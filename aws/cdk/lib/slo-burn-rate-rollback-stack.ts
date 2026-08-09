import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { RollbackTarget } from './rollback-automation-stack';

/**
 * A multi-window burn-rate policy, in the shape the Google SRE workbook
 * describes.
 *
 * `burnRate` is a multiple of the budget-exhaustion pace that would consume the
 * whole error budget in exactly one SLO window. Burning at 1x for 30 days
 * spends a 30-day budget precisely; burning at 14.4x spends 2% of it in an
 * hour.
 *
 * The two windows are an AND, and each one is there to cancel a specific
 * failure of the other:
 *
 *   `longWindow` decides significance. A five-minute spike that never recurs
 *   is not worth a rollback, and a long window refuses to see it.
 *
 *   `shortWindow` decides currency. A long window stays above the threshold
 *   long after the incident ends, because the errors are still inside it — so
 *   on its own it would roll back a service that has already recovered.
 */
export interface BurnRatePolicy {
  /** Identifier used in alarm names and notifications, e.g. `fast`. */
  readonly name: string;
  /** Burn-rate multiple that both windows must exceed. */
  readonly burnRate: number;
  /** Long window, in minutes. Must be a whole number of minutes. */
  readonly longWindowMinutes: number;
  /** Short window, in minutes. Conventionally 1/12th of the long window. */
  readonly shortWindowMinutes: number;
  /**
   * Roll back when this policy fires, rather than only notifying.
   * A slow-burn policy is usually a page, not a rollback: it fires hours after
   * the change that caused it, by which time a rollback is as likely to be
   * wrong as right.
   */
  readonly triggersRollback: boolean;
  /** Human-readable rationale, copied into the alarm description. */
  readonly description: string;
}

/**
 * Fast and slow burn, at the rates the SRE workbook recommends for a 30-day
 * window: 2% of the budget in an hour, and 5% in six hours.
 *
 * The fast policy rolls back. The slow policy notifies — see
 * {@link BurnRatePolicy.triggersRollback}.
 */
export const DEFAULT_BURN_RATE_POLICIES: BurnRatePolicy[] = [
  {
    name: 'fast',
    burnRate: 14.4,
    longWindowMinutes: 60,
    shortWindowMinutes: 5,
    triggersRollback: true,
    description:
      '2% of the 30-day error budget consumed in one hour, still burning in the last five minutes',
  },
  {
    name: 'slow',
    burnRate: 6,
    longWindowMinutes: 360,
    shortWindowMinutes: 30,
    triggersRollback: false,
    description:
      '5% of the 30-day error budget consumed in six hours, still burning in the last thirty minutes',
  },
];

export interface SloConfig {
  /**
   * Availability objective as a fraction, e.g. `0.999` for three nines.
   * The error budget is `1 - sloTarget`, and the burn rate is the observed
   * error ratio divided by that budget.
   */
  readonly target: number;
  /**
   * Rolling window the objective is stated over, in days (default: 30).
   * Only used to report how much budget is left; the alarms are window-relative
   * by construction.
   */
  readonly windowDays?: number;
  /**
   * Requests a window needs before its burn rate is believed (default: 60).
   *
   * Below this the ratio is reported as a burn rate of zero. Without the floor,
   * one failed request in a window of three reads as a 33% error ratio — a
   * 333x burn against a three-nines budget — and every quiet night rolls back
   * production.
   */
  readonly minimumRequestsPerWindow?: number;
}

/** `fast` → `Fast`, for construct ids. */
const titleCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** `0.999` → `99.9%`, without the float noise of a naive multiply. */
const formatTarget = (target: number): string => `${Math.round(target * 1e6) / 1e4}%`;

