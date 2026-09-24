# Synthetic canary checks from multiple regions

Three pieces:

| | |
|---|---|
| `aws/cdk/lib/synthetic-canary-probes.ts` | the contract — what a probe has to assert, the arithmetic behind the alarms, and the fleets it refuses |
| `aws/cdk/lib/synthetic-canary-stack.ts` | `SyntheticCanaryStack` (one per probe region) and `SyntheticCanaryQuorumStack` (one, in the aggregation region) |
| `aws/cdk/tools/audit-synthetic-canaries.ts` | `npm run audit:canaries`, the review gate over what synth wrote |

Nothing here instruments an application. The probes are ordinary HTTPS requests
made from outside the account, and §7 is what you have to set before they mean
anything.

## 1. The failure this exists to prevent

Every alarm in this repository before this one is measured from inside the
system: ECS CPU, ALB 5xx, RDS connections, the SLO burn rate. They share a blind
spot.

```
   user ──▶ DNS ──▶ CDN / WAF ──▶ ALB ──▶ ECS ──▶ RDS
             ▲        ▲            └──────┬──────┘
             │        │                   │
        nothing     nothing        every existing alarm
       measures    measures          measures here
```

When a request never reaches the load balancer, none of those alarms goes red.
They go **quiet** — and CloudWatch does not breach a threshold on a metric that
has no data points. An expired certificate, a DNS record pointing at a deleted
distribution, a WAF rule that matches everything, a Route 53 failover to an
empty target: each is total user-facing failure and an empty `RequestCount`.

A synthetic canary is the only probe that sees the system the way a browser
does. That is also why `SyntheticCanaryStack` never puts one in a VPC: a canary
on the application's own network reaches the load balancer directly and stops
being able to observe the DNS record, the certificate or anything in front of
the ALB — which is most of what it was added for. `canary-in-vpc` is a gate rule
because the VPC version still runs, still passes, and looks like monitoring.

## 2. Why more than one region, and why that is not enough on its own

One canary answers "is the application up?" with a claim it cannot support:

> **One region cannot tell "the application is down" from "this probe's region
> is having a bad morning."**

A canary in us-east-1 that fails might be reporting an outage, a cold-start
failure in its own region, or a network partition between two AWS regions that
no user is behind. Paging on it is how a canary earns a reputation for crying
wolf, and the usual response — raise the threshold until it stops — leaves a
probe that no longer reports the outage either.

Probing from several regions makes the question answerable, but only if
something compares the answers. **N regional alarms are not a comparison**: one
global outage pages N times, one flaky region pages once, and at 3am those look
the same. So the fleet has a quorum:

| what happened | what fires | where it goes |
|---|---|---|
| `quorum` regions or more are failing | `…-quorum` | page |
| one region is failing, the rest pass | `…-<region>` | ticket |
| one region has published nothing at all | `…-<region>-silent` | ticket |
| this region's own canary failed | `…-<region>-failed` (local) | that region's topic |

`quorum` is at least two, always. A quorum of one is the per-region alarm with a
louder destination, which is the arrangement the fleet exists to replace;
`quorum-below-two` refuses it at synth time.

## 3. Why the verdicts are republished

CloudWatch alarms are regional. An alarm in eu-west-1 cannot read a metric in
us-east-1, and no amount of metric math crosses that line — so the quorum cannot
be computed from the `CloudWatchSynthetics` metrics the canaries publish where
they run.

Each canary therefore publishes its verdict a second time, with `PutMetricData`
aimed at the **aggregation region**:

```
 us-east-1 canary ─┐
 eu-west-1 canary ─┼─▶ PutMetricData(region = aggregationRegion)
 ap-southeast-1   ─┘        │
                            ▼
              Boilerplate/SyntheticCanary
                ProbeFailure  {Environment, Probe, Region}
                ProbeLatency  {Environment, Probe, Region}
                            │
                            ▼
              FILL(m0,0) + FILL(m1,0) + FILL(m2,0) >= quorum
```

One statement makes this work, and its absence is silent in review:

> CDK's generated canary role allows `cloudwatch:PutMetricData` **under a
> condition pinning the namespace to `CloudWatchSynthetics`** — which is correct,
> and is exactly the call the handler makes into ours.

Without the added statement in `SyntheticCanaryStack`, every run is denied at
the republish. The handler lets that throw, so the local alarm catches it; the
gate rule `canary-without-metric-grant` catches it one step earlier, in review.

`activeTracing` has the same shape and is quieter still: it is a property on the
canary *and* a permission on its role, and CDK sets only the property. Without
`xray:PutTraceSegments`, the segments are dropped — the canary runs, reports,
and the trace that would say whether a slow run was the network or the origin is
simply never there.

