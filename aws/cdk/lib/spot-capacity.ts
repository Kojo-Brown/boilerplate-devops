/**
 * Which workloads may run on Fargate Spot, and what each one owes the two
 * minutes it gets when the capacity is reclaimed.
 *
 * Spot is the only cost lever in this repository that changes what happens
 * during an incident. Every other one — a smaller instance class, a shorter
 * retention, Graviton — changes a bill and nothing else; this one changes the
 * probability that a running task disappears, so the interesting half of a
 * "spot strategy" is not the services that move but the ones that do not, and
 * why. Nine of the eleven ECS services here stay on on-demand capacity and the
 * `reason` on each of those entries is the content of this file.
 *
 * ## What AWS actually promises
 *
 * When Fargate Spot reclaims a task, ECS sends a **two-minute warning**: a task
 * state change event to EventBridge with `stopCode: SpotInterruption`, and a
 * `SIGTERM` to the task's containers. Failure to shut down inside that window
 * ends with `SIGKILL`. Two things about the window are easy to get wrong and
 * neither of them fails loudly:
 *
 *   • **`stopTimeout` defaults to 30 seconds.** Not 120. A task definition that
 *     says nothing gets 30 seconds of grace and loses whatever it was doing at
 *     second 31, and the only trace is a task that went away — which is what a
 *     reclaimed task looks like anyway. AWS's own recommendation is a value of
 *     120 seconds or less; the default is a quarter of what is available.
 *
 *   • **Deregistration happens inside the same two minutes.** On a termination
 *     notice ECS deregisters the task from its target group *before* it sends
 *     `SIGTERM`, so the target group's `deregistration_delay.timeout_seconds`
 *     and the container's `stopTimeout` are spent one after the other out of
 *     the same budget. The ELB default is **300 seconds**, which on its own
 *     exceeds the window: nothing is left for the process to finish in, and the
 *     requests still in flight when the capacity goes are cut rather than
 *     drained. {@link drainBudgetSeconds} is that sum and
 *     {@link validateSpotCatalogue} refuses a budget that does not fit.
 *
 * ## The two postures, and why `base` is the whole safety story
 *
 * A capacity provider strategy of 100% `FARGATE_SPOT` does not fail loudly when
 * there is no Spot capacity to be had. `RunTask` simply does not place, the
 * service event log says so, the desired count stays unmet, and no alarm fires
 * — because the metrics that would go red are utilisation metrics of tasks that
 * do not exist, and CloudWatch does not breach a threshold on a metric with no
 * data points. It is the same shape as the canary blind spot in
 * `docs/synthetic-canaries.md`: the system does not go red, it goes quiet.
 *
 * So `spot-with-base` carries an on-demand `base` — a count, not a percentage,
 * placed before any weight is considered — and the environment holding it
 * carries an alarm comparing running tasks to desired tasks whose
 * `treatMissingData` is `breaching`. `spot-only` has no base and is reserved
 * for workloads where "it is not running" reaches the one person who cares by
 * another route entirely: a preview environment's absence is visible in the
 * pull request that is waiting for it.
 *
 * ## What the postures are not allowed to be
 *
 * `validateSpotCatalogue` is offline arithmetic over this catalogue and runs at
 * synth time. `tools/audit-spot-capacity.ts` is the other half: it reads what
 * `cdk synth` wrote and holds the templates to what is declared here, because
 * `posture` is a claim about a `CapacityProviderStrategy` block and nothing in
 * TypeScript connects the two.
 *
 * See docs/spot.md.
 */

/* ── What the platform gives us ───────────────────────────────────────────── */

/**
 * The warning Fargate Spot sends before it takes the task away.
 *
 * Everything in `drainBudget` is spent inside this. It is not configurable and
 * it is not a target to aim at — a budget that exactly equals it leaves no room
 * for the time between the event being emitted and `SIGTERM` arriving.
 */
