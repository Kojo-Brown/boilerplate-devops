/**
 * Which compute this repository will let an AWS Compute Optimizer finding
 * resize, and which it will not — with the reason on every entry.
 *
 * Compute Optimizer is the only cost lever here that proposes a change to a
 * *running* workload's capacity rather than to its price. Spot changes who may
 * take the capacity away; Graviton changes what the capacity costs per hour;
 * right-sizing changes how much of it there is. That makes the failure mode
 * different in kind from the other two: a Spot reclaim is an event somebody can
 * see, and an arm64 image that will not run fails at task placement. A task
 * given 25% less memory than it needs runs perfectly until the day the traffic
 * that needed it arrives, and the finding that caused it is three weeks old.
 *
 * ## The thing that makes this item mostly about what *cannot* be automated
 *
 * Compute Optimizer does not produce an ECS service recommendation for a service
 * that has a step scaling policy attached, or a target tracking policy on **both**
 * CPU and memory — AWS documents both as disqualifying conditions. `EcsStack`
 * attaches `scaleOnCpuUtilization` *and* `scaleOnMemoryUtilization`, so the two
 * services in this repository that carry the application — the most expensive
 * compute in the account, and the only compute a customer ever reaches — are
 * structurally invisible to the service this item is about.
 *
 * That is not a gap in the automation; it is the shape of the automation. And it
 * fails in the direction nobody checks:
 *
 *   • `GetECSServiceRecommendations` does not report "this service is excluded".
 *     It returns a list, and an excluded service is simply not in it.
 *   • So a sweep that counts over-provisioned services finds none, publishes a
 *     zero, and a zero reads exactly like "this account is right-sized".
 *   • The two services that are excluded are the ones whose size somebody
 *     actually guessed. The ones that *are* covered are the ones whose size was
 *     chosen deliberately and written down.
 *
 * Eligibility and safety are inversely correlated here, and the entry that says
 * so out loud is `otel-sampler-service`: the tail-sampling tier has no scaling
 * policy *on purpose* (see `docs/otel-collector.md`), which is exactly what
 * makes it the one service Compute Optimizer will confidently recommend
 * shrinking. Its memory is a span buffer. Fourteen days of low average
 * utilisation on a buffer is the buffer not having been needed yet, which is
 * what a buffer looks like when it is working.
 *
 * ## Why nothing here applies a recommendation to a live resource
 *
 * Every resource in this account is tagged `ManagedBy: CDK`, which
 * `policy/cloudformation/tags.rego` describes as "the resource is CDK's and must
 * not be edited in the console". An automation calling `ecs:UpdateService` with
 * a resized task definition would be doing precisely that, and the result is
 * worse than a refused change: the next `cdk deploy` reverts it, the saving
 * disappears, and nothing reports either event. The applied change and the
 * reverted change look identical from CloudWatch.
 *
 * So what is automated is everything up to the diff: reading the enrolment
 * status, reading the findings, discarding the ones the catalogue holds,
 * validating the recommended size against the Fargate size table and this
 * repository's floors, requiring agreement where two resources must stay the
 * same size, and publishing both the proposal and — the part that matters — the
 * resources it got no finding for. The change itself is three lines in
 * `bin/app.ts` and a pull request.
 *
 * `validateRightSizingCatalogue` is the offline half and runs at synth time.
 * `tools/audit-right-sizing.ts` is the other half: it reads what `cdk synth`
 * wrote and holds the templates to what is declared here, because
 * `uncoveredReason: 'dual-target-tracking'` is a claim about two
 * `AWS::ApplicationAutoScaling::ScalingPolicy` resources and nothing in
 * TypeScript connects the two.
 *
 * See docs/right-sizing.md.
 */

/* ── What the platform gives us ───────────────────────────────────────────── */

/**
 * Days of CloudWatch metrics Compute Optimizer analyses by default.
 *
 * The number that makes a *floor* necessary rather than a nicety: a service
 * whose load is a weekly release rehearsal is idle for thirteen of these
 * fourteen days, and the average over the window is a true statement about a
 * period that does not include the hour the capacity exists for.
 */
export const DEFAULT_LOOKBACK_DAYS = 14;

/**
 * Hours of ECS and CloudWatch metrics a service needs before it gets a
 * recommendation at all.
 *
 * AWS's documented minimum. It is why `preview-pr-service` is `uncovered`
 * rather than merely unlucky — a preview environment is created for one pull
 * request and reaped with it, so for most of them this threshold is never
 * reached, and for the ones that are, the proposal would outlive the service it
 * was about.
 */
export const MINIMUM_ECS_METRIC_HOURS = 24;

/**
 * Invocations in {@link DEFAULT_LOOKBACK_DAYS} days below which a Lambda
 * function gets no memory recommendation.
 *
 * AWS returns `finding: Unavailable` with
 * `findingReasonCodes: [InsufficientData]` for these, and they do not appear in
 * the Compute Optimizer console at all. Most of this repository's handlers run
 * on a daily or monthly schedule, which is 14 or 1 invocations per window — so
 * the Lambda half of this sweep is a coverage report rather than a proposal
 * stream, and docs/right-sizing.md §7 gives the counts.
 */
