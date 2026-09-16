# OpenTelemetry Collector with tail-based sampling

`OtelCollectorStack` deploys a collector tier that decides which traces to keep
**after** the trace is complete, rather than at its first span.

Nothing here is instrumentation. The application still has to emit OTLP, and it
has to stop head-sampling first — §3 is the part that is easy to skip and
guarantees the rest does nothing.

## 1. Why the decision moves to the tail

Head sampling decides at the root span. At that moment the request has not
failed, has not been slow, and has not touched the database, so the decision is
made without any of the facts that would make a trace worth keeping. A 5% head
sample keeps 5% of errors, and it keeps them by accident.

Tail sampling buffers a trace's spans, waits for it to finish, and then applies
policies to the whole thing. "Keep every error, keep everything slower than two
seconds, keep 5% of the rest" is a sentence you can only write at the tail.

It costs one hard constraint, stated in the processor's own README and missed
routinely:

> All spans for a given trace MUST be received by the same collector instance
> for effective sampling decisions.

A collector tier behind a load balancer breaks that by construction. Spans of a
single trace land on different instances; each instance sees a fragment and
decides confidently on it. **Nothing fails.** The pipeline is green, every task
is healthy, and what reaches the backend is a mixture of whole traces, half
traces, and traces one instance kept while another dropped. The symptom surfaces
during an incident, as a trace with the database span missing.

So the deployment is two tiers:

```
  application task                                sampler service (ECS)
 ┌───────────────────────────┐                   ┌───────────────────────┐
 │ app container             │                   │ otlp :4317            │
 │   OTLP → localhost:4317   │                   │   memory_limiter      │
 │                           │   consistent      │   tail_sampling  ◀────┼── decides
 │ otel-agent sidecar        │   hash over       │   batch               │
 │   otlp (loopback)         │   trace id        │   awsxray             │
 │   resourcedetection/ecs   │ ────────────────▶ └───────────────────────┘
 │   load_balancing exporter │                    registered in Cloud Map
 └───────────────────────────┘                    (2–3 tasks, fixed)
```

The **agent** is a sidecar rather than a shared gateway tier because the trace is
already in the application's task: no load balancer, no extra hop, and it scales
with the application for free. It is also the only place ECS resource attributes
can be attached — the task metadata endpoint is per-task, so cluster, task ARN
and task family are knowable in the sidecar and nowhere downstream. `XRayStack`
ships the X-Ray daemon the same way.

The **sampler** tier runs `tail_sampling`. Its instances are the backends of the
agents' hash ring.

## 2. Configuration delivery

Both containers run the pinned ADOT collector image
(`lib/base-images.ts: ADOT_COLLECTOR_IMAGE`) with its command replaced by
`--config=env:OTEL_CONFIG_CONTENT`, and the config itself in that environment
variable on the task definition.

The config is rendered **as JSON**, by `lib/otel-collector-config.ts`. YAML 1.2
is a superset of JSON and the collector parses the environment variable as YAML,
so a JSON document is a valid collector config. That buys three things: no YAML
serialiser in the synth path, a byte-stable string (so a task-definition diff
shows a policy change and nothing else), and a value an operator can paste into
a `config.yaml` unchanged.

To read what is actually deployed:

```sh
cd aws/cdk && npx cdk synth OtelCollectorStack-Production --quiet
python3 -c '
import json
t = json.load(open("cdk.out/OtelCollectorStack-Production.template.json"))
for r in t["Resources"].values():
    if r["Type"] != "AWS::ECS::TaskDefinition":
        continue
    for c in r["Properties"]["ContainerDefinitions"]:
        for e in c.get("Environment", []):
            if e["Name"] == "OTEL_CONFIG_CONTENT":
                print(e["Value"])
'
```

## 3. Wiring an application in

Two steps, and the second is the one that matters.

```ts
const agent = OtelCollectorStack.addAgentSidecar(
  taskDefinition,
  otelCollectorStack.agentSidecarOptions,
);

const app = taskDefinition.addContainer('AppContainer', {
  // …
  environment: {
    ...OtelCollectorStack.appEnvironment({ serviceName: 'api', envName: 'production' }),
  },
});

app.addContainerDependencies({
  container: agent,
  condition: ecs.ContainerDependencyCondition.HEALTHY,
});
```

`addAgentSidecar` also grants the application's **task role** the two
permissions the agent needs. The collector stack needs the application's
security group in `clientSecurityGroups`, since the sampler's OTLP port admits
nothing else.

### The setting everything depends on

`appEnvironment` sets `OTEL_TRACES_SAMPLER=parentbased_always_on`. This is not a
detail:

> If the SDK head-samples at 5%, the collector can only choose among the 5% that
> survived. "Keep every error" then keeps every error *in that 5%* — which is 5%
> of errors, and which looks from the outside exactly like tail sampling working.

Every guide on reducing trace cost sets `parentbased_traceidratio`, and
`XRayStack` configures the same reduction on the X-Ray side. If you are running
both, turn the X-Ray sampling rule's `fixedRate` up to 1 or stop deploying it:
two independent samplers multiply.

