import {
  ACCOUNT_SCOPE,
  COST_ALLOCATION_LOG_SCHEMA_VERSION,
  COST_ALLOCATION_METRIC_NAMESPACE,
  COST_ALLOCATION_REPORTER_SOURCE,
  COST_METRIC,
  TAG_GROUP_SEPARATOR,
  TAG_STATUS_ACTIVE,
  reporterCatalogue,
} from '../lib/cost-allocation-stack';
import { type SdkCall, loadInlineHandler, makeSdkModule } from './support/inline-lambda';

/**
 * Behavioural tests for the cost-allocation reporter.
 *
 * `lambda.Code.fromInline` ships this as a string, so nothing in the build
 * parses it. That matters more here than for most handlers because every
 * interesting failure ends in a *smaller* unattributed figure — a dropped
 * untagged bucket, a key that was never activated, a value outside the
 * catalogue — and a smaller unattributed figure is what a well-tagged account
 * publishes. A reporter that had silently stopped reading would be
 * indistinguishable from good news.
 */

type Handler = () => Promise<{
  start: string;
  end: string;
  keys: { tagKey: string; activated: boolean; total?: number; unattributed?: number }[];
}>;

const ENV = {
  METRIC_NAMESPACE: COST_ALLOCATION_METRIC_NAMESPACE,
  SCOPE: ACCOUNT_SCOPE,
  LOG_SCHEMA_VERSION: String(COST_ALLOCATION_LOG_SCHEMA_VERSION),
  LOOKBACK_DAYS: '7',
  COST_METRIC,
  TAG_GROUP_SEPARATOR,
  TAG_STATUS_ACTIVE,
  TAG_CATALOGUE: JSON.stringify([
    { key: 'Environment', values: ['staging', 'production'] },
    { key: 'CostCenter', values: ['engineering'] },
  ]),
};

interface GroupOptions {
  readonly keys: string[];
  readonly amount: string;
}

const group = (options: GroupOptions) => ({
  Keys: options.keys,
  Metrics: { [COST_METRIC]: { Amount: options.amount, Unit: 'USD' } },
});

interface LoadOptions {
  /** Tag keys `ListCostAllocationTags` reports Active. */
  readonly activeKeys?: readonly string[];
  /** Pages of groups, by tag key. Each entry is one `GetCostAndUsage` page. */
  readonly pages?: Record<string, Record<string, unknown>[][]>;
  /** How many activated keys `ListCostAllocationTags` returns per page. */
  readonly activationPageSize?: number;
  readonly env?: Record<string, string>;
}

const load = (options: LoadOptions = {}) => {
  const calls: SdkCall[] = [];
  const logs: string[] = [];
  const activeKeys = options.activeKeys ?? ['Environment', 'CostCenter'];
  const pages = options.pages ?? {};
  const consumed = new Map<string, number>();
  // One key per page when asked, so the pagination path is the one under test
  // rather than a single page that happens to hold everything.
  const activationPageSize = options.activationPageSize ?? Math.max(activeKeys.length, 1);

  const costExplorer = makeSdkModule(
    ['GetCostAndUsageCommand', 'ListCostAllocationTagsCommand'],
    ['CostExplorerClient'],
    calls,
    (call) => {
      if (call.command === 'ListCostAllocationTagsCommand') {
        const offset = Number(String(call.input.NextToken ?? '0').replace('tags-', '')) || 0;
        const page = activeKeys.slice(offset, offset + activationPageSize);
        const next = offset + activationPageSize;
        return {
          CostAllocationTags: page.map((key) => ({ TagKey: key, Status: TAG_STATUS_ACTIVE })),
          NextToken: next < activeKeys.length ? `tags-${next}` : undefined,
        };
      }
      const key = call.input.GroupBy[0].Key as string;
      const keyPages = pages[key] ?? [[]];
      const index = consumed.get(key) ?? 0;
      consumed.set(key, index + 1);
      const page = keyPages[index] ?? [];
      return {
        ResultsByTime: [{ Groups: page }],
        NextPageToken: index + 1 < keyPages.length ? `page-${index + 1}` : undefined,
      };
    },
  );

  const cloudwatch = makeSdkModule(
    ['PutMetricDataCommand'],
    ['CloudWatchClient'],
    calls,
    () => ({}),
  );

  const handler = loadInlineHandler<Handler>({
    source: COST_ALLOCATION_REPORTER_SOURCE,
    modules: {
      '@aws-sdk/client-cost-explorer': costExplorer,
      '@aws-sdk/client-cloudwatch': cloudwatch,
    },
    env: { ...ENV, ...options.env },
    logs,
  });

  return { handler, calls, logs };
};

