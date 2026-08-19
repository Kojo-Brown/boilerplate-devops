import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/** CloudWatch namespace every metric in this stack is published into. */
export const DORA_METRIC_NAMESPACE = 'DORA';

/**
 * EventBridge `source` the deployment event must carry.
 *
 * A deployment event has to come from the deploying workflow rather than from
 * `aws.ecs` or `aws.codedeploy`, because AWS does not know which commit it is
 * running. See `workflow-templates/emit-dora-deployment.yml`.
 */
export const DEPLOYMENT_EVENT_SOURCE = 'dora.deployment';

/** EventBridge `detail-type` of the deployment event. */
export const DEPLOYMENT_EVENT_DETAIL_TYPE = 'Deployment';

/**
 * Where a lead time was measured from.
 *
 * Published as a metric dimension rather than folded away, because the two are
 * not the same measurement and a repository can silently be reporting the
 * second while believing it reports the first:
 *
 *   `pullRequest`  the author date of the *first* commit on the branch, read
 *                  from the pull request. This is lead time for changes.
 *   `headCommit`   the author date of the deployed commit alone. Under a
 *                  squash-merge policy — which this repository's own ruleset
 *                  enforces — the squashed commit is authored at merge time, so
 *                  this measures how long the deploy pipeline took and nothing
 *                  about how long the change waited.
 */
export type LeadTimeSource = 'pullRequest' | 'headCommit';

/** Whether an incident was traced back to a deployment. */
export type IncidentAttribution = 'deployment' | 'unattributed';

/**
 * DORA performance bands, drawn on the dashboard as annotation lines.
 *
 * Values are the "elite" and "high" boundaries from the 2023 State of DevOps
 * report. They are props rather than constants because the bands move between
 * report years and because a team's own target is a more useful line than an
 * industry cohort's.
 */
export interface DoraThresholds {
  /** Deployments per day at or above which delivery is elite (default: 1). */
  readonly eliteDeploymentsPerDay?: number;
  /** Lead time in seconds at or below which delivery is elite (default: 24h). */
  readonly eliteLeadTimeSeconds?: number;
  /** Change failure rate percentage at or below which delivery is elite (default: 5). */
  readonly eliteChangeFailurePercent?: number;
  /** Recovery time in seconds at or below which delivery is elite (default: 1h). */
  readonly eliteRecoveryTimeSeconds?: number;
}

/** One deployment target the four keys are measured for. */
export interface DoraService {
  /** Environment name, e.g. `production`. Becomes the `Environment` dimension. */
  readonly environment: string;
  /** Service name, e.g. `api`. Becomes the `Service` dimension. */
  readonly service: string;
}

/**
 * An alarm whose ALARM and OK transitions open and close incidents, and the
 * service those incidents belong to.
 *
 * The service is declared rather than parsed out of the alarm name. Alarm names
 * in this repository look like `production-alb-5xx-elb` and
 * `production-ecs-cpu-high`, so any prefix rule would file them under services
 * called "alb" and "ecs" — plausible-looking dimensions that match no
 * deployment and therefore produce a change failure rate of zero forever.
 */
export interface DoraIncidentAlarm extends DoraService {
  /** Alarm name exactly as CloudWatch has it. */
  readonly alarmName: string;
}

export interface DoraMetricsStackProps extends cdk.StackProps {
  /**
   * Services whose four keys the aggregator computes on every run.
   *
   * The recorder writes whatever arrives; this list is what gets a rate
   * published even when the answer is "nothing deployed". A service that only
   * appears when it deploys leaves a gap in the graph that reads as missing
   * data rather than as no deployments.
   */
  readonly services: readonly DoraService[];
  /** `owner/name` of the repository whose commits are the lead-time source. */
  readonly repository: string;
  /**
   * Secrets Manager ARN of a secret whose `token` field is a GitHub token with
   * `contents: read` (plus `pull_requests: read` for private repositories).
   *
   * Omit it and the other three keys are still collected; lead time is reported
   * as `LeadTimeUnmeasurable` rather than as zero, because a zero lead time
   * graphs as the best possible score.
   */
  readonly githubTokenSecretArn?: string;
  /** GitHub API base URL — override for GitHub Enterprise Server. */
  readonly githubApiUrl?: string;
  /**
   * How long after a deployment an incident is still considered to have been
   * caused by it (default: 60 minutes).
   *
   * This is the one number that decides both halves of change failure rate: an
   * incident inside the window is a change failure, and a deployment younger
   * than the window has not yet been observed long enough to be called a
   * success. See {@link DoraMetricsStack} for why the second half matters.
   */
  readonly attributionWindowMinutes?: number;
  /**
   * An alarm that returns to ALARM within this many seconds of clearing
   * continues the incident it just closed rather than opening a new one
   * (default: 300).
   *
   * Without it a single flapping alarm reports as a dozen incidents, each with
   * a recovery time of about a minute — which moves both change failure rate
   * and recovery time in opposite wrong directions at once.
   */
  readonly flapWindowSeconds?: number;
  /** Trailing window the rates are computed over (default: 30 days). */
  readonly windowDays?: number;
  /** How often the aggregator recomputes the rates (default: hourly). */
  readonly aggregationSchedule?: events.Schedule;
  /** How long deployment and incident records are kept (default: 400 days). */
  readonly retentionDays?: number;
  /** Performance bands drawn on the dashboard. */
  readonly thresholds?: DoraThresholds;
  /** Override the dashboard name (default: `{stackName}-dora`). */
  readonly dashboardName?: string;
  /** Existing SNS topic for measurement-health alarms. One is created when omitted. */
  readonly notificationTopic?: sns.ITopic;
  /**
   * Alarms whose state changes open and close incidents, each mapped to the
   * service it belongs to.
   *
   * Listing them explicitly is what keeps a billing alarm or a staging noise
   * alarm out of production's recovery time — an empty pattern would match
   * every alarm in the account.
   */
  readonly incidentAlarms: readonly DoraIncidentAlarm[];
}

