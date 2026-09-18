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
import {
  DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT,
  SloDefinition,
  SLO_CATALOGUE,
  SloSeverity,
  assertValidSlo,
  describeMinutes,
  errorBudgetRatio,
  formatObjective,
  policiesFor,
  requireSlo,
  windowFloorEvents,
} from './slo-definitions';

/**
 * Namespace the error-budget metrics are published under.
 *
 * A namespace of this repository's own rather than an `AWS/` one, which is
 * reserved, and a short one because it appears in every alarm and dashboard
 * widget that reads a budget.
 */
export const SLO_METRIC_NAMESPACE = 'SLO';

/** Metric names published by the budget reporter. See {@link SloStack}. */
export const SLO_METRICS = {
  /** Percentage of the error budget still available. Clamped at zero. */
  budgetRemainingPercent: 'ErrorBudgetRemainingPercent',
  /** Percentage of the error budget spent. Not clamped — overspend is visible here. */
  budgetConsumedPercent: 'ErrorBudgetConsumedPercent',
  /** Valid events counted over the SLO window. Zero means the SLI has gone dark. */
  eventsObserved: 'EventsObserved',
  /** Bad events counted over the SLO window. */
  badEvents: 'BadEvents',
} as const;

/**
 * Availability measured at an Application Load Balancer.
 *
 * Valid events are `RequestCount`; bad events are target 5xx plus ELB 5xx.
 * ELB-generated 5xx — 502, 503, 504 — are counted here and nowhere else: they
 * are exactly what a deployment with a broken image or a failing health check
 * produces, the request never reaches a target, so it never appears in the
 * target-scoped metric. An SLI that ignored them would read as perfect while
 * every request failed.
 */
export interface AlbAvailabilitySource {
  readonly kind: 'alb';
  /** `loadBalancerFullName`, e.g. `app/production-alb/1234567890abcdef`. */
  readonly loadBalancerFullName: string;
  /** `targetGroupFullName`, e.g. `targetgroup/production-tg/abcdef1234567890`. */
  readonly targetGroupFullName: string;
}

/**
 * Any SLI expressed as two counts the application already publishes.
 *
 * This is the only shape a latency SLI can take — see docs/slo.md §5. Supply
 * exactly one of `goodMetricName` or `badMetricName`: whichever the emitter
 * actually counts. Deriving bad from good is done as `total - good` clamped at
 * zero, because the two series are published independently and can arrive a
 * datapoint apart.
 */
export interface RatioMetricSource {
  readonly kind: 'ratio';
  readonly namespace: string;
  /** Metric counting every valid event. */
  readonly totalMetricName: string;
  /** Metric counting good events. Mutually exclusive with `badMetricName`. */
  readonly goodMetricName?: string;
  /** Metric counting bad events. Mutually exclusive with `goodMetricName`. */
  readonly badMetricName?: string;
  /** Dimensions shared by both metrics. */
  readonly dimensionsMap: Record<string, string>;
  /** Statistic used to aggregate each metric over a window (default `Sum`). */
  readonly statistic?: string;
}

export type SliMetricSource = AlbAvailabilitySource | RatioMetricSource;

/** A catalogue entry plus the metrics that measure it in this account. */
export interface SloWiring {
  /** `id` of an entry in the catalogue. */
  readonly sloId: string;
  readonly source: SliMetricSource;
}

export interface SloStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging. */
  readonly envName: string;
  /** The objectives this stack measures. */
  readonly slos: readonly SloWiring[];
  /**
   * Catalogue to resolve `sloId` against (default: {@link SLO_CATALOGUE}).
   * Overridden only by tests.
   */
  readonly catalogue?: readonly SloDefinition[];
  /** Email addresses subscribed to the paging topic. */
  readonly pageEmails?: readonly string[];
  /** Email addresses subscribed to the ticket topic. */
  readonly ticketEmails?: readonly string[];
  /**
   * Send `page` severities to the ticket topic instead (default: false).
   *
   * Set on non-production environments. A boilerplate that pages on staging
   * noise gets its alarms muted, and a muted alarm is worse than no alarm — but
   * the policies are still evaluated there, so a change to them is exercised
   * before it reaches the rota.
   */
  readonly downgradePagesToTickets?: boolean;
  /**
   * How often the error-budget reporter runs, in minutes (default: 15).
   *
   * The budget is a slow number — a 30-day window moves by 0.1% an hour — but
   * "how much is left" is a question asked during an incident, in the minutes
   * before someone decides whether to keep rolling out. Fifteen minutes is
   * chosen so the answer quoted in that decision is current, not because the
   * number needs it.
   */
  readonly reportIntervalMinutes?: number;
  /** Reporter timeout in seconds (default: 60). */
  readonly lambdaTimeoutSeconds?: number;
}

/**
 * SNS alarm action.
 *
 * `aws-cdk-lib/aws-cloudwatch-actions` exists for exactly this, but importing it
 * for one topic pulls a second copy of the CloudWatch action bindings into every
 * consumer of this file. The interface is two lines.
 */
class SnsAlarmAction implements cloudwatch.IAlarmAction {
  constructor(private readonly topic: sns.ITopic) {}

  bind(): cloudwatch.AlarmActionConfig {
    return { alarmActionArn: this.topic.topicArn };
  }
}

/**
 * Metric-math ids must be unique across every metric in one alarm or graph
 * widget, and CDK flattens nested expressions into that single namespace — so
 * two policies graphed together cannot both call their denominator `valid`.
 * Ids must also match `^[a-z][a-zA-Z0-9_]*$`, which kebab-case policy names do
 * not.
 */
