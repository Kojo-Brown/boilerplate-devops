/**
 * The contract a multi-region synthetic canary fleet has to satisfy, and the
 * one script every canary in it runs.
 *
 * Kept separate from `synthetic-canary-stack.ts` for the same reason
 * `queue-trace-context.ts` is separate from `traced-queue-stack.ts`: the rules
 * below are arithmetic and string handling, they are the part that is wrong in
 * practice, and they are testable without synthesising anything.
 *
 * ## What a synthetic canary is for, and why one region is not enough
 *
 * Every alarm this repository had before this one is measured from inside the
 * system — ECS CPU, ALB 5xx, RDS connections, the SLO burn rate. All of them
 * share a blind spot: if the request never reaches the load balancer, they do
 * not go red, they go **quiet**. An expired certificate, a DNS record pointing
 * at a deleted distribution, a WAF rule that matches every request, a Route 53
 * failover to an empty target — each one is total user-facing failure and an
 * empty `RequestCount`, and CloudWatch does not breach a threshold on a metric
 * that has no data points. A canary is the only probe that sees the system the
 * way a browser does, from outside the account.
 *
 * The moment there is one, there is a second problem, and it is the reason this
 * module exists rather than a single `Canary` construct:
 *
 *   **One region cannot tell "the application is down" from "this probe's
 *   region is having a bad morning."**
 *
 * A canary in us-east-1 that fails might be reporting an outage, or a Lambda
 * cold-start failure in its own region, or a transient network partition
 * between two AWS regions that no user is behind. Paging on it is how a
 * synthetic canary earns a reputation for crying wolf, and the usual reaction —
 * raising the threshold until it stops — leaves a probe that no longer reports
 * the outage either.
 *
 * Running the same probe from several regions answers the question, but only if
 * something compares them. `N` regional alarms are not a comparison: one global
 * outage pages `N` times, and one flaky region pages once, and the two are
 * indistinguishable at 3am. The comparison is a **quorum** — page when at least
 * `quorum` of the probe regions agree, ticket when a single region disagrees,
 * because a single region disagreeing is a statement about reachability from
 * that region and not about the application.
 *
 * ## Why the metrics are republished
 *
 * CloudWatch alarms are regional: an alarm in us-east-1 cannot read a metric in
 * eu-west-1, and no amount of metric math crosses that line. So the quorum
 * cannot be computed from the `CloudWatchSynthetics` metrics the canaries
 * publish locally. Each canary therefore publishes its own verdict a second
 * time, with `PutMetricData` aimed at the aggregation region, carrying a
 * `Region` dimension — and the quorum alarm is ordinary metric math over those
 * series. `SyntheticCanaryStack` keeps the local alarm as well, because the
 * republishing path is itself something that can break.
 *
 * ## The rules, and the failure each one prevents
 *
 *   single-region-fleet          one probe region is the ambiguity above, with
 *                                a quorum alarm over it implying otherwise
 *   duplicate-probe-region       two canaries in one region, counted twice by
 *                                the quorum — a fleet that pages on one region
 *   quorum-below-two             page on any one region: N independent pagers
 *                                again, which is what the quorum replaces
 *   quorum-exceeds-regions       an alarm whose threshold is unreachable; it
 *                                stays green through a total outage
 *   schedule-outside-synthetics-range  Synthetics accepts rate(1 minute) to
 *                                rate(1 hour); outside it the canary fails to
 *                                create, at deploy time, in one region
 *   timeout-exceeds-schedule     runs overlap; CloudWatch Synthetics rejects it
 *   timeout-exceeds-maximum      a canary timeout above the 14-minute ceiling
 *   latency-budget-exceeds-timeout  a latency assertion that can never fail,
 *                                because the run is killed before it is reached
 *   probe-without-body-marker    HTTP 200 is not "the application works": a
 *                                maintenance page, a cached CloudFront error
 *                                page and an SPA shell rendering a spinner all
 *                                return 200
 *   probe-over-plaintext-http    a canary on http:// cannot observe certificate
 *                                expiry, which is one of the outages it is
 *                                most needed for
 *   expected-status-not-success  a probe asserting a 3xx or 4xx is asserting
 *                                about the edge, not about the application
 *   expected-status-without-body 204 and 304 carry no body for the marker to
 *                                match, so the assertion is vacuous
 *   canary-name-too-long         Synthetics names are capped at 21 characters;
 *                                over it, `cdk deploy` fails per region
 *   canary-name-invalid-characters  same, for anything outside [a-z0-9_-]
 *   duplicate-probe-name         two probes producing one canary name, and one
 *                                metric dimension carrying both verdicts
 *   datapoints-exceed-evaluation-periods  CloudFormation rejects it
 *   detection-slower-than-declared  the fleet states a detection budget and the
 *                                alarm arithmetic cannot meet it — schedule x
 *                                datapoints is the real number, and nothing
 *                                reconciles it with the stated one
 */

