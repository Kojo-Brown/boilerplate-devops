# Service level objectives: the catalogue, the budget, and the three ways it reads healthy while it is not

This repository had burn-rate alarms before it had SLOs.

`SloBurnRateRollbackStack` has computed an error-budget burn rate since PR #28,
and it works. But the objective it burns against was a literal in `bin/app.ts`:

```ts
slo: { target: 0.999, windowDays: 30, minimumRequestsPerWindow: 60 },
```

That is enough to drive an actuator and not enough to be an objective. Nothing
recorded who owned the number, what it was measured on, what should happen when
the budget ran out, or whether the two stacks referencing it agreed. An SLO that
exists only as an argument to a Lambda cannot be reviewed in a pull request,
cannot be reported on at the end of a month, and cannot be the thing a release
decision is made against.

So the objectives now live in [`aws/cdk/lib/slo-definitions.ts`](../aws/cdk/lib/slo-definitions.ts)
as data, `SloStack` turns each one into alarms and a reported budget, and
`npm run audit:slo` checks the catalogue against the wiring on every pull
request.

---

## 1. The arithmetic, in one screen

An objective implies an **error budget**: the fraction of events allowed to be
bad.

```
error budget = 1 − objective
99.9%  →  0.001   (1 event in 1,000)
99.5%  →  0.005   (1 event in 200)
99%    →  0.01    (1 event in 100)
```

The **burn rate** is the observed bad-event ratio as a multiple of that budget:

```
burn rate = (bad events / valid events) / error budget
```

1x spends the whole budget in exactly one SLO window. 14.4x spends 2% of a
30-day budget in an hour. The **remaining budget** is what is left of it over the
whole window:

```
budget consumed (%) = (bad / valid over the window) / error budget × 100
budget remaining (%) = 100 − budget consumed, floored at 0
```

Two consequences do most of the work in this document. First, an error ratio
cannot exceed 1, so `burn rate ≤ 1 / error budget` — a burn-rate threshold above
that can never be crossed. Second, a ratio computed over a handful of events is
noise, so every window needs a floor, and the floor cannot be one number
(§4).

---

## 2. The catalogue

| SLO | SLI | Objective | Window | Status |
|-----|-----|-----------|--------|--------|
| `production-api-availability` | HTTP requests at the ALB that did not return 5xx | 99.9% | 30 days | active |
| `staging-api-availability` | the same, on staging | 99.5% | 30 days | active |
| `production-api-latency` | requests served within 300 ms | 99% | 30 days | proposed — see §5 |

Each entry declares its owner (a team, never a person — an SLO outlives anyone's
time on a rota), a runbook URL, the burn-rate policies in force, and the traffic
rate below which it is too quiet to measure.

`status` is load-bearing. An `active` entry must be wired into an `SloStack`;
the audit gate fails if it is not, because an objective nobody alarms on produces
no signal and no signal is indistinguishable from a signal that never fires. A
`proposed` entry must carry `blockedOn` and must *not* be wired, because alarms
over a metric nothing publishes sit in `INSUFFICIENT_DATA` from the day they
deploy, which is how a dashboard acquires the one amber tile everybody has
learned to ignore.

Staging runs a looser objective than production on purpose, and routes every
severity to the ticket topic (`downgradePagesToTickets`). It still evaluates the
same policies, so a change to them is exercised before it reaches the rota. A
boilerplate that pages on staging noise gets its alarms muted, and a muted alarm
is worse than no alarm.

---

## 3. Three signals, because each is blind to what the others see

```
SLI metrics (ALB, or any good/valid pair)
  ├─ metric math: bad / valid / errorBudget, floored on traffic
  │    → long-window alarm ┐
  │    → short-window alarm┴→ composite (AND) → SNS: page | ticket
  └─ EventBridge schedule (15m) → error-budget reporter Lambda
       ├─ GetMetricData over the whole 30-day window at a 1h period
       ├─ PutMetricData → SLO namespace
       └─ alarms: budget low → ticket, budget exhausted → page, no data → ticket
```

**Burn-rate alarms** answer *is this costing more reliability than the objective
affords, right now*. Two windows ANDed together: the long window decides
significance, so a five-minute blip never pages; the short window decides
currency, so a service that has recovered stops paging while its errors are still
inside the long window.

Three policies, at the rates the Google SRE workbook recommends:

