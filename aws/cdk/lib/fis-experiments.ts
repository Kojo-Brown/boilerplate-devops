/**
 * The chaos experiments this repository is willing to run, and the arithmetic
 * that decides whether each one is an experiment or an outage.
 *
 * `FailoverGameDayStack` and `BackupRestoreDrillStack` measure two recovery
 * paths by performing the recovery: force a promotion, time it; restore a copy,
 * time it. Both are exercises of a mechanism we already believe in. What neither
 * asks is the question chaos engineering exists for — *does the application
 * survive a fault nobody planned for* — and the three faults below are the ones
 * every architecture diagram in this repository implicitly claims to tolerate:
 * a task disappears, the network gets slow, an Availability Zone goes away. The
 * claim has never been tested, and an untested tolerance claim is indistinguishable
 * from a tested one right up to the morning it matters.
 *
 * Four decisions here are the whole design.
 *
 *   **A stop condition that cannot fire is the default, not the exception.** AWS
 *   FIS requires `stopConditions` to be present and accepts `{ source: 'none' }`
 *   as a legal value, which is what every tutorial ships — including AWS's own
 *   CloudFormation sample for `aws:network:disrupt-connectivity`. `none` reads in
 *   review as "no stop condition configured yet"; what it actually means is that
 *   the fault runs to its full declared duration whatever happens to the
 *   application, in whichever account the template was copied into.
 *   {@link validateChaosCatalogue} refuses it outright.
 *
 *   **A guardrail is only as sensitive as the traffic it is derived from.** The
 *   obvious stop condition here is the ALB 5XX alarm that `CloudWatchAlarmsStack`
 *   already owns, and it is a good one — under load. All three faults below
 *   *reduce* the number of requests that reach a target, and a count of errors in
 *   an environment nobody is calling is zero whether the application is healthy
 *   or on fire. That is not a hypothetical: staging is quiet by construction, and
 *   production at 03:00 is quiet enough, and quiet is exactly when somebody
 *   chooses to run a chaos experiment. So every experiment must carry at least
 *   one stop condition whose metric is published on a schedule rather than by
 *   request traffic — {@link TRAFFIC_INDEPENDENT_METRICS}, which today is the
 *   game-day probe's {@link METRIC_CONNECT_SUCCESS}, emitted every minute whether
 *   or not anyone is running anything.
 *
 *   **A stop condition slower than the experiment is decoration.** A CloudWatch
 *   alarm needs `period x evaluationPeriods` of agreement before it changes
 *   state. `CloudWatchAlarmsStack`'s ALB alarms are five-minute periods over two
 *   evaluations, so they cannot change state inside ten minutes — and a
 *   five-minute experiment guarded by one of them has a guardrail that is
 *   guaranteed to still be evaluating when the fault ends. Nothing about that
 *   template looks wrong: the stop condition is present, the alarm is real, the
 *   experiment completes, and the report says the application tolerated the
 *   fault. {@link detectionWindowSeconds} is the number, and the validator
 *   refuses an experiment whose duration does not clear the fastest stop
 *   condition's window with {@link STOP_CONDITION_MARGIN} to spare.
 *
 *   **The blast radius is arithmetic over the target population, not a word in
 *   the description.** `selectionMode: 'ALL'` against a service running two
 *   tasks is a total outage described as an experiment, and `PERCENT(25)` against
 *   the same service is either one task or none depending on a rounding rule the
 *   template does not state. Both read fine. {@link resolvedTargetRange} computes
 *   the interval of target counts a selection mode can produce, and the validator
 *   refuses a selection that can take every member and one that can take none.
 *
 * What is deliberately not here: nothing in this file schedules an experiment.
 * FIS experiment *templates* are inert — they describe a fault and are started by
 * a human or by something that calls `StartExperiment`. This repository ships the
 * templates and the guardrails and stops there, which is the same line
 * `lib/game-days.ts` draws for a destructive fault: a human starts it. An
 * EventBridge rule that starts a `aws:ecs:stop-task` experiment on a cron is one
 * line of CDK away and is not a line this item is willing to write.
 *
 * See docs/chaos-engineering.md.
 */

import {
  GAME_DAY_NAMESPACE,
  METRIC_CONNECT_SUCCESS,
  PROBE_SCHEDULE_SECONDS,
} from './game-days';

/* ── The FIS vocabulary this repository uses ───────────────────────────────── */

/**
 * The kind of fault an experiment injects.
 *
 * The three the spec item names, and they are three different *questions* rather
 * than three severities. `instance` asks whether the service survives losing a
 * member — a scheduler and a load balancer question. `latency` asks whether it
 * survives a dependency that is slow rather than absent, which is the failure
 * that exhausts connection pools and thread pools while every health check
 * passes. `availability-zone` asks whether the multi-AZ layout the VPC pays for
 * actually works, which is the one claim in this repository that costs money
 * every month and has never once been exercised.
 */
export type ChaosFaultKind = 'instance' | 'latency' | 'availability-zone';

