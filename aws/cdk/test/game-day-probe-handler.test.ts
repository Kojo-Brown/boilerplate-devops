import { GAME_DAY_PROBE_SOURCE, endpointAddressParameterName } from '../lib/failover-game-day-stack';
import { GAME_DAY_NAMESPACE } from '../lib/game-days';
import { SdkCall, loadInlineHandler, makeSdkModule } from './support/inline-lambda';

/**
 * Behavioural tests for the probe.
 *
 * Every decision in it fails in the direction that looks like health: a connect
 * that is never attempted, a deadline that never fires, an address change
 * reported on every cold start, a metric published as a zero when the probe
 * could not look. None of those is visible in a template or in a diff, and the
 * first symptom of any of them is an RTO nobody can reproduce.
 *
 * The sockets are stubbed. `net` and `dns` are the two modules this handler uses
 * that are not an AWS client, and stubbing them is what lets the six-sample loop
 * run in milliseconds rather than a minute.
 */

type Handler = () => Promise<{
  address: string | null;
  addressChanged: boolean | null;
  samples: { at: string; connected: boolean; latencyMs: number | null; error: string | null }[];
  failed: number;
}>;

interface SocketScript {
  /** What each connect attempt does, in order. The last entry repeats. */
  readonly outcomes: readonly ('connect' | 'error' | 'timeout' | 'hang')[];
}

interface Harness {
  readonly handler: Handler;
  readonly calls: SdkCall[];
  readonly connects: { host: string; port: number }[];
  readonly warnings: string[];
}

const HOST = 'production-postgres.example.invalid';

const load = (options: {
  script?: SocketScript;
  lookup?: () => Promise<{ address: string }>;
  responder?: (call: SdkCall) => unknown;
  samples?: number;
} = {}): Harness => {
  const calls: SdkCall[] = [];
  const connects: { host: string; port: number }[] = [];
  const warnings: string[] = [];
  const outcomes = options.script?.outcomes ?? ['connect'];
  let attempt = 0;

  const net = {
    createConnection: ({ host, port }: { host: string; port: number }) => {
      connects.push({ host, port });
      const outcome = outcomes[Math.min(attempt, outcomes.length - 1)];
      attempt += 1;
      const listeners = new Map<string, (arg?: any) => void>();
      const socket = {
        setTimeout: () => undefined,
        destroy: () => undefined,
        once(event: string, listener: (arg?: any) => void) {
          listeners.set(event, listener);
          return socket;
        },
      };
      // Fire on the next tick, the way a real socket would, so the handler's
      // promise wiring is exercised rather than short-circuited.
      setImmediate(() => {
        if (outcome === 'connect') listeners.get('connect')?.();
        if (outcome === 'timeout') listeners.get('timeout')?.();
        if (outcome === 'error') listeners.get('error')?.({ message: 'ECONNREFUSED' });
        // 'hang' fires nothing: the handler's own deadline has to end it.
      });
      return socket;
    },
  };

  const dns = {
    promises: {
      lookup: options.lookup ?? (async () => ({ address: '10.0.1.7' })),
    },
  };

  const responder =
    options.responder ??
    ((call: SdkCall) =>
      call.command === 'GetParameterCommand' ? { Parameter: { Value: '10.0.1.7' } } : {});

  const handler = loadInlineHandler<Handler>({
    source: GAME_DAY_PROBE_SOURCE,
    warnings,
    modules: {
      'node:net': net,
      'node:dns': dns,
      '@aws-sdk/client-cloudwatch': makeSdkModule(
        ['PutMetricDataCommand'],
        ['CloudWatchClient'],
        calls,
        responder,
      ),
      '@aws-sdk/client-ssm': makeSdkModule(
        ['GetParameterCommand', 'PutParameterCommand'],
        ['SSMClient'],
        calls,
        responder,
      ),
    },
    env: {
      NAMESPACE: GAME_DAY_NAMESPACE,
      ENV_NAME: 'production',
      TARGET: 'production-postgres',
      ENDPOINT_ADDRESS: HOST,
      ENDPOINT_PORT: '5432',
      ADDRESS_PARAMETER: endpointAddressParameterName('production'),
      // Zero-spaced samples: the slot arithmetic is `invokedAt + i * interval`,
      // so a zero interval runs the same loop without waiting a minute for it.
      SAMPLE_INTERVAL_MS: '0',
      SAMPLES_PER_INVOCATION: String(options.samples ?? 3),
      STORAGE_RESOLUTION: '1',
      CONNECT_TIMEOUT_MS: '20',
    },
  });

  return { handler, calls, connects, warnings };
};

