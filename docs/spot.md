# Fargate Spot: which workloads, and what the two minutes buy

Spot is the only cost lever in this repository that changes what happens during
an incident. A smaller instance class, a shorter log retention, a move to
Graviton — each of those changes a bill and nothing else. This one changes the
probability that a running task disappears, so the interesting half of a "Spot
strategy" is not the services that move. It is the ones that do not, and why.

Nine of the eleven ECS services here stay on on-demand capacity. The reasons are
in `SPOT_WORKLOADS` in `aws/cdk/lib/spot-capacity.ts`, one per entry, and they
are the content of this document. `npm run audit:spot` holds the synthesised
templates to them.

---

## 1. The two postures

```
spot-only        every task on FARGATE_SPOT, no on-demand base.
                 Only where "it is not running" reaches somebody without
                 an alarm.

spot-with-base   an on-demand base — a task count, placed before any
                 weight applies — and FARGATE_SPOT for everything above it.

on-demand-only   no Spot at all. The entry records what would go wrong.
```

**The base is the whole safety story, and it is a count rather than a share for a
reason.** A capacity provider strategy that is 100% `FARGATE_SPOT` does not fail
loudly when there is no Spot capacity to be had: `RunTask` does not place, the
service event log says so, the desired count stays unmet, and nothing goes red.
The alarms that might have caught it are utilisation alarms on tasks that do not
exist, and CloudWatch does not breach a threshold on a metric with no data
points. It is the same blind spot [docs/synthetic-canaries.md](./synthetic-canaries.md)
is about: the system does not go red, it goes quiet.

A `base` of 1 is placed on `FARGATE` before any weight is considered, so a
Spot-wide shortage in these availability zones leaves the service degraded rather
than absent — and `<env>-spot-capacity-starved` (§4) is what makes the degraded
state visible.

`validateSpotCatalogue` refuses a `spot-with-base` entry whose base is zero. It
is the same configuration as `spot-only` wearing the safer name, and the name is
what gets read in review.

---

## 2. The posture of every service

| Workload | Services | Posture | On-demand base | Criticality | Drain budget |
| --- | --- | --- | --- | --- | --- |
| `preview-pr-service` | 1 | spot-only | 0 | ephemeral | 35s (5s + 30s), 85s spare |
| `staging-application` | 1 | spot-with-base | 1 | staging-grade | 90s (30s + 60s), 30s spare |
| `production-application` | 1 | on-demand-only | — | user-facing-slo | — |
| `blue-green-service` | 2 | on-demand-only | — | release-mechanism | — |
| `canary-deploy-services` | 2 | on-demand-only | — | release-mechanism | — |
| `canary-deploy-canary-services` | 2 | on-demand-only | — | release-mechanism | — |
| `otel-sampler-service` | 2 | on-demand-only | — | instance-affinity | — |

The table is generated from the catalogue; `doc-table-drift` fails the build when
it stops matching.

### The two that moved

**Previews** are where Spot pays best and costs least: dozens of short-lived
tasks a week, each one existing for a single pull request and destroyed with it.
A reclaimed preview task is replaced when capacity returns, and the only person
who notices is already looking at the pull request it belongs to. That is what
makes a base unnecessary here and necessary everywhere else — the absence reaches
somebody without an alarm.

**Staging's burst.** Staging carries no objective, and a reclaim there is a
rehearsal of exactly what production is supposed to survive, which is worth more
than the capacity it costs. It keeps a base of one: an environment every release
is validated against must not disappear in a Spot shortage, and if it did, the
failure would be silent for the reason §1 gives.

### The nine that did not

**`production-application` — an error budget cannot tell why a request failed.**
The availability and latency objectives in `lib/slo-definitions.ts` are measured
on this service. A 70% discount on the compute behind a 99.9% objective buys
capacity that can be withdrawn during the incident it helped cause.

**`blue-green-service` and the two canary services — a reclaim reads as a bad
release.** These are not workloads, they are how a release happens. CodeDeploy
shifts traffic between two task sets and decides on the result; the canary
analyser compares the canary target group's error rate and latency against the
stable one's and promotes or rolls back on the difference. A reclaim on either
side moves one of those numbers for a reason that has nothing to do with the
revision under test, and neither mechanism can tell the two apart. The failure is
not an outage — it is a *wrong verdict*, which reads exactly like a correct one.
The canary half is the more exposed of the two because it runs at a fraction of
the stable service's task count, so one reclaimed task is a larger share of the
sample.

