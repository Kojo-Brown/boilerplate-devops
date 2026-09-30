import { GAME_DAY_RECORDER_SOURCE } from '../lib/failover-game-day-stack';
import {
  GAME_DAY_NAMESPACE,
  RehearsalRecord,
  mergeRehearsalLog,
  rehearsalParameterName,
} from '../lib/game-days';
import { SdkCall, loadInlineHandler, makeSdkModule } from './support/inline-lambda';

/**
 * Behavioural tests for the recorder.
 *
 * It publishes the two numbers that are true between exercises, and the property
 * worth testing is what it does when it cannot make a reading: it publishes
 * nothing, and the alarms over both metrics breach on missing data. Every
 * alternative — a zero, a clamp, a sentinel — turns an unanswerable question
 * into a reassuring answer, and each is one line.
 */

type Handler = () => Promise<{
  published: number;
  objectives: {
    objectiveId: string;
    restorePointLagSeconds?: number | null;
    hoursSinceRehearsal?: number | null;
    reason?: string;
  }[];
}>;

const OBJECTIVES = [
  {
    id: 'rds-multi-az-promotion',
    path: 'multi-az-promotion',
    rpoBasis: 'synchronous-replication',
    rehearsalIntervalDays: 90,
    parameter: rehearsalParameterName('production', 'rds-multi-az-promotion'),
  },
  {
    id: 'rds-point-in-time-restore',
    path: 'point-in-time-restore',
    rpoBasis: 'latest-restorable-time',
    rehearsalIntervalDays: 180,
    parameter: rehearsalParameterName('production', 'rds-point-in-time-restore'),
  },
];

const NOW = new Date('2026-09-30T12:00:00.000Z');

const record = (overrides: Partial<RehearsalRecord> = {}): RehearsalRecord => ({
  objectiveId: 'rds-multi-az-promotion',
  scenarioId: 'rds-failover',
  startedAt: '2026-09-01T12:00:00.000Z',
  completedAt: '2026-09-01T12:10:00.000Z',
  outcome: 'measured',
  measuredRtoSeconds: 92,
  resolutionSeconds: 10,
  executionId: 'exec-1',
  ...overrides,
});

const load = (options: {
  latestRestorableTime?: string;
  parameters?: Record<string, string>;
  unparseable?: boolean;
} = {}) => {
  const calls: SdkCall[] = [];
  const notFound = Object.assign(new Error('not found'), { name: 'ParameterNotFound' });

  const responder = (call: SdkCall) => {
    if (call.command === 'DescribeDBInstancesCommand') {
      return {
        DBInstances: [
          options.latestRestorableTime === undefined
            ? {}
            : { LatestRestorableTime: options.latestRestorableTime },
        ],
      };
    }
    if (call.command === 'GetParameterCommand') {
      if (options.unparseable) return { Parameter: { Value: '{not json' } };
      const value = options.parameters?.[call.input.Name];
      return value === undefined ? notFound : { Parameter: { Value: value } };
    }
    return {};
  };

  const handler = loadInlineHandler<Handler>({
    source: GAME_DAY_RECORDER_SOURCE,
    modules: {
      '@aws-sdk/client-cloudwatch': makeSdkModule(
        ['PutMetricDataCommand'],
        ['CloudWatchClient'],
        calls,
        responder,
      ),
      '@aws-sdk/client-rds': makeSdkModule(
        ['DescribeDBInstancesCommand'],
        ['RDSClient'],
        calls,
        responder,
      ),
      '@aws-sdk/client-ssm': makeSdkModule(
        ['GetParameterCommand'],
        ['SSMClient'],
        calls,
        responder,
      ),
    },
    env: {
      NAMESPACE: GAME_DAY_NAMESPACE,
      ENV_NAME: 'production',
      DB_INSTANCE_IDENTIFIER: 'production-postgres',
      OBJECTIVES: JSON.stringify(OBJECTIVES),
    },
  });
  return { handler, calls };
};

const published = (calls: SdkCall[]) =>
  calls
    .filter((call) => call.command === 'PutMetricDataCommand')
    .flatMap((call) => call.input.MetricData as Record<string, any>[]);

const valueOf = (calls: SdkCall[], metricName: string, objectiveId: string) =>
  published(calls).find(
    (datum) =>
      datum.MetricName === metricName &&
      (datum.Dimensions as { Name: string; Value: string }[]).some(
        (dimension) => dimension.Name === 'Objective' && dimension.Value === objectiveId,
      ),
  )?.Value;

