/**
 * Recovery objectives, the game days that measure them, and the arithmetic that
 * turns a measurement into a number anyone should believe.
 *
 * `multiAz: true` is one line in `lib/rds-stack.ts` and it is, in this
 * repository as in most, the entire disaster-recovery story. It is also a claim
 * about AWS's behaviour rather than about ours. What AWS undertakes is that the
 * standby is promoted; what nobody here has ever measured is how long the
 * *caller* takes to be served again afterwards, which is a different number and
 * is usually dominated by things on our side of the endpoint — a connection pool
 * holding sockets to the old writer's address, a resolver cache that outlives
 * the endpoint's five-second TTL, a health check that passes because the process
 * is up. The failure this exists to end is not a wrong number. It is that there
 * is no number: "RTO: 60 seconds" in a DR document is the figure from a product
 * page, copied into a wiki, and the first time anybody checks it is during the
 * real AZ event.
 *
 * Three decisions here are the whole design.
 *
 *   **An objective per recovery path, never per system.** A Multi-AZ standby
 *   promotion has an RPO of zero by construction — the standby commits
 *   synchronously — and an RTO of a minute or two. A point-in-time restore has
 *   an RPO of however stale `LatestRestorableTime` is and an RTO measured in
 *   tens of minutes. A DR document carrying one pair of numbers for "the
 *   database" has conflated them, and the pair it carries is reliably the
 *   flattering one, so the plan that would actually be executed during data loss
 *   is the one nobody wrote down. {@link RECOVERY_OBJECTIVES} therefore keys on
 *   {@link RecoveryPath}, and {@link validateGameDayCatalogue} refuses an RPO of
 *   zero on any path whose basis is not synchronous replication.
 *
 *   **The measurement comes from a signal that was already being emitted.** A
 *   game day timed on someone's phone measures the exercise and nothing else: the
 *   same stopwatch is not running during the real incident, and the exercise is
 *   not the thing worth knowing about. So RTO is derived from
 *   {@link METRIC_CONNECT_SUCCESS}, which the probe in `FailoverGameDayStack`
 *   publishes every minute whether or not anyone is running an exercise — which
 *   means the real event is measured by exactly the arithmetic below, with no
 *   preparation and nobody awake.
 *
 *   **A measurement carries its own resolution.** CloudWatch's standard
 *   resolution is sixty seconds and a Multi-AZ RTO is of the same order, so an
 *   RTO read off standard-resolution datapoints is a number whose uncertainty is
 *   as large as itself. The probe publishes at one-second resolution for that
 *   reason alone, {@link measureRto} reports `resolutionSeconds` beside every
 *   number it produces, and the validator refuses an objective whose RTO is not
 *   comfortably above what the metric behind it can resolve — an unmeasurable
 *   objective reads exactly like a demanding one.
 *
 * What is deliberately not here: the fault is a failover and nothing else. AWS
 * FIS templates and the backup-restore drill are the two spec items after this
 * one, and {@link RECOVERY_OBJECTIVES} carries the restore path as `declared`
 * rather than `rehearsed` so that the gap is a value in a file rather than an
 * omission nobody can see.
 *
 * See docs/game-days.md.
 */

/* ── Where the measurements are published ─────────────────────────────────── */

/**
 * CloudWatch namespace for everything in this item.
 *
 * Its own namespace rather than `AWS/RDS`: these are measurements of the
 * *caller's* experience of the database, taken from a probe, and putting them
 * next to the engine's own metrics would invite reading `ConnectSuccess` as
 * something RDS reported.
 */
export const GAME_DAY_NAMESPACE = 'Platform/GameDay';

/** 1 if the probe reached the endpoint's TCP port, 0 if it did not. */
export const METRIC_CONNECT_SUCCESS = 'ConnectSuccess';

/** Round-trip time of the successful connect, in milliseconds. */
export const METRIC_CONNECT_LATENCY = 'ConnectLatencyMs';

/**
 * 1 when the endpoint resolved to a different address than the previous run.
 *
 * The signal that a promotion has actually happened, and the one that catches
 * the caller-side failure this item exists for: a client that holds the old
 * address keeps failing for as long as its own cache lives, whatever RDS thinks
 * the state of the failover is.
 */
export const METRIC_ENDPOINT_ADDRESS_CHANGED = 'EndpointAddressChanged';

/** 1 when the endpoint name could not be resolved at all. */
export const METRIC_RESOLUTION_FAILED = 'EndpointResolutionFailed';

/**
 * Age of `LatestRestorableTime`, in seconds: the live RPO of the restore path.
 *
 * This is the one number in DR planning that is continuously observable and
 * essentially never observed. If the backup pipeline stops, this timestamp stops
 * advancing, and nothing anywhere goes red — the instance is healthy, the
 * backups are "enabled", and the data you could get back is as old as whenever
 * it broke.
 */
export const METRIC_RESTORE_POINT_LAG = 'RestorePointLagSeconds';

/** Hours since the objective's last recorded rehearsal. */
export const METRIC_HOURS_SINCE_REHEARSAL = 'HoursSinceRehearsal';

/** Measured RTO of the last completed game day, published once per exercise. */
export const METRIC_MEASURED_RTO = 'MeasuredRtoSeconds';

/**
 * Seconds from the restore being requested to the restored copy answering a
 * verified query. Published once per drill.
 *
 * A different kind of number from {@link METRIC_MEASURED_RTO}, and the
 * difference is worth stating because it is the one exception to this item's
 * "measure from a signal that was already on" rule. A promotion is an event that
 * happens to a running system, so an always-on probe can catch it whenever it
 * occurs, including at 04:00 with nobody awake. A point-in-time restore is not
 * an event that happens: it is a thing somebody does, and no amount of watching
 * production will ever produce one. The only way to get a number is to perform
 * the restore, which is why this metric has one datapoint per drill and why the
 * drill is scheduled rather than approved.
 */
export const METRIC_MEASURED_RESTORE_SECONDS = 'MeasuredRestoreSeconds';

/**
 * 1 when every check in {@link RESTORE_VERIFICATION_CHECKS} passed, 0 when any
 * failed.
 *
 * Published on every drill that got as far as having something to verify, which
 * includes the drills that failed verification — a restore that came back wrong
 * is the finding, and a metric that is only ever published when things worked is
 * a metric whose absence is indistinguishable from health.
 */
export const METRIC_RESTORE_VERIFIED = 'RestoreVerified';

/**
 * Age of the drill instance that is currently running, in seconds.
 *
 * The one failure in this whole item that costs money forever: a drill that
 * aborted between the restore and the teardown leaves a full-size copy of
 * production running, and nothing about it is red. It does not serve traffic, it
 * has no alarms of its own, and it looks exactly like a database somebody meant
 * to create. The sweeper publishes this every hour so that the orphan is a
 * number on a graph rather than a line on next month's bill.
 */
export const METRIC_DRILL_INSTANCE_AGE = 'DrillInstanceAgeSeconds';

/**
 * Every metric the stack publishes into {@link GAME_DAY_NAMESPACE}.
 *
 * {@link RecoveryObjective.measuredBy} has to name one of these. An objective
 * measured by a metric nothing emits is an objective nothing evaluates, and it
 * reads identically to one that is measured.
 */
export const GAME_DAY_METRICS = [
  METRIC_CONNECT_SUCCESS,
  METRIC_CONNECT_LATENCY,
  METRIC_ENDPOINT_ADDRESS_CHANGED,
  METRIC_RESOLUTION_FAILED,
  METRIC_RESTORE_POINT_LAG,
  METRIC_HOURS_SINCE_REHEARSAL,
  METRIC_MEASURED_RTO,
  METRIC_MEASURED_RESTORE_SECONDS,
  METRIC_RESTORE_VERIFIED,
  METRIC_DRILL_INSTANCE_AGE,
] as const;

export type GameDayMetric = (typeof GAME_DAY_METRICS)[number];

/**
 * Storage resolution the probe publishes {@link METRIC_CONNECT_SUCCESS} at.
 *
 * One second, which makes it a high-resolution metric. Standard resolution
 * buckets everything into sixty seconds, so the six samples an invocation takes
 * would arrive as one datapoint and the whole point of taking them would be lost
 * in aggregation. See docs/game-days.md §4 for what the resolution costs, which
 * is small and is not nothing.
 */
export const PROBE_RESOLUTION_SECONDS = 1;

/**
 * How often the probe is *invoked*, in seconds.
 *
 * Sixty, because that is EventBridge's floor and there is no way around it.
 * Which is the constraint the whole measurement design follows from: a
 * once-a-minute probe cannot resolve a two-minute RTO to better than 50%, and
 * two minutes is what a Multi-AZ promotion actually takes.
 */
export const PROBE_SCHEDULE_SECONDS = 60;

/**
 * Seconds between samples *inside* one invocation.
 *
 * The way past EventBridge's floor: the probe is invoked once a minute and
 * connects {@link PROBE_SAMPLES_PER_INVOCATION} times while it is running,
 * publishing each result at its own timestamp. The measurement's resolution is
 * therefore this number and not the schedule — which only works because the
 * metric is high-resolution; at standard resolution CloudWatch would average the
 * six samples into the minute they landed in and hand back exactly the
 * sixty-second ruler this exists to avoid.
 */
export const PROBE_SAMPLE_INTERVAL_SECONDS = 10;

/**
 * Samples per invocation.
 *
 * Six at ten-second spacing spans fifty seconds, so the last sample of one
 * invocation and the first of the next are one interval apart and the series is
 * uniform across the minute boundary. Seven would overrun into the next
 * invocation; five would leave a twenty-second hole every minute, which is the
 * tolerance below and would make every measurement marginal.
 */
export const PROBE_SAMPLES_PER_INVOCATION = 6;

/**
 * The largest hole in the series a measurement tolerates, in seconds.
 *
 * One missed sample. Past that the probe was not reporting during part of the
 * event it exists to measure, and the honest output is a refusal rather than a
 * number: an arithmetic that treats missing datapoints as healthy turns a
 * four-minute outage nobody observed into a twenty-second one.
 */