/**
 * An FIS action, with the two strings about it that are easy to get wrong.
 *
 * `targetKey` is the key an action's own `targets` map must use to point at a
 * target definition, and it is decided by the action rather than by the author:
 * `aws:ec2:*` actions take `Instances`, `aws:ecs:task*` actions take `Tasks`,
 * `aws:network:disrupt-connectivity` takes `Subnets`. Getting it wrong is a
 * `ValidationException` at deploy time, which is the harmless case. The case
 * this table exists for is a template copied from an EC2 example into an ECS
 * action and then *edited until it deploys*, which is how a template ends up
 * describing a fault nobody reviewed.
 */
export interface FisAction {
  readonly actionId: string;
  readonly targetKey: string;
  readonly resourceType: string;
}

/**
 * The actions this repository injects, keyed by a name the catalogue uses.
 *
 * Deliberately a closed table rather than free strings on each experiment: an
 * action id is a magic string AWS validates in its own API and CloudFormation
 * does not, so a typo in one is a template that synthesises, passes every gate
 * here, deploys, and fails when somebody starts the experiment during an
 * exercise they had scheduled people's time for.
 */
export const FIS_ACTIONS = {
  'ecs-stop-task': {
    actionId: 'aws:ecs:stop-task',
    targetKey: 'Tasks',
    resourceType: 'aws:ecs:task',
  },
  'ecs-task-network-latency': {
    actionId: 'aws:ecs:task-network-latency',
    targetKey: 'Tasks',
    resourceType: 'aws:ecs:task',
  },
  'network-disrupt-connectivity': {
    actionId: 'aws:network:disrupt-connectivity',
    targetKey: 'Subnets',
    resourceType: 'aws:ec2:subnet',
  },
} as const satisfies Record<string, FisAction>;

export type FisActionName = keyof typeof FIS_ACTIONS;

/** Which action each fault kind is allowed to use. */
export const ACTION_FOR_FAULT_KIND: Readonly<Record<ChaosFaultKind, FisActionName>> = {
  instance: 'ecs-stop-task',
  latency: 'ecs-task-network-latency',
  'availability-zone': 'network-disrupt-connectivity',
};

/**
 * `source` values FIS accepts in a stop condition.
 *
 * `none` is in the type because FIS accepts it and because refusing it is one of
 * this file's reasons to exist — not because anything here may use it.
 */
export const STOP_CONDITION_SOURCE_ALARM = 'aws:cloudwatch:alarm';
export const STOP_CONDITION_SOURCE_NONE = 'none';

/**
 * `logSchemaVersion` for the experiment log configuration.
 *
 * Version 2 is what FIS writes today. The field is required when logging is
 * configured at all, and logging is not required by FIS — an experiment template
 * with no `logConfiguration` runs perfectly and records nothing about which
 * targets it resolved. That record is the entire difference between "we stopped
 * one task in us-east-1a" and "we stopped a task", and it is the question the
 * post-exercise review opens with.
 */
export const LOG_SCHEMA_VERSION = 2;

/* ── Durations ─────────────────────────────────────────────────────────────── */

/** Shortest fault FIS accepts for the duration-taking actions here. */
export const MIN_FAULT_DURATION_SECONDS = 60;

/**
 * Longest fault this repository will declare.
 *
 * FIS itself allows up to twelve hours. Twelve hours of injected latency is not
 * an experiment, it is a degradation with a ticket attached, and the reason to
 * cap it here is that the duration is the one field somebody edits in the
 * console five minutes before starting a run.
 */
export const MAX_FAULT_DURATION_SECONDS = 60 * 60;

/**
 * How much longer than its slowest-to-fire guardrail an experiment must run.
 *
 * Two, so the alarm has a full detection window to notice the fault and another
 * to be acted on before the fault ends on its own. One would mean the stop
 * condition can only ever fire in the instant the experiment was already
 * finishing, which is arithmetically a stop condition and operationally not one.
 */
export const STOP_CONDITION_MARGIN = 2;

/** `PT1M30S`, `PT5M`, `PT1H`. Hours, minutes and seconds, at least one of them. */
const ISO_DURATION = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;

/**
 * Seconds in an ISO-8601 duration of the shape FIS accepts, or `undefined`.
 *
 * `undefined` rather than a throw or a zero: the caller is a validator, and a
 * duration it cannot parse is a finding to report with the other findings rather
 * than an exception that hides them.
 */
export const parseFaultDurationSeconds = (duration: string): number | undefined => {
  const match = ISO_DURATION.exec(duration);
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) return undefined;
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
};

/** The inverse, for building action parameters from a number of seconds. */
export const formatFaultDuration = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts =
    (hours > 0 ? `${hours}H` : '') +
    (minutes > 0 ? `${minutes}M` : '') +
    (seconds > 0 ? `${seconds}S` : '');
  return `PT${parts === '' ? '0S' : parts}`;
};

/* ── Stop conditions ──────────────────────────────────────────────────────── */

/**
 * A CloudWatch alarm an experiment may stop on, described by the two properties
 * that decide whether it can.
 *
 * This is a description of an alarm rather than a reference to one on purpose:
 * the alarms themselves live in `CloudWatchAlarmsStack` and
 * `FailoverGameDayStack`, and what the validator needs to reason about is their
 * *shape*, which is knowable without an account and is what goes wrong.
 */
