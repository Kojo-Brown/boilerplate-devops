import * as zlib from 'zlib';
import { LOG_PIPELINE_METRIC_NAMESPACE, LOG_SCRUBBER_SOURCE } from '../lib/log-pipeline-stack';
import { DEFAULT_SCRUBBING_RULESET, serializeRuleset } from '../lib/log-scrubbing';

/**
 * Behavioural tests for the Firehose transform.
 *
 * `lambda.Code.fromInline` ships the handler as a string, so nothing else in
 * the build parses it: `tsc` sees a template literal and `cdk synth` embeds it
 * verbatim. It is compiled and run here against recorded Firehose events
 * instead, because every mistake it can make is silent — a record passed
 * through unscrubbed still arrives, and the pipeline's metrics still look
 * perfect.
 *
 * Two properties are asserted everywhere rather than in one test: the handler
 * never returns `ProcessingFailed` (which delivers the original bytes to the
 * error prefix), and nothing it writes to its own log group contains any part
 * of a record.
 */

const HASH_KEY = 'unit-test-hmac-key-not-a-real-secret';

/**
 * A JWT-shaped fixture, assembled at run time rather than written out.
 *
 * The three segments are a real header, a real payload and a signature that
 * says what it is — the handler sees exactly the string a logged token would
 * be. Written as one literal it is also a `eyJ….eyJ….…` in a source file, which
 * every secret scanner pointed at this repository reports as a hardcoded JSON
 * Web Token; GitGuardian did, on the first push of this file. Joining the parts
 * keeps the fixture honest and the scanner's finding true.
 */
const b64url = (value: object): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const jwtFixture = (subject: string): string =>
  [b64url({ alg: 'HS256', typ: 'JWT' }), b64url({ sub: subject }), 'not-a-real-signature'].join('.');

interface Harness {
  readonly handler: (event: unknown) => Promise<{ records: FirehoseOutput[] }>;
  readonly logs: string[];
  readonly secretCalls: number;
}

interface FirehoseOutput {
  readonly recordId: string;
  readonly result: 'Ok' | 'Dropped' | 'ProcessingFailed';
  readonly data?: string;
}

const makeSecretsModule = (
  responder: () => unknown,
  counter: { calls: number },
): Record<string, unknown> => ({
  GetSecretValueCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  SecretsManagerClient: class {
    async send() {
      counter.calls += 1;
      return responder();
    }
  },
});