## 4. The three ways silence is handled, and why they differ

Silence is the whole problem with monitoring a monitor. Three alarms treat it
three different ways, on purpose.

**`FILL(m, 0)` in the quorum expression.** CloudWatch metric math produces no
data point wherever *any* input is missing. Summing the regions raw means one
region whose canary has stopped reporting removes the quorum alarm's data for
every other region at the same time — the fleet is largest exactly when it is
least able to page. `FILL(m, 0)` reads a gap as "this region is not voting",
which is only safe because of the next one.

**`TreatMissingData: breaching` on the heartbeat alarm.** A canary that has
stopped running — deleted, throttled, failing before its first line, or on a
Synthetics runtime AWS retired — publishes nothing. To every threshold on
failures, nothing is indistinguishable from a run that passed. So one alarm per
region exists whose entire subject is the absence of data, and it is the only
one that reads a gap as a breach on its own.

**`TreatMissingData: notBreaching` on the per-region failure alarm.** Silence
there is the heartbeat alarm's business. Treating it as breaching too would
raise two alarms for one cause, which is how people learn to close one of them
without reading it.

The quorum alarm is also `breaching`: `FILL` covers a gap inside a series that
has data, and a fleet that has gone entirely silent produces no series to fill.

## 5. The local alarm, and what it is for

`SyntheticCanaryStack` keeps one alarm per canary in the canary's own region,
over the `CloudWatchSynthetics` `SuccessPercent` metric that Synthetics
publishes for itself.

It is deliberately redundant. It is the only signal for a probe that does not
depend on the cross-region republish, on the aggregation region being
reachable, or on any of the metric math being right. When the aggregation region
is the thing that is broken, the fleet degrades to N independent regional alarms
— which is worse than a quorum and much better than nothing.

Its `TreatMissingData` is `breaching`, for the reason above.

## 6. What a probe asserts

A status code is not a health check. `200 OK` is what a maintenance page
returns, what a cached CloudFront error page returns, and what an application
shell whose data fetch failed returns. So every probe carries three assertions,
as deployed environment variables rather than as code:

| variable | assertion |
|---|---|
| `PROBE_EXPECTED_STATUS` | the status the application returns when healthy (2xx; `204` is refused, as it has no body) |
| `PROBE_BODY_MARKER` | a string in the healthy body and in no error page — required, and empty is refused |
| `PROBE_LATENCY_BUDGET_MS` | the run fails above it, so the budget is a threshold rather than a number in a runbook |

The handler refuses to run if any of them is missing. That is not defensive
coding: an absent `PROBE_BODY_MARKER` would otherwise compare against
`undefined`, and the probe would silently become a status-code-only probe —
still green, still running, still reporting on an outage it can no longer see.

Two limits the validator enforces because AWS only enforces them at deploy time,
and CDK does not enforce them at all:

- **Canary names are capped at 21 characters** (`[a-z0-9_-]`). CDK's own check
  allows 255. Over the cap, `cdk deploy` fails in every probe region at once,
  with nothing in review that predicted it.
- **A `rate()` schedule must be 1 to 60 minutes**, and the run timeout must be
  at or below it, or runs overlap.

And one that is arithmetic rather than an AWS limit: a latency budget at or
above the run timeout can never be the reason a run failed, because the run is
killed first. It reads as a latency SLO that is never breached.

## 7. What you have to set

The URLs in `bin/app.ts` are placeholders in the reserved `example.com` domain,
like the ACM certificate ARNs at the top of that file. Set them before
deploying, by context or by environment variable:

```bash
cdk deploy --all \
  --context productionCanaryBaseUrl=https://www.your-domain.example \
  --context stagingCanaryBaseUrl=https://staging.your-domain.example
```

| context key | environment variable | default |
|---|---|---|
| `productionCanaryBaseUrl` | `PRODUCTION_CANARY_BASE_URL` | `https://www.example.com` |
| `stagingCanaryBaseUrl` | `STAGING_CANARY_BASE_URL` | `https://staging.example.com` |
| `canaryProbeRegions` | `CANARY_PROBE_REGIONS` | `us-east-1,eu-west-1,ap-southeast-1` |
| `canaryAggregationRegion` | `CANARY_AGGREGATION_REGION` | `eu-west-1` |

The body markers are the other half, and they are application-specific:
`"status":"ok"` for the health endpoint and `data-app-shell="ready"` for the
landing page are the reference values. Pick strings the **error** pages do not
contain — a marker taken from a shared layout is in the error page too.