| Policy | Burn rate | Long | Short | Budget spent in the long window | Severity |
|--------|-----------|------|-------|----------------------------------|----------|
| `fast` | 14.4x | 1h | 5m | 2% | page |
| `medium` | 6x | 6h | 30m | 5% | page |
| `slow` | 1x | 24h | 2h | 3.3% | ticket |

The workbook's third tier is 1x over **three days**. A CloudWatch alarm evaluates
at most a 24-hour period, so that tier is not expressible as an alarm and the
24-hour policy above is the closest thing that is.

**The error-budget reporter** answers *how much is left* — the drift the alarms
above are structurally unable to see. A month of small regressions, each an hour
long and none crossing 14.4x, spends the whole budget without one burn-rate alarm
firing. That number also cannot be an alarm on its own, for the same 24-hour
reason, so the Lambda reads the 30-day window with `GetMetricData` on a schedule
and republishes it as `ErrorBudgetRemainingPercent`, which *can* be alarmed on:

| Metric (namespace `SLO`) | Meaning |
|--------------------------|---------|
| `ErrorBudgetRemainingPercent` | what is left, clamped at 0 |
| `ErrorBudgetConsumedPercent` | what is gone, **not** clamped — overspend is visible here |
| `EventsObserved` | valid events in the window |
| `BadEvents` | bad events in the window |

Dimensioned by `Slo`, `Service` and `Environment`. The window burn rate is not
published: it is `ErrorBudgetConsumedPercent / 100` exactly, and a derivable
value is not worth a billed custom metric (§9).

**The no-data alarm** answers *is any of this still true*, and it is the only
alarm here that treats missing data as breaching. Every other signal degrades
quietly to green when the metric pipeline stops: a burn rate over zero requests
is zero, and a budget nothing has spent is a full one. A service nobody is
calling and a service nobody is measuring look identical from the outside. So the
reporter publishes `EventsObserved` unconditionally — including the `0` case,
where it publishes *no* budget metrics at all rather than a reassuring 100% — and
`<slo>-no-data` fires on either a zero or an absence.

There is also `<env>-slo-budget-reporter-errors`, on the function's own `Errors`
metric, because a reporter that throws on one objective and succeeds on the rest
leaves no gap the no-data alarms can see.

---

## 4. The traffic floor is a rate, not a count

Every window needs a minimum event count before its ratio is believed. One
failure in a window of three is a 33% error ratio, which against three nines is a
333x burn, and every quiet night would page.

The floor has to be large enough that **one** bad event does not by itself cross
the threshold:

```
floor ≥ 1 / (burn rate × error budget)
```

For 99.9% and 14.4x that is 70 events. For the 1x policy it is 1,000 — the bound
grows as the burn rate shrinks, and it does not depend on the window at all,
while the traffic in a window obviously does. A single
`minimumRequestsPerWindow`, applied to a 5-minute window and a 24-hour window
288 times longer, is therefore wrong for one of them by construction: sized for
the day it never fires in five minutes, sized for five minutes it pages on one
failed request per day.

So the catalogue declares a **rate** — `minimumEventsPerMinute` — and each
window's floor is that rate times the window:

For `production-api-availability` — 99.9%, 15 events/min:

| Window | Length | Floor | Single-event minimum | |
|---|---|---|---|---|
| `fast` short | 5m | 75 | 70 | ✓ |
| `fast` long | 60m | 900 | 70 | ✓ |
| `medium` short | 30m | 450 | 167 | ✓ |
| `slow` short | 120m | 1,800 | 1,000 | ✓ |

`validateSloDefinition` reports the failing case as
`traffic-floor-single-event`, and names the rate that would fix it. It is a real
finding against what this repository had before: `minimumRequestsPerWindow: 60`
under a 99.9% objective with a 14.4x policy needs 70, so at exactly the traffic
floor a single failed request crossed the threshold in both windows — and the
consequence there was not a page but an automated rollback.

Below its floor a window reports a burn rate of **zero**, not no data. "Too quiet
to tell" and "the metrics stopped" need different responses and only the second
is an incident; §3's no-data alarm is what distinguishes them.

---

## 5. Wiring a latency SLI

`production-api-latency` is `proposed` because **ALB cannot measure it**, and the
shape that looks like it can is the trap.

An SLI is a ratio of good events to valid events, so a latency SLI needs a *count*
of requests faster than the threshold. ALB publishes `TargetResponseTime`, which
is a distribution, not a count of anything. You can take `p99` of it, and
CloudWatch will not aggregate that percentile over a window — the p99 of twelve
five-minute p99s is not the p99 of the hour — so there is no ratio to divide by an
error budget.