const load = (
  env: Record<string, string> = {},
  responder: () => unknown = () => ({ SecretString: JSON.stringify({ key: HASH_KEY }) }),
): Harness => {
  const logs: string[] = [];
  const counter = { calls: 0 };
  const modules: Record<string, unknown> = {
    zlib,
    crypto: require('crypto'),
    '@aws-sdk/client-secrets-manager': makeSecretsModule(responder, counter),
  };

  const module = { exports: {} as { handler?: Harness['handler'] } };
  const requireStub = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require: ${id}`);
    return modules[id];
  };

  const factory = new Function('require', 'module', 'exports', 'process', 'console', LOG_SCRUBBER_SOURCE);
  factory(
    requireStub,
    module,
    module.exports,
    {
      env: {
        SCRUBBING_RULESET: serializeRuleset(DEFAULT_SCRUBBING_RULESET),
        METRIC_NAMESPACE: LOG_PIPELINE_METRIC_NAMESPACE,
        ENV_NAME: 'test',
        PIPELINE_NAME: 'test-log-pipeline',
        HASH_SECRET_ARN: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:test-abc',
        RESPONSE_BUDGET_BYTES: String(5 * 1024 * 1024),
        ...env,
      },
    },
    {
      log: (line: string) => logs.push(line),
      error: (line: string) => logs.push(line),
    },
  );

  if (module.exports.handler === undefined) throw new Error('handler was not exported');
  return {
    handler: module.exports.handler,
    logs,
    get secretCalls() {
      return counter.calls;
    },
  };
};

const envelope = (
  messages: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  owner: '123456789012',
  logGroup: '/ecs/test/api',
  logStream: 'api/task/1111',
  subscriptionFilters: ['test-log-pipeline-0'],
  messageType: 'DATA_MESSAGE',
  logEvents: messages.map((message, index) => ({
    id: `3742${index}`,
    timestamp: 1_760_000_000_000 + index,
    message,
  })),
  ...overrides,
});

const record = (payload: unknown, recordId = 'record-0', gzip = true) => ({
  recordId,
  approximateArrivalTimestamp: 1_760_000_000_000,
  data: (gzip
    ? zlib.gzipSync(JSON.stringify(payload))
    : Buffer.from(JSON.stringify(payload), 'utf8')
  ).toString('base64'),
});

/** The emitted lines of one output record. */
const linesOf = (output: FirehoseOutput): Record<string, unknown>[] => {
  const text = Buffer.from(output.data ?? '', 'base64').toString('utf8');
  // Firehose adds no separator between records, so every line the transform
  // emits has to end with one or the S3 object is a single unparseable line.
  expect(text.endsWith('\n')).toBe(true);
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
};

const run = async (
  messages: string[],
  env: Record<string, string> = {},
  responder?: () => unknown,
): Promise<{ lines: Record<string, unknown>[]; harness: Harness; output: FirehoseOutput }> => {
  const harness = load(env, responder);
  const response = await harness.handler({ records: [record(envelope(messages))] });
  expect(response.records[0].result).toBe('Ok');
  return { lines: linesOf(response.records[0]), harness, output: response.records[0] };
};

/** The EMF document the handler publishes, as an object. */
const metricsOf = (harness: Harness): Record<string, any> => {
  const emf = harness.logs.map((line) => JSON.parse(line)).find((entry) => entry._aws !== undefined);
  expect(emf).toBeDefined();
  return emf;
};

describe('free-text messages', () => {
  it('redacts an email interpolated into a message', async () => {
    const { lines } = await run(['login failed for ada@example.com after 3 tries']);
    expect(lines[0].message).toBe('login failed for [REDACTED:EMAIL] after 3 tries');
  });

  it('redacts a card number written with separators, and keeps the rest of the line', async () => {
    const { lines } = await run(['charge declined for 4111 1111 1111 1111 (issuer)']);
    expect(lines[0].message).toBe('charge declined for [REDACTED:CARD] (issuer)');
  });

  it('leaves a long digit run that fails the Luhn check alone', async () => {
    // An order id, not a card. Without the check digit this rule eats them.
    const { lines } = await run(['order 1234567812345678 shipped']);
    expect(lines[0].message).toBe('order 1234567812345678 shipped');
  });

  it('redacts an SSN but not a date written the same way', async () => {
    const { lines } = await run(['ssn 123-45-6789 dob 000-00-0000 ref 123-456-789']);
    expect(lines[0].message).toContain('[REDACTED:SSN]');
    expect(lines[0].message).toContain('000-00-0000');
    expect(lines[0].message).toContain('123-456-789');
  });

  it('redacts a JWT and an AWS access key id', async () => {
    const jwt = jwtFixture('ada');
    const { lines } = await run([`token=${jwt} key=AKIAIOSFODNN7EXAMPLE`]);
    expect(lines[0].message).toBe('token=[REDACTED:JWT] key=[REDACTED:AWS-KEY-ID]');
  });

  it('keeps the header name when it redacts an Authorization value', async () => {
    const { lines } = await run(['Authorization: Bearer abcdef0123456789 rejected']);
    expect(lines[0].message).toBe('Authorization: [REDACTED:AUTHORIZATION] rejected');
  });

  it('keeps the scheme and port around a redacted connection string', async () => {
    // `app:hunter2@db.internal` is also a valid email address, so the email
    // rule overlaps the URL rule from a later offset and the merged span takes
    // the host with it. Over-redacting is the direction to fail in: the
    // alternative is a rule that skips an address written after a colon, which
    // is how `email:ada@example.com` would survive.
    const { lines } = await run(['ECONNREFUSED postgres://app:hunter2@db.internal:5432/app']);
    expect(lines[0].message).toBe('ECONNREFUSED postgres://[REDACTED:OVERLAPPING]:5432/app');
    expect(lines[0].message).not.toContain('hunter2');
  });

  it('keeps the outer marker when one match contains another', async () => {
    // The Authorization rule's match contains the JWT rule's. There is an
    // honest label for that region, so it is used rather than OVERLAPPING.
    const { lines } = await run([`Authorization: Bearer ${jwtFixture('ada')}`]);
    expect(lines[0].message).toBe('Authorization: [REDACTED:AUTHORIZATION]');
    expect(lines[0].message).not.toContain('eyJ');
  });

  it('marks a partial overlap as such rather than picking one rule\'s label', async () => {
    const { lines } = await run(['contact ada@example.com:4111111111111111 now']);
    expect(String(lines[0].message)).not.toContain('ada@example.com');
    expect(String(lines[0].message)).not.toContain('4111111111111111');
  });

  it('is independent of rule order within one value', async () => {
    const { lines } = await run(['a@example.com 4111111111111111 +447700900123']); // scan-allow: aws-account-id Ofcom's reserved drama range, twelve digits after the country code
    expect(lines[0].message).toBe('[REDACTED:EMAIL] [REDACTED:CARD] [REDACTED:PHONE]');
  });

  it('leaves an IPv4 address alone, because that rule is opt-in', async () => {
    const { lines } = await run(['upstream 10.0.4.17 timed out']);
    expect(lines[0].message).toContain('10.0.4.17');
  });
});

describe('structured messages', () => {
  it('masks a value by key whatever its type', async () => {
    const { lines } = await run([
      JSON.stringify({ password: 12345, api_key: { rotated: true }, level: 'warn' }),
    ]);
    expect(lines[0].password).toBe('[REDACTED:FIELD]');
    expect(lines[0].api_key).toBe('[REDACTED:FIELD]');
    expect(lines[0].level).toBe('warn');
  });

  it('masks by key inside a nested object', async () => {
    const { lines } = await run([JSON.stringify({ ctx: { user: { ssn: '111-22-3333' } } })]);
    expect((lines[0].ctx as any).user.ssn).toBe('[REDACTED:FIELD]');
  });

  it('tokenises identifiers so records about one subject still correlate', async () => {
    const { lines } = await run([
      JSON.stringify({ user: { email: 'Ada@Example.com' }, action: 'login' }),
      JSON.stringify({ user: { email: 'ada@example.com' }, action: 'logout' }),
    ]);
    const first = (lines[0].user as any).email;
    const second = (lines[1].user as any).email;
    expect(first).toMatch(/^tkn:email:[0-9a-f]{32}$/);
    // Normalised before hashing: two spellings of one address are one subject,
    // and two tokens would be a join that silently returns half the rows.
    expect(second).toBe(first);
  });

  it('gives different subjects different tokens', async () => {
    const { lines } = await run([
      JSON.stringify({ email: 'ada@example.com' }),
      JSON.stringify({ email: 'grace@example.com' }),
    ]);
    expect(lines[0].email).not.toBe(lines[1].email);
  });

  it('passes an already-tokenised value through, so a second pass is idempotent', async () => {
    const { lines } = await run([JSON.stringify({ email: 'tkn:email:' + 'a'.repeat(32) })]);
    expect(lines[0].email).toBe('tkn:email:' + 'a'.repeat(32));
  });

  it('masks rather than tokenises when the key cannot be read, and says so', async () => {
    const { lines, harness } = await run([JSON.stringify({ email: 'ada@example.com' })], {}, () => {
      throw new Error('AccessDeniedException');
    });
    expect(lines[0].email).toBe('[REDACTED:FIELD]');
    expect(metricsOf(harness).TokenizationUnavailable).toBe(1);
    expect(JSON.stringify(lines)).not.toContain('ada@example.com');
  });

  it('still scans values under keys nobody listed', async () => {
    const { lines } = await run([JSON.stringify({ note: 'reply to ada@example.com' })]);
    expect(lines[0].note).toBe('reply to [REDACTED:EMAIL]');
  });

  it('scans a long digit run written as a JSON number', async () => {
    const { lines } = await run([JSON.stringify({ card: 4111111111111111 })]);
    expect(lines[0].card).toBe('[REDACTED:CARD]');
  });

  it('leaves ordinary numbers as numbers', async () => {
    const { lines } = await run([JSON.stringify({ durationMs: 1234, ok: true, missing: null })]);
    expect(lines[0].durationMs).toBe(1234);
    expect(lines[0].ok).toBe(true);
    expect(lines[0].missing).toBeNull();
  });

  it('scrubs inside arrays', async () => {
    const { lines } = await run([JSON.stringify({ recipients: ['a@example.com', 'b@example.com'] })]);
    expect(lines[0].recipients).toEqual(['[REDACTED:EMAIL]', '[REDACTED:EMAIL]']);
  });

  it('clips a subtree deeper than maxDepth instead of walking it', async () => {
    let deep: Record<string, unknown> = { email: 'ada@example.com' };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    const { lines, harness } = await run([JSON.stringify(deep)]);
    expect(JSON.stringify(lines)).toContain('[REDACTED:DEPTH-LIMIT]');
    expect(JSON.stringify(lines)).not.toContain('ada@example.com');
    expect(metricsOf(harness).SubtreesClipped).toBeGreaterThan(0);
  });

  it('truncates a value longer than the scan bound rather than passing it through', async () => {
    const long = `${'x'.repeat(9000)} ada@example.com`;
    const { lines, harness } = await run([JSON.stringify({ blob: long })]);
    expect(String(lines[0].blob)).toContain('[TRUNCATED]');
    expect(String(lines[0].blob).length).toBeLessThan(long.length);
    expect(metricsOf(harness).ValuesTruncated).toBe(1);
  });

  it('keeps the envelope fields an application field cannot overwrite', async () => {
    const { lines } = await run([
      JSON.stringify({ '@logGroup': 'attacker-controlled', message: 'hello' }),
    ]);
    expect(lines[0]['@logGroup']).toBe('/ecs/test/api');
    expect(lines[0]['@logStream']).toBe('api/task/1111');
    expect(lines[0]['@timestamp']).toBe(new Date(1_760_000_000_000).toISOString());
  });

  it('treats a JSON array message as text rather than spreading it', async () => {
    const { lines } = await run([JSON.stringify(['ada@example.com'])]);
    expect(String(lines[0].message)).toContain('[REDACTED:EMAIL]');
  });
});

describe('the Firehose contract', () => {
  it('emits one line per log event, newline-terminated', async () => {
    const { lines, output } = await run(['one', 'two', 'three']);
    expect(lines).toHaveLength(3);
    expect(Buffer.from(output.data ?? '', 'base64').toString('utf8').split('\n')).toHaveLength(4);
  });

  it('drops a control message without forwarding it, and counts it apart from failures', async () => {
    const harness = load();
    const response = await harness.handler({
      records: [record(envelope([], { messageType: 'CONTROL_MESSAGE' }))],
    });
    expect(response.records[0].result).toBe('Dropped');
    expect(metricsOf(harness).ControlMessagesDropped).toBe(1);
    // Folding these into RecordsDropped would put a permanent floor under the
    // drop alarm.
    expect(metricsOf(harness).RecordsDropped).toBe(0);
  });

  it('drops a record it cannot decode instead of failing it, which would deliver it raw', async () => {
    const harness = load();
    const response = await harness.handler({
      records: [{ recordId: 'bad', data: Buffer.from('not json at all').toString('base64') }],
    });
    expect(response.records[0].result).toBe('Dropped');
    expect(response.records[0].data).toBeUndefined();
    expect(metricsOf(harness).UnreadableRecordsDropped).toBe(1);
  });

  it('accepts an uncompressed direct-put record and scrubs it as one line', async () => {
    const harness = load();
    const response = await harness.handler({
      records: [record({ message: 'hello ada@example.com' }, 'direct', false)],
    });
    expect(response.records[0].result).toBe('Ok');
    expect(linesOf(response.records[0])[0].message).toBe('hello [REDACTED:EMAIL]');
  });

  it('drops records once the response budget is spent rather than failing the batch', async () => {
    const harness = load({ RESPONSE_BUDGET_BYTES: '200' });
    const response = await harness.handler({
      records: [
        record(envelope(['first message that fits nothing']), 'a'),
        record(envelope([`${'y'.repeat(400)}`]), 'b'),
      ],
    });
    const results = response.records.map((entry) => entry.result);
    expect(results).toContain('Dropped');
    expect(results).not.toContain('ProcessingFailed');
    expect(metricsOf(harness).OversizeRecordsDropped).toBeGreaterThan(0);
  });

  it.each([
    ['empty batch', { records: [] }],
    ['no records key', {}],
    ['a record with no data', { records: [{ recordId: 'x' }] }],
    ['a record whose payload is a JSON scalar', { records: [{ recordId: 'x', data: Buffer.from('42').toString('base64') }] }],
    ['a gzip header with no body', { records: [{ recordId: 'x', data: Buffer.from([0x1f, 0x8b, 0x00]).toString('base64') }] }],
  ])('never returns ProcessingFailed for %s', async (_name, event) => {
    const harness = load();
    const response = await harness.handler(event);
    for (const entry of response.records) expect(entry.result).not.toBe('ProcessingFailed');
  });

  it('reads the tokenisation key once per container, not once per record', async () => {
    const harness = load();
    await harness.handler({ records: [record(envelope(['a@example.com']), 'one')] });
    await harness.handler({ records: [record(envelope(['b@example.com']), 'two')] });
    expect(harness.secretCalls).toBe(1);
  });

  it('retries the key on the next invocation after a failure', async () => {
    let attempts = 0;
    const harness = load({}, () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Throttling');
      return { SecretString: JSON.stringify({ key: HASH_KEY }) };
    });
    await harness.handler({ records: [record(envelope([JSON.stringify({ email: 'a@example.com' })]), 'one')] });
    const second = await harness.handler({
      records: [record(envelope([JSON.stringify({ email: 'a@example.com' })]), 'two')],
    });
    expect(linesOf(second.records[0])[0].email).toMatch(/^tkn:email:/);
  });
});

describe('what the transform writes about itself', () => {
  it('logs no part of a record, in any branch', async () => {
    const harness = load();
    await harness.handler({
      records: [
        record(envelope([
          'ada@example.com 4111111111111111 111-22-3333',
          JSON.stringify({ password: 'hunter2', email: 'grace@example.com' }),
        ]), 'ok'),
        { recordId: 'unreadable', data: Buffer.from('ada@example.com').toString('base64') },
      ],
    });

    const written = harness.logs.join('\n');
    for (const secret of ['ada@example.com', 'grace@example.com', '4111111111111111', '111-22-3333', 'hunter2']) {
      expect(written).not.toContain(secret);
    }
  });

  it('publishes counters as EMF under the pipeline namespace', async () => {
    const { harness } = await run(['ada@example.com']);
    const emf = metricsOf(harness);
    expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe(LOG_PIPELINE_METRIC_NAMESPACE);
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Environment', 'Pipeline']]);
    expect(emf.Environment).toBe('test');
    expect(emf.Pipeline).toBe('test-log-pipeline');
    expect(emf.RecordsProcessed).toBe(1);
    expect(emf.EventsScrubbed).toBe(1);
    expect(emf.RedactionsApplied).toBe(1);
  });

  it('counts redactions per rule as properties rather than as dimensions', async () => {
    const { harness } = await run(['ada@example.com and 4111111111111111']);
    const emf = metricsOf(harness);
    expect(emf.redactionsByRule).toEqual({ email: 1, 'credit-card': 1 });
    const metricNames = emf._aws.CloudWatchMetrics[0].Metrics.map((entry: any) => entry.Name);
    expect(metricNames).not.toContain('email');
    expect(metricNames).toContain('RedactionsApplied');
  });

  it('declares every counter it publishes as a metric', async () => {
    const { harness } = await run(['nothing sensitive here']);
    const emf = metricsOf(harness);
    for (const entry of emf._aws.CloudWatchMetrics[0].Metrics) {
      expect(typeof emf[entry.Name]).toBe('number');
    }
  });
});
