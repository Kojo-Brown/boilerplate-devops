import { DORA_AGGREGATOR_SOURCE } from '../lib/dora-metrics-stack';

/**
 * Behavioural tests for the inline aggregator.
 *
 * Everything this handler computes is a ratio, and a ratio over the wrong
 * denominator is the failure mode that never surfaces: it lands in range, on the
 * right axis, moving in a believable direction. The two that matter here are the
 * trailing edge — a deployment four minutes old is already in the denominator
 * while the incident it is about to cause has not happened — and the empty
 * window, where zero over zero renders as a perfect score.
 */

interface SdkCall {
  readonly command: string;
  readonly input: Record<string, any>;
}

const makeSdkModule = (
  commandNames: string[],
  clientNames: string[],
  calls: SdkCall[],
  responder: (call: SdkCall) => unknown,
) => {
  const module: Record<string, unknown> = {};

  for (const name of commandNames) {
    module[name] = class {
      readonly __name = name;
      constructor(readonly input: Record<string, any>) {}
    };
  }

  for (const clientName of clientNames) {
    module[clientName] = class {
      async send(command: { __name: string; input: Record<string, any> }) {
        const call = { command: command.__name, input: command.input };
        calls.push(call);
        return responder(call);
      }
    };
  }

  return module;
};

const ENV = {
  AWS_REGION: 'us-east-1',
  TABLE_NAME: 'dora-events',
  METRIC_NAMESPACE: 'DORA',
  SERVICES: JSON.stringify([{ environment: 'production', service: 'api' }]),
  WINDOW_DAYS: '30',
  ATTRIBUTION_WINDOW_MINUTES: '60',
};

const NOW = '2026-08-17T12:00:00.000Z';

const S = (value: string) => ({ S: value });
const N = (value: number) => ({ N: String(value) });

/**
 * A deployment record, positioned relative to `NOW`.
 *
 * `minutesAgo` is what decides ripeness, so every case here states it directly
 * rather than hiding it in an absolute timestamp.
 */
const deployment = (
  minutesAgo: number,
  overrides: { outcome?: string; failed?: boolean; environment?: string; service?: string } = {},
) => {
  const at = Date.parse(NOW) - minutesAgo * 60 * 1000;
  const environment = overrides.environment ?? 'production';
  const service = overrides.service ?? 'api';
  return {
    pk: S(`DEPLOY#${environment}#${service}`),
    sk: S(`${new Date(at).toISOString()}#deploy-${minutesAgo}`),
    deploymentId: S(`deploy-${minutesAgo}`),
    outcome: S(overrides.outcome ?? 'succeeded'),
    deployedAt: N(at),
    failureAttributed: { BOOL: Boolean(overrides.failed) },
  };
};

interface RunOptions {
  /** Query pages returned in order; each entry may set LastEvaluatedKey. */
  readonly pages?: { items: Record<string, any>[]; more?: boolean }[];
  readonly env?: Partial<typeof ENV>;
  readonly time?: string | null;
}

const run = async (options: RunOptions = {}) => {
  const calls: SdkCall[] = [];
  const pages = [...(options.pages ?? [{ items: [] }])];

  const responder = (call: SdkCall): unknown => {
    if (call.command === 'QueryCommand') {
      const page = pages.shift() ?? { items: [] };
      return {
        Items: page.items,
        LastEvaluatedKey: page.more ? { pk: S('cursor'), sk: S('cursor') } : undefined,
      };
    }
    return {};
  };

  const modules: Record<string, unknown> = {
    '@aws-sdk/client-dynamodb': makeSdkModule(
      ['QueryCommand'],
      ['DynamoDBClient'],
      calls,
      responder,
    ),
    '@aws-sdk/client-cloudwatch': makeSdkModule(
      ['PutMetricDataCommand'],
      ['CloudWatchClient'],
      calls,
      responder,
    ),
  };

  const exports_: Record<string, any> = {};
  const factory = new Function(
    'exports',
    'require',
    'process',
    'console',
    DORA_AGGREGATOR_SOURCE,
  );
  factory(
    exports_,
    (name: string) => {
      const module = modules[name];
      if (!module) throw new Error(`unstubbed module ${name}`);
      return module;
    },
    { env: { ...ENV, ...options.env } },
    { info: () => undefined, warn: () => undefined, error: () => undefined },
  );

  const time = options.time === null ? undefined : (options.time ?? NOW);
  const result = await exports_.handler(time ? { time } : {});

  const metrics = calls
    .filter((call) => call.command === 'PutMetricDataCommand')
    .flatMap((call) => call.input.MetricData as Record<string, any>[])
    .map((datum) => ({
      name: datum.MetricName as string,
      value: datum.Value as number,
      unit: datum.Unit as string,
      dimensions: Object.fromEntries(
        ((datum.Dimensions ?? []) as { Name: string; Value: string }[]).map((d) => [
          d.Name,
          d.Value,
        ]),
      ),
    }));

  const metric = (name: string) => metrics.find((m) => m.name === name);

  return {
    result,
    calls,
    metrics,
    metric,
    queries: calls.filter((c) => c.command === 'QueryCommand'),
  };
};