/**
 * The DORA four keys, collected from events and dashboarded.
 *
 * Deployment frequency, lead time for changes, change failure rate, and failed
 * deployment recovery time. Each is a ratio or a duration over two events, and
 * every one of them has a way of being computed from the wrong pair — the
 * arithmetic is trivial and produces a plausible number regardless, which is
 * why a wrong DORA dashboard survives for years.
 *
 * ## Lead time is measured from the first commit, not the merge
 *
 * Lead time for changes is the time from code being *written* to it running in
 * production. The obvious implementation reads the author date of the commit
 * that was deployed. Under a squash-merge policy — which `trunk-based-main.json`
 * in this repository requires — that commit did not exist until the merge
 * button was pressed, and its author date is the merge. Every lead time then
 * comes out as the duration of the deploy pipeline, which is minutes, which
 * reads as elite performance no matter how long the change actually sat in
 * review.
 *
 * The branch's real history is not on `main` after a squash, so it cannot be
 * recovered from git; it has to come from the pull request. The recorder asks
 * GitHub for the pull request's commits and takes the earliest author date. If
 * the event carries no pull request number it falls back to the deployed commit
 * and publishes the datapoint under `Source=headCommit`, so the dashboard shows
 * the two as separate series instead of averaging a real measurement together
 * with a pipeline duration.
 *
 * ## Change failure rate has a trailing edge that lies
 *
 * The natural implementation — failures in the window over deployments in the
 * window — is wrong at the most recent end, and wrong in the flattering
 * direction. A deployment from four minutes ago is in the denominator already;
 * the incident it is about to cause has not happened yet. So the rate always
 * improves immediately after a deploy and then silently gets worse, and the
 * moment you most want the number is the moment it is least true.
 *
 * The aggregator therefore excludes deployments younger than
 * `attributionWindowMinutes` from *both* sides, and publishes the excluded
 * count as `UnripeDeployments` so the dashboard can show what it is not
 * counting. When nothing in the window is ripe, no rate is published at all: a
 * change failure rate over zero deployments is undefined, not zero percent.
 *
 * ## Not every incident is a change failure
 *
 * A certificate that expires at 04:00 on a Sunday is an incident, and it is not
 * a failed deployment. Counting all incidents against deployments produces a
 * change failure rate that rises when the deploy cadence *drops*. Each incident
 * here is attributed to the last successful deployment that preceded it, and
 * only if that deployment was inside the attribution window; the rest are
 * published as `Incidents` with `Attribution=unattributed` and are deliberately
 * absent from the rate. Recovery time follows the current DORA definition —
 * *failed deployment* recovery time — and is likewise reported for attributed
 * incidents, with the unattributed series kept alongside because operationally
 * it still matters how long those took.
 *
 * ## What it needs from the deploy pipeline
 *
 * One EventBridge event per deployment, carrying the commit and (ideally) the
 * pull request. `workflow-templates/emit-dora-deployment.yml` is that event as a
 * reusable workflow. Nothing here reads ECS or CodeDeploy events, because
 * neither carries a commit, and three of the four keys are about the commit.
 *
 * ## What it does not do
 *
 * Nothing in this stack gates a deployment or changes a rollout. The four keys
 * are a measurement of a delivery system, and a measurement that can block the
 * thing it measures stops being one.
 */
export class DoraMetricsStack extends cdk.Stack {
  /** Deployment and incident records; also the attribution state. */
  public readonly eventTable: dynamodb.Table;
  /** Writes deployment and incident facts, and attributes incidents to deployments. */
  public readonly recorderFunction: lambda.Function;
  /** Recomputes the window-dependent rates on a schedule. */
  public readonly aggregatorFunction: lambda.Function;
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly notificationTopic: sns.ITopic;
  /** Fires when lead time stops being measurable — the silent failure mode. */
  public readonly leadTimeUnmeasurableAlarm: cloudwatch.Alarm;
  public readonly metricNamespace: string;

  private readonly attributionWindowMinutes: number;