/** `360` → `6h`, `90` → `1h30m`, `5` → `5m`. */
const describeMinutes = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h${remainder}m`;
};

/**
 * SNS alarm action for a composite alarm.
 *
 * `aws-cdk-lib/aws-cloudwatch-actions` exists for exactly this, but importing it
 * for one topic pulls a second copy of the CloudWatch action bindings into every
 * consumer of this file. The interface is two lines.
 */
class SnsCompositeAction implements cloudwatch.IAlarmAction {
  constructor(private readonly topic: sns.ITopic) {}

  bind(): cloudwatch.AlarmActionConfig {
    return { alarmActionArn: this.topic.topicArn };
  }
}

export interface SloBurnRateRollbackStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging (default: production). */
  readonly envName?: string;
  /**
   * `loadBalancerFullName` of the ALB serving the SLO, e.g.
   * `app/production-alb/1234567890abcdef`. Take it from
   * `EcsStack.alb.loadBalancerFullName` rather than typing it.
   */
  readonly loadBalancerFullName: string;
  /**
   * `targetGroupFullName` of the target group the SLO is measured on, e.g.
   * `targetgroup/production-tg/abcdef1234567890`.
   */
  readonly targetGroupFullName: string;
  /** The objective the burn rate is measured against. */
  readonly slo: SloConfig;
  /**
   * Burn-rate policies to alarm on (default: {@link DEFAULT_BURN_RATE_POLICIES}).
   */
  readonly burnRatePolicies?: BurnRatePolicy[];
  /** ECS services to roll back. Rolling-update and CodeDeploy modes both supported. */
  readonly rollbackTargets: RollbackTarget[];
  /**
   * Only roll back a service whose current deployment started within this many
   * minutes (default: 120). Set to 0 to roll back regardless of deployment age.
   *
   * Burning budget is a symptom; a rollback only treats it if a deployment
   * caused it. When a dependency is down and nothing has shipped for a week,
   * rolling back to the previous revision changes nothing and costs a
   * deployment during an incident, so the default is to notify and leave the
   * service alone.
   */
  readonly deploymentAttributionWindowMinutes?: number;
  /** Email addresses subscribed to the notification topic. */
  readonly notificationEmails?: string[];
  /** Lambda execution timeout in seconds (default: 120). */
  readonly lambdaTimeoutSeconds?: number;
  /**
   * Reserved concurrency for the rollback Lambda (default: 2).
   *
   * Deliberately tiny. Several policies can breach at once and EventBridge
   * retries, so the cap is what stops a metric storm from turning into
   * concurrent rollbacks of the same service.
   */
  readonly lambdaReservedConcurrency?: number;
}

/**
 * Rollback driven by SLO error-budget burn rate.
 *
 * The stack next door, `RollbackAutomationStack`, rolls back when an alarm is
 * in ALARM. That answers "is a threshold crossed right now", which is a
 * different question from "is this deployment costing us more reliability than
 * we have to spend". A 5xx alarm at 1% fires identically for a thirty-second
 * blip and for a change that will exhaust a quarter's error budget by lunchtime;
 * a burn rate separates them, because it is the error ratio measured against
 * what the objective actually affords.
 *
 * Architecture:
 *
 *   ALB metrics (RequestCount, target 5xx, ELB 5xx)
 *     → metric math: errors / requests / errorBudget, floored on traffic
 *       → long-window alarm  ┐
 *       → short-window alarm ┴→ composite alarm (AND)
 *         → EventBridge (composite alarm state change → ALARM)
 *           → Lambda
 *             ├─ recompute burn and remaining budget from CloudWatch
 *             ├─ attribute: did this service deploy recently?
 *             ├─ roll back eligible targets (UpdateService / StopDeployment)
 *             └─ SNS: burn rate, budget remaining, what was done and why
 *
 * Why the Lambda re-reads metrics the alarm already evaluated: the alarm knows
 * a threshold was crossed and nothing else. The notification a human is woken
 * by needs the numbers — burn rate, budget spent, budget left — and the
 * rollback decision needs the traffic volume behind them. Reading them once, in
 * the handler, keeps the report and the decision consistent with each other.
 *
 * Integration:
 *   - `EcsStack` / `BlueGreenDeployStack` supply `loadBalancerFullName` and
 *     `targetGroupFullName`; pass the *stable* target group for a blue/green
 *     service, which is the one serving production between deployments.
 *   - `compositeAlarms` are also usable as CodeDeploy deployment alarms, so a
 *     burn-rate breach during a blue/green shift aborts the shift as well.
 *   - This stack composes with `RollbackAutomationStack` rather than replacing
 *     it: keep the alarm-state rollback for hard failures (no healthy hosts),
 *     and let the burn rate govern the slower, subtler regressions.
 */
export class SloBurnRateRollbackStack extends cdk.Stack {
  public readonly notificationTopic: sns.Topic;
  public readonly rollbackFunction: lambda.Function;
  public readonly compositeAlarms: cloudwatch.CompositeAlarm[];
  public readonly eventRule: events.Rule;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: SloBurnRateRollbackStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const policies = props.burnRatePolicies ?? DEFAULT_BURN_RATE_POLICIES;
    const windowDays = props.slo.windowDays ?? 30;
    const minimumRequests = props.slo.minimumRequestsPerWindow ?? 60;
    const attributionWindowMinutes = props.deploymentAttributionWindowMinutes ?? 120;
    const lambdaTimeoutSeconds = props.lambdaTimeoutSeconds ?? 120;
    const lambdaReservedConcurrency = props.lambdaReservedConcurrency ?? 2;

    if (props.slo.target <= 0 || props.slo.target >= 1) {
      throw new Error(
        `SloBurnRateRollbackStack: slo.target must be a fraction strictly between 0 and 1 (got ${props.slo.target}); 99.9% is 0.999`,
      );
    }
    if (props.rollbackTargets.length === 0) {
      throw new Error('SloBurnRateRollbackStack: rollbackTargets must contain at least one target');
    }
    if (policies.length === 0) {
      throw new Error('SloBurnRateRollbackStack: burnRatePolicies must contain at least one policy');
    }
    for (const policy of policies) {
      if (policy.shortWindowMinutes >= policy.longWindowMinutes) {
        throw new Error(
          `SloBurnRateRollbackStack: policy "${policy.name}" has a short window (${policy.shortWindowMinutes}m) that is not shorter than its long window (${policy.longWindowMinutes}m)`,
        );
      }
      // CloudWatch periods are whole minutes, and above 3 hours they must be a
      // multiple of 60 seconds anyway — an alarm silently rounding its window
      // would evaluate a different burn rate than the one written here.
      for (const minutes of [policy.longWindowMinutes, policy.shortWindowMinutes]) {
        if (!Number.isInteger(minutes) || minutes <= 0) {
          throw new Error(
            `SloBurnRateRollbackStack: policy "${policy.name}" window ${minutes} must be a positive whole number of minutes`,
          );
        }
      }
      if (policy.longWindowMinutes > 1440) {
        throw new Error(
          `SloBurnRateRollbackStack: policy "${policy.name}" long window ${policy.longWindowMinutes}m exceeds the 24-hour maximum CloudWatch alarm period`,
        );
      }
    }

    // `1 - 0.999` is 0.0010000000000000009 in binary floating point, and that
    // is what would be written into the alarm expression and read by whoever
    // opens it. Twelve significant figures is far more precision than any
    // objective carries and enough to keep an unusual one (0.9995, 0.99999)
    // intact.
    const errorBudget = Number((1 - props.slo.target).toPrecision(12));

    // ── Encryption key for logs and Lambda configuration ────────────────────────
    // The rollback log records which revision was pulled out of production and
    // on what evidence, which is the operational history most worth keeping out
    // of a plaintext-by-default store. CDK attaches the CloudWatch Logs service
    // grant and the Lambda decrypt grant to the key policy.
    const encryptionKey = new kms.Key(this, 'BurnRateEncryptionKey', {
      alias: `alias/${envName}-slo-burn-rate-rollback`,
      description: `Encrypts SLO burn-rate rollback logs and Lambda configuration (${envName})`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Notifications ───────────────────────────────────────────────────────────
    this.notificationTopic = new sns.Topic(this, 'BurnRateNotificationTopic', {
      topicName: `${envName}-slo-burn-rate-notifications`,
      displayName: `${envName} SLO Burn Rate Notifications`,
      // Server-side encryption with the AWS-managed SNS key. An alias reference
      // costs nothing and needs no key policy, unlike a customer-managed key.
      masterKey: kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns'),
    });

    for (const email of props.notificationEmails ?? []) {
      this.notificationTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    // ── Burn-rate alarms ────────────────────────────────────────────────────────
    const dimensions = {
      LoadBalancer: props.loadBalancerFullName,
      TargetGroup: props.targetGroupFullName,
    };

    /**
     * Burn rate over `windowMinutes`, as a CloudWatch metric-math expression.
     *
     * Written as three named sub-expressions rather than one line so that the
     * alarm's graph in the console shows the request count and the error count
     * that produced the ratio. When an on-call engineer opens a rollback
     * notification at 03:00, the first question is always "how much traffic was
     * that measured on".
     */
    const burnRateMetric = (windowMinutes: number, label: string): cloudwatch.MathExpression => {
      const period = cdk.Duration.minutes(windowMinutes);

      const requests = new cloudwatch.MathExpression({
        // A target group with no traffic publishes no RequestCount datapoint at
        // all, rather than a zero, so every input is filled before use.
        expression: 'FILL(rc, 0)',
        usingMetrics: {
          rc: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'RequestCount',
            dimensionsMap: dimensions,
            statistic: 'Sum',
          }),
        },
        period,
        label: `Requests (${label})`,
      });

      const errors = new cloudwatch.MathExpression({
        expression: 'FILL(t5, 0) + FILL(e5, 0)',
        usingMetrics: {
          t5: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_5XX_Count',
            dimensionsMap: dimensions,
            statistic: 'Sum',
          }),
          // ELB-generated 5xx — 502, 503 and 504 — are counted here and nowhere
          // else. They are exactly what a deployment with a broken image or a
          // failing health check produces: the request never reaches a target,
          // so it never appears in the target-scoped metric. An SLO that
          // ignored them would read as perfect while every request failed.
          e5: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_ELB_5XX_Count',
            dimensionsMap: dimensions,
            statistic: 'Sum',
          }),
        },
        period,
        label: `Failed requests (${label})`,
      });

      return new cloudwatch.MathExpression({
        // The denominator is guarded independently of the traffic floor.
        // `IF` is evaluated element-wise over both branches, so a window with
        // zero requests would divide by zero inside the branch that is about to
        // be discarded, and CloudWatch returns no data for that datapoint
        // instead of the zero the floor intends.
        expression: `IF(req >= ${minimumRequests}, err / IF(req > 0, req, 1) / ${errorBudget}, 0)`,
        usingMetrics: { req: requests, err: errors },
        period,
        label: `Burn rate (${label})`,
      });
    };

    this.compositeAlarms = policies.map((policy) => {
      const budgetFraction = (policy.burnRate * policy.longWindowMinutes) / (windowDays * 24 * 60);
      const budgetPercent = Math.round(budgetFraction * 1000) / 10;

      const windowAlarm = (windowMinutes: number, suffix: string): cloudwatch.Alarm =>
        new cloudwatch.Alarm(this, `BurnRate${titleCase(policy.name)}${suffix}Alarm`, {
          alarmName: `${envName}-slo-burn-rate-${policy.name}-${suffix.toLowerCase()}`,
          alarmDescription:
            `Error budget burning at more than ${policy.burnRate}x over ${describeMinutes(windowMinutes)} ` +
            `(SLO ${formatTarget(props.slo.target)} over ${windowDays} days). ${policy.description}.`,
          metric: burnRateMetric(windowMinutes, `${policy.name} ${suffix.toLowerCase()}`),
          threshold: policy.burnRate,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          // A window with too little traffic already evaluates to a burn rate of
          // zero, so missing data here means the metric itself stopped arriving.
          // That is a monitoring failure, not an SLO breach, and rolling back on
          // it would make an outage of CloudWatch into an outage of the service.
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

      const longAlarm = windowAlarm(policy.longWindowMinutes, 'Long');
      const shortAlarm = windowAlarm(policy.shortWindowMinutes, 'Short');

      const composite = new cloudwatch.CompositeAlarm(
        this,
        `BurnRate${titleCase(policy.name)}Composite`,
        {
          compositeAlarmName: `${envName}-slo-burn-rate-${policy.name}`,
          alarmDescription:
            `${policy.name} burn: ${budgetPercent}% of the ${windowDays}-day error budget consumed in ` +
            `${describeMinutes(policy.longWindowMinutes)} and still burning over the last ` +
            `${describeMinutes(policy.shortWindowMinutes)}. ` +
            (policy.triggersRollback
              ? 'Triggers automated rollback of recently deployed services.'
              : 'Notifies only; no automated rollback.'),
          alarmRule: cloudwatch.AlarmRule.allOf(
            cloudwatch.AlarmRule.fromAlarm(longAlarm, cloudwatch.AlarmState.ALARM),
            cloudwatch.AlarmRule.fromAlarm(shortAlarm, cloudwatch.AlarmState.ALARM),
          ),
          // The composite is the signal; leaving it self-resetting means a
          // recovered service stops being in ALARM without anyone acknowledging
          // it, which is what makes the short window worth having.
          actionsEnabled: true,
        },
      );
      composite.addAlarmAction(new SnsCompositeAction(this.notificationTopic));

      return composite;
    });

    // ── Rollback Lambda ─────────────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'RollbackLogGroup', {
      logGroupName: `/aws/lambda/${envName}-slo-burn-rate-rollback`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const rollbackRole = new iam.Role(this, 'RollbackRole', {
      roleName: `${envName}-slo-burn-rate-rollback-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Rolls back ${envName} ECS services when the SLO error budget burns too fast`,
    });
    rollbackRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    // cloudwatch:GetMetricData has no resource-level permissions — metrics are
    // not resources — so this wildcard is imposed by the API. The call is
    // read-only.
    rollbackRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadSloMetrics',
        actions: ['cloudwatch:GetMetricData'],
        resources: ['*'],
      }),
    );

    // ecs:DescribeServices is likewise not resource-scopable in the form this
    // handler calls it: the cluster is a request parameter and the services are
    // named in the body, so IAM cannot narrow it beyond the account. The
    // mutating call below is scoped to the exact service ARNs.
    rollbackRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DescribeEcsServices',
        actions: ['ecs:DescribeServices'],
        resources: ['*'],
      }),
    );

    rollbackRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UpdateEcsServices',
        actions: ['ecs:UpdateService'],
        resources: props.rollbackTargets.map((target) =>
          this.formatArn({
            service: 'ecs',
            resource: 'service',
            resourceName: `${target.clusterName}/${target.serviceName}`,
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ),
      }),
    );

    const codeDeployTargets = props.rollbackTargets.filter(
      (target) => target.codeDeployApplication && target.codeDeployDeploymentGroup,
    );
    if (codeDeployTargets.length > 0) {
      // ListDeployments filters by application and deployment group but is
      // authorized against the deployment-group ARN, so this is scoped to the
      // groups actually configured as targets. StopDeployment takes a
      // deployment id that does not exist until the deployment does, and
      // CodeDeploy authorizes it against the same group ARN.
      rollbackRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'StopCodeDeployDeployments',
          actions: [
            'codedeploy:ListDeployments',
            'codedeploy:GetDeployment',
            'codedeploy:StopDeployment',
          ],
          resources: codeDeployTargets.map((target) =>
            // CodeDeploy deployment-group ARNs separate the resource type from
            // the name with a colon, not a slash:
            //   arn:aws:codedeploy:<region>:<account>:deploymentgroup:<app>/<group>
            this.formatArn({
              service: 'codedeploy',
              resource: 'deploymentgroup',
              resourceName: `${target.codeDeployApplication}/${target.codeDeployDeploymentGroup}`,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          ),
        }),
      );
    }

    this.notificationTopic.grantPublish(rollbackRole);

    const rollbackPolicyNames = policies
      .filter((policy) => policy.triggersRollback)
      .map((policy) => `${envName}-slo-burn-rate-${policy.name}`);

    this.rollbackFunction = new lambda.Function(this, 'RollbackFunction', {
      functionName: `${envName}-slo-burn-rate-rollback`,
      description: `Rolls back ${envName} ECS services when an SLO burn-rate composite alarm fires`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: rollbackRole,
      timeout: cdk.Duration.seconds(lambdaTimeoutSeconds),
      reservedConcurrentExecutions: lambdaReservedConcurrency,
      environmentEncryption: encryptionKey,
      logGroup,
      environment: {
        LOAD_BALANCER_FULL_NAME: props.loadBalancerFullName,
        TARGET_GROUP_FULL_NAME: props.targetGroupFullName,
        SLO_TARGET: String(props.slo.target),
        SLO_WINDOW_DAYS: String(windowDays),
        MINIMUM_REQUESTS_PER_WINDOW: String(minimumRequests),
        // Only the policies that roll back are shipped to the handler. The
        // notify-only policies still reach the topic through their own alarm
        // action, so a slow burn pages without the handler having to decide.
        ROLLBACK_POLICIES: JSON.stringify(
          policies
            .filter((policy) => policy.triggersRollback)
            .map((policy) => ({
              alarmName: `${envName}-slo-burn-rate-${policy.name}`,
              name: policy.name,
              burnRate: policy.burnRate,
              longWindowMinutes: policy.longWindowMinutes,
              shortWindowMinutes: policy.shortWindowMinutes,
            })),
        ),
        ROLLBACK_TARGETS: JSON.stringify(props.rollbackTargets),
        DEPLOYMENT_ATTRIBUTION_WINDOW_MINUTES: String(attributionWindowMinutes),
        SNS_TOPIC_ARN: this.notificationTopic.topicArn,
        ENV_NAME: envName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(BURN_RATE_ROLLBACK_SOURCE),
    });

    // ── Checkov exemptions, recorded on the resource they apply to ─────────────
    // Written into the synthesized template rather than the repository baseline
    // so the reasoning travels with the resource into whatever account this is
    // copied to.
    (this.rollbackFunction.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_116',
          comment:
            'No DLQ: EventBridge is the invoker and already retries, and a rollback that ' +
            'failed twenty minutes ago is not one to replay from a queue — by then the ' +
            'burn has either stopped or the alarm has re-fired with current metrics. ' +
            'Failures surface as the notification the handler publishes before it throws.',
        },
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler calls only regional control-plane APIs (CloudWatch, ' +
            'ECS, CodeDeploy, SNS) and touches no VPC resource. Attaching it to the VPC ' +
            'would require a NAT gateway or four interface endpoints to reach those APIs, ' +
            'adding cost and a failure mode to the path that runs during an incident.',
        },
      ],
    });

    // ── EventBridge: composite alarm → rollback ─────────────────────────────────
    // Composite alarms emit the same `CloudWatch Alarm State Change` detail-type
    // as metric alarms, so the pattern filters on the composite names and the
    // two window alarms underneath never reach the handler on their own.
    this.eventRule = new events.Rule(this, 'BurnRateBreachRule', {
      ruleName: `${envName}-slo-burn-rate-rollback`,
      description: `Invokes the burn-rate rollback handler when a rollback policy breaches (${envName})`,
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        detail: {
          state: { value: ['ALARM'] },
          alarmName: rollbackPolicyNames,
        },
      },
      // A stack configured with only notify-only policies has nothing to invoke
      // the handler for; an event pattern with an empty name list would match
      // every alarm in the account instead of none.
      enabled: rollbackPolicyNames.length > 0,
    });

    if (rollbackPolicyNames.length > 0) {
      this.eventRule.addTarget(
        new events_targets.LambdaFunction(this.rollbackFunction, { retryAttempts: 2 }),
      );
    }

    // ── Dashboard ───────────────────────────────────────────────────────────────
    // Burn rate is not a number anyone can read off the raw ALB graphs, and the
    // notification quotes it without showing the shape of it. One row per
    // policy, each with its threshold drawn in, makes "how close were we" a
    // glance instead of a metric-math session.
    this.dashboard = new cloudwatch.Dashboard(this, 'BurnRateDashboard', {
      dashboardName: `${envName}-slo-burn-rate`,
      defaultInterval: cdk.Duration.days(1),
    });

    for (const policy of policies) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${policy.name} burn (${describeMinutes(policy.longWindowMinutes)} window, ${policy.burnRate}x)`,
          left: [burnRateMetric(policy.longWindowMinutes, `${policy.name} long`)],
          leftAnnotations: [
            {
              value: policy.burnRate,
              label: `${policy.burnRate}x`,
              color: cloudwatch.Color.RED,
            },
          ],
          width: 12,
          height: 6,
        }),
        new cloudwatch.GraphWidget({
          title: `${policy.name} burn (${describeMinutes(policy.shortWindowMinutes)} window, ${policy.burnRate}x)`,
          left: [burnRateMetric(policy.shortWindowMinutes, `${policy.name} short`)],
          leftAnnotations: [
            {
              value: policy.burnRate,
              label: `${policy.burnRate}x`,
              color: cloudwatch.Color.RED,
            },
          ],
          width: 12,
          height: 6,
        }),
      );
    }

    // ── Tags ────────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ─────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RollbackFunctionArn', {
      value: this.rollbackFunction.functionArn,
      description: 'ARN of the SLO burn-rate rollback Lambda function',
      exportName: `${envName}-slo-burn-rate-rollback-function-arn`,
    });

    new cdk.CfnOutput(this, 'NotificationTopicArn', {
      value: this.notificationTopic.topicArn,
      description: 'SNS topic ARN for SLO burn-rate notifications',
      exportName: `${envName}-slo-burn-rate-notification-topic-arn`,
    });

    new cdk.CfnOutput(this, 'CompositeAlarmNames', {
      // The configured names rather than `alarm.alarmName`, which is a Ref that
      // resolves only at deploy time — an output whose whole purpose is to be
      // copied into another stack's alarm configuration should be readable.
      value: policies.map((policy) => `${envName}-slo-burn-rate-${policy.name}`).join(','),
      description:
        'Composite burn-rate alarm names — usable as CodeDeploy deployment alarms to abort a shift mid-flight',
      exportName: `${envName}-slo-burn-rate-composite-alarm-names`,
    });

    new cdk.CfnOutput(this, 'ErrorBudget', {
      value: `${formatTarget(props.slo.target)} over ${windowDays} days (budget ${errorBudget})`,
      description: 'The objective these alarms measure burn against',
      exportName: `${envName}-slo-burn-rate-objective`,
    });
  }
}