export const LAMBDA_MINIMUM_INVOCATIONS = 50;

/**
 * Configured Lambda memory above which Compute Optimizer returns
 * `findingReasonCodes: [Inconclusive]` instead of a recommendation.
 *
 * Every function in this repository is below it, which is worth recording
 * because it means "no Lambda finding here" has exactly one cause — the
 * invocation count — and not two.
 */
export const LAMBDA_RECOMMENDATION_MEMORY_CEILING_MIB = 1792;

/** Compute Optimizer's account-level enrolment value that means it is running. */
export const ENROLMENT_ACTIVE = 'Active';

/** The two findings that carry a resize, as the ECS recommendation reports them. */
export const OVER_PROVISIONED_FINDING = 'Overprovisioned';
export const UNDER_PROVISIONED_FINDING = 'Underprovisioned';
/** The third, which carries no change. */
export const OPTIMIZED_FINDING = 'Optimized';

/**
 * The currency `savingsOpportunity.estimatedMonthlySavings` is summed in.
 *
 * Checked rather than assumed. The field carries its own `currency`, an account
 * billed in another one returns that one, and a sum over mixed currencies is a
 * number in none of them — which still renders on a dashboard and still looks
 * like money. A finding in any other currency is counted into
 * {@link SAVING_UNCOUNTED_METRIC} instead of silently added.
 */
export const SAVINGS_CURRENCY = 'USD';

/* ── What this repository publishes about right-sizing ────────────────────── */

/** Namespace for every metric the sweeper publishes. */
export const RIGHT_SIZING_METRIC_NAMESPACE = 'Boilerplate/RightSizing';

/** 1 when Compute Optimizer is enrolled for the account, 0 when it is not. */
export const ENROLLED_METRIC = 'Enrolled';

/**
 * 1 per completed sweep.
 *
 * The only metric here whose absence is the signal. Everything else can read
 * zero for a healthy reason; a sweep that did not happen produces no data at
 * all, and the alarm over this one treats that as breaching.
 */
export const SWEEP_SUCCESS_METRIC = 'SweepSuccess';

/** ECS service recommendations read, whatever the finding. */
export const FINDINGS_READ_METRIC = 'FindingsRead';

/** Findings that survived the catalogue and produced an appliable size. */
export const PROPOSALS_METRIC = 'Proposals';

/**
 * Findings the catalogue refused to turn into a proposal, dimensioned by why.
 *
 * Published rather than inferred from `FindingsRead - Proposals`, because the
 * reasons are the content: a `hold` entry and a recommendation that failed the
 * Fargate size table are both "not proposed" and nothing else about them is
 * alike.
 */
export const PROPOSALS_BLOCKED_METRIC = 'ProposalsBlocked';

/**
 * Catalogued resources Compute Optimizer returned no finding for.
 *
 * The metric this whole module exists for. An absent finding is how an excluded
 * service, a service below the metric threshold and a service AWS has not got
 * round to all present themselves, and none of the three is distinguishable
 * from "optimised" in any count of findings.
 */
export const COVERAGE_GAP_METRIC = 'CoverageGap';

/**
 * Findings for resources the catalogue declares `uncovered`.
 *
 * Structurally zero while the claim holds, so a non-zero reading means the claim
 * is wrong — usually because a scaling policy was removed, which makes a
 * service eligible and makes this catalogue's entry for it a stale excuse.
 * Deliberately not alarmed; docs/right-sizing.md §5 says why.
 */
export const UNEXPECTED_FINDING_METRIC = 'UnexpectedFinding';

/** Estimated monthly saving, in {@link SAVINGS_CURRENCY}, across all proposals. */
export const SAVING_METRIC = 'EstimatedMonthlySaving';

/** Findings whose saving arrived in some other currency and was not summed. */
export const SAVING_UNCOUNTED_METRIC = 'SavingUncountedCurrency';

/** Lambda recommendations read, and the two reasons there is nothing to read. */
export const LAMBDA_FINDINGS_READ_METRIC = 'LambdaFindingsRead';
export const LAMBDA_UNAVAILABLE_METRIC = 'LambdaUnavailable';

/* ── The Fargate size table ───────────────────────────────────────────────── */

/**
 * One row of the task CPU / memory combinations Fargate accepts.
 *
 * A recommendation is a pair, and the pair is the thing that can be invalid:
 * `RegisterTaskDefinition` rejects 512 CPU with 512 MiB of memory, which is a
 * failed deploy at the end of a pipeline rather than a review comment on the
 * pull request that proposed it.
 */
export interface FargateSizeRow {
  readonly cpu: number;
  readonly minMemoryMiB: number;
  readonly maxMemoryMiB: number;
  /** Memory step within the row. The two smallest rows are enumerated instead. */
  readonly stepMiB?: number;
  /** Explicit values, where the row is not an arithmetic series. */
  readonly memoryMiB?: readonly number[];
}