export const FARGATE_SPOT_WARNING_SECONDS = 120;

/** The largest `stopTimeout` Fargate accepts, which is the warning itself. */
export const FARGATE_MAX_STOP_TIMEOUT_SECONDS = 120;

/**
 * What ECS uses when a container definition declares no `stopTimeout`.
 *
 * Here so that "unset" and "deliberately 30" can be told apart in a review:
 * they produce the same behaviour and only one of them was chosen.
 */
export const ECS_DEFAULT_STOP_TIMEOUT_SECONDS = 30;

/**
 * What Elastic Load Balancing uses when a target group sets no deregistration
 * delay — two and a half times the whole Spot window.
 */
export const ELB_DEFAULT_DEREGISTRATION_DELAY_SECONDS = 300;

/**
 * `stopCode` on the task state change event that announces a reclaim.
 *
 * The one value AWS documents for Fargate Spot. ECS-on-EC2 capacity providers
 * report instance draining differently, and this repository has no ECS-on-EC2
 * capacity: matching a second code "just in case" would be a rule nothing here
 * can keep honest, so the event pattern names exactly this one and
 * `tools/audit-spot-capacity.ts` holds it there.
 */
export const SPOT_INTERRUPTION_STOP_CODE = 'SpotInterruption';

/** Capacity provider names. Both are account-wide and need only association. */
export const SPOT_CAPACITY_PROVIDER = 'FARGATE_SPOT';
export const ON_DEMAND_CAPACITY_PROVIDER = 'FARGATE';

/* ── What this repository publishes about interruptions ───────────────────── */

/** Namespace for every metric the interruption recorder publishes. */
export const SPOT_METRIC_NAMESPACE = 'Boilerplate/Spot';

/** One per announced reclaim, dimensioned by cluster and service. */
export const INTERRUPTION_METRIC = 'Interruptions';

/** Observed `stoppingAt` → `stoppedAt`, in seconds. */
export const DRAIN_SECONDS_METRIC = 'DrainSeconds';

/**
 * One per reclaim whose observed shutdown exceeded the declared budget.
 *
 * The metric that is worth an alarm. `DrainSeconds` is a distribution nobody
 * reads; an overrun is a task that was still working when `SIGKILL` arrived,
 * which is the one Spot failure that costs data rather than capacity.
 */
export const DRAIN_OVERRUN_METRIC = 'DrainOverruns';

/**
 * One per reclaim whose shutdown could not be measured at all.
 *
 * `stoppingAt` is absent when a task never entered STOPPING, and an unmeasurable
 * shutdown is not a clean one — it is the reclaim that went worst, with the
 * least to show for it. Published rather than inferred so that a rise in it
 * cannot be read off `DrainOverruns` staying at zero. Deliberately not alarmed;
 * see docs/spot.md.
 */
export const DRAIN_UNMEASURED_METRIC = 'DrainUnmeasured';

/**
 * The published Fargate Spot discount, and the fact that nobody here has
 * measured it.
 *
 * Marked the way `BENCHMARK_CLAIMS` in `lib/graviton-migration.ts` is marked:
 * AWS advertises "up to 70%" off the on-demand rate for Fargate Spot, that is a
 * list-price claim rather than an observation, and the Spot price moves. No
 * stack in this repository has ever run, so there is no bill to read it off.
 * Quoting it as a measured saving would be the same mistake the Graviton guide
 * refused to make, so the saving functions below return a *bound* and say so.
 */
export const FARGATE_SPOT_LIST_DISCOUNT = {
  percent: 70,
  measured: false,
  source: 'AWS Fargate pricing page, "Fargate Spot" — advertised as up to 70% off on-demand.',
  note:
    'An upper bound on the saving, not an expectation. The Spot price is set per ' +
    'availability zone and moves; the on-demand rates this repository has actually ' +
    'read out of the price list are in ARCHITECTURE_PRICES.',
} as const;

