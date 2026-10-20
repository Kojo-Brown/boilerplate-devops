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
  DRAIN_OVERRUN_METRIC,
  FARGATE_SPOT_WARNING_SECONDS,
  INTERRUPTION_METRIC,
  SPOT_INTERRUPTION_STOP_CODE,
  SPOT_METRIC_NAMESPACE,
  type SpotWorkload,
  assertValidSpotCatalogue,
  drainBudgetSeconds,
} from './spot-capacity';

/** Bumped when the shape of the recorder's log line changes. */
export const SPOT_LOG_SCHEMA_VERSION = 1;

/** Container Insights publishes the two task counts the starvation alarm compares. */
export const CONTAINER_INSIGHTS_NAMESPACE = 'ECS/ContainerInsights';
export const RUNNING_TASK_COUNT_METRIC = 'RunningTaskCount';
export const DESIRED_TASK_COUNT_METRIC = 'DesiredTaskCount';

/** Dimension carried by every metric the recorder publishes. */
export const ENVIRONMENT_DIMENSION = 'Environment';

/**
 * How long the starvation alarm waits before it pages.
 *
 * Fifteen one-minute datapoints. A deployment and a scale-out both make running
 * briefly smaller than desired — maxHealthyPercent lets ECS run over the count
 * on the way through, and a Fargate task that has to be placed and pass a
 * health check takes a couple of minutes — so a shorter window pages on the
 * service working. Nothing in this repository takes fifteen minutes to converge,
 * and a Spot shortage does not end on its own.
 */
export const STARVATION_EVALUATION_PERIODS = 15;

/**
 * Reclaims per hour that turn into a ticket.
 *
 * Not a page: an interruption is the deal. What is worth somebody's attention is
 * a *rate* — a service being reclaimed six times an hour is not getting the
 * 70% discount, it is getting a task that never finishes starting, and the
 * answer is usually a second task size or a move back to on-demand rather than
 * anything done in the next ten minutes.
 */
export const DEFAULT_INTERRUPTIONS_PER_HOUR_THRESHOLD = 6;

export interface SpotStarvationTarget {
  /** ECS cluster name, as Container Insights dimensions it. */
  readonly clusterName: string;
  /** ECS service name. */
  readonly serviceName: string;
  /**
   * The workload's declared on-demand base, used in the alarm description.
   *
   * The alarm itself compares running to desired rather than to the base,
   * because the base is what survives a Spot shortage and desired is what the
   * service is supposed to be running — the gap between them *is* the shortage.
   */
  readonly onDemandBase: number;
}