/**
 * The rows this repository is prepared to propose, and deliberately not all of
 * them.
 *
 * Fargate also accepts 8192 and 16384 CPU, and those two rows are **deliberately
 * absent**. Every task in this repository is 256, 512 or 1024 CPU, so neither is
 * within two doublings of anything here — and an incorrect row is worse than a
 * missing one in both directions: one that is too permissive proposes a pair
 * `RegisterTaskDefinition` rejects, and one that is too strict rejects a
 * recommendation that was fine. A recommendation naming a CPU value above
 * {@link CATALOGUED_MAX_CPU} is reported as `size-outside-catalogue` and read by
 * a human, which is the honest outcome for a size this table cannot speak for.
 *
 * Provenance, stated the way `ARCHITECTURE_PRICES` states its own: the five rows
 * here are the task CPU and memory combinations AWS documents for Fargate in the
 * Amazon ECS developer guide. They are **not** reproduced from a reading of that
 * page taken while this file was written — the page was not reachable from the
 * environment this was built in — so they carry no read date, unlike the price
 * observations in `lib/graviton-migration.ts`. What holds them honest instead is
 * `task-size-invalid` in `tools/audit-right-sizing.ts`: every task size this
 * repository actually synthesises is checked against this table on every build,
 * so a wrong row would have to be wrong in a way that agrees with eleven
 * deployed task definitions. Before adding a row, read the page.
 */
export const FARGATE_SIZE_ROWS: readonly FargateSizeRow[] = [
  { cpu: 256, minMemoryMiB: 512, maxMemoryMiB: 2048, memoryMiB: [512, 1024, 2048] },
  { cpu: 512, minMemoryMiB: 1024, maxMemoryMiB: 4096, stepMiB: 1024 },
  { cpu: 1024, minMemoryMiB: 2048, maxMemoryMiB: 8192, stepMiB: 1024 },
  { cpu: 2048, minMemoryMiB: 4096, maxMemoryMiB: 16384, stepMiB: 1024 },
  { cpu: 4096, minMemoryMiB: 8192, maxMemoryMiB: 30720, stepMiB: 1024 },
];

/** The largest CPU value {@link FARGATE_SIZE_ROWS} covers. */
export const CATALOGUED_MAX_CPU = 4096;

/** The row for a CPU value, or `undefined` where this table does not cover it. */
export const fargateSizeRow = (cpu: number): FargateSizeRow | undefined =>
  FARGATE_SIZE_ROWS.find((row) => row.cpu === cpu);

/** Is this exact task CPU / memory pair one Fargate will register? */
export const isValidFargateSize = (cpu: number, memoryMiB: number): boolean => {
  const row = fargateSizeRow(cpu);
  if (!row) return false;
  if (row.memoryMiB) return row.memoryMiB.includes(memoryMiB);
  if (memoryMiB < row.minMemoryMiB || memoryMiB > row.maxMemoryMiB) return false;
  const step = row.stepMiB ?? 1024;
  return (memoryMiB - row.minMemoryMiB) % step === 0;
};

/* ── The catalogue ────────────────────────────────────────────────────────── */

/**
 * What the sweeper may do with a finding about this resource.
 *
 *   `propose`    turn a finding into a concrete size for `bin/app.ts`.
 *   `hold`       record the finding and propose nothing, for the reason in
 *                `holdReason` — the size is a deliberate choice that a
 *                utilisation average cannot see.
 *   `uncovered`  Compute Optimizer structurally produces no finding for it. The
 *                posture that has to be *declared*, because its symptom is an
 *                empty result and an empty result is what success looks like.
 */
export type RightSizingPosture = 'propose' | 'hold' | 'uncovered';

/** Why Compute Optimizer cannot produce a finding. */
export type UncoveredReason =
  /**
   * A target tracking policy on CPU *and* on memory. AWS documents this, and a
   * step scaling policy, as disqualifying a service from ECS recommendations.
   */
  | 'dual-target-tracking'
  /** A step scaling policy, the other documented disqualification. */
  | 'step-scaling'
  /**
   * The resource does not live long enough to accumulate
   * {@link MINIMUM_ECS_METRIC_HOURS} of metrics, or is deleted before a
   * proposal about it could be merged.
   */
  | 'ephemeral-lifetime';

/** Why a finding about this resource must not become a proposal. */
export type HoldReason =
  /**
   * Its memory is a buffer, so the utilisation average Compute Optimizer reads
   * is low exactly when the buffer is doing its job.
   */
  | 'headroom-is-the-point'
  /**
   * Two resources are compared against each other, so resizing one of them
   * invalidates the comparison rather than the resource.
   */
  | 'paired-comparison';

export interface RightSizingFloor {
  /** The smallest task CPU a proposal may name. */
  readonly cpu: number;
  /** The smallest task memory a proposal may name, in MiB. */
  readonly memoryMiB: number;
}

