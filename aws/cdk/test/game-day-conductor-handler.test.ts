import { GAME_DAY_CONDUCTOR_SOURCE } from '../lib/failover-game-day-stack';
import {
  GAME_DAY_NAMESPACE,
  MAX_RESOLUTION_SECONDS,
  PROBE_SAMPLE_INTERVAL_SECONDS,
  ProbeDatapoint,
  measureRto,
  rehearsalParameterName,
} from '../lib/game-days';
import { SdkCall, loadInlineHandler, makeSdkModule } from './support/inline-lambda';

/**
 * Behavioural tests for the conductor, and the differential test that pins its
 * arithmetic to the library's.
 *
 * The RTO derivation exists twice — once in `lib/game-days.ts` and once inside
 * this handler — because `lambda.Code.fromInline` cannot import. That is a real
 * risk, and `agrees with measureRto` below is how it is handled: a table of
 * hand-built outages goes through both implementations and the results have to
 * match, so a change to either is a failing assertion here rather than a number
 * nobody can reproduce.
 */

type Handler = (event: Record<string, unknown>) => Promise<Record<string, any>>;

const SCENARIOS = [
  {
    id: 'rds-failover',
    title: 'Force a Multi-AZ failover and measure the caller-side outage',
    objectiveId: 'rds-multi-az-promotion',
    preflight: [
      'multi-az-enabled',
      'probe-reporting',
      'no-deployment-in-progress',
      'no-alarm-in-alarm-state',
    ],
    rtoSeconds: 120,
    parameter: rehearsalParameterName('production', 'rds-multi-az-promotion'),
  },
];

const T0 = new Date('2026-09-30T12:00:00.000Z');
const SAMPLE_MS = PROBE_SAMPLE_INTERVAL_SECONDS * 1000;

/** A uniform series: 1 is a success, 0 a failure. */
const series = (pattern: readonly number[], start = T0): ProbeDatapoint[] =>
  pattern.map((connectSuccess, index) => ({
    timestamp: new Date(start.getTime() + index * SAMPLE_MS),
    connectSuccess,
  }));

interface LoadOptions {
  /** The ConnectSuccess series GetMetricData returns. */
  readonly connect?: readonly ProbeDatapoint[];
  /** Sum of EndpointAddressChanged over the window. */
  readonly addressChanged?: number;
  readonly alarmsInAlarm?: readonly string[];
  /** The ECS service DescribeServices returns. `null` means an empty list. */
  readonly service?: Record<string, unknown> | null;
  readonly latestRestorableTime?: string;
  readonly existingLog?: unknown;
  readonly failedSteps?: readonly Record<string, unknown>[];
}

const load = (options: LoadOptions = {}) => {
  const calls: SdkCall[] = [];
  const notFound = Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
  // Ten minutes of healthy samples: what the `probe-reporting` preflight expects
  // to find, so a test about something else is not first a test about that.
  const connect = options.connect ?? series(Array(60).fill(1));

  const responder = (call: SdkCall) => {
    switch (call.command) {
      case 'GetMetricDataCommand':
        return {
          MetricDataResults: [
            {
              Id: 'connect',
              Timestamps: connect.map((point) => point.timestamp),
              Values: connect.map((point) => point.connectSuccess),
            },
            {
              Id: 'changed',
              Timestamps: [T0],
              Values: [options.addressChanged ?? 1],
            },
          ],
        };
      case 'DescribeAlarmsCommand':
        return { MetricAlarms: (options.alarmsInAlarm ?? []).map((AlarmName) => ({ AlarmName })) };
      case 'DescribeServicesCommand':
        if (options.service === null) return { services: [], failures: [{ reason: 'MISSING' }] };
        return {
          services: [options.service ?? { deployments: [], runningCount: 3, desiredCount: 3 }],
        };
      case 'DescribeDBInstancesCommand':
        return {
          DBInstances: [
            {
              LatestRestorableTime:
                options.latestRestorableTime ?? '2026-09-30T12:05:00.000Z',
            },
          ],
        };
      case 'GetParameterCommand':
        return options.existingLog === undefined
          ? notFound
          : { Parameter: { Value: JSON.stringify(options.existingLog) } };
      case 'GetAutomationExecutionCommand':
        return {
          AutomationExecution: { StepExecutions: options.failedSteps ?? [] },
        };
      default:
        return {};
    }
  };

  const handler = loadInlineHandler<Handler>({
    source: GAME_DAY_CONDUCTOR_SOURCE,
    modules: {
      '@aws-sdk/client-cloudwatch': makeSdkModule(
        ['DescribeAlarmsCommand', 'GetMetricDataCommand', 'PutMetricDataCommand'],
        ['CloudWatchClient'],
        calls,
        responder,
      ),
      '@aws-sdk/client-ecs': makeSdkModule(
        ['DescribeServicesCommand'],
        ['ECSClient'],
        calls,
        responder,
      ),
      '@aws-sdk/client-rds': makeSdkModule(
        ['DescribeDBInstancesCommand'],
        ['RDSClient'],
        calls,
        responder,
      ),
      '@aws-sdk/client-sns': makeSdkModule(['PublishCommand'], ['SNSClient'], calls, responder),
      '@aws-sdk/client-ssm': makeSdkModule(
        ['GetAutomationExecutionCommand', 'GetParameterCommand', 'PutParameterCommand'],
        ['SSMClient'],
        calls,
        responder,
      ),
    },
    env: {
      NAMESPACE: GAME_DAY_NAMESPACE,
      ENV_NAME: 'production',
      TOPIC_ARN: 'arn:aws:sns:us-east-1:111122223333:production-game-day',
      TARGET: 'production-postgres',
      DB_INSTANCE_IDENTIFIER: 'production-postgres',
      CLUSTER_NAME: 'production-cluster',
      SERVICE_NAME: 'production-service',
      SAMPLE_INTERVAL_SECONDS: String(PROBE_SAMPLE_INTERVAL_SECONDS),
      MAX_RESOLUTION_SECONDS: String(MAX_RESOLUTION_SECONDS),
      SCENARIOS: JSON.stringify(SCENARIOS),
    },
  });
  return { handler, calls };
};