export interface StopConditionAlarm {
  /** The alarm's `AlarmName`, as the stack sets it. */
  readonly alarmName: string;
  /** Namespace of the metric behind it. */
  readonly namespace: string;
  /** Metric name behind it. */
  readonly metricName: string;
  /** The alarm's `Period`, in seconds. */
  readonly periodSeconds: number;
  /** The alarm's `EvaluationPeriods`. */
  readonly evaluationPeriods: number;
  /** One line: what being in ALARM means, for the doc and the finding. */
  readonly meaning: string;
}

/**
 * Metrics that are published on a schedule rather than by request traffic.
 *
 * The property that matters is not "is this a good alarm" but "does this metric
 * have datapoints while the application is receiving nothing", because that is
 * the state every fault here moves the system towards. The game-day probe
 * qualifies by construction: `FailoverGameDayStack` runs it on a one-minute
 * EventBridge schedule and it publishes whether or not anybody is running an
 * exercise, which is the same property `lib/game-days.ts` relies on to measure a
 * real failover with nobody awake.
 *
 * Nothing else in this repository qualifies today, and the list is a table rather
 * than a comment so that adding a stop condition forces the question. The
 * synthetic canaries would qualify and deliberately are not here: they run in
 * `SyntheticCanaryStack`'s own regions and aggregate in
 * `canaryAggregationRegion`, and an FIS stop condition is an alarm ARN in the
 * experiment's own region, so the canary alarms are not addressable from here
 * under the default configuration.
 */
export const TRAFFIC_INDEPENDENT_METRICS: readonly { namespace: string; metricName: string }[] = [
  { namespace: GAME_DAY_NAMESPACE, metricName: METRIC_CONNECT_SUCCESS },
];

/** Whether an alarm's metric is published independently of request traffic. */
export const isTrafficIndependent = (alarm: StopConditionAlarm): boolean =>
  TRAFFIC_INDEPENDENT_METRICS.some(
    (metric) => metric.namespace === alarm.namespace && metric.metricName === alarm.metricName,
  );

/**
 * How long this alarm needs to change state, in seconds.
 *
 * `period x evaluationPeriods`, which is the floor rather than the expectation —
 * CloudWatch evaluates on period boundaries, so the real figure is up to one
 * more period. The floor is the right number for a rule that refuses an
 * experiment shorter than it: if the fault does not outlast even the optimistic
 * window, there is no argument to have.
 */
export const detectionWindowSeconds = (alarm: StopConditionAlarm): number =>
  alarm.periodSeconds * alarm.evaluationPeriods;

/**
 * The alarm the game-day probe already owns, as this catalogue sees it.
 *
 * Reused rather than recreated. `FailoverGameDayStack` built it to go red during
 * a forced failover, which makes it exactly the right guardrail for an AZ
 * isolation that takes the writer's subnet away, and it is the one alarm in this
 * repository on a metric that is published when nothing is asking.
 *
 * Its `treatMissingData` is `MISSING`, which holds the last known state rather
 * than inventing one, and that is worth stating plainly because it bounds what
 * this guardrail can do: if the probe itself stops during an experiment, the
 * alarm stays in whatever state it was in rather than going red.
 * `<env>-game-day-probe-silent` is the alarm for that, and it is not usable here
 * — it breaches on missing data, so it is in ALARM whenever the probe is quiet,
 * which is a stop condition that reports the probe's health rather than the
 * application's.
 */
export const PROBE_CONNECT_STOP_CONDITION: StopConditionAlarm = {
  alarmName: 'db-connect-failing',
  namespace: GAME_DAY_NAMESPACE,
  metricName: METRIC_CONNECT_SUCCESS,
  periodSeconds: PROBE_SCHEDULE_SECONDS,
  evaluationPeriods: 2,
  meaning:
    'nothing inside the VPC can open a connection to the database endpoint, which every fault ' +
    'here is capable of causing and none of them is supposed to',
};

/**
 * `CloudWatchAlarmsStack`'s load-balancer 5XX alarm, as this catalogue sees it.
 *
 * Carried as a second stop condition on every experiment rather than as the only
 * one. Under load it is the fastest honest signal that the fault has become an
 * incident — it counts responses the load balancer generated itself, which is
 * what a tasks-all-gone fault produces. With no load it counts nothing, which is
 * the whole reason {@link PROBE_CONNECT_STOP_CONDITION} is beside it.
 *
 * The period and evaluation count mirror `CloudWatchAlarmsStack`'s defaults
 * (`periodMinutes: 5`, `evaluationPeriods: 2`). They are the reason
 * {@link STOP_CONDITION_MARGIN} is checked against the *fastest* stop condition
 * rather than all of them: at a ten-minute detection window this alarm cannot
 * stop any experiment this catalogue is willing to declare, and requiring every
 * stop condition to clear the margin would mean either dropping it — losing the
 * signal that actually fires under load — or declaring half-hour faults to
 * accommodate it.
 */