/* ── The catalogue ────────────────────────────────────────────────────────── */

/**
 * How a service's capacity is chosen.
 *
 *   `spot-only`       every task on Spot, no on-demand base. Only for workloads
 *                     whose absence reaches somebody without an alarm.
 *   `spot-with-base`  an on-demand base, Spot for everything above it.
 *   `on-demand-only`  no Spot at all, for the reason in `reason`.
 */
export type SpotPosture = 'spot-only' | 'spot-with-base' | 'on-demand-only';

/**
 * Why interrupting this workload is or is not acceptable. The posture follows
 * from it, which is why both are declared: a posture that does not follow from
 * the criticality is a finding rather than a judgement call.
 */
export type SpotCriticality =
  /** An SLO in `lib/slo-definitions.ts` is measured on it. */
  | 'user-facing-slo'
  /** It is how a release reaches production, so interrupting it fails a deploy. */
  | 'release-mechanism'
  /** Its correctness depends on which instance a request lands on. */
  | 'instance-affinity'
  /** Somebody's work depends on it being up, but no objective does. */
  | 'staging-grade'
  /** It exists for one pull request and is deleted with it. */
  | 'ephemeral';

/** The two intervals a reclaim is spent in, both of them declared. */
export interface DrainBudget {
  /**
   * The target group's `deregistration_delay.timeout_seconds`.
   *
   * Spent first: ECS deregisters before it signals. Unset means the ELB default
   * of {@link ELB_DEFAULT_DEREGISTRATION_DELAY_SECONDS}, which does not fit.
   */
  readonly deregistrationDelaySeconds: number;
  /**
   * The container's `stopTimeout`: how long the process has after `SIGTERM`
   * before `SIGKILL`. Unset means {@link ECS_DEFAULT_STOP_TIMEOUT_SECONDS}.
   */
  readonly stopTimeoutSeconds: number;
}

export interface SpotWorkload {
  /** Unique, stable, kebab-case. Appears in the audit's output. */
  readonly id: string;
  /**
   * Stack name prefixes whose services this entry claims.
   *
   * Prefixes rather than names because the per-pull-request preview stack is
   * `PreviewPrStack-<number>`, and a catalogue that enumerated those would have
   * to be edited by CI.
   */
  readonly stackPrefixes: readonly string[];
  /** Construct path suffix of the `AWS::ECS::Service`, e.g. `Service/Service`. */
  readonly servicePathSuffix: string;
  readonly posture: SpotPosture;
  readonly criticality: SpotCriticality;
  /**
   * Why this posture, in the form "what happens when a task of this is
   * reclaimed". Not a description of the workload: the entries that matter are
   * the on-demand ones, and what makes them reviewable is the failure.
   */
  readonly reason: string;
  /** How many `AWS::ECS::Service` resources this entry should match. */
  readonly expectedResources: number;
  /**
   * Tasks placed on on-demand capacity before any weight applies.
   *
   * A count, not a share. Required by `spot-with-base` and refused on the other
   * two postures.
   */
  readonly onDemandBase?: number;
  /** Relative weight of Spot capacity above the base. */
  readonly spotWeight?: number;
  /** Relative weight of on-demand capacity above the base. */
  readonly onDemandWeight?: number;
  /** Required wherever Spot is used; meaningless without it. */
  readonly drainBudget?: DrainBudget;
  readonly note?: string;
}

/**
 * Every ECS service this repository synthesises, and its capacity posture.
 *
 * The audit requires this list to account for all of them: a service no entry
 * matches fails `service-unclassified`, so the next stack that adds one cannot
 * default quietly onto either kind of capacity.
 */