/** CloudWatch namespace the canaries republish their verdicts into. */
export const CANARY_METRIC_NAMESPACE = 'Boilerplate/SyntheticCanary';

/** 1 when a run failed its assertions, 0 when it passed. */
export const PROBE_FAILURE_METRIC = 'ProbeFailure';
/** End-to-end time of the probe request, in milliseconds. */
export const PROBE_LATENCY_METRIC = 'ProbeLatency';

/** Dimension carrying the environment a probe belongs to. */
export const ENVIRONMENT_DIMENSION = 'Environment';
/** Dimension carrying the probe's name. */
export const PROBE_DIMENSION = 'Probe';
/** Dimension carrying the region the probe ran *from*. */
export const REGION_DIMENSION = 'Region';

/** Tag marking a canary as part of a fleet, valued with the fleet's name. */
export const CANARY_FLEET_TAG = 'SyntheticCanaryFleet';
/** Tag carrying the quorum the fleet's page alarm uses. */
export const CANARY_QUORUM_TAG = 'SyntheticCanaryQuorum';

/* ── Environment variables the shared handler reads ───────────────────────── */

export const PROBE_NAME_ENV_VAR = 'PROBE_NAME';
export const PROBE_ENVIRONMENT_ENV_VAR = 'PROBE_ENVIRONMENT';
export const PROBE_REGION_ENV_VAR = 'PROBE_REGION';
export const PROBE_AGGREGATION_REGION_ENV_VAR = 'PROBE_AGGREGATION_REGION';
export const PROBE_NAMESPACE_ENV_VAR = 'PROBE_METRIC_NAMESPACE';
export const PROBE_URL_ENV_VAR = 'PROBE_URL';
export const PROBE_METHOD_ENV_VAR = 'PROBE_METHOD';
export const PROBE_EXPECTED_STATUS_ENV_VAR = 'PROBE_EXPECTED_STATUS';
export const PROBE_BODY_MARKER_ENV_VAR = 'PROBE_BODY_MARKER';
export const PROBE_LATENCY_BUDGET_ENV_VAR = 'PROBE_LATENCY_BUDGET_MS';

/**
 * Every variable the handler requires. It refuses to run without all of them —
 * see {@link CANARY_HANDLER_SOURCE}.
 */
export const REQUIRED_PROBE_ENV_VARS: readonly string[] = [
  PROBE_NAME_ENV_VAR,
  PROBE_ENVIRONMENT_ENV_VAR,
  PROBE_REGION_ENV_VAR,
  PROBE_AGGREGATION_REGION_ENV_VAR,
  PROBE_NAMESPACE_ENV_VAR,
  PROBE_URL_ENV_VAR,
  PROBE_METHOD_ENV_VAR,
  PROBE_EXPECTED_STATUS_ENV_VAR,
  PROBE_BODY_MARKER_ENV_VAR,
  PROBE_LATENCY_BUDGET_ENV_VAR,
];

/* ── AWS limits this module enforces at synth time ────────────────────────── */

/** Synthetics canary names: 1–21 characters. */
export const MAX_CANARY_NAME_LENGTH = 21;
/** Synthetics canary names: lowercase letters, digits, hyphen, underscore. */
export const CANARY_NAME_PATTERN = /^[a-z0-9_-]+$/;
/** `rate()` schedules Synthetics accepts, in minutes. */
export const MIN_SCHEDULE_MINUTES = 1;
export const MAX_SCHEDULE_MINUTES = 60;
/** A canary run is killed at 14 minutes. */
export const MAX_TIMEOUT_SECONDS = 840;

/* ── The spec ─────────────────────────────────────────────────────────────── */

/** HTTP methods a probe may use. Nothing here should mutate state. */
export type ProbeMethod = 'GET' | 'HEAD';