export const ALB_5XX_STOP_CONDITION: StopConditionAlarm = {
  alarmName: 'alb-5xx-elb',
  namespace: 'AWS/ApplicationELB',
  metricName: 'HTTPCode_ELB_5XX_Count',
  periodSeconds: 300,
  evaluationPeriods: 2,
  meaning:
    'the load balancer is answering requests itself because no target will, which under load is ' +
    'the first thing a user sees',
};

/* ── Target selection ─────────────────────────────────────────────────────── */

/** `ALL`, `COUNT(1)`, `PERCENT(50)`. */
const SELECTION_MODE = /^(?:ALL|COUNT\((\d+)\)|PERCENT\((\d+)\))$/;

/**
 * The inclusive range of targets a selection mode can resolve against a
 * population of `population` members.
 *
 * A range rather than a number, and that is the point. `COUNT(n)` and `ALL` are
 * exact. `PERCENT(n)` is not: the template does not say whether FIS rounds the
 * product up or down, and for the populations in this repository — a service
 * running two tasks — the difference between the two is the difference between
 * injecting a fault and injecting nothing at all. A rule written against the
 * optimistic reading of the rounding would pass a template that can resolve zero
 * targets, succeed, and produce a report saying the application was unaffected.
 *
 * Returns `undefined` for a selection mode that is not one of the three shapes
 * FIS accepts.
 */
export const resolvedTargetRange = (
  selectionMode: string,
  population: number,
): { readonly min: number; readonly max: number } | undefined => {
  const match = SELECTION_MODE.exec(selectionMode);
  if (!match) return undefined;
  const [, count, percent] = match;

  if (count !== undefined) {
    const exact = Math.min(Number(count), population);
    return { min: exact, max: exact };
  }

  if (percent !== undefined) {
    const product = (population * Number(percent)) / 100;
    return {
      min: Math.min(Math.floor(product), population),
      max: Math.min(Math.ceil(product), population),
    };
  }

  return { min: population, max: population };
};

/* ── Experiments ──────────────────────────────────────────────────────────── */

/**
 * What an experiment needs to be true of something it does not own.
 *
 * The latency action is the reason this exists. `aws:ecs:task-network-latency`
 * reaches inside a running task, and on Fargate that needs three independent
 * things to line up: the action must be told to use the ECS fault-injection
 * endpoints, the task definition must set `pidMode: task`, and the task
 * definition must set `enableFaultInjection: true`. Two of those three live in
 * `EcsStack`, a different stack owned by a different item, and nothing in
 * CloudFormation reconciles them with this one. Every combination deploys. The
 * experiment template is valid, the service is healthy, target resolution finds
 * the tasks, and the failure arrives when somebody starts the experiment — which
 * is during the exercise, in front of the people who booked the hour.
 *
 * So the requirement is data, and `tools/audit-fis-experiments.ts` checks it
 * against the synthesised `EcsStack` template rather than against this file.
 */
export interface TaskDefinitionRequirement {
  /** Required `PidMode` on the task definition the targeted tasks run. */
  readonly pidMode: 'task';
  /** Required `EnableFaultInjection` on that task definition. */
  readonly enableFaultInjection: true;
}

/**
 * Scope of a `aws:network:disrupt-connectivity` fault.
 *
 * Only the two that describe an AZ event are permitted by this catalogue, and
 * they are genuinely different experiments rather than two severities of one.
 * `availability-zone` denies traffic between the target subnet and subnets in
 * *other* AZs, which is the partition — the AZ is up, its instances are running,
 * and it cannot talk to the rest of the VPC. `all` denies everything to and from
 * the subnet, which is closer to the AZ being switched off.
 *
 * The scopes FIS also accepts and this catalogue refuses — `s3`, `dynamodb`,
 * `prefix-list` — are dependency-isolation experiments. They are perfectly good
 * experiments and they are not AZ faults, and an experiment labelled
 * `availability-zone` that carries `scope: 's3'` is one somebody will read the
 * title of and draw the wrong conclusion from.
 */
export type DisruptScope = 'all' | 'availability-zone';

export interface ChaosExperiment {
  /** Unique, stable, kebab-case. Becomes part of the template's `Name` tag. */
  readonly id: string;
  /** Heading of the section in `docs/chaos-engineering.md`. */
  readonly title: string;
  /** Anchor of that section, including the leading `#`. */
  readonly anchor: string;
  /** The team that answers for the experiment, never an individual. */
  readonly owner: string;
  readonly faultKind: ChaosFaultKind;
  /** Key into {@link FIS_ACTIONS}. Must be the one {@link ACTION_FOR_FAULT_KIND} names. */
  readonly action: FisActionName;
  /**
   * What is expected to happen, in a form that can be wrong.
   *
   * "The system is resilient" is not a hypothesis; it is a mood. What belongs
   * here is the observable the experiment would be refuted by, because an
   * experiment with no stated expectation cannot fail — whatever happens gets
   * written up as a learning.
   */
  readonly hypothesis: string;
  /** FIS selection mode: `ALL`, `COUNT(n)` or `PERCENT(n)`. */
  readonly selectionMode: string;
  /**
   * How many members the target population has when the experiment runs.
   *
   * Declared rather than discovered, because the rule it feeds — does this
   * selection leave a survivor — is about the blast radius somebody signed off
   * on. `EcsStack` runs `desiredCount` tasks with a scaling policy whose
   * `minCapacity` is the same number, so two is the floor rather than a
   * snapshot; the AZ experiments' population is the VPC's `maxAzs`.
   */
  readonly targetPopulation: number;
  /** ISO-8601, `PT5M`. Parsed by {@link parseFaultDurationSeconds}. */
  readonly duration: string;
  /** Alarms any one of which stops the experiment. Never empty, never `none`. */
  readonly stopConditions: readonly StopConditionAlarm[];
  /** Required only of an `availability-zone` experiment. */
  readonly disruptScope?: DisruptScope;
  /** Required only of a `latency` experiment. */
  readonly delayMilliseconds?: number;
  /** Required only of a `latency` experiment. */
  readonly taskDefinitionRequirement?: TaskDefinitionRequirement;
  /** Environments the template is deployed into. */
  readonly allowedEnvironments: readonly string[];
  /** One line: what this experiment is for. */
  readonly summary: string;
}