  constructor(scope: Construct, id: string, props: DoraMetricsStackProps) {
    super(scope, id, props);

    if (props.services.length === 0) {
      throw new Error(
        'DoraMetricsStack needs at least one service; with none the aggregator would ' +
          'publish nothing and the dashboard would read as a delivery system that never ships.',
      );
    }

    if (props.incidentAlarms.length === 0) {
      throw new Error(
        'DoraMetricsStack needs at least one incident alarm. An empty list would match every ' +
          'alarm in the account, putting billing and staging alarms into production change ' +
          'failure rate; it is not the same as "this service has no alarms".',
      );
    }

    const duplicateAlarm = props.incidentAlarms.find(
      (alarm, index) =>
        props.incidentAlarms.findIndex((other) => other.alarmName === alarm.alarmName) !== index,
    );
    if (duplicateAlarm) {
      throw new Error(
        `Alarm "${duplicateAlarm.alarmName}" is mapped to more than one service. One alarm ` +
          'belongs to one service; two mappings means the second silently wins and half the ' +
          'incidents land under a service that never sees them.',
      );
    }

    this.metricNamespace = DORA_METRIC_NAMESPACE;
    this.attributionWindowMinutes = props.attributionWindowMinutes ?? 60;
    const flapWindowSeconds = props.flapWindowSeconds ?? 300;
    const windowDays = props.windowDays ?? 30;
    const retentionDays = props.retentionDays ?? 400;
    const dashboardName = props.dashboardName ?? `${this.stackName}-dora`;

    if (retentionDays <= windowDays) {
      throw new Error(
        `retentionDays (${retentionDays}) must exceed windowDays (${windowDays}); records ` +
          'expiring inside the reporting window would shrink the denominator over time and ' +
          'improve every rate for no reason.',
      );
    }

    // ── Record store ──────────────────────────────────────────────────────────
    // CloudWatch alone cannot hold this. Change failure rate needs a failure
    // that arrives at 14:40 to find and mark the deployment from 14:05, and a
    // published metric datapoint cannot be revisited. The access pattern is
    // exactly one query — "the newest record for this service at or before time
    // T" — which is a backwards range query on a sort key, so the sort key is
    // the timestamp.
    this.eventTable = new dynamodb.Table(this, 'DoraEventTable', {
      tableName: `${this.stackName}-events`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      // Deployment history is the only copy of the attribution state, and it is
      // not reconstructible: the events that produced it are long gone from
      // EventBridge. Deleting the stack should not delete the record of how the
      // delivery system performed.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    (this.eventTable.node.defaultChild as dynamodb.CfnTable).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_119',
          comment:
            'No customer-managed KMS key: the table holds commit SHAs, pull request numbers, ' +
            'alarm names and timestamps for this account. AWS-managed encryption at rest ' +
            'applies, and a CMK here would add a key to rotate around data that is already ' +
            'visible in the repository and the CloudWatch console.',
        },
      ],
    });

    // ── Notifications ─────────────────────────────────────────────────────────
    this.notificationTopic =
      props.notificationTopic ??
      new sns.Topic(this, 'DoraMetricsTopic', {
        topicName: `${this.stackName}-dora-metrics`,
        displayName: 'DORA metrics collection health',
        enforceSSL: true,
        masterKey: kms.Alias.fromAliasName(this, 'DoraSnsKey', 'alias/aws/sns'),
      });

    // ── Recorder ──────────────────────────────────────────────────────────────
    const recorderLogGroup = this.createLogGroup('RecorderLogGroup', 'dora-recorder');

    // A deployment event that fails to record is a permanently missing
    // datapoint — EventBridge does not keep it, and the deploy will not happen
    // again. That is the difference between this function and the aggregator,
    // whose next run recomputes everything from the table, and it is why only
    // this one has a dead letter queue.
    const recorderDlq = new sqs.Queue(this, 'RecorderDlq', {
      queueName: `${this.stackName}-recorder-dlq`,
      // The AWS-managed SQS key rather than SSE-SQS: both encrypt at rest with
      // no key to rotate, but only this one satisfies CKV_AWS_27, and a real
      // fix beats a suppression on the queue that holds the events the metrics
      // are missing.
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kms.Alias.fromAliasName(this, 'DoraSqsKey', 'alias/aws/sqs'),
      enforceSSL: true,
      // Long enough that a deployment event lost over a weekend is still there
      // on Monday. Replaying it late is fine — the event carries its own
      // timestamp, so it lands in the window it belongs to.
      retentionPeriod: cdk.Duration.days(14),
    });

    const recorderRole = new iam.Role(this, 'RecorderRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Records deployments and incidents, and attributes incidents to deployments',
    });
    recorderLogGroup.grantWrite(recorderRole);
    recorderDlq.grantSendMessages(recorderRole);
    this.grantPublishMetrics(recorderRole, 'RecorderPutMetricData');

    // Spelled out rather than `grantReadWriteData`, which would also hand over
    // DeleteItem and Scan. Deleting a deployment record is how the change
    // failure rate gets quietly improved, and nothing here has a reason to.
    recorderRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RecordDoraEvents',
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [this.eventTable.tableArn],
      }),
    );

    if (props.githubTokenSecretArn) {
      recorderRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadGitHubToken',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.githubTokenSecretArn],
        }),
      );
    }

    this.recorderFunction = new lambda.Function(this, 'RecorderFunction', {
      functionName: `${this.stackName}-recorder`,
      description: 'Records DORA deployment and incident events',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: recorderRole,
      logGroup: recorderLogGroup,
      timeout: cdk.Duration.minutes(2),
      deadLetterQueue: recorderDlq,
      // Attribution reads the deployment history and then writes a flag back to
      // it. Two concurrent incidents for the same service would both read the
      // pre-write state; serialising is cheaper than a transaction for an
      // invocation rate measured in events per day.
      reservedConcurrentExecutions: 1,
      environment: {
        TABLE_NAME: this.eventTable.tableName,
        METRIC_NAMESPACE: this.metricNamespace,
        INCIDENT_ALARMS: JSON.stringify(
          Object.fromEntries(
            props.incidentAlarms.map((alarm) => [
              alarm.alarmName,
              { environment: alarm.environment, service: alarm.service },
            ]),
          ),
        ),
        REPOSITORY: props.repository,
        GITHUB_API_URL: props.githubApiUrl ?? 'https://api.github.com',
        GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecretArn ?? '',
        ATTRIBUTION_WINDOW_MINUTES: String(this.attributionWindowMinutes),
        FLAP_WINDOW_SECONDS: String(flapWindowSeconds),
        RETENTION_DAYS: String(retentionDays),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(DORA_RECORDER_SOURCE),
    });

    (this.recorderFunction.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler talks to DynamoDB, CloudWatch, Secrets Manager and the ' +
            'GitHub API. A VPC would need a NAT gateway or three interface endpoints to reach ' +
            'services it is no closer to, and the GitHub call would still leave the VPC.',
        },
        {
          id: 'CKV_AWS_173',
          comment:
            'No KMS key on the environment variables: they hold a table name, a repository ' +
            'name and three durations. The GitHub token is read from Secrets Manager at ' +
            'invocation and never placed in the environment.',
        },
      ],
    });

    new events.Rule(this, 'DeploymentEventRule', {
      ruleName: `${this.stackName}-deployments`,
      description: 'Deployment events emitted by the deploy pipeline',
      eventPattern: {
        source: [DEPLOYMENT_EVENT_SOURCE],
        detailType: [DEPLOYMENT_EVENT_DETAIL_TYPE],
      },
      targets: [
        new targets.LambdaFunction(this.recorderFunction, {
          deadLetterQueue: recorderDlq,
          retryAttempts: 3,
        }),
      ],
    });

    new events.Rule(this, 'IncidentAlarmRule', {
      ruleName: `${this.stackName}-incidents`,
      description: 'Alarm state changes that open and close incidents',
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        // Named alarms rather than every alarm in the account. INSUFFICIENT_DATA
        // is deliberately absent: an alarm that has lost its metric is a broken
        // alarm, and treating it as service restored would close incidents that
        // are still running.
        resources: props.incidentAlarms.map(
          (alarm) =>
            `arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:${alarm.alarmName}`,
        ),
        detail: { state: { value: ['ALARM', 'OK'] } },
      },
      targets: [
        new targets.LambdaFunction(this.recorderFunction, {
          deadLetterQueue: recorderDlq,
          retryAttempts: 3,
        }),
      ],
    });

    // ── Aggregator ────────────────────────────────────────────────────────────
    const aggregatorLogGroup = this.createLogGroup('AggregatorLogGroup', 'dora-aggregator');

    const aggregatorRole = new iam.Role(this, 'AggregatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Recomputes DORA rates over the trailing window',
    });
    aggregatorLogGroup.grantWrite(aggregatorRole);
    this.grantPublishMetrics(aggregatorRole, 'AggregatorPutMetricData');

    // Query and nothing else. The aggregator derives rates from the history; a
    // bug in that arithmetic must not be able to rewrite the history it is
    // derived from.
    aggregatorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadDoraEvents',
        actions: ['dynamodb:Query'],
        resources: [this.eventTable.tableArn],
      }),
    );

    this.aggregatorFunction = new lambda.Function(this, 'AggregatorFunction', {
      functionName: `${this.stackName}-aggregator`,
      description: 'Publishes deployment frequency and change failure rate over the window',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: aggregatorRole,
      logGroup: aggregatorLogGroup,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      environment: {
        TABLE_NAME: this.eventTable.tableName,
        METRIC_NAMESPACE: this.metricNamespace,
        SERVICES: JSON.stringify(
          props.services.map((s) => ({ environment: s.environment, service: s.service })),
        ),
        WINDOW_DAYS: String(windowDays),
        ATTRIBUTION_WINDOW_MINUTES: String(this.attributionWindowMinutes),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(DORA_AGGREGATOR_SOURCE),
    });

    (this.aggregatorFunction.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_116',
          comment:
            'No DLQ: the invoker is a schedule and every run recomputes the whole window from ' +
            'the table. A failed run is superseded by the next one rather than replayed, and ' +
            'there is no partial state to recover. The recorder, whose input is an event that ' +
            'will never occur again, does have one.',
        },
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler talks only to DynamoDB and CloudWatch, neither of which ' +
            'is reached faster from inside one.',
        },
        {
          id: 'CKV_AWS_173',
          comment:
            'No KMS key on the environment variables: a table name, a namespace, the service ' +
            'list, and two window lengths. Nothing here is secret.',
        },
      ],
    });

    new events.Rule(this, 'AggregationSchedule', {
      ruleName: `${this.stackName}-aggregation-schedule`,
      description: 'Recompute DORA rates over the trailing window',
      schedule: props.aggregationSchedule ?? events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(this.aggregatorFunction)],
    });

    // ── Measurement-health alarm ──────────────────────────────────────────────
    // The failure this guards against is not a bad score, it is a score that
    // has quietly stopped being a measurement: a revoked token, a renamed
    // repository, or a pipeline that stopped sending the pull request number.
    // Lead time would simply disappear from the graph, and a missing line on a
    // dashboard looks like nothing happened rather than like the instrument
    // broke.
    this.leadTimeUnmeasurableAlarm = new cloudwatch.Alarm(this, 'LeadTimeUnmeasurableAlarm', {
      alarmName: `${this.stackName}-lead-time-unmeasurable`,
      alarmDescription:
        'Deployments are being recorded but their lead time cannot be resolved from GitHub. ' +
        'Lead time on the dashboard is now a subset of deployments, not all of them.',
      metric: new cloudwatch.Metric({
        namespace: this.metricNamespace,
        metricName: 'LeadTimeUnmeasurable',
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.hours(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      // No deployments in an hour leaves no datapoint, and a quiet hour is not
      // a broken instrument.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.leadTimeUnmeasurableAlarm.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));

    // ── Dashboard ─────────────────────────────────────────────────────────────
    this.dashboard = new cloudwatch.Dashboard(this, 'DoraDashboard', {
      dashboardName,
      widgets: this.buildWidgets(props.services, props.thresholds ?? {}, windowDays),
    });

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DoraEventBusSource', {
      value: DEPLOYMENT_EVENT_SOURCE,
      description:
        'EventBridge source the deploy pipeline must put deployment events on; see ' +
        'workflow-templates/emit-dora-deployment.yml',
      exportName: `${this.stackName}-deployment-event-source`,
    });

    new cdk.CfnOutput(this, 'DoraTableName', {
      value: this.eventTable.tableName,
      description: 'Deployment and incident records backing the rates',
      exportName: `${this.stackName}-event-table`,
    });

    new cdk.CfnOutput(this, 'DoraDashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboardName}`,
      description: 'Direct link to the DORA dashboard',
      exportName: `${this.stackName}-dashboard-url`,
    });

    new cdk.CfnOutput(this, 'DoraRecorderDlqUrl', {
      value: recorderDlq.queueUrl,
      description:
        'Deployment events that could not be recorded. Anything in here is a hole in the ' +
        'metrics, not a retryable backlog — replay it rather than purging it.',
      exportName: `${this.stackName}-recorder-dlq`,
    });
  }

  /**
   * Deployment count for one service, as recorded.
   *
   * Exposed so another dashboard graphs the same series this one does rather
   * than re-deriving the dimensions and quietly disagreeing about, say, whether
   * failed deployments count.
   */
  public deploymentMetric(service: DoraService, outcome: 'succeeded' | 'failed'): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: this.metricNamespace,
      metricName: 'Deployments',
      dimensionsMap: {
        Environment: service.environment,
        Service: service.service,
        Outcome: outcome,
      },
      statistic: cloudwatch.Stats.SUM,
      period: cdk.Duration.days(1),
    });
  }

  /** Lead time datapoints for one service and measurement source. */
  public leadTimeMetric(
    service: DoraService,
    source: LeadTimeSource,
    statistic: string = 'p50',
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: this.metricNamespace,
      metricName: 'LeadTimeSeconds',
      dimensionsMap: {
        Environment: service.environment,
        Service: service.service,
        Source: source,
      },
      statistic,
      period: cdk.Duration.days(1),
    });
  }

  /** Change failure rate for one service, as a percentage of ripe deployments. */
  public changeFailureRateMetric(service: DoraService): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: this.metricNamespace,
      metricName: 'ChangeFailureRate',
      dimensionsMap: { Environment: service.environment, Service: service.service },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.hours(1),
    });
  }

  /** Recovery time datapoints for one service and attribution class. */
  public recoveryTimeMetric(
    service: DoraService,
    attribution: IncidentAttribution,
    statistic: string = 'p50',
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: this.metricNamespace,
      metricName: 'RecoveryTimeSeconds',
      dimensionsMap: {
        Environment: service.environment,
        Service: service.service,
        Attribution: attribution,
      },
      statistic,
      period: cdk.Duration.days(1),
    });
  }

  private createLogGroup(id: string, suffix: string): logs.LogGroup {
    const logGroup = new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/${this.stackName}-${suffix}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    (logGroup.node.defaultChild as logs.CfnLogGroup).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_158',
          comment:
            'No CMK on the log group: AWS-managed encryption at rest already applies, and the ' +
            'contents are deployment timestamps, commit SHAs and alarm names — the same facts ' +
            'the dashboard publishes.',
        },
      ],
    });

    return logGroup;
  }

  private grantPublishMetrics(role: iam.Role, sid: string): void {
    role.addToPolicy(
      new iam.PolicyStatement({
        sid,
        // PutMetricData rejects any resource other than `*`, so the namespace
        // condition is the only available scope — and it is the one that
        // matters: these roles can write DORA metrics and nothing else.
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': this.metricNamespace } },
      }),
    );
  }

  private buildWidgets(
    services: readonly DoraService[],
    thresholds: DoraThresholds,
    windowDays: number,
  ): cloudwatch.IWidget[][] {
    const eliteDeploymentsPerDay = thresholds.eliteDeploymentsPerDay ?? 1;
    const eliteLeadTimeSeconds = thresholds.eliteLeadTimeSeconds ?? 24 * 60 * 60;
    const eliteChangeFailurePercent = thresholds.eliteChangeFailurePercent ?? 5;
    const eliteRecoveryTimeSeconds = thresholds.eliteRecoveryTimeSeconds ?? 60 * 60;

    const elite = (value: number, label: string): cloudwatch.HorizontalAnnotation => ({
      value,
      label,
      color: cloudwatch.Color.GREEN,
    });

    const perService = <T>(fn: (s: DoraService) => T): T[] => services.map(fn);

    const frequencyWidget = new cloudwatch.GraphWidget({
      title: `Deployment frequency — successful deploys per day (${windowDays}d trailing)`,
      left: perService(
        (s) =>
          new cloudwatch.Metric({
            namespace: this.metricNamespace,
            metricName: 'DeploymentsPerDay',
            dimensionsMap: { Environment: s.environment, Service: s.service },
            statistic: cloudwatch.Stats.AVERAGE,
            period: cdk.Duration.hours(1),
            label: `${s.environment}/${s.service}`,
          }),
      ),
      leftAnnotations: [elite(eliteDeploymentsPerDay, 'elite ≥')],
      leftYAxis: { min: 0, label: 'Deploys/day', showUnits: false },
      width: 12,
      height: 6,
    });

    // p50 and p90 together, because lead time is not normally distributed —
    // most changes go out the same day and a handful sit in review for a
    // fortnight. A mean would report neither population.
    const leadTimeWidget = new cloudwatch.GraphWidget({
      title: 'Lead time for changes — p50 / p90, by measurement source',
      left: services.flatMap((s) => [
        this.leadTimeMetric(s, 'pullRequest', 'p50').with({
          label: `${s.environment}/${s.service} p50 (first commit)`,
        }),
        this.leadTimeMetric(s, 'pullRequest', 'p90').with({
          label: `${s.environment}/${s.service} p90 (first commit)`,
        }),
        // Kept visible on purpose. A repository that squash-merges and does not
        // send the pull request number sees only this series, and its numbers
        // are deploy durations wearing the label "lead time".
        this.leadTimeMetric(s, 'headCommit', 'p50').with({
          label: `${s.environment}/${s.service} p50 (deployed commit only)`,
          color: cloudwatch.Color.ORANGE,
        }),
      ]),
      leftAnnotations: [elite(eliteLeadTimeSeconds, 'elite ≤ 1 day')],
      leftYAxis: { min: 0, label: 'Seconds', showUnits: false },
      width: 12,
      height: 6,
    });

    const changeFailureWidget = new cloudwatch.GraphWidget({
      title: `Change failure rate — attributed failures / ripe deploys (${windowDays}d trailing)`,
      left: perService((s) =>
        this.changeFailureRateMetric(s).with({ label: `${s.environment}/${s.service}` }),
      ),
      leftAnnotations: [elite(eliteChangeFailurePercent, 'elite ≤')],
      leftYAxis: { min: 0, max: 100, label: 'Percent', showUnits: false },
      width: 12,
      height: 6,
    });

    const recoveryWidget = new cloudwatch.GraphWidget({
      title: 'Failed deployment recovery time — p50 / p90',
      left: services.flatMap((s) => [
        this.recoveryTimeMetric(s, 'deployment', 'p50').with({
          label: `${s.environment}/${s.service} p50`,
        }),
        this.recoveryTimeMetric(s, 'deployment', 'p90').with({
          label: `${s.environment}/${s.service} p90`,
        }),
      ]),
      leftAnnotations: [elite(eliteRecoveryTimeSeconds, 'elite ≤ 1 hour')],
      leftYAxis: { min: 0, label: 'Seconds', showUnits: false },
      width: 12,
      height: 6,
    });

    // The sample size behind the change failure rate, and the incidents the
    // rate deliberately excludes. Without these the rate is a number with no
    // stated confidence — 0% over two ripe deployments and 0% over two hundred
    // render identically.
    const coverageWidget = new cloudwatch.GraphWidget({
      title: 'Measurement coverage — what the rates are and are not counting',
      left: services.flatMap((s) => [
        new cloudwatch.Metric({
          namespace: this.metricNamespace,
          metricName: 'RipeDeployments',
          dimensionsMap: { Environment: s.environment, Service: s.service },
          statistic: cloudwatch.Stats.AVERAGE,
          period: cdk.Duration.hours(1),
          label: `${s.environment}/${s.service} deploys in the rate`,
        }),
        new cloudwatch.Metric({
          namespace: this.metricNamespace,
          metricName: 'UnripeDeployments',
          dimensionsMap: { Environment: s.environment, Service: s.service },
          statistic: cloudwatch.Stats.AVERAGE,
          period: cdk.Duration.hours(1),
          label: `${s.environment}/${s.service} too recent to judge`,
          color: cloudwatch.Color.ORANGE,
        }),
        new cloudwatch.Metric({
          namespace: this.metricNamespace,
          metricName: 'Incidents',
          dimensionsMap: {
            Environment: s.environment,
            Service: s.service,
            Attribution: 'unattributed',
          },
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.days(1),
          label: `${s.environment}/${s.service} incidents with no deploy behind them`,
          color: cloudwatch.Color.GREY,
        }),
      ]),
      leftYAxis: { min: 0, label: 'Count', showUnits: false },
      width: 12,
      height: 6,
    });

    const instrumentWidget = new cloudwatch.GraphWidget({
      title: 'Instrument health — deployments whose lead time could not be resolved',
      left: [
        new cloudwatch.Metric({
          namespace: this.metricNamespace,
          metricName: 'LeadTimeUnmeasurable',
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.hours(1),
          label: 'Unmeasurable lead times',
          color: cloudwatch.Color.RED,
        }),
      ],
      leftYAxis: { min: 0, label: 'Count', showUnits: false },
      width: 12,
      height: 6,
    });

    const notes = new cloudwatch.TextWidget({
      markdown: [
        '## How to read this dashboard',
        '',
        `**Change failure rate** counts only deployments older than ${this.attributionWindowMinutes} minutes.`,
        'A deployment younger than that has not been observed long enough to be called a success,',
        'and including it makes the rate improve the instant a deploy lands. The excluded count is',
        'the orange series in *Measurement coverage*; when nothing in the window is ripe, no rate is',
        'published at all rather than 0%.',
        '',
        '**Lead time** is measured from the author date of the first commit on the branch, read from',
        'the pull request. The orange *deployed commit only* series is the fallback used when a',
        'deployment event arrives without a pull request number — under squash merge that measures',
        'the deploy pipeline, not the change. If that series is the only one present, lead time here',
        'is not lead time.',
        '',
        '**Recovery time** covers incidents attributed to a deployment, which is the current DORA',
        'definition (*failed deployment recovery time*). Incidents with no deployment behind them are',
        'counted in *Measurement coverage* and excluded from the rate — otherwise change failure rate',
        'would rise whenever the deploy cadence fell.',
      ].join('\n'),
      width: 24,
      height: 8,
    });

    return [
      [frequencyWidget, leadTimeWidget],
      [changeFailureWidget, recoveryWidget],
      [coverageWidget, instrumentWidget],
      [notes],
    ];
  }
}