/** One user-facing path, probed identically from every region in the fleet. */
export interface CanaryProbe {
  /**
   * Short, kebab-case name. It becomes the canary name (with the environment
   * prefix) and the `Probe` metric dimension, so it is capped hard — see
   * {@link MAX_CANARY_NAME_LENGTH}.
   */
  readonly name: string;
  /** Absolute https:// URL, reached from the public internet. */
  readonly url: string;
  /** Default: `GET`. */
  readonly method?: ProbeMethod;
  /** Status the application returns when healthy. Default: 200. */
  readonly expectedStatus?: number;
  /**
   * A string that appears in the healthy response body and in no error page.
   *
   * Required. A status-code-only probe is green against a maintenance page, a
   * cached CloudFront error page, and an SPA shell whose data fetch failed.
   */
  readonly bodyMarker: string;
  /** Latency above which the run fails, in milliseconds. */
  readonly latencyBudgetMs: number;
  /** How often the probe runs, in minutes. Default: 5. */
  readonly scheduleMinutes?: number;
  /** Canary run timeout, in seconds. Default: 60. */
  readonly timeoutSeconds?: number;
}

export interface SyntheticCanaryFleet {
  /** Environment name; prefixes every canary name and tags every resource. */
  readonly envName: string;
  /** The probes, run identically from every region below. */
  readonly probes: readonly CanaryProbe[];
  /** Regions the probes run *from*. At least two — see the class comment. */
  readonly regions: readonly string[];
  /** Region holding the republished metrics and the quorum alarm. */
  readonly aggregationRegion: string;
  /** Regions that must agree before the fleet pages. At least two. */
  readonly quorum: number;
  /** Alarm evaluation periods. Default: 3. */
  readonly evaluationPeriods?: number;
  /** Breaching periods within them before the alarm fires. Default: 2. */
  readonly datapointsToAlarm?: number;
  /**
   * The detection budget this fleet claims, in minutes.
   *
   * Optional, and the only rule here that compares a stated intention with the
   * arithmetic underneath it: detection takes `scheduleMinutes x
   * datapointsToAlarm`, and a fleet whose runbook promises five minutes while
   * probing every ten has an alarm that cannot keep the promise.
   */
  readonly maxDetectionMinutes?: number;
}

export type CanaryFleetRule =
  | 'single-region-fleet'
  | 'duplicate-probe-region'
  | 'quorum-below-two'
  | 'quorum-exceeds-regions'
  | 'schedule-outside-synthetics-range'
  | 'timeout-exceeds-schedule'
  | 'timeout-exceeds-maximum'
  | 'latency-budget-exceeds-timeout'
  | 'probe-without-body-marker'
  | 'probe-over-plaintext-http'
  | 'expected-status-not-success'
  | 'expected-status-without-body'
  | 'canary-name-too-long'
  | 'canary-name-invalid-characters'
  | 'duplicate-probe-name'
  | 'datapoints-exceed-evaluation-periods'
  | 'detection-slower-than-declared';

export interface CanaryFleetViolation {
  readonly rule: CanaryFleetRule;
  readonly location: string;
  readonly message: string;
}

/** A probe with every default applied and every derived value computed. */
export interface ResolvedProbe {
  readonly name: string;
  readonly canaryName: string;
  readonly url: string;
  readonly method: ProbeMethod;
  readonly expectedStatus: number;
  readonly bodyMarker: string;
  readonly latencyBudgetMs: number;
  readonly scheduleMinutes: number;
  readonly timeoutSeconds: number;
  /** Alarm period, in seconds. One run per period, by construction. */
  readonly alarmPeriodSeconds: number;
  /** Worst-case time from the first failed run to the page, in minutes. */
  readonly detectionMinutes: number;
}

export interface ResolvedCanaryFleet {
  readonly envName: string;
  readonly probes: readonly ResolvedProbe[];
  readonly regions: readonly string[];
  readonly aggregationRegion: string;
  readonly quorum: number;
  readonly evaluationPeriods: number;
  readonly datapointsToAlarm: number;
  readonly maxDetectionMinutes?: number;
}

/** The canary name a probe deploys under, in every region of the fleet. */
export const canaryNameFor = (envName: string, probeName: string): string =>
  `${envName}-${probeName}`;

const DEFAULT_SCHEDULE_MINUTES = 5;
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_EXPECTED_STATUS = 200;
const DEFAULT_EVALUATION_PERIODS = 3;
const DEFAULT_DATAPOINTS_TO_ALARM = 2;
/** Statuses that are defined to carry no body, so a marker cannot match. */
const BODILESS_STATUSES = [204, 304];

