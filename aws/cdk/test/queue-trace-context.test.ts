import {
  BAGGAGE_ATTRIBUTE,
  MessageAttributeMap,
  QUEUE_TIME_ATTRIBUTE,
  QueuePropagationSpec,
  RESERVED_ATTRIBUTE_PREFIXES,
  SQS_MAX_MESSAGE_ATTRIBUTES,
  TRACEPARENT_ATTRIBUTE,
  TRACESTATE_ATTRIBUTE,
  TRACE_CONTEXT_MISSING_EVENT,
  TRACE_CONTEXT_TRUNCATED_EVENT,
  TraceContext,
  XRAY_SYSTEM_ATTRIBUTE,
  extractTraceContext,
  formatTraceparent,
  formatXRayHeader,
  injectTraceContext,
  parseTraceparent,
  parseXRayHeader,
  propagationDecision,
  traceContextMissingLog,
  traceContextTruncatedLog,
  validateQueuePropagation,
} from '../lib/queue-trace-context';

/**
 * Tests for the propagation contract.
 *
 * Every case here is a message that is delivered, a worker that runs, and a
 * pipeline whose metrics are perfect. What differs is whether the trace joins
 * up, which no part of AWS reports on. The rule-by-rule block at the bottom is
 * the important half: each of those configurations deploys cleanly.
 */

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

const sampled: TraceContext = { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true };
const unsampled: TraceContext = { ...sampled, sampled: false };

const attributes = (entries: Record<string, string>): MessageAttributeMap =>
  Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [
      name,
      { DataType: 'String', StringValue: value },
    ]),
  );

/** N business attributes with names that are not ours and not reserved. */
const businessAttributes = (count: number): MessageAttributeMap =>
  attributes(
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`attribute-${index}`, String(index)]),
    ),
  );

/** A configuration with nothing wrong with it. Every rule case mutates it. */
const healthy = (overrides: Partial<QueuePropagationSpec> = {}): QueuePropagationSpec => ({
  queueName: 'production-orders',
  format: 'both',
  consumer: 'ecs-poller',
  requestsSystemAttributes: true,
  businessAttributeCount: 2,
  consumerSampler: 'parentbased_always_on',
  decisionWaitSeconds: 30,
  dwellAlarmSeconds: 15,
  visibilityTimeoutSeconds: 30,
  maxReceiveCount: 5,
  ...overrides,
});

describe('the W3C wire format', () => {
  it('round-trips a sampled context', () => {
    expect(formatTraceparent(sampled)).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(parseTraceparent(formatTraceparent(sampled))).toEqual(sampled);
  });

  it('carries the sampling bit, which is the half that decides what is kept', () => {
    expect(formatTraceparent(unsampled)).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`);
    expect(parseTraceparent(formatTraceparent(unsampled))?.sampled).toBe(false);
  });

  it('reads a version it does not know, because a newer one still starts this way', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-extra`)?.traceId).toBe(TRACE_ID);
  });

  it('refuses version ff, which the specification forbids outright', () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeUndefined();
  });

  // An SDK emitting the all-zero id is telling you the context it had was
  // empty. Accepting it produces one trace that every service is part of.
  it('refuses the all-zero trace and span ids', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeUndefined();
  });

  it('refuses uppercase hex, truncated fields and missing fields', () => {
    expect(parseTraceparent(`00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE_ID.slice(0, 30)}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}`)).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
  });
});

describe('the X-Ray wire format', () => {
  // The two schemes are the same 128 bits with a different separator, which is
  // the only reason a half-OTel, half-X-Ray fleet can produce one trace.
  it('is the same identifier, split after the first eight hex characters', () => {
    expect(formatXRayHeader(sampled)).toBe(
      `Root=1-4bf92f35-77b34da6a3ce929d0e0e4736;Parent=${SPAN_ID};Sampled=1`,
    );
    expect(parseXRayHeader(formatXRayHeader(sampled))).toEqual(sampled);
    expect(parseXRayHeader(formatXRayHeader(unsampled))).toEqual(unsampled);
  });

  it('reads the fields by name, since their order is not guaranteed', () => {
    expect(
      parseXRayHeader(`Sampled=1;Parent=${SPAN_ID};Root=1-4bf92f35-77b34da6a3ce929d0e0e4736`),
    ).toEqual(sampled);
  });

  it('ignores the arbitrary pairs an intermediary may have added', () => {
    expect(
      parseXRayHeader(
        `Root=1-4bf92f35-77b34da6a3ce929d0e0e4736;Parent=${SPAN_ID};Sampled=1;Lineage=1:abc:0`,
      ),
    ).toEqual(sampled);
  });

  // An edge-generated id before any segment exists. The trace is real; the
  // parent span is not, and discarding the trace along with it would root the
  // worker's span under a trace of its own for no reason.
  it('keeps the trace when there is no Parent field', () => {
    const context = parseXRayHeader('Root=1-4bf92f35-77b34da6a3ce929d0e0e4736;Sampled=1');
    expect(context?.traceId).toBe(TRACE_ID);
    expect(context?.spanId).toBe('0'.repeat(16));
  });

  it('refuses a root that is not a version-1 X-Ray id', () => {
    expect(parseXRayHeader('Root=2-4bf92f35-77b34da6a3ce929d0e0e4736')).toBeUndefined();
    expect(parseXRayHeader('Root=1-4bf92f35')).toBeUndefined();
    expect(parseXRayHeader('Parent=00f067aa0ba902b7;Sampled=1')).toBeUndefined();
    expect(parseXRayHeader(undefined)).toBeUndefined();
  });
});

