# SLO burn-rate rollback

`SloBurnRateRollbackStack` rolls back a deployment when it is consuming the
error budget faster than the objective can afford — not when a fixed error-rate
threshold is crossed.

The distinction matters because a threshold alarm cannot tell a thirty-second
blip from a change that will exhaust the quarter's budget by lunchtime. Both put
the alarm in ALARM. A burn rate separates them, because it is not "how many
errors" but "how much of what we are allowed to spend, and how quickly".

## The arithmetic

An availability objective implies an **error budget**: the fraction of requests
allowed to fail.

```
error budget = 1 − SLO target
99.9%  →  0.001   (1 request in 1000)
99.5%  →  0.005   (1 request in 200)
```

The **burn rate** is the observed error ratio expressed as a multiple of that
budget:

```
burn rate = (failed requests / total requests) / error budget
```

A burn rate of 1x spends the entire budget in exactly one SLO window — 30 days,
by default. 14.4x spends 2% of it in an hour. 720x spends the whole thing in an
hour.

Worked example, three nines over 30 days:

| Failed / total in the window | Error ratio | Burn rate | Budget spent in 1h |
|------------------------------|-------------|-----------|--------------------|
| 5 / 100,000                  | 0.005%      | 0.05x     | 0.007%             |
| 100 / 100,000                | 0.1%        | 1x        | 0.14%              |
| 1,440 / 100,000              | 1.44%       | 14.4x     | 2%                 |
| 5,000 / 100,000              | 5%          | 50x       | 6.9%               |

The last column is `burn rate × window / SLO window`, which is what makes 14.4x
the conventional fast-burn threshold: an hour at that rate costs 2% of a 30-day
budget, and two of those a day would spend the month's budget in a fortnight.

## Why two windows

Each policy alarms only when a **long** window and a **short** window are both
over the threshold. Neither is sufficient alone:

- The **long window** decides significance. A five-minute spike that never
  recurs is not worth a rollback, and an hour-long window refuses to see it.
- The **short window** decides currency. An hour-long window stays above the
  threshold for the rest of that hour after the incident ends, because the
  errors are still inside it. On its own it would roll back a service that has
  already recovered.

The defaults follow the Google SRE workbook:

| Policy | Burn rate | Long window | Short window | Budget consumed | Action |
|--------|-----------|-------------|--------------|-----------------|--------|
| `fast` | 14.4x     | 1h          | 5m           | 2% in an hour   | Roll back |
| `slow` | 6x        | 6h          | 30m          | 5% in six hours | Notify only |

The slow policy deliberately does **not** roll back. It fires hours after the
change that caused it, by which point a rollback is as likely to be wrong as
right — it is a page, not an action.

## The traffic floor

`slo.minimumRequestsPerWindow` (default 60) is the number of requests a window
needs before its burn rate is believed. Below it the burn rate is reported as
zero, in the alarm expression and in the handler alike.

Without it, one failed request in a window of three reads as a 33% error ratio —
a 333x burn against three nines — and every quiet night rolls back production.
This is the setting most likely to need tuning to your request volume; set it
above the traffic your quietest five minutes sees.

## What the handler does before it rolls back

The composite alarm firing is the start of the decision, not the end. On each
invocation the handler:

1. **Re-reads the metrics.** The alarm knows a threshold was crossed and nothing
   else. The handler reads the short window, the long window and the full SLO
   window, so the notification carries real numbers and the decision and the
   report cannot disagree.
2. **Checks the burn is still current.** If the short window has fallen back to
   or below the threshold since the alarm fired, it aborts — the incident is
   over, and rolling back now would be a deployment during recovery. The
   comparison mirrors the alarm's `GreaterThanThreshold` exactly.
3. **Attributes the burn to a deployment.** A service is rolled back only if its
   current deployment started within `deploymentAttributionWindowMinutes`
   (default 120). When a dependency is down and nothing has shipped for a week,
   rolling back to the previous revision changes nothing and costs a deployment
   during an incident. Set the window to `0` to roll back regardless of age.
4. **Refuses to stack rollbacks.** A service whose PRIMARY deployment is
   `IN_PROGRESS` is skipped. That covers a deploy the ECS circuit breaker still
   owns and a rollback this handler issued on a previous alarm transition —
   without the check, the service walks backwards one revision per alarm
   re-fire.
5. **Rolls back.** Rolling-update services get `UpdateService` with revision
   N−1. CodeDeploy-controlled services get `StopDeployment` with auto-rollback,
   which shifts traffic back to Blue via the deployment group's own rollback
   configuration.
6. **Publishes the reasoning.** Burn rate over both windows, requests and
   failures behind each, budget consumed and remaining, and per-target detail:
   which revision each service came off and which it went to.

Skips are reported, not silent: `NO_RECENT_DEPLOYMENT`, `DEPLOYMENT_IN_PROGRESS`,
`ALREADY_AT_FIRST_REVISION`, `SERVICE_NOT_FOUND`, `DEPLOYMENT_AGE_UNKNOWN`.

## What counts as a failed request

`HTTPCode_Target_5XX_Count` plus `HTTPCode_ELB_5XX_Count`, over `RequestCount`,
all scoped to the load balancer and target group serving the SLO.

The second one is easy to leave out and expensive to leave out. ELB-generated
5xx — 502, 503, 504 — are the failures a deployment with a broken image or a
failing health check produces. Those requests never reach a target, so they
never appear in the target-scoped metric: an SLO that counted only target 5xx
would read as perfect while every request failed.

4xx is deliberately excluded. A client sending malformed requests is not the
service failing its objective.

## Configuration

```ts
new SloBurnRateRollbackStack(app, 'SloBurnRateRollbackStack-Production', {
  envName: 'production',
  loadBalancerFullName: ecsStack.alb.loadBalancerFullName,
  targetGroupFullName: ecsStack.targetGroup.targetGroupFullName,
  slo: { target: 0.999, windowDays: 30, minimumRequestsPerWindow: 60 },
  rollbackTargets: [
    { clusterName: ecsStack.cluster.clusterName, serviceName: ecsStack.service.serviceName },
  ],
  notificationEmails: ['oncall@example.com'],
});
```

For a blue/green service, pass the **stable** target group — it is the one
serving production between deployments — and give the target its CodeDeploy
application and deployment group so the rollback stops the shift rather than
editing the task definition underneath CodeDeploy.

To change the policies, pass `burnRatePolicies`. The stack rejects a short
window that is not shorter than its long window, a fractional window (CloudWatch
would round it and evaluate a different burn rate than the one written), a long
window over 24 hours, and an SLO target that is not a fraction strictly between
0 and 1 — `99.9` instead of `0.999` produces a negative budget, which silently
inverts every comparison.

## Operating it

- The composite alarm names are exported as
  `<env>-slo-burn-rate-composite-alarm-names`. Feed them into a CodeDeploy
  deployment group's alarm configuration and a burn-rate breach will also abort
  an in-flight blue/green shift.
- The `<env>-slo-burn-rate` dashboard graphs both windows of every policy with
  its threshold drawn in. Watch it for a week before letting the fast policy roll
  back unattended.
- This stack composes with `RollbackAutomationStack` rather than replacing it.
  Keep alarm-state rollback for hard failures — no healthy hosts, a health check
  flatlining — and let the burn rate govern the slower, subtler regressions that
  a fixed threshold either misses or over-reacts to.
- Nothing here has been exercised against a live ALB. The verification is synth,
  unit tests over the compiled handler, and static analysis.
