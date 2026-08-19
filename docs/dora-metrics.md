# DORA four keys

Deployment frequency, lead time for changes, change failure rate, and failed
deployment recovery time — how this repository collects them, and the four ways
a DORA dashboard is usually wrong.

Implementation: `aws/cdk/lib/dora-metrics-stack.ts`,
`workflow-templates/emit-dora-deployment.yml`.

---

## Why this is not just four CloudWatch queries

Each of the four keys is a ratio or a duration over two events. The arithmetic
is trivial, and that is the problem: every wrong pairing still produces a number
in range, on the right axis, moving in a believable direction. Nothing about a
DORA dashboard tells you it is measuring the wrong thing, so the failures below
survive for years and get quoted in board decks.

The four that matter:

| Mistake | What it produces | Guarded by |
| --- | --- | --- |
| Lead time from the merge commit | Every change looks like it shipped in minutes | `Source` dimension; PR commit lookup |
| Change failure rate over the trailing window | Rate improves the instant you deploy | Ripeness exclusion |
| All incidents counted as change failures | Rate rises when the deploy cadence falls | Attribution window |
| No lead time published when GitHub is down | A gap that reads as "nothing happened" | `LeadTimeUnmeasurable` + alarm |

---

## 1. Lead time is measured from the first commit, not the merge

Lead time for changes is the time from code being **written** to it running in
production.

The obvious implementation reads the author date of the commit that was
deployed. Under a squash-merge policy — which this repository's own ruleset
requires (`.github/rulesets/trunk-based-main.json`) — that commit did not exist
until the merge button was pressed. Its author date *is* the merge. So every
lead time comes out as the duration of the deploy pipeline: single-digit
minutes, elite by any threshold, no matter how long the change actually sat in
review.

The branch's real history does not survive the squash onto `main`, so it cannot
be recovered from git afterwards. It has to come from the pull request:

```
GET /repos/{owner}/{repo}/pulls/{number}/commits?per_page=100
```

GitHub returns these oldest-first, so `commits[0].commit.author.date` is the
answer and there is no page to follow.

**When the pull request number is missing**, the recorder falls back to the
deployed commit and publishes the datapoint under `Source=headCommit` instead of
`Source=pullRequest`. The dashboard graphs the two as separate series, coloured
differently. If the orange *deployed commit only* line is the only one on your
graph, your lead time is a deploy duration.

`emit-dora-deployment.yml` resolves the number from three places, in order: the
`pull-request-number` input, `github.event.pull_request.number`, and the `(#123)`
suffix GitHub puts on squash-merge subject lines. It logs a workflow warning
when all three come up empty.

### Author dates are not perfect

`git rebase` rewrites committer dates but preserves author dates, which is why
this uses the author date. A `--reset-author` rebase, or a force-push that
recreates the branch, will still understate lead time. There is no better signal
available from the git object graph; if the understatement matters to you, take
the first-commit date from your issue tracker instead.

---

## 2. Change failure rate has a trailing edge that lies

The natural implementation is *failures in the window / deployments in the
window*. It is wrong at the most recent end, and wrong in the flattering
direction.

A deployment from four minutes ago is already in the denominator. The incident
it is about to cause has not happened yet. So the rate always improves the
instant a deploy lands and then silently degrades over the next hour — and the
moment you most want the number, right after shipping, is the moment it is least
true.

The aggregator excludes deployments younger than `attributionWindowMinutes`
(default 60) from **both** the numerator and the denominator, and publishes the
excluded count as `UnripeDeployments`. The dashboard shows it in orange beside
the rate so the sample the rate was computed over is visible.

**When nothing in the window is ripe, no rate is published at all.** Zero over
zero is not zero percent — it is undefined, and publishing it as `0` is the most
flattering possible reading of no information. A gap in the line is the honest
rendering; `RipeDeployments` next to it says why.

---

## 3. Not every incident is a change failure

A certificate that expires at 04:00 on a Sunday is an incident. It is not a
failed deployment.

Counting all incidents against deployments produces a change failure rate that
**rises when the deploy cadence falls** — deploy less often, same number of
incidents, worse score. That is exactly backwards from what DORA is measuring,
and it is the single most common implementation error.

Each incident is attributed to the last **successful** deployment at or before
it started, and only if that deployment was inside the attribution window.
Everything else is published as `Incidents` with `Attribution=unattributed`,
counted on the coverage widget, and deliberately absent from the rate.

