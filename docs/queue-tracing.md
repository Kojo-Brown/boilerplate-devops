# Distributed tracing across API → queue → worker

`OtelCollectorStack` and `XRayStack` trace a request while it is a request. This
is what happens when it becomes a message.

Three pieces:

| | |
|---|---|
| `aws/cdk/lib/queue-trace-context.ts` | the contract — carriers, parent-or-link, and the configurations it refuses |
| `aws/cdk/lib/traced-queue-stack.ts` | the queue, its dead-letter queue, and the alarms that say when propagation stopped |
| `aws/cdk/tools/audit-queue-tracing.ts` | `npm run audit:tracing`, the review gate over what synth wrote |

Nothing here instruments an application. The producer has to call
`injectTraceContext` before `SendMessage` and the worker has to call
`extractTraceContext` after `ReceiveMessage`; §4 is the shape of both.

## 1. The failure this exists to prevent

A queue is the one boundary in a system where broken tracing and working tracing
look identical.

```
  POST /orders                         worker task
 ┌──────────────────┐                 ┌──────────────────┐
 │ span: POST /orders│                │ span: process    │
 │   span: SendMessage ──▶ [ queue ] ─┼──▶ (no parent)   │
 │ 202               │                │                  │
 └──────────────────┘                 └──────────────────┘
        trace A                              trace B
```

The API is instrumented. The worker is instrumented. Both emit spans, both
appear in the service map, both look healthy, and the only thing missing is the
edge between them. There is no error, no failed call, no metric that differs
from the working case — and the thing you look at during an incident is the
trace of the request that failed, which ends at the 202.

Everything below follows from that. Each rule in `validateQueuePropagation` is a
configuration AWS accepts, deploys and runs.

## 2. Three carriers, and they are not interchangeable

**Message attributes** carry W3C context: `traceparent`, `tracestate`,
`baggage`. SQS allows **ten user attributes per message** and enforces the limit
at `SendMessage`, so a producer that adds three unconditionally works until a
message carries eight business attributes — and then fails for that message
shape only, in production, on a path nothing changed.
`injectTraceContext` is therefore budget-aware: it gives up `baggage` first,
then `tracestate`, never `traceparent`, and logs what it gave up
(§6). If there is no room even for `traceparent` it throws, because the
alternative is a message that silently carries no trace.

**The system attribute** `AWSTraceHeader` carries the X-Ray header. It is a
reserved slot and does not count against the ten, which is why the X-Ray half is
never the half that gets dropped. It is also the quietest failure here:

> `ReceiveMessage` returns system attributes **only when the call names them**,
> in `MessageSystemAttributeNames`.

Omit the parameter and the field is simply absent from the response. Not an
error, not a warning — just a worker that opens a new trace for every message,
forever. Nothing in IAM can catch it (`sqs:ReceiveMessage` covers the attribute
either way), so `TracedQueueStack.workerEnvironment()` puts the name in the task
definition as a deployed value and `audit:tracing` checks that it is still
there.

**The body carries no trace context, ever.** Not because it cannot, but because
FIFO content-based deduplication hashes the body. Put a trace id in there and
two sends of an otherwise identical message are no longer duplicates:
deduplication stops deduplicating, with no error and no metric, and the symptom
is duplicate work.

### SNS in front of the queue

An SNS subscription with `RawMessageDelivery` disabled wraps the payload in a
notification envelope and puts the publisher's message attributes **inside it**.
The SQS message's own `MessageAttributes` then arrive empty:

```jsonc
// SQS Body, RawMessageDelivery: false
{
  "Type": "Notification",
  "TopicArn": "arn:aws:sns:…:orders",
  "Message": "{\"orderId\":\"ord-1\"}",
  "MessageAttributes": { "traceparent": { "Type": "String", "Value": "00-…" } }
}
```

Both halves look correct in the console. `validateQueuePropagation` refuses the
combination unless the path propagates X-Ray only — SNS copies `AWSTraceHeader`
into the system attribute either way. `extractTraceContext` still reaches into
the envelope, so an existing non-raw subscription keeps working while it is
being fixed rather than losing every trace in the meantime.

### Attribute name case

W3C names the headers in lowercase; SQS attribute names are case-sensitive; HTTP
header names are not, and libraries normalise them differently. An HTTP-to-SQS
bridge that title-cases what it copies produces `Traceparent`, and a consumer
matching exactly reads past it. So the library is **liberal on read and strict
on write**: extraction matches case-insensitively, injection always writes
lowercase, and the validator refuses a producer that declares a miscased copy of
one of the names.

## 3. Parent or link

