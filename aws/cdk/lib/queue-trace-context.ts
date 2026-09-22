/**
 * Trace context across a queue: how it is written, how it is read back, and the
 * configurations that carry it nowhere while looking correct.
 *
 * `XRayStack` and `OtelCollectorStack` trace a request while it is a request.
 * The moment it becomes a message the trace ends, because nothing about HTTP
 * propagation survives `SendMessage`: the producer's span closes when the API
 * returns 202, the worker starts a span with no parent, and what the backend
 * shows is two unrelated traces — a fast API call that did nothing, and a
 * worker that materialised out of nowhere. Nothing fails. Both services are
 * healthy, both are instrumented, and the one question a queue exists to make
 * hard to answer — *which request caused this worker to do this* — is the one
 * the tracing cannot answer.
 *
 * This module is the contract that closes that gap, as pure functions over
 * carriers so it is testable without an SDK, an account or a queue. The stack
 * that deploys the queue is `lib/traced-queue-stack.ts`; the gate that checks
 * the synthesised templates is `tools/audit-queue-tracing.ts`; the argument in
 * prose is `docs/queue-tracing.md`.
 *
 * ## Three carriers, and they are not interchangeable
 *
 * **Message attributes** (`MessageAttributes`) are user-defined key/value pairs
 * beside the body. This is where W3C context goes. SQS allows **ten per
 * message** and the limit is enforced at `SendMessage`, so a producer that adds
 * three and already had eight fails at run time — on the subset of messages
 * that carry every optional attribute, which is never the subset a test sends.
 * {@link injectTraceContext} is therefore budget-aware rather than hopeful.
 *
 * **The system attribute** (`AWSTraceHeader`) is a single reserved slot for the
 * X-Ray header. It does not count against the ten. It is also the carrier with
 * the quietest failure in the whole file: `ReceiveMessage` returns it **only
 * when explicitly asked for**, via `MessageSystemAttributeNames`. Ask for
 * nothing and the field is simply absent — not an error, not a warning, just a
 * worker that starts a fresh trace for every message it handles.
 *
 * **The body** carries no trace context, ever. Not because it cannot, but
 * because FIFO content-based deduplication hashes the body: put a trace id in
 * there and two sends of the identical message become two distinct messages,
 * so deduplication silently stops deduplicating and the only symptom is
 * duplicate work. {@link validateQueuePropagation} rejects it.
 *
 * ## Parent or link
 *
 * The instinct is to make every worker span a child of the producer's span.
 * That is right only while the producer's trace is still open, and a queue is
 * the one place in a system where it routinely is not.
 *
 * `OtelCollectorStack`'s tail sampler holds a trace for `decisionWaitSeconds`
 * after its **first** span and then decides it — for good. Spans arriving after
 * that belong to a trace that has already been sampled, exported and closed;
 * the processor counts them as late arrivals and drops them. So a message that
 * sits in a queue for longer than the decision window and is then processed as
 * a *child* produces a trace that is missing exactly the half the queue was
 * hiding, which looks in the console like a worker that never ran.
 *
 * Beyond that window the correct relationship is a **link**: a new trace, whole
 * and independently decidable, carrying a reference back to the span that
 * enqueued the message. It is a worse experience than one trace and it is an
 * honest one, which the alternative is not. {@link propagationDecision} draws
 * that line, and it draws it from the collector's own `decisionWaitSeconds` so
 * the two cannot drift apart.
 */

/* ── Wire formats ─────────────────────────────────────────────────────────── */

/**
 * The W3C `traceparent` value, split into its fields.
 *
 * `traceId` and `spanId` are lowercase hex of fixed length; `sampled` is bit 0
 * of the flags byte. The version prefix is not modelled: version `00` is the
 * only one defined, and a parser that accepts a higher version must still read
 * the first four fields the same way, which is what {@link parseTraceparent}
 * does.
 */
export interface TraceContext {
  /** 32 lowercase hex characters, not all zero. */
  readonly traceId: string;
  /** 16 lowercase hex characters, not all zero. */
  readonly spanId: string;
  /** Bit 0 of the trace flags — whether the producer sampled this trace. */
  readonly sampled: boolean;
  /** Vendor state, passed through verbatim when present. */
  readonly traceState?: string;
}

/** Message-attribute name carrying {@link TraceContext}. Lowercase, per W3C. */
export const TRACEPARENT_ATTRIBUTE = 'traceparent';
/** Message-attribute name carrying `tracestate`. */
export const TRACESTATE_ATTRIBUTE = 'tracestate';
/** Message-attribute name carrying W3C baggage. */
export const BAGGAGE_ATTRIBUTE = 'baggage';