An alarm on `p99 > 0.3` is a useful latency alarm. It is not a latency SLO, and
it reads in a diff exactly like one: an objective, a threshold, a period.
`SloStack` therefore rejects an `alb` source on a latency SLI outright rather than
approximating it.

What it needs is two counts from the application. With the OTel collector already
in this repository (`docs/otel-collector.md`), the cheapest route is an EMF
declaration publishing a good count alongside the total:

```jsonc
// Emitted by the application, or by a view in the collector's awsemf exporter.
{
  "Namespace": "AppSlo",
  "Dimensions": [["Service", "Environment"]],
  "Metrics": [
    { "Name": "Requests",     "Unit": "Count" },  // every valid request
    { "Name": "RequestsFast", "Unit": "Count" }   // those completing ≤ 300ms
  ]
}
```

Then flip the entry to `active` and wire it:

```ts
{
  sloId: 'production-api-latency',
  source: {
    kind: 'ratio',
    namespace: 'AppSlo',
    totalMetricName: 'Requests',
    goodMetricName: 'RequestsFast',
    dimensionsMap: { Service: 'api', Environment: 'production' },
  },
}
```

Two things about that source. The threshold lives in the **emitter**, not in the
catalogue: `thresholdSeconds` in the definition documents what `RequestsFast`
means and cannot enforce it, so changing one without the other silently
redefines the objective. And bad events are derived as `total − good` clamped at
zero, in both the metric math and the reporter, because the two series are
published independently and can arrive a datapoint apart — unclamped, that is a
negative bad count and a budget reading above 100%.

A `ratio` source must also carry dimensions. An undimensioned metric in a shared
namespace aggregates every service that publishes it, so the SLI would quietly
measure the whole account; `SloStack` refuses an empty `dimensionsMap`.

---

## 6. Why the rollback stack uses a different floor

`SloBurnRateRollbackStack` and `SloStack` compute a burn rate from the same
objective — `bin/app.ts` hands both the same catalogue entry — and use different
traffic floors on purpose.

`SloStack` uses the SLI's declared floor, per window, as in §4. An alert wakes a
human, and the failure mode of a floor that is slightly too low is a phone call
that turns out to be noise.

`SloBurnRateRollbackStack` takes one count for both of its windows, so
`bin/app.ts` hands it `significanceFloorEvents()`: the largest per-policy floor,
which is the conservative one. That stack mutates production. A rollback that
does not happen because traffic was thin is a better failure than one that pulls a
healthy revision out of service because a single request 502'd at 04:00.

The two stacks' alarms therefore overlap deliberately — the rollback stack's
alarms are an actuator (and are also usable as CodeDeploy deployment alarms, to
abort a blue/green shift mid-flight), and `SloStack`'s are the alerting and
reporting surface.

---

## 7. Responding to a burn-rate alert

The alert names the SLO, the policy, the burn rate and this document. In order:

1. **Read the budget, not just the alarm.** Open the `<env>-slo` dashboard.
   `ErrorBudgetRemainingPercent` for that SLO is the number that decides how much
   room there is to investigate rather than mitigate. A `fast` page at 80% budget
   remaining is a different situation from the same page at 5%.

2. **Check the traffic on the same graph.** The consumed-budget widget carries
   `EventsObserved` and `BadEvents` on its right axis for exactly this. A burn
   rate computed just above the floor is thin evidence; one computed on a normal
   hour of traffic is not.

3. **Attribute it.** Did anything deploy inside the long window? The
   `<env>-slo-burn-rate-rollback` handler applies a 120-minute deployment
   attribution window for the same reason; `docs/dora-metrics.md` has the
   deployment record.

4. **Mitigate before diagnosing** if the budget is going. Roll back, disable the
   feature flag (`docs/feature-flags.md`), or shed the load. The budget is the
   thing being spent while the investigation runs.

5. **A `slow` ticket is not an outage.** It fires hours after whatever caused it,
   and the useful response is an investigation during working hours.

6. **`<slo>-no-data` is never "the service is quiet".** Check that the ALB is
   receiving traffic, that the reporter ran (`/aws/lambda/<env>-slo-budget-reporter`
   logs an `slo.budget.reported` line on every invocation), and that nothing has
   renamed a metric or a dimension. Until it clears, every other SLO alarm on
   that objective is reading a stale datapoint or none.

7. **`<slo>-budget-exhausted` is a release decision, not an alarm to
   acknowledge.** The service is below the objective it promised over the window.
   What that implies — a freeze, a reliability sprint — is a policy this
   repository deliberately does not encode; it pages so that a person makes it.

