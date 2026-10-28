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
  COVERAGE_GAP_METRIC,
  ENROLLED_METRIC,
  ENROLMENT_ACTIVE,
  LAMBDA_MINIMUM_INVOCATIONS,
  LAMBDA_RECOMMENDATION_MEMORY_CEILING_MIB,
  RIGHT_SIZING_METRIC_NAMESPACE,
  SAVINGS_CURRENCY,
  SWEEP_SUCCESS_METRIC,
  type RightSizingWorkload,
  assertValidRightSizingCatalogue,
  sweeperCatalogue,
} from './right-sizing';

/** Bumped when the shape of the sweeper's log line changes. */
export const RIGHT_SIZING_LOG_SCHEMA_VERSION = 1;

/**
 * Dimension carried by every metric the sweeper publishes.
 *
 * `Scope`, not `Environment`. Compute Optimizer findings are account-and-region
 * scoped: there is one answer per account for a service in staging and a service
 * in production alike, and `bin/app.ts` deploys both environments into the same
 * account. A per-environment copy of this stack would read the same findings
 * twice and publish two datapoints for one window, which is a doubled
 * `CoverageGap` and a halved meaning.
 */
export const SCOPE_DIMENSION = 'Scope';

/** The only value {@link SCOPE_DIMENSION} takes, for the reason above. */
export const ACCOUNT_SCOPE = 'account';

/** Dimension on {@link PROPOSALS_BLOCKED_METRIC}, naming which rule refused. */
export const BLOCK_REASON_DIMENSION = 'Reason';

/**
 * How often the sweep runs.
 *
 * Daily. Compute Optimizer recomputes a recommendation from a rolling window, so
 * a sweep more often than that re-reads the same finding; a sweep less often
 * than that means a coverage gap opened by a merged pull request goes unreported
 * for longer than the pull request took to review. If AWS's own refresh turns
 * out to be slower than daily the sweep simply reads the same numbers twice,
 * which costs one Lambda invocation and publishes identical datapoints.
 */
export const DEFAULT_SWEEP_SCHEDULE_HOURS = 24;

/**
 * Hours without a completed sweep that turn into a ticket.
 *
 * Two sweeps' worth plus room for one retry. The alarm this bounds is the only
 * one here whose symptom is an absence: a disabled EventBridge rule produces no
 * errors, no dead letters and no metrics at all, and every other alarm in this
 * stack goes quiet with it.
 */
export const DEFAULT_SWEEP_STALE_HOURS = 48;