export interface RightSizingWorkload {
  /** Unique, stable, kebab-case. Appears in the sweeper's log and the audit. */
  readonly id: string;
  /**
   * Stack name prefixes whose services this entry claims.
   *
   * Prefixes rather than names, for the reason `lib/spot-capacity.ts` gives: the
   * per-pull-request preview stack is `PreviewPrStack-<number>` and a catalogue
   * that enumerated those would have to be edited by CI.
   */
  readonly stackPrefixes: readonly string[];
  /** Construct path suffix of the `AWS::ECS::Service`, e.g. `Service/Service`. */
  readonly servicePathSuffix: string;
  /**
   * How the sweeper recognises this entry's services at runtime.
   *
   * A glob over the `ServiceName` the template declares, in which `*` is any
   * run of characters. Needed because a Compute Optimizer recommendation carries
   * a service ARN and nothing else: there is no construct path at runtime, so
   * the two halves of this catalogue match on different things, and a pattern
   * that matches nothing is invisible from both ends — the sweeper never sees
   * the service, so it reports no coverage gap for it either.
   *
   * `tools/audit-right-sizing.ts` holds every pattern to the names `cdk synth`
   * actually wrote, in both directions, which is the only thing that makes the
   * claim checkable.
   */
  readonly serviceNamePattern: string;
  readonly posture: RightSizingPosture;
  readonly uncoveredReason?: UncoveredReason;
  readonly holdReason?: HoldReason;
  /**
   * Why this posture, in the form "what goes wrong if a finding about this is
   * applied". Not a description of the workload: the `hold` and `uncovered`
   * entries are the content of this catalogue, and what makes them reviewable is
   * the failure.
   */
  readonly reason: string;
  /** How many `AWS::ECS::Service` resources this entry should match. */
  readonly expectedResources: number;
  /** Required by `propose`, refused on the other two postures. */
  readonly floor?: RightSizingFloor;
  /**
   * Every resource this entry matches must end up the same size.
   *
   * True for the release mechanisms, where staging and production are copies of
   * each other: a release rehearsed on a different task size from the one
   * production uses has not been rehearsed, which is the argument
   * `lib/spot-capacity.ts` makes about capacity and is the same argument about
   * size. A proposal for such an entry needs a finding for every resource it
   * matches, and needs them to agree.
   */
  readonly uniformSize?: boolean;
  /**
   * Ids of other entries whose size this entry's must equal. Symmetric, and
   * validated as such.
   */
  readonly sizeMustMatch?: readonly string[];
  readonly note?: string;
}

/**
 * Every ECS service this repository synthesises, and what a Compute Optimizer
 * finding about it is allowed to do.
 *
 * The audit requires this list to account for all of them: a service no entry
 * matches fails `service-unclassified`, so the next stack that adds one cannot
 * default quietly into either being resized or being ignored.
 */
