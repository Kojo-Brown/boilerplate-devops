/**
 * The SLO catalogue: every objective this account measures, written down once.
 *
 * Before this file the repository had burn-rate alarms and no SLOs. The numbers
 * they burn against — `{ target: 0.999, windowDays: 30, minimumRequestsPerWindow: 60 }`
 * — were literals in `bin/app.ts`, passed to a stack whose job is to roll back
 * deployments. That works as an actuator and fails as an objective: nothing
 * records who owns the number, what it is measured on, what happens when the
 * budget runs out, or whether the same number is used consistently by the two
 * stacks that reference it. An SLO that exists only as an argument to a Lambda
 * cannot be reviewed, cannot be reported on, and cannot be the thing a release
 * decision is made against.
 *
 * So the objectives live here, as data with no CDK tokens in it, which is what
 * makes them reviewable in a diff and readable by `tools/audit-slo-definitions.ts`.
 * `SloStack` turns each one into burn-rate alarms, an error-budget reporter and a
 * dashboard; `bin/app.ts` derives `SloBurnRateRollbackStack`'s objective from the
 * same entries rather than restating them.
 *
 * Three things in here are easy to get wrong in a way that looks healthy, and
 * each has a rule in {@link validateSloDefinition}:
 *
 *   1. A burn-rate alarm that can never fire. Burn rate is the observed error
 *      ratio divided by the error budget, and an error ratio cannot exceed 1, so
 *      a policy needs `burnRate × errorBudget ≤ 1` to be reachable at all. A
 *      14.4x policy against a 90% objective needs a 144% error ratio: the alarm
 *      deploys, evaluates, stays green through a total outage and is
 *      indistinguishable in the console from one that is working.
 *
 *   2. A traffic floor that pages on a single failed request. Every burn-rate
 *      window needs a minimum event count before its ratio is believed,
 *      otherwise one failure in a window of three reads as a 33% error ratio.
 *      The floor has to be large enough that *one* bad event does not by itself
 *      cross the threshold — `floor ≥ 1 / (burnRate × errorBudget)` — and
 *      because that bound does not scale with the window while traffic does, the
 *      floor is declared as a rate ({@link Sli.minimumEventsPerMinute}) and
 *      multiplied out per window. A single number applied to a 5-minute and a
 *      24-hour window is wrong for one of them by construction.
 *
 *   3. A latency objective built from `TargetResponseTime`. An SLI is a ratio of
 *      good events to valid events, and a percentile is not a count: CloudWatch
 *      cannot aggregate `p99` over a window (the p99 of twelve five-minute p99s
 *      is not the p99 of the hour), so there is no burn rate to compute from it.
 *      An alarm on `p99 > 0.3` is a useful latency alarm and is not a latency
 *      SLO. Getting one needs a good-event count the application emits itself,
 *      which is why `production-api-latency` below is `proposed` rather than
 *      `active` — see docs/slo.md §5.
 *
 * See docs/slo.md.
 */

/** Who an alert wakes. */
export type SloSeverity = 'page' | 'ticket';

/**
 * Lifecycle of a catalogue entry.
 *
 * `active`   — wired into a stack, alarming. The audit gate requires it.
 * `proposed` — agreed and documented, but its SLI has no source yet. Must carry
 *              {@link SloDefinition.blockedOn} and must *not* be wired: an
 *              alarm over a metric nothing publishes sits in INSUFFICIENT_DATA
 *              forever, which is how a dashboard ends up with a permanently
 *              amber tile everyone has learned to ignore.
 */
export type SloStatus = 'active' | 'proposed';