### Trace ID format

The `awsxray` exporter maps OTel trace IDs onto X-Ray's format, in which the
first four bytes are a Unix timestamp. X-Ray rejects a segment whose embedded
timestamp is implausible, and a randomly generated OTel trace ID is implausible
almost always. The SDK therefore has to use the X-Ray ID generator:

| SDK      | How                                                                     |
|----------|-------------------------------------------------------------------------|
| Python   | `OTEL_PYTHON_ID_GENERATOR=xray`                                          |
| Node.js  | `idGenerator: new AWSXRayIdGenerator()` from `@opentelemetry/id-generator-aws-xray` |
| Java     | `-Dotel.aws.imds.enabled` auto-config, or `AwsXrayIdGenerator` explicitly |
| Go       | `sdktrace.WithIDGenerator(xray.NewIDGenerator())`                        |

Get this wrong and the pipeline looks healthy up to the last hop: the collector
accepts, samples, and exports, and X-Ray returns the segments as unprocessed.
`${env}-otel-export-failures` (§6) is the alarm that catches it.

`OTEL_PROPAGATORS` includes `xray` because the ALB stamps `X-Amzn-Trace-Id` on
inbound requests. An application configured for W3C alone starts a new trace at
every hop that only speaks the X-Ray header.

## 4. Sizing the sampler tier

Three numbers, and two of them are checked at synth time by
`validateSamplingSpec`.

**`decision_wait` must exceed the latency threshold.** The decision timer starts
at the trace's first span. A trace still in flight when it fires is judged on
the spans seen so far, so a latency policy looking for a two-second duration
never observes one if the window is one second — and the traces it misses are
exactly the slow ones it exists to catch. The validator rejects this.

**`num_traces` must hold a decision window of arrivals, twice over.** Traces sit
in a circular buffer; once it is full the oldest is evicted, before its timer
has fired, and counted as `sampling_trace_dropped_too_early`:

```
traces in flight ≈ expected_new_traces_per_sec × decision_wait
2000/s × 30s = 60,000    → num_traces 200,000 gives 3.3x headroom
```

The validator rejects anything below 2x. Memory is roughly the span volume of
that buffer, which is why the production task is 1 vCPU / 2 GiB.

**The tier does not auto-scale, deliberately.** Every other ECS service in this
repository does. Here the instances are the ring's backends: adding or removing
one re-points about 1/N of trace IDs, and for one resolver interval the agents
disagree about which instance owns which trace — so traces in flight across that
window are split and both halves are decided on a fragment. A scaling policy
would do that automatically, at the traffic peak, and it would never appear as
an error. Size for the peak and change `desiredCount` deliberately;
`${env}-otel-spans-refused` is what tells you it is too small.

For the same reason the service deploys at `minHealthyPercent: 100` rather than
the 50 the application services use.

## 5. The policies

Evaluated with **OR**: a trace is kept if any policy says so, with `drop` as the
one terminal decision. That is the most misread thing about this processor —
adding a 10% probabilistic policy next to an errors policy does not cap anything
at 10%, it adds 10% on top of every error already kept.

| Policy | Type | What it keeps |
|--------|------|---------------|
| `drop-synthetic-traffic-by-url.path` | `drop` | drops health checks and metric scrapes |
| `drop-synthetic-traffic-by-http.target` | `drop` | same, pre-1.0 semconv spelling |
| `keep-errors` | `status_code` | any trace with an `ERROR` span |
| `keep-slow` | `latency` | any trace over `latencyThresholdMs` |
| `keep-baseline-sample` | `probabilistic` | `baselinePercentage` of the remainder |

Two details in that table are load-bearing:

- **One drop policy per attribute key.** `drop` combines its sub-policies with
  AND — it drops only when every one matched. Both path spellings inside a
  single `drop` would require a span to carry `url.path` *and* `http.target`,
  which no SDK emits, so every health check would be sampled by a config that
  reads correct. As separate top-level policies they are OR'd.
- **`status_codes: [ERROR]`, not `[ERROR, UNSET]`.** `UNSET` is the status of
  every span nobody called `SetStatus` on, which is most of them. Including it
  turns "keep errors" into "keep everything".

The baseline percentage is checked to be strictly between 0 and 100. 100 is
`always_sample` written in a way that hides it — the other policies stop having
any effect on what is retained — and 0 is a policy that evaluates on every trace
and can never sample one.

Drop patterns are regular expressions (`enabled_regex_matching: true`). Without
that flag the values are exact matches, so `^/health$` matches the literal
string `^/health$` and nothing else.

## 6. Watching the watcher

Every failure this deployment has is silent. A dropped trace and a trace that
was never sent are identical at the backend: an absence. So each collector
scrapes its own Prometheus endpoint and publishes an allowlist of metrics to
CloudWatch as EMF, under `OTelCollector/{env}`.

The allowlist is an allowlist because `awsemf` with empty `metric_declarations`
publishes everything the collector exposes — several hundred series, each a
billed custom metric — and `dimension_rollup_option` defaults to republishing
each metric once per individual label on top of that.