describe('injecting context into an outbound message', () => {
  it('writes both carriers by default', () => {
    const { message, dropped } = injectTraceContext({}, sampled);

    expect(message.MessageAttributes?.[TRACEPARENT_ATTRIBUTE].StringValue).toBe(
      formatTraceparent(sampled),
    );
    expect(message.MessageSystemAttributes?.[XRAY_SYSTEM_ATTRIBUTE].StringValue).toBe(
      formatXRayHeader(sampled),
    );
    expect(dropped).toEqual([]);
  });

  it('leaves business attributes alone', () => {
    const { message } = injectTraceContext(
      { MessageAttributes: attributes({ orderId: 'ord-1', tenant: 'acme' }) },
      sampled,
    );

    expect(message.MessageAttributes?.orderId.StringValue).toBe('ord-1');
    expect(message.MessageAttributes?.tenant.StringValue).toBe('acme');
  });

  // The limit is per message and it is enforced at SendMessage, so the shape
  // that fails is the one carrying every optional attribute — never the shape a
  // test sends.
  it('gives up baggage first, then tracestate, and never traceparent', () => {
    const { message, dropped } = injectTraceContext(
      { MessageAttributes: businessAttributes(SQS_MAX_MESSAGE_ATTRIBUTES - 1) },
      { ...sampled, traceState: 'vendor=abc' },
      { baggage: 'tenant=acme' },
    );

    expect(dropped).toEqual([TRACESTATE_ATTRIBUTE, BAGGAGE_ATTRIBUTE]);
    expect(message.MessageAttributes?.[TRACEPARENT_ATTRIBUTE]).toBeDefined();
    expect(Object.keys(message.MessageAttributes ?? {})).toHaveLength(
      SQS_MAX_MESSAGE_ATTRIBUTES,
    );
  });

  it('refuses to produce an untraced message when even traceparent will not fit', () => {
    expect(() =>
      injectTraceContext(
        { MessageAttributes: businessAttributes(SQS_MAX_MESSAGE_ATTRIBUTES) },
        sampled,
      ),
    ).toThrow(/no slot for `traceparent`/);
  });

  // The system attribute is reserved and costs nothing from the budget, which
  // is why the X-Ray half is never the half that gets dropped.
  it('still propagates X-Ray with all ten user attributes taken', () => {
    const { message, dropped } = injectTraceContext(
      { MessageAttributes: businessAttributes(SQS_MAX_MESSAGE_ATTRIBUTES) },
      sampled,
      { format: 'xray' },
    );

    expect(dropped).toEqual([]);
    expect(message.MessageSystemAttributes?.[XRAY_SYSTEM_ATTRIBUTE].StringValue).toBe(
      formatXRayHeader(sampled),
    );
  });

  it('replaces context already on the message rather than taking a second slot', () => {
    const older: TraceContext = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };
    const { message } = injectTraceContext(
      { MessageAttributes: injectTraceContext({}, older).message.MessageAttributes },
      sampled,
    );

    expect(Object.keys(message.MessageAttributes ?? {})).toEqual([TRACEPARENT_ATTRIBUTE]);
    expect(message.MessageAttributes?.[TRACEPARENT_ATTRIBUTE].StringValue).toContain(TRACE_ID);
  });

  // Extraction prefers W3C, so a leftover attribute from an earlier hop would
  // be read in preference to the fresh X-Ray header this call writes.
  it('clears a stale traceparent even when writing X-Ray only', () => {
    const { message } = injectTraceContext(
      { MessageAttributes: attributes({ [TRACEPARENT_ATTRIBUTE]: `00-${'a'.repeat(32)}-${SPAN_ID}-01` }) },
      sampled,
      { format: 'xray' },
    );

    expect(message.MessageAttributes?.[TRACEPARENT_ATTRIBUTE]).toBeUndefined();
    expect(extractTraceContext(message as never).context).toBeUndefined();
  });
});