export interface SpotInterruptionStackProps extends cdk.StackProps {
  /** Environment name used for resource naming, tagging, and the metric dimension. */
  readonly envName: string;
  /**
   * Alarm topic the five alarms here notify.
   *
   * Passed in rather than created, for the reason `ChaosFisStack` gives about
   * its stop conditions: a topic created here would be one the runbook enricher
   * has not been subscribed to, and `tools/audit-runbooks.ts` fails that —
   * correctly, because an alarm nobody enriched arrives with no runbook on it.
   */
  readonly alarmTopic: sns.ITopic;
  /**
   * Cluster ARNs whose interruptions are recorded.
   *
   * The event pattern names them rather than matching every `aws.ecs` task state
   * change in the account: a rule with no cluster filter would invoke the
   * recorder for every task that stops anywhere, including the on-demand
   * services whose whole posture is that they are never reclaimed. Those
   * invocations would all be filtered inside the handler, which is a Lambda
   * invocation per task stop for a metric that is structurally zero.
   */
  readonly monitoredClusterArns: readonly string[];
  /**
   * The workloads whose declared drain budgets the recorder measures against.
   *
   * Only the Spot-bearing ones. Each contributes `serviceName → budget seconds`
   * to the handler's environment, so an overrun is measured against the number
   * `lib/spot-capacity.ts` declares rather than against a constant copied here.
   */
  readonly workloads: readonly { readonly serviceNamePattern: string; readonly workload: SpotWorkload }[];
  /**
   * The one service whose running-versus-desired gap is a page.
   *
   * Deliberately one, and deliberately not the previews: a preview environment
   * that cannot be placed is visible in the pull request that is waiting for it,
   * and paging a rota for it would be paging them for somebody else's branch.
   */
  readonly starvationTarget: SpotStarvationTarget;
  /** Reclaims per hour that open a ticket (default: {@link DEFAULT_INTERRUPTIONS_PER_HOUR_THRESHOLD}). */
  readonly interruptionsPerHourThreshold?: number;
  /** Retention for the recorder's log group (default: one month). */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * The record of what Fargate Spot actually did, and the alarms that make the
 * two silent failures of a Spot strategy loud.
 *
 * `lib/spot-capacity.ts` decides which workloads run on Spot and what each one
 * owes its two-minute warning. This stack is the other side of the deal: it
 * watches the warnings arrive, measures how long the shutdown took against the
 * budget that was declared, and alarms on the two things that otherwise pass
 * unnoticed.
 *
 * **Starvation is quiet, not red.** A service with Spot in its capacity
 * provider strategy and no Spot capacity available does not fail: `RunTask`
 * does not place, the service event log says so, and the desired count stays
 * unmet. Every alarm that might have caught it is a utilisation alarm on tasks
 * that do not exist, and CloudWatch does not breach a threshold on a metric with
 * no data points — the same blind spot `docs/synthetic-canaries.md` is about. So
 * the page here is metric math over Container Insights' `RunningTaskCount` and
 * `DesiredTaskCount`, with both terms `FILL()`ed and `treatMissingData` set to
 * `breaching`, because the failure being looked for is the *absence* of the
 * data rather than a value in it.
 *
 * A consequence worth stating: in an environment that has never reported these
 * metrics the page fires immediately. That is the same bargain
 * `*-rehearsal-overdue-*` makes in `FailoverGameDayStack` — a service whose task
 * counts have never been published is indistinguishable from one that has
 * stopped publishing them, and the first of the two is the one somebody can fix.
 *
 * **An overrun costs data, and looks like a reclaim.** A task killed at the end
 * of its grace period and a task that shut down cleanly produce the same thing:
 * a task that is gone. The difference is whether `stoppedAt - stoppingAt`
 * exceeded the budget, which the ECS task state change event carries and nothing
 * reads. The recorder reads it, publishes `DrainOverruns`, and the ticket on it
 * is the only signal in this repository that would notice a deregistration
 * delay somebody raised to 300 seconds in the console.
 *
 * **The recorder is itself a silent failure.** If it stops, `Interruptions`
 * reads zero — which is exactly what a healthy week looks like. So its errors
 * and its dead-letter queue both carry alarms, and `docs/runbooks.md` §9 is
 * where they go: something that measures the platform has failed, rather than
 * the platform.
 *
 * See docs/spot.md.
 */
export class SpotInterruptionStack extends cdk.Stack {
  /** Records warnings and measures shutdowns. */
  public readonly recorderFunction: lambda.Function;
  /** Interruption events the recorder could not process. */
  public readonly recorderDlq: sqs.Queue;
  /** The rule carrying `stopCode: SpotInterruption` for the monitored clusters. */
  public readonly interruptionRule: events.Rule;
  /** Alarms created here, keyed for `bin/app.ts` and the tests. */
  public readonly alarms: {
    readonly capacityStarved: cloudwatch.Alarm;
    readonly interruptionsHigh: cloudwatch.Alarm;
    readonly drainOverrun: cloudwatch.Alarm;
    readonly recorderErrors: cloudwatch.Alarm;
    readonly eventsUndelivered: cloudwatch.Alarm;
  };