/**
 * The recorder, shipped inline.
 *
 * Exported as a string so `test/dora-recorder-handler.test.ts` can compile and
 * run it. `lambda.Code.fromInline` means nothing else in the build parses it —
 * `tsc` sees a template literal and `cdk synth` embeds it verbatim — and every
 * mistake available in here is silent in the same direction: a lead time
 * computed from the wrong commit, an incident attributed to the wrong deploy, or
 * a duplicate event counted twice all produce a plausible dashboard.
 *
 * Written with string concatenation rather than template literals throughout,
 * because the whole body is itself inside a template literal.
 */
export const DORA_RECORDER_SOURCE = `
'use strict';
const {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const region = process.env.AWS_REGION;
const dynamodb = new DynamoDBClient({ region });
const cloudwatch = new CloudWatchClient({ region });
const secretsManager = new SecretsManagerClient({ region });

const TABLE_NAME = process.env.TABLE_NAME;
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE;
const INCIDENT_ALARMS = JSON.parse(process.env.INCIDENT_ALARMS);
const REPOSITORY = process.env.REPOSITORY;
const GITHUB_API_URL = process.env.GITHUB_API_URL;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN;
const ATTRIBUTION_WINDOW_MS = Number(process.env.ATTRIBUTION_WINDOW_MINUTES) * 60 * 1000;
const FLAP_WINDOW_MS = Number(process.env.FLAP_WINDOW_SECONDS) * 1000;
const RETENTION_SECONDS = Number(process.env.RETENTION_DAYS) * 24 * 60 * 60;

const DEPLOY_PREFIX = 'DEPLOY#';
const INCIDENT_PREFIX = 'INCIDENT#';

const deployKey = (environment, service) => DEPLOY_PREFIX + environment + '#' + service;
const incidentKey = (environment, service) => INCIDENT_PREFIX + environment + '#' + service;

/**
 * Sort keys are the ISO timestamp followed by an id. Lexicographic order on a
 * fixed-length ISO-8601 UTC string is chronological order, which is what makes
 * "the last deployment before time T" a plain backwards range query. The id
 * suffix keeps two events in the same millisecond from overwriting each other.
 */
const sortKey = (isoTimestamp, id) => isoTimestamp + '#' + id;

const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });
const BOOL = (value) => ({ BOOL: Boolean(value) });

let cachedToken;

const githubToken = async () => {
  if (!GITHUB_TOKEN_SECRET_ARN) return undefined;
  if (cachedToken !== undefined) return cachedToken || undefined;

  const result = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: GITHUB_TOKEN_SECRET_ARN }),
  );
  let token = '';
  try {
    const parsed = JSON.parse(result.SecretString || '{}');
    token = parsed.token || '';
  } catch (error) {
    // A secret stored as a bare string rather than JSON is a normal way to keep
    // a token, so it is read rather than rejected.
    token = result.SecretString || '';
  }
  cachedToken = token;
  return token || undefined;
};

const githubGet = async (path, token) => {
  const response = await fetch(GITHUB_API_URL + path, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + token,
      'user-agent': 'dora-metrics-recorder',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error('GitHub ' + path + ' returned ' + response.status);
  }
  return response.json();
};

/**
 * Earliest author date of the change, and where it came from.
 *
 * The pull request path is the real measurement. Under squash merge the branch
 * history does not survive onto the default branch, so the deployed commit's
 * author date is the merge time and measuring from it turns lead time into
 * pipeline duration. That fallback is still published, but under a different
 * Source dimension so the two never average together.
 *
 * Returns null when neither is available. Nothing substitutes a zero here: a
 * zero lead time is the best score the metric can take.
 */
const resolveChangeStart = async (detail, token) => {
  if (!token) return null;

  if (detail.pullRequestNumber) {
    // GitHub returns pull request commits oldest first, so the first element is
    // the earliest and there is no page to follow for the answer we want.
    const commits = await githubGet(
      '/repos/' + REPOSITORY + '/pulls/' + detail.pullRequestNumber + '/commits?per_page=100',
      token,
    );
    if (Array.isArray(commits) && commits.length > 0) {
      const authoredAt = Date.parse(commits[0].commit.author.date);
      if (Number.isFinite(authoredAt)) {
        return { authoredAt: authoredAt, source: 'pullRequest' };
      }
    }
  }

  if (detail.commitSha) {
    const commit = await githubGet('/repos/' + REPOSITORY + '/commits/' + detail.commitSha, token);
    const authoredAt = Date.parse(commit.commit.author.date);
    if (Number.isFinite(authoredAt)) {
      return { authoredAt: authoredAt, source: 'headCommit' };
    }
  }

  return null;
};

const putMetrics = async (metricData) => {
  if (metricData.length === 0) return;
  await cloudwatch.send(
    new PutMetricDataCommand({ Namespace: METRIC_NAMESPACE, MetricData: metricData }),
  );
};

const dimensions = (map) =>
  Object.keys(map).map((name) => ({ Name: name, Value: String(map[name]) }));

const recordDeployment = async (event) => {
  const detail = event.detail || {};
  const environment = detail.environment;
  const service = detail.service;
  if (!environment || !service) {
    throw new Error('deployment event is missing environment or service');
  }

  const outcome = detail.outcome === 'failed' ? 'failed' : 'succeeded';
  // The event's own time, never the clock. EventBridge retries and the DLQ
  // replay path both deliver late, and stamping those with the current time
  // would report a deployment that happened this morning as happening now.
  const deployedAtIso = detail.deployedAt || event.time;
  const deployedAt = Date.parse(deployedAtIso);
  if (!Number.isFinite(deployedAt)) {
    throw new Error('deployment event has an unparseable timestamp: ' + deployedAtIso);
  }
  const deploymentId = detail.deploymentId || detail.commitSha || String(deployedAt);
  const sk = sortKey(new Date(deployedAt).toISOString(), deploymentId);

  let leadTime = null;
  let leadTimeUnmeasurable = 0;
  if (outcome === 'succeeded') {
    try {
      const token = await githubToken();
      const start = await resolveChangeStart(detail, token);
      if (start && start.authoredAt <= deployedAt) {
        leadTime = {
          seconds: Math.round((deployedAt - start.authoredAt) / 1000),
          source: start.source,
        };
      } else if (start) {
        // A commit authored after its own deployment means a rewritten author
        // date, not a negative lead time. Counting it as unmeasurable is
        // honest; clamping it to zero would report the best possible score.
        console.warn(
          JSON.stringify({
            message: 'commit authored after deployment; lead time not published',
            deploymentId: deploymentId,
            authoredAt: new Date(start.authoredAt).toISOString(),
            deployedAt: new Date(deployedAt).toISOString(),
          }),
        );
        leadTimeUnmeasurable = 1;
      } else {
        leadTimeUnmeasurable = 1;
      }
    } catch (error) {
      // A GitHub outage must not lose the deployment itself. Three of the four
      // keys do not need GitHub at all.
      console.error(
        JSON.stringify({ message: 'lead time lookup failed', error: String(error) }),
      );
      leadTimeUnmeasurable = 1;
    }
  }

  const item = {
    pk: S(deployKey(environment, service)),
    sk: S(sk),
    recordType: S('deployment'),
    deploymentId: S(deploymentId),
    environment: S(environment),
    service: S(service),
    outcome: S(outcome),
    deployedAt: N(deployedAt),
    failureAttributed: BOOL(false),
    expiresAt: N(Math.floor(deployedAt / 1000) + RETENTION_SECONDS),
  };
  if (detail.commitSha) item.commitSha = S(detail.commitSha);
  if (detail.pullRequestNumber) item.pullRequestNumber = N(detail.pullRequestNumber);
  if (detail.version) item.version = S(detail.version);
  if (leadTime) {
    item.leadTimeSeconds = N(leadTime.seconds);
    item.leadTimeSource = S(leadTime.source);
  }

  try {
    await dynamodb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: item,
        // EventBridge delivers at least once, and the retry path above can
        // deliver the same event again after a partial failure. The key is
        // derived from the event, not the clock, so a redelivery collides here
        // instead of double-counting a deployment.
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.info(
        JSON.stringify({ message: 'duplicate deployment event ignored', deploymentId: deploymentId }),
      );
      return { duplicate: true };
    }
    throw error;
  }

  const metricData = [
    {
      MetricName: 'Deployments',
      Dimensions: dimensions({ Environment: environment, Service: service, Outcome: outcome }),
      Value: 1,
      Unit: 'Count',
      Timestamp: new Date(deployedAt),
    },
  ];
  if (leadTime) {
    metricData.push({
      MetricName: 'LeadTimeSeconds',
      Dimensions: dimensions({
        Environment: environment,
        Service: service,
        Source: leadTime.source,
      }),
      Value: leadTime.seconds,
      Unit: 'Seconds',
      Timestamp: new Date(deployedAt),
    });
  }
  if (leadTimeUnmeasurable) {
    metricData.push({
      MetricName: 'LeadTimeUnmeasurable',
      Value: 1,
      Unit: 'Count',
      Timestamp: new Date(deployedAt),
    });
  }
  await putMetrics(metricData);

  return { recorded: true, deploymentId: deploymentId, leadTime: leadTime };
};

/**
 * The most recent incident raised by one particular alarm.
 *
 * Scoped to the alarm rather than to the service because a service usually has
 * several alarms and they overlap: taking "the newest incident for this
 * service" would let a 5xx alarm's OK close a latency alarm's incident, and
 * would leave the 5xx incident open forever. Twenty records back is a bounded
 * read that covers any realistic interleaving.
 */
const latestIncidentForAlarm = async (environment, service, alarmName) => {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': S(incidentKey(environment, service)) },
      ScanIndexForward: false,
      Limit: 20,
    }),
  );
  return (result.Items || []).find((item) => item.alarmName && item.alarmName.S === alarmName);
};

/**
 * The deployment an incident should be blamed on: the newest successful one at
 * or before the incident started.
 *
 * Failed deployments are skipped rather than treated as the cause. A deployment
 * that failed did not reach production, so the code that is running is still
 * the previous release's, and that release is what the incident is about.
 */
const precedingDeployment = async (environment, service, startedAtIso) => {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND sk <= :sk',
      ExpressionAttributeValues: {
        ':pk': S(deployKey(environment, service)),
        ':sk': S(startedAtIso + '#\\uffff'),
      },
      ScanIndexForward: false,
      Limit: 10,
    }),
  );
  return (result.Items || []).find((item) => item.outcome && item.outcome.S === 'succeeded');
};

const openIncident = async (event, environment, service) => {
  const detail = event.detail || {};
  const alarmName = detail.alarmName;
  const startedAtIso = (detail.state && detail.state.timestamp) || event.time;
  const startedAt = Date.parse(startedAtIso);
  if (!Number.isFinite(startedAt)) {
    throw new Error('alarm state change has an unparseable timestamp: ' + startedAtIso);
  }

  // A flapping alarm is one incident, not one per oscillation. Without this a
  // service that rings six times in five minutes reports six failures each
  // recovering in seconds, which pushes change failure rate up and recovery
  // time down simultaneously.
  //
  // The merge is retroactive, and one artefact survives it: the close that is
  // about to be undone already published a RecoveryTimeSeconds datapoint, and
  // CloudWatch datapoints cannot be retracted. So a flapping episode leaves one
  // short reading behind alongside the correct full-episode one. Bounded and
  // visible rather than fixed, because the alternative is withholding every
  // recovery time for flapWindowSeconds on the chance that it flaps — which
  // would delay the honest majority to correct the rare exception. Incidents
  // and change failure rate, which is what the rate is built on, are unaffected.
  const previous = await latestIncidentForAlarm(environment, service, alarmName);
  if (
    previous &&
    previous.status &&
    previous.status.S === 'resolved' &&
    previous.resolvedAt &&
    startedAt - Number(previous.resolvedAt.N) <= FLAP_WINDOW_MS
  ) {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: previous.pk, sk: previous.sk },
        UpdateExpression:
          'SET #status = :open, reopenCount = if_not_exists(reopenCount, :zero) + :one ' +
          'REMOVE resolvedAt, recoveryTimeSeconds',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':open': S('open'), ':zero': N(0), ':one': N(1) },
      }),
    );
    return { reopened: true, incidentSk: previous.sk.S };
  }

  const attributed = await precedingDeployment(
    environment,
    service,
    new Date(startedAt).toISOString(),
  );
  const withinWindow =
    attributed && startedAt - Number(attributed.deployedAt.N) <= ATTRIBUTION_WINDOW_MS;
  const attribution = withinWindow ? 'deployment' : 'unattributed';

  const sk = sortKey(new Date(startedAt).toISOString(), alarmName);
  const item = {
    pk: S(incidentKey(environment, service)),
    sk: S(sk),
    recordType: S('incident'),
    alarmName: S(alarmName),
    environment: S(environment),
    service: S(service),
    status: S('open'),
    startedAt: N(startedAt),
    attribution: S(attribution),
    expiresAt: N(Math.floor(startedAt / 1000) + RETENTION_SECONDS),
  };
  if (withinWindow) {
    item.deploymentId = attributed.deploymentId;
    item.deploymentSk = attributed.sk;
  }

  try {
    await dynamodb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.info(JSON.stringify({ message: 'duplicate alarm transition ignored', sk: sk }));
      return { duplicate: true };
    }
    throw error;
  }

  if (withinWindow) {
    // The flag lives on the deployment, not on the incident, so that two
    // incidents from one bad deploy count as one change failure. Change failure
    // rate asks what fraction of deployments failed, not how many alarms rang.
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: attributed.pk, sk: attributed.sk },
        UpdateExpression: 'SET failureAttributed = :true',
        ExpressionAttributeValues: { ':true': BOOL(true) },
      }),
    );
  }

  await putMetrics([
    {
      MetricName: 'Incidents',
      Dimensions: dimensions({
        Environment: environment,
        Service: service,
        Attribution: attribution,
      }),
      Value: 1,
      Unit: 'Count',
      Timestamp: new Date(startedAt),
    },
  ]);

  return { opened: true, attribution: attribution, incidentSk: sk };
};

const resolveIncident = async (event, environment, service) => {
  const detail = event.detail || {};
  const alarmName = detail.alarmName;
  const resolvedAtIso = (detail.state && detail.state.timestamp) || event.time;
  const resolvedAt = Date.parse(resolvedAtIso);
  if (!Number.isFinite(resolvedAt)) {
    throw new Error('alarm state change has an unparseable timestamp: ' + resolvedAtIso);
  }

  const previous = await latestIncidentForAlarm(environment, service, alarmName);
  if (!previous || !previous.status || previous.status.S !== 'open') {
    // An OK with no open incident behind it is normal: the alarm was created in
    // OK, or the ALARM transition predates this stack. Recording a recovery for
    // it would invent an incident with an unknown start.
    console.info(
      JSON.stringify({ message: 'alarm cleared with no open incident', alarmName: alarmName }),
    );
    return { noOpenIncident: true };
  }

  const recoverySeconds = Math.round((resolvedAt - Number(previous.startedAt.N)) / 1000);
  const attribution = previous.attribution ? previous.attribution.S : 'unattributed';

  await dynamodb.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: previous.pk, sk: previous.sk },
      UpdateExpression:
        'SET #status = :resolved, resolvedAt = :resolvedAt, recoveryTimeSeconds = :recovery',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':resolved': S('resolved'),
        ':resolvedAt': N(resolvedAt),
        ':recovery': N(recoverySeconds),
      },
    }),
  );

  await putMetrics([
    {
      MetricName: 'RecoveryTimeSeconds',
      Dimensions: dimensions({
        Environment: environment,
        Service: service,
        Attribution: attribution,
      }),
      Value: recoverySeconds,
      Unit: 'Seconds',
      Timestamp: new Date(resolvedAt),
    },
  ]);

  return { resolved: true, recoverySeconds: recoverySeconds, attribution: attribution };
};

/**
 * Which service an alarm belongs to.
 *
 * A declared mapping, not a rule applied to the alarm name. Alarms here are
 * named after the metric they watch — "production-alb-5xx-elb",
 * "production-ecs-cpu-high" — so a prefix rule would file their incidents under
 * services called "alb" and "ecs". Those dimensions match no deployment, so
 * nothing would ever be attributed and change failure rate would read zero
 * forever, which is indistinguishable from a service that never breaks.
 */
const serviceForAlarm = (alarmName) => INCIDENT_ALARMS[alarmName] || null;

exports.handler = async (event) => {
  if (event['detail-type'] === '${DEPLOYMENT_EVENT_DETAIL_TYPE}' && event.source === '${DEPLOYMENT_EVENT_SOURCE}') {
    return recordDeployment(event);
  }

  if (event['detail-type'] === 'CloudWatch Alarm State Change') {
    const detail = event.detail || {};
    const target = serviceForAlarm(detail.alarmName);
    if (!target) {
      // Loud failure rather than a guessed service. An incident filed against
      // the wrong service moves two teams' numbers at once and neither will
      // recognise it. The rule only routes alarms that are in this map, so
      // reaching here means the two drifted apart.
      throw new Error(
        'alarm "' +
          detail.alarmName +
          '" is not in incidentAlarms; add it with its environment and service',
      );
    }

    const value = detail.state && detail.state.value;
    if (value === 'ALARM') return openIncident(event, target.environment, target.service);
    if (value === 'OK') return resolveIncident(event, target.environment, target.service);
    return { ignored: value };
  }

  throw new Error('unrecognised event: ' + event['detail-type']);
};
`;