export interface RightSizingStackProps extends cdk.StackProps {
  /**
   * Alarm topic the five alarms here notify.
   *
   * Passed in rather than created, for the reason `SpotInterruptionStack` gives:
   * a topic created here would be one the runbook enricher has not been
   * subscribed to, and `tools/audit-runbooks.ts` fails that — correctly,
   * because an alarm nobody enriched arrives with no runbook on it.
   *
   * `bin/app.ts` passes the production alarm topic. These five alarms are about
   * an instrument that measures the whole account rather than one environment,
   * and the rota that owns account-wide platform signals is the production one.
   */
  readonly alarmTopic: sns.ITopic;
  /**
   * The catalogue the sweeper is given.
   *
   * Every entry, not only the proposable ones. The `hold` and `uncovered`
   * entries are what make a missing finding reportable: without them in the
   * sweeper's hands an absent recommendation is an absent recommendation, and
   * `CoverageGap` is the metric this stack exists to publish.
   */
  readonly workloads: readonly RightSizingWorkload[];
  /** Hours between sweeps (default: {@link DEFAULT_SWEEP_SCHEDULE_HOURS}). */
  readonly sweepScheduleHours?: number;
  /** Hours without a sweep that alarm (default: {@link DEFAULT_SWEEP_STALE_HOURS}). */
  readonly sweepStaleHours?: number;
  /** Retention for the sweeper's log group (default: one month). */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * The daily read of AWS Compute Optimizer, and the alarms over the ways its
 * silence is mistaken for good news.
 *
 * `lib/right-sizing.ts` decides what a finding about each service is allowed to
 * do. This stack is the part that goes and gets the findings, and almost all of
 * its design is about the three ways this particular integration reports
 * nothing:
 *
 * **Not enrolled.** Compute Optimizer is opt-in per account. Before the opt-in
 * every `Get*Recommendations` call answers `OptInRequiredException`, which a
 * handler wrapping its sweep in one `try` turns into a logged warning and a
 * finding count of zero — and zero over-provisioned services is the number an
 * optimised account publishes. So the enrolment status is read **first**, on its
 * own, published as `Enrolled`, and a status other than `Active` ends the sweep
 * rather than being caught further down. The alarm on it is what makes "the
 * integration was never switched on" visible, which is otherwise a successful
 * run.
 *
 * **Excluded by its own scaling policies.** AWS produces no ECS service
 * recommendation for a service with a step scaling policy or with target
 * tracking on both CPU and memory, and does not say so in the response: the
 * service is simply absent from the list. Those are the two application
 * services here. The sweeper therefore iterates the *catalogue* and asks which
 * entries got a finding, instead of iterating the findings and reporting what it
 * sees — which is the difference between `CoverageGap` and a number that is
 * structurally zero.
 *
 * **The sweep did not run.** A disabled rule, a deleted schedule or a function
 * whose role lost a permission all produce no metrics, and an alarm on a metric
 * with no datapoints does not fire. `*-right-sizing-sweep-stale` is the one
 * alarm here with `treatMissingData: breaching`, which is also why the other
 * four do not need it: absence has exactly one alarm, so one cause produces one
 * ticket.
 *
 * What this stack deliberately does **not** have is any write permission. It
 * cannot call `ecs:UpdateService`, `lambda:UpdateFunctionConfiguration` or
 * `ecs:RegisterTaskDefinition`, and the reason is in `lib/right-sizing.ts`: every
 * resource in this account is tagged `ManagedBy: CDK`, a resize applied outside
 * CloudFormation is reverted by the next deploy, and the revert is as silent as
 * the change. The output of this stack is a proposal in a log line and a
 * `Proposals` datapoint; the change is a pull request.
 *
 * See docs/right-sizing.md.
 */
export class RightSizingStack extends cdk.Stack {
  /** Reads enrolment and recommendations, publishes the metrics. */
  public readonly sweeperFunction: lambda.Function;
  /** Schedule invocations EventBridge could not deliver. */
  public readonly sweeperDlq: sqs.Queue;
  /** The schedule that drives the sweep. */
  public readonly sweepRule: events.Rule;
  /** Alarms created here, keyed for `bin/app.ts` and the tests. */
  public readonly alarms: {
    readonly notEnrolled: cloudwatch.Alarm;
    readonly sweepStale: cloudwatch.Alarm;
    readonly coverageGap: cloudwatch.Alarm;
    readonly sweeperErrors: cloudwatch.Alarm;
    readonly sweepUndelivered: cloudwatch.Alarm;
  };

  constructor(scope: Construct, id: string, props: RightSizingStackProps) {
    super(scope, id, props);

    // Offline arithmetic, so there is no reason for a bad catalogue to be
    // discovered later than synth.
    assertValidRightSizingCatalogue(props.workloads);

    if (props.workloads.length === 0) {
      throw new Error(
        'RightSizingStack: no workloads. The sweeper reports a coverage gap by asking which ' +
          'catalogue entries got a finding, so an empty catalogue produces a clean sweep that ' +
          'read nothing — which is the exact failure this stack exists to make visible.',
      );
    }

    const sweepScheduleHours = props.sweepScheduleHours ?? DEFAULT_SWEEP_SCHEDULE_HOURS;
    const sweepStaleHours = props.sweepStaleHours ?? DEFAULT_SWEEP_STALE_HOURS;

    if (sweepStaleHours <= sweepScheduleHours) {
      throw new Error(
        `RightSizingStack: sweepStaleHours (${sweepStaleHours}) must exceed sweepScheduleHours ` +
          `(${sweepScheduleHours}). A staleness window no longer than the schedule alarms on the ` +
          'gap between two healthy sweeps, which is a ticket per day for a working integration.',
      );
    }

    // ── The sweeper ───────────────────────────────────────────────────────────

    const logGroup = new logs.LogGroup(this, 'SweeperLogGroup', {
      logGroupName: `/aws/lambda/${this.stackName}-right-sizing-sweeper`,
      retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    (logGroup.node.defaultChild as logs.CfnLogGroup).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_158',
          comment:
            'No CMK on the log group: AWS-managed encryption at rest already applies, and the ' +
            'contents are service names, task sizes and AWS’s own published saving ' +
            'estimates — the same facts the Compute Optimizer console shows anyone who can ' +
            'read the account.',
        },
      ],
    });