  constructor(scope: Construct, id: string, props: SpotInterruptionStackProps) {
    super(scope, id, props);

    // Offline arithmetic, so there is no reason for a bad catalogue to be
    // discovered later than synth.
    assertValidSpotCatalogue(props.workloads.map((entry) => entry.workload));

    if (props.monitoredClusterArns.length === 0) {
      throw new Error(
        'SpotInterruptionStack: monitoredClusterArns is empty. An EventBridge rule with an ' +
          'empty resources list matches every task state change in the account, which is the ' +
          'opposite of what an empty list means here.',
      );
    }
    if (props.workloads.length === 0) {
      throw new Error(
        'SpotInterruptionStack: no workloads. With no declared drain budget the recorder has ' +
          'nothing to measure an overrun against, and DrainOverruns would be structurally zero.',
      );
    }

    const envName = props.envName;
    const interruptionsPerHourThreshold =
      props.interruptionsPerHourThreshold ?? DEFAULT_INTERRUPTIONS_PER_HOUR_THRESHOLD;

    // ── The record ────────────────────────────────────────────────────────────

    const logGroup = new logs.LogGroup(this, 'RecorderLogGroup', {
      logGroupName: `/aws/lambda/${this.stackName}-spot-recorder`,
      retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    (logGroup.node.defaultChild as logs.CfnLogGroup).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_158',
          comment:
            'No CMK on the log group: AWS-managed encryption at rest already applies, and the ' +
            'contents are cluster names, service names, task ARNs and shutdown durations — ' +
            'the same facts the ECS console shows anyone who can read the cluster.',
        },
      ],
    });

    // An interruption event that fails to process is a permanently missing
    // datapoint: EventBridge does not keep it, the task is already gone, and the
    // reclaim will not happen again. That is what makes the queue worth having
    // here — not retries, which EventBridge does on its own, but the record that
    // the retries ran out.
    this.recorderDlq = new sqs.Queue(this, 'RecorderDlq', {
      queueName: `${this.stackName}-recorder-dlq`,
      // The AWS-managed SQS key rather than SSE-SQS: both encrypt at rest with
      // no key to rotate, and only this one satisfies CKV_AWS_27.
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kms.Alias.fromAliasName(this, 'SpotSqsKey', 'alias/aws/sqs'),
      enforceSSL: true,
      // Two weeks, so an interruption lost on a Friday is still there to be read
      // on Monday. Replaying it late is harmless: the metric timestamp comes out
      // of the event, not out of the clock at replay time.
      retentionPeriod: cdk.Duration.days(14),
    });