const idSuffix = (...parts: string[]): string =>
  `_${parts.join('_')}`.replace(/[^a-zA-Z0-9_]/g, '_');

/** `production-api-availability` → `ProductionApiAvailability`, for construct ids. */
const pascalCase = (value: string): string =>
  value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

/** Normalised reporter input for one objective. Shape shared with the handler. */
interface ReporterSpec {
  readonly id: string;
  readonly service: string;
  readonly envName: string;
  readonly objective: number;
  readonly windowDays: number;
  readonly errorBudget: number;
  readonly namespace: string;
  readonly dimensions: Record<string, string>;
  readonly statistic: string;
  readonly totalMetricName: string;
  /** Summed to produce the bad-event count. Empty when `goodMetricName` is set. */
  readonly badMetricNames: readonly string[];
  /** When set, bad events are `total - good`, clamped at zero. */
  readonly goodMetricName?: string;
}

/**
 * The SLO surface: burn-rate alerts, error-budget reporting, and a dashboard,
 * built from the catalogue in `lib/slo-definitions.ts`.
 *
 * Three signals, because each one is blind to what the others see:
 *
 *   Burn-rate alarms answer "is this costing more reliability than the objective
 *   affords, right now". Multi-window, so a five-minute blip does not page and a
 *   recovered service stops paging. They are the fast signal and they are
 *   structurally incapable of seeing slow drift: a month of regressions, each an
 *   hour long and none crossing a threshold, spends the whole budget without one
 *   of these alarms ever firing.
 *
 *   The error-budget reporter answers "how much is left". That number cannot be
 *   an alarm on its own: a CloudWatch alarm evaluates at most a 24-hour period
 *   and an SLO window is 30 days, so the window is read with `GetMetricData` on
 *   a schedule and republished as `ErrorBudgetRemainingPercent`, which *can* be
 *   alarmed on. It is also the number that belongs in a release decision, and
 *   the reason it is a metric rather than a report is so that decision can be
 *   automated later.
 *
 *   The no-data alarm answers "is any of this still true". Every other signal
 *   here degrades quietly to green when the metric pipeline stops: a burn rate
 *   over zero requests is zero, and a budget over zero requests is untouched.
 *   A service nobody is calling and a service nobody is measuring look
 *   identical from the outside, so absence is alarmed on explicitly and is the
 *   one alarm in this stack that treats missing data as breaching.
 *
 * Architecture:
 *
 *   SLI metrics (ALB, or any good/valid pair)
 *     ├─ metric math: bad / valid / errorBudget, floored on traffic
 *     │    → long-window alarm ┐
 *     │    → short-window alarm┴→ composite alarm (AND) → SNS (page | ticket)
 *     └─ EventBridge schedule → reporter Lambda
 *          ├─ GetMetricData over the whole SLO window at a 1h period
 *          ├─ PutMetricData: budget remaining, budget consumed, events, bad events
 *          └─ alarms: budget low → ticket, budget exhausted → page, no data → ticket
 *
 * Relationship to `SloBurnRateRollbackStack`: that stack is an actuator and this
 * one is the alerting and reporting surface. Both compute a burn rate from the
 * same objective — `bin/app.ts` hands both the same catalogue entry — but they
 * use different traffic floors on purpose. A rollback mutates production, so it
 * takes the conservative floor from `significanceFloorEvents()` and fails by
 * doing nothing; an alert wakes a human, so it takes the SLI's declared floor
 * and fails by being answered.
 */
export class SloStack extends cdk.Stack {
  public readonly pageTopic: sns.Topic;
  public readonly ticketTopic: sns.Topic;
  /** Composite burn-rate alarms, in `slos` × `policies` order. */
  public readonly burnRateAlarms: cloudwatch.CompositeAlarm[];
  public readonly budgetReporter: lambda.Function;
  public readonly reportSchedule: events.Rule;
  public readonly dashboard: cloudwatch.Dashboard;
  /** Resolved catalogue entries, in `slos` order. */
  public readonly definitions: readonly SloDefinition[];