export const MAX_RESOLUTION_SECONDS = PROBE_SAMPLE_INTERVAL_SECONDS * 2;

/**
 * How many sample intervals an RTO objective has to be worth, at minimum.
 *
 * Ten, so the floor on an objective is
 * {@link PROBE_SAMPLE_INTERVAL_SECONDS} × 10 = 100 seconds and
 * {@link MAX_RESOLUTION_SECONDS} is at worst a fifth of any objective that
 * passes. An objective below the floor is not a demanding target, it is an
 * unmeasurable one — and the two are indistinguishable in a document, which is
 * why this is a rule and not a guideline.
 */
export const MIN_RTO_PERIODS = 10;

/**
 * The drill's measurement resolution, in seconds.
 *
 * A restore is not watched by the probe — it happens to an instance that did not
 * exist a minute ago and that nothing is connected to — so its RTO is bounded
 * by how often the automation asks whether the restored instance is ready.
 * `aws:waitForAwsResourceProperty` polls on roughly this cadence, which means
 * the drill notices `available` up to one interval after it became true and the
 * measured number is up to one interval too large.
 *
 * That is the safe direction for an RTO and it is why this is a constant rather
 * than something to tune: a measurement that errs long is a target nobody
 * over-promises against, and the alternative — polling the restore every second
 * for forty minutes — buys thirty seconds of precision on a number whose
 * objective is half an hour.
 */
export const DRILL_POLL_INTERVAL_SECONDS = 30;

/**
 * Metrics the in-VPC probe publishes continuously.
 *
 * Separated from the rest because the preflight rules differ: an objective
 * measured from the probe cannot be exercised while the probe is quiet, and one
 * measured from a drill has no probe in its path at all. Requiring
 * `probe-reporting` of both would put a check on the drill that cannot fail for
 * any reason the drill cares about, which is the kind of green that teaches
 * people to stop reading a gate.
 */
export const PROBE_METRICS: readonly GameDayMetric[] = [
  METRIC_CONNECT_SUCCESS,
  METRIC_CONNECT_LATENCY,
  METRIC_ENDPOINT_ADDRESS_CHANGED,
  METRIC_RESOLUTION_FAILED,
];

/**
 * The uncertainty attached to an objective's measurement, in seconds.
 *
 * Which signal the objective is measured from decides it: the probe samples
 * every {@link PROBE_SAMPLE_INTERVAL_SECONDS}, and the drill observes the
 * restored instance every {@link DRILL_POLL_INTERVAL_SECONDS}. The floor rule in
 * {@link validateGameDayCatalogue} is written against this rather than against
 * the probe's interval, because an objective of half an hour measured by a
 * thirty-second poll is perfectly measurable and the probe's number has nothing
 * to say about it.
 */
export const measurementResolutionSeconds = (objective: RecoveryObjective): number =>
  PROBE_METRICS.includes(objective.measuredBy)
    ? PROBE_SAMPLE_INTERVAL_SECONDS
    : DRILL_POLL_INTERVAL_SECONDS;

/* ── Objectives ───────────────────────────────────────────────────────────── */

/**
 * How a recovery happens, which is what decides both numbers.
 *
 * Not a severity and not a system: two objectives over one database differ
 * because the *mechanism* differs, and the mechanism is what makes an RPO zero
 * or not.
 */
export type RecoveryPath =
  /** The standby is promoted. Synchronous, so nothing committed is lost. */
  | 'multi-az-promotion'
  /** A new instance is restored from automated backups to a chosen second. */
  | 'point-in-time-restore';

/**
 * What the RPO number is a statement about.
 *
 * The only reason this field exists is to make {@link RecoveryObjective.rpoSeconds}
 * refutable. `0` is a correct RPO for a synchronous standby and a fantasy for a
 * restore, and in a document the two are the same character.
 */
export type RpoBasis =
  /**
   * The commit is acknowledged only once the standby has it, so a promotion
   * loses nothing. Measuring this is not possible from outside the engine and
   * is not attempted: the rule enforced instead is that only this basis may
   * claim zero.
   */
  | 'synchronous-replication'
  /**
   * `LatestRestorableTime` from `rds:DescribeDBInstances`. An actual observable
   * number, published every five minutes as {@link METRIC_RESTORE_POINT_LAG},
   * and the only RPO here that can go wrong quietly.
   */
  | 'latest-restorable-time';

/**
 * Whether anything exercises this objective.
 *
 * The same distinction `lib/slo-definitions.ts` draws between an `active` and a
 * `proposed` objective, and for the same reason: a number in a file that nothing
 * checks is indistinguishable from one that is checked, and the second kind is
 * the only kind worth having. `declared` is honest about a gap;
 * {@link validateGameDayCatalogue} refuses the two ways it can go stale — a
 * `rehearsed` objective no scenario exercises, and a `declared` one that a
 * scenario does.
 */
export type ObjectiveStatus = 'rehearsed' | 'declared';

export interface RecoveryObjective {
  /** Unique, stable, kebab-case. Appears in the record and in the alert. */
  readonly id: string;
  /** Heading of the section in `docs/game-days.md`. */
  readonly title: string;
  /** Anchor of that section, including the leading `#`. */
  readonly anchor: string;
  /** The team that answers for the number, never an individual. */
  readonly owner: string;
  readonly path: RecoveryPath;
  readonly status: ObjectiveStatus;
  /**
   * Target time to recovery, in seconds, as the caller experiences it.
   *
   * Not AWS's promotion time: the span during which a connection attempt from
   * outside the database fails. That is the number a dependent service's
   * timeouts have to be set against, and it is always the larger one.
   */
  readonly rtoSeconds: number;
  /**
   * Target data loss, in seconds, on the basis below.
   *
   * Zero is permitted only for `synchronous-replication` — see {@link RpoBasis}.
   */
  readonly rpoSeconds: number;
  readonly rpoBasis: RpoBasis;
  /** Metric the RTO is derived from. Must be in {@link GAME_DAY_METRICS}. */
  readonly measuredBy: GameDayMetric;
  /**
   * How often the objective has to be re-measured to stay believable.
   *
   * The interval is the objective's shelf life, and the overdue alarm is the
   * only thing in this repository that reports a DR plan quietly going out of
   * date. An engine upgrade, an instance-class change or a new connection pool
   * can each move the RTO, and none of them is a change anybody associates with
   * disaster recovery.
   */
  readonly rehearsalIntervalDays: number;
  /** One line: what has actually been promised here. */
  readonly summary: string;
}

/**
 * The recovery objectives this repository's infrastructure can be held to.
 *
 * Two, over one database, because there are two mechanisms. Both are now
 * rehearsed by {@link GAME_DAY_SCENARIOS}, and by exercises of deliberately
 * different shapes: the promotion path breaks a live instance and so starts from
 * a human, and the restore path creates a copy and touches nothing live, so it
 * starts from a schedule. See {@link GameDayTrigger}.
 */
export const RECOVERY_OBJECTIVES: readonly RecoveryObjective[] = [
  {
    id: 'rds-multi-az-promotion',
    title: 'The database loses its writer',
    anchor: '#2-the-database-loses-its-writer',
    owner: 'platform-team',
    path: 'multi-az-promotion',
    status: 'rehearsed',
    // Two minutes, not the sixty seconds the product page quotes. The extra
    // minute is not slack: it is the caller's resolver cache and pool recycling,
    // and it is the part of the outage a database-side measurement cannot see.
    rtoSeconds: 120,
    rpoSeconds: 0,
    rpoBasis: 'synchronous-replication',
    measuredBy: METRIC_CONNECT_SUCCESS,
    rehearsalIntervalDays: 90,
    summary:
      'An AZ event, a failed writer or a patch that reboots one takes the primary away, the ' +
      'standby is promoted, and the endpoint name comes to resolve to a different address. ' +
      'Nothing committed is lost. What the caller sees is a connection that fails and then ' +
      'does not.',
  },
  {
    id: 'rds-point-in-time-restore',
    title: 'The data is wrong and has to be rolled back',
    anchor: '#3-the-data-is-wrong-and-has-to-be-rolled-back',
    owner: 'platform-team',
    path: 'point-in-time-restore',
    status: 'rehearsed',
    // Thirty minutes. It began life as a guess carrying `status: 'declared'`,
    // and what changed is not the number but that something now produces one to
    // compare it against: `rds-pitr-drill` restores to the latest restorable
    // point every thirty days and publishes the seconds it took. The objective
    // is deliberately left where it was rather than being moved to whatever the
    // first drill reports — an objective edited to match the last measurement is
    // not an objective, and the gap between the two is the finding.
    rtoSeconds: 1800,
    // Five minutes: the interval RDS advances LatestRestorableTime on. Not a
    // target we chose, a property of the mechanism — which is exactly why it is
    // worth publishing rather than asserting.
    rpoSeconds: 300,
    rpoBasis: 'latest-restorable-time',
    // The RTO's metric, not the RPO's. `METRIC_RESTORE_POINT_LAG` is still
    // published every five minutes and still alarmed on — it is this objective's
    // RPO — but what this field names is the signal the *RTO* is derived from,
    // and until the drill existed the honest answer was "nothing", written down
    // as the RPO metric because the field had to hold something.
    measuredBy: METRIC_MEASURED_RESTORE_SECONDS,
    // Thirty days rather than the 180 this carried while it was unexercised. A
    // drill nobody has to approve can run monthly, and the interval is the
    // objective's shelf life: the restore path's RTO moves with the volume's
    // size, which grows continuously, so a number from six months ago is a
    // number about a smaller database.
    rehearsalIntervalDays: 30,
    summary:
      'A bad migration or a bad deploy corrupts data, and recovery means a new instance ' +
      'restored to a second before the damage. The promotion path cannot help: the standby ' +
      'holds the same committed bytes, faithfully.',
  },
];

/* ── Scenarios ────────────────────────────────────────────────────────────── */