    const recorderRole = new iam.Role(this, 'RecorderRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Records Fargate Spot interruptions and measures shutdowns against budget',
    });
    logGroup.grantWrite(recorderRole);
    this.recorderDlq.grantSendMessages(recorderRole);
    recorderRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishSpotMetrics',
        // PutMetricData rejects any resource other than `*`, so the namespace
        // condition is the only scope available — and it is the one that
        // matters: this role can write Spot metrics and nothing else. It needs
        // no ECS permission at all, because everything it records is in the
        // event.
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': SPOT_METRIC_NAMESPACE } },
      }),
    );

    const drainBudgets = Object.fromEntries(
      props.workloads.map((entry) => [
        entry.serviceNamePattern,
        entry.workload.drainBudget ? drainBudgetSeconds(entry.workload.drainBudget) : 0,
      ]),
    );

    this.recorderFunction = new lambda.Function(this, 'SpotRecorder', {
      functionName: `${this.stackName}-spot-recorder`,
      description: 'Records Fargate Spot interruption warnings and measures the shutdown that follows',
      runtime: lambda.Runtime.NODEJS_22_X,
      // arm64: inline source on a managed runtime, so nothing in the artifact
      // is architecture-specific. 20% cheaper per GB-second — docs/graviton.md.
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      role: recorderRole,
      logGroup,
      code: lambda.Code.fromInline(SPOT_RECORDER_SOURCE),
      timeout: cdk.Duration.seconds(30),
      deadLetterQueue: this.recorderDlq,
      // One at a time. The handler is a pure read of the event plus a
      // PutMetricData, so concurrency buys nothing, and a mass reclaim — which
      // is the event this exists for — would otherwise arrive as a burst that
      // takes a slice of the account's pool.
      reservedConcurrentExecutions: 1,
      environment: {
        METRIC_NAMESPACE: SPOT_METRIC_NAMESPACE,
        ENVIRONMENT_NAME: envName,
        EXPECTED_STOP_CODE: SPOT_INTERRUPTION_STOP_CODE,
        LOG_SCHEMA_VERSION: String(SPOT_LOG_SCHEMA_VERSION),
        DRAIN_BUDGETS: JSON.stringify(drainBudgets),
        WARNING_SECONDS: String(FARGATE_SPOT_WARNING_SECONDS),
      },
    });

    (this.recorderFunction.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler reads the event it was given and calls PutMetricData. ' +
            'A VPC would need a NAT gateway or an interface endpoint to reach a CloudWatch ' +
            'endpoint it is no closer to, and would put the recorder behind the same network ' +
            'whose capacity loss it exists to record.',
        },
        {
          id: 'CKV_AWS_173',
          comment:
            'No KMS key on the environment variables: they hold a metric namespace, an ' +
            'environment name, a stop code, and the drain budgets already published in ' +
            'docs/spot.md. Nothing secret reaches this function at all \u2014 it has no ' +
            'credential to read and no data store to open.',
        },
      ],
    });

    // ── The rule ──────────────────────────────────────────────────────────────
    // `stopCode` is what makes this a Spot rule rather than a task-stop rule.
    // Without it the pattern matches a scale-in, a deployment replacing tasks,
    // and every `UserInitiated` stop — all of which would be counted as
    // interruptions, and the resulting metric would be a deployment counter with
    // an alarming name.
    //
    // `lastStatus` is deliberately absent, because the reclaim produces two
    // events and both matter: the warning arrives as `desiredStatus: STOPPED`
    // while `lastStatus` is still `RUNNING` — that is the start of the two
    // minutes — and the completion arrives as `lastStatus: STOPPED` carrying
    // the `stoppingAt`/`stoppedAt` pair the overrun is measured from. Filtering
    // to either one loses half the signal; the handler branches instead.
    this.interruptionRule = new events.Rule(this, 'SpotInterruptionRule', {
      ruleName: `${this.stackName}-spot-interruptions`,
      description: `ECS task state changes with stopCode ${SPOT_INTERRUPTION_STOP_CODE}`,
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          stopCode: [SPOT_INTERRUPTION_STOP_CODE],
          clusterArn: [...props.monitoredClusterArns],
        },
      },
      targets: [
        new targets.LambdaFunction(this.recorderFunction, {
          deadLetterQueue: this.recorderDlq,
          retryAttempts: 3,
        }),
      ],
    });

    // ── The alarms ────────────────────────────────────────────────────────────

    const alarmAction = new cloudwatchActions.SnsAction(props.alarmTopic);

    const taskCountMetric = (metricName: string, id: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: CONTAINER_INSIGHTS_NAMESPACE,
        metricName,
        dimensionsMap: {
          ClusterName: props.starvationTarget.clusterName,
          ServiceName: props.starvationTarget.serviceName,
        },
        statistic: cloudwatch.Stats.AVERAGE,
        period: cdk.Duration.minutes(1),
        label: id,
      });

    this.alarms = {
      // `FILL(running, 0)` and `FILL(desired, REPEAT)` for the reason
      // `SyntheticCanaryQuorumStack` fills its terms: metric math yields no
      // data point wherever *any* input is missing, so a service that has
      // stopped publishing `RunningTaskCount` would otherwise produce an
      // expression with no data rather than a gap of the full desired count.
      // REPEAT on the desired side because the last count anybody asked for is
      // still the count they asked for; 0 on the running side because a service
      // that is not reporting running tasks is the case being looked for.
      capacityStarved: new cloudwatch.Alarm(this, 'CapacityStarvedAlarm', {
        alarmName: `${envName}-spot-capacity-starved`,
        alarmDescription:
          `${props.starvationTarget.serviceName} has been running fewer tasks than it wants for ` +
          `${STARVATION_EVALUATION_PERIODS} minutes. With an on-demand base of ` +
          `${props.starvationTarget.onDemandBase}, the base is placed first, so a sustained gap ` +
          'is the Spot half of the strategy failing to place — not a deployment, which ' +
          'converges in under two minutes. See docs/runbooks.md.',
        metric: new cloudwatch.MathExpression({
          expression: 'FILL(running, 0) - FILL(desired, REPEAT)',
          usingMetrics: {
            running: taskCountMetric(RUNNING_TASK_COUNT_METRIC, 'running'),
            desired: taskCountMetric(DESIRED_TASK_COUNT_METRIC, 'desired'),
          },
          period: cdk.Duration.minutes(1),
          label: 'Running minus desired tasks',
        }),
        threshold: -1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: STARVATION_EVALUATION_PERIODS,
        datapointsToAlarm: STARVATION_EVALUATION_PERIODS,
        // The failure is the absence of the data, so absence is the alarm
        // condition. This is what makes the alarm fire on an environment whose
        // task counts have never been published, which is stated in the class
        // comment and in docs/spot.md rather than softened here.
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),

      interruptionsHigh: new cloudwatch.Alarm(this, 'InterruptionsHighAlarm', {
        alarmName: `${envName}-spot-interruptions-high`,
        alarmDescription:
          `More than ${interruptionsPerHourThreshold} Fargate Spot reclaims in an hour across ` +
          `the ${envName} Spot workloads. A ticket, not a page: interruptions are the deal, but ` +
          'at this rate the tasks are spending their lives starting up. See docs/runbooks.md.',
        metric: new cloudwatch.Metric({
          namespace: SPOT_METRIC_NAMESPACE,
          metricName: INTERRUPTION_METRIC,
          dimensionsMap: { [ENVIRONMENT_DIMENSION]: envName },
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.hours(1),
        }),
        threshold: interruptionsPerHourThreshold,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        // No interruptions means no datapoints, because the recorder publishes
        // on an event rather than on a schedule. Absence is the healthy state
        // here, which is the opposite of the alarm above — and the recorder's
        // own two alarms are what stop "no datapoints" from also meaning "the
        // recorder is dead".
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),

      drainOverrun: new cloudwatch.Alarm(this, 'DrainOverrunAlarm', {
        alarmName: `${envName}-spot-drain-overrun`,
        alarmDescription:
          'A reclaimed task took longer to shut down than its declared drain budget, so it was ' +
          'killed rather than drained. The budget is deregistration delay plus stopTimeout and ' +
          'both are spent inside the two-minute warning. See docs/runbooks.md.',
        metric: new cloudwatch.Metric({
          namespace: SPOT_METRIC_NAMESPACE,
          metricName: DRAIN_OVERRUN_METRIC,
          dimensionsMap: { [ENVIRONMENT_DIMENSION]: envName },
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.hours(1),
        }),
        // One. An overrun is a task that was still working when SIGKILL
        // arrived; there is no healthy non-zero value to tolerate.
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),

      recorderErrors: new cloudwatch.Alarm(this, 'RecorderErrorsAlarm', {
        alarmName: `${envName}-spot-recorder-errors`,
        alarmDescription:
          'The Spot interruption recorder is failing. Everything above reads zero while it is ' +
          'down, and zero is what a healthy week looks like. See docs/runbooks.md.',
        metric: this.recorderFunction.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: cloudwatch.Stats.SUM,
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),

      eventsUndelivered: new cloudwatch.Alarm(this, 'EventsUndeliveredAlarm', {
        alarmName: `${envName}-spot-events-undelivered`,
        alarmDescription:
          'Interruption events reached the dead-letter queue, so EventBridge gave up retrying ' +
          'and those reclaims are missing from every metric here. The events are in the queue ' +
          'for 14 days and can be replayed. See docs/runbooks.md.',
        metric: this.recorderDlq.metricApproximateNumberOfMessagesVisible({
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
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SpotMetricNamespace', {
      value: SPOT_METRIC_NAMESPACE,
      description: 'CloudWatch namespace holding the interruption and drain metrics',
      exportName: `${envName}-spot-metric-namespace`,
    });

    new cdk.CfnOutput(this, 'RecorderDlqUrl', {
      value: this.recorderDlq.queueUrl,
      description: 'Interruption events EventBridge could not deliver',
      exportName: `${envName}-spot-recorder-dlq-url`,
    });
  }
}

/**
 * The recorder, as it ships.
 *
 * `lambda.Code.fromInline` means nothing in the normal CDK pipeline parses this:
 * `tsc` sees a template literal and `cdk synth` embeds it verbatim. So it is
 * exported and `test/spot-recorder-handler.test.ts` loads it into a function
 * scope with `require` and `process` supplied, which is the same arrangement
 * `test/canary-deploy-handlers.test.ts` uses — and it is not optional here,
 * because an inverted comparison in the overrun check does not fail loudly: it
 * reports clean drains as overruns, or worse, overruns as clean drains.
 *
 * Three things it does that are worth saying out loud:
 *
 *   • It re-checks `stopCode`. The rule already filters on it, and a rule is a
 *     thing somebody can widen in the console at three in the morning while
 *     debugging. A handler that trusted the pattern would start counting
 *     deployments as interruptions.
 *
 *   • It publishes every metric twice: once dimensioned by environment, once by
 *     environment, cluster and service. CloudWatch does not aggregate across
 *     dimension sets — a metric published only with `(Environment, ClusterName,
 *     ServiceName)` cannot be read back as "interruptions in staging" — so the
 *     alarms read the first set and anybody diagnosing reads the second.
 *
 *   • It distinguishes "did not overrun" from "could not be measured".
 *     `stoppingAt` is absent if the task never entered STOPPING, and treating
 *     that as a clean drain would hide exactly the reclaim that went worst.
 */
export const SPOT_RECORDER_SOURCE = `
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const cloudwatch = new CloudWatchClient({});

const NAMESPACE = process.env.METRIC_NAMESPACE;
const ENVIRONMENT = process.env.ENVIRONMENT_NAME;
const EXPECTED_STOP_CODE = process.env.EXPECTED_STOP_CODE;
const SCHEMA_VERSION = Number(process.env.LOG_SCHEMA_VERSION || '1');
const WARNING_SECONDS = Number(process.env.WARNING_SECONDS || '120');

const budgets = JSON.parse(process.env.DRAIN_BUDGETS || '{}');

/**
 * The declared drain budget for a service, by longest matching pattern.
 *
 * Patterns rather than names because the per-pull-request services are
 * 'preview-pr-<number>', and the number is not knowable here.
 */
const budgetFor = (serviceName) => {
  let matched;
  for (const [pattern, seconds] of Object.entries(budgets)) {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const hit = pattern.endsWith('*') ? serviceName.startsWith(prefix) : serviceName === prefix;
    if (!hit) continue;
    if (matched === undefined || prefix.length > matched.prefix.length) {
      matched = { prefix, seconds };
    }
  }
  return matched ? matched.seconds : undefined;
};

/** 'service:staging-service' is how ECS names the group a service's tasks are in. */
const serviceNameOf = (detail) => {
  const group = detail.group || '';
  return group.startsWith('service:') ? group.slice('service:'.length) : '';
};

const clusterNameOf = (detail) => {
  const arn = detail.clusterArn || '';
  const slash = arn.lastIndexOf('/');
  return slash === -1 ? '' : arn.slice(slash + 1);
};

/**
 * Which half of the reclaim this event is.
 *
 * The warning is the event where ECS has decided to stop the task and the task
 * is still running — that is the start of the two minutes. The completion is
 * the one that carries the timestamps.
 */
const phaseOf = (detail) => {
  if (detail.lastStatus === 'STOPPED') return 'stopped';
  if (detail.desiredStatus === 'STOPPED') return 'warning';
  return 'other';
};

const publish = async (metrics, timestamp, dimensionsBase) => {
  const data = [];
  for (const metric of metrics) {
    data.push({
      MetricName: metric.name,
      Unit: metric.unit,
      Value: metric.value,
      Timestamp: timestamp,
      Dimensions: [{ Name: 'Environment', Value: ENVIRONMENT }],
    });
    data.push({
      MetricName: metric.name,
      Unit: metric.unit,
      Value: metric.value,
      Timestamp: timestamp,
      Dimensions: [
        { Name: 'Environment', Value: ENVIRONMENT },
        { Name: 'ClusterName', Value: dimensionsBase.clusterName },
        { Name: 'ServiceName', Value: dimensionsBase.serviceName },
      ],
    });
  }
  if (data.length === 0) return;
  await cloudwatch.send(new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: data }));
};

exports.handler = async (event) => {
  const detail = (event && event.detail) || {};

  // The rule filters on this already. Re-checked because a rule is editable in
  // the console and a handler that trusted it would count deployments.
  if (detail.stopCode !== EXPECTED_STOP_CODE) {
    return { recorded: false, reason: 'stop-code-not-' + EXPECTED_STOP_CODE };
  }

  const phase = phaseOf(detail);
  if (phase === 'other') {
    return { recorded: false, reason: 'not-a-reclaim-transition' };
  }

  const clusterName = clusterNameOf(detail);
  const serviceName = serviceNameOf(detail);
  const budgetSeconds = budgetFor(serviceName);
  const timestamp = new Date(event.time || Date.now());

  const record = {
    schemaVersion: SCHEMA_VERSION,
    event: 'spot-interruption',
    phase,
    environment: ENVIRONMENT,
    clusterName,
    serviceName,
    taskArn: detail.taskArn || '',
    stoppedReason: detail.stoppedReason || '',
    budgetSeconds: budgetSeconds === undefined ? null : budgetSeconds,
    warningSeconds: WARNING_SECONDS,
  };

  if (phase === 'warning') {
    await publish(
      [{ name: 'Interruptions', unit: 'Count', value: 1 }],
      timestamp,
      { clusterName, serviceName },
    );
    console.log(JSON.stringify(record));
    return { recorded: true, phase, serviceName };
  }

  // phase === 'stopped': the event that carries the shutdown.
  const stoppingAt = detail.stoppingAt ? Date.parse(detail.stoppingAt) : NaN;
  const stoppedAt = detail.stoppedAt ? Date.parse(detail.stoppedAt) : NaN;

  if (!Number.isFinite(stoppingAt) || !Number.isFinite(stoppedAt) || stoppedAt < stoppingAt) {
    // Unmeasurable, which is not the same as within budget. A task that went
    // from RUNNING to STOPPED without a STOPPING phase is the one whose
    // shutdown went worst, and counting it as a clean drain would hide it.
    await publish(
      [{ name: 'DrainUnmeasured', unit: 'Count', value: 1 }],
      timestamp,
      { clusterName, serviceName },
    );
    console.log(JSON.stringify({ ...record, drainSeconds: null, overrun: null }));
    return { recorded: true, phase, serviceName, drainSeconds: null };
  }

  const drainSeconds = (stoppedAt - stoppingAt) / 1000;
  // Against the declared budget where there is one. Where there is not — a
  // service on Spot that no catalogue entry claims, which the audit fails the
  // build for — the warning itself is the only bound available, and measuring
  // against it is better than measuring against nothing.
  const bound = budgetSeconds === undefined ? WARNING_SECONDS : budgetSeconds;
  const overrun = drainSeconds > bound;

  await publish(
    [
      { name: 'DrainSeconds', unit: 'Seconds', value: drainSeconds },
      { name: 'DrainOverruns', unit: 'Count', value: overrun ? 1 : 0 },
    ],
    timestamp,
    { clusterName, serviceName },
  );
  console.log(JSON.stringify({ ...record, drainSeconds, boundSeconds: bound, overrun }));
  return { recorded: true, phase, serviceName, drainSeconds, overrun };
};
`;
