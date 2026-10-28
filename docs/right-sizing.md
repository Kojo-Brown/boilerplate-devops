# Right-sizing: what Compute Optimizer can see, and what it cannot

AWS Compute Optimizer is the only cost lever in this repository that proposes a
change to a *running* workload's capacity rather than to its price. Spot changes
who may take capacity away; Graviton changes what an hour of it costs;
right-sizing changes how much of it there is.

That makes the failure different in kind from the other two. A Spot reclaim is an
event somebody can see. An arm64 image that cannot run fails at task placement,
loudly, during the deploy. A task given 25% less memory than it needs runs
perfectly until the day the traffic that needed it arrives — and the finding that
caused it is three weeks old by then.

So most of this page is about what *cannot* be automated, and the headline is
uncomfortable:

> **The two services that carry the application are structurally invisible to
> Compute Optimizer.** They are the most expensive compute in this account and
> the only compute a customer ever reaches, and AWS will never produce a
> right-sizing finding for either of them.

`lib/right-sizing.ts` is the catalogue. `lib/right-sizing-stack.ts` is the daily
sweep. `npm run audit:right-sizing` holds the synthesised templates to both.

---

## 1. What AWS actually promises

Compute Optimizer produces one task-level CPU and memory recommendation per ECS
service on Fargate, from the `CPUUtilization` and `MemoryUtilization` metrics
over a rolling window. Five of its conditions decide everything on this page:

| Condition | Consequence here |
| --- | --- |
| At least **24 hours** of ECS and CloudWatch metrics in the window | a preview environment reaped with its pull request often never reaches it |
| Default window is **14 days** | a service whose load is a weekly rehearsal is idle for thirteen of them, and the average is a true statement about a period that excludes the hour the capacity exists for |
| **No step scaling policy** attached | — nothing here uses one |
| **No target tracking policy on CPU *and* memory** | `EcsStack` attaches exactly that, which excludes staging's and production's application services |
| It is **opt-in per account** | before the opt-in every recommendation call answers `OptInRequiredException` |

The fourth row is the one this item is really about, and the reason is in the
*response*, not the condition:

**`GetECSServiceRecommendations` does not report an exclusion.** It returns a
list. An excluded service is simply not in it. There is no `finding:
NotApplicable`, no reason code, nothing to count. A sweep that iterates the
findings and totals the over-provisioned ones finds none, publishes a zero, and a
zero is the number a right-sized account publishes.

That is why the sweeper iterates the **catalogue** and asks which entries got a
finding, rather than iterating the findings and reporting what it was given. The
difference between those two loops is the `CoverageGap` metric.

---

## 2. The posture of every service

Three postures, and the two interesting ones are not `propose`:

* **`propose`** — a finding becomes a concrete `cpu` / `memoryLimitMiB` pair for
  `bin/app.ts`, if it survives the Fargate size table, the entry's floor, and
  agreement with anything that must stay the same size as it.
* **`hold`** — the finding is recorded and no proposal is produced, for the
  reason on the entry. The size is a deliberate choice that a utilisation average
  cannot see.
* **`uncovered`** — Compute Optimizer structurally produces no finding. This is
  the posture that has to be *declared*, because its symptom is an empty result
  and an empty result is what success looks like.

| Workload | Services | Posture | Why | Floor | Must match |
| --- | --- | --- | --- | --- | --- |
| `staging-application` | 1 | uncovered | dual-target-tracking | — | — |
| `production-application` | 1 | uncovered | dual-target-tracking | — | — |
| `preview-pr-service` | 1 | uncovered | ephemeral-lifetime | — | — |
| `blue-green-service` | 2 | propose | eligible, size is a guess | 512 / 1024 MiB | its own copies |
| `canary-stable-service` | 2 | hold | paired-comparison | — | `canary-deploy-canary-service` |
| `canary-deploy-canary-service` | 2 | hold | paired-comparison | — | `canary-stable-service` |
| `otel-sampler-service` | 2 | hold | headroom-is-the-point | — | — |

Eleven services: **2 proposable, 6 held, 3 that cannot produce a finding at
all.** The table is generated from `RIGHT_SIZING_WORKLOADS`; editing it by hand
fails `doc-table-drift`.

