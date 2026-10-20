import { SPOT_RECORDER_SOURCE } from '../lib/spot-interruption-stack';
import {
  FARGATE_SPOT_WARNING_SECONDS,
  SPOT_INTERRUPTION_STOP_CODE,
  SPOT_METRIC_NAMESPACE,
} from '../lib/spot-capacity';
import { type SdkCall, loadInlineHandler, makeSdkModule } from './support/inline-lambda';

/**
 * Behavioural tests for the interruption recorder.
 *
 * `lambda.Code.fromInline` ships this as a string, so nothing in the build
 * parses it: `tsc` sees a template literal and `cdk synth` embeds it verbatim.
 * That matters more here than for most handlers, because an inverted comparison
 * in the overrun check does not fail loudly — it reports clean drains as
 * overruns, or overruns as clean drains, and both read as a working metric.
 */

type Handler = (event: Record<string, any>) => Promise<any>;

const CLUSTER = 'arn:aws:ecs:us-east-1:123456789012:cluster/staging-cluster';

const ENV = {
  METRIC_NAMESPACE: SPOT_METRIC_NAMESPACE,
  ENVIRONMENT_NAME: 'staging',
  EXPECTED_STOP_CODE: SPOT_INTERRUPTION_STOP_CODE,
  LOG_SCHEMA_VERSION: '1',
  WARNING_SECONDS: String(FARGATE_SPOT_WARNING_SECONDS),
  DRAIN_BUDGETS: JSON.stringify({ 'staging-service': 90, 'preview-pr-*': 35 }),
};

const load = (env: Record<string, string> = {}) => {
  const calls: SdkCall[] = [];
  const logs: string[] = [];
  const handler = loadInlineHandler<Handler>({
    source: SPOT_RECORDER_SOURCE,
    modules: {
      '@aws-sdk/client-cloudwatch': makeSdkModule(
        ['PutMetricDataCommand'],
        ['CloudWatchClient'],
        calls,
        () => ({}),
      ),
    },
    env: { ...ENV, ...env },
    logs,
  });
  return { handler, calls, logs };
};

/** The warning: ECS has decided to stop the task and the task is still running. */
const warning = (overrides: Record<string, any> = {}) => ({
  time: '2026-10-20T09:00:00Z',
  detail: {
    clusterArn: CLUSTER,
    group: 'service:staging-service',
    taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/staging-cluster/abc123',
    stopCode: 'SpotInterruption',
    stoppedReason: 'Your Spot Task was interrupted.',
    lastStatus: 'RUNNING',
    desiredStatus: 'STOPPED',
    ...overrides,
  },
});

/** The completion, which is the event carrying the timestamps. */
const stopped = (overrides: Record<string, any> = {}) => ({
  time: '2026-10-20T09:01:30Z',
  detail: {
    clusterArn: CLUSTER,
    group: 'service:staging-service',
    taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/staging-cluster/abc123',
    stopCode: 'SpotInterruption',
    stoppedReason: 'Your Spot Task was interrupted.',
    lastStatus: 'STOPPED',
    desiredStatus: 'STOPPED',
    stoppingAt: '2026-10-20T09:00:00Z',
    stoppedAt: '2026-10-20T09:01:00Z',
    ...overrides,
  },
});

const metricData = (calls: SdkCall[]) => calls.flatMap((call) => call.input.MetricData);

const valuesOf = (calls: SdkCall[], metricName: string) =>
  metricData(calls)
    .filter((datum: any) => datum.MetricName === metricName)
    .map((datum: any) => datum.Value);

describe('what it refuses to count', () => {
  it('ignores a stop that is not a reclaim, even though the rule filters on it', () => {
    // A rule is a thing somebody can widen in a console at three in the
    // morning. A handler that trusted the pattern would turn every deployment
    // into an interruption and the rate alarm into a deploy counter.
    const { handler, calls } = load();
    return handler(stopped({ stopCode: 'ServiceSchedulerInitiated' })).then((result) => {
      expect(result).toEqual({ recorded: false, reason: 'stop-code-not-SpotInterruption' });
      expect(calls).toEqual([]);
    });
  });

  it('ignores a transition that is neither half of a reclaim', async () => {
    const { handler, calls } = load();
    const result = await handler(warning({ lastStatus: 'RUNNING', desiredStatus: 'RUNNING' }));
    expect(result).toEqual({ recorded: false, reason: 'not-a-reclaim-transition' });
    expect(calls).toEqual([]);
  });

  it('ignores an event with no detail at all', async () => {
    const { handler, calls } = load();
    expect(await handler({})).toEqual({
      recorded: false,
      reason: 'stop-code-not-SpotInterruption',
    });
    expect(calls).toEqual([]);
  });
});