/**
 * A multi-window burn-rate alert policy, in the shape the Google SRE workbook
 * describes.
 *
 * `burnRate` is a multiple of the pace that would consume the entire error
 * budget in exactly one SLO window. Burning at 1x for 30 days spends a 30-day
 * budget precisely; burning at 14.4x spends 2% of it in an hour.
 *
 * The two windows are an AND, and each cancels a specific failure of the other:
 *
 *   `longWindowMinutes` decides significance. A five-minute spike that never
 *   recurs is not worth waking anyone for, and a long window refuses to see it.
 *
 *   `shortWindowMinutes` decides currency. A long window stays above the
 *   threshold long after the incident ends, because the errors are still inside
 *   it — so on its own it keeps paging about a service that has recovered.
 */
export interface BurnRateAlertPolicy {
  /** Identifier used in alarm names, e.g. `fast`. Lower-case, kebab-case. */
  readonly name: string;
  /** Burn-rate multiple both windows must exceed. */
  readonly burnRate: number;
  /** Long window, in whole minutes. At most 1440 — see {@link MAX_ALARM_WINDOW_MINUTES}. */
  readonly longWindowMinutes: number;
  /** Short window, in whole minutes. Conventionally 1/12th of the long window. */
  readonly shortWindowMinutes: number;
  /** Where the alert goes. */
  readonly severity: SloSeverity;
  /** Rationale, copied into the alarm description. */
  readonly description: string;
}

/**
 * The largest period a CloudWatch alarm can evaluate: 24 hours.
 *
 * This is why the catalogue has an error-budget reporter and not only alarms.
 * The workbook's third tier is 1x over three days, which is not expressible as
 * an alarm period; the 24-hour policy below is the closest thing that is, and
 * the slower drift it cannot see is what
 * `ErrorBudgetRemainingPercent` exists to catch.
 */
export const MAX_ALARM_WINDOW_MINUTES = 1440;

/**
 * Fast, medium and slow burn: 2% of a 30-day budget in an hour, 5% in six
 * hours, 3.3% in a day.
 *
 * The first two page. The slow policy raises a ticket, because it fires hours
 * after whatever caused it and the useful response is an investigation during
 * working hours, not a phone call at 04:00 about a regression that has already
 * been burning for a day.
 */
export const DEFAULT_BURN_RATE_ALERT_POLICIES: readonly BurnRateAlertPolicy[] = [
  {
    name: 'fast',
    burnRate: 14.4,
    longWindowMinutes: 60,
    shortWindowMinutes: 5,
    severity: 'page',
    description:
      '2% of the error budget consumed in one hour, still burning over the last five minutes',
  },
  {
    name: 'medium',
    burnRate: 6,
    longWindowMinutes: 360,
    shortWindowMinutes: 30,
    severity: 'page',
    description:
      '5% of the error budget consumed in six hours, still burning over the last thirty minutes',
  },
  {
    name: 'slow',
    burnRate: 1,
    longWindowMinutes: MAX_ALARM_WINDOW_MINUTES,
    shortWindowMinutes: 120,
    severity: 'ticket',
    description:
      'budget burning at the rate that would exhaust it exactly on schedule, sustained for a day',
  },
];

/** Common to every SLI: how much traffic is needed before a ratio is believed. */
interface SliBase {
  /**
   * Events per minute below which the service is too quiet to measure.
   *
   * Multiplied by each window's length to produce that window's floor, so one
   * declaration covers a 5-minute and a 24-hour window correctly. Below the
   * floor a window's burn rate is reported as zero rather than as no data,
   * because "not enough traffic to tell" and "the metric pipeline is down" need
   * different responses and only the second is an incident.
   *
   * This is a statement about expected traffic, not a knob: set it to the floor
   * of what the service actually receives. Setting it too low is the defect
   * {@link validateSloDefinition} reports as `traffic-floor-single-event`.
   */
  readonly minimumEventsPerMinute: number;
}

/** Good events are the ones that did not fail. */
export interface AvailabilitySli extends SliBase {
  readonly kind: 'availability';
}

/**
 * Good events are the ones that completed within {@link thresholdSeconds}.
 *
 * Deliberately not derivable from ALB metrics — see the header note (3). A
 * latency SLI needs a count of fast requests, which means the application or
 * its collector emits one.
 */