describe('extracting context from a received message', () => {
  it('reads a message attribute, with tracestate', () => {
    const result = extractTraceContext({
      MessageAttributes: attributes({
        [TRACEPARENT_ATTRIBUTE]: formatTraceparent(sampled),
        [TRACESTATE_ATTRIBUTE]: 'vendor=abc',
      }),
    });

    expect(result.source).toBe('message-attribute');
    expect(result.context).toEqual({ ...sampled, traceState: 'vendor=abc' });
  });

  // HTTP header names are not case-sensitive and SQS attribute names are, so a
  // bridge that title-cases what it copies produces `Traceparent` — and a
  // consumer matching exactly starts a new trace for every message, forever.
  it('matches the attribute name case-insensitively', () => {
    const result = extractTraceContext({
      MessageAttributes: attributes({ TraceParent: formatTraceparent(sampled) }),
    });

    expect(result.source).toBe('message-attribute');
    expect(result.context?.traceId).toBe(TRACE_ID);
  });

  it('reads the X-Ray system attribute', () => {
    const result = extractTraceContext({
      Attributes: { [XRAY_SYSTEM_ATTRIBUTE]: formatXRayHeader(sampled) },
    });

    expect(result.source).toBe('system-attribute');
    expect(result.context).toEqual(sampled);
  });

  // SNS without RawMessageDelivery moves the publisher's attributes inside the
  // notification envelope, leaving the SQS message's own MessageAttributes
  // empty. Both halves look correct in the console.
  it('reaches into an SNS envelope when the subscription is not raw', () => {
    const result = extractTraceContext({
      Body: JSON.stringify({
        Type: 'Notification',
        MessageId: 'mock-message-id',
        TopicArn: 'arn:aws:sns:us-east-1:123456789012:orders',
        Message: '{"orderId":"ord-1"}',
        MessageAttributes: {
          [TRACEPARENT_ATTRIBUTE]: { Type: 'String', Value: formatTraceparent(sampled) },
        },
      }),
    });

    expect(result.source).toBe('sns-envelope');
    expect(result.context).toEqual(sampled);
  });

  it('does not mistake an ordinary JSON body for an envelope', () => {
    const result = extractTraceContext({
      Body: JSON.stringify({ Type: 'Notification', MessageAttributes: {} }),
    });

    expect(result.context).toBeUndefined();
    expect(result.reason).toBe('absent');
  });

  it('survives a body that is not JSON at all', () => {
    expect(extractTraceContext({ Body: 'not json' }).reason).toBe('absent');
  });

  // A producer writing both formats and an intermediary mangling one of them is
  // a real combination; falling through keeps the trace whole.
  it('falls through to X-Ray when the W3C attribute is unparseable', () => {
    const result = extractTraceContext({
      MessageAttributes: attributes({ [TRACEPARENT_ATTRIBUTE]: 'garbage' }),
      Attributes: { [XRAY_SYSTEM_ATTRIBUTE]: formatXRayHeader(sampled) },
    });

    expect(result.source).toBe('system-attribute');
    expect(result.context).toEqual(sampled);
  });

  it('reports malformed only when nothing else worked', () => {
    expect(
      extractTraceContext({
        MessageAttributes: attributes({ [TRACEPARENT_ATTRIBUTE]: 'garbage' }),
      }).reason,
    ).toBe('malformed');
  });

  // "Nobody sent one" and "nobody asked for it" are indistinguishable from
  // inside the consumer, and they send whoever investigates to opposite ends of
  // the system.
  it('distinguishes an absent header from a receive call that never asked', () => {
    expect(extractTraceContext({}).reason).toBe('absent');
    expect(extractTraceContext({}, { systemAttributesRequested: false }).reason).toBe(
      'not-requested',
    );
  });

  it('round-trips what injectTraceContext wrote', () => {
    const { message } = injectTraceContext(
      { MessageAttributes: attributes({ orderId: 'ord-1' }) },
      sampled,
    );

    const received = {
      MessageAttributes: message.MessageAttributes,
      Attributes: {
        [XRAY_SYSTEM_ATTRIBUTE]:
          message.MessageSystemAttributes?.[XRAY_SYSTEM_ATTRIBUTE].StringValue ?? '',
      },
    };

    expect(extractTraceContext(received).context).toEqual(sampled);
  });
});