  constructor(scope: Construct, id: string, props: SloStackProps) {
    super(scope, id, props);

    const envName = props.envName;
    const catalogue = props.catalogue ?? SLO_CATALOGUE;
    const reportIntervalMinutes = props.reportIntervalMinutes ?? 15;
    const lambdaTimeoutSeconds = props.lambdaTimeoutSeconds ?? 60;
    const downgrade = props.downgradePagesToTickets ?? false;

    if (props.slos.length === 0) {
      throw new Error(`SloStack ${id}: slos must contain at least one objective.`);
    }
    if (reportIntervalMinutes < 1 || !Number.isInteger(reportIntervalMinutes)) {
      throw new Error(
        `SloStack ${id}: reportIntervalMinutes must be a positive whole number (got ${reportIntervalMinutes}).`,
      );
    }

    const seenIds = new Set<string>();
    this.definitions = props.slos.map((wiring) => {
      if (seenIds.has(wiring.sloId)) {
        throw new Error(`SloStack ${id}: SLO '${wiring.sloId}' is wired twice.`);
      }
      seenIds.add(wiring.sloId);

      const slo = requireSlo(wiring.sloId, catalogue);
      assertValidSlo(slo);

      if (slo.status !== 'active') {
        throw new Error(
          `SloStack ${id}: SLO '${slo.id}' has status '${slo.status}' and must not be wired. ` +
            `Its alarms would sit in INSUFFICIENT_DATA over a metric nothing publishes` +
            (slo.blockedOn ? `: ${slo.blockedOn}` : '.'),
        );
      }

      // An objective names its environment, and a stack wiring another
      // environment's objective would alarm on the wrong traffic under the right
      // alarm name — a mistake with no symptom until someone trusts the number.
      if (slo.envName !== envName) {
        throw new Error(
          `SloStack ${id}: SLO '${slo.id}' is defined for environment '${slo.envName}' but this stack is ` +
            `'${envName}'.`,
        );
      }

      assertSourceMatchesSli(id, slo, wiring.source);

      return slo;
    });

    // ── Encryption key for the reporter's logs and configuration ──────────────
    const encryptionKey = new kms.Key(this, 'SloEncryptionKey', {
      alias: `alias/${envName}-slo`,
      description: `Encrypts ${envName} SLO reporter logs and Lambda configuration`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Notification topics ───────────────────────────────────────────────────
    // Two topics rather than one with a filter policy: the subscribers differ —
    // a pager integration and a ticket queue — and a filter policy that stops
    // matching sends everything to everyone or to nobody, silently.
    const managedSnsKey = kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns');

    this.pageTopic = new sns.Topic(this, 'SloPageTopic', {
      topicName: `${envName}-slo-page`,
      displayName: `${envName} SLO paging alerts`,
      masterKey: managedSnsKey,
    });
    this.ticketTopic = new sns.Topic(this, 'SloTicketTopic', {
      topicName: `${envName}-slo-ticket`,
      displayName: `${envName} SLO ticket alerts`,
      masterKey: managedSnsKey,
    });

    for (const email of props.pageEmails ?? []) {
      this.pageTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }
    for (const email of props.ticketEmails ?? []) {
      this.ticketTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    const topicFor = (severity: SloSeverity): sns.Topic =>
      severity === 'page' && !downgrade ? this.pageTopic : this.ticketTopic;

    // ── Burn-rate alarms ──────────────────────────────────────────────────────
    this.burnRateAlarms = [];
    const burnRateMetrics = new Map<string, cloudwatch.MathExpression[]>();

    this.definitions.forEach((slo, index) => {
      const source = props.slos[index].source;
      const budget = errorBudgetRatio(slo);
      const perSloMetrics: cloudwatch.MathExpression[] = [];

      const burnRate = (
        windowMinutesValue: number,
        label: string,
        ...ids: string[]
      ): cloudwatch.MathExpression =>
        burnRateExpression({
          source,
          windowMinutes: windowMinutesValue,
          floorEvents: windowFloorEvents(slo, windowMinutesValue),
          errorBudget: budget,
          label,
          ids: idSuffix(...ids),
        });

      for (const policy of policiesFor(slo)) {
        const windowAlarm = (minutes: number, suffix: 'Long' | 'Short'): cloudwatch.Alarm =>
          new cloudwatch.Alarm(
            this,
            `${pascalCase(slo.id)}${pascalCase(policy.name)}${suffix}Alarm`,
            {
              alarmName: `${slo.id}-burn-${policy.name}-${suffix.toLowerCase()}`,
              alarmDescription:
                `${slo.description}. Error budget burning at more than ${policy.burnRate}x over ` +
                `${describeMinutes(minutes)} against ${formatObjective(slo.objective)} over ` +
                `${slo.windowDays} days. ${policy.description}. Owner: ${slo.owner}. ` +
                `Runbook: ${slo.runbookUrl}`,
              metric: burnRate(minutes, `${policy.name} ${suffix.toLowerCase()}`, policy.name, suffix),
              threshold: policy.burnRate,
              evaluationPeriods: 1,
              comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
              // A window below its traffic floor already evaluates to a burn rate
              // of zero, so missing data here means the metric stopped arriving.
              // That is a monitoring failure, not a breach, and the no-data alarm
              // below is what reports it — paging on it from here would make an
              // outage of CloudWatch into an outage of the service.
              treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            },
          );

        const longAlarm = windowAlarm(policy.longWindowMinutes, 'Long');
        const shortAlarm = windowAlarm(policy.shortWindowMinutes, 'Short');

        const composite = new cloudwatch.CompositeAlarm(
          this,
          `${pascalCase(slo.id)}${pascalCase(policy.name)}Composite`,
          {
            compositeAlarmName: `${slo.id}-burn-${policy.name}`,
            alarmDescription:
              `${policy.name} burn on ${slo.id}: more than ${policy.burnRate}x over ` +
              `${describeMinutes(policy.longWindowMinutes)} and still burning over the last ` +
              `${describeMinutes(policy.shortWindowMinutes)}. ` +
              `${policy.severity === 'page' && !downgrade ? 'Pages' : 'Raises a ticket'}. ` +
              `Owner: ${slo.owner}. Runbook: ${slo.runbookUrl}`,
            alarmRule: cloudwatch.AlarmRule.allOf(
              cloudwatch.AlarmRule.fromAlarm(longAlarm, cloudwatch.AlarmState.ALARM),
              cloudwatch.AlarmRule.fromAlarm(shortAlarm, cloudwatch.AlarmState.ALARM),
            ),
            actionsEnabled: true,
          },
        );
        composite.addAlarmAction(new SnsAlarmAction(topicFor(policy.severity)));

        this.burnRateAlarms.push(composite);
        perSloMetrics.push(
          burnRate(policy.longWindowMinutes, `${policy.name} long`, policy.name, 'long'),
        );
      }

      burnRateMetrics.set(slo.id, perSloMetrics);
    });

    // ── Error-budget reporter ─────────────────────────────────────────────────
    const specs: ReporterSpec[] = this.definitions.map((slo, index) =>
      reporterSpec(slo, props.slos[index].source),
    );

    const logGroup = new logs.LogGroup(this, 'SloReporterLogGroup', {
      logGroupName: `/aws/lambda/${envName}-slo-budget-reporter`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const reporterRole = new iam.Role(this, 'SloReporterRole', {
      roleName: `${envName}-slo-budget-reporter-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Reads ${envName} SLI metrics and republishes error-budget consumption`,
    });
    reporterRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    // Neither call is resource-scopable: metrics are not resources, so
    // cloudwatch:GetMetricData and cloudwatch:PutMetricData take no ARN. The
    // wildcard is imposed by the API rather than chosen. PutMetricData is
    // narrowed by condition instead, to the one namespace this function writes —
    // without it the role could overwrite any metric in the account, including
    // the AWS/* series other alarms read.
    reporterRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadSliMetrics',
        actions: ['cloudwatch:GetMetricData'],
        resources: ['*'],
      }),
    );
    reporterRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishErrorBudgetMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': SLO_METRIC_NAMESPACE },
        },
      }),
    );

    this.budgetReporter = new lambda.Function(this, 'SloBudgetReporter', {
      functionName: `${envName}-slo-budget-reporter`,
      description: `Republishes ${envName} error-budget consumption as CloudWatch metrics`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: reporterRole,
      timeout: cdk.Duration.seconds(lambdaTimeoutSeconds),
      // One at a time. The function is idempotent — it recomputes a rolling
      // window and republishes it — so a concurrent second copy adds nothing
      // but a duplicate datapoint at the same timestamp, which CloudWatch
      // resolves by taking whichever arrived last.
      reservedConcurrentExecutions: 1,
      environmentEncryption: encryptionKey,
      logGroup,
      environment: {
        SLO_SPECS: JSON.stringify(specs),
        METRIC_NAMESPACE: SLO_METRIC_NAMESPACE,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(SLO_BUDGET_REPORTER_SOURCE),
    });

    // Recorded on the resource rather than in `.checkov.baseline` so the
    // reasoning travels with the resource into whatever account this is copied
    // to.
    (this.budgetReporter.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_116',
          comment:
            'No DLQ: the invocation is a schedule, not a message. A run that failed is ' +
            'superseded by the next one fifteen minutes later over the same rolling window, ' +
            'so a replayed event would republish a stale budget. Failures surface as the ' +
            'Errors alarm and as the no-data alarm on EventsObserved.',
        },
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler calls only the regional CloudWatch API and touches no ' +
            'VPC resource. Attaching it would require a NAT gateway or an interface endpoint ' +
            'to reach that API, adding cost and a failure mode to the path that reports how ' +
            'much error budget is left during an incident.',
        },
      ],
    });

    this.reportSchedule = new events.Rule(this, 'SloReportSchedule', {
      ruleName: `${envName}-slo-budget-report`,
      description: `Runs the ${envName} error-budget reporter every ${reportIntervalMinutes} minutes`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(reportIntervalMinutes)),
    });
    this.reportSchedule.addTarget(
      // Two retries and then the next schedule tick. Retrying harder would
      // republish an increasingly stale window.
      new events_targets.LambdaFunction(this.budgetReporter, { retryAttempts: 2 }),
    );

    // ── Error-budget alarms ───────────────────────────────────────────────────
    // Period is one hour against a reporter that runs every fifteen minutes, so
    // an hour with no datapoint means four consecutive failures rather than one
    // late publish. The statistic matters: the reporter republishes the same
    // rolling window several times an hour, so `Sum` would multiply it —
    // `Minimum` on what is left and `Maximum` on what is gone both take the
    // worst view of the hour.
    const budgetPeriod = cdk.Duration.hours(1);

    for (const slo of this.definitions) {
      const dimensions = {
        Slo: slo.id,
        Service: slo.service,
        Environment: slo.envName,
      };
      const budgetMetric = (metricName: string, statistic: string): cloudwatch.Metric =>
        new cloudwatch.Metric({
          namespace: SLO_METRIC_NAMESPACE,
          metricName,
          dimensionsMap: dimensions,
          statistic,
          period: budgetPeriod,
        });

      const threshold = slo.budgetAlertThresholdPercent ?? DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT;

      const budgetLow = new cloudwatch.Alarm(this, `${pascalCase(slo.id)}BudgetLowAlarm`, {
        alarmName: `${slo.id}-budget-low`,
        alarmDescription:
          `Less than ${threshold}% of the ${slo.windowDays}-day error budget for ${slo.id} is left. ` +
          `This is the signal burn-rate alarms cannot produce: a month of small regressions, none of ` +
          `them crossing a burn threshold, spends the budget exactly like one outage does. ` +
          `Owner: ${slo.owner}. Runbook: ${slo.runbookUrl}`,
        metric: budgetMetric(SLO_METRICS.budgetRemainingPercent, 'Minimum'),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        // Absence is the no-data alarm's job. Treating it as breaching here too
        // would report one dead reporter as three incidents.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      budgetLow.addAlarmAction(new SnsAlarmAction(topicFor('ticket')));

      const budgetExhausted = new cloudwatch.Alarm(
        this,
        `${pascalCase(slo.id)}BudgetExhaustedAlarm`,
        {
          alarmName: `${slo.id}-budget-exhausted`,
          alarmDescription:
            `The ${slo.windowDays}-day error budget for ${slo.id} is spent: the service is now below ` +
            `${formatObjective(slo.objective)} over the window it promised. Owner: ${slo.owner}. ` +
            `Runbook: ${slo.runbookUrl}`,
          metric: budgetMetric(SLO_METRICS.budgetRemainingPercent, 'Minimum'),
          threshold: 0,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        },
      );
      budgetExhausted.addAlarmAction(new SnsAlarmAction(topicFor('page')));

      // The one alarm here that treats missing data as breaching. Every other
      // signal in this stack degrades to green when the SLI stops arriving.
      const noData = new cloudwatch.Alarm(this, `${pascalCase(slo.id)}NoDataAlarm`, {
        alarmName: `${slo.id}-no-data`,
        alarmDescription:
          `No valid events counted for ${slo.id} in the last hour, or the error-budget reporter has ` +
          `stopped publishing. Both make every other SLO alarm on this objective read as healthy: a ` +
          `burn rate over zero requests is zero and an untouched budget is a full one. ` +
          `Owner: ${slo.owner}. Runbook: ${slo.runbookUrl}`,
        metric: budgetMetric(SLO_METRICS.eventsObserved, 'Maximum'),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      noData.addAlarmAction(new SnsAlarmAction(topicFor('ticket')));
    }

    // A reporter that throws on one objective and succeeds on the others leaves
    // no gap the no-data alarms can see, because the metrics they read are still
    // being published for everything else.
    const reporterErrors = new cloudwatch.Alarm(this, 'SloReporterErrorsAlarm', {
      alarmName: `${envName}-slo-budget-reporter-errors`,
      alarmDescription:
        `The ${envName} error-budget reporter is failing. While it is down, every budget alarm in ` +
        `this stack is evaluating a stale datapoint.`,
      metric: this.budgetReporter.metricErrors({
        period: budgetPeriod,
        statistic: 'Sum',
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    reporterErrors.addAlarmAction(new SnsAlarmAction(topicFor('ticket')));

    // ── Dashboard ─────────────────────────────────────────────────────────────
    this.dashboard = new cloudwatch.Dashboard(this, 'SloDashboard', {
      dashboardName: `${envName}-slo`,
      defaultInterval: cdk.Duration.days(7),
    });

    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: catalogueMarkdown(envName, this.definitions),
        width: 24,
        height: 2 + this.definitions.length,
      }),
    );

    this.dashboard.addWidgets(
      ...this.definitions.map(
        (slo) =>
          new cloudwatch.SingleValueWidget({
            title: `${slo.id} — budget left (${slo.windowDays}d)`,
            metrics: [
              new cloudwatch.Metric({
                namespace: SLO_METRIC_NAMESPACE,
                metricName: SLO_METRICS.budgetRemainingPercent,
                dimensionsMap: {
                  Slo: slo.id,
                  Service: slo.service,
                  Environment: slo.envName,
                },
                statistic: 'Minimum',
                period: cdk.Duration.hours(1),
                label: 'Budget remaining',
              }),
            ],
            width: Math.max(6, Math.floor(24 / Math.max(1, this.definitions.length))),
            height: 4,
          }),
      ),
    );

    for (const slo of this.definitions) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${slo.id} — burn rate by policy`,
          left: burnRateMetrics.get(slo.id) ?? [],
          leftAnnotations: policiesFor(slo).map((policy) => ({
            value: policy.burnRate,
            label: `${policy.name} ${policy.burnRate}x`,
            color: policy.severity === 'page' ? cloudwatch.Color.RED : cloudwatch.Color.ORANGE,
          })),
          width: 12,
          height: 6,
        }),
        new cloudwatch.GraphWidget({
          title: `${slo.id} — error budget consumed (%)`,
          left: [
            new cloudwatch.Metric({
              namespace: SLO_METRIC_NAMESPACE,
              metricName: SLO_METRICS.budgetConsumedPercent,
              dimensionsMap: {
                Slo: slo.id,
                Service: slo.service,
                Environment: slo.envName,
              },
              statistic: 'Maximum',
              period: cdk.Duration.hours(1),
              label: 'Consumed',
            }),
          ],
          leftAnnotations: [
            { value: 100, label: 'budget exhausted', color: cloudwatch.Color.RED },
            {
              value: 100 - (slo.budgetAlertThresholdPercent ?? DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT),
              label: 'ticket raised',
              color: cloudwatch.Color.ORANGE,
            },
          ],
          // Valid and bad event counts on the right axis, because the first
          // question about any budget number is how much traffic produced it.
          right: [
            new cloudwatch.Metric({
              namespace: SLO_METRIC_NAMESPACE,
              metricName: SLO_METRICS.eventsObserved,
              dimensionsMap: {
                Slo: slo.id,
                Service: slo.service,
                Environment: slo.envName,
              },
              statistic: 'Maximum',
              period: cdk.Duration.hours(1),
              label: 'Valid events in window',
            }),
            new cloudwatch.Metric({
              namespace: SLO_METRIC_NAMESPACE,
              metricName: SLO_METRICS.badEvents,
              dimensionsMap: {
                Slo: slo.id,
                Service: slo.service,
                Environment: slo.envName,
              },
              statistic: 'Maximum',
              period: cdk.Duration.hours(1),
              label: 'Bad events in window',
            }),
          ],
          width: 12,
          height: 6,
        }),
      );
    }

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SloPageTopicArn', {
      value: this.pageTopic.topicArn,
      description: 'SNS topic ARN for SLO alerts that page',
      exportName: `${envName}-slo-page-topic-arn`,
    });

    new cdk.CfnOutput(this, 'SloTicketTopicArn', {
      value: this.ticketTopic.topicArn,
      description: 'SNS topic ARN for SLO alerts that raise a ticket',
      exportName: `${envName}-slo-ticket-topic-arn`,
    });

    new cdk.CfnOutput(this, 'SloBurnRateAlarmNames', {
      // The configured names rather than `alarm.alarmName`, which is a Ref that
      // resolves only at deploy time. An output whose purpose is to be copied
      // into a CodeDeploy deployment group's alarm configuration should be
      // readable.
      value: this.definitions
        .flatMap((slo) => policiesFor(slo).map((policy) => `${slo.id}-burn-${policy.name}`))
        .join(','),
      description:
        'Composite burn-rate alarm names — usable as CodeDeploy deployment alarms to abort a shift mid-flight',
      exportName: `${envName}-slo-burn-alarm-names`,
    });

    new cdk.CfnOutput(this, 'SloObjectives', {
      value: this.definitions
        .map((slo) => `${slo.id}=${formatObjective(slo.objective)}/${slo.windowDays}d`)
        .join(','),
      description: 'The objectives this stack measures',
      exportName: `${envName}-slo-objectives`,
    });
  }
}

/**
 * Reject a source that cannot measure the SLI it is wired to.
 *
 * The latency case is the one worth the error message: ALB publishes
 * `TargetResponseTime` and no count of requests under a threshold, and
 * CloudWatch cannot aggregate a percentile over a window, so there is no ratio
 * to divide by an error budget. An `alb` source on a latency SLI is not a
 * missing feature, it is a category error, and the shape it would otherwise take
 * — an alarm on `p99 > threshold` — reads in review exactly like a latency SLO.
 */
const assertSourceMatchesSli = (
  stackId: string,
  slo: SloDefinition,
  source: SliMetricSource,
): void => {
  if (source.kind === 'alb') {
    if (slo.sli.kind !== 'availability') {
      throw new Error(
        `SloStack ${stackId}: SLO '${slo.id}' has a '${slo.sli.kind}' SLI and cannot use an 'alb' source. ` +
          `ALB publishes no count of requests under a latency threshold, and a TargetResponseTime ` +
          `percentile cannot be aggregated over a window into one, so no burn rate can be computed from ` +
          `it. Emit good and valid counts from the application and use a 'ratio' source — see ` +
          `docs/slo.md §5.`,
      );
    }
    return;
  }

  const hasGood = source.goodMetricName !== undefined;
  const hasBad = source.badMetricName !== undefined;
  if (hasGood === hasBad) {
    throw new Error(
      `SloStack ${stackId}: SLO '${slo.id}' ratio source must set exactly one of goodMetricName or ` +
        `badMetricName (got ${hasGood && hasBad ? 'both' : 'neither'}).`,
    );
  }
  if (Object.keys(source.dimensionsMap).length === 0) {
    throw new Error(
      `SloStack ${stackId}: SLO '${slo.id}' ratio source has no dimensions. An undimensioned metric in a ` +
        `shared namespace aggregates every service that publishes it, so the SLI would measure the whole ` +
        `account.`,
    );
  }
};

/** Normalise a wiring into the flat shape the reporter handler reads. */
const reporterSpec = (slo: SloDefinition, source: SliMetricSource): ReporterSpec => {
  const common = {
    id: slo.id,
    service: slo.service,
    envName: slo.envName,
    objective: slo.objective,
    windowDays: slo.windowDays,
    errorBudget: errorBudgetRatio(slo),
  };

  if (source.kind === 'alb') {
    return {
      ...common,
      namespace: 'AWS/ApplicationELB',
      dimensions: {
        LoadBalancer: source.loadBalancerFullName,
        TargetGroup: source.targetGroupFullName,
      },
      statistic: 'Sum',
      totalMetricName: 'RequestCount',
      badMetricNames: ['HTTPCode_Target_5XX_Count', 'HTTPCode_ELB_5XX_Count'],
    };
  }

  return {
    ...common,
    namespace: source.namespace,
    dimensions: source.dimensionsMap,
    statistic: source.statistic ?? 'Sum',
    totalMetricName: source.totalMetricName,
    badMetricNames: source.badMetricName ? [source.badMetricName] : [],
    ...(source.goodMetricName ? { goodMetricName: source.goodMetricName } : {}),
  };
};

/**
 * Burn rate over `windowMinutes`, as a CloudWatch metric-math expression.
 *
 * Written as named sub-expressions rather than one line so the alarm's graph in
 * the console shows the valid-event count and the bad-event count that produced
 * the ratio. When an on-call engineer opens an alert at 03:00, the first question
 * is always how much traffic it was measured on.
 */
const burnRateExpression = (args: {
  source: SliMetricSource;
  windowMinutes: number;
  floorEvents: number;
  errorBudget: number;
  label: string;
  /** Appended to every metric-math id — see {@link idSuffix}. */
  ids: string;
}): cloudwatch.MathExpression => {
  const { source, windowMinutes: minutes, floorEvents, errorBudget, label, ids } = args;
  const period = cdk.Duration.minutes(minutes);

  const metric = (namespace: string, metricName: string, statistic: string, dims: Record<string, string>) =>
    new cloudwatch.Metric({ namespace, metricName, dimensionsMap: dims, statistic });

  let valid: cloudwatch.MathExpression;
  let bad: cloudwatch.MathExpression;

  if (source.kind === 'alb') {
    const dims = {
      LoadBalancer: source.loadBalancerFullName,
      TargetGroup: source.targetGroupFullName,
    };
    valid = new cloudwatch.MathExpression({
      // A target group with no traffic publishes no `RequestCount` datapoint at
      // all rather than a zero, so every input is filled before use.
      expression: `FILL(rc${ids}, 0)`,
      usingMetrics: { [`rc${ids}`]: metric('AWS/ApplicationELB', 'RequestCount', 'Sum', dims) },
      period,
      label: `Valid events (${label})`,
    });
    bad = new cloudwatch.MathExpression({
      expression: `FILL(t5${ids}, 0) + FILL(e5${ids}, 0)`,
      usingMetrics: {
        [`t5${ids}`]: metric('AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', 'Sum', dims),
        [`e5${ids}`]: metric('AWS/ApplicationELB', 'HTTPCode_ELB_5XX_Count', 'Sum', dims),
      },
      period,
      label: `Bad events (${label})`,
    });
  } else {
    const statistic = source.statistic ?? 'Sum';
    const totalMetric = metric(
      source.namespace,
      source.totalMetricName,
      statistic,
      source.dimensionsMap,
    );
    valid = new cloudwatch.MathExpression({
      expression: `FILL(tot${ids}, 0)`,
      usingMetrics: { [`tot${ids}`]: totalMetric },
      period,
      label: `Valid events (${label})`,
    });
    bad =
      source.badMetricName !== undefined
        ? new cloudwatch.MathExpression({
            // `rawbad`, not `bad`: the outer burn-rate expression binds its own
            // `bad` id to this whole sub-expression, and CDK flattens both into
            // one id namespace per alarm — reusing the name is a synth-time
            // DuplicateMetricId, which is the good outcome, but only because
            // nothing else would have noticed.
            expression: `FILL(rawbad${ids}, 0)`,
            usingMetrics: {
              [`rawbad${ids}`]: metric(
                source.namespace,
                source.badMetricName,
                statistic,
                source.dimensionsMap,
              ),
            },
            period,
            label: `Bad events (${label})`,
          })
        : new cloudwatch.MathExpression({
            // Good and valid are published independently and can arrive a
            // datapoint apart, so the subtraction is clamped. `IF` is the only
            // element-wise clamp metric math has: `MAX` reduces a series to a
            // scalar, so `MAX(tot - good, 0)` would compare the whole window
            // against zero and return one number.
            expression: `IF(tot${ids} - good${ids} > 0, tot${ids} - good${ids}, 0)`,
            usingMetrics: {
              [`tot${ids}`]: totalMetric,
              [`good${ids}`]: metric(
                source.namespace,
                source.goodMetricName as string,
                statistic,
                source.dimensionsMap,
              ),
            },
            period,
            label: `Bad events (${label})`,
          });
  }

  return new cloudwatch.MathExpression({
    // The denominator is guarded independently of the traffic floor. `IF` is
    // evaluated element-wise over both branches, so a window with zero events
    // would divide by zero inside the branch that is about to be discarded, and
    // CloudWatch returns no data for that datapoint instead of the zero the
    // floor intends.
    expression:
      `IF(valid${ids} >= ${floorEvents}, bad${ids} / IF(valid${ids} > 0, valid${ids}, 1) / ${errorBudget}, 0)`,
    usingMetrics: { [`valid${ids}`]: valid, [`bad${ids}`]: bad },
    period,
    label: `Burn rate (${label})`,
  });
};

/** The dashboard's header: the catalogue, as the dashboard's reader needs it. */
const catalogueMarkdown = (envName: string, definitions: readonly SloDefinition[]): string => {
  const rows = definitions
    .map(
      (slo) =>
        `| ${slo.id} | ${slo.sli.kind} | ${formatObjective(slo.objective)} | ${slo.windowDays}d | ` +
        `${slo.owner} | [runbook](${slo.runbookUrl}) |`,
    )
    .join('\n');

  return (
    `## ${envName} service level objectives\n\n` +
    `Budget left is a rolling window republished by \`${envName}-slo-budget-reporter\`; ` +
    `burn rate is computed from the SLI directly.\n\n` +
    '| SLO | SLI | Objective | Window | Owner | Runbook |\n' +
    '| --- | --- | --- | --- | --- | --- |\n' +
    rows
  );
};

/**
 * The error-budget reporter, shipped inline.
 *
 * Exported as a string so `test/slo-budget-reporter-handler.test.ts` can compile
 * and run it: `lambda.Code.fromInline` means nothing else in the build ever
 * parses it, so an inverted comparison in here would first surface as a budget
 * that reads full through an outage.
 */
export const SLO_BUDGET_REPORTER_SOURCE = `
'use strict';
const {
  CloudWatchClient,
  GetMetricDataCommand,
  PutMetricDataCommand,
} = require('@aws-sdk/client-cloudwatch');

const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });

const SPECS = JSON.parse(process.env.SLO_SPECS);
const NAMESPACE = process.env.METRIC_NAMESPACE;

/** The whole SLO window is read at a one-hour period. */
const PERIOD_SECONDS = 3600;

const round = (value, places) => {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
};

const sum = (values) => values.reduce((a, b) => a + b, 0);

const dimensionList = (dimensions) =>
  Object.keys(dimensions).map((name) => ({ Name: name, Value: dimensions[name] }));

/**
 * Read every metric a spec needs over its whole window.
 *
 * One GetMetricData call per objective rather than one for all of them: a spec
 * whose metrics have been renamed then fails on its own instead of taking every
 * other budget's datapoint down with it.
 *
 * NextToken is followed. Nothing here is near the 100,800-value response limit —
 * a 30-day window at a one-hour period is 720 values per metric — but a query
 * that starts paginating silently returns a truncated window, and a truncated
 * window reports a budget that has been spent less than it has.
 */
async function readWindow(spec) {
  const names = [spec.totalMetricName]
    .concat(spec.badMetricNames)
    .concat(spec.goodMetricName ? [spec.goodMetricName] : []);

  const queries = names.map((metricName, index) => ({
    Id: 'm' + index,
    MetricStat: {
      Metric: {
        Namespace: spec.namespace,
        MetricName: metricName,
        Dimensions: dimensionList(spec.dimensions),
      },
      Period: PERIOD_SECONDS,
      Stat: spec.statistic,
    },
    ReturnData: true,
  }));

  const endTime = new Date(Math.floor(Date.now() / 60000) * 60000);
  const startTime = new Date(endTime.getTime() - spec.windowDays * 24 * 60 * 60 * 1000);

  const totals = {};
  for (const query of queries) totals[query.Id] = 0;

  let nextToken;
  let pages = 0;
  do {
    const response = await cloudwatch.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: startTime,
        EndTime: endTime,
        ScanBy: 'TimestampDescending',
        NextToken: nextToken,
      }),
    );

    for (const result of response.MetricDataResults || []) {
      if (totals[result.Id] === undefined) continue;
      totals[result.Id] += sum(result.Values || []);
    }

    nextToken = response.NextToken;
    pages += 1;
    // A token that never clears would loop until the function times out, which
    // looks like a reporter that has stopped rather than one that is wrong.
    if (pages > 50) {
      throw new Error('GetMetricData paginated more than 50 pages for ' + spec.id);
    }
  } while (nextToken);

  const valid = totals.m0;
  let bad;
  if (spec.goodMetricName) {
    // The good count is the last query. Good and valid arrive independently, so
    // the subtraction is clamped: a good count momentarily ahead of the valid
    // count would otherwise report negative bad events and a budget above 100%.
    const good = totals['m' + (queries.length - 1)];
    bad = Math.max(valid - good, 0);
  } else {
    bad = sum(spec.badMetricNames.map((_, index) => totals['m' + (index + 1)]));
  }

  // Bad is bounded by valid because an error ratio above 1 is not a worse
  // outage, it is two counts drawn from different populations — a bad-event
  // metric published with different dimensions, or a statistic other than Sum on
  // one of the pair. Neither number is trustworthy then, and the bound at least
  // keeps the reported budget inside its own scale.
  return { valid: valid, bad: Math.min(bad, valid) };
}

/** Datapoints for one objective, or only the traffic count when there is none. */
function datapointsFor(spec, reading, timestamp) {
  const dimensions = dimensionList({
    Slo: spec.id,
    Service: spec.service,
    Environment: spec.envName,
  });
  const datum = (metricName, value, unit) => ({
    MetricName: metricName,
    Dimensions: dimensions,
    Timestamp: timestamp,
    Value: value,
    Unit: unit,
  });

  const data = [
    datum('${SLO_METRICS.eventsObserved}', reading.valid, 'Count'),
    datum('${SLO_METRICS.badEvents}', reading.bad, 'Count'),
  ];

  // A window with no valid events has no error ratio. Publishing 100% remaining
  // for it would make a dead metric pipeline and a perfect month identical, and
  // the budget alarms would be green for both — which is why EventsObserved is
  // published unconditionally and alarmed on separately.
  if (reading.valid <= 0) return data;

  const errorRatio = reading.bad / reading.valid;
  const consumedPercent = (errorRatio / spec.errorBudget) * 100;

  data.push(datum('${SLO_METRICS.budgetConsumedPercent}', round(consumedPercent, 4), 'Percent'));
  // Clamped, because a CloudWatch Percent metric below zero renders as an axis
  // nobody can read, and because the alarm on it only asks whether anything is
  // left. Overspend stays visible on the unclamped consumed metric above.
  data.push(
    datum('${SLO_METRICS.budgetRemainingPercent}', round(Math.max(100 - consumedPercent, 0), 4), 'Percent'),
  );

  return data;
}

exports.handler = async () => {
  const timestamp = new Date();
  const reported = [];
  const failures = [];

  for (const spec of SPECS) {
    try {
      const reading = await readWindow(spec);
      const data = datapointsFor(spec, reading, timestamp);

      await cloudwatch.send(
        new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: data }),
      );

      const errorRatio = reading.valid > 0 ? reading.bad / reading.valid : null;
      reported.push({
        slo: spec.id,
        validEvents: reading.valid,
        badEvents: reading.bad,
        errorRatio: errorRatio === null ? null : round(errorRatio, 6),
        budgetRemainingPercent:
          errorRatio === null
            ? null
            : round(Math.max(100 - (errorRatio / spec.errorBudget) * 100, 0), 4),
        windowDays: spec.windowDays,
        objective: spec.objective,
      });
    } catch (error) {
      failures.push({ slo: spec.id, error: error && error.message ? error.message : String(error) });
    }
  }

  console.log(JSON.stringify({ event: 'slo.budget.reported', reported: reported, failures: failures }));

  // Every objective is attempted before anything throws — one renamed metric
  // should not stop the other budgets being published — and then the invocation
  // fails, so the Errors alarm sees it.
  if (failures.length > 0) {
    throw new Error(
      failures.length + ' SLO(s) could not be reported: ' + failures.map((f) => f.slo + ' (' + f.error + ')').join('; '),
    );
  }

  return { reported: reported.length };
};
`;