const resolveProbe = (envName: string, probe: CanaryProbe): ResolvedProbe => {
  const scheduleMinutes = probe.scheduleMinutes ?? DEFAULT_SCHEDULE_MINUTES;
  return {
    name: probe.name,
    canaryName: canaryNameFor(envName, probe.name),
    url: probe.url,
    method: probe.method ?? 'GET',
    expectedStatus: probe.expectedStatus ?? DEFAULT_EXPECTED_STATUS,
    bodyMarker: probe.bodyMarker,
    latencyBudgetMs: probe.latencyBudgetMs,
    scheduleMinutes,
    timeoutSeconds: probe.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    alarmPeriodSeconds: scheduleMinutes * 60,
    detectionMinutes: 0,
  };
};

/**
 * Apply defaults and check every rule. Returns the resolved fleet alongside the
 * violations so a caller can report all of them at once; `requireCanaryFleet`
 * is the throwing form the stacks use.
 */
export const validateCanaryFleet = (
  fleet: SyntheticCanaryFleet,
): { readonly resolved: ResolvedCanaryFleet; readonly violations: readonly CanaryFleetViolation[] } => {
  const violations: CanaryFleetViolation[] = [];
  const add = (rule: CanaryFleetRule, location: string, message: string): void => {
    violations.push({ rule, location, message });
  };

  const evaluationPeriods = fleet.evaluationPeriods ?? DEFAULT_EVALUATION_PERIODS;
  const datapointsToAlarm = fleet.datapointsToAlarm ?? DEFAULT_DATAPOINTS_TO_ALARM;

  /* ── The fleet ──────────────────────────────────────────────────────────── */

  const uniqueRegions = new Set(fleet.regions);
  if (uniqueRegions.size !== fleet.regions.length) {
    add(
      'duplicate-probe-region',
      `${fleet.envName} fleet`,
      `regions [${fleet.regions.join(', ')}] contains a duplicate. Each region contributes one ` +
        'term to the quorum sum, so a repeated region votes twice and the fleet pages on a ' +
        'single region while appearing to require agreement.',
    );
  }

  if (uniqueRegions.size < 2) {
    add(
      'single-region-fleet',
      `${fleet.envName} fleet`,
      `${uniqueRegions.size} probe region(s). A single region cannot distinguish an application ` +
        'outage from a bad morning in its own region, and a quorum alarm over one region is a ' +
        'threshold with nothing to compare.',
    );
  }

  if (fleet.quorum < 2) {
    add(
      'quorum-below-two',
      `${fleet.envName} fleet`,
      `quorum is ${fleet.quorum}. A quorum of one pages whenever any single region fails, which ` +
        'is the N-independent-alarms behaviour the fleet exists to replace — the per-region ' +
        'alarms already ticket that case.',
    );
  }

  if (fleet.quorum > uniqueRegions.size) {
    add(
      'quorum-exceeds-regions',
      `${fleet.envName} fleet`,
      `quorum ${fleet.quorum} over ${uniqueRegions.size} region(s): the sum can never reach the ` +
        'threshold, so the page alarm stays green through a total outage.',
    );
  }

  if (datapointsToAlarm > evaluationPeriods) {
    add(
      'datapoints-exceed-evaluation-periods',
      `${fleet.envName} fleet`,
      `datapointsToAlarm ${datapointsToAlarm} exceeds evaluationPeriods ${evaluationPeriods}; ` +
        'CloudFormation rejects the alarm at deploy time.',
    );
  }

  /* ── The probes ─────────────────────────────────────────────────────────── */

  const seen = new Set<string>();
  const probes = fleet.probes.map((probe) => {
    const resolved = resolveProbe(fleet.envName, probe);
    const where = `probe ${probe.name}`;

    if (seen.has(resolved.canaryName)) {
      add(
        'duplicate-probe-name',
        where,
        `two probes resolve to the canary name ${resolved.canaryName}. They would also share the ` +
          `${PROBE_DIMENSION} dimension, so one time series would carry both verdicts.`,
      );
    }
    seen.add(resolved.canaryName);

    if (resolved.canaryName.length > MAX_CANARY_NAME_LENGTH) {
      add(
        'canary-name-too-long',
        where,
        `${resolved.canaryName} is ${resolved.canaryName.length} characters; CloudWatch ` +
          `Synthetics caps canary names at ${MAX_CANARY_NAME_LENGTH}. This is a deploy-time ` +
          'failure in every region at once and has no other symptom.',
      );
    }

    if (!CANARY_NAME_PATTERN.test(resolved.canaryName)) {
      add(
        'canary-name-invalid-characters',
        where,
        `${resolved.canaryName} is outside ${String(CANARY_NAME_PATTERN)} — Synthetics accepts ` +
          'lowercase letters, digits, hyphens and underscores only.',
      );
    }

    if (resolved.bodyMarker.trim().length === 0) {
      add(
        'probe-without-body-marker',
        where,
        'no body marker. A status-code-only probe passes against a maintenance page, a cached ' +
          'CloudFront error page and an SPA shell whose data fetch failed — every one of which ' +
          'returns 200 and is an outage.',
      );
    }

    if (!resolved.url.startsWith('https://')) {
      add(
        'probe-over-plaintext-http',
        where,
        `${resolved.url} is not https. A plaintext probe cannot observe an expired or misissued ` +
          'certificate, which is one of the failures only a canary sees at all.',
      );
    }

    if (resolved.expectedStatus < 200 || resolved.expectedStatus > 299) {
      add(
        'expected-status-not-success',
        where,
        `expects ${resolved.expectedStatus}. A probe asserting a redirect or an error is ` +
          'asserting about the edge rather than the application, and stays green when the ' +
          'origin behind it is gone.',
      );
    } else if (BODILESS_STATUSES.includes(resolved.expectedStatus)) {
      add(
        'expected-status-without-body',
        where,
        `expects ${resolved.expectedStatus}, which carries no body, so the marker assertion can ` +
          'never match and the probe is a status-code-only probe with a marker beside it.',
      );
    }

    if (
      resolved.scheduleMinutes < MIN_SCHEDULE_MINUTES ||
      resolved.scheduleMinutes > MAX_SCHEDULE_MINUTES
    ) {
      add(
        'schedule-outside-synthetics-range',
        where,
        `runs every ${resolved.scheduleMinutes} minute(s); Synthetics accepts rate() schedules ` +
          `from ${MIN_SCHEDULE_MINUTES} to ${MAX_SCHEDULE_MINUTES} minutes.`,
      );
    }

    if (resolved.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      add(
        'timeout-exceeds-maximum',
        where,
        `timeout ${resolved.timeoutSeconds}s is above the ${MAX_TIMEOUT_SECONDS}s ceiling a ` +
          'canary run is killed at.',
      );
    }

    if (resolved.timeoutSeconds > resolved.scheduleMinutes * 60) {
      add(
        'timeout-exceeds-schedule',
        where,
        `timeout ${resolved.timeoutSeconds}s exceeds its ${resolved.scheduleMinutes}-minute ` +
          'schedule, so runs would overlap. Synthetics rejects it at deploy time.',
      );
    }

    if (resolved.latencyBudgetMs >= resolved.timeoutSeconds * 1000) {
      add(
        'latency-budget-exceeds-timeout',
        where,
        `latency budget ${resolved.latencyBudgetMs}ms is at or above the ${resolved.timeoutSeconds}s ` +
          'run timeout: the run is killed before the assertion is reached, so the budget can ' +
          'never be the reason a run fails and reads as a latency SLO that is never breached.',
      );
    }

    const detectionMinutes = resolved.scheduleMinutes * datapointsToAlarm;
    if (fleet.maxDetectionMinutes !== undefined && detectionMinutes > fleet.maxDetectionMinutes) {
      add(
        'detection-slower-than-declared',
        where,
        `detection takes ${resolved.scheduleMinutes} minute(s) x ${datapointsToAlarm} datapoint(s) ` +
          `= ${detectionMinutes} minutes, against a declared budget of ${fleet.maxDetectionMinutes}.`,
      );
    }

    return { ...resolved, detectionMinutes };
  });

  return {
    resolved: {
      envName: fleet.envName,
      probes,
      regions: fleet.regions,
      aggregationRegion: fleet.aggregationRegion,
      quorum: fleet.quorum,
      evaluationPeriods,
      datapointsToAlarm,
      maxDetectionMinutes: fleet.maxDetectionMinutes,
    },
    violations,
  };
};