const published = (calls: SdkCall[]) =>
  calls.filter((call) => call.command === 'PublishCommand').map((call) => call.input);

const parameterWrites = (calls: SdkCall[]) =>
  calls
    .filter((call) => call.command === 'PutParameterCommand')
    .map((call) => JSON.parse(call.input.Value));

/* ── The differential test ────────────────────────────────────────────────── */

describe('the conductor\'s RTO arithmetic', () => {
  const CASES: { name: string; datapoints: ProbeDatapoint[] }[] = [
    { name: 'a clean two-minute outage', datapoints: series([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]) },
    { name: 'a single failing sample', datapoints: series([1, 0, 1]) },
    { name: 'nothing failing at all', datapoints: series([1, 1, 1, 1]) },
    { name: 'a window that opens on a failure', datapoints: series([0, 0, 0, 1]) },
    { name: 'a window that ends still failing', datapoints: series([1, 0, 0, 0]) },
    { name: 'an empty window', datapoints: [] },
    {
      name: 'a hole across the outage',
      datapoints: [
        { timestamp: T0, connectSuccess: 1 },
        { timestamp: new Date(T0.getTime() + SAMPLE_MS), connectSuccess: 0 },
        { timestamp: new Date(T0.getTime() + 300_000), connectSuccess: 1 },
      ],
    },
    {
      name: 'a gap exactly at the tolerance',
      datapoints: [
        { timestamp: T0, connectSuccess: 1 },
        { timestamp: new Date(T0.getTime() + MAX_RESOLUTION_SECONDS * 1000), connectSuccess: 0 },
        { timestamp: new Date(T0.getTime() + (MAX_RESOLUTION_SECONDS + 10) * 1000), connectSuccess: 1 },
      ],
    },
    { name: 'two outages, the first short', datapoints: series([1, 0, 1, 0, 0, 0, 0, 1]) },
  ];

  it.each(CASES)('agrees with measureRto on $name', async ({ datapoints }) => {
    const expected = measureRto(datapoints, {
      windowStart: new Date(T0.getTime() - SAMPLE_MS),
      windowEnd: new Date(T0.getTime() + 3_600_000),
    });

    const { handler, calls } = load({ connect: datapoints });
    const event = {
      operation: 'measure',
      scenarioId: 'rds-failover',
      windowStart: new Date(T0.getTime() - SAMPLE_MS).toISOString(),
      executionId: 'exec-1',
    };

    if (expected.conclusive) {
      const result = await handler(event);
      expect(Number(result.measuredRtoSeconds)).toBe(expected.rtoSeconds);
      expect(result.resolutionSeconds).toBe(expected.resolutionSeconds);
      expect(published(calls)[0].Message).toContain(`${expected.rtoSeconds}s`);
    } else {
      // The library refuses, so the handler has to refuse with the same reason —
      // and by throwing, so the automation routes to the abort record rather
      // than writing a measurement it does not have.
      await expect(handler(event)).rejects.toThrow(expected.reason);
      expect(parameterWrites(calls)).toEqual([]);
    }
  });
});