Failed deployments are skipped when looking backwards for the cause: a
deployment that never reached production did not change the running code, so
the incident belongs to the release before it.

The attribution flag lives on the **deployment record**, not on the incident. A
bad deploy that trips three alarms is one change failure, because change failure
rate asks what fraction of deployments failed — not how many alarms rang.

---

## 4. Recovery time, and flapping alarms

`RecoveryTimeSeconds` runs from the alarm entering `ALARM` to it returning to
`OK`. Two things make that harder than it sounds.

**Flapping.** An alarm that oscillates six times in five minutes would otherwise
report six incidents, each recovering in about a minute. That pushes change
failure rate up and recovery time down simultaneously — two keys wrong in
opposite directions from one noisy alarm. An alarm returning to `ALARM` within
`flapWindowSeconds` (default 300) of clearing **continues the incident it just
closed** rather than opening a new one, and the eventual recovery time covers
the whole episode from its original start.

**Overlapping alarms.** A service usually has several. The recorder closes the
incident raised by the *same alarm*, not whichever incident happens to be
newest — otherwise a 5xx alarm's recovery would close a latency alarm's incident
and leave the 5xx one open forever.

The merge is retroactive, and it leaves one artefact. The close that is about to
be undone has already published a `RecoveryTimeSeconds` datapoint, and CloudWatch
datapoints cannot be retracted — so a flapping episode leaves one short reading
behind alongside the correct full-episode one, pulling p50 recovery down
slightly. It is bounded and disclosed rather than fixed: the alternative is
withholding every recovery time for `flapWindowSeconds` on the chance that it
flaps, which delays the honest majority to correct the rare exception. Incident
counts and change failure rate are unaffected — those are keyed on the incident
record, which is merged correctly.

`INSUFFICIENT_DATA` is deliberately not subscribed to. An alarm that has lost
its metric is a broken alarm, not a restored service, and treating it as `OK`
would close incidents that are still running.

Recovery time is reported for attributed incidents, matching the current DORA
name for the key (*failed deployment recovery time*). The unattributed series is
kept alongside because operationally it still matters how long those took.

---

## Wiring it up

### 1. Deploy the stack

```bash
DORA_GITHUB_TOKEN_SECRET_ARN=arn:aws:secretsmanager:...:secret:dora-github-token \
  npx cdk deploy DoraMetricsStack
```

The token secret holds `{"token": "ghp_..."}` and needs `contents: read`, plus
`pull_requests: read` for a private repository. Omit it entirely and the other
three keys still work — lead time reports as unmeasurable rather than as zero.

The DynamoDB table is created with `RemovalPolicy.RETAIN`: the attribution state
is the only copy of how the delivery system performed, and the events that
produced it are long gone from EventBridge. Note the consequence — after a
`cdk destroy`, redeploying fails on the table name until you delete or import
the retained table.

### 2. Let the pipeline emit events

Grant `events:PutEvents` on the target bus to the deploy role, then call the
template from every deploy job:

```yaml
dora:
  needs: [deploy]
  if: always() && needs.deploy.result != 'cancelled'
  uses: YOUR_ORG/YOUR_REPO/.github/workflows/emit-dora-deployment.yml@main
  with:
    environment: production
    service: api
    outcome: ${{ needs.deploy.result == 'success' && 'succeeded' || 'failed' }}
  secrets:
    AWS_ROLE_ARN: ${{ secrets.DORA_EMITTER_ROLE_ARN }}
```

`always()` matters. A deployment that failed is a datapoint; skipping it leaves
change failure rate computed over successes only.

Nothing subscribes to `aws.ecs` or `aws.codedeploy` events, because neither
carries a commit and three of the four keys are about the commit.

### 3. Declare the incident alarms

```ts
incidentAlarms: [
  { alarmName: 'production-alb-5xx-elb', environment: 'production', service: 'api' },
],
```

The service is **declared, not parsed**. Alarms here are named after the metric
they watch (`production-alb-5xx-elb`, `production-ecs-cpu-high`), so any prefix
rule would file their incidents under services called "alb" and "ecs". Those
dimensions match no deployment, nothing is ever attributed, and change failure
rate reads zero forever — which is indistinguishable from a service that never
breaks.

An empty list is rejected at synth: an EventBridge pattern with no `resources`
matches every alarm in the account, which would put billing and staging alarms
into production's recovery time.