---

## 8. What the reporter actually does

`<env>-slo-budget-reporter`, every 15 minutes, per objective:

- `GetMetricData` over the whole window at a **one-hour period** (720 datapoints
  for 30 days), summing the values. One call per objective, not one for all of
  them, so a renamed metric fails that budget rather than every budget.
- Follows `NextToken`. Nothing here is near the 100,800-value response limit, but
  a query that starts paginating returns a truncated window silently, and a
  truncated window reports a budget less spent than it is.
- Publishes the four metrics in §3 with `PutMetricData`, or only
  `EventsObserved`/`BadEvents` when the window holds no valid events.
- Logs one structured `slo.budget.reported` line, then throws if any objective
  failed — so the invocation is recorded as an error and the errors alarm sees it,
  after every objective has been attempted.

The budget is a slow number; 15 minutes is not for its sake. "How much is left"
is asked during an incident, in the minutes before someone decides whether to
keep rolling out, and the answer quoted in that decision should be current.

The reporter's IAM is two statements, both on `*` because metrics are not
resources and neither API accepts an ARN. `PutMetricData` is narrowed by a
`cloudwatch:namespace` condition to `SLO`: without it the role could overwrite any
metric in the account, including the `AWS/*` series other alarms read.

---

## 9. Cost

Four custom metrics per objective. At two active objectives that is 8 metrics
(~$2.40/month at $0.30 each), plus 10 metric alarms and 3 composite alarms per
environment, plus 2,880 `PutMetricData` and `GetMetricData` calls a day per
objective.

This is why the window burn rate is not a fifth metric and why `metric_declarations`
in the collector's EMF exporter matters (`docs/otel-collector.md`): a custom
metric per dimension combination is the line item that surprises people, and the
default in most emitters is to publish everything.

---

## 10. The failures, and what each one looks like

| Failure | What you see | What catches it |
|---|---|---|
| Burn-rate threshold above `1 / error budget` | an alarm that stays green through a total outage | `policy-unreachable` |
| Traffic floor below `1 / (burn rate × budget)` | a page — or a rollback — on one failed request, only at the traffic floor | `traffic-floor-single-event` |
| One floor for a 5m and a 24h window | correct for one window, silently wrong for the other | the floor is a rate; §4 |
| Latency SLO built on `TargetResponseTime` | a plausible alarm that is not an SLI and produces no burn rate | `SloStack` rejects an `alb` source on a latency SLI |
| Objective defined and never wired | a dashboard read at review time that was never created | `slo-not-wired` |
| Objective wired before its SLI exists | a permanent `INSUFFICIENT_DATA` tile | `proposed-slo-wired` |
| Objective stated twice | one copy tightened, the other still driving rollbacks | `objective-literal` |
| SLI pipeline stops | every burn rate is zero and the budget is untouched | `<slo>-no-data`, the one alarm that treats missing data as breaching |
| Good count published ahead of the total | negative bad events, budget above 100% | clamped in both the metric math and the reporter (§5) |
| Reporter fails on one objective only | three budgets updating, one frozen, no gap in any no-data alarm | `<env>-slo-budget-reporter-errors` |
| `proposed` objective quietly malformed | promoted to `active` months later as "already reviewed" | the audit validates proposed entries too |

---

## 11. Known gaps

- **Nothing has been deployed.** The alarms, the reporter and the dashboard are
  asserted against synthesised CloudFormation and the handler is run against
  recording stubs. No burn rate in here has been computed from a real ALB, and no
  budget has been read out of a real account.
- **No latency or correctness SLO is active.** §5 has the contract; the
  application has to emit it. Availability at the load balancer is the only SLI
  this repository can produce on its own, and it counts a slow success as a
  success.
- **Multi-window, not multi-burn-rate-per-window.** The workbook's six-window
  variant halves the short window of each tier again; three tiers with nested
  windows is what CloudWatch expresses without a second composite layer.
- **The budget is a rolling window, not a calendar one.** A rolling 30 days is
  what CloudWatch can answer and is the right thing for alerting; a report to
  anyone outside engineering usually wants the month, which this does not
  produce.
- **Nothing consumes the budget metric automatically.** `ErrorBudgetRemainingPercent`
  is published so that a release gate *could* read it, and no pipeline in this
  repository does. That, and an alert whose first step is executable rather than a
  link to §7, are the next two items in SPEC.md's observability phase.