interface Datapoint {
  MetricName: string;
  Value: number;
  Dimensions: { Name: string; Value: string }[];
}

const published = (calls: readonly SdkCall[]): Datapoint[] =>
  calls
    .filter((call) => call.command === 'PutMetricDataCommand')
    .flatMap((call) => call.input.MetricData as Datapoint[]);

const datapoint = (calls: readonly SdkCall[], name: string, dimensions: Record<string, string>) =>
  published(calls).find(
    (point) =>
      point.MetricName === name &&
      Object.entries(dimensions).every(([key, value]) =>
        point.Dimensions.some((d) => d.Name === key && d.Value === value),
      ),
  );

const records = (logs: readonly string[]) => logs.map((line) => JSON.parse(line));

describe('cost-allocation reporter', () => {
  describe('activation', () => {
    // An un-activated key and a key nobody spent against return the same thing
    // from GetCostAndUsage — no groups. Only ListCostAllocationTags tells them
    // apart, so it is read first and on its own.
    it('reads activation before asking Cost Explorer for anything', async () => {
      const { handler, calls } = load();
      await handler();
      expect(calls[0].command).toBe('ListCostAllocationTagsCommand');
    });

    it('publishes TagActivated 0 and makes no query for an un-activated key', async () => {
      const { handler, calls } = load({ activeKeys: ['Environment'] });
      await handler();

      expect(datapoint(calls, 'TagActivated', { TagKey: 'CostCenter' })?.Value).toBe(0);
      const queried = calls
        .filter((call) => call.command === 'GetCostAndUsageCommand')
        .map((call) => (call.input.GroupBy as { Key: string }[])[0].Key);
      expect(queried).toEqual(['Environment']);
    });

    // A zero published for a grouping AWS never had is worse than no datapoint:
    // it renders identically to a measured zero, and it is a paid-for zero.
    it('publishes no cost metrics at all for an un-activated key', async () => {
      const { handler, calls } = load({ activeKeys: [] });
      await handler();

      const costPoints = published(calls).filter((point) =>
        ['AttributedCost', 'UnattributedCost', 'UnattributedSharePercent'].includes(
          point.MetricName,
        ),
      );
      expect(costPoints).toEqual([]);
    });

    it('says in the log why nothing was queried', async () => {
      const { handler, logs } = load({ activeKeys: [] });
      await handler();

      const line = records(logs).find(
        (record) => record.event === 'cost-allocation-key' && record.tagKey === 'Environment',
      );
      expect(line.activated).toBe(false);
      expect(line.note).toMatch(/not retroactive/i);
    });

    // An account may activate up to 500 keys and this call returns a page at a
    // time. Reading one page would report every later key as not activated —
    // an alarm on a correctly configured account, and no cost query for it.
    it('follows NextToken through the activation list', async () => {
      const { handler, calls } = load({
        activeKeys: ['Environment', 'CostCenter'],
        activationPageSize: 1,
      });
      await handler();

      expect(
        calls.filter((call) => call.command === 'ListCostAllocationTagsCommand'),
      ).toHaveLength(2);
      expect(datapoint(calls, 'TagActivated', { TagKey: 'CostCenter' })?.Value).toBe(1);
    });

    it('ignores a tag AWS reports with a status other than Active', async () => {
      const calls: SdkCall[] = [];
      const costExplorer = makeSdkModule(
        ['GetCostAndUsageCommand', 'ListCostAllocationTagsCommand'],
        ['CostExplorerClient'],
        calls,
        (call) =>
          call.command === 'ListCostAllocationTagsCommand'
            ? { CostAllocationTags: [{ TagKey: 'Environment', Status: 'Inactive' }] }
            : { ResultsByTime: [] },
      );
      const cloudwatch = makeSdkModule(
        ['PutMetricDataCommand'],
        ['CloudWatchClient'],
        calls,
        () => ({}),
      );
      const handler = loadInlineHandler<Handler>({
        source: COST_ALLOCATION_REPORTER_SOURCE,
        modules: {
          '@aws-sdk/client-cost-explorer': costExplorer,
          '@aws-sdk/client-cloudwatch': cloudwatch,
        },
        env: ENV,
      });

      await handler();
      expect(datapoint(calls, 'TagActivated', { TagKey: 'Environment' })?.Value).toBe(0);
    });
  });

  describe('the untagged bucket', () => {
    // Cost Explorer reports spend with no value for the grouping tag as
    // 'Environment$' — key, separator, nothing. Treating that as a parse failure
    // publishes a dashboard on which everything is attributed.
    it('reads Key$ as untagged spend rather than as a malformed group', async () => {
      const { handler, calls } = load({
        pages: {
          Environment: [
            [
              group({ keys: ['Environment$production'], amount: '75' }),
              group({ keys: ['Environment$'], amount: '25' }),
            ],
          ],
        },
      });
      await handler();

      expect(datapoint(calls, 'UnattributedCost', { TagKey: 'Environment' })?.Value).toBe(25);
      expect(
        datapoint(calls, 'AttributedCost', { TagKey: 'Environment', TagValue: 'production' })
          ?.Value,
      ).toBe(75);
      expect(
        datapoint(calls, 'UnattributedSharePercent', { TagKey: 'Environment' })?.Value,
      ).toBeCloseTo(25);
    });

    it('splits on the first separator, so a value containing one survives', async () => {
      const { handler, calls } = load({
        env: {
          TAG_CATALOGUE: JSON.stringify([{ key: 'Environment', values: ['prod$eu'] }]),
        },
        activeKeys: ['Environment'],
        pages: { Environment: [[group({ keys: ['Environment$prod$eu'], amount: '10' })]] },
      });
      await handler();

      expect(
        datapoint(calls, 'AttributedCost', { TagKey: 'Environment', TagValue: 'prod$eu' })?.Value,
      ).toBe(10);
    });

    // A share of nothing is undefined, not nought per cent, and nought per cent
    // reads as perfect attribution.
    it('omits the share entirely when the window has no spend', async () => {
      const { handler, calls } = load({ pages: { Environment: [[]] } });
      await handler();

      expect(datapoint(calls, 'UnattributedSharePercent', { TagKey: 'Environment' })).toBeUndefined();
      expect(datapoint(calls, 'UnattributedCost', { TagKey: 'Environment' })?.Value).toBe(0);
    });
  });

  describe('declared and undeclared values', () => {
    // The dashboard names its series up front, so an undeclared value would
    // appear in no series and in no untagged bucket — the chart would stop
    // summing to the bill with nothing looking wrong.
    it('counts a value outside the catalogue instead of dropping it', async () => {
      const { handler, calls, logs } = load({
        pages: {
          Environment: [
            [
              group({ keys: ['Environment$production'], amount: '50' }),
              group({ keys: ['Environment$Prod'], amount: '30' }),
              group({ keys: ['Environment$qa'], amount: '20' }),
            ],
          ],
        },
      });
      await handler();

      expect(datapoint(calls, 'UnexpectedTagValue', { TagKey: 'Environment' })?.Value).toBe(2);
      const line = records(logs).find(
        (record) => record.event === 'cost-allocation-key' && record.tagKey === 'Environment',
      );
      expect(line.undeclaredValues).toEqual(['Prod', 'qa']);
    });

    it('publishes a zero for a declared value with no spend, so the series exists', async () => {
      const { handler, calls } = load({
        pages: { Environment: [[group({ keys: ['Environment$production'], amount: '10' })]] },
      });
      await handler();

      expect(
        datapoint(calls, 'AttributedCost', { TagKey: 'Environment', TagValue: 'staging' })?.Value,
      ).toBe(0);
    });

    it('sums repeated groups for one value across the daily buckets', async () => {
      const { handler, calls } = load({
        pages: {
          Environment: [
            [
              group({ keys: ['Environment$production'], amount: '10' }),
              group({ keys: ['Environment$production'], amount: '15' }),
            ],
          ],
        },
      });
      await handler();

      expect(
        datapoint(calls, 'AttributedCost', { TagKey: 'Environment', TagValue: 'production' })
          ?.Value,
      ).toBe(25);
    });

    it('treats an unreadable amount as zero rather than NaN', async () => {
      const { handler, calls } = load({
        pages: {
          Environment: [
            [{ Keys: ['Environment$production'], Metrics: {} }, group({ keys: ['Environment$'], amount: '5' })],
          ],
        },
      });
      await handler();

      expect(
        datapoint(calls, 'AttributedCost', { TagKey: 'Environment', TagValue: 'production' })
          ?.Value,
      ).toBe(0);
      expect(
        datapoint(calls, 'UnattributedSharePercent', { TagKey: 'Environment' })?.Value,
      ).toBe(100);
    });
  });

  describe('the window', () => {
    // End is exclusive and today's figures are partial until the day closes. A
    // window including today makes every series fall at midnight and climb back
    // through the day, on all of them at once.
    it('ends at today and covers whole days only', async () => {
      const { handler } = load();
      const result = await handler();

      const today = new Date().toISOString().slice(0, 10);
      expect(result.end).toBe(today);

      const span =
        (Date.parse(`${result.end}T00:00:00Z`) - Date.parse(`${result.start}T00:00:00Z`)) /
        (24 * 60 * 60 * 1000);
      expect(span).toBe(7);
    });

    it('asks Cost Explorer for the configured metric at daily granularity', async () => {
      const { handler, calls } = load();
      await handler();

      const query = calls.find((call) => call.command === 'GetCostAndUsageCommand');
      expect(query?.input.Granularity).toBe('DAILY');
      expect(query?.input.Metrics).toEqual([COST_METRIC]);
      expect(query?.input.GroupBy).toEqual([{ Type: 'TAG', Key: 'Environment' }]);
    });
  });

  describe('pagination and completion', () => {
    it('follows NextPageToken until the groups run out', async () => {
      const { handler, calls } = load({
        pages: {
          Environment: [
            [group({ keys: ['Environment$production'], amount: '10' })],
            [group({ keys: ['Environment$staging'], amount: '4' })],
          ],
        },
      });
      await handler();

      expect(
        datapoint(calls, 'AttributedCost', { TagKey: 'Environment', TagValue: 'staging' })?.Value,
      ).toBe(4);
      const environmentQueries = calls.filter(
        (call) =>
          call.command === 'GetCostAndUsageCommand' &&
          (call.input.GroupBy as { Key: string }[])[0].Key === 'Environment',
      );
      expect(environmentQueries).toHaveLength(2);
      expect(environmentQueries[1].input.NextPageToken).toBe('page-1');
    });

    // The staleness alarm reads this metric. Published first, it would report a
    // healthy report for a run that threw halfway through.
    it('publishes ReportSuccess last, after every key', async () => {
      const { handler, calls } = load();
      await handler();

      const names = published(calls).map((point) => point.MetricName);
      expect(names[names.length - 1]).toBe('ReportSuccess');
      expect(datapoint(calls, 'ReportSuccess', { Scope: ACCOUNT_SCOPE })?.Value).toBe(1);
    });

    it('publishes no ReportSuccess when Cost Explorer throws', async () => {
      const calls: SdkCall[] = [];
      const costExplorer = makeSdkModule(
        ['GetCostAndUsageCommand', 'ListCostAllocationTagsCommand'],
        ['CostExplorerClient'],
        calls,
        (call) =>
          call.command === 'ListCostAllocationTagsCommand'
            ? { CostAllocationTags: [{ TagKey: 'Environment', Status: TAG_STATUS_ACTIVE }] }
            : new Error('DataUnavailableException'),
      );
      const cloudwatch = makeSdkModule(
        ['PutMetricDataCommand'],
        ['CloudWatchClient'],
        calls,
        () => ({}),
      );
      const handler = loadInlineHandler<Handler>({
        source: COST_ALLOCATION_REPORTER_SOURCE,
        modules: {
          '@aws-sdk/client-cost-explorer': costExplorer,
          '@aws-sdk/client-cloudwatch': cloudwatch,
        },
        env: ENV,
      });

      await expect(handler()).rejects.toThrow('DataUnavailableException');
      expect(datapoint(calls, 'ReportSuccess', { Scope: ACCOUNT_SCOPE })).toBeUndefined();
    });

    it('chunks PutMetricData rather than sending one oversized call', async () => {
      const values = Array.from({ length: 40 }, (_, index) => `value-${index}`);
      const { handler, calls } = load({
        activeKeys: ['Environment'],
        env: { TAG_CATALOGUE: JSON.stringify([{ key: 'Environment', values }]) },
      });
      await handler();

      const puts = calls.filter((call) => call.command === 'PutMetricDataCommand');
      expect(puts.length).toBeGreaterThan(1);
      for (const put of puts) {
        expect((put.input.MetricData as unknown[]).length).toBeLessThanOrEqual(20);
      }
    });

    it('stamps every log line with the schema version', async () => {
      const { handler, logs } = load();
      await handler();

      for (const record of records(logs)) {
        expect(record.schemaVersion).toBe(COST_ALLOCATION_LOG_SCHEMA_VERSION);
      }
    });
  });
});

describe('reporterCatalogue', () => {
  it('passes only the activated keys, with their declared values', () => {
    expect(reporterCatalogue()).toEqual([
      { key: 'Environment', values: ['staging', 'production', 'preview'] },
      { key: 'Project', values: ['boilerplate'] },
      { key: 'CostCenter', values: ['engineering', 'platform'] },
    ]);
  });
});