/**
 * The fault, or the exercise, a game day performs.
 *
 * Two, and they are not the same kind of thing — which is the distinction
 * {@link GameDayTrigger} exists to carry. A forced failover is a fault injected
 * into a live instance. A point-in-time restore injects nothing: it reads the
 * backups into a second instance and leaves production untouched. Calling both
 * "faults" was the first shape of this type and it is what made a restore drill
 * look like something that needed a human to approve it.
 */
export type GameDayFault = 'rds-force-failover' | 'rds-point-in-time-restore';

/**
 * Faults that change something live.
 *
 * The list is the reason the approval step exists, so it is data rather than a
 * comment: {@link validateGameDayCatalogue} refuses a scenario whose fault is in
 * here and whose trigger is anything but `approval`, and adding a fault without
 * adding it here is the way a destructive exercise would acquire a schedule.
 */
export const DESTRUCTIVE_FAULTS: readonly GameDayFault[] = ['rds-force-failover'];

/**
 * What starts an exercise.
 *
 * The whole of the distinction between the two scenarios in this catalogue, and
 * the thing most worth getting right, because the two mistakes are not
 * symmetrical. A destructive exercise on a schedule is an outage nobody chose. A
 * non-destructive one behind an approval is an exercise that quietly stops
 * happening — somebody has to remember, and six months later the overdue alarm
 * is a ticket in a backlog, which is where DR rehearsals go to die. The restore
 * drill exists because §3 of docs/game-days.md had been honest about an
 * unmeasured number for one spec item, and an unmeasured number behind a human
 * gate would have stayed unmeasured.
 */
export type GameDayTrigger =
  /**
   * A human approves it through `aws:approve`. Mandatory for every fault in
   * {@link DESTRUCTIVE_FAULTS}.
   */
  | 'approval'
  /**
   * An EventBridge schedule starts the automation. Permitted only where the
   * exercise changes nothing live, and required to run at least as often as the
   * objective's `rehearsalIntervalDays` — otherwise the schedule and the overdue
   * alarm disagree, and the alarm is red through a drill cadence somebody chose.
   */
  | 'schedule';

/**
 * A precondition checked before the fault is injected.
 *
 * Every one of these exists because the exercise fails *silently* without it —
 * it runs, it reports, and the report is wrong in the reassuring direction.
 */
export const PREFLIGHT_CHECKS = [
  /**
   * The instance is actually Multi-AZ.
   *
   * A forced failover on a Single-AZ instance is not an error: it is a reboot.
   * The instance goes away, comes back, the probe records an outage, and the
   * exercise reports a measured RTO for a failover that never happened — a
   * number that will be quoted for a year.
   */
  'multi-az-enabled',
  /**
   * The probe is currently reporting.
   *
   * With the probe stopped, the measurement window contains no datapoints, and
   * an arithmetic that treats absence as success reports an RTO of zero. See
   * {@link measureRto}, which refuses instead.
   */
  'probe-reporting',
  /**
   * Nothing is mid-deploy.
   *
   * Two changes at once means the exercise measures the pair of them, and the
   * half that is not in the report is the half that gets blamed.
   */
  'no-deployment-in-progress',
  /**
   * Nothing is already on fire.
   *
   * A game day during an incident is not a game day. This is the check that most
   * often refuses a scheduled exercise, and refusing is the point.
   *
   * Deliberately *not* on the restore drill: that exercise changes nothing live,
   * so "an incident is going on" is not a reason to skip it — and a monthly
   * drill gated on an account-wide alarm prefix is a drill that stops happening
   * during the months when something is always red, which are the months you
   * most want to know the backups restore.
   */
  'no-alarm-in-alarm-state',
  /**
   * There is a restore point, and it is recent enough to restore to.
   *
   * `UseLatestRestorableTime` on an instance with no automated backups is not an
   * error the API returns helpfully: it is an `InvalidDBInstanceState` forty
   * seconds in, and the drill it aborts looks like a drill that failed rather
   * than like an instance that cannot be restored at all. Checking first turns
   * the most important finding this item can produce — *there is no restore
   * path* — into the reason on an abort record instead of a stack trace.
   */
  'restore-point-available',
  /**
   * No drill instance from a previous run is still around.
   *
   * Restoring onto an identifier that exists fails outright, which would be
   * harmless. The dangerous shape is the next step: a teardown scoped to that
   * identifier would delete the *other* drill's instance, in the middle of its
   * verification, and the report would say the restore could not be verified.
   */
  'no-drill-instance-present',
] as const;

export type PreflightCheck = (typeof PREFLIGHT_CHECKS)[number];

/** A condition that ends the exercise before it finishes. */
export const ABORT_CONDITIONS = [
  /** The probe is still failing well past the objective. The exercise is now an incident. */
  'probe-failing-past-rto-budget',
  /** The instance has not returned to `available` inside the wait. */
  'instance-not-available-in-time',
  /** A human said stop. Always available, always first. */
  'operator-abort',
  /**
   * The restored instance never reached `available` inside the wait.
   *
   * Which is a result, not a hitch: it means the restore path's RTO is past the
   * wait, and the wait is set from the objective. The record carries it and the
   * instance is torn down, so the finding is "a restore takes longer than we
   * promised" rather than a drill that hung.
   */
  'restore-not-available-in-time',
  /**
   * The restored copy came back and could not be verified.
   *
   * The single most valuable outcome this item can produce, and the one a drill
   * that only watched for `available` would have reported as a success.
   */
  'verification-failed',
] as const;

export type AbortCondition = (typeof ABORT_CONDITIONS)[number];

export interface GameDayScenario {
  /** Unique, stable, kebab-case. Part of the automation document's name. */
  readonly id: string;
  readonly title: string;
  /** The objective this measures. Must be an id in {@link RECOVERY_OBJECTIVES}. */
  readonly objectiveId: string;
  readonly fault: GameDayFault;
  /**
   * What starts it. See {@link GameDayTrigger} — the rules are that a
   * destructive fault must be `approval`, and that a `schedule` must be at least
   * as frequent as the objective's rehearsal interval.
   */
  readonly trigger: GameDayTrigger;
  /**
   * Days between automatic runs. Required when {@link trigger} is `schedule`,
   * and refused when it is not: a cadence on an exercise nothing schedules is a
   * number that reads like a commitment and drives nothing.
   */
  readonly scheduleIntervalDays?: number;
  /**
   * Environments this scenario may be run in, by name.
   *
   * The blast radius, as data. Empty means anywhere, which is why it is refused,
   * and `*` is refused for the same reason: a scenario runnable everywhere is a
   * scenario runnable in production by someone who thought they were in staging.
   * Production is in this list for both exercises on purpose — a failover
   * rehearsed only in staging measures staging's connection pool, and a restore
   * rehearsed only in staging measures staging's volume — and for the failover
   * that is exactly why {@link trigger} is not negotiable.
   */
  readonly allowedEnvironments: readonly string[];
  readonly preflight: readonly PreflightCheck[];
  readonly abortIf: readonly AbortCondition[];
  /** Rough wall-clock cost of running it, for the calendar invite. */
  readonly expectedDurationMinutes: number;
  /** One line: what is being done, and what is being learned. */
  readonly summary: string;
}

export const GAME_DAY_SCENARIOS: readonly GameDayScenario[] = [
  {
    id: 'rds-failover',
    title: 'Force a Multi-AZ failover and measure the caller-side outage',
    objectiveId: 'rds-multi-az-promotion',
    fault: 'rds-force-failover',
    trigger: 'approval',
    allowedEnvironments: ['staging', 'production'],
    preflight: [
      'multi-az-enabled',
      'probe-reporting',
      'no-deployment-in-progress',
      'no-alarm-in-alarm-state',
    ],
    abortIf: [
      'operator-abort',
      'instance-not-available-in-time',
      'probe-failing-past-rto-budget',
    ],
    expectedDurationMinutes: 20,
    summary:
      'Reboot the primary with ForceFailover, then read the outage off the probe rather than ' +
      'off a stopwatch. What is learned is the caller-side RTO, and whether the endpoint ' +
      'address changed at all — which is the difference between a failover and a reboot.',
  },
  {
    id: 'rds-pitr-drill',
    title: 'Restore to the latest restorable point and prove the data came back',
    objectiveId: 'rds-point-in-time-restore',
    fault: 'rds-point-in-time-restore',
    // A schedule, which is the point. See {@link GameDayTrigger}: this exercise
    // reads the backups into a second instance and never touches the live one,
    // so there is nothing for a human to weigh — and a restore drill behind an
    // approval is a restore drill that runs once, in the week the item shipped.
    trigger: 'schedule',
    // Monthly, which is the objective's interval. The rule in
    // `validateGameDayCatalogue` is that the schedule must be at least as
    // frequent as the interval: a drill every 60 days against a 30-day shelf
    // life means the overdue alarm is red for half of every cycle, with nothing
    // anybody can do about it except widen the interval they just chose.
    scheduleIntervalDays: 30,
    allowedEnvironments: ['staging', 'production'],
    preflight: ['restore-point-available', 'no-drill-instance-present'],
    abortIf: ['operator-abort', 'restore-not-available-in-time', 'verification-failed'],
    // Forty-five minutes for a 100 GiB volume, almost all of it the restore
    // itself. Nobody has to sit through it — the drill reports when it is done —
    // but it is what the schedule has to be spaced against, and it is why the
    // teardown is on the failure path of every step after the restore.
    expectedDurationMinutes: 45,
    summary:
      'Restore the instance to its latest restorable point into a scratch instance and verify ' +
      'the copy: it is available, private and encrypted, its engine negotiates TLS and presents ' +
      'a certificate for the endpoint that was restored, its volume holds the source\'s bytes, ' +
      'and its point in time is the one that was asked for. Then measure how long that took and ' +
      'delete the copy. What is learned is that the backups restore at all, which ' +
      'LatestRestorableTime advancing is not evidence of.',
  },
];

/* ── Names ────────────────────────────────────────────────────────────────── */

/** `<env>-gameday-<scenarioId>`: the SSM Automation document. */
export const gameDayDocumentName = (envName: string, scenarioId: string): string =>
  `${envName}-gameday-${scenarioId}`;