/* ── Preflight ────────────────────────────────────────────────────────────── */

describe('preflight', () => {
  it('passes a quiet environment and returns the window\'s start', async () => {
    const { handler } = load();
    const result = await handler({
      operation: 'preflight',
      scenarioId: 'rds-failover',
      executionId: 'exec-1',
    });
    expect(result.checksPassed).toEqual(SCENARIOS[0].preflight);
    expect(new Date(result.startedAt).getTime()).not.toBeNaN();
  });

  it('refuses when the probe is not reporting enough datapoints', async () => {
    // The measurement window would have holes in it, and a hole is not a fast
    // recovery.
    const { handler } = load({ connect: series([1, 1]) });
    await expect(
      handler({ operation: 'preflight', scenarioId: 'rds-failover', executionId: 'exec-1' }),
    ).rejects.toThrow(/probe-reporting/);
  });

  it('refuses when the probe is already failing', async () => {
    // An outage that started before the fault cannot be attributed to it, and
    // the measurement would be a lower bound presented as a number.
    const failing = Array(60).fill(1);
    failing[30] = 0;
    const { handler } = load({ connect: series(failing) });
    await expect(
      handler({ operation: 'preflight', scenarioId: 'rds-failover', executionId: 'exec-1' }),
    ).rejects.toThrow(/already failing/);
  });

  it('refuses during an incident, and names what is red', async () => {
    const { handler } = load({ alarmsInAlarm: ['production-alb-5xx-target'] });
    await expect(
      handler({ operation: 'preflight', scenarioId: 'rds-failover', executionId: 'exec-1' }),
    ).rejects.toThrow(/no-alarm-in-alarm-state: production-alb-5xx-target/);
  });

  it('refuses mid-deploy', async () => {
    const { handler } = load({
      service: { deployments: [{ rolloutState: 'IN_PROGRESS' }], runningCount: 2, desiredCount: 3 },
    });
    await expect(
      handler({ operation: 'preflight', scenarioId: 'rds-failover', executionId: 'exec-1' }),
    ).rejects.toThrow(/no-deployment-in-progress/);
  });

  it('refuses when the service it was told to check does not exist', async () => {
    // DescribeServices answers 200 with an empty list for a service that is not
    // there, so this is the shape a renamed cluster or service produces — and a
    // preflight that cannot be made is not one that passed.
    const { handler } = load({ service: null });
    await expect(
      handler({ operation: 'preflight', scenarioId: 'rds-failover', executionId: 'exec-1' }),
    ).rejects.toThrow(/was not found/);
  });

  it('refuses a service running fewer tasks than it wants', async () => {
    const { handler } = load({
      service: { deployments: [], runningCount: 2, desiredCount: 3 },
    });
    await expect(
      handler({ operation: 'preflight', scenarioId: 'rds-failover', executionId: 'exec-1' }),
    ).rejects.toThrow(/2\/3 tasks running/);
  });

  it('refuses a scenario it does not know, rather than guessing', async () => {
    const { handler } = load();
    await expect(
      handler({ operation: 'preflight', scenarioId: 'something-else', executionId: 'exec-1' }),
    ).rejects.toThrow(/Unknown scenario/);
  });

  it('refuses an operation it does not know', async () => {
    const { handler } = load();
    await expect(
      handler({ operation: 'improvise', scenarioId: 'rds-failover', executionId: 'exec-1' }),
    ).rejects.toThrow(/Unknown operation/);
  });
});

/* ── Measure ──────────────────────────────────────────────────────────────── */