    // A missed sweep is a missed datapoint rather than a lost event: the next
    // one reads the same rolling window. The queue is here for the record that
    // EventBridge gave up, because a schedule that stops firing and a sweep
    // that stops finding anything publish the same thing — nothing — and only
    // one of the two is visible in a queue depth.
    this.sweeperDlq = new sqs.Queue(this, 'SweeperDlq', {
      queueName: `${this.stackName}-sweeper-dlq`,
      // The AWS-managed SQS key rather than SSE-SQS: both encrypt at rest with
      // no key to rotate, and only this one satisfies CKV_AWS_27.
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kms.Alias.fromAliasName(this, 'RightSizingSqsKey', 'alias/aws/sqs'),
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const sweeperRole = new iam.Role(this, 'SweeperRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Reads AWS Compute Optimizer findings and publishes right-sizing coverage',
    });
    logGroup.grantWrite(sweeperRole);

    sweeperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadComputeOptimizerFindings',
        // Compute Optimizer takes no resource ARNs on any of these — the
        // recommendation APIs are account-and-region scoped reads, and
        // `Resource: "*"` is the only form they accept. All three are reads, and
        // the role has no Update, Put or Export action at all: it cannot opt the
        // account in (which creates a service-linked role), cannot change a
        // recommendation preference, and cannot start an export job that would
        // write to a bucket.
        actions: [
          'compute-optimizer:GetEnrollmentStatus',
          'compute-optimizer:GetECSServiceRecommendations',
          'compute-optimizer:GetLambdaFunctionRecommendations',
        ],
        resources: ['*'],
      }),
    );

    sweeperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishRightSizingMetrics',
        // PutMetricData rejects any resource other than `*`, so the namespace
        // condition is the only scope available — and it is the one that
        // matters: this role can write right-sizing metrics and nothing else.
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': RIGHT_SIZING_METRIC_NAMESPACE } },
      }),
    );

    this.sweeperFunction = new lambda.Function(this, 'RightSizingSweeper', {
      functionName: `${this.stackName}-right-sizing-sweeper`,
      description:
        'Reads Compute Optimizer enrolment and findings, and publishes proposals and coverage gaps',
      runtime: lambda.Runtime.NODEJS_22_X,
      // arm64: inline source on a managed runtime, so nothing in the artifact
      // is architecture-specific. 20% cheaper per GB-second — docs/graviton.md.
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      role: sweeperRole,
      logGroup,
      code: lambda.Code.fromInline(RIGHT_SIZING_SWEEPER_SOURCE),
      // Two paginated reads over an account's compute. Generous because the
      // alternative to a slow sweep is a timed-out one, which publishes no
      // SweepSuccess and tickets the staleness alarm for a reason that is not
      // staleness.
      timeout: cdk.Duration.minutes(5),
      deadLetterQueue: this.sweeperDlq,
      // One at a time. Two concurrent sweeps would publish two sets of
      // datapoints for one window, and `CoverageGap` is a SUM.
      reservedConcurrentExecutions: 1,
      environment: {
        METRIC_NAMESPACE: RIGHT_SIZING_METRIC_NAMESPACE,
        SCOPE: ACCOUNT_SCOPE,
        LOG_SCHEMA_VERSION: String(RIGHT_SIZING_LOG_SCHEMA_VERSION),
        CATALOGUE: JSON.stringify(sweeperCatalogue(props.workloads)),
        EXPECTED_ENROLMENT: ENROLMENT_ACTIVE,
        SAVINGS_CURRENCY,
        LAMBDA_MINIMUM_INVOCATIONS: String(LAMBDA_MINIMUM_INVOCATIONS),
        LAMBDA_MEMORY_CEILING_MIB: String(LAMBDA_RECOMMENDATION_MEMORY_CEILING_MIB),
      },
    });

    (this.sweeperFunction.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler calls two Compute Optimizer read APIs and PutMetricData. ' +
            'A VPC would need a NAT gateway or three interface endpoints to reach endpoints it ' +
            'is no closer to, for a function that runs once a day and holds nothing.',
        },
        {
          id: 'CKV_AWS_173',
          comment:
            'No KMS key on the environment variables: they hold a metric namespace, an ' +
            'environment name, the catalogue already published in docs/right-sizing.md, and two ' +
            'AWS-documented thresholds. Nothing secret reaches this function — it has no ' +
            'credential to read and no data store to open.',
        },
      ],
    });

    // ── The schedule ──────────────────────────────────────────────────────────
    this.sweepRule = new events.Rule(this, 'SweepRule', {
      ruleName: `${this.stackName}-right-sizing-sweep`,
      description: `Reads Compute Optimizer findings every ${sweepScheduleHours}h`,
      schedule: events.Schedule.rate(cdk.Duration.hours(sweepScheduleHours)),
      targets: [
        new targets.LambdaFunction(this.sweeperFunction, {
          deadLetterQueue: this.sweeperDlq,
          retryAttempts: 2,
        }),
      ],
    });

    // ── The alarms ────────────────────────────────────────────────────────────

    const alarmAction = new cloudwatchActions.SnsAction(props.alarmTopic);

    const sweeperMetric = (metricName: string, period: cdk.Duration, statistic: string) =>
      new cloudwatch.Metric({
        namespace: RIGHT_SIZING_METRIC_NAMESPACE,
        metricName,
        dimensionsMap: { [SCOPE_DIMENSION]: ACCOUNT_SCOPE },
        statistic,
        period,
      });

    this.alarms = {
      // The sweep ran and said the account is not enrolled. NOT_BREACHING,
      // because a sweep that did not run at all is the alarm below: one cause,
      // one ticket.
      notEnrolled: new cloudwatch.Alarm(this, 'NotEnrolledAlarm', {
        alarmName: 'right-sizing-not-enrolled',
        alarmDescription:
          'Compute Optimizer is not enrolled for this account, so every right-sizing number ' +
          'below reads zero — and zero over-provisioned services is what an optimised ' +
          'account publishes. Nothing is broken; nothing has ever been measured. See ' +
          'docs/runbooks.md.',
        metric: sweeperMetric(ENROLLED_METRIC, cdk.Duration.hours(sweepStaleHours), cloudwatch.Stats.MINIMUM),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),

      // The one alarm here whose symptom is the absence of the data. A disabled
      // rule, a deleted schedule or a role that lost `compute-optimizer:Get*`
      // all produce no metrics at all, and the other four alarms go quiet with
      // them.
      sweepStale: new cloudwatch.Alarm(this, 'SweepStaleAlarm', {
        alarmName: 'right-sizing-sweep-stale',
        alarmDescription:
          `No completed Compute Optimizer sweep in ${sweepStaleHours} hours, against a schedule ` +
          `of ${sweepScheduleHours}. Every other right-sizing alarm reads healthy while this is ` +
          'red, because a sweep that does not run publishes nothing and an alarm on a metric ' +
          'with no datapoints does not fire. See docs/runbooks.md.',
        metric: sweeperMetric(SWEEP_SUCCESS_METRIC, cdk.Duration.hours(sweepStaleHours), cloudwatch.Stats.SUM),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),

      // A catalogued service Compute Optimizer returned no finding for. One is
      // worth a ticket: the catalogue already declares which services are
      // structurally uncovered, so a gap is a service that was expected to be
      // measured and was not.
      coverageGap: new cloudwatch.Alarm(this, 'CoverageGapAlarm', {
        alarmName: 'right-sizing-coverage-gap',
        alarmDescription:
          'A service the catalogue expects a Compute Optimizer finding for did not get one. An ' +
          'absent finding is how an excluded service, a service below the 24-hour metric ' +
          'threshold and a service AWS has not reached all look, and none of the three is ' +
          'distinguishable from "optimised" in a count of findings. See docs/runbooks.md.',
        metric: sweeperMetric(COVERAGE_GAP_METRIC, cdk.Duration.hours(sweepStaleHours), cloudwatch.Stats.MAXIMUM),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),

      sweeperErrors: new cloudwatch.Alarm(this, 'SweeperErrorsAlarm', {
        alarmName: 'right-sizing-sweeper-errors',
        alarmDescription:
          'The Compute Optimizer sweeper is failing. The staleness alarm catches a sweep that ' +
          'stopped running; this one catches a sweep that runs and throws, which is the case ' +
          'where the schedule looks healthy. See docs/runbooks.md.',
        metric: this.sweeperFunction.metricErrors({
          period: cdk.Duration.hours(sweepStaleHours),
          statistic: cloudwatch.Stats.SUM,
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),

      sweepUndelivered: new cloudwatch.Alarm(this, 'SweepUndeliveredAlarm', {
        alarmName: 'right-sizing-sweep-undelivered',
        alarmDescription:
          'Scheduled sweep invocations reached the dead-letter queue, so EventBridge gave up ' +
          'retrying. The findings are not lost — the next sweep reads the same rolling ' +
          'window — but the record that the schedule failed is only here. See ' +
          'docs/runbooks.md.',
        metric: this.sweeperDlq.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: cloudwatch.Stats.MAXIMUM,
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    };

    for (const alarm of Object.values(this.alarms)) {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    }

    // ── Tags ──────────────────────────────────────────────────────────────────
    // `policy/cloudformation/tags.rego` requires ManagedBy and Stack on
    // everything this repository creates, and holds Environment to the three
    // values the stacks actually use.
    // No `Environment` tag, deliberately. The stack is account-scoped, so there
    // is no true value to give it, and inventing one — `shared`, `platform` —
    // reads in Cost Explorer as a fourth environment rather than as "spans all
    // of them". `policy/cloudformation/tags.rego` requires ManagedBy and Stack
    // for exactly this reason and holds Environment to the real three wherever
    // it is applied.
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RightSizingMetricNamespace', {
      value: RIGHT_SIZING_METRIC_NAMESPACE,
      description: 'CloudWatch namespace holding the proposal and coverage metrics',
      exportName: `${this.stackName}-metric-namespace`,
    });

    new cdk.CfnOutput(this, 'SweeperLogGroupName', {
      value: logGroup.logGroupName,
      description: 'Log group holding one JSON line per finding, proposal and coverage gap',
      exportName: `${this.stackName}-sweeper-log-group`,
    });

    new cdk.CfnOutput(this, 'SweeperDlqUrl', {
      value: this.sweeperDlq.queueUrl,
      description: 'Scheduled invocations EventBridge could not deliver',
      exportName: `${this.stackName}-sweeper-dlq-url`,
    });
  }
}

/**
 * The sweeper, as it ships.
 *
 * `lambda.Code.fromInline` means nothing in the normal CDK pipeline parses this:
 * `tsc` sees a template literal and `cdk synth` embeds it verbatim. So it is
 * exported and `test/right-sizing-sweeper-handler.test.ts` loads it into a
 * function scope with `require` and `process` supplied, the arrangement
 * `test/spot-recorder-handler.test.ts` uses — and it is not optional here,
 * because every interesting path through this handler ends in a *smaller*
 * number, and a smaller number is what success looks like.
 *
 * Four things it does that are worth saying out loud:
 *
 *   • **Enrolment is read first and alone.** `OptInRequiredException` is what
 *     every recommendation call answers before the account opts in, and a sweep
 *     that wrapped the whole run in one `try` would log it once and publish a
 *     finding count of zero. So a status other than `Active` publishes
 *     `Enrolled: 0` and returns, and nothing below runs to produce a reassuring
 *     zero beside it.
 *
 *   • **It iterates the catalogue, not the findings.** AWS omits an excluded
 *     service from the response rather than reporting the exclusion, so a loop
 *     over findings can only ever report what it was given. The loop is over the
 *     catalogue, and an entry with no finding is a `CoverageGap` datapoint.
 *
 *   • **Agreement is counted before it is compared.** Two services that must
 *     stay the same size produce two findings, and a missing one leaves a single
 *     recommendation that agrees with itself. `blockingReason` in
 *     `lib/right-sizing.ts` requires the peer count first for that reason, and
 *     this handler supplies the peers it actually found rather than the ones it
 *     expected.
 *
 *   • **A saving in another currency is not added.** `estimatedMonthlySavings`
 *     carries its own `currency`; an account billed in one other than USD
 *     returns that one, and a sum across currencies is a number in none of them
 *     that still renders as money on a dashboard.
 */
export const RIGHT_SIZING_SWEEPER_SOURCE = `
const {
  ComputeOptimizerClient,
  GetEnrollmentStatusCommand,
  GetECSServiceRecommendationsCommand,
  GetLambdaFunctionRecommendationsCommand,
} = require('@aws-sdk/client-compute-optimizer');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const optimizer = new ComputeOptimizerClient({});
const cloudwatch = new CloudWatchClient({});

const NAMESPACE = process.env.METRIC_NAMESPACE;
const SCOPE = process.env.SCOPE || 'account';
const SCHEMA_VERSION = Number(process.env.LOG_SCHEMA_VERSION || '1');
const EXPECTED_ENROLMENT = process.env.EXPECTED_ENROLMENT || 'Active';
const CURRENCY = process.env.SAVINGS_CURRENCY || 'USD';
const LAMBDA_MINIMUM_INVOCATIONS = Number(process.env.LAMBDA_MINIMUM_INVOCATIONS || '50');
const LAMBDA_MEMORY_CEILING_MIB = Number(process.env.LAMBDA_MEMORY_CEILING_MIB || '1792');

const catalogue = JSON.parse(process.env.CATALOGUE || '[]');

/** Fargate's task CPU/memory table, restated here because the handler ships alone. */
const FARGATE_ROWS = [
  { cpu: 256, values: [512, 1024, 2048] },
  { cpu: 512, min: 1024, max: 4096, step: 1024 },
  { cpu: 1024, min: 2048, max: 8192, step: 1024 },
  { cpu: 2048, min: 4096, max: 16384, step: 1024 },
  { cpu: 4096, min: 8192, max: 30720, step: 1024 },
];

const sizeIsValid = (cpu, memoryMiB) => {
  const row = FARGATE_ROWS.find((candidate) => candidate.cpu === cpu);
  if (!row) return false;
  if (row.values) return row.values.includes(memoryMiB);
  if (memoryMiB < row.min || memoryMiB > row.max) return false;
  return (memoryMiB - row.min) % row.step === 0;
};

const sizeIsCatalogued = (cpu) => FARGATE_ROWS.some((row) => row.cpu === cpu);

/** 'arn:aws:ecs:r:a:service/cluster/name' -> 'name'. */
const serviceNameOf = (arn) => {
  const parts = String(arn || '').split('/');
  return parts.length > 0 ? parts[parts.length - 1] : '';
};

/**
 * Does a glob claim this service name? '*' is any run of characters.
 *
 * A glob rather than a prefix because the names are environment-prefixed:
 * 'staging-bg-service' and 'production-bg-service' are one entry, and a prefix
 * match would need the environment in it.
 */
const nameMatches = (pattern, serviceName) =>
  new RegExp(
    '^' +
      String(pattern || '')
        .split('*')
        .map((literal) =>
          literal.replace(/[^A-Za-z0-9_-]/g, (character) => '\\\\' + character),
        )
        .join('.*') +
      '$',
  ).test(serviceName);

/** How specific a pattern is: fewer wildcards first, then more literal characters. */
const specificity = (pattern) =>
  (String(pattern || '').split('*').length - 1) * -1000 +
  String(pattern || '').replace(/\\*/g, '').length;

/**
 * The catalogue entry claiming a service name, most specific pattern first.
 *
 * 'service-name-pattern-ambiguous' in the gate forbids two patterns matching one
 * name, so the ordering is here to make the runtime answer decidable rather than
 * to resolve a real tie — a sweeper whose posture depended on array order would
 * report a different answer on a different day.
 */
const entryFor = (serviceName) => {
  const matching = catalogue.filter((entry) => nameMatches(entry.pattern, serviceName));
  if (matching.length === 0) return undefined;
  return matching.sort((left, right) => specificity(right.pattern) - specificity(left.pattern))[0];
};

/**
 * The recommended task size, or undefined when the option carries neither.
 *
 * Compute Optimizer returns the options ranked, rank 1 first, so the first one
 * is the recommendation and the rest are alternatives. An option with no cpu or
 * no memory is not a smaller size, it is not a size, and is reported as such
 * rather than defaulted.
 */
const recommendedSize = (recommendation) => {
  const options = recommendation.serviceRecommendationOptions || [];
  if (options.length === 0) return undefined;
  const ranked = [...options].sort((left, right) => (left.rank || 1) - (right.rank || 1));
  const option = ranked[0];
  const cpu = Number(option.cpu);
  const memoryMiB = Number(option.memory);
  if (!Number.isFinite(cpu) || !Number.isFinite(memoryMiB)) return undefined;
  return { cpu, memoryMiB, savings: option.savingsOpportunity };
};

/** The library's rule, restated: see the handler comment in right-sizing-stack.ts. */
const blockingReason = (entry, size, peers) => {
  if (entry.posture === 'hold') return 'posture-hold';
  if (entry.posture === 'uncovered') return 'posture-uncovered';
  if (!sizeIsCatalogued(size.cpu)) return 'size-outside-catalogue';
  if (!sizeIsValid(size.cpu, size.memoryMiB)) return 'size-invalid-for-fargate';
  if (entry.floorCpu !== undefined && size.cpu < entry.floorCpu) return 'below-floor';
  if (entry.floorMemoryMiB !== undefined && size.memoryMiB < entry.floorMemoryMiB) {
    return 'below-floor';
  }

  const peerIds = entry.sizeMustMatch || [];
  const needsAgreement = entry.uniformSize === true || peerIds.length > 0;
  if (!needsAgreement) return undefined;

  const expectedPeers =
    (entry.uniformSize === true ? entry.expectedResources - 1 : 0) + peerIds.length;
  if (peers.length !== expectedPeers) return 'peer-disagreement';
  const disagrees = peers.some(
    (peer) => peer.cpu !== size.cpu || peer.memoryMiB !== size.memoryMiB,
  );
  return disagrees ? 'peer-disagreement' : undefined;
};

const paginate = async (build, key) => {
  const items = [];
  let token;
  do {
    const response = await optimizer.send(build(token));
    for (const item of response[key] || []) items.push(item);
    token = response.nextToken;
  } while (token);
  return items;
};

const publish = async (metrics) => {
  const data = metrics.map((metric) => ({
    MetricName: metric.name,
    Unit: metric.unit,
    Value: metric.value,
    Dimensions: [
      { Name: 'Scope', Value: SCOPE },
      ...(metric.reason ? [{ Name: 'Reason', Value: metric.reason }] : []),
    ],
  }));
  if (data.length === 0) return;
  // PutMetricData takes at most 1000 metrics per call, and the blocked-reason
  // breakdown is one datapoint per reason rather than per finding, so this stays
  // far inside it. Chunked anyway: a sweep that throws on a limit publishes
  // nothing at all, including the SweepSuccess the staleness alarm reads.
  for (let index = 0; index < data.length; index += 20) {
    await cloudwatch.send(
      new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: data.slice(index, index + 20) }),
    );
  }
};

const log = (record) => console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...record }));

exports.handler = async () => {
  // Read enrolment on its own, before anything that could turn
  // OptInRequiredException into a reassuring zero.
  const enrolment = await optimizer.send(new GetEnrollmentStatusCommand({}));
  const enrolled = enrolment.status === EXPECTED_ENROLMENT;

  if (!enrolled) {
    await publish([{ name: 'Enrolled', unit: 'Count', value: 0 }]);
    log({
      event: 'right-sizing-sweep',
      scope: SCOPE,
      enrolled: false,
      status: enrolment.status || null,
      statusReason: enrolment.statusReason || null,
      note:
        'Compute Optimizer is not enrolled, so no recommendation call was made. Every ' +
        'right-sizing metric is absent rather than zero: a zero would read as a measured ' +
        'account.',
    });
    return { enrolled: false, status: enrolment.status || null };
  }

  const ecsRecommendations = await paginate(
    (token) => new GetECSServiceRecommendationsCommand(token ? { nextToken: token } : {}),
    'ecsServiceRecommendations',
  );

  // Findings by catalogue entry, so the loop below is over what was *declared*
  // rather than over what AWS happened to return.
  const byEntry = new Map();
  const unexpected = [];
  for (const recommendation of ecsRecommendations) {
    const serviceName = serviceNameOf(recommendation.serviceArn);
    const entry = entryFor(serviceName);
    if (!entry) {
      // A service no entry claims. The audit fails the build for this, so at
      // runtime it is a log line rather than a metric: the template that
      // introduced it could not have merged.
      log({
        event: 'right-sizing-finding',
        scope: SCOPE,
        serviceName,
        finding: recommendation.finding || null,
        note: 'No catalogue entry claims this service; tools/audit-right-sizing.ts fails for it.',
      });
      continue;
    }
    const existing = byEntry.get(entry.id) || [];
    existing.push({ serviceName, recommendation });
    byEntry.set(entry.id, existing);
    if (entry.posture === 'uncovered') unexpected.push({ entry, serviceName });
  }

  const metrics = [{ name: 'Enrolled', unit: 'Count', value: 1 }];
  const blockedByReason = new Map();
  const proposals = [];
  let coverageGap = 0;
  let savingTotal = 0;
  let savingUncounted = 0;

  for (const entry of catalogue) {
    const found = byEntry.get(entry.id) || [];

    if (found.length === 0) {
      if (entry.posture === 'uncovered') {
        // The declared case. Not a gap: this entry exists to say that an absent
        // finding here is expected, which is the only way an absent finding is
        // ever distinguishable from an unmeasured one.
        log({
          event: 'right-sizing-coverage',
          scope: SCOPE,
          workload: entry.id,
          covered: false,
          expected: true,
          reason: entry.blockedReason || null,
        });
        continue;
      }
      coverageGap += entry.expectedResources;
      log({
        event: 'right-sizing-coverage',
        scope: SCOPE,
        workload: entry.id,
        covered: false,
        expected: false,
        expectedResources: entry.expectedResources,
        note:
          'Catalogued as ' + entry.posture + ' and Compute Optimizer returned no finding. ' +
          'Either the service is newly excluded, has under 24 hours of metrics, or the ' +
          'catalogue is describing a service that no longer exists.',
      });
      continue;
    }

    if (found.length < entry.expectedResources && entry.posture !== 'uncovered') {
      coverageGap += entry.expectedResources - found.length;
    }

    // Sizes for every resource this entry matched, so the agreement check sees
    // what was found rather than what was hoped for.
    const sizes = [];
    for (const hit of found) {
      const size = recommendedSize(hit.recommendation);
      if (size) sizes.push({ serviceName: hit.serviceName, ...size });
    }

    for (const hit of found) {
      const finding = hit.recommendation.finding || null;
      const size = recommendedSize(hit.recommendation);

      if (!size) {
        // Optimized carries no resize, which is the common case and not a
        // problem. Anything else with no option is a response this handler
        // cannot read, and is logged rather than counted as healthy.
        log({
          event: 'right-sizing-finding',
          scope: SCOPE,
          workload: entry.id,
          serviceName: hit.serviceName,
          finding,
          proposed: null,
          note: finding === 'Optimized' ? 'No change recommended.' : 'No readable size option.',
        });
        continue;
      }

      const peers = sizes
        .filter((candidate) => candidate.serviceName !== hit.serviceName)
        .map((candidate) => ({ cpu: candidate.cpu, memoryMiB: candidate.memoryMiB }));
      // Peers named in sizeMustMatch live in other entries, so their sizes come
      // out of the other entries' findings.
      for (const peerId of entry.sizeMustMatch || []) {
        for (const peerHit of byEntry.get(peerId) || []) {
          const peerSize = recommendedSize(peerHit.recommendation);
          if (peerSize) peers.push({ cpu: peerSize.cpu, memoryMiB: peerSize.memoryMiB });
        }
      }

      const blocked = blockingReason(entry, size, peers);
      if (blocked) {
        blockedByReason.set(blocked, (blockedByReason.get(blocked) || 0) + 1);
        log({
          event: 'right-sizing-finding',
          scope: SCOPE,
          workload: entry.id,
          serviceName: hit.serviceName,
          finding,
          proposed: { cpu: size.cpu, memoryMiB: size.memoryMiB },
          blocked,
        });
        continue;
      }

      const opportunity = size.savings || {};
      const estimated = opportunity.estimatedMonthlySavings || {};
      if (estimated.currency && estimated.currency !== CURRENCY) {
        savingUncounted += 1;
      } else if (Number.isFinite(Number(estimated.value))) {
        savingTotal += Number(estimated.value);
      }

      proposals.push({ workload: entry.id, serviceName: hit.serviceName, size });
      log({
        event: 'right-sizing-proposal',
        scope: SCOPE,
        workload: entry.id,
        serviceName: hit.serviceName,
        finding,
        proposed: { cpu: size.cpu, memoryMiB: size.memoryMiB },
        savingPercent: opportunity.savingsOpportunityPercentage ?? null,
        savingCurrency: estimated.currency || null,
        savingValue: Number.isFinite(Number(estimated.value)) ? Number(estimated.value) : null,
        note:
          'Apply by editing cpu and memoryLimitMiB in bin/app.ts and opening a pull request. ' +
          'Nothing here writes to the resource: a change applied outside CloudFormation is ' +
          'reverted by the next deploy, as silently as it was made.',
      });
    }
  }

  for (const { entry, serviceName } of unexpected) {
    log({
      event: 'right-sizing-unexpected-finding',
      scope: SCOPE,
      workload: entry.id,
      serviceName,
      reason: entry.blockedReason || null,
      note:
        'The catalogue declares this service uncovered and Compute Optimizer produced a ' +
        'finding for it, so the claim is stale — usually a scaling policy removed in a ' +
        'refactor, which makes the service eligible.',
    });
  }

  const lambdaRecommendations = await paginate(
    (token) => new GetLambdaFunctionRecommendationsCommand(token ? { nextToken: token } : {}),
    'lambdaFunctionRecommendations',
  );

  // No proposals from the Lambda half, by design: see docs/right-sizing.md §7.
  // What is published is the coverage, because "no Lambda findings" has one
  // cause here — the invocation count — and a reader cannot tell that from a
  // missing metric.
  const lambdaUnavailable = lambdaRecommendations.filter(
    (recommendation) => recommendation.finding === 'Unavailable',
  ).length;

  metrics.push(
    { name: 'FindingsRead', unit: 'Count', value: ecsRecommendations.length },
    { name: 'Proposals', unit: 'Count', value: proposals.length },
    { name: 'CoverageGap', unit: 'Count', value: coverageGap },
    { name: 'UnexpectedFinding', unit: 'Count', value: unexpected.length },
    { name: 'EstimatedMonthlySaving', unit: 'None', value: savingTotal },
    { name: 'SavingUncountedCurrency', unit: 'Count', value: savingUncounted },
    { name: 'LambdaFindingsRead', unit: 'Count', value: lambdaRecommendations.length },
    { name: 'LambdaUnavailable', unit: 'Count', value: lambdaUnavailable },
  );
  for (const [reason, value] of blockedByReason.entries()) {
    metrics.push({ name: 'ProposalsBlocked', unit: 'Count', value, reason });
  }
  // Last, and only once everything above has been computed: this is the metric
  // the staleness alarm reads, and a sweep that published it before doing the
  // work would report a successful sweep for a run that threw.
  metrics.push({ name: 'SweepSuccess', unit: 'Count', value: 1 });

  await publish(metrics);

  log({
    event: 'right-sizing-sweep',
    scope: SCOPE,
    enrolled: true,
    findingsRead: ecsRecommendations.length,
    proposals: proposals.length,
    coverageGap,
    unexpectedFindings: unexpected.length,
    lambdaFindingsRead: lambdaRecommendations.length,
    lambdaUnavailable,
    lambdaMinimumInvocations: LAMBDA_MINIMUM_INVOCATIONS,
    lambdaMemoryCeilingMiB: LAMBDA_MEMORY_CEILING_MIB,
    estimatedMonthlySaving: savingTotal,
    savingsCurrency: CURRENCY,
    savingUncounted,
  });

  return {
    enrolled: true,
    findingsRead: ecsRecommendations.length,
    proposals: proposals.length,
    coverageGap,
    unexpectedFindings: unexpected.length,
  };
};
`;
