import { SLO_BUDGET_REPORTER_SOURCE, SLO_METRICS } from '../lib/slo-stack';

/**
 * Behavioural tests for the inline error-budget reporter.
 *
 * `lambda.Code.fromInline` ships this as a string, so nothing else in the build
 * ever parses it: `tsc` sees a template literal and `cdk synth` embeds it
 * verbatim. Every decision in here fails in the same direction — a budget that
 * reads fuller than it is, or full when nothing is being measured at all — so the
 * handler is compiled and run against recording stubs rather than asserted on as
 * text.
 */

interface SdkCall {
  readonly command: string;
  readonly input: Record<string, any>;
}

type Handler = () => Promise<{ reported: number }>;

const makeSdkModule = (
  commandNames: string[],
  calls: SdkCall[],
  responder: (call: SdkCall) => unknown,
  clientNames: string[],
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

const loadHandler = (
  env: Record<string, string>,
  modules: Record<string, unknown>,
): Handler => {
  const module = { exports: {} as { handler?: Handler } };
  const requireStub = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require: ${id}`);
    return modules[id];
  };

  const factory = new Function(
    'require',
    'module',
    'exports',
    'process',
    'console',
    SLO_BUDGET_REPORTER_SOURCE,
  );
  factory(requireStub, module, module.exports, { env }, { log: () => {}, error: () => {} });

  if (!module.exports.handler) throw new Error('handler was not exported');
  return module.exports.handler;
};

const ALB_SPEC = {
  id: 'test-api-availability',
  service: 'api',
  envName: 'test',
  objective: 0.999,
  windowDays: 30,
  errorBudget: 0.001,
  namespace: 'AWS/ApplicationELB',
  dimensions: {
    LoadBalancer: 'app/test-alb/1111111111111111',
    TargetGroup: 'targetgroup/test-tg/2222222222222222',
  },
  statistic: 'Sum',
  totalMetricName: 'RequestCount',
  badMetricNames: ['HTTPCode_Target_5XX_Count', 'HTTPCode_ELB_5XX_Count'],
};

const GOOD_RATIO_SPEC = {
  ...ALB_SPEC,
  id: 'test-api-latency',
  objective: 0.99,
  errorBudget: 0.01,
  namespace: 'AppSlo',
  dimensions: { Service: 'api', Environment: 'test' },
  totalMetricName: 'Requests',
  badMetricNames: [] as string[],
  goodMetricName: 'RequestsFast',
};

/** `{ m0: [...], m1: [...] }` → a GetMetricData response. */
const metricResponse = (
  values: Record<string, number[]>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  MetricDataResults: Object.entries(values).map(([Id, Values]) => ({ Id, Values })),
  ...extra,
});

const run = (
  specs: unknown[],
  responder: (call: SdkCall) => unknown,
): { handler: Handler; calls: SdkCall[] } => {
  const calls: SdkCall[] = [];
  const modules = {
    '@aws-sdk/client-cloudwatch': makeSdkModule(
      ['GetMetricDataCommand', 'PutMetricDataCommand'],
      calls,
      responder,
      ['CloudWatchClient'],
    ),
  };
  const handler = loadHandler(
    {
      AWS_REGION: 'us-east-1',
      SLO_SPECS: JSON.stringify(specs),
      METRIC_NAMESPACE: 'SLO',
    },
    modules,
  );
  return { handler, calls };
};

/** Datum values from the single PutMetricData call, keyed by metric name. */
const publishedValues = (calls: SdkCall[]): Record<string, number> => {
  const put = calls.filter((call) => call.command === 'PutMetricDataCommand');
  expect(put).toHaveLength(1);
  return Object.fromEntries(
    (put[0].input.MetricData as Array<Record<string, any>>).map((datum) => [
      datum.MetricName,
      datum.Value,
    ]),
  );
};

describe('the query it asks CloudWatch', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-18T12:34:56.789Z'));
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it('reads the whole SLO window at a one-hour period', async () => {
    // A 30-day window cannot be an alarm period, which is the entire reason this
    // function exists. One hour over 30 days is 720 datapoints per metric.
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand' ? metricResponse({ m0: [1000], m1: [1], m2: [0] }) : {},
    );
    await handler();

    const get = calls.find((call) => call.command === 'GetMetricDataCommand')!;
    expect(get.input.MetricDataQueries).toHaveLength(3);
    for (const query of get.input.MetricDataQueries) {
      expect(query.MetricStat.Period).toBe(3600);
      expect(query.MetricStat.Stat).toBe('Sum');
    }
    // Truncated to the minute, so consecutive runs inside one minute ask the same
    // question and get the same answer.
    expect((get.input.EndTime as Date).toISOString()).toBe('2026-09-18T12:34:00.000Z');
    expect((get.input.StartTime as Date).toISOString()).toBe('2026-08-19T12:34:00.000Z');
  });

  it('asks for the total first, then each bad-event metric', async () => {
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand' ? metricResponse({ m0: [1000], m1: [1], m2: [0] }) : {},
    );
    await handler();

    const queries = calls.find((c) => c.command === 'GetMetricDataCommand')!.input
      .MetricDataQueries as Array<Record<string, any>>;
    expect(queries.map((q) => [q.Id, q.MetricStat.Metric.MetricName])).toEqual([
      ['m0', 'RequestCount'],
      ['m1', 'HTTPCode_Target_5XX_Count'],
      ['m2', 'HTTPCode_ELB_5XX_Count'],
    ]);
    expect(queries[0].MetricStat.Metric.Dimensions).toEqual([
      { Name: 'LoadBalancer', Value: 'app/test-alb/1111111111111111' },
      { Name: 'TargetGroup', Value: 'targetgroup/test-tg/2222222222222222' },
    ]);
  });

  it('asks one question per objective rather than one for all of them', async () => {
    // A renamed metric then fails that budget rather than every budget.
    const { handler, calls } = run([ALB_SPEC, { ...ALB_SPEC, id: 'second' }], (call) =>
      call.command === 'GetMetricDataCommand' ? metricResponse({ m0: [500], m1: [0], m2: [0] }) : {},
    );
    await handler();
    expect(calls.filter((c) => c.command === 'GetMetricDataCommand')).toHaveLength(2);
    expect(calls.filter((c) => c.command === 'PutMetricDataCommand')).toHaveLength(2);
  });
});

describe('the budget it computes', () => {
  it('reports a budget half spent as 50% remaining', async () => {
    // 100,000 requests, 50 failures: a 0.05% error ratio against a 0.1% budget.
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [100_000], m1: [40], m2: [10] })
        : {},
    );
    await handler();

    const values = publishedValues(calls);
    expect(values[SLO_METRICS.eventsObserved]).toBe(100_000);
    expect(values[SLO_METRICS.badEvents]).toBe(50);
    expect(values[SLO_METRICS.budgetConsumedPercent]).toBeCloseTo(50, 6);
    expect(values[SLO_METRICS.budgetRemainingPercent]).toBeCloseTo(50, 6);
  });

  it('sums both ELB and target 5xx into the bad-event count', async () => {
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [10_000], m1: [3], m2: [7] })
        : {},
    );
    await handler();
    expect(publishedValues(calls)[SLO_METRICS.badEvents]).toBe(10);
  });

  it('sums every datapoint in the window, not just the latest', async () => {
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [400, 300, 300], m1: [1, 0, 0], m2: [0, 0, 0] })
        : {},
    );
    await handler();
    expect(publishedValues(calls)[SLO_METRICS.eventsObserved]).toBe(1000);
    expect(publishedValues(calls)[SLO_METRICS.badEvents]).toBe(1);
  });

  it('clamps remaining at zero and leaves consumed unclamped when the budget is overspent', async () => {
    // 1% failures against a 0.1% budget is ten times the budget. Clamping both
    // would hide how far past it the service is; clamping neither makes a Percent
    // metric render on an axis nobody can read.
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [10_000], m1: [100], m2: [0] })
        : {},
    );
    await handler();

    const values = publishedValues(calls);
    expect(values[SLO_METRICS.budgetConsumedPercent]).toBeCloseTo(1000, 6);
    expect(values[SLO_METRICS.budgetRemainingPercent]).toBe(0);
  });

  it('publishes no budget at all for a window with no valid events', async () => {
    // This is the whole point of the no-data alarm. A window with no events has no
    // error ratio, and publishing 100% remaining for it would make a dead metric
    // pipeline and a perfect month identical — green in both cases.
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand' ? metricResponse({ m0: [], m1: [], m2: [] }) : {},
    );
    const result = await handler();

    const values = publishedValues(calls);
    expect(values[SLO_METRICS.eventsObserved]).toBe(0);
    expect(values[SLO_METRICS.badEvents]).toBe(0);
    expect(values[SLO_METRICS.budgetRemainingPercent]).toBeUndefined();
    expect(values[SLO_METRICS.budgetConsumedPercent]).toBeUndefined();
    // And it is a successful invocation: zero traffic is not an error, it is a
    // fact for the alarm to act on.
    expect(result).toEqual({ reported: 1 });
  });

  it('publishes a full budget for a window with traffic and no failures', async () => {
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [50_000], m1: [0], m2: [0] })
        : {},
    );
    await handler();
    expect(publishedValues(calls)[SLO_METRICS.budgetRemainingPercent]).toBe(100);
  });

  it('bounds bad events by valid events', async () => {
    // An error ratio above 1 is not a worse outage, it is two counts from
    // different populations — a bad-event metric with different dimensions, or a
    // statistic other than Sum on one of the pair.
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [100], m1: [500], m2: [0] })
        : {},
    );
    await handler();
    const values = publishedValues(calls);
    expect(values[SLO_METRICS.badEvents]).toBe(100);
    expect(values[SLO_METRICS.budgetConsumedPercent]).toBeCloseTo(100_000, 0);
  });

  it('dimensions and units every datum it publishes', async () => {
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [10_000], m1: [5], m2: [0] })
        : {},
    );
    await handler();

    const put = calls.find((c) => c.command === 'PutMetricDataCommand')!;
    expect(put.input.Namespace).toBe('SLO');
    for (const datum of put.input.MetricData as Array<Record<string, any>>) {
      expect(datum.Dimensions).toEqual([
        { Name: 'Slo', Value: 'test-api-availability' },
        { Name: 'Service', Value: 'api' },
        { Name: 'Environment', Value: 'test' },
      ]);
      expect(datum.Timestamp).toBeInstanceOf(Date);
      expect(['Count', 'Percent']).toContain(datum.Unit);
    }
  });
});

describe('a good-event source', () => {
  it('derives bad events by subtraction', async () => {
    const { handler, calls } = run([GOOD_RATIO_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [10_000], m1: [9_900] })
        : {},
    );
    await handler();

    const values = publishedValues(calls);
    expect(values[SLO_METRICS.badEvents]).toBe(100);
    // 1% slow against a 1% budget is exactly the budget.
    expect(values[SLO_METRICS.budgetConsumedPercent]).toBeCloseTo(100, 6);
    expect(values[SLO_METRICS.budgetRemainingPercent]).toBe(0);
  });

  it('clamps the subtraction when the good count arrives ahead of the total', async () => {
    // The two series are published independently and can be a datapoint apart.
    // Unclamped this is a negative bad count and a budget above 100%.
    const { handler, calls } = run([GOOD_RATIO_SPEC], (call) =>
      call.command === 'GetMetricDataCommand' ? metricResponse({ m0: [1_000], m1: [1_010] }) : {},
    );
    await handler();

    const values = publishedValues(calls);
    expect(values[SLO_METRICS.badEvents]).toBe(0);
    expect(values[SLO_METRICS.budgetRemainingPercent]).toBe(100);
  });

  it('asks for the good metric and no bad metric', async () => {
    const { handler, calls } = run([GOOD_RATIO_SPEC], (call) =>
      call.command === 'GetMetricDataCommand' ? metricResponse({ m0: [100], m1: [100] }) : {},
    );
    await handler();

    const queries = calls.find((c) => c.command === 'GetMetricDataCommand')!.input
      .MetricDataQueries as Array<Record<string, any>>;
    expect(queries.map((q) => q.MetricStat.Metric.MetricName)).toEqual([
      'Requests',
      'RequestsFast',
    ]);
  });
});

describe('pagination', () => {
  it('follows NextToken and sums every page', async () => {
    // Nothing here is near the 100,800-value response limit, but a query that
    // starts paginating returns a truncated window silently, and a truncated
    // window reports a budget less spent than it is.
    let page = 0;
    const { handler, calls } = run([ALB_SPEC], (call) => {
      if (call.command !== 'GetMetricDataCommand') return {};
      page += 1;
      return page === 1
        ? metricResponse({ m0: [600], m1: [1], m2: [0] }, { NextToken: 'more' })
        : metricResponse({ m0: [400], m1: [0], m2: [1] });
    });
    await handler();

    const gets = calls.filter((c) => c.command === 'GetMetricDataCommand');
    expect(gets).toHaveLength(2);
    expect(gets[0].input.NextToken).toBeUndefined();
    expect(gets[1].input.NextToken).toBe('more');
    expect(publishedValues(calls)[SLO_METRICS.eventsObserved]).toBe(1000);
    expect(publishedValues(calls)[SLO_METRICS.badEvents]).toBe(2);
  });

  it('gives up rather than looping until the timeout when a token never clears', async () => {
    // A timeout looks like a reporter that has stopped; an error says what went
    // wrong, and the Errors alarm sees both.
    const { handler } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [1], m1: [0], m2: [0] }, { NextToken: 'forever' })
        : {},
    );
    await expect(handler()).rejects.toThrow(/paginated more than 50 pages for test-api-availability/);
  });

  it('ignores a result whose Id it did not ask for', async () => {
    const { handler, calls } = run([ALB_SPEC], (call) =>
      call.command === 'GetMetricDataCommand'
        ? metricResponse({ m0: [100], m1: [1], m2: [0], surprise: [9_999] })
        : {},
    );
    await handler();
    expect(publishedValues(calls)[SLO_METRICS.eventsObserved]).toBe(100);
  });
});

describe('failure handling', () => {
  it('publishes every objective it can before it throws', async () => {
    // One renamed metric should not stop the other budgets being published, and
    // the invocation should still be recorded as a failure.
    const broken = { ...ALB_SPEC, id: 'broken', namespace: 'MissingNamespace' };
    const { handler, calls } = run([broken, ALB_SPEC], (call) => {
      if (call.command !== 'GetMetricDataCommand') return {};
      if (call.input.MetricDataQueries[0].MetricStat.Metric.Namespace === 'MissingNamespace') {
        throw new Error('metric not found');
      }
      return metricResponse({ m0: [1000], m1: [1], m2: [0] });
    });

    await expect(handler()).rejects.toThrow(
      /1 SLO\(s\) could not be reported: broken \(metric not found\)/,
    );
    // The healthy objective was still published.
    expect(calls.filter((c) => c.command === 'PutMetricDataCommand')).toHaveLength(1);
  });

  it('reports the underlying error message', async () => {
    const { handler } = run([ALB_SPEC], (call) => {
      if (call.command === 'GetMetricDataCommand') throw new Error('rate exceeded');
      return {};
    });
    await expect(handler()).rejects.toThrow(/rate exceeded/);
  });

  it('surfaces a failed publish, not just a failed read', async () => {
    const { handler } = run([ALB_SPEC], (call) => {
      if (call.command === 'PutMetricDataCommand') throw new Error('access denied');
      return metricResponse({ m0: [1000], m1: [1], m2: [0] });
    });
    await expect(handler()).rejects.toThrow(/access denied/);
  });
});