The instinct is to make every worker span a child of the producer's span. That
is right only while the producer's trace is still open, and a queue is the one
place where it routinely is not.

The tail sampler holds a trace for `decisionWaitSeconds` after its **first**
span and then decides it — for good. Spans arriving later belong to a trace that
has already been sampled, exported and closed; the processor counts them as late
arrivals and drops them. A message that waits longer than the window and is then
processed as a *child* therefore produces a trace missing exactly the half the
queue was hiding, which reads in the console as a worker that never ran.

Beyond that window the correct relationship is a **link**: a new trace, whole and
independently decidable, carrying a reference back to the span that enqueued the
message. It is a worse experience than one trace, and it is an honest one.

`propagationDecision` draws the line, from the collector's own
`decisionWaitSeconds` so the two cannot drift:

| condition | relationship | why |
|---|---|---|
| producer did not sample | link | a child of an unsampled parent is unsampled, so the work is invisible; a link gives the consumer's sampler a say and still names the parent |
| `ApproximateReceiveCount > 1` | link | a retry is separated from the first attempt by at least the visibility timeout, and a dead-letter redrive by days |
| dwell ≥ decision window | link | the original trace is already decided and exported |
| otherwise | parent | the producer's trace is still open |

Clock skew is clamped rather than trusted: `SentTimestamp` is SQS's clock and
the receive time is the consumer's, so a consumer running behind would otherwise
compute a negative dwell and take the parent branch regardless of how long the
message actually waited.

The gap itself is worth an attribute. Without one, the trace shows eleven
seconds of nothing and nothing in it says the eleven seconds were spent in a
queue rather than in an untraced service. `QUEUE_TIME_ATTRIBUTE` is
`aws.sqs.queue_time_ms` — deliberately **not** in the `messaging.` namespace,
which OpenTelemetry owns and which has no queue-time convention yet.

## 4. Using it

Producer, before `SendMessage`:

```ts
import { injectTraceContext, traceContextTruncatedLog } from '@/lib/queue-trace-context';

const { message, dropped } = injectTraceContext(
  { MessageAttributes: { orderId: { DataType: 'String', StringValue: order.id } } },
  { traceId, spanId, sampled },          // from the active span context
);

if (dropped.length > 0) {
  console.log(traceContextTruncatedLog({ queueName, dropped }));
}

await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody, ...message }));
```

Worker, after `ReceiveMessage`:

```ts
const response = await sqs.send(new ReceiveMessageCommand({
  QueueUrl,
  MessageAttributeNames: ['All'],
  // Without this the AWSTraceHeader field is absent from every message.
  MessageSystemAttributeNames: [process.env.TRACE_MESSAGE_SYSTEM_ATTRIBUTE_NAMES!],
  AttributeNames: ['SentTimestamp', 'ApproximateReceiveCount'],
}));

for (const message of response.Messages ?? []) {
  const { context, reason } = extractTraceContext(message);

  if (context === undefined) {
    console.log(traceContextMissingLog({ queueName, messageId: message.MessageId!, reason: reason! }));
    // Start a new trace and process the message. A tracing header is never a
    // reason to dead-letter a good payload.
  } else {
    const { relationship, dwellMs } = propagationDecision({
      sentAtMs: Number(message.Attributes!.SentTimestamp),
      receivedAtMs: Date.now(),
      approximateReceiveCount: Number(message.Attributes!.ApproximateReceiveCount),
      decisionWaitSeconds: Number(process.env.TRACE_DECISION_WAIT_SECONDS),
      parentSampled: context.sampled,
    });
    // relationship === 'parent' → start the span with `context` as its parent
    // relationship === 'link'   → start a root span with a link to `context`
    // either way, set QUEUE_TIME_ATTRIBUTE to dwellMs
  }
}
```

`MessageAttributeNames: ['All']` and `MessageSystemAttributeNames` are separate
parameters covering separate namespaces. Asking for all of one does not return
any of the other.

The worker also needs `OtelCollectorStack.appEnvironment()` and the agent
sidecar; without them it extracts context correctly and exports it nowhere,
which `audit:tracing` reports as `worker-without-otel-endpoint`.

## 5. Sampling has to be parent-based on both sides

If the consumer's `OTEL_TRACES_SAMPLER` decides without reference to the
incoming context, the producer and the consumer sample the same trace
independently. Most traces then keep one half and drop the other, and every
service involved looks correctly instrumented while the backend fills with
fragments.