export const RIGHT_SIZING_WORKLOADS: readonly RightSizingWorkload[] = [
  {
    id: 'staging-application',
    stackPrefixes: ['EcsStack-Staging'],
    servicePathSuffix: 'Service/Service',
    serviceNamePattern: 'staging-service',
    posture: 'uncovered',
    uncoveredReason: 'dual-target-tracking',
    reason:
      'EcsStack attaches target tracking policies to both CPU and memory, which AWS documents ' +
      'as disqualifying a service from ECS rightsizing recommendations. Nothing reports the ' +
      'exclusion: GetECSServiceRecommendations returns a list and this service is not in it, so ' +
      'the sweep sees no over-provisioning here and a zero reads as "right-sized" rather than ' +
      'as "not measured".',
    expectedResources: 1,
    note:
      'Removing either scaling policy would make this service eligible, and the first sign ' +
      'would be a finding about a task size nobody chose deliberately — `cpu: 512` in ' +
      'bin/app.ts is a starting point, not a measurement. That is the one case the ' +
      'UnexpectedFinding metric exists for.',
  },
  {
    id: 'production-application',
    stackPrefixes: ['EcsStack-Production'],
    servicePathSuffix: 'Service/Service',
    serviceNamePattern: 'production-service',
    posture: 'uncovered',
    uncoveredReason: 'dual-target-tracking',
    reason:
      'The same two scaling policies, on the service that carries the availability and latency ' +
      'objectives in lib/slo-definitions.ts. This is the most expensive compute in the account ' +
      'and the only compute a customer reaches, and it is the one resource this entire item ' +
      'cannot see — which is the honest headline of docs/right-sizing.md rather than a ' +
      'footnote in it.',
    expectedResources: 1,
  },
  {
    id: 'preview-pr-service',
    stackPrefixes: ['PreviewPrStack-'],
    servicePathSuffix: 'Service/Service',
    serviceNamePattern: 'preview-pr-*',
    posture: 'uncovered',
    uncoveredReason: 'ephemeral-lifetime',
    reason:
      'A preview exists for one pull request and is reaped with it, so most of them never reach ' +
      `the ${MINIMUM_ECS_METRIC_HOURS} hours of metrics a recommendation needs, and for the ` +
      'ones that do the proposal would outlive the service it is about. Resizing the preview ' +
      'template from a finding about one pull request’s branch would also be sizing every ' +
      'future preview from whatever that branch happened to do.',
    expectedResources: 1,
  },
  {
    id: 'blue-green-service',
    stackPrefixes: ['BlueGreenDeployStack-'],
    servicePathSuffix: 'Service/Service',
    serviceNamePattern: '*-bg-service',
    posture: 'propose',
    reason:
      'No scaling policy, so Compute Optimizer can see it, and its size is a guess rather than ' +
      'a constraint — CodeDeploy shifts traffic between two task sets of whatever size the ' +
      'task definition declares. A resize lands through a pull request and the next release, ' +
      'which is the mechanism this service already is; what must not happen is a resize applied ' +
      'to one environment and not the other.',
    expectedResources: 2,
    // The task sizes in bin/app.ts are 512/1024 for staging and 1024/2048 for
    // production, so the floor is the smaller of the two rounded down to the
    // smallest row that still fits an application container: a release
    // mechanism that cannot hold the application is not a release mechanism.
    floor: { cpu: 512, memoryMiB: 1024 },
    uniformSize: true,
    note:
      'uniformSize is the whole of this entry. lib/spot-capacity.ts refuses Spot here because a ' +
      'release mechanism rehearsed on different capacity from production’s has not been ' +
      'rehearsed; the same sentence is true of task size, and a finding arrives per service ' +
      'rather than per mechanism.',
  },
  {
    id: 'canary-stable-service',
    stackPrefixes: ['CanaryDeployStack-'],
    servicePathSuffix: 'StableService/Service',
    serviceNamePattern: '*-stable-service',
    posture: 'hold',
    holdReason: 'paired-comparison',
    reason:
      'The canary analyser promotes or rolls back on the difference between this service’s ' +
      'error rate and latency and the canary’s. Resizing one side moves one of those two ' +
      'numbers for a reason that has nothing to do with the revision under test, and the ' +
      'analyser cannot tell the two apart — the failure is a wrong verdict, which reads ' +
      'exactly like a correct one. A finding here is held rather than proposed because the two ' +
      'sides receive separate findings and nothing guarantees they agree.',
    expectedResources: 2,
    sizeMustMatch: ['canary-deploy-canary-service'],
  },
  {
    id: 'canary-deploy-canary-service',
    stackPrefixes: ['CanaryDeployStack-'],
    servicePathSuffix: 'CanaryService/Service',
    serviceNamePattern: '*-canary-service',
    posture: 'hold',
    holdReason: 'paired-comparison',
    reason:
      'The canary half of the comparison above, and the more exposed of the two: it runs at a ' +
      'fraction of the stable service’s task count, so its utilisation average is computed ' +
      'over a smaller sample and a resize changes the comparison by more. Held for the same ' +
      'reason and declared separately because the audit matches a construct path, and these two ' +
      'are different paths in the same stack.',
    expectedResources: 2,
    sizeMustMatch: ['canary-stable-service'],
  },
  {
    id: 'otel-sampler-service',
    stackPrefixes: ['OtelCollectorStack-'],
    servicePathSuffix: 'Service/Service',
    serviceNamePattern: '*-otel-sampler',
    posture: 'hold',
    holdReason: 'headroom-is-the-point',
    reason:
      'The tail-sampling tier holds every span of a trace in memory until the trace is complete, ' +
      'so its memory is a buffer sized for the burst rather than for the average. Fourteen days ' +
      'of low average memory utilisation on a buffer is the buffer not having been needed yet, ' +
      'and shrinking it trades a monthly saving for spans dropped during exactly the incident ' +
      'the traces are being kept for. It is also the one service here with no scaling policy at ' +
      'all — deliberately, because the tier is a hash ring — which is what makes it ' +
      'the service Compute Optimizer can see most clearly and the one that must not be resized.',
    expectedResources: 2,
    note:
      'This entry is the argument of docs/right-sizing.md §3: eligibility and safety point ' +
      'in opposite directions. The services excluded by their scaling policies are the ones ' +
      'whose size was guessed; the ones Compute Optimizer measures confidently are the ones ' +
      'whose size was chosen and written down.',
  },
];

/* ── Matching ─────────────────────────────────────────────────────────────── */

/**
 * A glob in which `*` is any run of characters, anchored at both ends.
 *
 * The same shape as `matchesPattern` in `lib/runbooks.ts`, and here rather than
 * imported from it because the two are about different things and a shared
 * helper would make a change to one a change to both.
 */
export const serviceNameMatches = (pattern: string, serviceName: string): boolean =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  ).test(serviceName);

/**
 * How specific a pattern is, for a deterministic choice when two match.
 *
 * Fewer wildcards first, then more literal characters. The audit forbids the
 * ambiguity outright — `service-name-pattern-ambiguous` — so this exists to make
 * the runtime behaviour decidable rather than to resolve a real tie: a sweeper
 * whose answer depended on object key order would report a different posture on
 * a different day.
 */
export const patternSpecificity = (pattern: string): number =>
  (pattern.split('*').length - 1) * -1000 + pattern.replace(/\*/g, '').length;