/**
 * The rollback handler, shipped inline.
 *
 * Exported as a string so `test/slo-burn-rate-rollback-handler.test.ts` can
 * compile and run it: `lambda.Code.fromInline` means nothing else in the build
 * ever parses it, so an inverted comparison here would first surface as a
 * production rollback that did not happen.
 */
export const BURN_RATE_ROLLBACK_SOURCE = `
'use strict';
const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { ECSClient, DescribeServicesCommand, UpdateServiceCommand } = require('@aws-sdk/client-ecs');
const { CodeDeployClient, ListDeploymentsCommand, StopDeploymentCommand } = require('@aws-sdk/client-codedeploy');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const region = process.env.AWS_REGION;
const cloudwatch = new CloudWatchClient({ region });
const ecs = new ECSClient({ region });
const codedeploy = new CodeDeployClient({ region });
const sns = new SNSClient({ region });

const LB = process.env.LOAD_BALANCER_FULL_NAME;
const TG = process.env.TARGET_GROUP_FULL_NAME;
const SLO_TARGET = parseFloat(process.env.SLO_TARGET);
const ERROR_BUDGET = 1 - SLO_TARGET;
const SLO_WINDOW_DAYS = parseFloat(process.env.SLO_WINDOW_DAYS);
const MINIMUM_REQUESTS = parseFloat(process.env.MINIMUM_REQUESTS_PER_WINDOW);
const POLICIES = JSON.parse(process.env.ROLLBACK_POLICIES);
const TARGETS = JSON.parse(process.env.ROLLBACK_TARGETS);
const ATTRIBUTION_WINDOW_MINUTES = parseFloat(process.env.DEPLOYMENT_ATTRIBUTION_WINDOW_MINUTES);
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const ENV_NAME = process.env.ENV_NAME;

const round = (value, places) => {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
};

const sumValues = (result) => (result && result.Values ? result.Values : []).reduce((a, b) => a + b, 0);

function metricQuery(id, metricName, period) {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ApplicationELB',
        MetricName: metricName,
        Dimensions: [
          { Name: 'TargetGroup', Value: TG },
          { Name: 'LoadBalancer', Value: LB },
        ],
      },
      Period: period,
      Stat: 'Sum',
    },
    ReturnData: true,
  };
}

/**
 * Requests and failed requests over the last \`windowMinutes\`.
 *
 * The period is the whole window, so CloudWatch returns one datapoint per
 * metric and the sums below are exact rather than an average of averages.
 * GetMetricData caps a period at one day, which is also the largest window an
 * alarm can evaluate, so a policy window always fits in one datapoint. The SLO
 * window does not, and is queried at a one-hour period instead.
 */
async function readWindow(windowMinutes, period) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - windowMinutes * 60 * 1000);

  const response = await cloudwatch.send(new GetMetricDataCommand({
    StartTime: startTime,
    EndTime: endTime,
    ScanBy: 'TimestampAscending',
    MetricDataQueries: [
      metricQuery('requests', 'RequestCount', period),
      metricQuery('targetErrors', 'HTTPCode_Target_5XX_Count', period),
      metricQuery('elbErrors', 'HTTPCode_ELB_5XX_Count', period),
    ],
  }));

  const byId = {};
  for (const result of response.MetricDataResults || []) {
    byId[result.Id] = result;
  }

  const requests = sumValues(byId.requests);
  // ELB-generated 5xx never reach a target, so they are absent from the
  // target-scoped metric and have to be added in explicitly.
  const errors = sumValues(byId.targetErrors) + sumValues(byId.elbErrors);

  return { requests, errors };
}

/**
 * Burn rate: the observed error ratio expressed as a multiple of the ratio the
 * budget affords. 1x spends the whole budget in exactly one SLO window.
 *
 * Mirrors the traffic floor the alarm applies, so the number in the
 * notification is the same number the alarm evaluated. Below the floor the
 * ratio is noise, not signal.
 */
function burnRate(window) {
  if (window.requests <= 0 || window.requests < MINIMUM_REQUESTS) return 0;
  return (window.errors / window.requests) / ERROR_BUDGET;
}

/**
 * Whether this service's running deployment is recent enough for a rollback to
 * plausibly be the fix, and whether one is already in flight.
 *
 * ECS reports the deployment currently being rolled out as PRIMARY. Its
 * \`rolloutState\` is IN_PROGRESS while tasks are still being replaced — which
 * covers both a deploy that has not landed yet (the circuit breaker owns that
 * one) and a rollback this handler already issued on a previous alarm
 * transition. Either way, issuing another one now would stack deployments and
 * walk the service backwards a revision per alarm re-fire.
 */
function assessDeployment(service, now) {
  const deployments = service.deployments || [];
  const primary = deployments.find((d) => d.status === 'PRIMARY');
  if (!primary) return { eligible: false, reason: 'NO_PRIMARY_DEPLOYMENT' };

  if (primary.rolloutState === 'IN_PROGRESS') {
    return { eligible: false, reason: 'DEPLOYMENT_IN_PROGRESS' };
  }

  if (ATTRIBUTION_WINDOW_MINUTES <= 0) return { eligible: true, ageMinutes: null };

  const createdAt = primary.createdAt ? new Date(primary.createdAt).getTime() : null;
  if (createdAt === null || Number.isNaN(createdAt)) {
    // Without a timestamp there is no way to attribute the burn to this
    // deployment, and attribution is the whole reason for the check. Rolling
    // back anyway would be exactly the alarm-state behaviour this replaces.
    return { eligible: false, reason: 'DEPLOYMENT_AGE_UNKNOWN' };
  }

  const ageMinutes = (now - createdAt) / 60000;
  if (ageMinutes > ATTRIBUTION_WINDOW_MINUTES) {
    return { eligible: false, reason: 'NO_RECENT_DEPLOYMENT', ageMinutes: round(ageMinutes, 1) };
  }

  return { eligible: true, ageMinutes: round(ageMinutes, 1) };
}

/**
 * Previous task-definition ARN, by decrementing the revision.
 * Null at revision 1, where there is nothing to roll back to.
 */
function previousTaskDefArn(currentArn) {
  const match = /^(.+):(\\d+)$/.exec(currentArn || '');
  if (!match) return null;
  const revision = parseInt(match[2], 10);
  if (revision <= 1) return null;
  return match[1] + ':' + (revision - 1);
}

async function rollbackRollingService(target, service) {
  const currentArn = service.taskDefinition;
  const previousArn = previousTaskDefArn(currentArn);
  if (!previousArn) {
    return { target: target.serviceName, action: 'SKIPPED', reason: 'ALREADY_AT_FIRST_REVISION' };
  }

  await ecs.send(new UpdateServiceCommand({
    cluster: target.clusterName,
    service: target.serviceName,
    taskDefinition: previousArn,
    forceNewDeployment: true,
  }));

  return { target: target.serviceName, action: 'ROLLED_BACK', from: currentArn, to: previousArn };
}

async function rollbackCodeDeployService(target) {
  const { deploymentIds } = await codedeploy.send(new ListDeploymentsCommand({
    applicationName: target.codeDeployApplication,
    deploymentGroupName: target.codeDeployDeploymentGroup,
    includeOnlyStatuses: ['InProgress'],
  }));

  if (!deploymentIds || deploymentIds.length === 0) {
    return { target: target.serviceName, action: 'SKIPPED', reason: 'NO_IN_PROGRESS_DEPLOYMENT' };
  }

  const stopped = [];
  for (const deploymentId of deploymentIds) {
    // Stopping with autoRollbackEnabled is what shifts traffic back to Blue;
    // the deployment group's own rollback configuration does the work.
    await codedeploy.send(new StopDeploymentCommand({ deploymentId, autoRollbackEnabled: true }));
    stopped.push(deploymentId);
  }

  return { target: target.serviceName, action: 'DEPLOYMENT_STOPPED', stoppedDeployments: stopped };
}

async function handleTarget(target, now) {
  // A CodeDeploy-controlled service is not described here at all. Its rollout
  // is owned by CodeDeploy, so the ECS-side deployment state says nothing about
  // it, and the attribution question — is a deployment in flight to roll back —
  // is answered by ListDeployments directly. Calling DescribeServices anyway
  // would add a failure mode to a path that runs during an incident.
  if (target.codeDeployApplication && target.codeDeployDeploymentGroup) {
    return rollbackCodeDeployService(target);
  }

  const described = await ecs.send(new DescribeServicesCommand({
    cluster: target.clusterName,
    services: [target.serviceName],
  }));
  const service = (described.services || [])[0];
  if (!service) {
    return { target: target.serviceName, action: 'SKIPPED', reason: 'SERVICE_NOT_FOUND' };
  }

  const assessment = assessDeployment(service, now);
  if (!assessment.eligible) {
    return {
      target: target.serviceName,
      action: 'SKIPPED',
      reason: assessment.reason,
      deploymentAgeMinutes: assessment.ageMinutes,
    };
  }

  const result = await rollbackRollingService(target, service);
  return Object.assign(result, { deploymentAgeMinutes: assessment.ageMinutes });
}

exports.handler = async (event) => {
  console.log('Burn-rate rollback event:', JSON.stringify(event));

  const detail = event.detail || {};
  const alarmName = detail.alarmName || 'unknown-alarm';
  const policy = POLICIES.find((p) => p.alarmName === alarmName);

  if (!policy) {
    // The event rule only matches rollback policy alarms, so this means the
    // rule and the environment disagree — a deploy landed one and not the
    // other. Rolling back on an alarm whose burn thresholds are unknown is not
    // a decision this handler can make.
    console.error('No rollback policy matches alarm', alarmName);
    return { alarmName, action: 'IGNORED', reason: 'UNKNOWN_ALARM' };
  }

  const now = Date.now();

  // The alarm evaluated the short and long windows; re-reading them here is
  // what makes the notification quote real numbers, and what lets a burn that
  // has already stopped abort the rollback before it touches production.
  const shortWindow = await readWindow(policy.shortWindowMinutes, policy.shortWindowMinutes * 60);
  const longWindow = await readWindow(policy.longWindowMinutes, policy.longWindowMinutes * 60);
  // The SLO window is far too long for a single period, so it is read hourly
  // and summed. 30 days at one hour is 720 datapoints, well inside the
  // GetMetricData limits.
  const sloWindow = await readWindow(SLO_WINDOW_DAYS * 24 * 60, 3600);

  const shortBurn = burnRate(shortWindow);
  const longBurn = burnRate(longWindow);

  // Budget consumed over the whole SLO window: the observed error ratio as a
  // fraction of the ratio the objective allows. Above 1 the budget is spent.
  const budgetConsumed = sloWindow.requests > 0
    ? (sloWindow.errors / sloWindow.requests) / ERROR_BUDGET
    : 0;
  const budgetRemainingPercent = round(Math.max(0, 1 - budgetConsumed) * 100, 2);

  const results = [];
  const errors = [];
  let decision = 'ROLLBACK';

  if (shortBurn <= policy.burnRate) {
    // Between the alarm firing and this invocation the short window fell back
    // under the threshold, so the incident is already over. The long window
    // will stay high for another hour regardless — that is what it is for —
    // and rolling back now would be a deployment during recovery.
    //
    // The comparison mirrors the alarm's GreaterThanThreshold exactly: a burn
    // sitting on the threshold did not fire the alarm, so it does not justify
    // a rollback here either.
    decision = 'ABORTED_BURN_RECOVERED';
  } else {
    for (const target of TARGETS) {
      try {
        const result = await handleTarget(target, now);
        results.push(result);
        console.log('Rollback result:', JSON.stringify(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ target: target.serviceName, error: message });
        console.error('Rollback error for', target.serviceName, ':', message);
      }
    }
  }

  const rolledBack = results.filter((r) => r.action !== 'SKIPPED').map((r) => r.target);
  const skipped = results
    .filter((r) => r.action === 'SKIPPED')
    .map((r) => r.target + ' (' + r.reason + ')');
  const failed = errors.map((e) => e.target + ': ' + e.error);

  const summary = {
    alarmName,
    policy: policy.name,
    decision,
    burnRateThreshold: policy.burnRate,
    shortWindow: {
      minutes: policy.shortWindowMinutes,
      requests: shortWindow.requests,
      errors: shortWindow.errors,
      burnRate: round(shortBurn, 2),
    },
    longWindow: {
      minutes: policy.longWindowMinutes,
      requests: longWindow.requests,
      errors: longWindow.errors,
      burnRate: round(longBurn, 2),
    },
    errorBudget: {
      sloTarget: SLO_TARGET,
      windowDays: SLO_WINDOW_DAYS,
      consumedPercent: round(budgetConsumed * 100, 2),
      remainingPercent: budgetRemainingPercent,
    },
    rolledBack,
    skipped,
    errors: failed,
    // Per-target detail: which revision each service came off, which it went
    // to, and how old the deployment was that the burn was attributed to. The
    // name lists above answer "what happened"; this answers "to what".
    targets: results,
  };

  const lines = [
    'SLO burn-rate alarm: ' + alarmName + ' (' + policy.name + ' burn, threshold ' + policy.burnRate + 'x)',
    'Environment: ' + ENV_NAME,
    'Decision: ' + decision,
    '',
    'Burn rate ' + round(shortBurn, 2) + 'x over ' + policy.shortWindowMinutes + 'm (' +
      shortWindow.errors + '/' + shortWindow.requests + ' requests failed)',
    'Burn rate ' + round(longBurn, 2) + 'x over ' + policy.longWindowMinutes + 'm (' +
      longWindow.errors + '/' + longWindow.requests + ' requests failed)',
    'Error budget: ' + round(budgetConsumed * 100, 2) + '% consumed, ' +
      budgetRemainingPercent + '% remaining of the ' + SLO_WINDOW_DAYS + '-day budget',
    '',
    'Rolled back: ' + (rolledBack.length > 0 ? rolledBack.join(', ') : 'none'),
    'Skipped:     ' + (skipped.length > 0 ? skipped.join('; ') : 'none'),
    'Errors:      ' + (failed.length > 0 ? failed.join('; ') : 'none'),
    '',
    'Details: ' + JSON.stringify(summary, null, 2),
  ];

  try {
    await sns.send(new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Subject: '[' + ENV_NAME.toUpperCase() + '] SLO burn rate ' + policy.name + ': ' + decision,
      Message: lines.join('\\n'),
    }));
  } catch (snsErr) {
    // A failed notification must not swallow a successful rollback, nor mask a
    // failed one — the throw below still happens.
    console.error('SNS publish failed (non-fatal):', snsErr instanceof Error ? snsErr.message : snsErr);
  }

  if (errors.length > 0) {
    throw new Error('Burn-rate rollback errors: ' + failed.join('; '));
  }

  return summary;
};
`;