---

## Event shape

```json
{
  "Source": "dora.deployment",
  "DetailType": "Deployment",
  "Detail": {
    "environment": "production",
    "service": "api",
    "outcome": "succeeded",
    "commitSha": "9f1c0de5b4a37821cc6d1ee4b0f9a2d3c5e78190",
    "deploymentId": "gha-12345678-1",
    "deployedAt": "2026-08-17T12:00:00.000Z",
    "pullRequestNumber": 42,
    "version": "v2.14.0"
  }
}
```

`deployedAt` is stamped by the pipeline, not by the recorder, so a retry or a
dead-letter replay records when the deployment happened rather than when the
event was finally processed.

`deploymentId` is the idempotency key. EventBridge delivers at least once, and
the sort key is derived from the event rather than the clock, so a redelivery
collides on a conditional put instead of inventing a second deployment. A re-run
of the emitting job produces a new `run_attempt` and therefore a new id — a
genuine second deployment, which is the correct reading.

---

## Metrics

Namespace `DORA`.

| Metric | Dimensions | Published by |
| --- | --- | --- |
| `Deployments` | Environment, Service, Outcome | recorder, per deployment |
| `LeadTimeSeconds` | Environment, Service, Source | recorder, per deployment |
| `LeadTimeUnmeasurable` | — | recorder |
| `Incidents` | Environment, Service, Attribution | recorder, per incident |
| `RecoveryTimeSeconds` | Environment, Service, Attribution | recorder, on resolve |
| `DeploymentsPerDay` | Environment, Service | aggregator, hourly |
| `ChangeFailureRate` | Environment, Service | aggregator, hourly |
| `RipeDeployments` | Environment, Service | aggregator, hourly |
| `UnripeDeployments` | Environment, Service | aggregator, hourly |
| `FailedDeployments` | Environment, Service | aggregator, hourly |

Point-in-time facts are published when they happen; only the window-dependent
ratios are recomputed on a schedule.

Lead time and recovery time are graphed at **p50 and p90, never as a mean**.
Neither is normally distributed — most changes ship the same day and a handful
sit in review for a fortnight — so a mean reports a population that does not
exist.

`DeploymentsPerDay` carries `Unit: None`. CloudWatch has no per-day unit, and
labelling a per-day rate as `Count/Second` makes the console render it with an
SI prefix.

---

## Performance bands

The dashboard draws one annotation per key, defaulting to the 2023 State of
DevOps elite boundaries:

| Key | Elite |
| --- | --- |
| Deployment frequency | ≥ 1/day |
| Lead time for changes | ≤ 1 day |
| Change failure rate | ≤ 5% |
| Failed deployment recovery time | ≤ 1 hour |

These are props, not constants:

```ts
thresholds: {
  eliteDeploymentsPerDay: 4,
  eliteLeadTimeSeconds: 3600,
  eliteChangeFailurePercent: 2,
  eliteRecoveryTimeSeconds: 900,
}
```

The bands shift between report years, and a team's own target is a more useful
line than an industry cohort's.

---

## When the instrument breaks

The failure this system guards hardest against is not a bad score — it is a
score that has quietly stopped being a measurement. A revoked token, a renamed
repository, or a pipeline that stopped sending the pull request number all make
lead time vanish from the graph, and a missing line reads as "nothing happened".

- `LeadTimeUnmeasurable` is published whenever a deployment is recorded but its
  lead time cannot be resolved, and an alarm fires when it is non-zero across
  two consecutive hours.
- The recorder has a dead letter queue; the aggregator does not. A deployment
  event that fails to record is a permanently missing datapoint, whereas a
  failed aggregation run is superseded by the next one. **Anything in the DLQ is
  a hole in the metrics, not a retryable backlog** — replay it rather than
  purging it.
- The aggregator paginates rather than capping its read. A truncated query would
  silently shrink the denominator, and a change failure rate over "the first
  megabyte of deployments" is not a change failure rate.

---

## Goodhart

These four numbers are diagnostic, not a target. Deployment frequency rises when
you split one change across three pull requests. Change failure rate falls when
you stop alarming on things. Recovery time falls when you resolve incidents in
the tracker before the fix ships.

Nothing in this stack gates a deployment or changes a rollout, deliberately: a
measurement that can block the thing it measures stops being one. Use the trend
and the shape of the distribution, and treat any sudden improvement as a
question about the instrument first.
