import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import {
  GOVERNED_TAGS,
  type GovernedTag,
  assertValidTaggingPolicy,
  costAllocationTagKeys,
} from './tagging-policy';

/** Namespace every metric this stack publishes lands in. */
export const COST_ALLOCATION_METRIC_NAMESPACE = 'Boilerplate/CostAllocation';

/** Bumped when the shape of the reporter's structured log lines changes. */
export const COST_ALLOCATION_LOG_SCHEMA_VERSION = 1;

/** Dimension carrying the tag key a datapoint is about. */
export const TAG_KEY_DIMENSION = 'TagKey';
/** Dimension carrying one value of that tag. */
export const TAG_VALUE_DIMENSION = 'TagValue';
/** Dimension on the account-wide metrics, matching `RightSizingStack`'s. */
export const SCOPE_DIMENSION = 'Scope';
/** Cost Explorer answers per account, so there is one scope and it is the account. */
export const ACCOUNT_SCOPE = 'account';

export const TAG_ACTIVATED_METRIC = 'TagActivated';
export const ATTRIBUTED_COST_METRIC = 'AttributedCost';
export const UNATTRIBUTED_COST_METRIC = 'UnattributedCost';
export const UNATTRIBUTED_SHARE_METRIC = 'UnattributedSharePercent';
export const UNEXPECTED_TAG_VALUE_METRIC = 'UnexpectedTagValue';
export const REPORT_SUCCESS_METRIC = 'ReportSuccess';

/** Cost Explorer's own separator between a tag key and its value in a group key. */
export const TAG_GROUP_SEPARATOR = '$';

/** Cost metric pulled from Cost Explorer. Unblended is what the invoice charges. */
export const COST_METRIC = 'UnblendedCost';

/** Status `ce:ListCostAllocationTags` reports for a key Billing has activated. */
export const TAG_STATUS_ACTIVE = 'Active';

/** Once a day: Cost Explorer refreshes at most that often, and each query is billed. */
export const DEFAULT_REPORT_SCHEDULE_HOURS = 24;

/** Older than this and the dashboard is drawing a number nobody refreshed. */
export const DEFAULT_REPORT_STALE_HOURS = 48;

/** Trailing window each run reports over. */
export const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * Default ceiling on the share of spend with no value for a governed tag.
 *
 * Not zero, and it cannot be. Tax, support charges, and most inter-AZ data
 * transfer are not attached to a taggable resource at all, so Cost Explorer
 * reports them in the untagged bucket for every tag key that exists. Five
 * account-scoped stacks here carry no `Environment` tag by design, this one
 * among them. And an SCP
 * does not apply to the organization's management account, so anything created
 * there is untagged whatever the policy says. 15% is the headroom those three
 * together need; the alarm is on the trend crossing it, not on the number being
 * above nought.
 */
export const DEFAULT_UNATTRIBUTED_SHARE_PERCENT = 15;

export interface CostAllocationStackProps extends cdk.StackProps {
  /** Topic every alarm here notifies. Shared with the rest of the account's alarms. */
  readonly alarmTopic: sns.ITopic;
  /** The tag catalogue. Defaults to {@link GOVERNED_TAGS}. */
  readonly governedTags?: readonly GovernedTag[];
  /** Hours between reports (default {@link DEFAULT_REPORT_SCHEDULE_HOURS}). */
  readonly reportScheduleHours?: number;
  /** Hours without a successful report before alarming (default {@link DEFAULT_REPORT_STALE_HOURS}). */
  readonly reportStaleHours?: number;
  /** Trailing days each report covers (default {@link DEFAULT_LOOKBACK_DAYS}). */
  readonly lookbackDays?: number;
  /** Untagged-share ceiling, overall or per tag key. */
  readonly unattributedSharePercent?: number | Record<string, number>;
  readonly logRetention?: logs.RetentionDays;
  readonly dashboardName?: string;
}