### The two that moved

`blue-green-service`, staging and production. It has no scaling policy, so
Compute Optimizer can see it, and its size is genuinely a guess: CodeDeploy
shifts traffic between two task sets of whatever size the task definition
declares, and nothing about the mechanism constrains that size.

`uniformSize` is the whole of the entry. `lib/spot-capacity.ts` refuses Spot here
because *a release mechanism rehearsed on different capacity from production's
has not been rehearsed*. The same sentence is true of task size — and a finding
arrives per **service**, not per mechanism. So a proposal needs a finding for
every service the entry matches, and needs them to agree. A missing finding is
not consent, which is why `blockingReason` counts the peers before it compares
them.

### The six that are held

`canary-stable-service` and `canary-deploy-canary-service` are one decision in
two entries. The canary analyser promotes or rolls back on the *difference*
between the two services' error rates and latencies. Resizing one side moves one
of those two numbers for a reason that has nothing to do with the revision under
test, and the analyser cannot tell the two apart: the failure is a **wrong
verdict**, which reads exactly like a correct one. They receive separate findings
and nothing makes those findings agree, so both are held and both name the other
in `sizeMustMatch`.

`otel-sampler-service` is the entry worth reading twice. Its memory is a
**buffer**: the tail-sampling tier holds every span of a trace until the trace is
complete. Fourteen days of low average memory utilisation on a buffer is the
buffer not having been needed yet, which is what a working buffer looks like.
Shrinking it trades a monthly saving for spans dropped during exactly the
incident the traces are being kept for.

### The three that cannot produce a finding

`staging-application` and `production-application`: `EcsStack` calls both
`scaleOnCpuUtilization` and `scaleOnMemoryUtilization`, and target tracking on
both metrics is a documented disqualification. Nothing reports it.

`preview-pr-service`: a preview exists for one pull request and is reaped with
it, so most never reach 24 hours of metrics, and for the ones that do the
proposal would outlive the service it was about. Resizing the preview *template*
from a finding about one branch would also be sizing every future preview from
whatever that branch happened to do.

---

## 3. Eligibility and safety point in opposite directions

This is the part that is not obvious from the AWS documentation, and it is the
argument of this page.

The services Compute Optimizer **cannot** see here are the ones whose size
somebody guessed. `cpu: 512` on staging's application service in `bin/app.ts` is
a starting point, not a measurement; it has never been checked against a load,
because no load has ever run.

The service Compute Optimizer can see **most clearly** is `otel-sampler-service`
— and it is clear precisely because the tier has no scaling policy, which is
deliberate: the tier is a hash ring, and `docs/otel-collector.md` explains why
scaling it reassigns trace ownership mid-trace. The one service with a confident
recommendation is the one whose size was chosen for a reason a utilisation
average cannot represent.

So the inventory is inverted. An automation that applied every finding it
received would resize nothing that was guessed and everything that was decided.
That is why there are two `propose` entries out of eleven, and why six carry a
`hold` with a written reason instead.

---

## 4. Enrolment: the zero that looks like success

Compute Optimizer is opt-in per account. Before the opt-in, every
`Get*Recommendations` call answers `OptInRequiredException` with HTTP 400.

A sweeper that wrapped its run in one `try` would log that once and publish a
finding count of zero — and zero over-provisioned services is the number an
optimised account publishes. Nothing would be broken. Nothing would ever have
been measured.

So enrolment is read **first and alone**:

1. `GetEnrollmentStatus`.
2. A status other than `Active` publishes `Enrolled: 0` and **returns**. No
   recommendation call is made, so no reassuring zero is published beside it.
3. `right-sizing-not-enrolled` is the alarm on it.

Opting in is one console action or one `update-enrollment-status` call. It is
deliberately **not** something this repository's automation can do: the opt-in
creates a service-linked role in the account, and a read-only sweeper that can
create roles is not a read-only sweeper. Allow a day or two of metric collection
before reading the first findings — a freshly enrolled account returns empty
results for a while, which is a fourth way an absent finding happens.

---

## 5. The three silent failures, and the five alarms