describe('the restore point, which is the live RPO', () => {
  it('publishes the age of LatestRestorableTime for the restore path only', () => {
    jest.useFakeTimers().setSystemTime(NOW);
    try {
      return (async () => {
        const { handler, calls } = load({ latestRestorableTime: '2026-09-30T11:56:00.000Z' });
        await handler();
        expect(valueOf(calls, 'RestorePointLagSeconds', 'rds-point-in-time-restore')).toBe(240);
        // The promotion path's RPO is zero by construction and is not observable
        // from outside the engine; publishing a number for it would be inventing
        // one.
        expect(valueOf(calls, 'RestorePointLagSeconds', 'rds-multi-az-promotion')).toBeUndefined();
      })();
    } finally {
      jest.useRealTimers();
    }
  });

  it('publishes nothing when the instance has no restore point at all', async () => {
    // Backup retention of zero. The RPO there is not large — there is no restore
    // path, and the alarm breaches on the missing datapoint.
    const { handler, calls } = load({});
    const result = await handler();
    expect(valueOf(calls, 'RestorePointLagSeconds', 'rds-point-in-time-restore')).toBeUndefined();
    expect(result.objectives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectiveId: 'rds-point-in-time-restore', reason: 'absent' }),
      ]),
    );
  });

  it('refuses a timestamp in the future rather than clamping it to a perfect RPO', async () => {
    const { handler, calls } = load({ latestRestorableTime: '2099-01-01T00:00:00.000Z' });
    const result = await handler();
    expect(valueOf(calls, 'RestorePointLagSeconds', 'rds-point-in-time-restore')).toBeUndefined();
    expect(result.objectives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'in-the-future' }),
      ]),
    );
  });
});

describe('rehearsal freshness', () => {
  it('publishes the hours since the last measurement', () => {
    jest.useFakeTimers().setSystemTime(NOW);
    try {
      return (async () => {
        const log = mergeRehearsalLog(undefined, record());
        const { handler, calls } = load({
          parameters: { [OBJECTIVES[0].parameter]: JSON.stringify(log) },
        });
        await handler();
        const hours = valueOf(calls, 'HoursSinceRehearsal', 'rds-multi-az-promotion');
        expect(hours).toBeCloseTo(28 * 24 + 23 + 50 / 60, 3);
      })();
    } finally {
      jest.useRealTimers();
    }
  });

  it('publishes nothing for an objective nothing has ever measured', async () => {
    // No sentinel value is invented: absence is the signal, and the overdue
    // alarm breaches on missing data. A large number here would work too, until
    // somebody asked what it meant.
    const { handler, calls } = load({});
    const result = await handler();
    expect(valueOf(calls, 'HoursSinceRehearsal', 'rds-multi-az-promotion')).toBeUndefined();
    expect(result.objectives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectiveId: 'rds-multi-az-promotion',
          hoursSinceRehearsal: null,
        }),
      ]),
    );
  });

  it('does not count an aborted attempt as a rehearsal', async () => {
    // The exercise that refused at the preflight injected nothing. Counting it
    // would mean scheduling an exercise, having it refuse, and coming away with
    // an objective that looks freshly measured.
    const log = mergeRehearsalLog(undefined, record({ outcome: 'aborted', note: 'an alarm was red' }));
    const { handler, calls } = load({
      parameters: { [OBJECTIVES[0].parameter]: JSON.stringify(log) },
    });
    await handler();
    expect(valueOf(calls, 'HoursSinceRehearsal', 'rds-multi-az-promotion')).toBeUndefined();
  });

  it('treats a parameter that will not parse as no parameter, rather than failing', async () => {
    // Throwing would take both gauges off the air for every objective, which
    // takes the alarms with them. A hand-edited parameter should cost one
    // reading, not the signal.
    const { handler, calls } = load({ unparseable: true, latestRestorableTime: '2026-09-30T11:58:00.000Z' });
    await expect(handler()).resolves.toBeDefined();
    expect(valueOf(calls, 'RestorePointLagSeconds', 'rds-point-in-time-restore')).toBeDefined();
  });

  it('makes no PutMetricData call at all when there is nothing to publish', async () => {
    // An empty MetricData array is an API error, and an API error here is the
    // recorder's own alarm going red for a reason that is not a fault.
    const { handler, calls } = load({});
    await handler();
    expect(calls.filter((call) => call.command === 'PutMetricDataCommand')).toHaveLength(0);
  });
});