export const SPOT_WORKLOADS: readonly SpotWorkload[] = [
  {
    id: 'preview-pr-service',
    stackPrefixes: ['PreviewPrStack-'],
    servicePathSuffix: 'Service/Service',
    posture: 'spot-only',
    criticality: 'ephemeral',
    reason:
      'A preview exists for one pull request and is destroyed with it. A reclaimed task is ' +
      'replaced when capacity returns and is visible to exactly one person, who is already ' +
      'looking at the pull request it belongs to — so the absence reaches somebody without ' +
      'an alarm, which is the only thing that makes a base unnecessary. This is also the ' +
      'workload where Spot pays best: dozens of short-lived tasks a week, none of them ' +
      'load-bearing.',
    expectedResources: 1,
    spotWeight: 1,
    // 5s deregistration (PreviewPrStack sets it: nothing is draining to, since
    // the tasks being replaced are a deploy nobody depends on) plus 30s of
    // grace. 35 of the 120 available, which is the shape to keep: a preview
    // that lingers for two minutes per reclaim is two minutes of somebody
    // waiting.
    drainBudget: { deregistrationDelaySeconds: 5, stopTimeoutSeconds: 30 },
  },
  {
    id: 'staging-application',
    stackPrefixes: ['EcsStack-Staging'],
    servicePathSuffix: 'Service/Service',
    posture: 'spot-with-base',
    criticality: 'staging-grade',
    reason:
      'Staging carries no objective, and a reclaim there is a rehearsal of the thing ' +
      'production is supposed to survive — which is worth more than the capacity it costs. ' +
      'It keeps an on-demand base of one because a Spot-wide shortage would otherwise leave ' +
      'nothing running in the environment every release is validated against, and the ' +
      'failure would be silent: no tasks means no utilisation metrics, and no alarm on a ' +
      'metric with no data points.',
    expectedResources: 1,
    onDemandBase: 1,
    onDemandWeight: 0,
    spotWeight: 1,
    // 30s deregistration (EcsStack's target group) plus 60s of grace: 90 of the
    // 120 available. The 30 left over is deliberate slack for the gap between
    // the event and SIGTERM, which AWS does not bound.
    drainBudget: { deregistrationDelaySeconds: 30, stopTimeoutSeconds: 60 },
    note:
      'The base is a count, so at `bin/app.ts`\u2019s staging desiredCount of 1 this strategy ' +
      'saves nothing: the one task it wants is the one task the base places on on-demand ' +
      'capacity. What is on Spot is staging\u2019s *burst* \u2014 the CPU and memory scaling policies ' +
      'in EcsStack go to four tasks, and tasks two through four are placed by weight. That is ' +
      'the honest reading of a base-plus-weight strategy and it is stated here rather than in ' +
      'a saving estimate that assumes a load staging does not have. See maximumSavingPercent.',
  },
  {
    id: 'production-application',
    stackPrefixes: ['EcsStack-Production'],
    servicePathSuffix: 'Service/Service',
    posture: 'on-demand-only',
    criticality: 'user-facing-slo',
    reason:
      'The availability and latency objectives in `lib/slo-definitions.ts` are measured on ' +
      'this service, and an error budget does not distinguish a request failed by a bug from ' +
      'one failed by a reclaim. A 70% discount on the compute behind a 99.9% objective buys ' +
      'capacity that can be withdrawn during the incident it would help cause.',
    expectedResources: 1,
  },
  {
    id: 'blue-green-service',
    stackPrefixes: ['BlueGreenDeployStack-'],
    servicePathSuffix: 'Service/Service',
    posture: 'on-demand-only',
    criticality: 'release-mechanism',
    reason:
      'This is not a workload, it is how a release happens: CodeDeploy shifts traffic ' +
      'between two task sets and decides on the result. A reclaim during the shift is ' +
      'indistinguishable from a bad revision — the replacement task set loses capacity, the ' +
      'deployment fails its health checks, and the rollback is of a release that was fine. ' +
      'Staging is included deliberately: a release mechanism rehearsed on different capacity ' +
      'from the one production uses has not been rehearsed.',
    expectedResources: 2,
  },
  {
    id: 'canary-deploy-services',
    stackPrefixes: ['CanaryDeployStack-'],
    servicePathSuffix: 'StableService/Service',
    posture: 'on-demand-only',
    criticality: 'release-mechanism',
    reason:
      'The canary analyser compares the canary target group’s error rate and latency against ' +
      'the stable one’s and promotes or rolls back on the difference. A reclaim on either ' +
      'side moves one of the two numbers for a reason that has nothing to do with the ' +
      'revision under test, and the analyser cannot tell the two apart: it would promote on a ' +
      'quiet half-hour or roll back on a reclaim, and either verdict reads exactly like a ' +
      'correct one.',
    expectedResources: 2,
  },
  {
    id: 'canary-deploy-canary-services',
    stackPrefixes: ['CanaryDeployStack-'],
    servicePathSuffix: 'CanaryService/Service',
    posture: 'on-demand-only',
    criticality: 'release-mechanism',
    reason:
      'The canary half of the comparison above, and the more exposed of the two: it runs at a ' +
      'fraction of the stable service’s task count, so one reclaimed task is a larger share ' +
      'of the sample the analyser is deciding on.',
    expectedResources: 2,
  },
  {
    id: 'otel-sampler-service',
    stackPrefixes: ['OtelCollectorStack-'],
    servicePathSuffix: 'Service/Service',
    posture: 'on-demand-only',
    criticality: 'instance-affinity',
    reason:
      'The tail-sampling tier is a hash ring: every span of a trace must reach the same ' +
      'instance, and the agents resolve that through Cloud Map. Losing an instance re-points ' +
      'roughly 1/N of trace IDs, and for one resolver interval the agents disagree about ' +
      'which instance owns which trace — so traces in flight across that window are split and ' +
      'both halves are decided on fragments. This is the same property that is already the ' +
      'reason this tier has no scaling policy (see `docs/otel-collector.md`); Spot would ' +
      'reintroduce it on AWS’s schedule instead of ours, and it fails silently: every task ' +
      'stays healthy and a trace is missing its database span.',
    expectedResources: 2,
  },
];