describe('the warning', () => {
  it('counts one interruption when the two minutes start', async () => {
    const { handler, calls } = load();
    const result = await handler(warning());
    expect(result).toMatchObject({ recorded: true, phase: 'warning', serviceName: 'staging-service' });
    expect(valuesOf(calls, 'Interruptions')).toEqual([1, 1]);
    // Nothing about the shutdown is knowable yet.
    expect(valuesOf(calls, 'DrainSeconds')).toEqual([]);
  });

  it('publishes into the declared namespace at the event time, not at invocation time', async () => {
    const { handler, calls } = load();
    await handler(warning());
    expect(calls[0].input.Namespace).toBe(SPOT_METRIC_NAMESPACE);
    for (const datum of metricData(calls)) {
      expect(datum.Timestamp).toEqual(new Date('2026-10-20T09:00:00Z'));
    }
  });

  it('publishes each metric twice, because CloudWatch does not aggregate dimension sets', async () => {
    const { handler, calls } = load();
    await handler(warning());
    const dimensions = metricData(calls).map((datum: any) =>
      datum.Dimensions.map((dimension: any) => dimension.Name).join(','),
    );
    expect(dimensions).toEqual(['Environment', 'Environment,ClusterName,ServiceName']);
    const detailed = metricData(calls)[1] as any;
    expect(detailed.Dimensions).toEqual([
      { Name: 'Environment', Value: 'staging' },
      { Name: 'ClusterName', Value: 'staging-cluster' },
      { Name: 'ServiceName', Value: 'staging-service' },
    ]);
  });

  it('writes one structured line per reclaim, which the runbook reads', async () => {
    const { handler, logs } = load();
    await handler(warning());
    expect(JSON.parse(logs[0])).toMatchObject({
      schemaVersion: 1,
      event: 'spot-interruption',
      phase: 'warning',
      environment: 'staging',
      clusterName: 'staging-cluster',
      serviceName: 'staging-service',
      budgetSeconds: 90,
      warningSeconds: 120,
      stoppedReason: 'Your Spot Task was interrupted.',
    });
  });
});

describe('the shutdown', () => {
  it('measures stoppingAt to stoppedAt in seconds', async () => {
    const { handler, calls } = load();
    const result = await handler(stopped());
    expect(result).toMatchObject({ phase: 'stopped', drainSeconds: 60, overrun: false });
    expect(valuesOf(calls, 'DrainSeconds')).toEqual([60, 60]);
    expect(valuesOf(calls, 'DrainOverruns')).toEqual([0, 0]);
    expect(metricData(calls).find((datum: any) => datum.MetricName === 'DrainSeconds').Unit).toBe(
      'Seconds',
    );
  });

  it('calls an overrun an overrun at one second past the budget, and not at the budget', async () => {
    const atBudget = load();
    await atBudget.handler(stopped({ stoppedAt: '2026-10-20T09:01:30Z' })); // 90s, the budget
    expect(valuesOf(atBudget.calls, 'DrainOverruns')).toEqual([0, 0]);

    const overBudget = load();
    const result = await overBudget.handler(stopped({ stoppedAt: '2026-10-20T09:01:31Z' }));
    expect(result).toMatchObject({ drainSeconds: 91, overrun: true });
    expect(valuesOf(overBudget.calls, 'DrainOverruns')).toEqual([1, 1]);
  });

  it('measures a preview against the preview budget, matched by prefix', async () => {
    const { handler, calls, logs } = load();
    // 40 seconds, which is inside staging's 90 and outside a preview's 35.
    const result = await handler(
      stopped({
        group: 'service:preview-pr-4211',
        stoppedAt: '2026-10-20T09:00:40Z',
      }),
    );
    expect(result).toMatchObject({ serviceName: 'preview-pr-4211', drainSeconds: 40, overrun: true });
    expect(valuesOf(calls, 'DrainOverruns')).toEqual([1, 1]);
    expect(JSON.parse(logs[0]).budgetSeconds).toBe(35);
  });

  it('prefers the longest matching pattern, so a specific name beats a prefix', async () => {
    const { handler, logs } = await Promise.resolve(
      load({
        DRAIN_BUDGETS: JSON.stringify({ 'preview-pr-*': 35, 'preview-pr-1': 100 }),
      }),
    );
    await handler(stopped({ group: 'service:preview-pr-1' }));
    expect(JSON.parse(logs[0]).budgetSeconds).toBe(100);
  });

  it('falls back to the warning itself for a service with no declared budget', async () => {
    // Which the audit fails the build for — but a handler that measured against
    // nothing would publish no overrun at all for the one service nobody
    // classified.
    const { handler, calls, logs } = load();
    const result = await handler(
      stopped({ group: 'service:unclassified-service', stoppedAt: '2026-10-20T09:02:30Z' }),
    );
    expect(JSON.parse(logs[0]).budgetSeconds).toBeNull();
    expect(result).toMatchObject({ drainSeconds: 150, overrun: true });
    expect(valuesOf(calls, 'DrainOverruns')).toEqual([1, 1]);
  });
});

describe('a shutdown that cannot be measured', () => {
  it('is not counted as a clean drain', async () => {
    // A task that went from RUNNING to STOPPED with no stopping phase is the
    // reclaim that went worst, with the least to show for it. Publishing a zero
    // overrun for it would hide it inside the healthy case.
    for (const detail of [
      { stoppingAt: undefined },
      { stoppedAt: undefined },
      { stoppedAt: '2026-10-20T08:59:00Z' },
    ]) {
      const { handler, calls, logs } = load();
      const result = await handler(stopped(detail));
      expect(result).toMatchObject({ phase: 'stopped', drainSeconds: null });
      expect(valuesOf(calls, 'DrainUnmeasured')).toEqual([1, 1]);
      expect(valuesOf(calls, 'DrainOverruns')).toEqual([]);
      expect(JSON.parse(logs[0]).overrun).toBeNull();
    }
  });
});

describe('a task that belongs to no service', () => {
  it('records it with an empty service name rather than dropping it', async () => {
    // A standalone RunTask has no `service:` group. Nothing in this repository
    // runs one on Spot, and a handler that dropped the event would be the
    // reason nobody found out if something did.
    const { handler, calls } = load();
    const result = await handler(warning({ group: 'family:staging-migration' }));
    expect(result).toMatchObject({ recorded: true, serviceName: '' });
    expect(valuesOf(calls, 'Interruptions')).toEqual([1, 1]);
  });
});