Every alarm here is a **ticket**, not a page. Nothing on this page is an outage;
everything on it is a number elsewhere quietly becoming untrue. All five go to
`docs/runbooks.md` §9 — "a platform component has stopped reporting" — because
that is literally what each of them means.

| Alarm | Cause | Missing data |
| --- | --- | --- |
| `right-sizing-sweep-stale` | no completed sweep in 48h | **breaching** |
| `right-sizing-not-enrolled` | the account was never opted in | not breaching |
| `right-sizing-coverage-gap` | a catalogued service got no finding | not breaching |
| `right-sizing-sweeper-errors` | the sweep ran and threw | not breaching |
| `right-sizing-sweep-undelivered` | EventBridge gave up delivering the schedule | not breaching |

**Absence has exactly one alarm.** `right-sizing-sweep-stale` is the only one
treating missing data as breaching, and the other four do not need to: a disabled
rule, a deleted schedule or a role that lost `compute-optimizer:Get*` produce no
datapoints at all, and every other alarm here would go quiet with them. One cause
makes one ticket. If the staleness alarm is red, read it before trusting any of
the others.

The alarm names carry **no environment prefix** and the stack carries no
`Environment` tag, because `RightSizingStack` is account-scoped: Compute
Optimizer answers per account and region, `bin/app.ts` puts both environments in
one account, and a per-environment copy would read the same findings twice and
double every count.

### What is published and deliberately not alarmed

* **`Proposals` and `EstimatedMonthlySaving`.** A saving is a decision, not an
  incident. Paging or ticketing a rota because money is being spent is how a rota
  learns to close right-sizing tickets unread.
* **`UnexpectedFinding`** — a finding for a service the catalogue calls
  `uncovered`. Structurally zero while the claim holds, so a non-zero reading
  means the claim is stale, usually a scaling policy removed in a refactor. It is
  published rather than alarmed because the template cause is caught at build
  time by `covered-service-excluded` and `uncovered-claim-unsupported`, and a
  console-made scaling change is drift the next deploy reverts — the same bargain
  `docs/spot.md` strikes for a console-edited capacity strategy.
* **`ProposalsBlocked`**, dimensioned by reason. Published rather than inferred
  from `FindingsRead - Proposals`, because the reasons are the content: a `hold`
  entry and a recommendation that failed the Fargate size table are both "not
  proposed" and nothing else about them is alike.

---

## 6. What a proposal is, and why nothing applies one

A proposal is a log line in the sweeper's log group and a `Proposals` datapoint.
It names the workload, the service, the finding, and the exact `cpu` /
`memoryLimitMiB` pair to put in `bin/app.ts`.

Nothing in this repository applies it, and the reason is not caution:

Every resource in this account is tagged `ManagedBy: CDK`, which
`policy/cloudformation/tags.rego` describes as *"the resource is CDK's and must
not be edited in the console"*. An automation calling `ecs:UpdateService` with a
resized task definition is doing precisely that. The result is worse than a
refused change: **the next `cdk deploy` reverts it, the saving disappears, and
neither event is reported anywhere.** The applied change and the reverted change
are indistinguishable from CloudWatch.

So `RightSizingStack`'s role holds three Compute Optimizer read actions and
`cloudwatch:PutMetricData` scoped to one namespace. It has no `ecs:*`, no
`lambda:*`, no `application-autoscaling:*`, and no
`compute-optimizer:UpdateEnrollmentStatus`. `sweeper-can-write` in the gate fails
the build if any of those appears, including through a policy attached later —
because one added `ecs:UpdateService` deploys cleanly and passes every other
check in this repository.

### What a proposal has to survive

In order, and the order matters — a posture decision is about the workload and
outranks anything about the numbers; an invalid pair is not a smaller size, it is
not a size:

1. **`posture-hold` / `posture-uncovered`** — the catalogue refuses.
2. **`size-outside-catalogue`** — a CPU value this table does not cover. Fargate
   also accepts 8192 and 16384; `FARGATE_SIZE_ROWS` deliberately stops at 4096
   because every task here is 256, 512 or 1024 CPU, and an incorrect row is worse
   than a missing one in both directions. A recommendation naming one is read by
   a human rather than silently accepted or silently rejected. The five rows that
   *are* there carry no read date, unlike the price observations in
   `docs/graviton.md`: what holds them honest is `task-size-invalid`, which
   checks every synthesised task size against them on every build.