/* ── Matching ─────────────────────────────────────────────────────────────── */

/** Does this entry claim a service at `constructPath` in `stackName`? */
export const spotWorkloadMatches = (
  workload: SpotWorkload,
  resource: { readonly stackName: string; readonly constructPath: string },
): boolean =>
  workload.stackPrefixes.some((prefix) => resource.stackName.startsWith(prefix)) &&
  resource.constructPath.endsWith(workload.servicePathSuffix);

/** Entries claiming a given service. More than one is a finding, not a tie-break. */
export const spotWorkloadsFor = (
  resource: { readonly stackName: string; readonly constructPath: string },
  workloads: readonly SpotWorkload[] = SPOT_WORKLOADS,
): readonly SpotWorkload[] =>
  workloads.filter((workload) => spotWorkloadMatches(workload, resource));

/**
 * The entry with this id, or a thrown error.
 *
 * Throws rather than returning `undefined` because every caller is a stack
 * wiring its own capacity: a typo would otherwise synthesise a service with no
 * strategy at all, which is on-demand, which deploys, which is the one outcome
 * nobody would notice.
 */
export const spotWorkloadById = (
  id: string,
  workloads: readonly SpotWorkload[] = SPOT_WORKLOADS,
): SpotWorkload => {
  const workload = workloads.find((candidate) => candidate.id === id);
  if (!workload) {
    throw new Error(
      `No Spot capacity workload with id ${JSON.stringify(id)}. Known ids: ${workloads
        .map((candidate) => candidate.id)
        .join(', ')}.`,
    );
  }
  return workload;
};

/* ── Arithmetic ───────────────────────────────────────────────────────────── */

/** True for the two postures that place tasks on Spot. */
export const usesSpot = (workload: SpotWorkload): boolean => workload.posture !== 'on-demand-only';