/** The entry whose `serviceNamePattern` claims this name, most specific first. */
export const rightSizingWorkloadForServiceName = (
  serviceName: string,
  workloads: readonly RightSizingWorkload[] = RIGHT_SIZING_WORKLOADS,
): RightSizingWorkload | undefined =>
  [...workloads]
    .filter((workload) => serviceNameMatches(workload.serviceNamePattern, serviceName))
    .sort(
      (left, right) =>
        patternSpecificity(right.serviceNamePattern) -
        patternSpecificity(left.serviceNamePattern),
    )[0];

/** Does this entry claim a service at `constructPath` in `stackName`? */
export const rightSizingWorkloadMatches = (
  workload: RightSizingWorkload,
  resource: { readonly stackName: string; readonly constructPath: string },
): boolean =>
  workload.stackPrefixes.some((prefix) => resource.stackName.startsWith(prefix)) &&
  resource.constructPath.endsWith(workload.servicePathSuffix);

/** Entries claiming a given service. More than one is a finding, not a tie-break. */
export const rightSizingWorkloadsFor = (
  resource: { readonly stackName: string; readonly constructPath: string },
  workloads: readonly RightSizingWorkload[] = RIGHT_SIZING_WORKLOADS,
): readonly RightSizingWorkload[] =>
  workloads.filter((workload) => rightSizingWorkloadMatches(workload, resource));

/**
 * The entry with this id, or a thrown error.
 *
 * Throws rather than returning `undefined` because every caller is a stack
 * wiring the sweeper: a typo would otherwise ship a catalogue missing an entry,
 * and a missing entry is a service the sweeper proposes nothing for and reports
 * no gap about — indistinguishable from one that is optimised.
 */
export const rightSizingWorkloadById = (
  id: string,
  workloads: readonly RightSizingWorkload[] = RIGHT_SIZING_WORKLOADS,
): RightSizingWorkload => {
  const workload = workloads.find((candidate) => candidate.id === id);
  if (!workload) {
    throw new Error(
      `No right-sizing workload with id ${JSON.stringify(id)}. Known ids: ${workloads
        .map((candidate) => candidate.id)
        .join(', ')}.`,
    );
  }
  return workload;
};

/* ── Arithmetic ───────────────────────────────────────────────────────────── */

/** True for the one posture that can turn a finding into a size. */
export const isProposable = (workload: RightSizingWorkload): boolean =>
  workload.posture === 'propose';

/**
 * Why a recommended size cannot be proposed, or `undefined` when it can.
 *
 * Ordered so the answer a reader needs comes first: a posture decision is about
 * the workload and outranks anything about the numbers, and an invalid pair
 * outranks a floor because a pair Fargate rejects is not a smaller size, it is
 * not a size.
 */
export type ProposalBlock =
  | 'posture-hold'
  | 'posture-uncovered'
  | 'size-outside-catalogue'
  | 'size-invalid-for-fargate'
  | 'below-floor'
  | 'peer-disagreement';

export interface RecommendedSize {
  readonly cpu: number;
  readonly memoryMiB: number;
}

/**
 * Whether a recommendation may become a proposal, and why not when it may not.
 *
 * `peers` carries the sizes recommended for the resources that must stay the
 * same size as this one — the other services this entry matches when
 * `uniformSize` is set, plus every entry named in `sizeMustMatch`. An empty
 * `peers` on an entry that requires agreement is itself a disagreement: a
 * missing finding is not consent.
 */
export const blockingReason = (
  workload: RightSizingWorkload,
  size: RecommendedSize,
  peers: readonly RecommendedSize[] = [],
): ProposalBlock | undefined => {
  if (workload.posture === 'hold') return 'posture-hold';
  if (workload.posture === 'uncovered') return 'posture-uncovered';
  if (size.cpu > CATALOGUED_MAX_CPU || !fargateSizeRow(size.cpu)) return 'size-outside-catalogue';
  if (!isValidFargateSize(size.cpu, size.memoryMiB)) return 'size-invalid-for-fargate';

  const floor = workload.floor;
  if (floor && (size.cpu < floor.cpu || size.memoryMiB < floor.memoryMiB)) return 'below-floor';

  const needsAgreement = workload.uniformSize === true || (workload.sizeMustMatch?.length ?? 0) > 0;
  if (!needsAgreement) return undefined;

  // A resource this entry claims that produced no finding leaves `peers` one
  // shorter than it should be, and the arithmetic below cannot see the
  // difference between "they all agree" and "only one answered". So the count is
  // checked before the values: an entry matching two services needs two sizes,
  // and an entry naming a peer needs that peer's too.
  const expectedPeers =
    (workload.uniformSize === true ? workload.expectedResources - 1 : 0) +
    (workload.sizeMustMatch?.length ?? 0);
  if (peers.length !== expectedPeers) return 'peer-disagreement';

  const disagrees = peers.some(
    (peer) => peer.cpu !== size.cpu || peer.memoryMiB !== size.memoryMiB,
  );
  return disagrees ? 'peer-disagreement' : undefined;
};