export interface LatencySli extends SliBase {
  readonly kind: 'latency';
  /** Requests completing at or under this many seconds are good events. */
  readonly thresholdSeconds: number;
}

export type Sli = AvailabilitySli | LatencySli;

export interface SloDefinition {
  /** Unique, stable, kebab-case. Used in alarm names and metric dimensions. */
  readonly id: string;
  /** The service the objective is about, e.g. `api`. */
  readonly service: string;
  /** Deployment environment: `production`, `staging`. */
  readonly envName: string;
  /** What is counted. */
  readonly sli: Sli;
  /**
   * The objective, as a fraction of good events: `0.999` for three nines.
   * The error budget is `1 - objective`.
   */
  readonly objective: number;
  /** Rolling window the objective is stated over, in days. */
  readonly windowDays: number;
  /**
   * The team accountable for the budget, never an individual — an SLO outlives
   * anyone's time on a rota, and an owner who has left is an owner nobody
   * notices is missing.
   */
  readonly owner: string;
  /** Runbook for the burn-rate alerts. Must be a real URL. */
  readonly runbookUrl: string;
  /** One line, for alarm descriptions and the dashboard header. */
  readonly description: string;
  /** See {@link SloStatus}. */
  readonly status: SloStatus;
  /** Required when `status` is `proposed`: what has to exist first. */
  readonly blockedOn?: string;
  /** Override {@link DEFAULT_BURN_RATE_ALERT_POLICIES} for this objective. */
  readonly burnRatePolicies?: readonly BurnRateAlertPolicy[];
  /**
   * Raise a ticket when less than this percentage of the budget is left
   * (default {@link DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT}).
   *
   * This is the signal burn-rate alarms structurally cannot produce: a month of
   * small, individually unalarming regressions spends the budget without any
   * window ever crossing a threshold.
   */
  readonly budgetAlertThresholdPercent?: number;
}

/** Remaining-budget percentage that raises a ticket. */
export const DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT = 25;

/**
 * The objectives this account measures.
 *
 * Staging runs a looser objective than production deliberately, and a looser
 * traffic floor with it: a boilerplate that pages on staging noise gets its
 * alarms muted, and a muted alarm is worse than no alarm.
 */
export const SLO_CATALOGUE: readonly SloDefinition[] = [
  {
    id: 'production-api-availability',
    service: 'api',
    envName: 'production',
    sli: { kind: 'availability', minimumEventsPerMinute: 15 },
    objective: 0.999,
    windowDays: 30,
    owner: 'platform-team',
    runbookUrl: 'https://github.com/Kojo-Brown/boilerplate-devops/blob/main/docs/slo.md#7-responding-to-a-burn-rate-alert',
    description:
      'HTTP requests to the production API that did not fail, measured at the load balancer',
    status: 'active',
  },
  {
    id: 'staging-api-availability',
    service: 'api',
    envName: 'staging',
    sli: { kind: 'availability', minimumEventsPerMinute: 3 },
    objective: 0.995,
    windowDays: 30,
    owner: 'platform-team',
    runbookUrl: 'https://github.com/Kojo-Brown/boilerplate-devops/blob/main/docs/slo.md#7-responding-to-a-burn-rate-alert',
    description:
      'HTTP requests to the staging API that did not fail, measured at the load balancer',
    status: 'active',
    // Staging pages nobody. The fast and medium policies are kept so the
    // catalogue's shape is the same in both environments and a policy change is
    // exercised on staging first; `SloStack` routes staging severities to the
    // ticket topic.
  },
  {
    id: 'production-api-latency',
    service: 'api',
    envName: 'production',
    sli: { kind: 'latency', thresholdSeconds: 0.3, minimumEventsPerMinute: 15 },
    objective: 0.99,
    windowDays: 30,
    owner: 'platform-team',
    runbookUrl: 'https://github.com/Kojo-Brown/boilerplate-devops/blob/main/docs/slo.md#5-wiring-a-latency-sli',
    description: 'Production API requests served within 300ms',
    status: 'proposed',
    blockedOn:
      'ALB publishes no count of requests under a latency threshold, and TargetResponseTime ' +
      'percentiles cannot be aggregated into one, so this needs the application to emit ' +
      'good/valid counts as EMF through the OTel collector — docs/slo.md §5 has the contract.',
  },
];