/**
 * Seconds a reclaim needs: deregistration first, then the grace period.
 *
 * The sum rather than the maximum, because ECS deregisters the target before it
 * sends `SIGTERM` — the two intervals do not overlap.
 */
export const drainBudgetSeconds = (budget: DrainBudget): number =>
  budget.deregistrationDelaySeconds + budget.stopTimeoutSeconds;

/** What is left of the two minutes once the budget is spent. */
export const drainSlackSeconds = (budget: DrainBudget): number =>
  FARGATE_SPOT_WARNING_SECONDS - drainBudgetSeconds(budget);

/**
 * The capacity provider strategy for a workload, in the shape ECS takes.
 *
 * `base` is emitted only where it is non-zero: a strategy entry carrying
 * `base: 0` and one carrying no base behave identically, and the first reads in
 * a template diff like a base somebody set.
 */
export const spotCapacityProviderStrategies = (
  workload: SpotWorkload,
): readonly { readonly capacityProvider: string; readonly base?: number; readonly weight: number }[] => {
  if (!usesSpot(workload)) return [];

  const strategies: { capacityProvider: string; base?: number; weight: number }[] = [];
  const base = workload.onDemandBase ?? 0;
  const onDemandWeight = workload.onDemandWeight ?? 0;

  if (base > 0 || onDemandWeight > 0) {
    strategies.push({
      capacityProvider: ON_DEMAND_CAPACITY_PROVIDER,
      ...(base > 0 ? { base } : {}),
      weight: onDemandWeight,
    });
  }
  strategies.push({
    capacityProvider: SPOT_CAPACITY_PROVIDER,
    weight: workload.spotWeight ?? 1,
  });
  return strategies;
};

/**
 * An upper bound on the compute saving, as a percentage of the service's
 * on-demand cost.
 *
 * A bound and not an estimate, for two reasons stated in
 * {@link FARGATE_SPOT_LIST_DISCOUNT}: the discount is advertised rather than
 * measured, and the base is a count while this is a share — a `base` of 1 on a
 * service whose desired count is 2 is half the tasks today and a quarter of
 * them after a scale-out, so the saving moves with the load.
 */
export const maximumSavingPercent = (
  workload: SpotWorkload,
  desiredCount: number,
  discountPercent: number = FARGATE_SPOT_LIST_DISCOUNT.percent,
): number => {
  if (!usesSpot(workload) || desiredCount <= 0) return 0;
  const base = Math.min(workload.onDemandBase ?? 0, desiredCount);
  const spotShare = (desiredCount - base) / desiredCount;
  return Math.round(spotShare * discountPercent * 10) / 10;
};

/* ── Validation ───────────────────────────────────────────────────────────── */

export interface SpotCatalogueFinding {
  readonly rule: string;
  readonly subject: string;
  readonly message: string;
}

/**
 * The shortest a `reason` may be.
 *
 * A length floor is a crude rule and it is here on purpose: this catalogue is
 * read by somebody deciding whether to move a workload, and `reason: 'critical'`
 * satisfies every other rule in this file while telling them nothing. Ninety
 * characters is about one sentence naming a failure.
 */
export const MINIMUM_REASON_LENGTH = 90;

/**
 * Everything about this catalogue that is decidable offline.
 *
 * Called at synth time by every stack that reads the catalogue, so a bad entry
 * is a failed synth rather than a deployed strategy. The template-facing half —
 * does the service actually carry what is declared here — is
 * `tools/audit-spot-capacity.ts`, which needs `cdk.out`.
 */