| Alarm | Metric | What it means |
|-------|--------|---------------|
| `{env}-otel-traces-dropped-before-decision` | `…tail_sampling_sampling_trace_dropped_too_early` | the buffer evicted traces before deciding them — raise `numTraces`, shorten `decisionWaitSeconds`, or add tasks |
| `{env}-otel-spans-refused` | `otelcol_processor_refused_spans` | the memory limiter is shedding load; the tier is undersized |
| `{env}-otel-export-failures` | `otelcol_exporter_send_failed_spans` | on an agent, the sampler tier is unreachable; on the sampler, X-Ray is rejecting segments (see §3) |
| `{env}-otel-no-sampler-backends` | `otelcol_loadbalancer_num_backends` | an agent resolved nothing and is dropping every span while passing its health check |
| `{env}-otel-no-traces-received` | `otelcol_receiver_accepted_spans` | opt-in via `alarmOnNoTracesReceived` — the tier has gone quiet |

The last one is off by default because before the first application is
instrumented the tier legitimately receives nothing, and an alarm that is red
from the day it is created is one somebody silences. Turn it on once traffic is
arriving. It is also the only alarm here that treats missing data as breaching:
for the others, no datapoints means a counter that never incremented.

`service.telemetry.metrics` is deliberately **not** set in either config. The
collector's default is already a Prometheus reader on `localhost:8888` with
`without_units` and `without_type_suffix`, which is what makes the exported
names the suffix-free ones above. Restating the block would not restate those
flags unless every one were written out, because `readers` is a list — confmap
merges maps and replaces sequences, so any `readers:` discards the default entry
rather than amending it, and the replacement's unset fields fall back to Go zero
values. Every metric name would then grow a suffix, the EMF allowlist would
match nothing, and four alarms would sit at `INSUFFICIENT_DATA` looking like a
quiet system.

## 7. Service discovery

The sampler registers into a Cloud Map **private DNS** namespace, because that
is what ECS service discovery writes into. Nothing resolves it by DNS.

The agent's `load_balancing` exporter uses the `aws_cloud_map` resolver, which
calls `DiscoverInstances`. The DNS resolver would have been the obvious choice
and is wrong here: Cloud Map's DNS answers are Route 53 multivalue records,
**capped at eight**. A ninth sampler task would be invisible to DNS, and — worse
— two agents resolving different eights would build different hash rings, which
splits traces across samplers. That is the failure the whole design exists to
prevent, reintroduced by a resolver choice.

Three things about that resolver are easy to get wrong and impossible to see:

- **`port` must be set explicitly.** Left unset, the resolver reads each
  instance's `AWS_INSTANCE_PORT` attribute, which only SRV registrations carry.
  An A registration yields `10.0.1.4:` and every export fails to connect.
- **`AWS_REGION` must be on the container.** ECS puts credentials and the
  metadata URI in a task's environment but not a region, and the resolver falls
  back to a hard-coded `us-east-1`. Anywhere else that is a healthy task
  querying a namespace that does not exist, resolving zero backends, and
  dropping every span. `addAgentSidecar` sets it from the stack's region.
- **`health_status: HEALTHY_OR_ELSE_ALL`.** `HEALTHY` alone resolves to zero
  backends whenever health propagation lags a deploy or a scale event, and an
  agent with no backends drops everything. Routing to a draining task loses the
  traces in flight to it; routing to nothing loses all of them.

`DiscoverInstances` is granted on `Resource: "*"`. It is addressed by namespace
and service *name* rather than by ARN; the `servicediscovery:NamespaceArn`
condition key exists, but the namespace's id is not knowable in the application
stack without importing an output from the collector stack — and a cross-stack
export cannot change while anything references it, which would freeze the
collector stack behind every application's release cadence. The action is
read-only and returns registered addresses.

## 8. Known gaps

- **Nothing is instrumented.** This repository deploys no application, so the
  agent sidecar has never run beside one. The wiring in §3 is asserted by
  `test/otel-collector-stack.test.ts` against the synthesised task definition,
  not by a running trace.
- **X-Ray only.** `buildSamplerConfig` exports to `awsxray` and nothing else.
  A second `otlp` exporter to a vendor backend is a few lines, but it needs an
  endpoint and a credential, and both belong to whoever is adopting this.
- **The agent runs in every task, including ones that emit nothing.** It is
  128 CPU units and 512 MiB of a task's allocation; `addAgentSidecar` takes
  overrides for both.
- **`decisionWaitSeconds` is not checked against observed trace duration.** The
  validator holds it above the *latency policy's* threshold, which is the
  mechanical relationship. Whether it is above your p99.9 trace duration is a
  measurement. `otelcol_processor_tail_sampling_sampling_trace_removal_age` is
  the histogram that answers it, and it is deliberately not in the published
  allowlist — read it off a task's `localhost:8888` with ECS Exec rather than
  paying for a histogram nothing alarms on.
- **Tail sampling does not reduce what the application sends.** Every span
  crosses the network to the sampler tier before anything is discarded; what is
  saved is backend storage and query cost, not egress or CPU in the app.
