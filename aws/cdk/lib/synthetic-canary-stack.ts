import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import { Construct } from 'constructs';
import {
  CANARY_FLEET_TAG,
  CANARY_HANDLER,
  CANARY_HANDLER_SOURCE,
  CANARY_METRIC_NAMESPACE,
  CANARY_QUORUM_TAG,
  ENVIRONMENT_DIMENSION,
  PROBE_DIMENSION,
  PROBE_FAILURE_METRIC,
  PROBE_LATENCY_METRIC,
  REGION_DIMENSION,
  ResolvedCanaryFleet,
  ResolvedProbe,
  SyntheticCanaryFleet,
  probeEnvironment,
  requireCanaryFleet,
} from './synthetic-canary-probes';

/**
 * The Synthetics runtime the probes run on: the newest Puppeteer runtime the
 * pinned `aws-cdk-lib` knows about, on Node.js 22.
 *
 * Pinned rather than defaulted, and kept current rather than merely pinned.
 * Synthetics retires runtimes on a schedule, and a canary on a retired runtime
 * keeps running until AWS stops it — at which point the fleet goes quiet, which
 * for a probe is the one failure mode indistinguishable from health. Pinning
 * makes the upgrade a reviewed diff on a date somebody chose; the heartbeat
 * alarms in `SyntheticCanaryQuorumStack` are what notice if that date passes
 * anyway.
 *
 * Puppeteer rather than Playwright because `activeTracing` is not supported on
 * the Playwright runtimes, and the canary's own X-Ray segment is how a slow run
 * is attributed to the network rather than to the origin.
 */
export const CANARY_RUNTIME = synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_13_0;

export interface SyntheticCanaryStackProps extends cdk.StackProps {
  /** The fleet this stack deploys one region of. */
  readonly fleet: SyntheticCanaryFleet;
  /** Addresses subscribed to this region's local alarm topic. */
  readonly alertEmails?: readonly string[];
  /** How long canary artifacts are kept, in days (default: 30). */
  readonly artifactRetentionDays?: number;
}

/**
 * One region's half of a multi-region synthetic canary fleet.
 *
 * Deploy one per entry in `fleet.regions`, each with an explicit `env.region`.
 * Every probe in the fleet runs identically in every one of them, so the only
 * variable between two runs of the same probe is where it was run from — which
 * is the entire point, and what makes the quorum in
 * {@link SyntheticCanaryQuorumStack} mean anything.
 *
 * Four decisions are worth knowing before reading.
 *
 * **The canaries are deliberately not in a VPC.** A canary attached to the
 * application's VPC reaches the load balancer through the same network the
 * application already trusts, so it sees neither the public DNS record, nor the
 * certificate the browser sees, nor the WAF in front of it — which are three of
 * the failures that a canary is the only thing able to observe. The probe is
 * useful precisely because it is outside.
 *
 * **The region is required to be concrete.** An environment-agnostic stack
 * resolves `this.region` to a `Ref`, and the probe's `Region` dimension would
 * then be a value nothing knows at synth time — leaving the quorum alarm in the
 * aggregation region unable to name the series it has to add up. So the stack
 * refuses to synthesise without an explicit region rather than producing a
 * fleet whose aggregation silently reads nothing.
 *
 * **The canary role is extended, not replaced.** CDK's generated role allows
 * `cloudwatch:PutMetricData` under a condition pinning the namespace to
 * `CloudWatchSynthetics`, which is correct and is also exactly the call the
 * probe makes to republish its verdict into the aggregation region. Without the
 * statement added below, every run fails at the republish — loudly, because the
 * handler lets that throw, which is the behaviour we want and not one to rely
 * on for a misconfiguration that is preventable here.
 *
 * **The local alarm stays, alongside the aggregated ones.** It reads the
 * `CloudWatchSynthetics` metrics this region publishes for itself, so it is the
 * one signal that does not depend on the cross-region republish, on the
 * aggregation region being up, or on any of the metric math. See
 * `docs/synthetic-canaries.md` §5.
 */