3. **`size-invalid-for-fargate`** — a pair `RegisterTaskDefinition` would reject,
   like 512 CPU with 512 MiB.
4. **`below-floor`** — smaller than the entry's declared minimum. The floor
   exists because the recommendation is an average over 14 days.
5. **`peer-disagreement`** — the resources that must stay the same size did not
   all get a finding, or did not agree. **An empty peer list is a
   disagreement**, not a unanimous vote.

---

## 7. Out of scope, deliberately

**Lambda memory recommendations.** The sweep *reads* them and publishes
`LambdaFindingsRead` and `LambdaUnavailable`, and proposes nothing from them.
Compute Optimizer needs at least **50 invocations in 14 days** before it will
recommend a memory size; below that it returns `finding: Unavailable` with
`findingReasonCodes: [InsufficientData]`, and those functions do not appear in
the console at all. This repository's handlers are scheduled daily or monthly —
14 or 1 invocations per window — so the Lambda half is a coverage report rather
than a proposal stream. The coverage is published precisely so that "no Lambda
findings" is visibly one cause (the invocation count) rather than an absent
metric. Every function here is also below the 1792 MiB ceiling above which
Compute Optimizer returns `Inconclusive`, so there is exactly one cause and not
two.

**EC2 instances and Auto Scaling groups.** The only EC2 capacity here is the EKS
managed node groups, and the Auto Scaling group a managed node group creates is
not in `cdk.out` — so nothing in this gate could classify it or hold a claim
about it to a template. A node group's instance types are declared in
`bin/app.ts` and `docs/graviton.md` already governs that choice.

**RDS and ElastiCache.** A DB instance class change is a reboot or a Multi-AZ
failover, which is the event `docs/game-days.md` exists to measure. A size
proposal for the database belongs with the failover rehearsal that would apply
it, not in a cost sweep that runs daily and cannot tell whether anybody is
watching.

**EBS volumes and idle resources.** Nothing here attaches a managed EBS volume
outside the EKS node groups above, so the recommendations would be about
resources this repository does not create.

**The saving is AWS's number, not a measurement.** `EstimatedMonthlySaving` is
`savingsOpportunity.estimatedMonthlySavings` summed over the proposals, which is
Compute Optimizer's own estimate from the account's own usage. No stack in this
repository has ever run, so there is no bill to check it against — the same gap
`docs/graviton.md` leaves open for its benchmark half. The currency is checked
rather than assumed: a finding whose currency is not USD is counted into
`SavingUncountedCurrency` instead of added, because a sum across currencies is a
number in none of them that still renders as money on a dashboard.

---

## 8. Changing a posture

A posture is a claim about a template, so changing one is two edits and a gate
run:

1. Edit the entry in `lib/right-sizing.ts`. `reason` must name a failure and must
   be at least 90 characters; `validateRightSizingCatalogue` refuses an
   `uncovered` entry with no `uncoveredReason`, a `hold` with no `holdReason`, a
   `propose` with no floor, a floor that is not a size Fargate registers, and a
   `sizeMustMatch` that is not symmetric or whose peers declare different floors.
2. `npx cdk synth && npm run audit:right-sizing`. Moving an entry from
   `uncovered` to `propose` without removing the scaling policy that excluded it
   fails `covered-service-excluded`; claiming `dual-target-tracking` for a
   service that is not target-tracked on both metrics fails
   `uncovered-claim-unsupported`.
3. Regenerate the table in §2 if the catalogue changed, or `doc-table-drift`
   fails.

**An entry matches twice, on two different things.** `servicePathSuffix` is how
the gate finds the service in `cdk.out`; `serviceNamePattern` is how the sweeper
finds it at runtime, because a Compute Optimizer recommendation carries a service
ARN and nothing else. A pattern that matches nothing has no symptom at all — the
sweeper never sees the service, so it produces no proposal *and* counts no
coverage gap, and the posture quietly stops applying. That is why
`service-name-pattern-mismatch` holds every pattern to the `ServiceName` the
template actually declares, in both directions. It caught exactly this while this
page was being written: the catalogue said `blue-green` and the deployed names
are `staging-bg-service` and `production-bg-service`.