describe('DORA aggregator — change failure rate', () => {
  it('divides attributed failures by deployments old enough to have failed', async () => {
    const { metric } = await run({
      pages: [
        {
          items: [
            deployment(600, { failed: true }),
            deployment(500),
            deployment(400),
            deployment(300),
          ],
        },
      ],
    });

    expect(metric('ChangeFailureRate')!.value).toBe(25);
    expect(metric('ChangeFailureRate')!.unit).toBe('Percent');
    expect(metric('RipeDeployments')!.value).toBe(4);
  });

  // The trailing edge. A deployment from four minutes ago is already in the
  // denominator; the incident it is about to cause has not happened yet. So the
  // rate improves the instant a deploy lands, and the moment you most want the
  // number is the moment it is least true.
  it('excludes deployments too recent to have been judged', async () => {
    const { metric } = await run({
      pages: [
        {
          items: [
            deployment(600, { failed: true }),
            deployment(500),
            deployment(4), // inside the 60-minute attribution window
            deployment(10),
          ],
        },
      ],
    });

    // 1 failure over the 2 ripe deployments, not over all 4.
    expect(metric('ChangeFailureRate')!.value).toBe(50);
    expect(metric('RipeDeployments')!.value).toBe(2);
    expect(metric('UnripeDeployments')!.value).toBe(2);
  });

  // Zero percent over zero deployments is the most flattering possible reading
  // of no information, and it graphs identically to a genuinely clean month.
  it('publishes no rate at all when nothing in the window is ripe', async () => {
    const { metric } = await run({ pages: [{ items: [deployment(5), deployment(20)] }] });

    expect(metric('ChangeFailureRate')).toBeUndefined();
    expect(metric('RipeDeployments')!.value).toBe(0);
    expect(metric('UnripeDeployments')!.value).toBe(2);
  });

  it('publishes no rate for a service that has not deployed at all', async () => {
    const { metric } = await run({ pages: [{ items: [] }] });

    expect(metric('ChangeFailureRate')).toBeUndefined();
    // The other series are still published, so the graph shows a service that
    // is quiet rather than a gap that reads as missing data.
    expect(metric('DeploymentsPerDay')!.value).toBe(0);
    expect(metric('RipeDeployments')!.value).toBe(0);
  });

  // A build that went red never reached production. Counting it as a change
  // failure would mean a repository with flaky CI and a perfect production
  // record reports a terrible change failure rate.
  it('keeps failed deployments out of the rate and counts them separately', async () => {
    const { metric } = await run({
      pages: [
        {
          items: [
            deployment(600, { outcome: 'failed' }),
            deployment(500, { outcome: 'failed' }),
            deployment(400),
            deployment(300, { failed: true }),
          ],
        },
      ],
    });

    expect(metric('ChangeFailureRate')!.value).toBe(50); // 1 of 2 succeeded deploys
    expect(metric('RipeDeployments')!.value).toBe(2);
    expect(metric('FailedDeployments')!.value).toBe(2);
  });
});