/** The entry with this id, or `undefined`. */
export const sloById = (id: string, catalogue: readonly SloDefinition[] = SLO_CATALOGUE) =>
  catalogue.find((slo) => slo.id === id);

/**
 * The entry with this id, or a throw naming what is available.
 *
 * `bin/app.ts` wires stacks by id, and a typo there should fail at synth with a
 * usable message rather than produce a stack with no SLOs in it.
 */
export const requireSlo = (
  id: string,
  catalogue: readonly SloDefinition[] = SLO_CATALOGUE,
): SloDefinition => {
  const found = sloById(id, catalogue);
  if (found === undefined) {
    throw new Error(
      `No SLO definition with id '${id}'. Defined ids: ${catalogue.map((slo) => slo.id).join(', ')}.`,
    );
  }
  return found;
};

/** Decimal places in a number's own decimal notation. `0` for exponential form. */
const decimalPlaces = (value: number): number => {
  const text = value.toString();
  if (text.includes('e') || text.includes('E')) return 0;
  const point = text.indexOf('.');
  return point === -1 ? 0 : text.length - point - 1;
};

/**
 * `1 - objective`, without the float noise.
 *
 * `1 - 0.999` is `0.0010000000000000009` in binary floating point, and that is
 * what would be written into a CloudWatch metric-math expression and read by
 * whoever opens the alarm.
 *
 * Rounded to the objective's own precision rather than to a fixed number of
 * significant figures, because an error budget has exactly as many decimal places
 * as the objective it came from. `toPrecision(12)` looks like plenty and is not:
 * `1 - 0.99999` at twelve significant figures is `0.00000999999999995`, so the
 * one objective where the noise is most visible — five nines, where the budget is
 * five decimal places down — is the one it fails to clean up.
 */
export const errorBudgetFor = (objective: number): number => {
  const places = decimalPlaces(objective);
  const budget = 1 - objective;
  return places > 0 ? Number(budget.toFixed(places)) : Number(budget.toPrecision(12));
};

/** The error budget implied by an objective: `1 - objective`. */
export const errorBudgetRatio = (slo: SloDefinition): number => errorBudgetFor(slo.objective);

/** The policies in force for this objective. */
export const policiesFor = (slo: SloDefinition): readonly BurnRateAlertPolicy[] =>
  slo.burnRatePolicies ?? DEFAULT_BURN_RATE_ALERT_POLICIES;

/** Minutes in the SLO window. */
export const windowMinutes = (slo: SloDefinition): number => slo.windowDays * 24 * 60;

/**
 * Minimum events a window of `minutes` needs before its burn rate is believed.
 *
 * The rate times the window, floored at one event: a zero floor would divide by
 * a zero denominator on the first quiet minute.
 */
export const windowFloorEvents = (slo: SloDefinition, minutes: number): number =>
  Math.max(1, Math.ceil(slo.sli.minimumEventsPerMinute * minutes));

/**
 * The smallest window floor at which a *single* bad event does not on its own
 * exceed `burnRate`.
 *
 * One bad event in a window of `n` is an error ratio of `1/n`, so a burn rate of
 * `1 / (n × errorBudget)`. Below this floor the alarm is a single-error pager
 * dressed as an objective, and it only behaves that way at the traffic floor —
 * which is exactly where the floor was supposed to protect it.
 */
export const singleEventFloor = (slo: SloDefinition, burnRate: number): number =>
  Math.ceil(1 / (burnRate * errorBudgetRatio(slo)));