/**
 * {@link validateCanaryFleet}, throwing on the first set of violations.
 *
 * The stacks call this before creating anything, so a fleet that would deploy
 * and report nothing fails at `cdk synth` on the line that declared it.
 */
export const requireCanaryFleet = (fleet: SyntheticCanaryFleet): ResolvedCanaryFleet => {
  const { resolved, violations } = validateCanaryFleet(fleet);
  if (violations.length > 0) {
    const detail = violations.map((v) => `  [${v.rule}] ${v.location}: ${v.message}`).join('\n');
    throw new Error(
      `Invalid synthetic canary fleet for ${fleet.envName}:\n${detail}\n` +
        'See docs/synthetic-canaries.md.',
    );
  }
  return resolved;
};

/** Environment variables one probe's canary carries, in its own region. */
export const probeEnvironment = (options: {
  readonly probe: ResolvedProbe;
  readonly envName: string;
  readonly region: string;
  readonly aggregationRegion: string;
}): Record<string, string> => ({
  [PROBE_NAME_ENV_VAR]: options.probe.name,
  [PROBE_ENVIRONMENT_ENV_VAR]: options.envName,
  [PROBE_REGION_ENV_VAR]: options.region,
  [PROBE_AGGREGATION_REGION_ENV_VAR]: options.aggregationRegion,
  [PROBE_NAMESPACE_ENV_VAR]: CANARY_METRIC_NAMESPACE,
  [PROBE_URL_ENV_VAR]: options.probe.url,
  [PROBE_METHOD_ENV_VAR]: options.probe.method,
  [PROBE_EXPECTED_STATUS_ENV_VAR]: String(options.probe.expectedStatus),
  [PROBE_BODY_MARKER_ENV_VAR]: options.probe.bodyMarker,
  [PROBE_LATENCY_BUDGET_ENV_VAR]: String(options.probe.latencyBudgetMs),
});