/**
 * `/<env>/game-day/<objectiveId>/last-rehearsal`: where the measurement lands.
 *
 * An SSM Parameter rather than a row in a document somebody edits. It is what
 * the overdue metric is computed from and what the next exercise compares
 * against, so the record has to be machine-readable or the whole "documented"
 * half of this item is a wiki page going stale.
 */
export const rehearsalParameterName = (envName: string, objectiveId: string): string =>
  `/${envName}/game-day/${objectiveId}/last-rehearsal`;

/**
 * `<env>-dr-drill`: the instance a restore drill restores into.
 *
 * One identifier per environment, fixed rather than suffixed with an execution
 * id, and that is a deliberate trade. A fixed name means two drills cannot run
 * at once — the second one's restore fails on the identifier, which the
 * `no-drill-instance-present` preflight turns into a clean refusal — and in
 * exchange every grant that can delete a database in this repository is scoped
 * to one literal ARN that is known at synth time. With a generated name the
 * teardown's grant would have to be `<env>-dr-drill-*` at best, and the
 * difference between a prefix and a name is the difference between "can delete
 * the drill copy" and "can delete anything somebody names like one".
 */
export const drillInstanceIdentifier = (envName: string): string => `${envName}-dr-drill`;

/**
 * Longest a drill instance may exist before the sweeper treats it as abandoned,
 * in seconds.
 *
 * Six hours, against a drill that takes about forty-five minutes. The margin is
 * wide on purpose: the sweeper deletes what it finds, and the only thing worse
 * than an orphaned copy of production is a sweeper that deletes a drill which
 * was still working — which would report as a verification failure and send
 * somebody looking at the backups.
 */
export const MAX_DRILL_INSTANCE_AGE_SECONDS = 6 * 3600;

/** The objective a scenario measures, or `undefined` if it names one that is gone. */
export const objectiveFor = (
  scenario: GameDayScenario,
  objectives: readonly RecoveryObjective[] = RECOVERY_OBJECTIVES,
): RecoveryObjective | undefined => objectives.find((o) => o.id === scenario.objectiveId);

/** Scenarios that exercise this objective. More than one is a defect, not a bonus. */
export const scenariosFor = (
  objective: RecoveryObjective,
  scenarios: readonly GameDayScenario[] = GAME_DAY_SCENARIOS,
): GameDayScenario[] => scenarios.filter((s) => s.objectiveId === objective.id);

/* ── The record a game day writes ─────────────────────────────────────────── */

/**
 * What a completed exercise leaves behind.
 *
 * Deliberately holds the failure cases too. A game day that aborted is a result,
 * and an exercise log that records only the ones that finished is how a plan
 * comes to look rehearsed on the strength of the three attempts that worked.
 */
export interface RehearsalRecord {
  readonly objectiveId: string;
  readonly scenarioId: string;
  /** ISO 8601, UTC. When the fault was injected. */
  readonly startedAt: string;
  /** ISO 8601, UTC. When the measurement was taken. */
  readonly completedAt: string;
  readonly outcome: 'measured' | 'aborted' | 'inconclusive';
  /** Measured caller-side RTO. Absent unless `outcome` is `measured`. */
  readonly measuredRtoSeconds?: number;
  /** Uncertainty of that number, from the probe's interval. */
  readonly resolutionSeconds?: number;
  /**
   * The point in time a restore drill restored to, ISO 8601. Absent on a
   * failover exercise, which has no restore point.
   */
  readonly restorePoint?: string;
  /** Verification checks that passed, in the order they ran. */
  readonly checksPassed?: readonly string[];
  /**
   * Verification checks that failed, with the detail each one reported.
   *
   * Present and non-empty is the finding: the restore completed, the instance
   * reached `available`, and the copy is not usable. A drill that recorded only
   * "aborted" would have thrown that away.
   */
  readonly checksFailed?: readonly string[];
  /** Did the endpoint resolve somewhere new? A `false` here means no failover happened. */
  readonly endpointAddressChanged?: boolean;
  /** Restore-point lag at the time of the exercise, for the record. */
  readonly restorePointLagSeconds?: number;
  /** Why it aborted or could not be measured. Required unless `measured`. */
  readonly note?: string;
  /** The automation execution, so the exercise can be read back in full. */
  readonly executionId: string;
}

/**
 * Everything recorded about one objective, in one SSM parameter.
 *
 * Two records rather than one, and the reason is the whole of this type. An
 * aborted exercise is a result worth keeping — a preflight that refused three
 * times running is the most useful thing this mechanism produces — but an abort
 * must not reset the rehearsal clock. With a single record it does: the
 * exercise is scheduled, the preflight refuses because something is already on
 * fire, the record is written, and the objective now looks freshly rehearsed on
 * the strength of an exercise that never injected anything. So `lastAttempt` is
 * every attempt and `lastMeasured` is only the ones that produced a number, and
 * {@link lastMeasuredAt} — which the overdue metric is computed from — reads the
 * second.
 */
export interface RehearsalLog {
  readonly objectiveId: string;
  /** The most recent attempt, whatever came of it. */
  readonly lastAttempt: RehearsalRecord;
  /** The most recent attempt that produced a measurement. */
  readonly lastMeasured?: RehearsalRecord;
}

/** Fold a new record into the log, keeping the last measurement if this is not one. */
export const mergeRehearsalLog = (
  previous: RehearsalLog | undefined,
  record: RehearsalRecord,
): RehearsalLog => ({
  objectiveId: record.objectiveId,
  lastAttempt: record,
  lastMeasured: record.outcome === 'measured' ? record : previous?.lastMeasured,
});

/**
 * When the objective was last actually measured, if ever.
 *
 * Tolerant of a log that is absent or malformed, and deliberately so: both come
 * back as `undefined`, which {@link rehearsalFreshness} reports as overdue. The
 * alternative — throwing on a parameter somebody hand-edited — would take the
 * overdue metric off the air, and an objective with no freshness metric is one
 * with no overdue alarm.
 */
export const lastMeasuredAt = (log: RehearsalLog | undefined): Date | undefined => {
  const timestamp = log?.lastMeasured?.completedAt;
  if (typeof timestamp !== 'string') return undefined;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/**
 * Parse what was read out of the SSM parameter.
 *
 * Returns `undefined` rather than throwing for anything that is not a log, for
 * the reason {@link lastMeasuredAt} gives.
 */
export const parseRehearsalLog = (raw: string | undefined): RehearsalLog | undefined => {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<RehearsalLog>;
    if (typeof parsed?.objectiveId !== 'string' || typeof parsed?.lastAttempt !== 'object') {
      return undefined;
    }
    return parsed as RehearsalLog;
  } catch {
    return undefined;
  }
};

/* ── RTO measurement ──────────────────────────────────────────────────────── */

/** One probe result, as CloudWatch gives it back. */
export interface ProbeDatapoint {
  readonly timestamp: Date;
  /** The `ConnectSuccess` value: 1 reached the port, 0 did not. */
  readonly connectSuccess: number;
}

export interface MeasureRtoOptions {
  /** Start of the window examined. Usually the moment the fault was injected. */
  readonly windowStart: Date;
  /** End of the window examined. */
  readonly windowEnd: Date;
  /**
   * The largest hole in the series to tolerate, in seconds.
   *
   * Default {@link MAX_RESOLUTION_SECONDS}. Also the cap on the
   * `resolutionSeconds` a conclusive measurement can carry, which is what makes
   * this one knob rather than two: a measurement is either precise enough to be
   * reported or it is a refusal.
   */
  readonly maxResolutionSeconds?: number;
}

/**
 * Why a window could not produce a number.
 *
 * Every one of these is a case where a naive implementation returns a plausible
 * RTO instead, and the plausible answer is always the flattering one.
 */
export type RtoInconclusiveReason =
  /** No datapoints at all. A mean over an empty set is not zero. */
  | 'no-datapoints'
  /** Nothing ever failed. Either the fault missed, or the probe did. */
  | 'no-outage-observed'
  /** The first datapoint is already failing: the outage began before the window. */
  | 'outage-began-before-window'
  /** The window ends still failing: this is a lower bound, not a measurement. */
  | 'outage-unresolved-in-window'
  /**
   * A hole in the series, across the outage, wider than the tolerance.
   *
   * The probe stopped reporting *during* the event, which is the one time its
   * silence is most likely to mean something. A hole at the end is the dangerous
   * one — failures, then silence, then a success an hour later bounds the
   * recovery nowhere — but a hole in the middle is not safe either: a brief
   * recovery inside it would mean two short outages rather than one long one,
   * and the long reading is the one that gets quoted.
   */
  | 'datapoint-gap-across-outage';

export type RtoMeasurement =
  | {
      readonly conclusive: true;
      /** Timestamp of the last success before the outage. */
      readonly lastHealthyAt: Date;
      /** Timestamp of the first failure. */
      readonly outageStartedAt: Date;
      /** Timestamp of the first success after it. */
      readonly recoveredAt: Date;
      /**
       * Recovery time, in seconds: first failure to first success.
       *
       * Measured from the first *failure* rather than from the last success,
       * which would inflate it by up to one probe interval — and inflating an
       * RTO is not the safe direction either, since a number that is generous
       * about how long recovery takes is generous about how long a dependent
       * service should wait.
       */
      readonly rtoSeconds: number;
      /**
       * Uncertainty of the above, in seconds.
       *
       * The larger of the two gaps that bound the event: last success to first
       * failure, and last failure to first success. Measured from the data
       * rather than assumed from the schedule, because a probe that was running
       * late produced a coarser number than a probe that was not, and the record
       * should say which one this was.
       */
      readonly resolutionSeconds: number;
      /** Failing datapoints seen. A one-datapoint outage is a blip, not an RTO. */
      readonly failedDatapoints: number;
    }
  | {
      readonly conclusive: false;
      readonly reason: RtoInconclusiveReason;
      /**
       * The lower bound, where there is one.
       *
       * Present for `outage-unresolved-in-window`, because "at least four
       * minutes and still going" is worth reporting; absent everywhere else,
       * because there is nothing to report.
       */
      readonly atLeastSeconds?: number;
    };