describe('measure', () => {
  const OUTAGE = series([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  const event = {
    operation: 'measure',
    scenarioId: 'rds-failover',
    windowStart: new Date(T0.getTime() - SAMPLE_MS).toISOString(),
    executionId: 'exec-1',
  };

  it('records the measurement, the verdict and the resolution', async () => {
    const { handler, calls } = load({ connect: OUTAGE });
    const result = await handler(event);
    expect(result.outcome).toBe('measured');
    expect(result.verdict).toBe('met');
    expect(Number(result.measuredRtoSeconds)).toBe(90);
    expect(result.resolutionSeconds).toBe(PROBE_SAMPLE_INTERVAL_SECONDS);

    const [log] = parameterWrites(calls);
    expect(log.lastAttempt.outcome).toBe('measured');
    expect(log.lastMeasured.measuredRtoSeconds).toBe(90);
    expect(log.lastAttempt.endpointAddressChanged).toBe(true);
  });

  it('publishes the measurement as a metric, so the exercise has a history', async () => {
    const { handler, calls } = load({ connect: OUTAGE });
    await handler(event);
    const data = calls
      .filter((call) => call.command === 'PutMetricDataCommand')
      .flatMap((call) => call.input.MetricData as Record<string, any>[]);
    expect(data).toEqual([
      expect.objectContaining({ MetricName: 'MeasuredRtoSeconds', Value: 90, Unit: 'Seconds' }),
    ]);
  });

  it('records the restore-point lag alongside it, for the record', async () => {
    const { handler, calls } = load({
      connect: OUTAGE,
      latestRestorableTime: new Date(T0.getTime() - 120_000).toISOString(),
    });
    await handler(event);
    const [log] = parameterWrites(calls);
    expect(log.lastAttempt.restorePointLagSeconds).toBeGreaterThan(0);
  });

  it('warns loudly when the endpoint never moved — that is a reboot, not a failover', async () => {
    // An RTO that met the objective while the address never changed describes
    // the wrong event. `assertMultiAz` should make it impossible; this is what
    // says so if it happens anyway.
    const { handler, calls } = load({ connect: OUTAGE, addressChanged: 0 });
    await handler(event);
    expect(published(calls)[0].Message).toContain('no promotion was observed');
  });

  it('keeps the SNS subject inside the limit SNS enforces', async () => {
    const { handler, calls } = load({ connect: OUTAGE });
    await handler(event);
    const [message] = published(calls);
    expect(message.Subject.length).toBeLessThanOrEqual(100);
    expect(message.Subject).not.toContain('\n');
  });

  it('refuses a windowStart that is not a timestamp', async () => {
    const { handler } = load({ connect: OUTAGE });
    await expect(handler({ ...event, windowStart: 'soon' })).rejects.toThrow(/not a timestamp/);
  });

  it('says the exercise has become an incident when the probe never recovers', async () => {
    const { handler } = load({ connect: series([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) });
    await expect(handler(event)).rejects.toThrow(/this is now an incident, not an exercise/);
  });
});

/* ── Abort ────────────────────────────────────────────────────────────────── */

describe('abort', () => {
  const event = { operation: 'abort', scenarioId: 'rds-failover', executionId: 'exec-1' };

  it('records the attempt without touching the last measurement', async () => {
    // The rehearsal clock is what an abort must not reset.
    const existingLog = {
      objectiveId: 'rds-multi-az-promotion',
      lastAttempt: { objectiveId: 'rds-multi-az-promotion', outcome: 'measured', completedAt: '2026-08-01T00:00:00.000Z' },
      lastMeasured: { objectiveId: 'rds-multi-az-promotion', outcome: 'measured', completedAt: '2026-08-01T00:00:00.000Z' },
    };
    const { handler, calls } = load({ existingLog });
    const result = await handler(event);
    expect(result.outcome).toBe('aborted');
    const [log] = parameterWrites(calls);
    expect(log.lastAttempt.outcome).toBe('aborted');
    expect(log.lastMeasured.completedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('reads the execution to find out which step refused, and says so', async () => {
    // SSM gives a failing step one destination, so without this every abort
    // record would say only that something went wrong.
    const { handler, calls } = load({
      failedSteps: [
        { StepName: 'preflight', StepStatus: 'Failed', FailureMessage: 'no-alarm-in-alarm-state: production-alb-5xx-target' },
      ],
    });
    const result = await handler(event);
    expect(result.note).toContain('preflight Failed');
    expect(result.note).toContain('production-alb-5xx-target');
    expect(published(calls)[0].Message).toContain('production-alb-5xx-target');
  });

  it('still writes a record when it cannot find out why', async () => {
    // An abort step that threw while trying to explain itself would leave no
    // record at all, which is the one outcome worse than an unexplained one.
    const { handler, calls } = load({ failedSteps: [] });
    const result = await handler(event);
    expect(result.note).toBe('no reason recorded');
    expect(parameterWrites(calls)).toHaveLength(1);
  });

  it('prefers a note it was handed over one it has to go and find', async () => {
    const { handler } = load({ failedSteps: [{ StepName: 'x', StepStatus: 'Failed' }] });
    const result = await handler({ ...event, note: 'operator stopped it' });
    expect(result.note).toBe('operator stopped it');
  });

  it('tells the reader the clock has not moved', async () => {
    const { handler, calls } = load();
    await handler(event);
    expect(published(calls)[0].Message).toContain('rehearsal clock has not been reset');
  });
});