/**
 * The cost-allocation dashboard, and the instruments that say whether it can be
 * believed.
 *
 * `policy/organizations/tag-enforcement-scp.json` is the half that stops new
 * untagged resources appearing. This is the half that says whether it worked,
 * and it exists because every way the first half can fail produces a dashboard
 * that looks fine:
 *
 *   • **A tag key that was never activated in Billing.** Cost Explorer accepts
 *     the grouping and returns an empty list of groups. Every series on the
 *     widget is then flat at zero, which is what a tag nobody spends against
 *     looks like. Activation is read first, on its own, and published as
 *     `TagActivated` — the same shape as the enrolment read in
 *     `RightSizingStack`, for the same reason.
 *
 *   • **Activation is not retroactive.** A key activated today carries no data
 *     for last month, ever. The widget for a freshly activated key is therefore
 *     correct and empty, and the `TextWidget` says so, because the alternative
 *     is someone concluding the account spent nothing.
 *
 *   • **The untagged bucket being dropped.** Cost Explorer returns untagged
 *     spend as the group `Environment$` — the key, the separator, and nothing.
 *     A reporter that treats a group with no value as a parse failure and skips
 *     it publishes a dashboard where 100% of cost is attributed. That bucket is
 *     the single most important series here, so it is published as its own
 *     metric and the share is what the alarm reads.
 *
 *   • **A tag value nobody declared.** The dashboard draws one series per value
 *     in the catalogue, because a CloudWatch widget has to name its dimensions.
 *     A resource tagged `Environment=Prod` is therefore spend that appears in no
 *     series and in no untagged bucket — it would simply be missing from the
 *     total. `UnexpectedTagValue` counts those, and it is the metric that
 *     catches a pre-SCP resource or a spelling the tag policy is not attached
 *     to.
 *
 * One stack, account-scoped: Cost Explorer answers per account, so a second copy
 * would bill a second set of queries to return the same figures. That is also
 * why nothing here carries an `Environment` tag.
 *
 * Costs money to run, which belongs in the open: `ce:GetCostAndUsage` is billed
 * per request, and this makes one per activated tag key per run. See
 * `docs/cost-allocation.md`.
 */
export class CostAllocationStack extends cdk.Stack {
  /** Reads Cost Explorer and publishes the metrics behind the dashboard. */
  public readonly reporterFunction: lambda.Function;
  /** Scheduled invocations EventBridge could not deliver. */
  public readonly reporterDlq: sqs.Queue;
  /** The schedule that drives the report. */
  public readonly reportRule: events.Rule;
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarms: {
    /** One per activated key: Billing does not have it activated. */
    readonly tagNotActivated: Record<string, cloudwatch.Alarm>;
    /** One per activated key: too much spend carries no value for it. */
    readonly unattributedShare: Record<string, cloudwatch.Alarm>;
    readonly reportStale: cloudwatch.Alarm;
    readonly reporterErrors: cloudwatch.Alarm;
    readonly reportUndelivered: cloudwatch.Alarm;
  };

  private readonly governedTags: readonly GovernedTag[];