/* ── Validation ───────────────────────────────────────────────────────────── */

export interface RightSizingCatalogueFinding {
  readonly rule: string;
  readonly subject: string;
  readonly message: string;
}

/**
 * The shortest a `reason` may be.
 *
 * A length floor is a crude rule and it is here for the reason
 * `lib/spot-capacity.ts` gives for its own: this catalogue is read by somebody
 * deciding whether a finding about their service is actionable, and
 * `reason: 'not safe'` satisfies every other rule in this file while telling
 * them nothing. Ninety characters is about one sentence naming a failure.
 */
export const MINIMUM_REASON_LENGTH = 90;

/**
 * Everything about this catalogue that is decidable offline.
 *
 * Called at synth time by the stack that reads the catalogue, so a bad entry is
 * a failed synth rather than a deployed sweeper. The template-facing half — do
 * the scaling policies actually match the `uncovered` claim — is
 * `tools/audit-right-sizing.ts`, which needs `cdk.out`.
 */
export const validateRightSizingCatalogue = (
  workloads: readonly RightSizingWorkload[] = RIGHT_SIZING_WORKLOADS,
): readonly RightSizingCatalogueFinding[] => {
  const findings: RightSizingCatalogueFinding[] = [];
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
        'No stackPrefixes, so this entry claims every service with a matching construct path in ' +
          'every stack.',
      );
    }
    if (workload.servicePathSuffix.trim() === '') {
      add(
        'workload-no-path-suffix',
        workload.id,
        'No servicePathSuffix, so this entry claims every service in its stacks.',
      );
    }
    if (workload.serviceNamePattern.trim() === '') {
      add(
        'workload-no-service-name-pattern',
        workload.id,
        'No serviceNamePattern. The audit matches a construct path and the sweeper matches a ' +
          'service name out of a recommendation ARN; an entry with no pattern is invisible at ' +
          'runtime while passing every rule here.',
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
        `reason is ${workload.reason.trim().length} characters. The hold and uncovered entries ` +
          'are the content of this catalogue and a reason that does not name a failure cannot ' +
          'be reviewed.',
      );
    }

    if (workload.posture === 'uncovered' && !workload.uncoveredReason) {
      add(
        'uncovered-without-reason',
        workload.id,
        'Declares that Compute Optimizer produces no finding for this service and does not say ' +
          'why. The claim is the kind that goes stale silently — a scaling policy removed ' +
          'in a refactor makes the service eligible — and without the reason there is ' +
          'nothing for tools/audit-right-sizing.ts to check against the template.',
      );
    }
    if (workload.posture !== 'uncovered' && workload.uncoveredReason) {
      add(
        'uncovered-reason-without-posture',
        workload.id,
        `Carries uncoveredReason '${workload.uncoveredReason}' with posture ` +
          `'${workload.posture}'. One of the two is wrong, and the sweeper follows the posture.`,
      );
    }
    if (workload.posture === 'hold' && !workload.holdReason) {
      add(
        'hold-without-reason',
        workload.id,
        'Holds every finding about this service and does not say why. A hold with no reason is ' +
          'indistinguishable from an entry nobody has looked at since the service was added.',
      );
    }
    if (workload.posture !== 'hold' && workload.holdReason) {
      add(
        'hold-reason-without-posture',
        workload.id,
        `Carries holdReason '${workload.holdReason}' with posture '${workload.posture}'.`,
      );
    }

    if (workload.posture === 'propose') {
      if (!workload.floor) {
        add(
          'propose-without-floor',
          workload.id,
          'Proposable and declares no floor. The recommendation is an average over ' +
            `${DEFAULT_LOOKBACK_DAYS} days, and a service whose load is a weekly rehearsal is ` +
            'idle for thirteen of them — so the average is a true statement about a period ' +
            'that excludes the hour the capacity exists for.',
        );
      } else {
        const floor = workload.floor;
        if (!isValidFargateSize(floor.cpu, floor.memoryMiB)) {
          add(
            'floor-invalid-for-fargate',
            workload.id,
            `floor is ${floor.cpu} CPU / ${floor.memoryMiB} MiB, which is not a pair Fargate ` +
              'registers. A floor that is not itself a deployable size can never be reached, so ' +
              'every proposal below the next valid pair is rejected for the wrong reason.',
          );
        }
      }
    } else if (workload.floor) {
      add(
        'floor-on-unproposable-workload',
        workload.id,
        `Posture is '${workload.posture}' and a floor is declared. Nothing consults it — no ` +
          'proposal is ever produced for this entry — so it reads as a bound that is not one.',
      );
    }

    if (workload.uniformSize && workload.expectedResources < 2) {
      add(
        'uniform-size-on-single-resource',
        workload.id,
        'uniformSize with expectedResources of 1. There is nothing to be uniform with, and the ' +
          'agreement check would require zero peers — which passes, so the flag reads as a ' +
          'constraint while enforcing nothing.',
      );
    }

    for (const peerId of workload.sizeMustMatch ?? []) {
      if (peerId === workload.id) {
        add('size-match-self', workload.id, 'Names itself in sizeMustMatch.');
        continue;
      }
      const peer = workloads.find((candidate) => candidate.id === peerId);
      if (!peer) {
        add(
          'size-match-unknown-peer',
          workload.id,
          `sizeMustMatch names '${peerId}', which is not an entry here. The sweeper would look ` +
            'for a peer finding that cannot exist, so every proposal for this entry is blocked ' +
            'as a disagreement rather than reported as a broken reference.',
        );
        continue;
      }
      if (!(peer.sizeMustMatch ?? []).includes(workload.id)) {
        add(
          'size-match-not-symmetric',
          workload.id,
          `sizeMustMatch names '${peerId}' and '${peerId}' does not name it back. The ` +
            'constraint would then hold in one direction: a proposal for the peer could change ' +
            'its size without consulting this one.',
        );
      }
      if (
        peer.floor &&
        workload.floor &&
        (peer.floor.cpu !== workload.floor.cpu || peer.floor.memoryMiB !== workload.floor.memoryMiB)
      ) {
        add(
          'size-match-floors-differ',
          workload.id,
          `Must stay the same size as '${peerId}' and the two declare different floors. There ` +
            'is then a size that satisfies one floor, violates the other, and is the only size ' +
            'both could agree on.',
        );
      }
    }
  }

  return findings;
};