export const validateSpotCatalogue = (
  workloads: readonly SpotWorkload[] = SPOT_WORKLOADS,
): readonly SpotCatalogueFinding[] => {
  const findings: SpotCatalogueFinding[] = [];
  const add = (rule: string, subject: string, message: string) =>
    findings.push({ rule, subject, message });

  for (const workload of workloads) {
    if (workloads.filter((other) => other.id === workload.id).length > 1) {
      add('workload-duplicate-id', workload.id, 'Two entries share this id.');
    }
    if (workload.stackPrefixes.length === 0) {
      add(
        'workload-no-stack-prefix',
        workload.id,
        'No stackPrefixes, so this entry claims every service with a matching construct path ' +
          'in every stack.',
      );
    }
    if (workload.servicePathSuffix.trim() === '') {
      add(
        'workload-no-path-suffix',
        workload.id,
        'No servicePathSuffix, so this entry claims every service in its stacks.',
      );
    }
    if (workload.expectedResources < 1) {
      add(
        'workload-expects-nothing',
        workload.id,
        `expectedResources is ${workload.expectedResources}: an entry matching no service is a ` +
          'classification nothing is held to.',
      );
    }
    if (workload.reason.trim().length < MINIMUM_REASON_LENGTH) {
      add(
        'workload-reason-too-short',
        workload.id,
        `reason is ${workload.reason.trim().length} characters. The on-demand entries are the ` +
          'content of this catalogue and a reason that does not name a failure cannot be ' +
          'reviewed.',
      );
    }

    const base = workload.onDemandBase ?? 0;

    if (workload.posture === 'on-demand-only') {
      if (workload.drainBudget) {
        add(
          'on-demand-with-drain-budget',
          workload.id,
          'An on-demand-only workload declares a drainBudget. Nothing enforces it — no ' +
            'capacity provider strategy is emitted — so it reads as a guarantee that is not ' +
            'one.',
        );
      }
      if (base > 0 || workload.spotWeight !== undefined || workload.onDemandWeight !== undefined) {
        add(
          'on-demand-with-weights',
          workload.id,
          'An on-demand-only workload declares a base or a weight. No strategy is emitted for ' +
            'it, so these values are inert.',
        );
      }
      continue;
    }

    if (!workload.drainBudget) {
      add(
        'spot-without-drain-budget',
        workload.id,
        'Runs on Spot and declares no drainBudget. The defaults it would then inherit are 300 ' +
          'seconds of deregistration and 30 of grace, which is two and a half times the ' +
          'warning before the process is signalled at all.',
      );
    } else {
      const budget = workload.drainBudget;
      if (budget.stopTimeoutSeconds < 1) {
        add(
          'stop-timeout-not-positive',
          workload.id,
          `stopTimeoutSeconds is ${budget.stopTimeoutSeconds}.`,
        );
      }
      if (budget.stopTimeoutSeconds > FARGATE_MAX_STOP_TIMEOUT_SECONDS) {
        add(
          'stop-timeout-above-platform-maximum',
          workload.id,
          `stopTimeoutSeconds is ${budget.stopTimeoutSeconds}, above the ` +
            `${FARGATE_MAX_STOP_TIMEOUT_SECONDS} Fargate accepts. The task definition is ` +
            'rejected at registration, which is a failed deploy rather than a review comment.',
        );
      }
      if (budget.deregistrationDelaySeconds < 0) {
        add(
          'deregistration-delay-negative',
          workload.id,
          `deregistrationDelaySeconds is ${budget.deregistrationDelaySeconds}.`,
        );
      }
      if (drainBudgetSeconds(budget) > FARGATE_SPOT_WARNING_SECONDS) {
        add(
          'drain-budget-exceeds-warning',
          workload.id,
          `deregistration (${budget.deregistrationDelaySeconds}s) plus grace ` +
            `(${budget.stopTimeoutSeconds}s) is ${drainBudgetSeconds(budget)}s, and the warning ` +
            `is ${FARGATE_SPOT_WARNING_SECONDS}s. ECS deregisters before it signals, so these ` +
            'do not overlap: the overshoot is time the process does not get, and it ends in ' +
            'SIGKILL.',
        );
      }
    }

    if (workload.posture === 'spot-with-base') {
      if (base < 1) {
        add(
          'base-missing',
          workload.id,
          'spot-with-base and the base is zero, which is spot-only wearing the safer name. A ' +
            'Spot shortage then leaves the service with no tasks and no alarm, because the ' +
            'utilisation metrics that would go red belong to tasks that do not exist.',
        );
      }
    } else if (base > 0) {
      add(
        'spot-only-with-base',
        workload.id,
        `spot-only declares an on-demand base of ${base}. One of the two is wrong, and the ` +
          'template follows the base.',
      );
    }

    if ((workload.spotWeight ?? 1) < 1) {
      add(
        'spot-weight-not-positive',
        workload.id,
        `spotWeight is ${workload.spotWeight}. A Spot provider with weight 0 above a base ` +
          'places nothing on Spot, so the workload is on-demand under another name.',
      );
    }

    if (workload.criticality === 'user-facing-slo') {
      add(
        'slo-workload-on-spot',
        workload.id,
        'Carries a user-facing objective and runs on Spot. An error budget does not ' +
          'distinguish a request failed by a bug from one failed by a reclaim, so the capacity ' +
          'decision would be spending the budget the objective is measured against.',
      );
    }
    if (workload.criticality === 'release-mechanism' || workload.criticality === 'instance-affinity') {
      add(
        'mechanism-workload-on-spot',
        workload.id,
        `criticality is ${workload.criticality} and the posture places tasks on Spot. Both of ` +
          'these fail by producing a wrong answer rather than by going down — a rolled-back ' +
          'release, a trace decided on a fragment — and neither failure is visible as an ' +
          'interruption.',
      );
    }
    if (workload.posture === 'spot-only' && workload.criticality === 'staging-grade') {
      add(
        'staging-workload-without-base',
        workload.id,
        'A staging-grade workload is something people depend on being up without an objective ' +
          'saying so, which is exactly the case a base exists for: nobody is watching it ' +
          'closely enough to notice it is gone.',
      );
    }
  }

  return findings;
};