  constructor(scope: Construct, id: string, props: CostAllocationStackProps) {
    super(scope, id, props);

    const governedTags = props.governedTags ?? GOVERNED_TAGS;
    this.governedTags = governedTags;

    // Offline arithmetic: a catalogue that cannot generate a valid SCP should
    // not reach a template either.
    assertValidTaggingPolicy(governedTags);

    const groupedKeys = costAllocationTagKeys(governedTags);
    if (groupedKeys.length === 0) {
      throw new Error(
        'CostAllocationStack: no tag in the catalogue is activated for cost allocation. The ' +
          'reporter would query nothing and the dashboard would draw nothing, which is ' +
          'indistinguishable from an account whose spend is fully attributed.',
      );
    }

    const reportScheduleHours = props.reportScheduleHours ?? DEFAULT_REPORT_SCHEDULE_HOURS;
    const reportStaleHours = props.reportStaleHours ?? DEFAULT_REPORT_STALE_HOURS;
    const lookbackDays = props.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

    if (reportStaleHours <= reportScheduleHours) {
      throw new Error(
        `CostAllocationStack: reportStaleHours (${reportStaleHours}) must exceed ` +
          `reportScheduleHours (${reportScheduleHours}). A staleness window no longer than the ` +
          'schedule alarms on the gap between two healthy reports.',
      );
    }

    if (lookbackDays < 1) {
      throw new Error(
        `CostAllocationStack: lookbackDays (${lookbackDays}) must be at least 1. Cost Explorer ` +
          'takes a half-open interval, so a zero-day window asks for no days at all and returns ' +
          'an empty result that reads as zero spend.',
      );
    }

    const shareThreshold = (key: string): number => {
      const configured = props.unattributedSharePercent;
      if (typeof configured === 'number') return configured;
      return configured?.[key] ?? DEFAULT_UNATTRIBUTED_SHARE_PERCENT;
    };

    // ── The reporter ──────────────────────────────────────────────────────────

    const logGroup = new logs.LogGroup(this, 'ReporterLogGroup', {
      logGroupName: `/aws/lambda/${this.stackName}-cost-allocation-reporter`,
      retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    (logGroup.node.defaultChild as logs.CfnLogGroup).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_158',
          comment:
            'No CMK on the log group: AWS-managed encryption at rest already applies, and the ' +
            'contents are tag keys, tag values and this account’s own spend totals — the same ' +
            'figures Cost Explorer shows anyone who can open the Billing console.',
        },
      ],
    });

    // A missed report is a missed datapoint rather than a lost event: the next
    // run reads the same trailing window. The queue is here for the record that
    // EventBridge gave up, because a schedule that stopped firing and an
    // account that stopped spending publish the same thing.
    this.reporterDlq = new sqs.Queue(this, 'ReporterDlq', {
      queueName: `${this.stackName}-reporter-dlq`,
      // The AWS-managed SQS key rather than SSE-SQS: both encrypt at rest with
      // no key to rotate, and only this one satisfies CKV_AWS_27.
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kms.Alias.fromAliasName(this, 'CostAllocationSqsKey', 'alias/aws/sqs'),
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const reporterRole = new iam.Role(this, 'ReporterRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Reads Cost Explorer tag groupings and publishes cost-allocation coverage',
    });
    logGroup.grantWrite(reporterRole);

    reporterRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCostAllocationData',
        // Cost Explorer takes no resource ARNs on either of these: both are
        // account-scoped reads and `Resource: "*"` is the only form they
        // accept. Both are reads. In particular the role holds no
        // `ce:UpdateCostAllocationTagsStatus`, so it cannot activate a tag to
        // make its own coverage metric go green — activation is a deliberate
        // act in the Billing console, recorded in lib/tagging-policy.ts.
        actions: ['ce:GetCostAndUsage', 'ce:ListCostAllocationTags'],
        resources: ['*'],
      }),
    );

    reporterRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishCostAllocationMetrics',
        // PutMetricData rejects any resource other than `*`, so the namespace
        // condition is the only scope available — and it is the one that
        // matters: this role can write cost-allocation metrics and nothing else.
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': COST_ALLOCATION_METRIC_NAMESPACE },
        },
      }),
    );

    this.reporterFunction = new lambda.Function(this, 'CostAllocationReporter', {
      functionName: `${this.stackName}-cost-allocation-reporter`,
      description:
        'Groups Cost Explorer spend by each activated cost allocation tag and publishes the ' +
        'attributed, unattributed, and undeclared shares',
      runtime: lambda.Runtime.NODEJS_22_X,
      // arm64: inline source on a managed runtime, so nothing in the artifact
      // is architecture-specific. 20% cheaper per GB-second — docs/graviton.md.
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      role: reporterRole,
      logGroup,
      code: lambda.Code.fromInline(COST_ALLOCATION_REPORTER_SOURCE),
      // One paginated Cost Explorer query per tag key. Generous because the
      // alternative to a slow report is a timed-out one, which publishes no
      // ReportSuccess and tickets the staleness alarm for a reason that is not
      // staleness.
      timeout: cdk.Duration.minutes(5),
      deadLetterQueue: this.reporterDlq,
      // One at a time. Two concurrent reports would publish two sets of
      // datapoints for one window, and every cost metric here is read as a
      // MAXIMUM over the period precisely so a duplicate does not double it.
      reservedConcurrentExecutions: 1,
      environment: {
        METRIC_NAMESPACE: COST_ALLOCATION_METRIC_NAMESPACE,
        SCOPE: ACCOUNT_SCOPE,
        LOG_SCHEMA_VERSION: String(COST_ALLOCATION_LOG_SCHEMA_VERSION),
        TAG_CATALOGUE: JSON.stringify(reporterCatalogue(governedTags)),
        LOOKBACK_DAYS: String(lookbackDays),
        COST_METRIC,
        TAG_GROUP_SEPARATOR,
        TAG_STATUS_ACTIVE,
      },
    });

    (this.reporterFunction.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler calls two Cost Explorer read APIs and PutMetricData. A ' +
            'VPC would need a NAT gateway or interface endpoints to reach endpoints it is no ' +
            'closer to, for a function that runs once a day and holds nothing.',
        },
        {
          id: 'CKV_AWS_173',
          comment:
            'No KMS key on the environment variables: they hold a metric namespace, a window ' +
            'length, and the tag catalogue already published in docs/cost-allocation.md. ' +
            'Nothing secret reaches this function — it has no credential to read and no data ' +
            'store to open.',
        },
      ],
    });

    // ── The schedule ──────────────────────────────────────────────────────────
    this.reportRule = new events.Rule(this, 'ReportRule', {
      ruleName: `${this.stackName}-cost-allocation-report`,
      description: `Groups spend by cost allocation tag every ${reportScheduleHours}h`,
      schedule: events.Schedule.rate(cdk.Duration.hours(reportScheduleHours)),
      targets: [
        new targets.LambdaFunction(this.reporterFunction, {
          deadLetterQueue: this.reporterDlq,
          retryAttempts: 2,
        }),
      ],
    });

    // ── The alarms ────────────────────────────────────────────────────────────

    const alarmAction = new cloudwatchActions.SnsAction(props.alarmTopic);

    const tagNotActivated: Record<string, cloudwatch.Alarm> = {};
    const unattributedShare: Record<string, cloudwatch.Alarm> = {};

    for (const key of groupedKeys) {
      const activated = new cloudwatch.Alarm(this, `TagNotActivatedAlarm${key}`, {
        alarmName: `cost-allocation-tag-not-activated-${key.toLowerCase()}`,
        alarmDescription:
          `'${key}' is declared as a cost allocation tag and Billing does not have it ` +
          'activated. Cost Explorer accepts the grouping and returns no groups, so every ' +
          'series for this key renders flat at zero — which is what a tag nobody spends ' +
          'against looks like. Activate it in Billing → Cost allocation tags; the data starts ' +
          'from the activation date and is never backfilled.',
        metric: new cloudwatch.Metric({
          namespace: COST_ALLOCATION_METRIC_NAMESPACE,
          metricName: TAG_ACTIVATED_METRIC,
          dimensionsMap: { [TAG_KEY_DIMENSION]: key },
          statistic: cloudwatch.Stats.MINIMUM,
          period: cdk.Duration.hours(reportScheduleHours),
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        // Not breaching on missing data: a report that did not run leaves this
        // metric absent, and `reportStale` is the one alarm that owns absence.
        // Two alarms for one cause is two tickets for one cause.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      activated.addAlarmAction(alarmAction);
      tagNotActivated[key] = activated;

      const threshold = shareThreshold(key);
      const share = new cloudwatch.Alarm(this, `UnattributedShareAlarm${key}`, {
        alarmName: `cost-allocation-unattributed-${key.toLowerCase()}`,
        alarmDescription:
          `More than ${threshold}% of spend in the trailing ${lookbackDays}d carries no ` +
          `'${key}' value. Some of that is structural — tax, support, and most data transfer ` +
          'are not attached to a taggable resource, and the management account is outside ' +
          'every SCP — so this alarms on the share growing past the headroom those need, not ' +
          'on it being above nought.',
        metric: new cloudwatch.Metric({
          namespace: COST_ALLOCATION_METRIC_NAMESPACE,
          metricName: UNATTRIBUTED_SHARE_METRIC,
          dimensionsMap: { [TAG_KEY_DIMENSION]: key },
          statistic: cloudwatch.Stats.MAXIMUM,
          period: cdk.Duration.hours(reportScheduleHours),
        }),
        threshold,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      share.addAlarmAction(alarmAction);
      unattributedShare[key] = share;
    }

    // The one alarm that owns absence. Every other alarm here tolerates missing
    // data so that a report which never ran produces one ticket rather than
    // 2n + 1 of them.
    const reportStale = new cloudwatch.Alarm(this, 'ReportStaleAlarm', {
      alarmName: 'cost-allocation-report-stale',
      alarmDescription:
        `No successful cost-allocation report in ${reportStaleHours}h. The dashboard is still ` +
        'drawing the last figures it was given, and a stale cost chart is indistinguishable ' +
        'from a steady one.',
      metric: new cloudwatch.Metric({
        namespace: COST_ALLOCATION_METRIC_NAMESPACE,
        metricName: REPORT_SUCCESS_METRIC,
        dimensionsMap: { [SCOPE_DIMENSION]: ACCOUNT_SCOPE },
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.hours(reportStaleHours),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    reportStale.addAlarmAction(alarmAction);

    const reporterErrors = new cloudwatch.Alarm(this, 'ReporterErrorsAlarm', {
      alarmName: 'cost-allocation-reporter-errors',
      alarmDescription:
        'The cost-allocation reporter threw. Distinct from staleness: an invocation that ' +
        'throws after publishing some keys leaves a dashboard that is partly fresh.',
      metric: this.reporterFunction.metricErrors({
        period: cdk.Duration.hours(reportScheduleHours),
        statistic: cloudwatch.Stats.SUM,
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    reporterErrors.addAlarmAction(alarmAction);

    const reportUndelivered = new cloudwatch.Alarm(this, 'ReportUndeliveredAlarm', {
      alarmName: 'cost-allocation-report-undelivered',
      alarmDescription:
        'EventBridge could not deliver a scheduled report and sent it to the dead-letter ' +
        'queue. The schedule exists and is not reaching the function.',
      metric: this.reporterDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.hours(reportScheduleHours),
        statistic: cloudwatch.Stats.MAXIMUM,
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    reportUndelivered.addAlarmAction(alarmAction);

    this.alarms = {
      tagNotActivated,
      unattributedShare,
      reportStale,
      reporterErrors,
      reportUndelivered,
    };

    // ── The dashboard ─────────────────────────────────────────────────────────

    const dashboardName = props.dashboardName ?? 'cost-allocation';
    this.dashboard = new cloudwatch.Dashboard(this, 'CostAllocationDashboard', {
      dashboardName,
      widgets: this.buildWidgets(groupedKeys, lookbackDays, shareThreshold),
    });

    // ── Tags ──────────────────────────────────────────────────────────────────
    // No `Environment`: Cost Explorer answers per account, so this stack spans
    // both environments and has no true value to give. That is the same
    // exemption `policy/cloudformation/tags.rego` records for the other
    // account-scoped stacks — and it is itself a documented contributor to the
    // untagged slice this dashboard draws.
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CostAllocationMetricNamespace', {
      value: COST_ALLOCATION_METRIC_NAMESPACE,
      description: 'CloudWatch namespace the cost-allocation metrics are published to',
      exportName: `${this.stackName}-metric-namespace`,
    });

    new cdk.CfnOutput(this, 'CostAllocationDashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboardName}`,
      description: 'Direct link to the cost-allocation dashboard',
      exportName: `${this.stackName}-dashboard-url`,
    });

    new cdk.CfnOutput(this, 'CostAllocationTagKeys', {
      value: groupedKeys.join(','),
      description:
        'Tag keys this account must have activated under Billing → Cost allocation tags. ' +
        'Activation is not retroactive.',
      exportName: `${this.stackName}-tag-keys`,
    });

    new cdk.CfnOutput(this, 'CostAllocationReporterDlqUrl', {
      value: this.reporterDlq.queueUrl,
      description: 'Scheduled reports EventBridge could not deliver',
      exportName: `${this.stackName}-reporter-dlq-url`,
    });
  }

  private costMetric(
    metricName: string,
    dimensionsMap: Record<string, string>,
    label: string,
    color?: string,
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: COST_ALLOCATION_METRIC_NAMESPACE,
      metricName,
      dimensionsMap,
      // MAXIMUM, not SUM: each run republishes the same trailing window, so two
      // runs in one period are two measurements of one figure. Summing them
      // would double the bill on the chart every time a retry succeeded.
      statistic: cloudwatch.Stats.MAXIMUM,
      period: cdk.Duration.days(1),
      label,
      ...(color ? { color } : {}),
    });
  }

  private buildWidgets(
    groupedKeys: readonly string[],
    lookbackDays: number,
    shareThreshold: (key: string) => number,
  ): cloudwatch.IWidget[][] {
    const rows: cloudwatch.IWidget[][] = [];

    rows.push([
      new cloudwatch.SingleValueWidget({
        title: `Share of spend with no governed tag value (${lookbackDays}d trailing)`,
        metrics: groupedKeys.map((key) =>
          this.costMetric(UNATTRIBUTED_SHARE_METRIC, { [TAG_KEY_DIMENSION]: key }, key),
        ),
        width: 12,
        height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: 'Instrument health — tag activation and undeclared values',
        left: groupedKeys.map((key) =>
          this.costMetric(TAG_ACTIVATED_METRIC, { [TAG_KEY_DIMENSION]: key }, `${key} activated`),
        ),
        right: groupedKeys.map((key) =>
          this.costMetric(
            UNEXPECTED_TAG_VALUE_METRIC,
            { [TAG_KEY_DIMENSION]: key },
            `${key} undeclared values`,
            cloudwatch.Color.ORANGE,
          ),
        ),
        leftYAxis: { min: 0, max: 1, label: 'Activated', showUnits: false },
        rightYAxis: { min: 0, label: 'Values', showUnits: false },
        width: 12,
        height: 5,
      }),
    ]);

    for (const key of groupedKeys) {
      const tag = this.governedTags.find((candidate) => candidate.key === key);
      const values = tag?.allowedValues ?? [];

      rows.push([
        new cloudwatch.GraphWidget({
          title: `${key} — ${COST_METRIC} by value (${lookbackDays}d trailing)`,
          stacked: true,
          left: [
            ...values.map((value) =>
              this.costMetric(
                ATTRIBUTED_COST_METRIC,
                { [TAG_KEY_DIMENSION]: key, [TAG_VALUE_DIMENSION]: value },
                value,
              ),
            ),
            // Last, so it stacks on top: the untagged slice is the one series
            // on this widget that is supposed to shrink.
            this.costMetric(
              UNATTRIBUTED_COST_METRIC,
              { [TAG_KEY_DIMENSION]: key },
              `no ${key} value`,
              cloudwatch.Color.GREY,
            ),
          ],
          leftYAxis: { min: 0, label: 'USD', showUnits: false },
          width: 12,
          height: 6,
        }),
        new cloudwatch.GraphWidget({
          title: `${key} — unattributed share against its ceiling`,
          left: [
            this.costMetric(
              UNATTRIBUTED_SHARE_METRIC,
              { [TAG_KEY_DIMENSION]: key },
              `${key} unattributed`,
            ),
          ],
          leftAnnotations: [
            {
              value: shareThreshold(key),
              label: `alarm > ${shareThreshold(key)}%`,
              color: cloudwatch.Color.RED,
            },
          ],
          leftYAxis: { min: 0, max: 100, label: 'Percent', showUnits: false },
          width: 12,
          height: 6,
        }),
      ]);
    }

    rows.push([
      new cloudwatch.TextWidget({
        markdown: [
          '## How to read this dashboard',
          '',
          '**The grey slice is not a defect count.** Tax, support charges and most inter-AZ data',
          'transfer are not attached to a taggable resource, so Cost Explorer files them under the',
          'untagged bucket for every tag key that exists. Five account-scoped stacks here carry no',
          '`Environment` tag deliberately. And an SCP never applies to the organization’s',
          'management account, so anything created there is untagged whatever the policy says.',
          `The alarm fires on the share crossing its ceiling, not on it being above nought.`,
          '',
          '**An empty widget may be a correct one.** Cost allocation tag activation is not',
          'retroactive: a key activated today has no data before today and never will. Check the',
          '*Instrument health* widget first — if `activated` is 0 for a key, Cost Explorer returned',
          'no groups at all and every series below is flat zero for that reason alone.',
          '',
          '**Undeclared values are invisible in the cost widgets.** A widget can only name series',
          'it was built with, so spend tagged with a value outside the catalogue appears in no',
          'series *and* in no untagged bucket. The orange series counts them; a non-zero reading',
          'means either a resource that predates the SCP or a spelling the tag policy does not',
          'cover.',
          '',
          `**Series are a ${lookbackDays}-day trailing total republished on every run**, and are read as`,
          'MAXIMUM rather than SUM so a retry does not double the chart.',
          '',
          'Enforcement lives in `policy/organizations/tag-enforcement-scp.json`; see',
          '`docs/cost-allocation.md`.',
        ].join('\n'),
        width: 24,
        height: 9,
      }),
    ]);

    return rows;
  }
}

/** One catalogue entry as the reporter receives it. */
export interface ReporterTagEntry {
  readonly key: string;
  readonly values: readonly string[];
}

/** The activated subset of the catalogue, trimmed to what the handler reads. */
export const reporterCatalogue = (
  tags: readonly GovernedTag[] = GOVERNED_TAGS,
): ReporterTagEntry[] =>
  tags
    .filter((tag) => tag.costAllocation === 'activated')
    .map((tag) => ({ key: tag.key, values: [...(tag.allowedValues ?? [])] }));

/**
 * The reporter, as it ships.
 *
 * `lambda.Code.fromInline` means nothing in the normal CDK pipeline parses this:
 * `tsc` sees a template literal and `cdk synth` embeds it verbatim. So it is
 * exported and `test/cost-allocation-reporter-handler.test.ts` loads it into a
 * function scope with `require` and `process` supplied — the arrangement
 * `test/right-sizing-sweeper-handler.test.ts` uses, and necessary here for the
 * same reason: every failure mode of this handler ends in a *smaller*
 * unattributed figure, and a smaller one is what a well-tagged account
 * publishes.
 *
 * Four things it does that are worth saying out loud:
 *
 *   • **Activation is read first and alone.** `ce:ListCostAllocationTags` is the
 *     only way to tell an un-activated key from a key nobody spent against, and
 *     a run that wrapped both calls in one `try` would publish a tidy set of
 *     zeroes for a grouping AWS never had.
 *
 *   • **The empty value is the untagged bucket, not a parse failure.** Cost
 *     Explorer returns untagged spend as `Environment$` — key, separator,
 *     nothing. Skipping a group whose value is empty publishes a dashboard
 *     where everything is attributed.
 *
 *   • **A value outside the catalogue is counted, not dropped.** The dashboard
 *     names its series up front, so an undeclared value would otherwise vanish
 *     from both the attributed series and the untagged one, and the two would
 *     stop summing to the bill.
 *
 *   • **The window is half-open.** Cost Explorer's `End` is exclusive and its
 *     daily data for the current day is partial, so the window ends at today
 *     and covers whole days only. A window that included today would fall every
 *     morning and rise through the day, on every series at once.
 */
export const COST_ALLOCATION_REPORTER_SOURCE = `
const {
  CostExplorerClient,
  GetCostAndUsageCommand,
  ListCostAllocationTagsCommand,
} = require('@aws-sdk/client-cost-explorer');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const costExplorer = new CostExplorerClient({});
const cloudwatch = new CloudWatchClient({});

const NAMESPACE = process.env.METRIC_NAMESPACE;
const SCOPE = process.env.SCOPE || 'account';
const SCHEMA_VERSION = Number(process.env.LOG_SCHEMA_VERSION || '1');
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || '7');
const COST_METRIC = process.env.COST_METRIC || 'UnblendedCost';
const SEPARATOR = process.env.TAG_GROUP_SEPARATOR || '$';
const STATUS_ACTIVE = process.env.TAG_STATUS_ACTIVE || 'Active';

const catalogue = JSON.parse(process.env.TAG_CATALOGUE || '[]');

const log = (record) => console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...record }));

/** 'YYYY-MM-DD' in UTC, which is the only format Cost Explorer accepts. */
const isoDay = (date) => date.toISOString().slice(0, 10);

/**
 * The reporting window, half-open and whole days only.
 *
 * End is exclusive and today's daily figures are partial until the day closes,
 * so including today would make every series fall at midnight and climb back
 * through the day — on all of them at once, which reads as a real change.
 */
const window = (now) => {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return { Start: isoDay(start), End: isoDay(end) };
};

/**
 * Split a Cost Explorer group key into its tag value.
 *
 * The shape is 'Key$Value', and 'Key$' — separator present, value empty — is how
 * untagged spend is reported. A value may itself contain the separator, so the
 * split is on the first occurrence only.
 */
const valueOf = (groupKey, tagKey) => {
  const text = String(groupKey == null ? '' : groupKey);
  const prefix = tagKey + SEPARATOR;
  if (text.indexOf(prefix) === 0) return text.slice(prefix.length);
  const index = text.indexOf(SEPARATOR);
  return index === -1 ? text : text.slice(index + 1);
};

const amountOf = (group) => {
  const metric = (group.Metrics || {})[COST_METRIC] || {};
  const amount = Number(metric.Amount);
  return Number.isFinite(amount) ? amount : 0;
};

const paginate = async (build) => {
  const groups = [];
  let token;
  do {
    const response = await costExplorer.send(build(token));
    for (const result of response.ResultsByTime || []) {
      for (const group of result.Groups || []) groups.push(group);
    }
    token = response.NextPageToken;
  } while (token);
  return groups;
};

const publish = async (metrics) => {
  const data = metrics.map((metric) => ({
    MetricName: metric.name,
    Unit: metric.unit,
    Value: metric.value,
    Dimensions: metric.dimensions,
  }));
  if (data.length === 0) return;
  // PutMetricData takes at most 1000 metrics per call. Chunked at 20 anyway: a
  // run that throws on a limit publishes nothing at all, including the
  // ReportSuccess the staleness alarm reads.
  for (let index = 0; index < data.length; index += 20) {
    await cloudwatch.send(
      new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: data.slice(index, index + 20) }),
    );
  }
};

exports.handler = async () => {
  const period = window(new Date());

  // Activation first, on its own. An un-activated key and a key nobody spent
  // against return the same thing from GetCostAndUsage — no groups — and only
  // this call tells them apart.
  //
  // Paginated, because an account may activate up to 500 cost allocation tags
  // and this call returns a page at a time. An unpaginated read would report
  // every key past the first page as not activated, which is an alarm on a
  // correctly configured account and, worse, no cost query for those keys.
  const activeKeys = new Set();
  let activationToken;
  do {
    const activation = await costExplorer.send(new ListCostAllocationTagsCommand({
      Status: STATUS_ACTIVE,
      ...(activationToken ? { NextToken: activationToken } : {}),
    }));
    for (const tag of activation.CostAllocationTags || []) {
      if (tag.Status === STATUS_ACTIVE) activeKeys.add(tag.TagKey);
    }
    activationToken = activation.NextToken;
  } while (activationToken);

  const metrics = [];
  const summary = [];

  for (const entry of catalogue) {
    const activated = activeKeys.has(entry.key);
    metrics.push({
      name: 'TagActivated',
      unit: 'Count',
      value: activated ? 1 : 0,
      dimensions: [{ Name: 'TagKey', Value: entry.key }],
    });

    if (!activated) {
      // Deliberately no cost metrics for this key: a zero here is
      // indistinguishable from a measured zero, and the query costs money to
      // make.
      log({
        event: 'cost-allocation-key',
        scope: SCOPE,
        tagKey: entry.key,
        activated: false,
        note:
          'Not activated under Billing -> Cost allocation tags, so no grouping was requested. ' +
          'Cost Explorer would have returned no groups, which renders identically to an ' +
          'account that spent nothing against this tag. Activation is not retroactive.',
      });
      summary.push({ tagKey: entry.key, activated: false });
      continue;
    }

    const groups = await paginate((token) => new GetCostAndUsageCommand({
      TimePeriod: period,
      Granularity: 'DAILY',
      Metrics: [COST_METRIC],
      GroupBy: [{ Type: 'TAG', Key: entry.key }],
      ...(token ? { NextPageToken: token } : {}),
    }));

    const declared = new Set(entry.values || []);
    const byValue = new Map();
    let unattributed = 0;
    let total = 0;
    const undeclared = new Set();

    for (const group of groups) {
      const amount = amountOf(group);
      total += amount;
      const value = valueOf((group.Keys || [])[0], entry.key);

      if (value === '') {
        // The untagged bucket. Not a parse failure: this is how Cost Explorer
        // reports spend carrying no value for the grouping tag, and dropping it
        // publishes a dashboard on which everything is attributed.
        unattributed += amount;
        continue;
      }

      if (!declared.has(value)) {
        // The dashboard names its series in advance, so this spend would appear
        // in no series and in no untagged bucket — the chart would simply stop
        // summing to the bill. Counted here instead.
        undeclared.add(value);
        continue;
      }

      byValue.set(value, (byValue.get(value) || 0) + amount);
    }

    for (const value of declared) {
      metrics.push({
        name: 'AttributedCost',
        unit: 'None',
        value: byValue.get(value) || 0,
        dimensions: [{ Name: 'TagKey', Value: entry.key }, { Name: 'TagValue', Value: value }],
      });
    }

    metrics.push({
      name: 'UnattributedCost',
      unit: 'None',
      value: unattributed,
      dimensions: [{ Name: 'TagKey', Value: entry.key }],
    });

    metrics.push({
      name: 'UnexpectedTagValue',
      unit: 'Count',
      value: undeclared.size,
      dimensions: [{ Name: 'TagKey', Value: entry.key }],
    });

    // A share of nothing is not nought per cent, it is undefined. Publishing 0
    // for an account with no spend in the window would read as perfect
    // attribution, so the metric is omitted and the alarm's missing-data
    // handling decides.
    if (total > 0) {
      metrics.push({
        name: 'UnattributedSharePercent',
        unit: 'Percent',
        value: (unattributed / total) * 100,
        dimensions: [{ Name: 'TagKey', Value: entry.key }],
      });
    }

    log({
      event: 'cost-allocation-key',
      scope: SCOPE,
      tagKey: entry.key,
      activated: true,
      start: period.Start,
      end: period.End,
      groupsRead: groups.length,
      total,
      unattributed,
      undeclaredValues: [...undeclared].sort(),
    });

    summary.push({
      tagKey: entry.key,
      activated: true,
      total,
      unattributed,
      undeclared: undeclared.size,
    });
  }

  // Last, and only once every key above has been read and published: this is
  // the metric the staleness alarm sees, and a run that published it first
  // would report a healthy report for one that threw halfway.
  metrics.push({
    name: 'ReportSuccess',
    unit: 'Count',
    value: 1,
    dimensions: [{ Name: 'Scope', Value: SCOPE }],
  });

  await publish(metrics);

  log({
    event: 'cost-allocation-report',
    scope: SCOPE,
    start: period.Start,
    end: period.End,
    costMetric: COST_METRIC,
    keys: summary,
  });

  return { start: period.Start, end: period.End, keys: summary };
};
`;