/**
 * The reserved system attribute carrying the X-Ray header.
 *
 * Reserved means two things: it does not count against the ten user attributes,
 * and it is not returned by `ReceiveMessage` unless named in
 * `MessageSystemAttributeNames`.
 */
export const XRAY_SYSTEM_ATTRIBUTE = 'AWSTraceHeader';

/** SQS's hard limit on user-defined message attributes per message. */
export const SQS_MAX_MESSAGE_ATTRIBUTES = 10;

/**
 * Attribute-name prefixes SQS reserves. A `SendMessage` naming one is rejected.
 *
 * Matched case-insensitively because SQS reserves them that way, while the
 * names themselves are case-sensitive — so `aws.traceparent` is refused and
 * `Traceparent` is accepted and then never found by a consumer reading
 * `traceparent`.
 */
export const RESERVED_ATTRIBUTE_PREFIXES = ['aws.', 'amazon.'] as const;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

/** `00-<32 hex>-<16 hex>-<2 hex>`, the only `traceparent` version defined. */
export const formatTraceparent = (context: TraceContext): string =>
  `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;

/**
 * Parse a `traceparent`, returning `undefined` for anything malformed.
 *
 * Deliberately total rather than throwing. A malformed header is an upstream
 * bug, and the right response in a consumer is to start a new trace and count
 * the event — not to fail the message, which would send a perfectly good
 * payload to the dead-letter queue over a tracing header.
 *
 * The all-zero trace and span ids are refused: W3C defines them as invalid, and
 * an SDK that emits one is telling you the context it had was empty. Accepting
 * it produces a trace every service in the fleet is a member of.
 */
export const parseTraceparent = (value: string | undefined): TraceContext | undefined => {
  if (value === undefined) return undefined;

  const fields = value.trim().split('-');
  if (fields.length < 4) return undefined;

  const [version, traceId, spanId, flags] = fields;
  // Version `ff` is forbidden outright; anything else parses as version 00 does,
  // which is what forward compatibility means here.
  if (!/^[0-9a-f]{2}$/.test(version) || version === 'ff') return undefined;
  if (!TRACE_ID_PATTERN.test(traceId) || traceId === INVALID_TRACE_ID) return undefined;
  if (!SPAN_ID_PATTERN.test(spanId) || spanId === INVALID_SPAN_ID) return undefined;
  if (!/^[0-9a-f]{2}$/.test(flags)) return undefined;

  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 0x01 };
};

/**
 * Format an X-Ray `Root=…;Parent=…;Sampled=…` header from a W3C context.
 *
 * The two identifier schemes are the same 128 bits with a different separator:
 * an X-Ray root is `1-` plus the first 8 hex of the trace id, read as an epoch
 * second, plus the remaining 24. That is a genuine bijection and not an
 * approximation, which is why a fleet can be half OTel and half X-Ray SDK and
 * still produce one trace — provided somebody converts at the boundary, which
 * nothing does by default.
 */
export const formatXRayHeader = (context: TraceContext): string =>
  `Root=1-${context.traceId.slice(0, 8)}-${context.traceId.slice(8)};` +
  `Parent=${context.spanId};Sampled=${context.sampled ? '1' : '0'}`;

/**
 * Parse an X-Ray header back into a W3C context.
 *
 * Field order is not guaranteed — X-Ray documents the header as
 * semicolon-separated pairs — so this reads them by name. Unknown fields are
 * ignored rather than rejected: X-Ray permits arbitrary `key=value` pairs and
 * an intermediary may have added one.
 */
export const parseXRayHeader = (value: string | undefined): TraceContext | undefined => {
  if (value === undefined) return undefined;

  const fields = new Map<string, string>();
  for (const pair of value.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    fields.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }

  const root = fields.get('Root');
  if (root === undefined) return undefined;

  const rootFields = root.split('-');
  if (rootFields.length !== 3 || rootFields[0] !== '1') return undefined;

  const traceId = `${rootFields[1]}${rootFields[2]}`.toLowerCase();
  if (!TRACE_ID_PATTERN.test(traceId) || traceId === INVALID_TRACE_ID) return undefined;

  // A header with no `Parent` is what an edge-generated X-Ray id looks like
  // before any segment has been recorded — the trace is real, the parent span
  // is not. Represented as the invalid span id so a consumer roots its own span
  // under the right trace rather than discarding the trace along with it.
  const parent = (fields.get('Parent') ?? '').toLowerCase();
  const spanId = SPAN_ID_PATTERN.test(parent) && parent !== INVALID_SPAN_ID ? parent : INVALID_SPAN_ID;

  return { traceId, spanId, sampled: fields.get('Sampled') === '1' };
};

/* ── Carriers ─────────────────────────────────────────────────────────────── */

/** One SQS message attribute, in the shape the API takes and returns. */
export interface MessageAttributeValue {
  readonly DataType: string;
  readonly StringValue?: string;
}

/** SQS `MessageAttributes`, keyed by their case-sensitive names. */
export type MessageAttributeMap = Readonly<Record<string, MessageAttributeValue>>;

/** The parts of a received SQS message this module reads. */
export interface ReceivedMessage {
  /** The raw body. Read only to unwrap an SNS envelope — never for context. */
  readonly Body?: string;
  readonly MessageAttributes?: MessageAttributeMap;
  /**
   * System attributes, as `ReceiveMessage` returns them.
   *
   * Populated **only** when the receive call named them in
   * `MessageSystemAttributeNames`. An absent `AWSTraceHeader` here means either
   * that nobody sent one or that nobody asked for it, and the two are
   * indistinguishable from inside the consumer — which is why
   * {@link validateQueuePropagation} refuses the configuration rather than
   * leaving it to be noticed.
   */
  readonly Attributes?: Readonly<Record<string, string>>;
}

/** The subset of a `SendMessage` request this module writes. */
export interface OutboundMessage {
  readonly MessageAttributes?: MessageAttributeMap;
  readonly MessageSystemAttributes?: MessageAttributeMap;
}

const stringAttribute = (value: string): MessageAttributeValue => ({
  DataType: 'String',
  StringValue: value,
});

/**
 * Read an attribute by name, case-insensitively.
 *
 * Liberal on read and strict on write, and the asymmetry is deliberate. W3C
 * names the headers in lowercase, SQS attribute names are case-sensitive, and
 * an HTTP-to-SQS bridge that title-cases what it copies (several do, because
 * HTTP header names are not case-sensitive and every library normalises
 * differently) produces `Traceparent`. A consumer matching exactly finds
 * nothing and starts a new trace, for every message, forever.
 */
const attributeValue = (
  attributes: MessageAttributeMap | undefined,
  name: string,
): string | undefined => {
  if (attributes === undefined) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(attributes)) {
    if (key.toLowerCase() === wanted) return value.StringValue;
  }
  return undefined;
};

/* ── Injection ────────────────────────────────────────────────────────────── */

/** Which wire formats a producer writes. */
export type PropagationFormat = 'w3c' | 'xray' | 'both';

/** What {@link injectTraceContext} wrote, and what it could not fit. */
export interface InjectionResult {
  /** The message, with context merged into its attributes. */
  readonly message: OutboundMessage;
  /**
   * Attributes dropped for want of a slot, in the order they were given up.
   *
   * Never empty silently: `traced-queue-stack.ts` turns this into a counted,
   * alarmed log event, because dropping baggage to keep a send working is a
   * real degradation and the alternative — a `SendMessage` that throws on the
   * messages carrying the most attributes — is worse and just as invisible.
   */
  readonly dropped: readonly string[];
}

/**
 * Merge trace context into an outbound message's attributes.
 *
 * Budget-aware by construction. SQS enforces ten user attributes at
 * `SendMessage`, so a producer that adds context unconditionally works until
 * the day a message carries eight business attributes — and then fails for that
 * message shape only, in production, on a code path nothing changed.
 *
 * The order attributes are given up is fixed and is not arbitrary: `baggage`
 * first (application-defined and reconstructible), then `tracestate` (vendor
 * routing, degrades to a correct trace with a less specific sampling hint), and
 * `traceparent` never. Losing `traceparent` is losing the trace, which is the
 * entire point of the call; if there is no room for it the caller has nine
 * business attributes and a decision to make, so this throws rather than
 * quietly producing an unpropagated message.
 */
export const injectTraceContext = (
  message: OutboundMessage,
  context: TraceContext,
  options: { readonly format?: PropagationFormat; readonly baggage?: string } = {},
): InjectionResult => {
  const format = options.format ?? 'both';
  const existing = { ...(message.MessageAttributes ?? {}) };

  // Anything already present under one of our names is removed first, whatever
  // format is being written. Two reasons, and the second is the important one:
  // a replayed message does not consume a second attribute slot, and an
  // `xray`-only send cannot leave a *stale* `traceparent` behind — extraction
  // prefers W3C, so a leftover attribute from an earlier hop would be read in
  // preference to the fresh header this call is writing.
  for (const name of [TRACEPARENT_ATTRIBUTE, TRACESTATE_ATTRIBUTE, BAGGAGE_ATTRIBUTE]) {
    for (const key of Object.keys(existing)) {
      if (key.toLowerCase() === name) delete existing[key];
    }
  }

  const businessCount = Object.keys(existing).length;
  const wanted: { readonly name: string; readonly value: string }[] = [];

  if (format === 'w3c' || format === 'both') {
    wanted.push({ name: TRACEPARENT_ATTRIBUTE, value: formatTraceparent(context) });
    if (context.traceState !== undefined) {
      wanted.push({ name: TRACESTATE_ATTRIBUTE, value: context.traceState });
    }
    if (options.baggage !== undefined) {
      wanted.push({ name: BAGGAGE_ATTRIBUTE, value: options.baggage });
    }
  }

  const available = SQS_MAX_MESSAGE_ATTRIBUTES - businessCount;
  if ((format === 'w3c' || format === 'both') && available < 1) {
    throw new Error(
      `Cannot propagate trace context: the message already carries ${businessCount} of SQS's ` +
        `${SQS_MAX_MESSAGE_ATTRIBUTES} message attributes, leaving no slot for \`traceparent\`. ` +
        'Move business attributes into the body — trace context cannot go there, because FIFO ' +
        'content-based deduplication hashes the body. See docs/queue-tracing.md §3.',
    );
  }

  const kept = wanted.slice(0, Math.max(available, 0));
  const dropped = wanted.slice(kept.length).map((entry) => entry.name);

  const attributes: Record<string, MessageAttributeValue> = { ...existing };
  for (const entry of kept) attributes[entry.name] = stringAttribute(entry.value);

  // `MessageAttributes` is rebuilt rather than merged over the original, so the
  // stale-context removal above actually reaches the returned message. Spreading
  // the input and then adding a key would leave the original map in place
  // whenever this call writes no W3C attributes at all.
  const result: OutboundMessage = {
    ...message,
    MessageAttributes: attributes,
    // The system attribute is a reserved slot and costs nothing from the budget
    // above, which is why the X-Ray half is never the half that gets dropped.
    ...(format === 'xray' || format === 'both'
      ? {
          MessageSystemAttributes: {
            ...(message.MessageSystemAttributes ?? {}),
            [XRAY_SYSTEM_ATTRIBUTE]: stringAttribute(formatXRayHeader(context)),
          },
        }
      : {}),
  };

  return { message: result, dropped };
};