describe('parent or link', () => {
  const base = {
    sentAtMs: 1_000_000,
    approximateReceiveCount: 1,
    decisionWaitSeconds: 30,
    parentSampled: true,
  };

  it('parents a message picked up inside the decision window', () => {
    const decision = propagationDecision({ ...base, receivedAtMs: base.sentAtMs + 5_000 });

    expect(decision.relationship).toBe('parent');
    expect(decision.reason).toBe('within-decision-window');
    expect(decision.dwellMs).toBe(5_000);
  });

  // The case the whole module is arranged around: the sampler has already
  // decided and exported this trace, so a child span is written into a trace
  // nothing will read.
  it('links once dwell reaches the decision window', () => {
    const decision = propagationDecision({ ...base, receivedAtMs: base.sentAtMs + 30_000 });

    expect(decision.relationship).toBe('link');
    expect(decision.reason).toBe('dwell-exceeded');
  });

  it('links a redelivery, however quickly it came back', () => {
    const decision = propagationDecision({
      ...base,
      receivedAtMs: base.sentAtMs + 100,
      approximateReceiveCount: 2,
    });

    expect(decision.relationship).toBe('link');
    expect(decision.reason).toBe('redelivered');
  });

  // A child of an unsampled parent is unsampled under parentbased_*, which is
  // correct and also means the worker's work is invisible. A link gives the
  // consumer's own sampler a say and still names the parent.
  it('links an unsampled parent so the work is not invisible', () => {
    const decision = propagationDecision({
      ...base,
      receivedAtMs: base.sentAtMs + 100,
      parentSampled: false,
    });

    expect(decision.relationship).toBe('link');
    expect(decision.reason).toBe('unsampled-parent');
  });

  // SentTimestamp is SQS's clock and receivedAtMs is the consumer's. A consumer
  // running behind would otherwise compute a negative dwell and take the
  // within-window branch regardless of how long the message actually waited.
  it('clamps clock skew rather than trusting it', () => {
    const decision = propagationDecision({ ...base, receivedAtMs: base.sentAtMs - 500 });

    expect(decision.dwellMs).toBe(0);
    expect(decision.relationship).toBe('parent');
  });
});