const seconds = (from: Date, to: Date): number => Math.round((to.getTime() - from.getTime()) / 1000);

/**
 * Derive the caller-side RTO from the probe's datapoints.
 *
 * Pure, and takes the window explicitly, so the same function that the
 * automation's final step calls is the one the tests call with a hand-built
 * outage. There is no path in here that produces a number from an absence.
 */
export const measureRto = (
  datapoints: readonly ProbeDatapoint[],
  options: MeasureRtoOptions,
): RtoMeasurement => {
  const maxResolutionSeconds = options.maxResolutionSeconds ?? MAX_RESOLUTION_SECONDS;
  const inWindow = datapoints
    .filter(
      (d) =>
        d.timestamp.getTime() >= options.windowStart.getTime() &&
        d.timestamp.getTime() <= options.windowEnd.getTime(),
    )
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  if (inWindow.length === 0) return { conclusive: false, reason: 'no-datapoints' };

  const firstFailureIndex = inWindow.findIndex((d) => d.connectSuccess < 1);
  if (firstFailureIndex === -1) return { conclusive: false, reason: 'no-outage-observed' };

  // A window whose very first datapoint is a failure cannot say when the outage
  // started. Reporting the span from there to recovery would be a lower bound
  // presented as a measurement, and it is what the exercise produces when the
  // probe was already unhappy before anybody injected anything — which is what
  // the `probe-reporting` preflight exists to catch first.
  if (firstFailureIndex === 0) return { conclusive: false, reason: 'outage-began-before-window' };

  const outageStartedAt = inWindow[firstFailureIndex].timestamp;
  const lastHealthyAt = inWindow[firstFailureIndex - 1].timestamp;

  const recoveryIndex = inWindow.findIndex(
    (d, index) => index > firstFailureIndex && d.connectSuccess >= 1,
  );
  if (recoveryIndex === -1) {
    return {
      conclusive: false,
      reason: 'outage-unresolved-in-window',
      atLeastSeconds: seconds(outageStartedAt, inWindow[inWindow.length - 1].timestamp),
    };
  }

  // Every gap from the last healthy sample to the recovery sample, inclusive:
  // the two at the edges are the measurement's uncertainty, and any of them
  // being too wide means the probe was not watching.
  let resolutionSeconds = 0;
  for (let index = firstFailureIndex; index <= recoveryIndex; index += 1) {
    const gap = seconds(inWindow[index - 1].timestamp, inWindow[index].timestamp);
    resolutionSeconds = Math.max(resolutionSeconds, gap);
  }
  if (resolutionSeconds > maxResolutionSeconds) {
    return { conclusive: false, reason: 'datapoint-gap-across-outage' };
  }

  const recoveredAt = inWindow[recoveryIndex].timestamp;
  return {
    conclusive: true,
    lastHealthyAt,
    outageStartedAt,
    recoveredAt,
    rtoSeconds: seconds(outageStartedAt, recoveredAt),
    resolutionSeconds,
    failedDatapoints: recoveryIndex - firstFailureIndex,
  };
};

/**
 * Did the measurement meet the objective, allowing for its own uncertainty?
 *
 * A measured 122 seconds against a 120-second objective, from a probe that runs
 * every 60, is not a miss — it is indistinguishable from a pass, and calling it
 * a miss teaches people that the gate is noise. So the verdict is three-valued
 * and the middle value says what it is.
 */
export type ObjectiveVerdict = 'met' | 'missed' | 'within-measurement-error';

export const verdictFor = (
  objective: RecoveryObjective,
  measurement: Extract<RtoMeasurement, { conclusive: true }>,
): ObjectiveVerdict => {
  if (measurement.rtoSeconds <= objective.rtoSeconds) return 'met';
  if (measurement.rtoSeconds - objective.rtoSeconds <= measurement.resolutionSeconds) {
    return 'within-measurement-error';
  }
  return 'missed';
};

/* ── RPO measurement ──────────────────────────────────────────────────────── */

export type RestorePointLag =
  | { readonly usable: true; readonly lagSeconds: number }
  | {
      readonly usable: false;
      /**
       * `absent`: RDS reported no `LatestRestorableTime`, which is what an
       * instance with backup retention set to zero looks like — the RPO is not
       * large, there is no restore path at all.
       *
       * `in-the-future`: the timestamp is ahead of now, which is clock skew or a
       * parsing error. Clamping it to zero would publish a perfect RPO out of a
       * broken reading, which is the worst available outcome.
       */
      readonly reason: 'absent' | 'in-the-future';
    };

/**
 * The restore path's live RPO, from `LatestRestorableTime`.
 *
 * Not clamped and not defaulted: the two unusable readings are the two that
 * matter, and both of them look like a healthy zero to anything that rounds.
 */
export const restorePointLag = (
  latestRestorableTime: Date | undefined,
  now: Date,
): RestorePointLag => {
  if (latestRestorableTime === undefined) return { usable: false, reason: 'absent' };
  const lagSeconds = seconds(latestRestorableTime, now);
  if (lagSeconds < 0) return { usable: false, reason: 'in-the-future' };
  return { usable: true, lagSeconds };
};

/**
 * How often the recorder samples `LatestRestorableTime`, in seconds.
 *
 * Five minutes. Sampling faster would not produce a fresher number: RDS advances
 * the timestamp on its own interval, so a one-minute sample rate buys four more
 * readings of the same value.
 */
export const RECORDER_INTERVAL_SECONDS = 300;

/**
 * The threshold the restore-point alarm has to use, in seconds.
 *
 * The obvious threshold is the objective itself, and it pages roughly half the
 * time on a perfectly healthy instance. `LatestRestorableTime` advances in steps
 * of about {@link RecoveryObjective.rpoSeconds}, so the observed lag sawtooths
 * between nearly zero and one full step; sampling every
 * {@link RECORDER_INTERVAL_SECONDS} can land anywhere in that tooth and miss the
 * trough, so what a sampler sees peaks at one step plus one sample interval. A
 * threshold at or below that is red during normal operation, which is how an
 * alarm about data loss becomes an alarm people mute.
 *
 * One further sample interval of margin puts the threshold clear of the
 * sawtooth while still catching the failure that matters, which is not a late
 * backup but a backup pipeline that has stopped: that timestamp then stops
 * advancing at all and the lag climbs without bound.
 *
 * Restated in `tools/audit-game-days.ts` and pinned to the synthesised alarm, so
 * a threshold edited in the stack is a build failure rather than a pager going
 * off every afternoon.
 */
export const restorePointAlarmThresholdSeconds = (
  objective: RecoveryObjective,
  recorderIntervalSeconds: number = RECORDER_INTERVAL_SECONDS,
): number => objective.rpoSeconds + 2 * recorderIntervalSeconds;

/* ── Verifying a restore ──────────────────────────────────────────────────── */

/**
 * What a drill checks about the copy it restored.
 *
 * The shape of this list is decided by one constraint, and it is worth stating
 * before the entries rather than apologising for afterwards: **there is no
 * PostgreSQL client here.** `lambda.Code.fromInline` is how every function in
 * this repository ships, a driver would mean bundling, and docs/game-days.md has
 * carried "that needs a client library in the probe, which means bundling, which
 * this repository does not do" as a known gap since the probe was written. So
 * none of these checks runs a query, and the two that would have — "the schema
 * is there", "the rows are there" — are replaced by the two below that reach the
 * same findings through the control plane and the wire protocol. What that costs
 * is listed in docs/game-days.md §12.
 *
 * Every entry is here because a drill without it reports a success that means
 * nothing. The order is the order they run in, and it is cheapest-and-most-
 * decisive first: there is no point opening a socket to an instance that is not
 * `available`, and the public-access check comes before anything that touches
 * the data because that is a finding you want *before* a copy of production has
 * been reachable from the internet for forty minutes.
 */
export const RESTORE_VERIFICATION_CHECKS = [
  /**
   * The restored instance reports `available`.
   *
   * Not sufficient, and until this item it was the whole of what most restore
   * "drills" test: RDS reports `available` as soon as the engine starts, and an
   * instance restored from a backup of an empty volume starts perfectly.
   */
  'instance-available',
  /**
   * `PubliclyAccessible` is false.
   *
   * The drill's own worst failure, and the reason this check exists rather than
   * the request simply setting the flag. `RestoreDBInstanceToPointInTime` does
   * not copy `PubliclyAccessible` from the source — it takes it from the
   * request, and the default depends on the subnet group — so a drill that omits
   * it can put a full copy of production's data on a public endpoint, once a
   * month, with nobody looking. Asserted against the instance that exists
   * instead of against the call that was made, because those are different
   * claims.
   */
  'not-publicly-accessible',
  /** `StorageEncrypted` is true, which a restore of an encrypted source is. */
  'storage-encrypted',
  /**
   * The engine answers PostgreSQL's SSL negotiation and completes a TLS
   * handshake.
   *
   * The first check that is about the database rather than about the control
   * plane, and strictly stronger than the TCP connect the failover probe makes:
   * a backend has to read the eight-byte `SSLRequest` and answer `S` before any
   * session exists, so a listener with no postmaster behind it fails here while
   * passing a connect. An instance still replaying WAL does not reach this
   * either — it is the state a restore that silently did not finish leaves
   * behind.
   */
  'engine-negotiates-tls',
  /**
   * The certificate the engine presents names the endpoint that was restored.
   *
   * Identity without a chain, deliberately — see
   * {@link RESTORE_TLS_CHAIN_UNVERIFIED}. What it rules out is the whole class
   * of "something answered": the drill resolved the endpoint of the instance it
   * created, and the thing on the other end holds a certificate for that name.
   */
  'certificate-names-the-instance',
  /**
   * The restored volume holds about as many bytes as the source's.
   *
   * The replacement for the query nobody can run here, and the check that
   * catches the restore that completed and brought back nothing: an instance
   * restored from the wrong source, or from a point before the schema existed,
   * is `available`, serves TLS, presents the right certificate, and is empty.
   * `FreeStorageSpace` is published for both instances by RDS itself, once a
   * minute, so the comparison is between two numbers AWS produced — and an
   * empty database against a populated one is not a near miss, it is orders of
   * magnitude. See {@link restoredBytesMatch} for the tolerance and why it is
   * as wide as it is.
   */
  'restored-bytes-match-source',
  /**
   * The copy is not older than the point the drill asked for.
   *
   * `UseLatestRestorableTime` is a request, and the thing that answers it is a
   * backup pipeline. A restore that quietly came from an older point is the
   * exact failure a point-in-time restore exists to avoid — you restore to a
   * second before the bad migration and get the bad migration — and it is
   * invisible in every other check here, because an instance restored to last
   * Tuesday is just as `available`, just as encrypted and holds just as many
   * bytes. The restored instance's `InstanceCreateTime` is at or after the
   * moment the restore was requested, and the preflight recorded the source's
   * `LatestRestorableTime` as of that moment, so the two bracket the point the
   * data is from.
   */
  'restore-point-not-stale',
] as const;