/* ── Extraction ───────────────────────────────────────────────────────────── */

/** Where a consumer found the context it is about to use. */
export type ContextSource =
  | 'message-attribute'
  | 'sns-envelope'
  | 'system-attribute'
  | 'none';

/** The outcome of reading context off a received message. */
export interface ExtractionResult {
  readonly context?: TraceContext;
  readonly source: ContextSource;
  /**
   * Why no context was found, when none was.
   *
   * Worth logging rather than counting alone: "the header was there and did not
   * parse" and "there was no header" have different causes and different fixes,
   * and a single `trace_context_missing` counter cannot tell you which you have.
   */
  readonly reason?: 'absent' | 'malformed' | 'not-requested';
}

/** The SNS envelope fields that appear in a non-raw delivery to SQS. */
interface SnsEnvelope {
  readonly Type?: unknown;
  readonly TopicArn?: unknown;
  readonly MessageAttributes?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The message attributes of an SNS envelope, when the body is one.
 *
 * SNS → SQS without `RawMessageDelivery` wraps the payload in a notification
 * envelope, and the publisher's message attributes go **inside** it. The SQS
 * message's own `MessageAttributes` are then empty, so a consumer that reads
 * only those finds nothing — on a topic that is correctly publishing context,
 * through a subscription that is correctly delivering it. There is no error
 * anywhere. `validateQueuePropagation` refuses the combination for that reason;
 * this exists so a consumer reading an existing non-raw subscription still
 * works rather than silently losing every trace while the subscription is
 * fixed.
 *
 * SNS's envelope shape differs from SQS's: `{Type, Value}` rather than
 * `{DataType, StringValue}`.
 */
const snsEnvelopeAttributes = (body: string | undefined): MessageAttributeMap | undefined => {
  if (body === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  const envelope = parsed as SnsEnvelope;
  if (envelope.Type !== 'Notification' || typeof envelope.TopicArn !== 'string') return undefined;
  if (!isRecord(envelope.MessageAttributes)) return undefined;

  const attributes: Record<string, MessageAttributeValue> = {};
  for (const [name, value] of Object.entries(envelope.MessageAttributes)) {
    if (!isRecord(value)) continue;
    const type = typeof value.Type === 'string' ? value.Type : 'String';
    if (typeof value.Value === 'string') {
      attributes[name] = { DataType: type, StringValue: value.Value };
    }
  }
  return attributes;
};

/**
 * Read trace context off a received message.
 *
 * The carriers are tried in the order that preserves the most information:
 * W3C message attributes first (full 128-bit id plus `tracestate`), then the
 * SNS envelope, then the X-Ray system attribute. The X-Ray header is last
 * because it carries no `tracestate`, not because it is less trustworthy — the
 * ids are the same ids.
 *
 * A carrier that is present but unparseable does not end the search — the next
 * one is still tried. A producer writing both formats and an intermediary that
 * mangles one of them is a real combination, and falling back to the X-Ray
 * header there keeps the trace whole. `malformed` is reported only when nothing
 * else worked, so it says "the context that was there was unusable" rather than
 * "the first thing I looked at was unusable".
 *
 * `systemAttributesRequested` is the caller telling this function whether the
 * receive call asked for `AWSTraceHeader`. It changes nothing about the result
 * and everything about the diagnosis: without it, a worker whose receive call
 * forgot the parameter reports `absent`, which sends whoever investigates to
 * the producer — the one place where nothing is wrong.
 */
export const extractTraceContext = (
  message: ReceivedMessage,
  options: { readonly systemAttributesRequested?: boolean } = {},
): ExtractionResult => {
  const systemAttributesRequested = options.systemAttributesRequested ?? true;
  let sawMalformed = false;

  const fromW3c = (
    attributes: MessageAttributeMap | undefined,
    source: ContextSource,
  ): ExtractionResult | undefined => {
    const raw = attributeValue(attributes, TRACEPARENT_ATTRIBUTE);
    if (raw === undefined) return undefined;
    const context = parseTraceparent(raw);
    if (context === undefined) {
      sawMalformed = true;
      return undefined;
    }
    const traceState = attributeValue(attributes, TRACESTATE_ATTRIBUTE);
    return {
      context: traceState === undefined ? context : { ...context, traceState },
      source,
    };
  };

  const direct = fromW3c(message.MessageAttributes, 'message-attribute');
  if (direct !== undefined) return direct;

  const envelope = fromW3c(snsEnvelopeAttributes(message.Body), 'sns-envelope');
  if (envelope !== undefined) return envelope;

  const system = message.Attributes?.[XRAY_SYSTEM_ATTRIBUTE];
  if (system !== undefined) {
    const context = parseXRayHeader(system);
    if (context !== undefined) return { context, source: 'system-attribute' };
    sawMalformed = true;
  }

  if (sawMalformed) return { source: 'none', reason: 'malformed' };

  return {
    source: 'none',
    reason: systemAttributesRequested ? 'absent' : 'not-requested',
  };
};

/* ── Parent or link ───────────────────────────────────────────────────────── */

/** How a consumer span should relate to the context it extracted. */
export type SpanRelationship = 'parent' | 'link';

/** {@link propagationDecision}'s answer, with the reason it reached it. */
export interface PropagationDecision {
  readonly relationship: SpanRelationship;
  readonly reason: 'within-decision-window' | 'dwell-exceeded' | 'redelivered' | 'unsampled-parent';
  /** How long the message waited, in milliseconds. Negative clock skew is clamped. */
  readonly dwellMs: number;
}

/** Everything the decision depends on, all of it available at receive time. */
export interface PropagationDecisionInput {
  /** `SentTimestamp`, in epoch milliseconds — SQS returns it as a string. */
  readonly sentAtMs: number;
  /** When the consumer received the message, in epoch milliseconds. */
  readonly receivedAtMs: number;
  /** `ApproximateReceiveCount`. 1 on first delivery. */
  readonly approximateReceiveCount: number;
  /** The collector's `decisionWaitSeconds`. See the header comment. */
  readonly decisionWaitSeconds: number;
  /** Whether the producer sampled the trace. */
  readonly parentSampled: boolean;
}

/**
 * Decide whether a consumer span continues the producer's trace or starts a new
 * one linked to it.
 *
 * Four cases, in the order they are checked:
 *
 *   • **The producer did not sample.** A child of an unsampled parent is
 *     unsampled too under `parentbased_*`, which is correct and also means the
 *     worker's work is invisible. Linking gives the consumer's own sampler a
 *     say, and the link still names the parent for anyone who goes looking.
 *   • **Redelivered.** A second attempt is separated from the first by at least
 *     the visibility timeout and possibly by a dead-letter redrive days later.
 *     The original trace is long decided; a child of it is a span written into
 *     a trace nothing will ever read.
 *   • **Dwell past the decision window.** The case this whole module is
 *     arranged around.
 *   • Otherwise the producer's trace is still open, and a child is exactly
 *     right.
 *
 * Clock skew is clamped rather than trusted: `SentTimestamp` is SQS's clock and
 * `receivedAtMs` is the consumer's, and a consumer running a few hundred
 * milliseconds behind would otherwise compute a negative dwell and take the
 * within-window branch for every message regardless of how long it actually
 * waited.
 */
export const propagationDecision = (input: PropagationDecisionInput): PropagationDecision => {
  const dwellMs = Math.max(0, input.receivedAtMs - input.sentAtMs);

  if (!input.parentSampled) return { relationship: 'link', reason: 'unsampled-parent', dwellMs };
  if (input.approximateReceiveCount > 1) {
    return { relationship: 'link', reason: 'redelivered', dwellMs };
  }
  if (dwellMs >= input.decisionWaitSeconds * 1_000) {
    return { relationship: 'link', reason: 'dwell-exceeded', dwellMs };
  }

  return { relationship: 'parent', reason: 'within-decision-window', dwellMs };
};

/* ── Configuration, and the shapes that deploy cleanly and trace nothing ──── */

/** What consumes the queue. The two have different failure modes. */
export type QueueConsumer = 'lambda' | 'ecs-poller';

/** One API → queue → worker path, as data with no CDK token in it. */
export interface QueuePropagationSpec {
  /** Queue name, used only in error messages. */
  readonly queueName: string;
  /** Which wire formats the producer writes. */
  readonly format: PropagationFormat;
  /** What consumes it. */
  readonly consumer: QueueConsumer;
  /**
   * Whether the consumer's `ReceiveMessage` (or event source mapping) asks for
   * `AWSTraceHeader` by name. Ignored for a `w3c`-only path.
   */
  readonly requestsSystemAttributes: boolean;
  /**
   * Business message attributes the producer sends at most, excluding context.
   *
   * The count that matters is the maximum across every message shape, not the
   * typical one: the limit is per message and the message carrying the most
   * attributes is the one that fails.
   */
  readonly businessAttributeCount: number;
  /** Producer's own attribute names, checked for case and reserved prefixes. */
  readonly attributeNames?: readonly string[];
  /** True when an SNS topic fans into this queue. */
  readonly viaSnsTopic?: boolean;
  /** `RawMessageDelivery` on that subscription. Required when `viaSnsTopic`. */
  readonly snsRawMessageDelivery?: boolean;
  /** Trace context written into the message body. Always wrong; see below. */
  readonly contextInBody?: boolean;
  /** Event source mapping batch size, for a Lambda consumer. */
  readonly batchSize?: number;
  /**
   * Whether the consumer opens a span per message rather than per batch.
   *
   * Only meaningful above a batch size of one, where it is the difference
   * between ten traces and one trace with ten unrelated things in it.
   */
  readonly perMessageContext?: boolean;
  /** The consumer's `OTEL_TRACES_SAMPLER`. */
  readonly consumerSampler: string;
  /** The collector's `decisionWaitSeconds` for this environment. */
  readonly decisionWaitSeconds: number;
  /**
   * Queue age, in seconds, at which the dwell alarm fires.
   *
   * Must be **below** the decision window: the alarm exists to say "traces are
   * about to start arriving after they are decided", and one that fires at or
   * after the window says it instead about traces already lost.
   */
  readonly dwellAlarmSeconds: number;
  /** Visibility timeout, in seconds. */
  readonly visibilityTimeoutSeconds: number;
  /** `maxReceiveCount` before the message is dead-lettered. */
  readonly maxReceiveCount: number;
}

/** Samplers that defer to the incoming context. Anything else splits traces. */
const PARENT_BASED_SAMPLERS = [
  'parentbased_always_on',
  'parentbased_always_off',
  'parentbased_traceidratio',
  'parentbased_jaeger_remote',
] as const;

/**
 * Reject a propagation configuration that deploys, runs and traces nothing.
 *
 * Throws rather than collecting findings, for the same reason
 * `validateSamplingSpec` does: this runs inside `cdk synth`, so the build
 * should fail at the line that caused it. Every message names both halves of
 * the disagreement, because in each case either one could be the one to change.
 *
 * Every rule here is a configuration AWS accepts. None of them produces an
 * error, a failed deploy or a red metric — the queue delivers, the worker
 * processes, the dashboards are green, and the traces are wrong.
 */
export const validateQueuePropagation = (spec: QueuePropagationSpec): void => {
  const fail = (message: string): never => {
    throw new Error(`${spec.queueName}: ${message}`);
  };

  /* Carrier: the body is never one. ------------------------------------- */
  if (spec.contextInBody === true) {
    fail(
      'trace context is written into the message body. FIFO content-based deduplication hashes ' +
        'the body, so two sends of an otherwise identical message carry different trace ids and ' +
        'are no longer duplicates — deduplication stops deduplicating with no error and no ' +
        'metric, and the symptom is duplicate work. Context belongs in message attributes ' +
        '(W3C) or the AWSTraceHeader system attribute (X-Ray).',
    );
  }

  /* Carrier: the SNS envelope swallows message attributes. ---------------- */
  if (spec.viaSnsTopic === true) {
    if (spec.snsRawMessageDelivery === undefined) {
      fail('viaSnsTopic is set but snsRawMessageDelivery is not — state it explicitly.');
    }
    if (spec.snsRawMessageDelivery === false && spec.format !== 'xray') {
      fail(
        'an SNS subscription with RawMessageDelivery disabled carries the publisher\'s message ' +
          'attributes *inside* the notification envelope, so the SQS message\'s own ' +
          'MessageAttributes arrive empty and a consumer reading `traceparent` finds nothing. ' +
          'Both halves look correct in the console. Enable RawMessageDelivery, or propagate ' +
          'X-Ray only — SNS copies AWSTraceHeader into the system attribute either way.',
      );
    }
  }

  /* Carrier: the system attribute has to be asked for. -------------------- */
  if (
    (spec.format === 'xray' || spec.format === 'both') &&
    spec.consumer === 'ecs-poller' &&
    !spec.requestsSystemAttributes
  ) {
    fail(
      'the X-Ray context travels in the AWSTraceHeader *system* attribute, and ReceiveMessage ' +
        'returns system attributes only when they are named in MessageSystemAttributeNames. ' +
        'This consumer does not name it, so the field is simply absent from every message — ' +
        'not an error, not a warning, just a new trace per message. (A Lambda event source ' +
        'mapping populates `record.attributes` without being asked, which is why this is ' +
        'checked for pollers only.)',
    );
  }

  /* Budget: ten attributes, enforced at SendMessage. ---------------------- */
  const contextSlots = spec.format === 'xray' ? 0 : 1;
  const total = spec.businessAttributeCount + contextSlots;
  if (total > SQS_MAX_MESSAGE_ATTRIBUTES) {
    fail(
      `${spec.businessAttributeCount} business message attribute(s) plus ${contextSlots} for ` +
        `trace context is ${total}, over SQS's limit of ${SQS_MAX_MESSAGE_ATTRIBUTES}. ` +
        'SendMessage rejects the call, but only for the message shapes that carry every ' +
        'optional attribute — which is never the shape a test sends. Move business attributes ' +
        'into the body; trace context cannot follow them there.',
    );
  }

  /* Naming: case-sensitive keys, reserved prefixes. ----------------------- */
  for (const name of spec.attributeNames ?? []) {
    const lower = name.toLowerCase();
    for (const prefix of RESERVED_ATTRIBUTE_PREFIXES) {
      if (lower.startsWith(prefix)) {
        fail(
          `message attribute \`${name}\` uses the reserved \`${prefix}\` prefix, which SQS ` +
            'refuses at SendMessage.',
        );
      }
    }
    if ([TRACEPARENT_ATTRIBUTE, TRACESTATE_ATTRIBUTE, BAGGAGE_ATTRIBUTE].includes(lower) && name !== lower) {
      fail(
        `message attribute \`${name}\` is the W3C \`${lower}\` header with different casing. ` +
          'SQS attribute names are case-sensitive, so a consumer matching the lowercase name ' +
          'reads past it and starts a new trace for every message.',
      );
    }
  }

  /* Batching: one span over ten unrelated messages. ----------------------- */
  const batchSize = spec.batchSize ?? 1;
  if (batchSize > 1 && spec.perMessageContext !== true) {
    fail(
      `the consumer takes batches of ${batchSize} but opens no span per message. Lambda's own ` +
        '`_X_AMZN_TRACE_ID` is the trace of the *poller invocation*, not of any message in the ' +
        'batch, so every message is attributed to whichever trace happened to trigger the poll ' +
        '— which is a real trace, so the result reads as working. Extract per record and parent ' +
        'or link each one.',
    );
  }

  /* Sampling: a consumer that decides for itself halves every trace. ------ */
  if (!PARENT_BASED_SAMPLERS.includes(spec.consumerSampler as (typeof PARENT_BASED_SAMPLERS)[number])) {
    fail(
      `the consumer's OTEL_TRACES_SAMPLER is \`${spec.consumerSampler}\`, which decides without ` +
        'reference to the incoming context. The producer and the consumer then sample the same ' +
        'trace independently, so most traces keep one half and drop the other and the backend ' +
        `shows a fleet of fragments. Use one of: ${PARENT_BASED_SAMPLERS.join(', ')}.`,
    );
  }

  /* Timing: the alarm has to precede the loss. ---------------------------- */
  if (spec.dwellAlarmSeconds >= spec.decisionWaitSeconds) {
    fail(
      `the dwell alarm fires at ${spec.dwellAlarmSeconds}s but the collector decides a trace ` +
        `${spec.decisionWaitSeconds}s after its first span. An alarm at or after the decision ` +
        'window reports traces that have already been decided on their producer half — it is a ' +
        'record of the loss rather than a warning of it. Set it below the window.',
    );
  }

  if (spec.visibilityTimeoutSeconds <= 0) {
    fail(`visibilityTimeoutSeconds must be positive, got ${spec.visibilityTimeoutSeconds}.`);
  }
  if (spec.maxReceiveCount < 1) {
    fail(`maxReceiveCount must be at least 1, got ${spec.maxReceiveCount}.`);
  }
};

/* ── The signal that propagation broke ────────────────────────────────────── */

/**
 * The structured event a worker logs when it could not find context.
 *
 * Every failure in this file is silent by construction — a worker with no
 * parent context does exactly what a worker at the start of a trace does — so
 * the only way to know is for the consumer to say so. `TracedQueueStack` puts a
 * metric filter on this event and alarms on it, which is what turns a class of
 * invisible bugs into a page.
 *
 * `event` is a fixed literal because a metric filter matches on it verbatim,
 * and a filter pattern and the string it matches are edited in different files.
 * `test/queue-trace-context.test.ts` pins them together.
 */
export const TRACE_CONTEXT_MISSING_EVENT = 'trace_context_missing';

/** The event logged when the attribute budget forced context to be dropped. */
export const TRACE_CONTEXT_TRUNCATED_EVENT = 'trace_context_truncated';

/** A JSON log line reporting that a message arrived with no usable context. */
export const traceContextMissingLog = (options: {
  readonly queueName: string;
  readonly messageId: string;
  readonly reason: NonNullable<ExtractionResult['reason']>;
}): string =>
  JSON.stringify({
    event: TRACE_CONTEXT_MISSING_EVENT,
    queue: options.queueName,
    message_id: options.messageId,
    reason: options.reason,
  });

/** A JSON log line reporting attributes given up to the ten-attribute limit. */
export const traceContextTruncatedLog = (options: {
  readonly queueName: string;
  readonly dropped: readonly string[];
}): string =>
  JSON.stringify({
    event: TRACE_CONTEXT_TRUNCATED_EVENT,
    queue: options.queueName,
    dropped: [...options.dropped],
  });

/**
 * Span attribute carrying how long a message waited, in milliseconds.
 *
 * Not a semantic convention: OpenTelemetry's messaging conventions have no
 * queue-time attribute, and squatting on the `messaging.` namespace with one
 * would collide the day they add it. `aws.sqs.` is this repository's, so it
 * cannot. The value matters because without it the gap between the producer
 * span ending and the consumer span starting is unattributed — the trace shows
 * eleven seconds of nothing, and nothing in it says the eleven seconds were
 * spent in a queue rather than in an untraced service.
 */
export const QUEUE_TIME_ATTRIBUTE = 'aws.sqs.queue_time_ms';