const metrics = (calls: SdkCall[]) =>
  calls
    .filter((call) => call.command === 'PutMetricDataCommand')
    .flatMap((call) => call.input.MetricData as Record<string, any>[]);

const valuesOf = (calls: SdkCall[], metricName: string) =>
  metrics(calls)
    .filter((datum) => datum.MetricName === metricName)
    .map((datum) => datum.Value);

describe('the probe', () => {
  it('connects to the endpoint by name, not to the address it just resolved', async () => {
    // The whole point. A client that cached the pre-failover address keeps
    // failing after RDS considers the promotion complete, and a probe dialling
    // the address it looked up a line earlier would never see it.
    const { handler, connects } = load();
    await handler();
    expect(connects.every((connect) => connect.host === HOST)).toBe(true);
    expect(connects.every((connect) => connect.port === 5432)).toBe(true);
  });

  it('takes one sample per slot and publishes each as it is taken', async () => {
    // Published per sample, not batched: an invocation killed at its timeout
    // then costs the samples it had not taken and none of the ones it had.
    const { handler, calls } = load({ samples: 4 });
    const result = await handler();
    expect(result.samples).toHaveLength(4);
    expect(calls.filter((call) => call.command === 'PutMetricDataCommand')).toHaveLength(4);
    expect(valuesOf(calls, 'ConnectSuccess')).toEqual([1, 1, 1, 1]);
  });

  it('publishes at one-second storage resolution, which is what makes the sampling count', async () => {
    const { handler, calls } = load();
    await handler();
    expect(metrics(calls).every((datum) => datum.StorageResolution === 1)).toBe(true);
    expect(
      metrics(calls).every((datum) =>
        (datum.Dimensions as { Name: string }[]).some((dimension) => dimension.Name === 'Target'),
      ),
    ).toBe(true);
  });

  it('records a refused connection as a failure rather than an error', async () => {
    // A probe that threw would publish nothing for the sample, and a missing
    // sample is a hole the measurement refuses to read across — where a zero is
    // exactly the datapoint an outage is made of.
    const { handler, calls } = load({ script: { outcomes: ['error'] } });
    const result = await handler();
    expect(result.failed).toBe(3);
    expect(valuesOf(calls, 'ConnectSuccess')).toEqual([0, 0, 0]);
    expect(valuesOf(calls, 'ConnectLatencyMs')).toEqual([]);
    expect(result.samples[0].error).toBe('ECONNREFUSED');
  });

  it('ends a connect that never answers, on its own deadline', async () => {
    // `socket.setTimeout` cannot help with a lookup that hangs before the socket
    // exists, so the explicit timer is what bounds the attempt. Without it the
    // probe stops reporting during the event it exists to measure.
    const { handler, calls } = load({ script: { outcomes: ['hang'] }, samples: 1 });
    const result = await handler();
    expect(result.samples[0].connected).toBe(false);
    expect(result.samples[0].error).toBe('deadline');
    expect(valuesOf(calls, 'ConnectSuccess')).toEqual([0]);
  });

  it('records a latency only for the samples that connected', async () => {
    const { handler, calls } = load({ script: { outcomes: ['connect', 'error', 'connect'] } });
    await handler();
    expect(valuesOf(calls, 'ConnectSuccess')).toEqual([1, 0, 1]);
    expect(valuesOf(calls, 'ConnectLatencyMs')).toHaveLength(2);
  });
});