export type RestoreVerificationCheck = (typeof RESTORE_VERIFICATION_CHECKS)[number];

/**
 * Why the TLS handshake in `engine-negotiates-tls` does not validate the chain.
 *
 * Exported as a constant so it is one string, quoted by the verifier's own
 * output and by `test/backup-restore-drill-stack.test.ts`, rather than a comment
 * somebody deletes. RDS serves certificates from Amazon's own RDS CAs, which are
 * in no default trust store, so validating the chain means shipping a CA bundle.
 * The three ways to do that were each worse than this: pinning the PEM into this
 * repository puts a 60 KB certificate blob in copy-paste material and a rotation
 * deadline in somebody else's calendar; fetching the bundle at run time puts an
 * internet dependency on the path of the thing that verifies the backups; and a
 * parameter group with `rds.force_ssl = 0` turns the encryption off on a copy of
 * production rather than checking it.
 *
 * What the connection is for is the identity check below it, which does not need
 * a chain: nothing is sent to the engine beyond the negotiation and nothing is
 * read from it beyond the certificate, so there is no session and no data on
 * this socket to protect.
 */
export const RESTORE_TLS_CHAIN_UNVERIFIED =
  'TLS chain not validated: RDS certificates are signed by Amazon CAs that are in no default ' +
  'trust store, and the alternatives are a pinned 60 KB bundle, an internet dependency, or ' +
  'turning TLS off. The certificate is checked for the restored endpoint\'s name instead, and ' +
  'nothing is sent or read on this socket beyond the handshake.';

export interface VerificationCheckResult {
  readonly check: RestoreVerificationCheck;
  readonly passed: boolean;
  /** What was observed. Goes in the record and in the notification, pass or fail. */
  readonly detail: string;
}

export type RestoreVerdict = 'verified' | 'failed';

/**
 * The verdict, and it is unanimity.
 *
 * No weighting, no advisory checks, no "warn". Every entry in
 * {@link RESTORE_VERIFICATION_CHECKS} is there because the drill is worthless
 * without it, so a check that may fail without failing the drill is a check that
 * should have been deleted — and the first optional one is how a verification
 * suite becomes a dashboard nobody reads. A drill that did not run every check
 * is `failed` too: a result that is missing is not a result that passed, and
 * "the verifier crashed after three checks" has to be as loud as "the data is
 * not there", because from the outside they are the same amount of knowledge.
 */
export const restoreVerdict = (
  results: readonly VerificationCheckResult[],
  required: readonly RestoreVerificationCheck[] = RESTORE_VERIFICATION_CHECKS,
): RestoreVerdict => {
  if (results.some((result) => !result.passed)) return 'failed';
  const seen = new Set(results.map((result) => result.check));
  return required.every((check) => seen.has(check)) ? 'verified' : 'failed';
};

/**
 * How far the restored copy's used bytes may differ from the source's, as a
 * fraction.
 *
 * A fifth, which is far wider than the difference a correct restore produces and
 * is chosen against the failure this check is for rather than against precision.
 * A restore that brought back the data differs from its source by WAL that has
 * accumulated since the restore point, by an autovacuum state that did not come
 * with it, and by the source having kept writing while the drill ran. A restore
 * that brought back *nothing* differs from its source by one to two orders of
 * magnitude. There is no tolerance between 1.2x and 100x that distinguishes
 * those two cases better than this one does, and a tight tolerance here buys
 * nothing except a drill that fails in the month somebody loads a large table.
 */
export const RESTORED_BYTES_TOLERANCE = 0.2;

/**
 * Minimum used bytes on the source before the comparison means anything.
 *
 * One GiB. Below it the source is mostly the engine's own files and the ratio is
 * dominated by them, so a restore of an empty database would pass — which is
 * precisely the case this check exists for. A source under the floor is reported
 * as a failed check rather than skipped: "this drill cannot tell whether the
 * data came back" is a finding about the drill, and skipping it is how a check
 * that never fires comes to look like a check that passes.
 */
export const RESTORED_BYTES_FLOOR = 1024 * 1024 * 1024;

export interface StorageUsage {
  /** `AllocatedStorage`, in GiB, as RDS reports it. */
  readonly allocatedStorageGiB: number;
  /** Latest `AWS/RDS` `FreeStorageSpace` datapoint, in bytes. */
  readonly freeStorageBytes: number;
}

export type BytesComparison =
  | { readonly matches: true; readonly sourceUsedBytes: number; readonly restoredUsedBytes: number; readonly ratio: number }
  | {
      readonly matches: false;
      readonly reason: 'source-too-small' | 'restored-too-small' | 'restored-too-large';
      readonly sourceUsedBytes: number;
      readonly restoredUsedBytes: number;
      readonly ratio: number;
    };

/**
 * Do the restored instance's used bytes look like the source's?
 *
 * Used bytes rather than free, and each computed from its own instance's
 * `AllocatedStorage`, because storage autoscaling means the two instances can
 * have different volume sizes — `maxAllocatedStorage` is set on the source, and
 * a restore takes the allocation the source had at the restore point. Comparing
 * free space directly would then report a perfectly good restore as a mismatch
 * the first time the source's volume grew.
 */
export const restoredBytesMatch = (
  source: StorageUsage,
  restored: StorageUsage,
  tolerance: number = RESTORED_BYTES_TOLERANCE,
  floor: number = RESTORED_BYTES_FLOOR,
): BytesComparison => {
  const used = (usage: StorageUsage) =>
    usage.allocatedStorageGiB * 1024 * 1024 * 1024 - usage.freeStorageBytes;
  const sourceUsedBytes = used(source);
  const restoredUsedBytes = used(restored);
  const ratio = sourceUsedBytes === 0 ? 0 : restoredUsedBytes / sourceUsedBytes;

  if (sourceUsedBytes < floor) {
    return { matches: false, reason: 'source-too-small', sourceUsedBytes, restoredUsedBytes, ratio };
  }
  if (ratio < 1 - tolerance) {
    return { matches: false, reason: 'restored-too-small', sourceUsedBytes, restoredUsedBytes, ratio };
  }
  if (ratio > 1 + tolerance) {
    return { matches: false, reason: 'restored-too-large', sourceUsedBytes, restoredUsedBytes, ratio };
  }
  return { matches: true, sourceUsedBytes, restoredUsedBytes, ratio };
};

/**
 * How stale the restored copy's point in time may be, in seconds.
 *
 * Twice the restore path's RPO. `UseLatestRestorableTime` lands on a point that
 * is already up to one RPO old by construction — that is what
 * {@link METRIC_RESTORE_POINT_LAG} measures — and the restore itself is
 * requested a moment after the preflight read the number, so one RPO of slack is
 * the mechanism and the second is the drill's own latency. Past that the copy is
 * from a point nobody asked for.
 */
export const restorePointStaleAfterSeconds = (objective: RecoveryObjective): number =>
  objective.rpoSeconds * 2;

/**
 * Is the copy from the point the drill asked for?
 *
 * `restorePointAtPreflight` is the source's `LatestRestorableTime` as the
 * preflight read it, and `instanceCreateTime` is when RDS created the restored
 * instance. A correct `UseLatestRestorableTime` restore carries data from
 * somewhere between the two, so the span between them is the uncertainty — and
 * if that span is wider than {@link restorePointStaleAfterSeconds}, the copy is
 * from a point the drill cannot vouch for whatever the API reported.
 */
export const restorePointIsFresh = (
  restorePointAtPreflight: Date,
  instanceCreateTime: Date,
  maxStaleSeconds: number,
): boolean => {
  const span = seconds(restorePointAtPreflight, instanceCreateTime);
  return span >= 0 && span <= maxStaleSeconds;
};

export interface RestoreMeasurement {
  /** Seconds from the restore being requested to the copy being verified. */
  readonly restoreSeconds: number;
  /** Uncertainty, from {@link DRILL_POLL_INTERVAL_SECONDS}. */
  readonly resolutionSeconds: number;
}

/**
 * How long the restore took, from two timestamps the platform produced.
 *
 * `requestedAt` is the restored instance's `InstanceCreateTime` rather than the
 * moment the automation called the API, which is the same deliberate choice the
 * failover exercise makes about `ConnectSuccess`: a number read off something
 * the platform recorded is reproducible after the fact, and a number the
 * automation timed itself is only as good as the automation's clock and its own
 * scheduling. It also errs in the honest direction —
 * {@link DRILL_POLL_INTERVAL_SECONDS} pushes the measurement long, and an RTO
 * that errs long is one nobody over-promises against.
 *
 * Throws on a negative span: a verification that completed before the instance
 * was created means the two timestamps are not about the same restore — most
 * likely a copy left over from an earlier run — and a negative RTO published
 * into a graph is worse than no datapoint.
 */