/**
 * A single event floor that satisfies every policy, for consumers that take one
 * count rather than a rate.
 *
 * `SloBurnRateRollbackStack` is the case: it applies one
 * `minimumRequestsPerWindow` to both of its windows. Handing it the largest
 * per-policy floor is deliberately conservative — it mutates production, so a
 * rollback that does not happen on thin traffic is a better failure than one
 * that pulls a healthy revision out of service because a single request 502'd
 * at 04:00.
 */
export const significanceFloorEvents = (slo: SloDefinition): number =>
  Math.max(...policiesFor(slo).map((policy) => singleEventFloor(slo, policy.burnRate)));

/** `0.999` → `99.9%`, without the float noise of a naive multiply. */
export const formatObjective = (objective: number): string =>
  `${Math.round(objective * 1e6) / 1e4}%`;

/** `360` → `6h`, `90` → `1h30m`, `5` → `5m`. */
export const describeMinutes = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h${remainder}m`;
};

/**
 * Fraction of the error budget a policy spends inside its own long window.
 *
 * `14.4x` over an hour against a 30-day window is `14.4 × 60 / 43200` = 2%.
 */
export const budgetFractionPerPolicy = (
  slo: SloDefinition,
  policy: BurnRateAlertPolicy,
): number => (policy.burnRate * policy.longWindowMinutes) / windowMinutes(slo);

/**
 * Longest SLO window the budget reporter can read.
 *
 * CloudWatch retains one-hour datapoints for 455 days, and the reporter reads
 * the whole window at a one-hour period in a single `GetMetricData` call.
 */
export const MAX_WINDOW_DAYS = 455;

/** A rule violation in a catalogue entry. */
export interface SloFinding {
  /** Id of the offending entry, or `<catalogue>` for a cross-entry rule. */
  readonly sloId: string;
  /** Stable rule name, for suppression discussions and docs. */
  readonly rule: string;
  readonly message: string;
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every rule that can be decided from one entry.
 *
 * Returns findings rather than throwing so that the audit gate can report all of
 * them at once; `SloStack` throws on the first, because a stack that synthesises
 * an unreachable alarm is worse than one that fails to synthesise.
 */
export const validateSloDefinition = (slo: SloDefinition): SloFinding[] => {
  const findings: SloFinding[] = [];
  const report = (rule: string, message: string) =>
    findings.push({ sloId: slo.id, rule, message });

  if (!KEBAB_CASE.test(slo.id)) {
    report(
      'id-not-kebab-case',
      `id '${slo.id}' must be lower-case kebab-case: it becomes part of an alarm name and a metric dimension value.`,
    );
  }

  if (!Number.isFinite(slo.objective) || slo.objective <= 0 || slo.objective >= 1) {
    report(
      'objective-out-of-range',
      `objective must be a fraction strictly between 0 and 1 (got ${slo.objective}); 99.9% is 0.999, not 99.9.`,
    );
    // Every remaining rule divides by the error budget. Reporting them against a
    // nonsensical objective would bury the one finding that matters.
    return findings;
  }

  const budget = errorBudgetRatio(slo);

  if (!Number.isInteger(slo.windowDays) || slo.windowDays < 1) {
    report(
      'window-days-invalid',
      `windowDays must be a positive whole number of days (got ${slo.windowDays}).`,
    );
  } else if (slo.windowDays > MAX_WINDOW_DAYS) {
    report(
      'window-days-too-long',
      `windowDays ${slo.windowDays} exceeds ${MAX_WINDOW_DAYS}: the budget reporter reads the window at a ` +
        `one-hour period, and CloudWatch retains one-hour datapoints for 455 days, so a longer window ` +
        `silently reports on a truncated one.`,
    );
  }

  if (!Number.isFinite(slo.sli.minimumEventsPerMinute) || slo.sli.minimumEventsPerMinute <= 0) {
    report(
      'traffic-rate-invalid',
      `sli.minimumEventsPerMinute must be greater than zero (got ${slo.sli.minimumEventsPerMinute}); ` +
        `a zero floor divides the error ratio by a zero denominator.`,
    );
  }

  if (slo.sli.kind === 'latency' && !(slo.sli.thresholdSeconds > 0)) {
    report(
      'latency-threshold-invalid',
      `sli.thresholdSeconds must be greater than zero (got ${slo.sli.thresholdSeconds}).`,
    );
  }

  const threshold = slo.budgetAlertThresholdPercent ?? DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT;
  if (!(threshold > 0) || threshold >= 100) {
    report(
      'budget-alert-threshold-invalid',
      `budgetAlertThresholdPercent must be between 0 and 100 exclusive (got ${threshold}); at 100 the ` +
        `alarm is in ALARM from the first failed request, at 0 it never fires before the budget is gone.`,
    );
  }

  if (slo.status === 'proposed' && !slo.blockedOn) {
    report(
      'proposed-without-blocker',
      `status 'proposed' requires blockedOn: an objective nobody is measuring and nobody has recorded a ` +
        `reason for is an objective that will still be proposed next year.`,
    );
  }
  if (slo.status === 'active' && slo.blockedOn) {
    report(
      'active-with-blocker',
      `status 'active' must not carry blockedOn (${slo.blockedOn}): if the blocker is real the objective is ` +
        `not active, and if it is stale it is describing an alarm that exists.`,
    );
  }

  if (!slo.owner) {
    report('owner-missing', 'owner is required: a budget with no owner is nobody\'s to spend.');
  } else if (slo.owner.includes('@')) {
    report(
      'owner-is-an-individual',
      `owner '${slo.owner}' looks like a person. An SLO outlives anyone's time on a rota; name the team.`,
    );
  }

  if (!/^https:\/\/\S+$/.test(slo.runbookUrl)) {
    report(
      'runbook-url-invalid',
      `runbookUrl must be an https URL (got '${slo.runbookUrl}').`,
    );
  } else if (/example\.(com|org|net)|TODO|FIXME|changeme/i.test(slo.runbookUrl)) {
    report(
      'runbook-url-placeholder',
      `runbookUrl '${slo.runbookUrl}' is a placeholder. A link nobody can follow is worse than no link: ` +
        `it is read as a runbook having been written.`,
    );
  }

  const policies = policiesFor(slo);
  if (policies.length === 0) {
    report('no-burn-rate-policies', 'burnRatePolicies must contain at least one policy.');
  }

  const seenPolicyNames = new Set<string>();
  for (const policy of policies) {
    const label = `policy '${policy.name}'`;

    if (seenPolicyNames.has(policy.name)) {
      report(
        'duplicate-policy-name',
        `${label} is declared twice; the two would collide on one alarm name and CloudFormation would ` +
          `reject the stack.`,
      );
    }
    seenPolicyNames.add(policy.name);

    if (!KEBAB_CASE.test(policy.name)) {
      report('policy-name-not-kebab-case', `${label} must be lower-case kebab-case.`);
    }

    for (const [field, minutes] of [
      ['longWindowMinutes', policy.longWindowMinutes],
      ['shortWindowMinutes', policy.shortWindowMinutes],
    ] as const) {
      if (!Number.isInteger(minutes) || minutes <= 0) {
        report(
          'policy-window-invalid',
          `${label} ${field} must be a positive whole number of minutes (got ${minutes}); CloudWatch ` +
            `periods are whole minutes and an alarm rounding its own window evaluates a different burn ` +
            `rate than the one written here.`,
        );
      }
    }

    if (policy.shortWindowMinutes >= policy.longWindowMinutes) {
      report(
        'policy-windows-not-nested',
        `${label} has a short window (${policy.shortWindowMinutes}m) that is not shorter than its long ` +
          `window (${policy.longWindowMinutes}m); the short window exists to say the burn is still ` +
          `happening, which it cannot do over the same span.`,
      );
    }

    if (policy.longWindowMinutes > MAX_ALARM_WINDOW_MINUTES) {
      report(
        'policy-window-exceeds-alarm-maximum',
        `${label} long window ${policy.longWindowMinutes}m exceeds the ${MAX_ALARM_WINDOW_MINUTES}m maximum ` +
          `period of a CloudWatch alarm. Slower drift than a day is what the error-budget alarms cover.`,
      );
    }

    if (!(policy.burnRate > 0)) {
      report('policy-burn-rate-invalid', `${label} burnRate must be greater than zero.`);
      continue;
    }

    if (policy.burnRate * budget > 1) {
      report(
        'policy-unreachable',
        `${label} needs an error ratio of ${Math.round(policy.burnRate * budget * 1000) / 10}% to fire ` +
          `(burnRate ${policy.burnRate} × error budget ${budget}), and an error ratio cannot exceed 100%. ` +
          `This alarm deploys, evaluates and stays green through a total outage. Cap the burn rate at ` +
          `${Math.floor((1 / budget) * 10) / 10} for a ${formatObjective(slo.objective)} objective, or ` +
          `tighten the objective.`,
      );
    }

    if (budgetFractionPerPolicy(slo, policy) > 1) {
      report(
        'policy-spends-more-than-the-budget',
        `${label} claims ${Math.round(budgetFractionPerPolicy(slo, policy) * 100)}% of the ` +
          `${slo.windowDays}-day budget inside its own ${describeMinutes(policy.longWindowMinutes)} window, ` +
          `which is more budget than exists. The window and the burn rate disagree about the SLO window.`,
      );
    }

    // The single-event rule is checked on the short window because it is the
    // smaller of the two and therefore the binding one.
    const shortFloor = windowFloorEvents(slo, policy.shortWindowMinutes);
    const required = singleEventFloor(slo, policy.burnRate);
    if (shortFloor < required) {
      const requiredRate = Math.ceil(required / policy.shortWindowMinutes);
      report(
        'traffic-floor-single-event',
        `${label} short window is ${policy.shortWindowMinutes}m, which at ` +
          `${slo.sli.minimumEventsPerMinute} events/min floors at ${shortFloor} events — below the ` +
          `${required} needed for one bad event not to exceed ${policy.burnRate}x on its own. At the ` +
          `traffic floor this alarm is a single-error pager. Raise sli.minimumEventsPerMinute to ` +
          `${requiredRate}, lengthen the short window, or drop the policy for this objective.`,
      );
    }
  }

  return findings;
};