/**
 * The script every canary in every region runs.
 *
 * One script, parameterised entirely by {@link probeEnvironment}, for two
 * reasons. A per-probe script is a per-probe copy of the assertion logic, and
 * the copies drift; and a gate reading a synthesised template can check an
 * environment variable but cannot meaningfully check that a generated function
 * body still asserts what it claims to.
 *
 * Three things in here are load-bearing and each is a way a canary reports
 * health it did not observe:
 *
 *   • **It refuses to run without every variable.** A missing
 *     `PROBE_BODY_MARKER` would otherwise become `undefined`, and
 *     `body.includes(undefined)` is `false` in one direction and the assertion
 *     silently disappearing in the other. A canary that cannot see its own
 *     configuration must fail, not adapt.
 *
 *   • **The verdict is republished in a `finally`.** A run that throws still
 *     has to publish `ProbeFailure = 1`, because the quorum alarm reads the
 *     republished series and a thrown run that publishes nothing is a gap.
 *
 *   • **A failure to republish fails the run.** Otherwise the aggregation
 *     region goes blind while every local canary stays green, which is the one
 *     combination that would make the fleet's page alarm unreachable.
 */
export const CANARY_HANDLER_SOURCE = `
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const REQUIRED = ${JSON.stringify(REQUIRED_PROBE_ENV_VARS)};

const config = () => {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    // A probe that cannot read its own assertions must fail rather than run a
    // weaker check: an absent body marker would otherwise become a comparison
    // against undefined, which is a probe that only checks the status code.
    throw new Error('Probe misconfigured, missing: ' + missing.join(', '));
  }
  return {
    name: process.env.${PROBE_NAME_ENV_VAR},
    environment: process.env.${PROBE_ENVIRONMENT_ENV_VAR},
    region: process.env.${PROBE_REGION_ENV_VAR},
    aggregationRegion: process.env.${PROBE_AGGREGATION_REGION_ENV_VAR},
    namespace: process.env.${PROBE_NAMESPACE_ENV_VAR},
    url: process.env.${PROBE_URL_ENV_VAR},
    method: process.env.${PROBE_METHOD_ENV_VAR},
    expectedStatus: Number(process.env.${PROBE_EXPECTED_STATUS_ENV_VAR}),
    bodyMarker: process.env.${PROBE_BODY_MARKER_ENV_VAR},
    latencyBudgetMs: Number(process.env.${PROBE_LATENCY_BUDGET_ENV_VAR}),
  };
};

const requestOptions = (cfg) => {
  const url = new URL(cfg.url);
  return {
    hostname: url.hostname,
    method: cfg.method,
    path: url.pathname + url.search,
    port: url.port === '' ? 443 : Number(url.port),
    protocol: url.protocol,
    // Bounds the socket at the budget so a hung origin ends the run as a
    // latency failure rather than occupying it until the canary timeout.
    timeout: cfg.latencyBudgetMs,
  };
};

const assertHealthy = (cfg, status, body, latencyMs) => {
  if (status !== cfg.expectedStatus) {
    throw new Error('expected HTTP ' + cfg.expectedStatus + ', got ' + status);
  }
  // The status code alone is satisfied by a maintenance page and by a cached
  // error page from the CDN, both of which are 200 and both of which are the
  // outage this canary exists to report.
  if (!body.includes(cfg.bodyMarker)) {
    throw new Error('response did not contain the marker ' + JSON.stringify(cfg.bodyMarker));
  }
  if (latencyMs > cfg.latencyBudgetMs) {
    throw new Error(latencyMs + 'ms over the ' + cfg.latencyBudgetMs + 'ms budget');
  }
};

const publish = async (cfg, failed, latencyMs) => {
  // Aimed at the aggregation region, not this one. CloudWatch alarms cannot
  // read a metric from another region, so the quorum can only be computed over
  // series that were written where the alarm lives.
  const client = new CloudWatchClient({ region: cfg.aggregationRegion });
  const dimensions = [
    { Name: '${ENVIRONMENT_DIMENSION}', Value: cfg.environment },
    { Name: '${PROBE_DIMENSION}', Value: cfg.name },
    { Name: '${REGION_DIMENSION}', Value: cfg.region },
  ];
  const metrics = [
    {
      MetricName: '${PROBE_FAILURE_METRIC}',
      Dimensions: dimensions,
      Unit: 'Count',
      Value: failed ? 1 : 0,
    },
  ];
  if (latencyMs !== undefined) {
    metrics.push({
      MetricName: '${PROBE_LATENCY_METRIC}',
      Dimensions: dimensions,
      Unit: 'Milliseconds',
      Value: latencyMs,
    });
  }
  await client.send(new PutMetricDataCommand({ Namespace: cfg.namespace, MetricData: metrics }));
};

exports.handler = async () => {
  const cfg = config();

  // Request and response bodies stay out of the artifact bucket. A probe
  // against an authenticated path would otherwise write a copy of whatever the
  // application returned into S3 on every run, for as long as the retention
  // policy keeps it — a second, unreviewed copy of production data.
  synthetics.getConfiguration().setConfig({
    includeRequestBody: false,
    includeResponseBody: false,
    includeRequestHeaders: false,
    includeResponseHeaders: true,
    restrictedHeaders: ['authorization', 'cookie', 'x-api-key'],
  });

  let failure;
  let latencyMs;

  try {
    const started = Date.now();
    await synthetics.executeHttpStep(cfg.name, requestOptions(cfg), async (res) => {
      const status = res.statusCode;
      const chunks = [];
      for await (const chunk of res) {
        chunks.push(chunk);
      }
      latencyMs = Date.now() - started;
      assertHealthy(cfg, status, Buffer.concat(chunks).toString('utf8'), latencyMs);
    });
    log.info(cfg.name + ' healthy from ' + cfg.region + ' in ' + latencyMs + 'ms');
  } catch (error) {
    failure = error;
    log.error(cfg.name + ' failed from ' + cfg.region + ': ' + error.message);
  }

  // Unconditional on purpose: a run that threw still has to publish its
  // verdict, because the quorum alarm reads the republished series and a thrown
  // run that published nothing leaves a gap rather than a failure. A failure to
  // publish then fails the run, since the alternative is an aggregation region
  // going blind while every local canary stays green.
  await publish(cfg, failure !== undefined, latencyMs);

  if (failure) {
    throw failure;
  }
  return 'ok';
};
`;

/**
 * Handler entry point.
 *
 * Fixed at `index.handler` because the code is supplied inline: CDK's
 * `Code.fromInline` rejects anything else, since an inline script has no file
 * name for a handler to refer to. Inline rather than an asset because a script
 * in an S3 asset is a zip in `cdk.out` that no gate can read, and this one is
 * short enough that carrying it in the template keeps it reviewable in a
 * `cdk diff` and readable by `npm run audit:canaries`.
 */
export const CANARY_HANDLER = 'index.handler';