export const measureRestore = (
  requestedAt: Date,
  verifiedAt: Date,
  resolutionSeconds: number = DRILL_POLL_INTERVAL_SECONDS,
): RestoreMeasurement => {
  const restoreSeconds = seconds(requestedAt, verifiedAt);
  if (restoreSeconds < 0) {
    throw new Error(
      `measureRestore: the copy was verified at ${verifiedAt.toISOString()}, before it was ` +
        `created at ${requestedAt.toISOString()}. The two timestamps are not about the same ` +
        'restore — most likely a drill instance left over from an earlier run was described ' +
        'instead of this one.',
    );
  }
  return { restoreSeconds, resolutionSeconds };
};

/* ── Rehearsal freshness ──────────────────────────────────────────────────── */

export interface RehearsalFreshness {
  /** Hours since the last recorded rehearsal, or `undefined` if there is none. */
  readonly hoursSince?: number;
  readonly overdue: boolean;
  /** Days until it next comes due. Negative once overdue. */
  readonly dueInDays?: number;
}

/**
 * How stale the objective's last measurement is.
 *
 * An objective that has *never* been rehearsed is overdue, immediately. The
 * alternative — treating "no record" as "not due yet" — means a newly declared
 * objective sits unrehearsed and unreported until somebody rehearses it, which
 * is the one state this whole mechanism exists to make visible.
 */
export const rehearsalFreshness = (
  objective: RecoveryObjective,
  lastRehearsedAt: Date | undefined,
  now: Date,
): RehearsalFreshness => {
  if (lastRehearsedAt === undefined) return { overdue: true };
  const hoursSince = seconds(lastRehearsedAt, now) / 3600;
  const intervalHours = objective.rehearsalIntervalDays * 24;
  return {
    hoursSince,
    overdue: hoursSince > intervalHours,
    dueInDays: (intervalHours - hoursSince) / 24,
  };
};

/* ── Validation ───────────────────────────────────────────────────────────── */