describe('the endpoint address', () => {
  it('reports no change when the address is what it was', async () => {
    const { handler, calls } = load();
    const result = await handler();
    expect(result.addressChanged).toBe(false);
    expect(valuesOf(calls, 'EndpointAddressChanged')).toEqual([0]);
    expect(calls.some((call) => call.command === 'PutParameterCommand')).toBe(false);
  });

  it('reports a change once, and remembers the new address', async () => {
    const { handler, calls } = load({
      lookup: async () => ({ address: '10.0.2.9' }),
    });
    const result = await handler();
    expect(result.addressChanged).toBe(true);
    // Once per invocation, not once per sample: the address is bookkeeping and
    // the connect is the measurement.
    expect(valuesOf(calls, 'EndpointAddressChanged')).toEqual([1]);
    const put = calls.find((call) => call.command === 'PutParameterCommand');
    expect(put?.input.Value).toBe('10.0.2.9');
    expect(put?.input.Overwrite).toBe(true);
  });

  it('treats a first run as a first run, not as a change', async () => {
    // With no previous value every cold start would otherwise report an address
    // change that did not happen — and the one signal that distinguishes a
    // failover from a reboot would be loudest when nothing had failed over.
    const notFound = Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
    const { handler, calls } = load({
      responder: (call) => (call.command === 'GetParameterCommand' ? notFound : {}),
    });
    const result = await handler();
    expect(result.addressChanged).toBe(false);
    expect(valuesOf(calls, 'EndpointAddressChanged')).toEqual([0]);
    // And it records the address, so the next invocation has a baseline.
    expect(calls.some((call) => call.command === 'PutParameterCommand')).toBe(true);
  });

  it('publishes no address metric at all when the name did not resolve', async () => {
    // "It did not change" and "we could not look" are different facts, and a
    // zero here would be the probe asserting the first while observing the
    // second.
    const { handler, calls, warnings } = load({
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    const result = await handler();
    expect(result.address).toBeNull();
    expect(result.addressChanged).toBeNull();
    expect(valuesOf(calls, 'EndpointAddressChanged')).toEqual([]);
    expect(valuesOf(calls, 'EndpointResolutionFailed')).toEqual([1]);
    expect(warnings.join()).toContain('endpoint-resolution-failed');
  });

  it('still measures connectivity when the name did not resolve', async () => {
    // Resolution and connection are separate questions, and a resolver that is
    // down does not excuse the probe from answering the second.
    const { handler, calls } = load({
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
      script: { outcomes: ['error'] },
    });
    await handler();
    expect(valuesOf(calls, 'ConnectSuccess')).toEqual([0, 0, 0]);
  });
});

describe('what must not cost the invocation its samples', () => {
  it('keeps sampling when the address parameter cannot be read', async () => {
    // The address is bookkeeping and the connect is the measurement. An SSM
    // throttle or a denied GetParameter must not leave a hole in the series,
    // because a hole is what the measurement refuses to read across.
    const { handler, calls, warnings } = load({
      responder: (call) =>
        call.command === 'GetParameterCommand' ? new Error('Rate exceeded') : {},
    });
    const result = await handler();
    expect(result.samples).toHaveLength(3);
    expect(valuesOf(calls, 'ConnectSuccess')).toEqual([1, 1, 1]);
    // And it says nothing about the address rather than guessing at it.
    expect(result.addressChanged).toBeNull();
    expect(valuesOf(calls, 'EndpointAddressChanged')).toEqual([]);
    expect(warnings.join()).toContain('endpoint-address-unreadable');
  });

  it('publishes the samples it can, then fails so the errors alarm reports it', async () => {
    // One throttled PutMetricData must not take the other samples with it, and
    // it must not pass silently either: the throw comes after the loop.
    let seen = 0;
    const { handler, calls } = load({
      responder: (call) => {
        if (call.command === 'GetParameterCommand') return { Parameter: { Value: '10.0.1.7' } };
        if (call.command === 'PutMetricDataCommand') {
          seen += 1;
          return seen === 2 ? new Error('Throttling') : {};
        }
        return {};
      },
    });
    await expect(handler()).rejects.toThrow(/1 of 3 sample\(s\) could not be published/);
    // All three were attempted; two landed.
    expect(calls.filter((call) => call.command === 'PutMetricDataCommand')).toHaveLength(3);
  });
});