Staging's copies are included deliberately. A release mechanism rehearsed on
different capacity from the one production uses has not been rehearsed — the same
argument `EcsStack` makes for setting `enableFaultInjection` in every environment
rather than in staging alone.

**`otel-sampler-service` — the hash ring.** The tail-sampling tier requires every
span of a trace to reach the same instance, and the agents resolve that through
Cloud Map. Losing an instance re-points roughly 1/N of trace IDs, and for one
resolver interval the agents disagree about which instance owns which trace: the
traces in flight across that window are split, and both halves are decided on
fragments. This is already the reason that tier has no scaling policy — see
[docs/otel-collector.md](./otel-collector.md). Spot would reintroduce it on AWS's
schedule instead of ours, and it fails silently: every task stays healthy, and a
trace is missing its database span.

---

## 3. The two minutes

When Fargate Spot reclaims a task, ECS sends a two-minute warning: a task state
change event with `stopCode: SpotInterruption`, and a `SIGTERM` to the task's
containers. Failure to shut down inside the window ends in `SIGKILL`.

Two things about that window are easy to get wrong, and neither fails loudly.

**`stopTimeout` defaults to 30 seconds.** Not 120. A task definition that says
nothing gets a quarter of what is available and loses whatever it was doing at
second 31 — and the only trace is a task that went away, which is what a reclaim
looks like anyway. AWS's own guidance is 120 seconds or less; the default is
nobody's decision.

**Deregistration is spent inside the same two minutes.** On a termination notice
ECS deregisters the task from its target group *before* it sends `SIGTERM`, so
the target group's `deregistration_delay.timeout_seconds` and the container's
`stopTimeout` run one after the other out of one budget:

```
  0s ────────────────────── 120s   the warning
  │                           │
  ├── deregistration ──┐      │    ECS removes the target and waits
  │                    ├─ grace ─┐ then SIGTERM, then stopTimeout
  │                               └─ SIGKILL, wherever this lands
```

The ELB default is **300 seconds**, which exceeds the whole window on its own:
nothing is left for the process, and the requests still in flight when the
capacity goes are cut rather than drained. So both numbers are declared together
in the catalogue's `drainBudget`, their sum is checked against the warning at
synth time, and `npm run audit:spot` checks the two properties the templates
actually carry — because either can be edited without touching the catalogue.

| Service | Deregistration | Grace | Budget | Spare |
| --- | --- | --- | --- | --- |
| `staging-service` | 30s | 60s | 90s | 30s |
| `preview-pr-<n>` | 5s | 30s | 35s | 85s |

The spare is deliberate. AWS does not bound the gap between the event being
emitted and `SIGTERM` arriving, so a budget that exactly equalled the warning
would be betting on a number nobody published.

**The deployment circuit breaker.** `EcsStack` runs with
`circuitBreaker: { rollback: true }`, which counts tasks that fail to reach a
steady state during a deployment — and a reclaim mid-deployment is one of those.
What keeps a good release from being rolled back because AWS wanted the capacity
back is the on-demand base: it is placed before any weight applies, so the
breaker's minimum healthy count can be met without Spot. That is the second
reason `validateSpotCatalogue` refuses a base of zero.

---

## 4. The two silent failures, and the alarms over them

`SpotInterruptionStack-Staging` is one stack rather than one per environment: the
only Spot capacity in this account is staging's burst and the previews, previews
run in the staging VPC, and production is on-demand by posture — a production
instance would carry alarms on metrics that are structurally zero.