/** Every rule above, plus the ones that need the whole catalogue. */
export const validateSloCatalogue = (
  catalogue: readonly SloDefinition[] = SLO_CATALOGUE,
): SloFinding[] => {
  const findings = catalogue.flatMap(validateSloDefinition);

  const byId = new Map<string, number>();
  for (const slo of catalogue) byId.set(slo.id, (byId.get(slo.id) ?? 0) + 1);
  for (const [id, count] of byId) {
    if (count > 1) {
      findings.push({
        sloId: id,
        rule: 'duplicate-id',
        message: `id '${id}' is defined ${count} times. Ids become alarm names and metric dimensions, so ` +
          `the second entry would overwrite the first's metrics and collide on its alarms.`,
      });
    }
  }

  return findings;
};

/**
 * Throw on the first violation. Used by `SloStack`.
 *
 * All of them are reported, not just the first: a wrong objective usually
 * produces several, and fixing them one synth at a time is how the last one
 * gets committed.
 */
export const assertValidSlo = (slo: SloDefinition): void => {
  const findings = validateSloDefinition(slo);
  if (findings.length > 0) {
    throw new Error(
      `SLO '${slo.id}' is invalid:\n` +
        findings.map((f) => `  [${f.rule}] ${f.message}`).join('\n') +
        '\nSee docs/slo.md.',
    );
  }
};