`parentbased_always_on`, `parentbased_always_off`, `parentbased_traceidratio`
and `parentbased_jaeger_remote` are accepted; a bare `traceidratio` or
`always_on` is not. `OtelCollectorStack.appEnvironment()` already sets
`parentbased_always_on`, and the reason it matters here is different from the
reason it matters there: on HTTP a non-parent-based sampler wastes the tail
sampler's judgement, and across a queue it halves traces.

## 6. What tells you it broke

Every failure above is silent by construction, so the worker saying so is the
only signal there is. `TracedQueueStack` creates the worker's log group, puts two
metric filters on it, and alarms on both:

| event logged | metric | what it means |
|---|---|---|
| `trace_context_missing` | `TraceContextMissing` | a message arrived with no usable context. `reason` distinguishes `absent`, `malformed`, and `not-requested` — the last one means the receive call never asked for the system attribute, which sends you to the consumer rather than to the producer |
| `trace_context_truncated` | `TraceContextTruncated` | the ten-attribute budget cost `tracestate` or `baggage` |

Both filters carry `DefaultValue: 0`. Without it the metric has no datapoint
when nothing matched and the alarm spends its life in `INSUFFICIENT_DATA`; with
it, zero is published, which is the counter's true value when the worker is
running and finding context. Both alarms treat missing data as **not**
breaching: missing data means the worker logged nothing at all, which is a
worker that is not running, and the ECS service alarms own that.

Two more alarms are about the queue rather than the worker:

- **`…-dwell-approaching-decision-window`** on `ApproximateAgeOfOldestMessage`,
  at half the decision window by default. It fires *below* the window on
  purpose: at or past it, it would describe traces already decided on their
  producer half. `validateQueuePropagation` refuses a threshold at or above the
  window for that reason.
- **`…-dlq-not-empty`**. Beyond the ordinary meaning, a redriven message links
  rather than parents, so its trace and the original request's are separate.

## 7. The gate

`npm run audit:tracing` reads `cdk.out/*.template.json` — what synth wrote, not
the TypeScript that produced it.

| rule | the failure |
|---|---|
| `worker-without-system-attribute` | `ReceiveMessage` never asks for `AWSTraceHeader` |
| `worker-without-otel-endpoint` | context extracted correctly, exported nowhere |
| `sampler-not-parent-based` | producer and consumer sample independently |
| `traced-queue-without-dlq` | unbounded redelivery, so unbounded dwell |
| `dead-letter-queue-open-to-any-source` | another team's poison messages in this worker's redrive |
| `traced-queue-unencrypted` | message bodies at rest in the clear |
| `dwell-alarm-missing` | dwell past the window with no signal |
| `dwell-alarm-at-or-past-decision-window` | an alarm that records the loss instead of warning of it |
| `context-signal-missing` | no metric filter over the missing-context event |
| `context-filter-pattern-mismatch` | a pattern that matches nothing, reporting zero forever |
| `context-alarm-missing` | the metric is published and nobody evaluates it |

Queue-scoped rules apply to queues tagged `TraceContextPropagation`, which
`TracedQueueStack` sets. That is a real limitation — a queue that is supposed to
be traced and carries no tag escapes them — and the alternative was to apply
them to every SQS queue in the repository, which would report a Lambda's
dead-letter queue for having no dwell alarm. The worker-side rules need no tag:
a container carrying `TRACED_QUEUE_URL` has already declared itself.

## 8. Known gaps

- **Nothing has been deployed.** No message has been through this in an account.
  The wiring is asserted against synthesised templates and the propagation logic
  against carriers built in memory, which is a different and weaker claim than
  having watched a trace cross a queue.
- **This repository deploys no application**, so there is no producer and no
  worker here. `TracedQueueStack` creates the queue and the log group and hands
  out the environment; the three worker-side rules in `audit:tracing` therefore
  have no subject in this repository's own templates and are exercised by
  fixtures in `test/audit-queue-tracing.test.ts` alone. The same is true of
  `XRayStack`, which `bin/app.ts` still does not instantiate.
- **The parent-or-link boundary is mechanical.** It compares dwell against the
  collector's configured `decisionWaitSeconds`, which is a number somebody
  chose, not a measured trace completion time.
- **No alarm topic is wired in `bin/app.ts`.** The four alarms are created and
  evaluated but notify nobody until a `alarmTopic` is passed, as with
  `LogPipelineStack`.
- **Batch consumption is validated, not implemented.** The validator refuses a
  batching consumer that opens no span per message; the per-record loop itself
  is the application's, and the snippet in §4 is a single-message shape.
- **EventBridge and SNS-to-Lambda are out of scope.** EventBridge propagates
  `AWSTraceHeader` on the event and not W3C context, and a direct SNS-to-Lambda
  subscription has no queue and so no dwell — both need their own treatment.