describe('DORA aggregator — deployment frequency', () => {
  it('reports successful deploys per day over the window', async () => {
    const { metric } = await run({
      pages: [{ items: Array.from({ length: 60 }, (_, i) => deployment(120 + i * 10)) }],
    });

    expect(metric('DeploymentsPerDay')!.value).toBe(2);
    // Not Count/Second: CloudWatch has no per-day unit and the console would
    // render a per-day rate with an SI prefix.
    expect(metric('DeploymentsPerDay')!.unit).toBe('None');
  });

  // Frequency is about what reached production. A red build is a signal, but it
  // is not a deployment.
  it('counts only deployments that reached production', async () => {
    const { metric } = await run({
      pages: [
        {
          items: [
            deployment(600),
            deployment(500, { outcome: 'failed' }),
            deployment(400, { outcome: 'failed' }),
          ],
        },
      ],
    });

    expect(metric('DeploymentsPerDay')!.value).toBeCloseTo(1 / 30, 10);
  });

  // Unlike the rate, frequency includes the recent end: a deployment that
  // happened, happened.
  it('includes deployments too recent for the failure rate', async () => {
    const { metric } = await run({
      pages: [{ items: [deployment(600), deployment(5)] }],
    });

    expect(metric('DeploymentsPerDay')!.value).toBeCloseTo(2 / 30, 10);
    expect(metric('RipeDeployments')!.value).toBe(1);
  });
});

describe('DORA aggregator — window handling', () => {
  it('queries from the start of the trailing window', async () => {
    const { queries } = await run({ env: { WINDOW_DAYS: '7' } });

    const from = queries[0].input.ExpressionAttributeValues[':from'].S;
    expect(from).toBe('2026-08-10T12:00:00.000Z');
    expect(queries[0].input.KeyConditionExpression).toContain('sk >= :from');
  });

  // A truncated read silently shrinks the denominator, and a change failure
  // rate over "the first megabyte of deployments" is not a change failure rate.
  it('follows pagination rather than capping the read', async () => {
    const { queries, metric } = await run({
      pages: [
        { items: [deployment(600, { failed: true }), deployment(500)], more: true },
        { items: [deployment(400), deployment(300)] },
      ],
    });

    expect(queries).toHaveLength(2);
    expect(queries[1].input.ExclusiveStartKey).toBeDefined();
    expect(metric('RipeDeployments')!.value).toBe(4);
    expect(metric('ChangeFailureRate')!.value).toBe(25);
  });

  // A delayed or replayed invocation should recompute the window it was
  // scheduled for, not the one that happens to be current.
  it('anchors the window to the event time when there is one', async () => {
    const { queries } = await run({ time: '2026-06-01T00:00:00.000Z' });
    expect(queries[0].input.ExpressionAttributeValues[':from'].S).toBe('2026-05-02T00:00:00.000Z');
  });

  it('falls back to the clock when the event carries no time', async () => {
    const before = Date.now();
    const { queries } = await run({ time: null });
    const from = Date.parse(queries[0].input.ExpressionAttributeValues[':from'].S);
    expect(from).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000 - 5000);
  });
});

describe('DORA aggregator — multiple services', () => {
  it('publishes each service under its own dimensions', async () => {
    const { metrics, queries } = await run({
      env: {
        SERVICES: JSON.stringify([
          { environment: 'production', service: 'api' },
          { environment: 'production', service: 'worker' },
        ]),
      },
      pages: [
        { items: [deployment(600), deployment(500, { failed: true })] },
        { items: [deployment(600, { service: 'worker' })] },
      ],
    });

    expect(queries).toHaveLength(2);
    expect(queries[0].input.ExpressionAttributeValues[':pk'].S).toBe('DEPLOY#production#api');
    expect(queries[1].input.ExpressionAttributeValues[':pk'].S).toBe('DEPLOY#production#worker');

    const rates = metrics.filter((m) => m.name === 'ChangeFailureRate');
    expect(rates).toHaveLength(2);
    expect(rates.find((r) => r.dimensions.Service === 'api')!.value).toBe(50);
    expect(rates.find((r) => r.dimensions.Service === 'worker')!.value).toBe(0);
  });

  it('returns a per-service summary for the logs', async () => {
    const { result } = await run({ pages: [{ items: [deployment(600, { failed: true })] }] });

    expect(result.summaries).toEqual([
      expect.objectContaining({
        environment: 'production',
        service: 'api',
        succeeded: 1,
        ripe: 1,
        unripe: 0,
        attributedFailures: 1,
        changeFailureRate: 100,
      }),
    ]);
  });
});