Every probe region needs a CDK bootstrap, because a canary is deployed there:

```bash
for region in us-east-1 eu-west-1 ap-southeast-1; do
  cdk bootstrap "aws://$ACCOUNT/$region"
done
```

Paging goes to `${envName}-canary-page` and tickets to
`${envName}-canary-ticket`, created by the quorum stack. Pass `pageTopic` /
`ticketTopic` to route them into an existing topic instead — `SloStack`'s, for
example, which lives in the same account and can be in the same region.

## 8. Cost

A canary run is billed per run, and the fleet multiplies: probes × regions ×
runs. The reference configuration is 2 probes × 3 regions every 5 minutes for
production, and 2 × 2 every 15 minutes for staging — roughly 62,000 production
runs a month. Raising the cadence to one minute multiplies that by five and buys
four minutes of detection; `maxDetectionMinutes` on the fleet is where that
trade is written down, and `detection-slower-than-declared` is what stops the
number in the runbook drifting away from the one the alarms achieve.

Staging is probed at all for one reason: it is where a broken probe — a stale
URL, a marker that no longer appears, an IAM change — is found before production
is the place that finds it.

## 9. The gate

`npm run audit:canaries` reads `cdk.out/*.template.json` after `cdk synth`, so
it sees what synth wrote rather than the TypeScript that produced it. It is
scoped by the `SyntheticCanaryFleet` tag on the canaries, and by the
`Boilerplate/SyntheticCanary` namespace on the alarms.

| rule | what it prevents |
|---|---|
| `canary-in-vpc` | a probe on the application's own network, blind to DNS, TLS and the WAF |
| `canary-missing-probe-config` | a status-code-only probe with a marker variable that is not set |
| `canary-without-metric-grant` | the republish denied on every run; the quorum reads an empty series |
| `canary-artifacts-unencrypted` | production response headers and screenshots at rest in the clear |
| `canary-schedule-outside-range` | a canary that fails to create |
| `canary-timeout-exceeds-schedule` | overlapping runs, rejected at deploy time |
| `local-alarm-missing` | no signal that survives the aggregation region |
| `local-alarm-ignores-missing-data` | a stopped canary reading as a healthy one |
| `quorum-alarm-missing` | per-region alarms with nothing comparing them |
| `quorum-expression-without-fill` | one silent region blinding the quorum for all the others |
| `quorum-threshold-below-two` | a quorum that is a per-region alarm with a pager attached |
| `quorum-terms-below-threshold` | a threshold the sum cannot reach: green through a total outage |
| `quorum-alarm-ignores-missing-data` | a fleet that has gone entirely silent, sitting green |
| `heartbeat-alarm-missing` | nothing watching for the absence of a verdict |
| `alarm-without-action` | an alarm that is evaluated and tells nobody |

It reads both shapes CloudFormation accepts for an alarm's metric — the flat
`Namespace`/`MetricName`/`Dimensions` properties, and the `Metrics` array CDK
switches to as soon as a metric carries a label. A gate that understood only one
would have gone quiet the day somebody added a legend label.

The gate also fails when it finds **no** canaries at all. A tag-scoped gate
whose scope has gone empty passes exactly like one that checked everything.

## 10. Known gaps

- **The aggregation region is a single point of failure for the aggregated
  signals.** If CloudWatch there is unavailable, the quorum and heartbeat alarms
  are unavailable with it, and the fleet falls back to the per-region local
  alarms. Choose an aggregation region the application does not run in; the
  default (`eu-west-1`) is not the default application region for that reason.
- **Nothing here has been deployed.** The rules parse, validate, synthesise and
  reject; no canary in this repository has yet made a request. The runtime is
  pinned to `syn-nodejs-puppeteer-13.0` and the handler is checked against the
  constants the stacks and the gate read, which is a different and weaker claim
  than having watched a run fail and a page arrive.
- **Latency has no alarm of its own.** A run over budget fails, so latency
  breaches arrive as `ProbeFailure` and reach the quorum like any other failure.
  `ProbeLatency` is published for the dashboard and for diagnosis — "was it slow
  everywhere or only from Singapore" — not for a threshold.
- **The probes are unauthenticated `GET`s.** Probing a signed-in path needs a
  credential in the canary, and a canary with a production credential is a new
  thing to protect in three regions; `restrictedHeaders` in the handler keeps
  `authorization` and `cookie` out of the artifacts, but the decision about the
  credential itself is not made here.
- **A probe cannot tell a slow origin from a slow probe.** `activeTracing` is on
  so the canary's own request appears in X-Ray, which narrows it; it does not
  close it.