Its alarms go to `staging-cloudwatch-alarms`, the topic `RunbookStack-Staging`
already enriches, so each one arrives with [its runbook](./runbooks.md#12-fargate-spot-took-the-capacity-or-the-drain-did-not-fit)
and a started first step. A topic of its own would be one `npm run audit:runbooks`
fails for, correctly.

### `staging-spot-capacity-starved` — the page

Metric math over Container Insights:

```
FILL(running, 0) - FILL(desired, REPEAT)   ≤ -1 for 15 consecutive minutes
treatMissingData: breaching
```

Three properties, each load-bearing:

* **`FILL()` on both terms.** Metric math yields no datapoint wherever *any*
  input is missing, so a service that has stopped publishing `RunningTaskCount`
  would otherwise produce an expression with no data rather than a gap of the
  full desired count. `REPEAT` on the desired side because the last count
  anybody asked for is still the count they asked for; `0` on the running side
  because a service not reporting running tasks is the case being looked for.
* **`breaching` on missing data.** The symptom is an absence. An alarm that
  ignored absence would be green through the outage it was written for.
* **Fifteen minutes.** A deployment and a scale-out both make running briefly
  smaller than desired. Nothing here takes fifteen minutes to converge, and a
  Spot shortage does not end on its own.

A consequence worth stating rather than softening: **in an environment that has
never published these metrics, this alarm fires immediately.** A service whose
task counts have never been published is indistinguishable from one that has
stopped publishing them, and only the first can be fixed by whoever is reading
the page. It is the same bargain `*-rehearsal-overdue-*` makes in
`FailoverGameDayStack`.

### `staging-spot-drain-overrun` — the one that costs data

A task killed at the end of its grace period and a task that drained cleanly both
end as a task that is gone. The difference is `stoppedAt - stoppingAt` against the
declared budget, which the ECS event carries and nothing else here reads. The
recorder reads it, publishes `DrainOverruns`, and the ticket on it is the only
signal in this repository that would notice a deregistration delay somebody
raised in the console.

### The rest

| Alarm | Severity | What it means |
| --- | --- | --- |
| `staging-spot-interruptions-high` | ticket | More reclaims an hour than the threshold. Not an outage — interruptions are the deal — but at this rate the tasks are spending their lives starting up, and the answer is a capacity decision made in daylight. |
| `staging-spot-recorder-errors` | ticket | The recorder is failing, so everything above reads zero — and zero is what a healthy week looks like. [§9](./runbooks.md#9-a-platform-component-has-stopped-reporting). |
| `staging-spot-events-undelivered` | ticket | EventBridge gave up retrying and the reclaims are in the dead-letter queue, where they keep for 14 days and can be replayed. |

### What the recorder publishes

In `Boilerplate/Spot`, every metric twice: once dimensioned by `Environment`,
once by `Environment`, `ClusterName` and `ServiceName`. CloudWatch does not
aggregate across dimension sets — a metric published only with all three cannot
be read back as "interruptions in staging" — so the alarms read the first set and
anybody diagnosing reads the second.

| Metric | When |
| --- | --- |
| `Interruptions` | On the warning, which is when the two minutes start and the only moment a human could act. |
| `DrainSeconds` | On the stop, from `stoppingAt` to `stoppedAt`. |
| `DrainOverruns` | `1` when that exceeded the declared budget, `0` when it did not. |
| `DrainUnmeasured` | When `stoppingAt` is absent, so the shutdown cannot be measured at all. Deliberately not alarmed — see §7. |

The handler re-checks `stopCode` even though the rule already filters on it. A
rule is a thing somebody can widen in a console at three in the morning while
debugging, and a handler that trusted the pattern would start counting
deployments as interruptions.

---

## 5. What this actually saves today

**Nothing, on staging, at its current size — and that is the honest shape of a
base-plus-weight strategy rather than a defect.** `bin/app.ts` runs staging at
`desiredCount: 1`, and the on-demand base is 1, so the one task it wants is the
one task the base places on on-demand capacity. What is on Spot is staging's
*burst*: the CPU and memory scaling policies in `EcsStack` go to four tasks, and
tasks two through four are placed by weight.

`maximumSavingPercent` is the arithmetic, and it is a **bound** rather than an
estimate:

| Desired count | Tasks on Spot | Upper bound on the saving |
| --- | --- | --- |
| 1 | 0 | 0% |
| 2 | 1 | 35% |
| 3 | 2 | 46.7% |
| 4 | 3 | 52.5% |

A preview, with no base, is bounded at 70%.

The 70% is AWS's advertised Fargate Spot discount and is marked
`measured: false` in `FARGATE_SPOT_LIST_DISCOUNT`, for the same reason the
Graviton guide marks its benchmark claims unmeasured: it is a list-price claim,
the Spot price is set per availability zone and moves, and no stack in this
repository has ever run, so there is no bill to read it off. The on-demand rates
that *were* read out of the price list, with their SKUs and publication dates,
are in `ARCHITECTURE_PRICES` — see [docs/graviton.md](./graviton.md).

---

## 6. Changing a posture

A posture is one argument in `bin/app.ts`:

```ts
new EcsStack(app, 'EcsStack-Staging', {
  // ...
  capacity: spotWorkloadById('staging-application'),
});
```

Omitting `capacity` is on-demand with no capacity provider associated on the
cluster — which is what `EcsStack-Production` does, and it is the default because
a service that gains reclaimable capacity by being forgotten is the failure this
whole item exists to prevent.

To move a service **onto** Spot:

1. Change its entry in `SPOT_WORKLOADS`: the posture, the criticality, the
   `reason` (a sentence naming what happens when a task is reclaimed, which the
   validator holds to a length floor), the base, and the `drainBudget`.
2. Pass the entry as `capacity` where the stack is instantiated. The stack
   derives three things from it — the strategy, the container's `stopTimeout`,
   and the target group's deregistration delay — because the three numbers are
   only correct together.
3. Add the cluster's ARN to `monitoredClusterArns` on `SpotInterruptionStack`, or
   the reclaims go unrecorded and the metrics stay at zero.
4. `npx cdk synth && npm run audit:spot`.

To move one **off** Spot, drop the `capacity` argument and set the entry to
`on-demand-only` with the reason. Doing it in the console instead is reverted by
the next deploy with nothing to show for it, which is what the gate is for.

The validator will refuse some of this on purpose. A `user-facing-slo`,
`release-mechanism` or `instance-affinity` criticality with a Spot posture is a
finding rather than a judgement call: those three fail by producing a wrong
answer — a spent error budget, a rolled-back release, a trace decided on a
fragment — rather than by going down, and none of those failures is visible as
an interruption. Changing the criticality to get past it is a change somebody
has to make in a diff, next to the reason it contradicts.

---

## 7. Out of scope, deliberately

**EC2 Spot, including the EKS node groups.** `EksStack.addManagedNodeGroup`
already accepts `capacityType: SPOT`, and `bin/app.ts` uses it nowhere. Putting
it to work is a separate item and a larger one: EC2 Spot interruption is an
instance-level event, the drain is a Kubernetes eviction rather than a `SIGTERM`
to one container, and doing it properly needs a termination handler running on
the cluster plus capacity rebalancing across enough instance types to make the
pool deep. None of that shares a mechanism with what is here, so the catalogue
covers `AWS::ECS::Service` resources only and the gate says so.

**One-shot tasks.** `DbMigrationStack` registers a task definition and nothing
runs it until a workflow calls `RunTask`, which chooses the capacity provider at
call time — so there is no strategy in the template for a rule to read. The
posture is still obvious and worth writing down: a migration interrupted between
two statements leaves a half-applied schema, and 70% off a task that runs for
ninety seconds a week is not worth that. Nothing in this repository passes
`FARGATE_SPOT` to `RunTask`, and nothing should.

**Alarming `DrainUnmeasured`.** An absent `stoppingAt` means the task went from
`RUNNING` to `STOPPED` with no stopping phase recorded, which is rare and is not
by itself a loss. It is published so that a rise in it cannot be read off
`DrainOverruns` staying at zero, and it belongs on a dashboard rather than on a
rota's phone.

**Measuring the discount.** `FARGATE_SPOT_LIST_DISCOUNT` is a published figure,
not an observation (§5). Replacing it with a measured one means a deployed
account and a Cost Explorer query, which is the same gap
[docs/graviton.md](./graviton.md) leaves open for its benchmark half.

---

## 8. What the gate checks

`npm run audit:spot` reads `cdk.out`, this document and `.github/workflows/ci.yml`.
Twenty rules; the ones worth knowing by name:

| Rule | The failure it prevents |
| --- | --- |
| `service-unclassified` | A service no entry claims, which makes every other rule vacuous. This is the normal state of an inventory after somebody adds a stack. |
| `posture-mismatch` | A deployed strategy that is not the catalogue's — in both directions, because a posture that reverted to on-demand is more expensive and perfectly healthy. |
| `capacity-provider-unassociated` | A Spot strategy on a cluster that has not associated `FARGATE_SPOT`. Rejected at `CreateService`, after the template has passed every other gate here. Resolved through the CloudFormation export, because the preview cluster and the preview service are in different stacks. |
| `deregistration-delay-unset` | A target group behind a Spot service with no delay set, so ELB uses 300 seconds and the process is killed before it is asked to stop. |
| `stop-timeout-unset` | A Spot container on ECS's 30-second default, where "unexamined" and "chosen" produce the same template. |
| `drain-budget-exceeds-warning` | The two deployed numbers not fitting in 120 seconds. |
| `interruption-rule-stop-code` | A task-state rule with no `stopCode` filter, which counts deployments, scale-ins and every `UserInitiated` stop as interruptions. |
| `starvation-alarm-not-breaching` | The one alarm whose symptom is an absence, configured to ignore absences. |
| `cluster-unresolvable` | A cluster reference the gate could not follow — reported rather than skipped, because an unevaluated rule and a passing one look identical in a log. |

Run it after `npx cdk synth`; it reads what synth wrote, because that is where a
capacity provider strategy is decided.