export interface GameDayFinding {
  /** Id of the offending entry, or `<catalogue>` for a cross-entry rule. */
  readonly subject: string;
  /** Stable rule name, for discussion and docs. */
  readonly rule: string;
  readonly message: string;
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ANCHOR = /^#[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The longest a rehearsal interval may be, in days.
 *
 * A year, because past that the objective has outlived at least one engine
 * version, one instance class and most of the team, and an interval of "every
 * two years" is a way of writing "never" that passes review.
 */
export const MAX_REHEARSAL_INTERVAL_DAYS = 365;

/**
 * The shortest, in days.
 *
 * A fortnight. Below that the overdue alarm is in ALARM more often than not,
 * and an alarm that is usually red is an alarm people filter.
 */
export const MIN_REHEARSAL_INTERVAL_DAYS = 14;

/**
 * Every rule that can be decided from this file alone.
 *
 * The ones needing the synthesised templates or the markdown live in
 * `tools/audit-game-days.ts`. Findings rather than throws, so a catalogue with
 * three problems reports three.
 */
export const validateGameDayCatalogue = (
  objectives: readonly RecoveryObjective[] = RECOVERY_OBJECTIVES,
  scenarios: readonly GameDayScenario[] = GAME_DAY_SCENARIOS,
): GameDayFinding[] => {
  const findings: GameDayFinding[] = [];
  const report = (subject: string, rule: string, message: string) =>
    findings.push({ subject, rule, message });

  if (objectives.length === 0) {
    report(
      '<catalogue>',
      'catalogue-empty',
      'no recovery objectives are declared, so every rule below passes and nothing is ' +
        'promised. An empty DR plan and an unwritten one are the same artefact.',
    );
  }

  const seenIds = new Map<string, number>();
  const seenAnchors = new Map<string, string[]>();
  const seenPaths = new Map<RecoveryPath, string[]>();

  for (const objective of objectives) {
    seenIds.set(objective.id, (seenIds.get(objective.id) ?? 0) + 1);
    seenAnchors.set(objective.anchor, [...(seenAnchors.get(objective.anchor) ?? []), objective.id]);
    seenPaths.set(objective.path, [...(seenPaths.get(objective.path) ?? []), objective.id]);

    if (!KEBAB_CASE.test(objective.id)) {
      report(
        objective.id,
        'objective-id-not-kebab-case',
        `id '${objective.id}' must be lower-case kebab-case: it becomes part of an SSM ` +
          'parameter path and a CloudWatch dimension value.',
      );
    }
    if (!objective.title.trim()) {
      report(objective.id, 'objective-title-missing', 'title is required: it is the heading of the section.');
    }
    if (!objective.summary.trim()) {
      report(
        objective.id,
        'objective-summary-missing',
        'summary is required: it is the sentence that says what was promised, and a plan whose ' +
          'entries are two numbers and an id has not been written down.',
      );
    }
    if (!ANCHOR.test(objective.anchor)) {
      report(
        objective.id,
        'objective-anchor-malformed',
        `anchor '${objective.anchor}' must be '#' followed by the lower-case kebab-case slug ` +
          'GitHub generates from the heading.',
      );
    }
    if (!objective.owner) {
      report(
        objective.id,
        'objective-owner-missing',
        'owner is required: an objective with no owner is nobody\'s to re-measure.',
      );
    } else if (objective.owner.includes('@')) {
      report(
        objective.id,
        'objective-owner-is-an-individual',
        `owner '${objective.owner}' looks like a person. An objective outlives anyone's time on ` +
          'a rota; name the team.',
      );
    }

    if (!Number.isFinite(objective.rtoSeconds) || objective.rtoSeconds <= 0) {
      report(
        objective.id,
        'rto-not-positive',
        `rtoSeconds is ${objective.rtoSeconds}. An RTO of zero is a claim that recovery is ` +
          'instantaneous, which no mechanism here provides, and it makes every measurement a miss.',
      );
    } else if (objective.rtoSeconds < MIN_RTO_PERIODS * measurementResolutionSeconds(objective)) {
      const resolution = measurementResolutionSeconds(objective);
      report(
        objective.id,
        'rto-below-measurable-resolution',
        `rtoSeconds is ${objective.rtoSeconds}, and '${objective.measuredBy}' is observed every ` +
          `${resolution}s — so a measurement of it is mostly quantisation error. An objective ` +
          `needs at least ${MIN_RTO_PERIODS} observation intervals ` +
          `(${MIN_RTO_PERIODS * resolution}s) behind it, or it reads as a demanding target ` +
          'while being an unmeasurable one.',
      );
    }

    if (!Number.isFinite(objective.rpoSeconds) || objective.rpoSeconds < 0) {
      report(
        objective.id,
        'rpo-negative',
        `rpoSeconds is ${objective.rpoSeconds}, which is not a duration.`,
      );
    }
    if (objective.rpoSeconds === 0 && objective.rpoBasis !== 'synchronous-replication') {
      report(
        objective.id,
        'rpo-zero-without-synchronous-basis',
        `rpoSeconds is 0 on basis '${objective.rpoBasis}'. Zero data loss is a property of a ` +
          'synchronous commit and of nothing else; on a restore path it is the flattering half ' +
          'of a conflation this catalogue exists to keep apart.',
      );
    }
    if (objective.rpoSeconds > 0 && objective.rpoBasis === 'synchronous-replication') {
      report(
        objective.id,
        'rpo-nonzero-on-synchronous-basis',
        `rpoSeconds is ${objective.rpoSeconds} on basis 'synchronous-replication', which loses ` +
          'nothing by construction. Either the basis is wrong — an asynchronous replica ' +
          'described as a standby — or the number is padding on a guarantee that does not need it.',
      );
    }

    if (!(GAME_DAY_METRICS as readonly string[]).includes(objective.measuredBy)) {
      report(
        objective.id,
        'measured-by-unknown-metric',
        `measuredBy '${objective.measuredBy}' is not a metric anything publishes. The objective ` +
          `then has no measurement behind it, which reads the same as having one. Known: ` +
          `${GAME_DAY_METRICS.join(', ')}.`,
      );
    }

    if (
      objective.rehearsalIntervalDays > MAX_REHEARSAL_INTERVAL_DAYS ||
      objective.rehearsalIntervalDays < MIN_REHEARSAL_INTERVAL_DAYS
    ) {
      report(
        objective.id,
        'rehearsal-interval-out-of-range',
        `rehearsalIntervalDays is ${objective.rehearsalIntervalDays}; it must be between ` +
          `${MIN_REHEARSAL_INTERVAL_DAYS} and ${MAX_REHEARSAL_INTERVAL_DAYS}. Longer is a way ` +
          'of writing "never" that passes review; shorter puts the overdue alarm in ALARM most ' +
          'of the time, which is how it gets filtered.',
      );
    }

    const exercising = scenariosFor(objective, scenarios);
    if (objective.status === 'rehearsed' && exercising.length === 0) {
      report(
        objective.id,
        'objective-rehearsed-without-scenario',
        "status is 'rehearsed' and no scenario exercises it. Nothing will ever write a record " +
          'for it, so it is overdue forever while claiming to be the measured one.',
      );
    }
    if (objective.status === 'declared' && exercising.length > 0) {
      report(
        objective.id,
        'objective-declared-with-scenario',
        `status is 'declared' but ${exercising.map((s) => s.id).join(', ')} exercises it. The ` +
          'status is what decides whether the overdue alarm is armed, so a stale one means the ' +
          'exercise runs and nothing ever reports that it stopped running.',
      );
    }
    if (exercising.length > 1) {
      report(
        objective.id,
        'objective-with-two-scenarios',
        `${exercising.map((s) => s.id).join(' and ')} both exercise it, so each overwrites the ` +
          "other's record and the objective's history is whichever ran last.",
      );
    }
  }

  for (const [id, count] of seenIds) {
    if (count > 1) {
      report(
        id,
        'duplicate-objective-id',
        `objective '${id}' is declared ${count} times; they share one parameter path, so the ` +
          'second one silently reads and overwrites the first one\'s record.',
      );
    }
  }
  for (const [anchor, ids] of seenAnchors) {
    if (ids.length > 1) {
      report(
        '<catalogue>',
        'duplicate-objective-anchor',
        `anchor '${anchor}' is claimed by ${ids.join(', ')}. Two objectives pointing at one ` +
          'section means one of them is undocumented.',
      );
    }
  }
  for (const [path, ids] of seenPaths) {
    if (ids.length > 1) {
      report(
        '<catalogue>',
        'duplicate-recovery-path',
        `path '${path}' has two objectives (${ids.join(', ')}). One mechanism cannot have two ` +
          'RTOs; whichever is quoted in an incident will be the kinder one.',
      );
    }
  }

  const seenScenarioIds = new Map<string, number>();
  for (const scenario of scenarios) {
    seenScenarioIds.set(scenario.id, (seenScenarioIds.get(scenario.id) ?? 0) + 1);

    if (!KEBAB_CASE.test(scenario.id)) {
      report(
        scenario.id,
        'scenario-id-not-kebab-case',
        `id '${scenario.id}' must be lower-case kebab-case: it becomes part of an SSM ` +
          'Automation document name.',
      );
    }
    if (!scenario.title.trim() || !scenario.summary.trim()) {
      report(
        scenario.id,
        'scenario-description-missing',
        'title and summary are both required: the approval step shows them, and an approval ' +
          'request that does not say what is about to happen to production gets approved anyway.',
      );
    }
    if (objectiveFor(scenario, objectives) === undefined) {
      report(
        scenario.id,
        'scenario-objective-unknown',
        `objectiveId '${scenario.objectiveId}' is not in the catalogue. The exercise runs, ` +
          'injects a real fault into a real environment, and has nothing to compare its result ' +
          'against or anywhere to record it.',
      );
    }

    if (scenario.allowedEnvironments.length === 0) {
      report(
        scenario.id,
        'scenario-without-allowed-environments',
        'allowedEnvironments is empty, so nothing constrains where this fault may be injected. ' +
          'The blast radius is the one property of a game day that has to be declared rather ' +
          'than remembered.',
      );
    }
    for (const environment of scenario.allowedEnvironments) {
      if (environment.includes('*')) {
        report(
          scenario.id,
          'scenario-allowed-environment-wildcard',
          `allowedEnvironments contains '${environment}'. A wildcard blast radius is how a ` +
            'failover gets injected into production by somebody who believed they were in staging.',
        );
      }
    }

    const destructive = DESTRUCTIVE_FAULTS.includes(scenario.fault);
    if (destructive && scenario.trigger !== 'approval') {
      report(
        scenario.id,
        'destructive-scenario-without-approval',
        `fault '${scenario.fault}' changes a live instance and trigger is '${scenario.trigger}'. ` +
          'A destructive exercise a machine can start is an outage nobody chose, at an hour ' +
          'nobody chose. Every fault in DESTRUCTIVE_FAULTS has to begin with aws:approve.',
      );
    }

    if (scenario.trigger === 'schedule') {
      if (destructive) {
        // Reported above as well, and deliberately: this one is about the
        // schedule rather than about the approval, and a reader fixing the first
        // finding by removing the schedule should see that both halves agreed.
        report(
          scenario.id,
          'destructive-scenario-scheduled',
          `fault '${scenario.fault}' is destructive and this scenario carries a schedule. ` +
            'Nothing in this repository starts a deliberate production outage on a timer.',
        );
      }
      const interval = scenario.scheduleIntervalDays;
      if (interval === undefined || !Number.isFinite(interval) || interval <= 0) {
        report(
          scenario.id,
          'scheduled-scenario-without-interval',
          `trigger is 'schedule' and scheduleIntervalDays is ${String(interval)}. There is then ` +
            'nothing to build the EventBridge rule from, and the exercise that was supposed to ' +
            'be the one nobody has to remember is the one nothing runs.',
        );
      } else {
        const objective = objectiveFor(scenario, objectives);
        if (objective !== undefined && interval > objective.rehearsalIntervalDays) {
          report(
            scenario.id,
            'schedule-slower-than-rehearsal-interval',
            `it runs every ${interval} days against an objective whose shelf life is ` +
              `${objective.rehearsalIntervalDays} days. The overdue alarm is then red for ` +
              `${interval - objective.rehearsalIntervalDays} days of every cycle, with nothing ` +
              'anybody can do about it but widen the interval they just chose — which is how an ' +
              'alarm about a stale DR number acquires a filter rule.',
          );
        }
      }
    } else if (scenario.scheduleIntervalDays !== undefined) {
      report(
        scenario.id,
        'approval-scenario-with-interval',
        `trigger is '${scenario.trigger}' and scheduleIntervalDays is ` +
          `${scenario.scheduleIntervalDays}. Nothing reads that number, so it is a cadence this ` +
          'catalogue appears to commit to and nothing honours.',
      );
    }

    for (const check of scenario.preflight) {
      if (!(PREFLIGHT_CHECKS as readonly string[]).includes(check)) {
        report(
          scenario.id,
          'scenario-preflight-unknown',
          `preflight names '${check}', which nothing implements, so it is a comment. Known: ` +
            `${PREFLIGHT_CHECKS.join(', ')}.`,
        );
      }
    }
    if (new Set(scenario.preflight).size !== scenario.preflight.length) {
      report(scenario.id, 'scenario-preflight-duplicated', 'preflight lists a check twice.');
    }
    if (scenario.fault === 'rds-force-failover' && !scenario.preflight.includes('multi-az-enabled')) {
      report(
        scenario.id,
        'failover-without-multi-az-preflight',
        "a 'rds-force-failover' scenario must preflight 'multi-az-enabled'. On a Single-AZ " +
          'instance the same call is a reboot: the probe records an outage, the exercise ' +
          'reports a measured RTO, and the number is for a failover that never happened.',
      );
    }
    const measuredObjective = objectiveFor(scenario, objectives);
    const probeMeasured =
      measuredObjective !== undefined && PROBE_METRICS.includes(measuredObjective.measuredBy);
    if (probeMeasured && !scenario.preflight.includes('probe-reporting')) {
      report(
        scenario.id,
        'scenario-without-probe-preflight',
        "it measures '" + measuredObjective.measuredBy + "', which comes from the probe, and it " +
          "does not preflight 'probe-reporting'. With the probe stopped the measurement window " +
          'is empty, and an exercise that cannot measure anything is worse than one that was ' +
          'not run — it produces a record.',
      );
    }
    if (!probeMeasured && scenario.preflight.includes('probe-reporting')) {
      report(
        scenario.id,
        'scenario-with-irrelevant-probe-preflight',
        "it preflights 'probe-reporting' and nothing in its measurement comes from the probe. A " +
          'check that cannot fail for any reason the exercise cares about is the kind of green ' +
          'that teaches people to stop reading the others.',
      );
    }

    if (scenario.fault === 'rds-point-in-time-restore') {
      for (const required of ['restore-point-available', 'no-drill-instance-present'] as const) {
        if (scenario.preflight.includes(required)) continue;
        report(
          scenario.id,
          'restore-drill-without-required-preflight',
          `a 'rds-point-in-time-restore' scenario must preflight '${required}'. Without ` +
            "'restore-point-available' the drill's most important finding — there is no restore " +
            'path at all — arrives as an opaque InvalidDBInstanceState rather than as a refusal ' +
            "that says so; without 'no-drill-instance-present' a run that starts while an " +
            "earlier drill's copy is still up tears that copy down mid-verification and reports " +
            'the restore as unverifiable.',
        );
      }
      for (const required of ['verification-failed', 'restore-not-available-in-time'] as const) {
        if (scenario.abortIf.includes(required)) continue;
        report(
          scenario.id,
          'restore-drill-without-required-abort',
          `a 'rds-point-in-time-restore' scenario must declare abortIf '${required}'. Both are ` +
            'results rather than hitches — a copy that came back unusable, and a restore slower ' +
            'than the objective — and a drill that does not name them as outcomes is one whose ' +
            'record cannot tell them from an exercise nobody ran.',
        );
      }
    }

    for (const condition of scenario.abortIf) {
      if (!(ABORT_CONDITIONS as readonly string[]).includes(condition)) {
        report(
          scenario.id,
          'scenario-abort-condition-unknown',
          `abortIf names '${condition}', which nothing implements. Known: ` +
            `${ABORT_CONDITIONS.join(', ')}.`,
        );
      }
    }
    if (!scenario.abortIf.includes('operator-abort')) {
      report(
        scenario.id,
        'scenario-without-operator-abort',
        "abortIf must include 'operator-abort'. An exercise a human cannot stop is not an " +
          'exercise.',
      );
    }

    if (!Number.isFinite(scenario.expectedDurationMinutes) || scenario.expectedDurationMinutes <= 0) {
      report(
        scenario.id,
        'scenario-duration-not-positive',
        `expectedDurationMinutes is ${scenario.expectedDurationMinutes}. It is what goes in the ` +
          'calendar invite, and a game day nobody booked time for is one that gets abandoned ' +
          'halfway.',
      );
    }
  }

  for (const [id, count] of seenScenarioIds) {
    if (count > 1) {
      report(
        id,
        'duplicate-scenario-id',
        `scenario '${id}' is declared ${count} times; both map to one automation document name, ` +
          'so the second definition is the one that deploys and the first is unreachable.',
      );
    }
  }

  return findings;
};

/**
 * Throw on any violation. Used by `FailoverGameDayStack`.
 *
 * All of them are reported, not just the first: a bad entry usually produces
 * several, and fixing them one synth at a time is how the last one gets
 * committed.
 */
export const assertValidGameDayCatalogue = (
  objectives: readonly RecoveryObjective[] = RECOVERY_OBJECTIVES,
  scenarios: readonly GameDayScenario[] = GAME_DAY_SCENARIOS,
): void => {
  const findings = validateGameDayCatalogue(objectives, scenarios);
  if (findings.length > 0) {
    throw new Error(
      'The game-day catalogue is invalid:\n' +
        findings.map((f) => `  [${f.rule}] ${f.subject}: ${f.message}`).join('\n') +
        '\nSee docs/game-days.md.',
    );
  }
};