/** Throws on any finding. Called by the stack, so a bad catalogue fails synth. */
export const assertValidRightSizingCatalogue = (
  workloads: readonly RightSizingWorkload[] = RIGHT_SIZING_WORKLOADS,
): void => {
  const findings = validateRightSizingCatalogue(workloads);
  if (findings.length === 0) return;
  throw new Error(
    `Invalid right-sizing catalogue:\n${findings
      .map((finding) => `  [${finding.rule}] ${finding.subject}: ${finding.message}`)
      .join('\n')}`,
  );
};

/* ── Rendering ────────────────────────────────────────────────────────────── */

/** The posture table, rendered from {@link RIGHT_SIZING_WORKLOADS} for the guide. */
export const renderRightSizingTable = (
  workloads: readonly RightSizingWorkload[] = RIGHT_SIZING_WORKLOADS,
): string => {
  const header = [
    '| Workload | Services | Posture | Why | Floor | Must match |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const rows = workloads.map((workload) => {
    const why = workload.uncoveredReason ?? workload.holdReason ?? 'eligible, size is a guess';
    const peers = [
      ...(workload.uniformSize ? ['its own copies'] : []),
      ...(workload.sizeMustMatch ?? []).map((id) => `\`${id}\``),
    ];
    const cells = [
      `\`${workload.id}\``,
      String(workload.expectedResources),
      workload.posture,
      why,
      workload.floor ? `${workload.floor.cpu} / ${workload.floor.memoryMiB} MiB` : '—',
      peers.length > 0 ? peers.join(', ') : '—',
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return [...header, ...rows].join('\n');
};

/** Service counts by posture, for the guide's opening paragraph and the audit summary. */
export const postureTotals = (
  workloads: readonly RightSizingWorkload[] = RIGHT_SIZING_WORKLOADS,
): Record<RightSizingPosture, number> => {
  const totals: Record<RightSizingPosture, number> = { propose: 0, hold: 0, uncovered: 0 };
  for (const workload of workloads) totals[workload.posture] += workload.expectedResources;
  return totals;
};

/**
 * The catalogue as the sweeper's environment carries it.
 *
 * A projection rather than the whole entry: the handler needs the posture, the
 * floor, the pattern and the agreement constraints, and does not need the prose
 * — which is several kilobytes and would be the bulk of a Lambda environment
 * variable. The reasons stay in this file and in the guide, where they are read.
 */
export interface SweeperCatalogueEntry {
  readonly id: string;
  readonly pattern: string;
  readonly posture: RightSizingPosture;
  readonly floorCpu?: number;
  readonly floorMemoryMiB?: number;
  readonly uniformSize: boolean;
  readonly expectedResources: number;
  readonly sizeMustMatch: readonly string[];
  readonly blockedReason?: UncoveredReason | HoldReason;
}

/** {@link SweeperCatalogueEntry} for every entry, in catalogue order. */
export const sweeperCatalogue = (
  workloads: readonly RightSizingWorkload[] = RIGHT_SIZING_WORKLOADS,
): readonly SweeperCatalogueEntry[] =>
  workloads.map((workload) => ({
    id: workload.id,
    pattern: workload.serviceNamePattern,
    posture: workload.posture,
    ...(workload.floor ? { floorCpu: workload.floor.cpu, floorMemoryMiB: workload.floor.memoryMiB } : {}),
    uniformSize: workload.uniformSize === true,
    expectedResources: workload.expectedResources,
    sizeMustMatch: [...(workload.sizeMustMatch ?? [])],
    ...(workload.uncoveredReason || workload.holdReason
      ? { blockedReason: workload.uncoveredReason ?? workload.holdReason }
      : {}),
  }));