describe('the configurations that deploy cleanly and trace nothing', () => {
  it('accepts a configuration with nothing wrong with it', () => {
    expect(() => validateQueuePropagation(healthy())).not.toThrow();
  });

  it('accepts a raw SNS subscription', () => {
    expect(() =>
      validateQueuePropagation(healthy({ viaSnsTopic: true, snsRawMessageDelivery: true })),
    ).not.toThrow();
  });

  it('refuses trace context in the body, which defeats FIFO deduplication', () => {
    expect(() => validateQueuePropagation(healthy({ contextInBody: true }))).toThrow(
      /deduplication stops deduplicating/,
    );
  });

  it('refuses a non-raw SNS subscription carrying W3C context', () => {
    expect(() =>
      validateQueuePropagation(healthy({ viaSnsTopic: true, snsRawMessageDelivery: false })),
    ).toThrow(/notification envelope/);
  });

  // X-Ray is copied into the system attribute either way, so the one
  // combination the envelope does not break is the one this allows.
  it('allows a non-raw SNS subscription that propagates X-Ray only', () => {
    expect(() =>
      validateQueuePropagation(
        healthy({ format: 'xray', viaSnsTopic: true, snsRawMessageDelivery: false }),
      ),
    ).not.toThrow();
  });

  it('insists the SNS delivery mode is stated rather than assumed', () => {
    expect(() => validateQueuePropagation(healthy({ viaSnsTopic: true }))).toThrow(
      /state it explicitly/,
    );
  });

  it('refuses a poller that never asks for the AWSTraceHeader system attribute', () => {
    expect(() => validateQueuePropagation(healthy({ requestsSystemAttributes: false }))).toThrow(
      /MessageSystemAttributeNames/,
    );
  });

  // A Lambda event source mapping populates `record.attributes` without being
  // asked, which is why the rule above is scoped to pollers.
  it('does not require it of a Lambda consumer', () => {
    expect(() =>
      validateQueuePropagation(
        healthy({ consumer: 'lambda', requestsSystemAttributes: false }),
      ),
    ).not.toThrow();
  });

  it('refuses a producer that has no attribute slot left for context', () => {
    expect(() =>
      validateQueuePropagation(healthy({ businessAttributeCount: SQS_MAX_MESSAGE_ATTRIBUTES })),
    ).toThrow(/over SQS's limit of 10/);
  });

  it('allows all ten business attributes when only X-Ray is propagated', () => {
    expect(() =>
      validateQueuePropagation(
        healthy({ format: 'xray', businessAttributeCount: SQS_MAX_MESSAGE_ATTRIBUTES }),
      ),
    ).not.toThrow();
  });

  it.each(RESERVED_ATTRIBUTE_PREFIXES)('refuses the reserved %s prefix', (prefix) => {
    expect(() =>
      validateQueuePropagation(healthy({ attributeNames: [`${prefix}orderId`] })),
    ).toThrow(/reserved/);
  });

  it('refuses a miscased copy of one of the W3C names', () => {
    expect(() => validateQueuePropagation(healthy({ attributeNames: ['TraceParent'] }))).toThrow(
      /case-sensitive/,
    );
  });

  // Lambda's own `_X_AMZN_TRACE_ID` is the trace of the poller invocation, not
  // of any message in the batch — a real trace, so the result reads as working.
  it('refuses a batching consumer with no span per message', () => {
    expect(() =>
      validateQueuePropagation(healthy({ consumer: 'lambda', batchSize: 10 })),
    ).toThrow(/poller invocation/);
  });

  it('accepts a batching consumer that extracts per record', () => {
    expect(() =>
      validateQueuePropagation(
        healthy({ consumer: 'lambda', batchSize: 10, perMessageContext: true }),
      ),
    ).not.toThrow();
  });

  it('refuses a consumer that head-samples independently of the producer', () => {
    expect(() =>
      validateQueuePropagation(healthy({ consumerSampler: 'traceidratio' })),
    ).toThrow(/decides without reference to the incoming context/);
  });

  it.each(['parentbased_always_off', 'parentbased_traceidratio'])(
    'accepts %s, which still defers to the parent',
    (consumerSampler) => {
      expect(() => validateQueuePropagation(healthy({ consumerSampler }))).not.toThrow();
    },
  );

  // An alarm at or past the window describes traces that are already lost.
  it('refuses a dwell alarm at or past the decision window', () => {
    expect(() => validateQueuePropagation(healthy({ dwellAlarmSeconds: 30 }))).toThrow(
      /record of the loss rather than a warning/,
    );
    expect(() => validateQueuePropagation(healthy({ dwellAlarmSeconds: 45 }))).toThrow(
      /record of the loss rather than a warning/,
    );
  });

  it('refuses nonsense timings outright', () => {
    expect(() => validateQueuePropagation(healthy({ visibilityTimeoutSeconds: 0 }))).toThrow(
      /must be positive/,
    );
    expect(() => validateQueuePropagation(healthy({ maxReceiveCount: 0 }))).toThrow(
      /at least 1/,
    );
  });

  it('names the queue in every message, since a stack may hold several', () => {
    expect(() =>
      validateQueuePropagation(healthy({ queueName: 'production-invoices', contextInBody: true })),
    ).toThrow(/^production-invoices: /);
  });
});

describe('the signals a worker emits', () => {
  // The filter patterns in `traced-queue-stack.ts` match on these literals.
  // They are otherwise two strings in two files with nothing reconciling them.
  it('logs the missing-context event under a fixed name', () => {
    const line = JSON.parse(
      traceContextMissingLog({
        queueName: 'production-orders',
        messageId: 'mock-message-id',
        reason: 'not-requested',
      }),
    );

    expect(line).toEqual({
      event: TRACE_CONTEXT_MISSING_EVENT,
      queue: 'production-orders',
      message_id: 'mock-message-id',
      reason: 'not-requested',
    });
  });

  it('logs what the attribute budget cost', () => {
    const line = JSON.parse(
      traceContextTruncatedLog({
        queueName: 'production-orders',
        dropped: [TRACESTATE_ATTRIBUTE, BAGGAGE_ATTRIBUTE],
      }),
    );

    expect(line).toEqual({
      event: TRACE_CONTEXT_TRUNCATED_EVENT,
      queue: 'production-orders',
      dropped: [TRACESTATE_ATTRIBUTE, BAGGAGE_ATTRIBUTE],
    });
  });

  // Not a semantic convention, and deliberately not in the `messaging.`
  // namespace, which would collide the day OpenTelemetry defines one.
  it('keeps the queue-time attribute out of the messaging namespace', () => {
    expect(QUEUE_TIME_ATTRIBUTE).toBe('aws.sqs.queue_time_ms');
    expect(QUEUE_TIME_ATTRIBUTE.startsWith('messaging.')).toBe(false);
  });
});