/** Throws on any finding. Called by the stacks, so a bad catalogue fails synth. */
export const assertValidSpotCatalogue = (
  workloads: readonly SpotWorkload[] = SPOT_WORKLOADS,
): void => {
  const findings = validateSpotCatalogue(workloads);
  if (findings.length === 0) return;
  throw new Error(
    `Invalid Spot capacity catalogue:\n${findings
      .map((finding) => `  [${finding.rule}] ${finding.subject}: ${finding.message}`)
      .join('\n')}`,
  );
};

/* ── Rendering ────────────────────────────────────────────────────────────── */

/** The posture table, rendered from {@link SPOT_WORKLOADS} for docs/spot.md. */
export const renderSpotTable = (
  workloads: readonly SpotWorkload[] = SPOT_WORKLOADS,
): string => {
  const header = [
    '| Workload | Services | Posture | On-demand base | Criticality | Drain budget |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const rows = workloads.map((workload) => {
    const budget = workload.drainBudget;
    const cells = [
      `\`${workload.id}\``,
      String(workload.expectedResources),
      workload.posture,
      usesSpot(workload) ? String(workload.onDemandBase ?? 0) : '—',
      workload.criticality,
      budget
        ? `${drainBudgetSeconds(budget)}s (${budget.deregistrationDelaySeconds}s + ` +
          `${budget.stopTimeoutSeconds}s), ${drainSlackSeconds(budget)}s spare`
        : '—',
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return [...header, ...rows].join('\n');
};

/** Service counts by posture, for the guide's opening paragraph and the audit summary. */
export const postureTotals = (
  workloads: readonly SpotWorkload[] = SPOT_WORKLOADS,
): Record<SpotPosture, number> => {
  const totals: Record<SpotPosture, number> = {
    'spot-only': 0,
    'spot-with-base': 0,
    'on-demand-only': 0,
  };
  for (const workload of workloads) totals[workload.posture] += workload.expectedResources;
  return totals;
};