export class SyntheticCanaryStack extends cdk.Stack {
  /** The canaries created here, in `fleet.probes` order. */
  public readonly canaries: readonly synthetics.Canary[];
  /** Local `SuccessPercent` alarms, in the same order. */
  public readonly localAlarms: readonly cloudwatch.Alarm[];
  /** Bucket holding this region's canary artifacts. */
  public readonly artifactBucket: s3.Bucket;
  /** This region's alarm topic. Regional: an alarm cannot cross a region. */
  public readonly alarmTopic: sns.Topic;
  /** The validated fleet, for callers that want the resolved defaults. */
  public readonly fleet: ResolvedCanaryFleet;

  constructor(scope: Construct, id: string, props: SyntheticCanaryStackProps) {
    super(scope, id, props);

    this.fleet = requireCanaryFleet(props.fleet);
    const { envName } = this.fleet;
    const artifactRetentionDays = props.artifactRetentionDays ?? 30;

    if (cdk.Token.isUnresolved(this.region)) {
      throw new Error(
        `${id}: a synthetic canary stack needs a concrete env.region. The probe's ` +
          `${REGION_DIMENSION} dimension is written from it, and the quorum alarm in ` +
          `${this.fleet.aggregationRegion} has to name that dimension at synth time.`,
      );
    }

    if (!this.fleet.regions.includes(this.region)) {
      throw new Error(
        `${id}: deploying into ${this.region}, which is not one of the fleet's probe regions ` +
          `[${this.fleet.regions.join(', ')}]. The quorum alarm sums one term per declared ` +
          'region, so this region\'s verdicts would be published and never read.',
      );
    }

    /* ── Artifacts ──────────────────────────────────────────────────────────
     * Screenshots, HAR files and the run log for every execution. Encrypted
     * with a key this stack owns: the artifacts describe how a production
     * endpoint responds, including its response headers, and the canary role is
     * the only principal that writes them.
     */
    const artifactKey = new kms.Key(this, 'ArtifactKey', {
      alias: `alias/${envName}-canary-artifacts-${this.region}`,
      description: `${envName} synthetic canary artifacts (${this.region})`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const accessLogBucket = new s3.Bucket(this, 'ArtifactAccessLogBucket', {
      bucketName: `${envName}-canary-access-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // S3-managed rather than the artifact key: the log delivery service
      // writes these, and a KMS destination adds a grant to the key for a
      // service that writes records nobody reads day to day.
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-access-logs',
          enabled: true,
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // The end of the logging chain, as in `LogPipelineStack`. An access-log
    // bucket pointed at itself records the writes it is making; pointed at a
    // third bucket it moves the same question one bucket along. Declared here
    // with its reason rather than left to `.checkov.baseline`, which is for
    // findings that predate the gate.
    (accessLogBucket.node.defaultChild as s3.CfnBucket).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_18',
          comment:
            'This is the access-log bucket for the canary artifacts. The chain terminates here ' +
            'deliberately; see the comment above the declaration.',
        },
      ],
    });

    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `${envName}-canary-artifacts-${this.account}-${this.region}`,
      serverAccessLogsBucket: accessLogBucket,
      serverAccessLogsPrefix: 'artifact-access/',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: artifactKey,
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Artifacts are diagnostic: they answer "what did the failing run
          // see", which is a question asked within days. Keeping them for
          // longer is a growing copy of production responses in S3.
          id: 'expire-canary-artifacts',
          enabled: true,
          expiration: cdk.Duration.days(artifactRetentionDays),
          noncurrentVersionExpiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    /* ── This region's alarm topic ──────────────────────────────────────── */
    this.alarmTopic = new sns.Topic(this, 'CanaryAlarmTopic', {
      topicName: `${envName}-canary-${this.region}`,
      displayName: `${envName} synthetic canary alerts (${this.region})`,
      masterKey: kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns'),
    });
    for (const email of props.alertEmails ?? []) {
      this.alarmTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }
    const snsAction = new cw_actions.SnsAction(this.alarmTopic);

    /* ── The canaries ───────────────────────────────────────────────────── */
    const canaries: synthetics.Canary[] = [];
    const localAlarms: cloudwatch.Alarm[] = [];

    for (const probe of this.fleet.probes) {
      const canary = new synthetics.Canary(this, `Canary${pascal(probe.name)}`, {
        canaryName: probe.canaryName,
        runtime: CANARY_RUNTIME,
        test: synthetics.Test.custom({
          code: synthetics.Code.fromInline(CANARY_HANDLER_SOURCE),
          handler: CANARY_HANDLER,
        }),
        schedule: synthetics.Schedule.rate(cdk.Duration.minutes(probe.scheduleMinutes)),
        timeout: cdk.Duration.seconds(probe.timeoutSeconds),
        environmentVariables: probeEnvironment({
          probe,
          envName,
          region: this.region,
          aggregationRegion: this.fleet.aggregationRegion,
        }),
        artifactsBucketLocation: {
          // No trailing slash. CDK's generated role scopes `s3:PutObject` to
          // `<prefix>/*` and builds that by appending, so a prefix of `health/`
          // grants `health//*` while the artifacts are written under `health/`
          // — a canary that deploys, runs, and is denied on every artifact it
          // tries to save.
          bucket: this.artifactBucket,
          prefix: probe.name,
        },
        artifactS3KmsKey: artifactKey,
        // X-Ray on the canary's own request, so a slow run can be attributed to
        // the network rather than only to the application it is probing.
        activeTracing: true,
        successRetentionPeriod: cdk.Duration.days(artifactRetentionDays),
        failureRetentionPeriod: cdk.Duration.days(artifactRetentionDays),
        // The canary's Lambda function and layer go with the canary. Without
        // this they outlive it, and a re-created canary of the same name lands
        // beside the orphans rather than replacing them.
        provisionedResourceCleanup: true,
      });

      // The one statement CDK's generated role does not carry: its
      // PutMetricData grant is conditioned on the CloudWatchSynthetics
      // namespace, and the republished verdict is written to ours. Same
      // condition key, so this stays as narrow as the grant it extends.
      canary.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['cloudwatch:PutMetricData'],
          // PutMetricData takes no resource ARN; the namespace condition is the
          // only scoping AWS offers for it.
          resources: ['*'],
          conditions: { StringEquals: { 'cloudwatch:namespace': CANARY_METRIC_NAMESPACE } },
        }),
      );

      // `activeTracing` is a property on the canary and a permission on its
      // role, and CDK sets only the first. Without these the segments are
      // dropped: the canary still runs and still reports, and the trace that
      // would say whether a slow run was the network or the origin is simply
      // never there. Neither action accepts a resource ARN — X-Ray's write API
      // is account-scoped by design, which is why `*` is the only expressible
      // form rather than an unscoped grant.
      canary.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
          resources: ['*'],
        }),
      );

      cdk.Tags.of(canary).add(CANARY_FLEET_TAG, envName);
      cdk.Tags.of(canary).add(CANARY_QUORUM_TAG, String(this.fleet.quorum));

      // The local signal. Everything else about this probe is evaluated in the
      // aggregation region over a republished metric; this one is evaluated
      // here, over the metric Synthetics publishes for itself, and so survives
      // the republish path, the aggregation region and the metric math all
      // being broken at once.
      //
      // BREACHING, not NOT_BREACHING: a canary that has stopped running
      // publishes nothing, and nothing is what a canary that is passing also
      // publishes to an alarm that ignores gaps.
      const alarm = new cloudwatch.Alarm(this, `CanaryFailed${pascal(probe.name)}`, {
        alarmName: `${probe.canaryName}-${this.region}-failed`,
        alarmDescription:
          `${probe.name} failed from ${this.region}. Local signal, read from this region's own ` +
          'CloudWatchSynthetics metrics rather than the aggregated ones. On its own it does not ' +
          'distinguish an application outage from a bad morning in this region — the quorum ' +
          `alarm in ${this.fleet.aggregationRegion} is what does. See docs/synthetic-canaries.md.`,
        metric: canary.metricSuccessPercent({
          period: cdk.Duration.seconds(probe.alarmPeriodSeconds),
          statistic: 'Average',
        }),
        threshold: 100,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: this.fleet.evaluationPeriods,
        datapointsToAlarm: this.fleet.datapointsToAlarm,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        actionsEnabled: true,
      });
      alarm.addAlarmAction(snsAction);
      alarm.addOkAction(snsAction);

      canaries.push(canary);
      localAlarms.push(alarm);

      new cdk.CfnOutput(this, `Canary${pascal(probe.name)}Name`, {
        value: canary.canaryName,
        description: `${probe.name} canary in ${this.region}`,
      });
    }

    this.canaries = canaries;
    this.localAlarms = localAlarms;

    new cdk.CfnOutput(this, 'CanaryAlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: `${envName} synthetic canary alarm topic (${this.region})`,
    });

    // `policy/cloudformation/tags.rego` requires ManagedBy and Stack on
    // everything that costs money, holds data or grants access — which here is
    // the artifact buckets, their key, the canary roles and the alarm topic.
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);
  }
}

export interface SyntheticCanaryQuorumStackProps extends cdk.StackProps {
  /** The same fleet the regional stacks are given. */
  readonly fleet: SyntheticCanaryFleet;
  /** Topic for the page-worthy alarm. Created here when omitted. */
  readonly pageTopic?: sns.ITopic;
  /** Topic for the per-region and heartbeat alarms. Created here when omitted. */
  readonly ticketTopic?: sns.ITopic;
  /** Addresses subscribed to a topic this stack creates. */
  readonly pageEmails?: readonly string[];
  /** Addresses subscribed to a ticket topic this stack creates. */
  readonly ticketEmails?: readonly string[];
}

/**
 * The half of the fleet that compares the regions.
 *
 * Deploy exactly one, in `fleet.aggregationRegion`. It creates no canaries: it
 * reads the `Boilerplate/SyntheticCanary` series that every regional canary
 * republishes here and turns them into three kinds of alarm per probe.
 *
 * **The quorum alarm pages.** It adds one term per probe region and fires when
 * at least `quorum` of them are failing in the same window. This is the alarm
 * that is worth waking somebody for, because agreement between regions is the
 * only evidence available that the failure is the application's rather than one
 * probe's path to it.
 *
 * Each term is wrapped in `FILL(m, 0)`. Without it, a region whose canary has
 * stopped reporting contributes a gap, and CloudWatch metric math produces no
 * data point where any input is missing — so one dead canary would blind the
 * quorum alarm for every other region at once. Filling the gap with zero says
 * "this region is not voting to page", which is only safe because the
 * heartbeat alarm below exists to notice the silence itself.
 *
 * **The heartbeat alarm tickets, and treats missing data as breaching.** A
 * canary that has stopped running — deleted, throttled, failing before its
 * first line, or on a runtime AWS retired — publishes nothing at all, and
 * nothing is indistinguishable from a healthy run to every threshold in this
 * file. It is the failure mode a monitoring system is most likely to have and
 * least likely to report, so it gets an alarm of its own whose whole subject is
 * the absence of data.
 *
 * **The per-region alarm tickets.** One region failing while the others pass is
 * a statement about reachability from that region. It is worth a ticket — it is
 * how a regional network problem or a single unhealthy edge location gets seen
 * — and it is not worth a page, which is the distinction the quorum exists to
 * make.
 *
 * ## What this design cannot do
 *
 * The aggregation region is a single point of failure for the aggregated
 * signals: if CloudWatch there is unavailable, the quorum and heartbeat alarms
 * are unavailable with it. That is why `SyntheticCanaryStack` keeps a local
 * alarm in every probe region — those keep working, and they are the reason the
 * fleet degrades to "N independent alarms" rather than to nothing. Choose an
 * aggregation region the application does not itself depend on.
 */
export class SyntheticCanaryQuorumStack extends cdk.Stack {
  /** Page-worthy alarm per probe, in `fleet.probes` order. */
  public readonly quorumAlarms: readonly cloudwatch.Alarm[];
  /** Per-probe, per-region failure alarms. */
  public readonly regionalAlarms: readonly cloudwatch.Alarm[];
  /** Per-probe, per-region "this canary stopped reporting" alarms. */
  public readonly heartbeatAlarms: readonly cloudwatch.Alarm[];
  public readonly pageTopic: sns.ITopic;
  public readonly ticketTopic: sns.ITopic;
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly fleet: ResolvedCanaryFleet;

  constructor(scope: Construct, id: string, props: SyntheticCanaryQuorumStackProps) {
    super(scope, id, props);

    this.fleet = requireCanaryFleet(props.fleet);
    const { envName } = this.fleet;

    if (cdk.Token.isUnresolved(this.region)) {
      throw new Error(
        `${id}: the quorum stack needs a concrete env.region so it can be checked against the ` +
          `fleet's aggregation region (${this.fleet.aggregationRegion}).`,
      );
    }

    if (this.region !== this.fleet.aggregationRegion) {
      throw new Error(
        `${id}: deploying into ${this.region}, but the canaries republish their verdicts to ` +
          `${this.fleet.aggregationRegion}. A CloudWatch alarm cannot read a metric from another ` +
          'region, so every alarm here would evaluate an empty series — which, for a threshold ' +
          'on failures, reads as healthy forever.',
      );
    }

    const managedSnsKey = kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns');

    this.pageTopic =
      props.pageTopic ??
      new sns.Topic(this, 'CanaryPageTopic', {
        topicName: `${envName}-canary-page`,
        displayName: `${envName} synthetic canary paging alerts`,
        masterKey: managedSnsKey,
      });
    this.ticketTopic =
      props.ticketTopic ??
      new sns.Topic(this, 'CanaryTicketTopic', {
        topicName: `${envName}-canary-ticket`,
        displayName: `${envName} synthetic canary ticket alerts`,
        masterKey: managedSnsKey,
      });

    if (props.pageTopic === undefined) {
      for (const email of props.pageEmails ?? []) {
        (this.pageTopic as sns.Topic).addSubscription(new sns_sub.EmailSubscription(email));
      }
    }
    if (props.ticketTopic === undefined) {
      for (const email of props.ticketEmails ?? []) {
        (this.ticketTopic as sns.Topic).addSubscription(new sns_sub.EmailSubscription(email));
      }
    }

    const pageAction = new cw_actions.SnsAction(this.pageTopic);
    const ticketAction = new cw_actions.SnsAction(this.ticketTopic);

    const quorumAlarms: cloudwatch.Alarm[] = [];
    const regionalAlarms: cloudwatch.Alarm[] = [];
    const heartbeatAlarms: cloudwatch.Alarm[] = [];
    const dashboardRows: cloudwatch.IWidget[][] = [];

    for (const probe of this.fleet.probes) {
      const period = cdk.Duration.seconds(probe.alarmPeriodSeconds);
      const failureByRegion = new Map<string, cloudwatch.Metric>();

      for (const [index, region] of this.fleet.regions.entries()) {
        const failures = this.failureMetric(probe, region, period);
        failureByRegion.set(`m${index}`, failures);

        const regional = new cloudwatch.Alarm(this, `Regional${pascal(probe.name)}${index}`, {
          alarmName: `${envName}-canary-${probe.name}-${region}`,
          alarmDescription:
            `${probe.name} is failing when probed from ${region}, while the fleet as a whole has ` +
            'not reached quorum. That is a statement about reachability from this region rather ' +
            'than about the application: ticket it, look at the canary artifacts for the failing ' +
            'runs, and compare against the other regions before escalating.',
          metric: failures,
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: this.fleet.evaluationPeriods,
          datapointsToAlarm: this.fleet.datapointsToAlarm,
          // Silence is the heartbeat alarm's subject, not this one's. Treating
          // it as breaching here would raise both alarms for one cause.
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          actionsEnabled: true,
        });
        regional.addAlarmAction(ticketAction);
        regional.addOkAction(ticketAction);
        regionalAlarms.push(regional);

        const heartbeat = new cloudwatch.Alarm(this, `Heartbeat${pascal(probe.name)}${index}`, {
          alarmName: `${envName}-canary-${probe.name}-${region}-silent`,
          alarmDescription:
            `${probe.name} has published no verdict from ${region}. The canary is not running, ` +
            'not reaching CloudWatch in the aggregation region, or failing before its first ' +
            'line. Every other alarm on this probe reads the absence of data as health, so this ' +
            'is the only one that reports it.',
          metric: this.failureMetric(probe, region, period, 'SampleCount'),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          evaluationPeriods: this.fleet.evaluationPeriods,
          datapointsToAlarm: this.fleet.datapointsToAlarm,
          treatMissingData: cloudwatch.TreatMissingData.BREACHING,
          actionsEnabled: true,
        });
        heartbeat.addAlarmAction(ticketAction);
        heartbeat.addOkAction(ticketAction);
        heartbeatAlarms.push(heartbeat);
      }

      const usingMetrics: Record<string, cloudwatch.IMetric> = {};
      for (const [id, metric] of failureByRegion) usingMetrics[id] = metric;

      const regionsFailing = new cloudwatch.MathExpression({
        // FILL(m, 0) per term: see the class comment. Without it one silent
        // region removes the data point for every region.
        expression: [...failureByRegion.keys()].map((id) => `FILL(${id}, 0)`).join(' + '),
        usingMetrics,
        label: `${probe.name} regions failing`,
        period,
      });

      const quorum = new cloudwatch.Alarm(this, `Quorum${pascal(probe.name)}`, {
        alarmName: `${envName}-canary-${probe.name}-quorum`,
        alarmDescription:
          `${probe.name} is failing from at least ${this.fleet.quorum} of ` +
          `${this.fleet.regions.length} regions (${this.fleet.regions.join(', ')}) — the ` +
          'application is down for users, not just unreachable from one probe. Detection takes ' +
          `up to ${probe.detectionMinutes} minutes (${probe.scheduleMinutes}-minute schedule x ` +
          `${this.fleet.datapointsToAlarm} datapoints). See docs/synthetic-canaries.md.`,
        metric: regionsFailing,
        threshold: this.fleet.quorum,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: this.fleet.evaluationPeriods,
        datapointsToAlarm: this.fleet.datapointsToAlarm,
        // FILL covers a gap inside a series that has data; a fleet that is
        // entirely silent produces no series to fill, and that case has to page
        // rather than sit green.
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        actionsEnabled: true,
      });
      quorum.addAlarmAction(pageAction);
      quorum.addOkAction(pageAction);
      quorumAlarms.push(quorum);

      dashboardRows.push([
        new cloudwatch.GraphWidget({
          title: `${probe.name} — failing regions (quorum ${this.fleet.quorum})`,
          left: [regionsFailing],
          leftAnnotations: [
            { value: this.fleet.quorum, label: 'quorum', color: cloudwatch.Color.RED },
          ],
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: `${probe.name} — latency by region (budget ${probe.latencyBudgetMs}ms)`,
          left: this.fleet.regions.map((region) => this.latencyMetric(probe, region, period)),
          leftAnnotations: [
            { value: probe.latencyBudgetMs, label: 'budget', color: cloudwatch.Color.ORANGE },
          ],
          width: 12,
        }),
      ]);
    }

    this.quorumAlarms = quorumAlarms;
    this.regionalAlarms = regionalAlarms;
    this.heartbeatAlarms = heartbeatAlarms;

    this.dashboard = new cloudwatch.Dashboard(this, 'CanaryDashboard', {
      dashboardName: `${envName}-synthetic-canaries`,
      widgets: dashboardRows,
    });

    new cdk.CfnOutput(this, 'CanaryPageTopicArn', {
      value: this.pageTopic.topicArn,
      description: `${envName} synthetic canary paging topic`,
    });
    new cdk.CfnOutput(this, 'CanaryTicketTopicArn', {
      value: this.ticketTopic.topicArn,
      description: `${envName} synthetic canary ticket topic`,
    });

    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);
  }

  /**
   * One region's failure series for one probe.
   *
   * `Maximum` rather than `Sum` or `Average`: the period is exactly one run
   * long, so the question the quorum asks is "did this region see a failure in
   * this window", which is a 1 or a 0 either way — and stays a 1 if a retry
   * ever puts two runs in one period.
   */
  private failureMetric(
    probe: ResolvedProbe,
    region: string,
    period: cdk.Duration,
    statistic = 'Maximum',
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: CANARY_METRIC_NAMESPACE,
      metricName: PROBE_FAILURE_METRIC,
      dimensionsMap: {
        [ENVIRONMENT_DIMENSION]: this.fleet.envName,
        [PROBE_DIMENSION]: probe.name,
        [REGION_DIMENSION]: region,
      },
      period,
      statistic,
      label: region,
    });
  }

  private latencyMetric(
    probe: ResolvedProbe,
    region: string,
    period: cdk.Duration,
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: CANARY_METRIC_NAMESPACE,
      metricName: PROBE_LATENCY_METRIC,
      dimensionsMap: {
        [ENVIRONMENT_DIMENSION]: this.fleet.envName,
        [PROBE_DIMENSION]: probe.name,
        [REGION_DIMENSION]: region,
      },
      period,
      // p90 rather than average: a probe runs once per period, so the average
      // is that one run, and the interesting number across a day is the tail.
      statistic: 'p90',
      label: region,
    });
  }
}

/** `checkout-flow` → `CheckoutFlow`, for construct ids. */
const pascal = (name: string): string =>
  name
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