/**
 * The three experiments the spec item names.
 *
 * Every one of them carries both stop conditions rather than the one that suits
 * it, because the question "is this environment receiving traffic right now" is
 * not one the template can answer and is not one the person starting the
 * experiment should have to.
 */
export const CHAOS_EXPERIMENTS: readonly ChaosExperiment[] = [
  {
    id: 'ecs-task-loss',
    title: 'A task disappears',
    anchor: '#2-a-task-disappears',
    owner: 'platform-team',
    faultKind: 'instance',
    action: 'ecs-stop-task',
    hypothesis:
      'Stopping one of the two tasks is absorbed by the remaining task and by the deployment ' +
      'controller replacing it: the load balancer drains the stopped target rather than serving ' +
      'it, no 5XX reaches a caller, and the replacement is healthy inside one deregistration ' +
      'delay. Refuted by any ELB-generated 5XX, or by a replacement that does not pass its ' +
      'health check.',
    // COUNT(1) rather than PERCENT(50), which resolves to the same one task
    // today. The difference is what happens after somebody raises desiredCount:
    // the percentage silently becomes a bigger fault, and the count stays the
    // experiment that was signed off on.
    selectionMode: 'COUNT(1)',
    targetPopulation: 2,
    // Five minutes: longer than twice the probe alarm's 120-second detection
    // window, and longer than ECS needs to place and health-check a replacement
    // — an experiment shorter than the recovery it is testing measures the fault
    // and not the recovery.
    duration: 'PT5M',
    stopConditions: [PROBE_CONNECT_STOP_CONDITION, ALB_5XX_STOP_CONDITION],
    allowedEnvironments: ['staging', 'production'],
    summary:
      'The fault every autoscaling diagram assumes is survivable, injected on purpose rather ' +
      'than waiting for a spot reclaim or an AZ hiccup to do it unannounced.',
  },
  {
    id: 'ecs-task-network-latency',
    title: 'The network gets slow rather than broken',
    anchor: '#3-the-network-gets-slow-rather-than-broken',
    owner: 'platform-team',
    faultKind: 'latency',
    action: 'ecs-task-network-latency',
    hypothesis:
      'Two hundred milliseconds of added egress latency degrades response times and nothing ' +
      'else: no request fails, the connection pool does not saturate, and the health check — ' +
      'which crosses the same interface — keeps passing. Refuted by a target 5XX, by an ' +
      'unhealthy target, or by latency that outlasts the fault, which means a queue that did ' +
      'not drain.',
    selectionMode: 'COUNT(1)',
    targetPopulation: 2,
    duration: 'PT5M',
    stopConditions: [PROBE_CONNECT_STOP_CONDITION, ALB_5XX_STOP_CONDITION],
    // Two hundred milliseconds, which is FIS's own default and is chosen to be
    // slow enough to notice and well inside every timeout in this repository.
    // The interesting number is not this one: it is the number at which the
    // hypothesis starts failing, and finding it means running this experiment
    // again with a larger delay.
    delayMilliseconds: 200,
    taskDefinitionRequirement: { pidMode: 'task', enableFaultInjection: true },
    allowedEnvironments: ['staging', 'production'],
    summary:
      'The failure mode that looks like health: every check passes, every dependency answers, ' +
      'and the pool behind them fills up.',
  },
  {
    id: 'availability-zone-partition',
    title: 'An Availability Zone is cut off',
    anchor: '#4-an-availability-zone-is-cut-off',
    owner: 'platform-team',
    faultKind: 'availability-zone',
    action: 'network-disrupt-connectivity',
    hypothesis:
      'Partitioning one AZ from the others leaves the application served from the surviving AZ: ' +
      'the load balancer stops sending to targets it can no longer reach, the database either ' +
      'was not in the partitioned AZ or is promoted out of it, and the probe keeps connecting. ' +
      'Refuted by the probe losing the database for longer than the promotion RTO in ' +
      'docs/game-days.md, or by sustained ELB 5XX from the surviving AZ.',
    // COUNT(1) of the AZs. One, because the VPC has two: taking both is not a
    // zonal experiment, it is a region-out exercise with no survivor to serve
    // from, and the selection rule below refuses it rather than leaving it to
    // whoever is editing the console at the time.
    selectionMode: 'COUNT(1)',
    targetPopulation: 2,
    // Ten minutes, the longest fault in this catalogue. A partition is the one
    // fault here whose interesting behaviour is not the first thirty seconds:
    // resolver caches expire, connection pools recycle, a Multi-AZ promotion
    // takes a minute or two, and every one of those is a thing that happens
    // after the fault has been in place for a while.
    duration: 'PT10M',
    stopConditions: [PROBE_CONNECT_STOP_CONDITION, ALB_5XX_STOP_CONDITION],
    // The partition rather than the AZ-off. `all` is the harsher experiment and
    // it is not the one to run first: a subnet denied everything cannot be
    // reached by the probe either, so the measurement goes dark along with the
    // application and the result is indistinguishable from the experiment having
    // broken the measurement. `availability-zone` leaves intra-AZ traffic alone,
    // which keeps the question "did the surviving AZ serve the application"
    // answerable.
    disruptScope: 'availability-zone',
    // Staging only. This is the one experiment in the catalogue whose fault
    // cannot be undone faster than FIS's own rollback: the action replaces the
    // subnets' network ACL association for the duration, and a mistake in the
    // target selection is a production AZ off the air until the experiment ends
    // or somebody re-associates the ACL by hand. It graduates to production when
    // it has run in staging, which is a decision with a date on it rather than a
    // default.
    allowedEnvironments: ['staging'],
    summary:
      'The claim the multi-AZ layout is billed for every month, and the only one in this ' +
      'repository that has never been exercised.',
  },
];