/**
 * The aggregator, shipped inline.
 *
 * Exported as a string so `test/dora-aggregator-handler.test.ts` can compile and
 * run it. Everything here is a ratio, and a ratio computed over the wrong
 * denominator is the failure mode that never surfaces — it produces a number in
 * range, on the right axis, moving in a believable direction.
 */
export const DORA_AGGREGATOR_SOURCE = `
'use strict';
const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const region = process.env.AWS_REGION;
const dynamodb = new DynamoDBClient({ region });
const cloudwatch = new CloudWatchClient({ region });

const TABLE_NAME = process.env.TABLE_NAME;
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE;
const SERVICES = JSON.parse(process.env.SERVICES);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS);
const ATTRIBUTION_WINDOW_MS = Number(process.env.ATTRIBUTION_WINDOW_MINUTES) * 60 * 1000;

const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

const S = (value) => ({ S: String(value) });

const dimensions = (environment, service) => [
  { Name: 'Environment', Value: environment },
  { Name: 'Service', Value: service },
];

/** Every deployment record for a service inside the trailing window. */
const deploymentsInWindow = async (environment, service, windowStart) => {
  const items = [];
  let startKey;

  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND sk >= :from',
        ExpressionAttributeValues: {
          ':pk': S('DEPLOY#' + environment + '#' + service),
          ':from': S(new Date(windowStart).toISOString()),
        },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of result.Items || []) items.push(item);
    startKey = result.LastEvaluatedKey;
    // Paginated rather than capped. A truncated read would silently shrink the
    // denominator, and a change failure rate over "the first megabyte of
    // deployments" is not a change failure rate.
  } while (startKey);

  return items;
};

const summarise = (deployments, now) => {
  const ripeBefore = now - ATTRIBUTION_WINDOW_MS;

  let succeeded = 0;
  let failed = 0;
  let ripe = 0;
  let unripe = 0;
  let attributedFailures = 0;

  for (const item of deployments) {
    const outcome = item.outcome ? item.outcome.S : 'succeeded';
    if (outcome === 'failed') {
      // A deployment that never reached production is not a change failure —
      // it is a build that went red, and it belongs to deployment frequency's
      // numerator only by its absence. Counted separately so the two are not
      // confused.
      failed += 1;
      continue;
    }
    succeeded += 1;

    if (Number(item.deployedAt.N) > ripeBefore) {
      unripe += 1;
      continue;
    }
    ripe += 1;
    if (item.failureAttributed && item.failureAttributed.BOOL) attributedFailures += 1;
  }

  return {
    succeeded: succeeded,
    failed: failed,
    ripe: ripe,
    unripe: unripe,
    attributedFailures: attributedFailures,
    // Undefined rather than zero when nothing is ripe. Zero percent over zero
    // deployments is the most flattering possible reading of no information,
    // and it graphs identically to a genuinely clean month.
    changeFailureRate: ripe === 0 ? null : (attributedFailures / ripe) * 100,
    deploymentsPerDay: succeeded / WINDOW_DAYS,
  };
};

exports.handler = async (event) => {
  // The event's time when there is one, so a replayed or delayed invocation
  // recomputes the window it was scheduled for rather than the current one.
  const now = event && event.time ? Date.parse(event.time) : Date.now();
  const windowStart = now - WINDOW_MS;

  const metricData = [];
  const summaries = [];

  for (const target of SERVICES) {
    const deployments = await deploymentsInWindow(
      target.environment,
      target.service,
      windowStart,
    );
    const summary = summarise(deployments, now);
    summaries.push({ environment: target.environment, service: target.service, ...summary });

    const dims = dimensions(target.environment, target.service);
    const timestamp = new Date(now);

    metricData.push(
      {
        MetricName: 'DeploymentsPerDay',
        Dimensions: dims,
        Value: summary.deploymentsPerDay,
        // 'None', not 'Count/Second'. CloudWatch has no per-day unit, and
        // labelling a per-day rate as per-second makes the console render it
        // with an SI prefix — 0.0000116 deploys, which is both correct and
        // unreadable. The metric name carries the period instead.
        Unit: 'None',
        Timestamp: timestamp,
      },
      {
        MetricName: 'RipeDeployments',
        Dimensions: dims,
        Value: summary.ripe,
        Unit: 'Count',
        Timestamp: timestamp,
      },
      {
        MetricName: 'UnripeDeployments',
        Dimensions: dims,
        Value: summary.unripe,
        Unit: 'Count',
        Timestamp: timestamp,
      },
      {
        MetricName: 'FailedDeployments',
        Dimensions: dims,
        Value: summary.failed,
        Unit: 'Count',
        Timestamp: timestamp,
      },
    );

    if (summary.changeFailureRate !== null) {
      metricData.push({
        MetricName: 'ChangeFailureRate',
        Dimensions: dims,
        Value: summary.changeFailureRate,
        Unit: 'Percent',
        Timestamp: timestamp,
      });
    }
  }

  // PutMetricData accepts 1000 datapoints per call; five per service means the
  // chunking only matters past two hundred services, but a silent drop at that
  // point would be indistinguishable from a service that stopped deploying.
  for (let i = 0; i < metricData.length; i += 1000) {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: metricData.slice(i, i + 1000),
      }),
    );
  }

  console.info(
    JSON.stringify({ message: 'dora aggregation complete', windowDays: WINDOW_DAYS, summaries: summaries }),
  );

  return { summaries: summaries };
};
`;