**Making a service eligible** is a different decision from changing its posture,
and it is the expensive one. Removing `scaleOnMemoryUtilization` from `EcsStack`
would make both application services visible to Compute Optimizer — and would
remove the memory scaling that currently absorbs a memory-bound burst. That is a
trade between a recommendation and a mechanism, not a free improvement, and it
belongs in its own pull request with `docs/autoscaling.md` open.

---

## 9. What the gate checks

`npm run audit:right-sizing`, after `cdk synth`, in the `cdk` job:

| Rule | What it catches | What it looks like without the gate |
| --- | --- | --- |
| `catalogue` | any offline finding | a bad entry discovered at deploy |
| `service-unclassified` | an ECS service no entry claims | invisible from both ends: no posture, and no coverage gap either |
| `service-ambiguous` | two entries claiming one service | a posture decided by iteration order |
| `service-count-drift` | a matched count that is not declared | a coverage gap reported that is not there, or one hidden |
| `service-name-pattern-mismatch` | an entry whose name pattern misses the deployed `ServiceName` | the sweeper never sees the service, so no proposal **and no gap** |
| `service-name-pattern-ambiguous` | two patterns claiming one name | a posture decided by a sort being stable |
| `uncovered-claim-unsupported` | an `uncovered` entry whose template carries no exclusion | a real finding arriving with `posture-uncovered` stamped on it |
| `covered-service-excluded` | a `propose`/`hold` entry whose template does carry one | every proposal structurally impossible, gap alarm red by construction |
| `task-size-invalid` | a synthesised CPU/memory pair Fargate rejects | a failed deploy at the end of a pipeline |
| `task-size-below-floor` | a service already smaller than its floor | every proposal rejected, including the one that would restore the minimum |
| `sweeper-missing` | nothing publishing to the namespace | every rule below unevaluated, and the gate green |
| `sweeper-can-write` | a write action on the sweeper's role | drift the next deploy reverts, as silently as it was made |
| `sweep-rule-missing` | nothing scheduling the sweep | every metric absent rather than zero |
| `sweep-rule-no-dlq` | a dropped invocation | a schedule that stopped and a sweep that found nothing, publishing the same thing |
| `stale-alarm-missing` | nothing alarming on `SweepSuccess` | the one absence nobody is watching |
| `stale-alarm-not-breaching` | that alarm tolerating missing data | an alarm that fires only in the case the error alarm already covers |
| `enrolment-alarm-missing` | nothing alarming on `Enrolled` | a never-enrolled account reading as optimised |
| `coverage-alarm-missing` | nothing alarming on `CoverageGap` | an unmeasured service reading as an optimised one |
| `doc-table-drift` | a hand-edited table | the column a reader uses to find out why their service never gets a finding |
| `audit-not-run-in-ci` | the gate not wired into a job | all of the above, enforcing nothing |

---

## 10. Known gaps

* **Nothing here has been deployed.** No automation in this repository has run
  against a real account, so the sweeper is checked for shape — a fake
  recommendation page through the real handler source — rather than against a
  real Compute Optimizer response. The exclusion conditions in §1 come from
  AWS's documentation, and the one that matters most is also the one that would
  be most visible if it changed: a finding for a service this catalogue calls
  `uncovered` publishes `UnexpectedFinding`.
* **No proposal has ever been applied.** The arithmetic that decides whether a
  recommendation survives is unit-tested against the failures it is meant to
  catch, and the `bin/app.ts` edit at the end of it has never been made from a
  real finding.
* **The 32-day lookback is not configured.** AWS can extend the ECS window from
  14 days to 32 at no extra cost, which would weaken the `below-floor` argument
  considerably for a service whose load is weekly. Setting it is a recommendation
  *preference*, which is an account-level write this stack has no permission to
  make — so it is a console action somebody has to take, and §1's 14 days is what
  the catalogue is currently reasoned against.