/* ── Validation ───────────────────────────────────────────────────────────── */

export interface ChaosFinding {
  /** Id of the offending experiment, or `<catalogue>` for a cross-entry rule. */
  readonly subject: string;
  /** Stable rule name, for discussion and docs. */
  readonly rule: string;
  readonly message: string;
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ANCHOR = /^#[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Environments an experiment may name.
 *
 * Two of the three the policy pack allows. `preview` is deliberately absent: a
 * preview environment is created per pull request and reaped by
 * `PreviewEnvironmentStack`'s sweeper, so a fault injected into one is a fault
 * injected into something that may not exist by the time anybody reads the
 * result — and the thing a chaos experiment produces is a comparison with its
 * own last run.
 */
export const ALLOWED_ENVIRONMENTS: readonly string[] = ['staging', 'production'];

/**
 * Every rule that can be checked without an AWS account or a synthesised
 * template, reported together.
 *
 * All of them, not the first: a bad entry usually produces several, and fixing
 * them one `cdk synth` at a time is how the last one gets committed.
 */
export const validateChaosCatalogue = (
  experiments: readonly ChaosExperiment[] = CHAOS_EXPERIMENTS,
): ChaosFinding[] => {
  const findings: ChaosFinding[] = [];
  const report = (subject: string, rule: string, message: string): void => {
    findings.push({ subject, rule, message });
  };

  const seenIds = new Map<string, number>();

  for (const experiment of experiments) {
    seenIds.set(experiment.id, (seenIds.get(experiment.id) ?? 0) + 1);

    if (!KEBAB_CASE.test(experiment.id)) {
      report(
        experiment.id,
        'experiment-id-not-kebab',
        `id '${experiment.id}' is not kebab-case. It is used in the template's Name tag and in ` +
          'the log stream the experiment writes, and both are read by things that match on it.',
      );
    }

    if (!ANCHOR.test(experiment.anchor)) {
      report(
        experiment.id,
        'experiment-anchor-malformed',
        `anchor '${experiment.anchor}' is not a '#kebab-case' GitHub heading anchor. The ` +
          'template description points a reader at it, and GitHub answers 200 for an anchor ' +
          'that does not exist, landing them at the top of the page instead.',
      );
    }

    if (experiment.owner.trim() === '' || !experiment.owner.includes('-team')) {
      report(
        experiment.id,
        'experiment-owner-not-a-team',
        `owner '${experiment.owner}' is not a team. An experiment owned by an individual is one ` +
          'that stops being run the week they change teams.',
      );
    }

    if (experiment.hypothesis.trim().length < 40) {
      report(
        experiment.id,
        'experiment-hypothesis-missing',
        'hypothesis is empty or a phrase. An experiment with no stated expectation cannot be ' +
          'refuted, so whatever happens gets written up as a learning and nothing is decided.',
      );
    }

    /* ── Action and target wiring ────────────────────────────────────────── */

    const expectedAction = ACTION_FOR_FAULT_KIND[experiment.faultKind];
    if (experiment.action !== expectedAction) {
      report(
        experiment.id,
        'fault-kind-action-mismatch',
        `faultKind '${experiment.faultKind}' is injected with '${expectedAction}', not ` +
          `'${experiment.action}'. The pairing is what makes the catalogue's three entries three ` +
          'different questions rather than three names for one.',
      );
    }

    const action = FIS_ACTIONS[experiment.action];

    /* ── Duration ───────────────────────────────────────────────────────── */

    const durationSeconds = parseFaultDurationSeconds(experiment.duration);
    if (durationSeconds === undefined) {
      report(
        experiment.id,
        'duration-not-iso8601',
        `duration '${experiment.duration}' is not an ISO-8601 duration of the form FIS accepts ` +
          "(for example 'PT5M'). FIS rejects it when the template is created, which is the " +
          "harmless case; the harmful one is a value like 'PT5' that reads as five of something.",
      );
    } else if (
      durationSeconds < MIN_FAULT_DURATION_SECONDS ||
      durationSeconds > MAX_FAULT_DURATION_SECONDS
    ) {
      report(
        experiment.id,
        'duration-out-of-range',
        `duration is ${durationSeconds}s, outside the ${MIN_FAULT_DURATION_SECONDS}s to ` +
          `${MAX_FAULT_DURATION_SECONDS}s this repository declares. Below the floor the fault is ` +
          'over before anything observing it has a datapoint; above the ceiling it is a ' +
          'degradation with a ticket attached rather than an experiment.',
      );
    }

    /* ── Stop conditions ────────────────────────────────────────────────── */

    if (experiment.stopConditions.length === 0) {
      report(
        experiment.id,
        'stop-condition-missing',
        'no stop conditions. FIS requires the field and accepts an explicit "none", so an ' +
          'experiment with no guardrail is a legal template: the fault then runs its full ' +
          'declared duration whatever happens to the application.',
      );
    }

    for (const alarm of experiment.stopConditions) {
      if (alarm.alarmName === STOP_CONDITION_SOURCE_NONE || alarm.alarmName.trim() === '') {
        report(
          experiment.id,
          'stop-condition-none',
          "a stop condition resolves to FIS's 'none'. It is what every tutorial ships, " +
            "AWS's own CloudFormation sample for aws:network:disrupt-connectivity included, and " +
            'it reads in review as "not configured yet" rather than as "runs to completion ' +
            'regardless".',
        );
      }
    }

    if (
      experiment.stopConditions.length > 0 &&
      !experiment.stopConditions.some(isTrafficIndependent)
    ) {
      report(
        experiment.id,
        'stop-conditions-all-traffic-dependent',
        'every stop condition is derived from request traffic. All three faults here reduce the ' +
          'requests that reach a target, and a count of errors in an environment nobody is ' +
          'calling is zero whether the application is healthy or on fire — so the guardrail is ' +
          'weakest in exactly the conditions somebody chooses to run a chaos experiment in. At ' +
          'least one stop condition must be on a metric that is published on a schedule: ' +
          `${TRAFFIC_INDEPENDENT_METRICS.map((m) => `${m.namespace}/${m.metricName}`).join(', ')}.`,
      );
    }

    if (durationSeconds !== undefined && experiment.stopConditions.length > 0) {
      const fastest = Math.min(...experiment.stopConditions.map(detectionWindowSeconds));
      if (durationSeconds < fastest * STOP_CONDITION_MARGIN) {
        report(
          experiment.id,
          'duration-within-detection-window',
          `the fault lasts ${durationSeconds}s and the fastest stop condition needs ${fastest}s ` +
            `to change state, so the guardrail has less than the ${STOP_CONDITION_MARGIN}x ` +
            'margin it needs to both notice the fault and act on it before the fault ends by ' +
            'itself. Nothing about such a template looks wrong — the stop condition is present, ' +
            'the alarm is real, the experiment completes, and the report says the fault was ' +
            'tolerated.',
        );
      }
    }

    /* ── Blast radius ───────────────────────────────────────────────────── */

    if (!Number.isInteger(experiment.targetPopulation) || experiment.targetPopulation < 2) {
      report(
        experiment.id,
        'target-population-leaves-no-survivor',
        `targetPopulation is ${experiment.targetPopulation}. Any fault against a population of ` +
          'one is a total outage of that thing, however the selection mode is written, so there ' +
          'is no selection this catalogue could accept.',
      );
    } else {
      const range = resolvedTargetRange(experiment.selectionMode, experiment.targetPopulation);
      if (range === undefined) {
        report(
          experiment.id,
          'selection-mode-unparseable',
          `selectionMode '${experiment.selectionMode}' is not ALL, COUNT(n) or PERCENT(n), the ` +
            'three shapes FIS accepts.',
        );
      } else {
        if (range.max >= experiment.targetPopulation) {
          report(
            experiment.id,
            'selection-takes-every-target',
            `selectionMode '${experiment.selectionMode}' can resolve all ` +
              `${experiment.targetPopulation} target(s). That is a total outage described as an ` +
              'experiment: there is no survivor to observe, so the result is "everything broke", ' +
              'which was knowable without running it.',
          );
        }
        if (range.min === 0) {
          report(
            experiment.id,
            'selection-may-resolve-no-targets',
            `selectionMode '${experiment.selectionMode}' against ${experiment.targetPopulation} ` +
              'target(s) can resolve zero, because the template does not state which way FIS ' +
              'rounds the product. The experiment then starts, injects nothing, succeeds, and ' +
              'produces a report saying the application was unaffected.',
          );
        }
      }
    }

    /* ── Per-fault requirements ─────────────────────────────────────────── */

    if (experiment.faultKind === 'availability-zone') {
      if (experiment.disruptScope === undefined) {
        report(
          experiment.id,
          'az-experiment-without-scope',
          'an availability-zone experiment must declare disruptScope. ' +
            `'${action.actionId}' also accepts 's3', 'dynamodb' and 'prefix-list', which are ` +
            'dependency-isolation experiments rather than AZ faults — and a template labelled ' +
            'as this one is, carrying one of those, is one somebody reads the title of and draws ' +
            'the wrong conclusion from.',
        );
      }
    } else if (experiment.disruptScope !== undefined) {
      report(
        experiment.id,
        'disrupt-scope-on-non-network-fault',
        `disruptScope is set on a '${experiment.faultKind}' experiment, whose action ` +
          `'${action.actionId}' does not take a scope. FIS ignores parameters an action does not ` +
          'define, so the field is a statement of intent that nothing enforces.',
      );
    }

    if (experiment.faultKind === 'latency') {
      if (
        experiment.delayMilliseconds === undefined ||
        !Number.isInteger(experiment.delayMilliseconds) ||
        experiment.delayMilliseconds <= 0
      ) {
        report(
          experiment.id,
          'latency-experiment-without-delay',
          'a latency experiment must declare a positive integer delayMilliseconds. Omitting it ' +
            "leaves FIS's own default in place, which makes the size of the fault a property of " +
            'the service rather than of the template somebody approved.',
        );
      }
      if (experiment.taskDefinitionRequirement === undefined) {
        report(
          experiment.id,
          'latency-experiment-without-task-definition-requirement',
          'a latency experiment must declare its taskDefinitionRequirement. The action reaches ' +
            'inside a running task, which on Fargate needs pidMode and EnableFaultInjection set ' +
            'on a task definition that lives in EcsStack — a different stack, where every ' +
            'combination deploys cleanly and the failure surfaces only when somebody starts the ' +
            'experiment.',
        );
      }
    } else if (experiment.taskDefinitionRequirement !== undefined) {
      report(
        experiment.id,
        'task-definition-requirement-on-non-latency-fault',
        `taskDefinitionRequirement is set on a '${experiment.faultKind}' experiment. ` +
          `'${action.actionId}' does not enter the task, so the requirement is a constraint on ` +
          'EcsStack that nothing here needs and the audit would hold it to anyway.',
      );
    }

    /* ── Environments ───────────────────────────────────────────────────── */

    if (experiment.allowedEnvironments.length === 0) {
      report(
        experiment.id,
        'experiment-without-environment',
        'allowedEnvironments is empty, so the template is deployed nowhere. An experiment that ' +
          'exists only in this file is a plan, and it reads on a dashboard exactly like one that ' +
          'runs.',
      );
    }
    for (const envName of experiment.allowedEnvironments) {
      if (!ALLOWED_ENVIRONMENTS.includes(envName)) {
        report(
          experiment.id,
          'experiment-environment-unknown',
          `allowedEnvironments names '${envName}', which is not one of ` +
            `${ALLOWED_ENVIRONMENTS.join(', ')}. Cost and access reports group on an exact ` +
            'string match, so a fourth spelling is a fourth environment.',
        );
      }
    }
  }

  for (const [id, count] of seenIds) {
    if (count > 1) {
      report(
        id,
        'duplicate-experiment-id',
        `experiment '${id}' is declared ${count} times. Both map to one template construct id, ` +
          'so the second definition is the one that deploys and the first is unreachable.',
      );
    }
  }

  return findings;
};

/**
 * Throw on any violation. Used by `ChaosFisStack`, so a bad entry fails
 * `cdk synth` rather than deploying.
 */
export const assertValidChaosCatalogue = (
  experiments: readonly ChaosExperiment[] = CHAOS_EXPERIMENTS,
): void => {
  const findings = validateChaosCatalogue(experiments);
  if (findings.length > 0) {
    throw new Error(
      'The chaos experiment catalogue is invalid:\n' +
        findings.map((f) => `  [${f.rule}] ${f.subject}: ${f.message}`).join('\n') +
        '\nSee docs/chaos-engineering.md.',
    );
  }
};

/** Experiments deployed into one environment. */
export const experimentsFor = (
  envName: string,
  experiments: readonly ChaosExperiment[] = CHAOS_EXPERIMENTS,
): readonly ChaosExperiment[] =>
  experiments.filter((experiment) => experiment.allowedEnvironments.includes(envName));

/**
 * Name of the FIS experiment template, as its `Name` tag carries it.
 *
 * The tag rather than a property: `AWS::FIS::ExperimentTemplate` has no name
 * field, and the console lists templates by this tag. A template with no `Name`
 * is a row of blank in the console that somebody has to open to identify, which
 * is how the wrong one gets started.
 */
export const experimentTemplateName = (envName: string, experimentId: string): string =>
  `${envName}-chaos-${experimentId}`;

/** Log group the experiment writes its target resolution and timeline to. */
export const experimentLogGroupName = (envName: string): string =>
  `/aws/fis/${envName}-chaos-experiments`;
