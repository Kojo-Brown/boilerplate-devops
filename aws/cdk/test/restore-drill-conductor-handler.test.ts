import {
  DRILL_POLL_INTERVAL_SECONDS,
  GAME_DAY_NAMESPACE,
  drillInstanceIdentifier,
  measureRestore,
  rehearsalParameterName,
  restorePointStaleAfterSeconds,
  RECOVERY_OBJECTIVES,
} from '../lib/game-days';
import { RESTORE_DRILL_CONDUCTOR_SOURCE } from '../lib/backup-restore-drill-stack';
import { SdkCall, loadInlineHandler, makeSdkModule } from './support/inline-lambda';

/**
 * Tests for the restore drill's conductor, compiled and run.
 *
 * `lambda.Code.fromInline` means nothing else in the build parses this: `tsc`
 * sees a template literal and `cdk synth` embeds it verbatim. Three things in
 * here are worth a test each.
 *
 * **The restore arithmetic is a second copy of `measureRestore`**, because an
 * inline handler cannot import. The last describe block runs a table of
 * timestamps through both and asserts they agree, so drift is a failing
 * assertion rather than a number nobody can reproduce.
 *
 * **The abort deletes the copy before it does anything else.** Every other line
 * in that path is information; that one is the difference between a finding and
 * a bill, and the ordering is invisible in review.
 *
 * **A failed verification is recorded, not thrown.** The drill has to tear the
 * copy down whatever it finds, and the rehearsal clock must not move — which is
 * how `verification-failed` is actually implemented.
 */

const OBJECTIVE = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-point-in-time-restore')!;
const PARAMETER = rehearsalParameterName('production', OBJECTIVE.id);
const COPY = drillInstanceIdentifier('production');

const SCENARIO = {
  id: 'rds-pitr-drill',
  title: 'Restore to the latest restorable point and prove the data came back',
  objectiveId: OBJECTIVE.id,
  preflight: ['restore-point-available', 'no-drill-instance-present'],
  rtoSeconds: OBJECTIVE.rtoSeconds,
  rpoSeconds: OBJECTIVE.rpoSeconds,
  maxRestorePointStaleSeconds: restorePointStaleAfterSeconds(OBJECTIVE),
  parameter: PARAMETER,
};

const ENV = {
  ENV_NAME: 'production',
  NAMESPACE: GAME_DAY_NAMESPACE,
  TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:production-restore-drill',
  SOURCE_INSTANCE: 'production-postgres',
  DRILL_INSTANCE: COPY,
  RESOLUTION_SECONDS: String(DRILL_POLL_INTERVAL_SECONDS),
  CHECK_COUNT: '7',
  SCENARIOS: JSON.stringify([SCENARIO]),
};

type Handler = (event: Record<string, unknown>) => Promise<Record<string, any>>;

interface NotFound extends Error {
  name: string;
}

const notFound = (): NotFound => {
  const error = new Error('DBInstance not found') as NotFound;
  error.name = 'DBInstanceNotFoundFault';
  return error;
};

const parameterNotFound = (): NotFound => {
  const error = new Error('ParameterNotFound') as NotFound;
  error.name = 'ParameterNotFound';
  return error;
};

interface Harness {
  readonly handler: Handler;
  readonly calls: SdkCall[];
  readonly warnings: string[];
}

const load = (responder: (call: SdkCall) => unknown, env: Record<string, string> = {}): Harness => {
  const calls: SdkCall[] = [];
  const warnings: string[] = [];
  const handler = loadInlineHandler<Handler>({
    source: RESTORE_DRILL_CONDUCTOR_SOURCE,
    env: { ...ENV, ...env },
    warnings,
    modules: {
      '@aws-sdk/client-cloudwatch': makeSdkModule(
        ['PutMetricDataCommand'],
        ['CloudWatchClient'],
        calls,
        responder,
      ),
      '@aws-sdk/client-rds': makeSdkModule(
        ['DeleteDBInstanceCommand', 'DescribeDBInstancesCommand'],
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
  });
  return { handler, calls, warnings };
};

const sent = (calls: SdkCall[], command: string): SdkCall[] =>
  calls.filter((call) => call.command === command);

const CREATED_AT = '2026-07-01T12:00:00.000Z';
const RESTORE_POINT = '2026-07-01T11:58:00.000Z';
const VERIFIED_AT = '2026-07-01T12:20:00.000Z';

const sourceInstance = {
  DBInstanceIdentifier: 'production-postgres',
  DBInstanceStatus: 'available',
  DBInstanceClass: 'db.t3.medium',
  AllocatedStorage: 100,
  LatestRestorableTime: RESTORE_POINT,
  DBParameterGroups: [{ DBParameterGroupName: 'production-pg16' }],
};

const copyInstance = {
  DBInstanceIdentifier: COPY,
  DBInstanceStatus: 'available',
  InstanceCreateTime: CREATED_AT,
  AllocatedStorage: 100,
};

/* ── Preflight ────────────────────────────────────────────────────────────── */

describe('preflight', () => {
  const respond = (call: SdkCall) => {
    if (call.command === 'DescribeDBInstancesCommand') {
      if (call.input.DBInstanceIdentifier === 'production-postgres') {
        return { DBInstances: [{ ...sourceInstance, LatestRestorableTime: new Date().toISOString() }] };
      }
      return notFound();
    }
    return {};
  };

  it('returns the source\'s class and parameter group, so the copy reproduces it', async () => {
    const { handler } = load(respond);
    const result = await handler({
      operation: 'preflight',
      scenarioId: SCENARIO.id,
      executionId: 'exec-1',
    });
    expect(result.instanceClass).toBe('db.t3.medium');
    expect(result.parameterGroup).toBe('production-pg16');
    expect(result.checksPassed).toContain('restore-point-available');
    expect(result.checksPassed).toContain('no-drill-instance-present');
    expect(Date.parse(result.restorePoint)).not.toBeNaN();
  });

  it('refuses when the source has no restore point at all', async () => {
    // The most important finding this drill can produce, and the reason it is
    // found out here rather than as an opaque InvalidDBInstanceState forty
    // seconds into a restore.
    const { handler } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? call.input.DBInstanceIdentifier === 'production-postgres'
          ? { DBInstances: [{ ...sourceInstance, LatestRestorableTime: undefined }] }
          : notFound()
        : {},
    );
    await expect(
      handler({ operation: 'preflight', scenarioId: SCENARIO.id, executionId: 'exec-1' }),
    ).rejects.toThrow(/no restore path at all/);
  });

  it('refuses when the restore point is already past what the objective can vouch for', async () => {
    const stale = new Date(Date.now() - (SCENARIO.maxRestorePointStaleSeconds + 60) * 1000);
    const { handler } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? call.input.DBInstanceIdentifier === 'production-postgres'
          ? { DBInstances: [{ ...sourceInstance, LatestRestorableTime: stale.toISOString() }] }
          : notFound()
        : {},
    );
    await expect(
      handler({ operation: 'preflight', scenarioId: SCENARIO.id, executionId: 'exec-1' }),
    ).rejects.toThrow(/past the/);
  });

  it('refuses when a copy from an earlier drill is still there', async () => {
    // Not because the restore would fail — that is harmless — but because the
    // teardown is scoped to this identifier and would delete that copy in the
    // middle of its own verification.
    const { handler } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? call.input.DBInstanceIdentifier === 'production-postgres'
          ? { DBInstances: [{ ...sourceInstance, LatestRestorableTime: new Date().toISOString() }] }
          : { DBInstances: [copyInstance] }
        : {},
    );
    await expect(
      handler({ operation: 'preflight', scenarioId: SCENARIO.id, executionId: 'exec-1' }),
    ).rejects.toThrow(/already exists/);
  });

  it('reports the missing restore path before the leftover copy', async () => {
    // Order matters: "there is no restore path" should not be hidden behind
    // last month's instance.
    const { handler } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? call.input.DBInstanceIdentifier === 'production-postgres'
          ? { DBInstances: [{ ...sourceInstance, LatestRestorableTime: undefined }] }
          : { DBInstances: [copyInstance] }
        : {},
    );
    await expect(
      handler({ operation: 'preflight', scenarioId: SCENARIO.id, executionId: 'exec-1' }),
    ).rejects.toThrow(/no restore path at all/);
  });
});

/* ── Measure ──────────────────────────────────────────────────────────────── */

describe('measure', () => {
  const baseResponder = (call: SdkCall): unknown => {
    if (call.command === 'DescribeDBInstancesCommand') return { DBInstances: [copyInstance] };
    if (call.command === 'GetParameterCommand') return parameterNotFound();
    return {};
  };

  const measureEvent = (verdict: string, overrides: Record<string, unknown> = {}) => ({
    operation: 'measure',
    scenarioId: SCENARIO.id,
    startedAt: CREATED_AT,
    restorePoint: RESTORE_POINT,
    verdict,
    verifiedAt: VERIFIED_AT,
    checksPassed: 'instance-available | storage-encrypted',
    checksFailed: 'none',
    executionId: 'exec-1',
    ...overrides,
  });

  it('measures from the copy\'s InstanceCreateTime, not from its own clock', async () => {
    const { handler, calls } = load(baseResponder);
    const result = await handler(measureEvent('verified'));
    expect(result.outcome).toBe('measured');
    expect(result.measuredRestoreSeconds).toBe('1200');
    const published = sent(calls, 'PutMetricDataCommand')[0];
    expect(published.input.MetricData[0].MetricName).toBe('MeasuredRestoreSeconds');
    expect(published.input.MetricData[0].Value).toBe(1200);
    expect(published.input.Namespace).toBe(GAME_DAY_NAMESPACE);
  });

  it('resets the rehearsal clock only for a verified copy', async () => {
    const { handler, calls } = load(baseResponder);
    await handler(measureEvent('verified'));
    const written = JSON.parse(sent(calls, 'PutParameterCommand')[0].input.Value);
    expect(written.lastMeasured).toBeDefined();
    expect(written.lastAttempt.outcome).toBe('measured');
  });

  it('records a failed verification without throwing, and leaves the clock alone', async () => {
    // This is where `verification-failed` is implemented. Throwing here would
    // route to the abort, which would also delete the copy — but the record
    // would then say only "aborted", throwing away the finding.
    const { handler, calls } = load(baseResponder);
    const result = await handler(
      measureEvent('failed', {
        checksPassed: 'instance-available',
        checksFailed: 'restored-bytes-match-source: the copy holds 0.30 GiB against 40.00 GiB',
      }),
    );
    expect(result.outcome).toBe('inconclusive');
    const written = JSON.parse(sent(calls, 'PutParameterCommand')[0].input.Value);
    expect(written.lastMeasured).toBeUndefined();
    expect(written.lastAttempt.checksFailed).toEqual([
      'restored-bytes-match-source: the copy holds 0.30 GiB against 40.00 GiB',
    ]);
  });

  it('publishes no restore time for a copy that came back wrong', async () => {
    // A number about how long it took to produce something unusable is
    // indistinguishable, on a graph next to the objective, from a good result.
    const { handler, calls } = load(baseResponder);
    await handler(measureEvent('failed'));
    expect(sent(calls, 'PutMetricDataCommand')).toHaveLength(0);
    const message = sent(calls, 'PublishCommand')[0].input;
    expect(message.Subject).toContain('NOT verified');
    expect(message.Message).toContain('has NOT been reset');
  });

  it('keeps the previous measurement when this attempt did not produce one', async () => {
    const previous = {
      objectiveId: OBJECTIVE.id,
      lastAttempt: { outcome: 'measured', measuredRtoSeconds: 900 },
      lastMeasured: { outcome: 'measured', measuredRtoSeconds: 900 },
    };
    const { handler, calls } = load((call) => {
      if (call.command === 'GetParameterCommand') {
        return { Parameter: { Value: JSON.stringify(previous) } };
      }
      return baseResponder(call);
    });
    await handler(measureEvent('failed'));
    const written = JSON.parse(sent(calls, 'PutParameterCommand')[0].input.Value);
    expect(written.lastMeasured.measuredRtoSeconds).toBe(900);
  });

  it('refuses a copy with no InstanceCreateTime rather than timing itself', async () => {
    const { handler } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? { DBInstances: [{ ...copyInstance, InstanceCreateTime: undefined }] }
        : call.command === 'GetParameterCommand'
          ? parameterNotFound()
          : {},
    );
    await expect(handler(measureEvent('verified'))).rejects.toThrow(/no InstanceCreateTime/);
  });

  it('refuses a verifiedAt that is not a timestamp', async () => {
    const { handler } = load(baseResponder);
    await expect(handler(measureEvent('verified', { verifiedAt: 'soon' }))).rejects.toThrow(
      /not a timestamp/,
    );
  });
});

/* ── Teardown and abort ───────────────────────────────────────────────────── */

describe('teardown', () => {
  it('deletes the copy and its automated backups', async () => {
    // Without DeleteAutomatedBackups, RDS keeps the deleted copy's backups for
    // the source's retention period — a month of a full copy of production's
    // data somewhere nobody is looking.
    const { handler, calls } = load((call) =>
      call.command === 'DescribeDBInstancesCommand' ? { DBInstances: [copyInstance] } : {},
    );
    const result = await handler({
      operation: 'teardown',
      scenarioId: SCENARIO.id,
      executionId: 'exec-1',
    });
    expect(result.deleted).toBe(true);
    const deletion = sent(calls, 'DeleteDBInstanceCommand')[0].input;
    expect(deletion.DBInstanceIdentifier).toBe(COPY);
    expect(deletion.SkipFinalSnapshot).toBe(true);
    expect(deletion.DeleteAutomatedBackups).toBe(true);
  });

  it('is idempotent, so the abort path can call it after the teardown already ran', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'DescribeDBInstancesCommand' ? notFound() : {},
    );
    const result = await handler({
      operation: 'teardown',
      scenarioId: SCENARIO.id,
      executionId: 'exec-1',
    });
    expect(result.deleted).toBe(false);
    expect(result.reason).toBe('not-present');
    expect(sent(calls, 'DeleteDBInstanceCommand')).toHaveLength(0);
  });

  it('does not re-delete a copy that is already deleting', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? { DBInstances: [{ ...copyInstance, DBInstanceStatus: 'deleting' }] }
        : {},
    );
    const result = await handler({
      operation: 'teardown',
      scenarioId: SCENARIO.id,
      executionId: 'exec-1',
    });
    expect(result.reason).toBe('already-deleting');
    expect(sent(calls, 'DeleteDBInstanceCommand')).toHaveLength(0);
  });
});

describe('abort', () => {
  const execution = {
    AutomationExecution: {
      StepExecutions: [
        { StepName: 'preflight', StepStatus: 'Success' },
        {
          StepName: 'waitForAvailable',
          StepStatus: 'TimedOut',
          FailureMessage: 'the copy never reached available',
        },
      ],
    },
  };

  const respond = (call: SdkCall): unknown => {
    if (call.command === 'DescribeDBInstancesCommand') return { DBInstances: [copyInstance] };
    if (call.command === 'GetParameterCommand') return parameterNotFound();
    if (call.command === 'GetAutomationExecutionCommand') return execution;
    return {};
  };

  it('deletes the copy before it writes anything down', async () => {
    // Everything else in this path is information; this is the part that stops
    // a full-size copy of production running until somebody notices a bill.
    const { handler, calls } = load(respond);
    await handler({ operation: 'abort', scenarioId: SCENARIO.id, executionId: 'exec-1' });
    const order = calls.map((call) => call.command);
    expect(order.indexOf('DeleteDBInstanceCommand')).toBeLessThan(
      order.indexOf('PutParameterCommand'),
    );
    expect(order.indexOf('DeleteDBInstanceCommand')).toBeLessThan(
      order.indexOf('GetAutomationExecutionCommand'),
    );
    expect(order.indexOf('DeleteDBInstanceCommand')).toBeLessThan(order.indexOf('PublishCommand'));
  });

  it('names the step that failed, so three aborts in a row are a finding', async () => {
    const { handler, calls } = load(respond);
    const result = await handler({
      operation: 'abort',
      scenarioId: SCENARIO.id,
      executionId: 'exec-1',
    });
    expect(result.note).toContain('waitForAvailable TimedOut');
    expect(sent(calls, 'PublishCommand')[0].input.Message).toContain('never reached available');
  });

  it('still records the abort when the execution cannot be read', async () => {
    const { handler, calls, warnings } = load((call) =>
      call.command === 'GetAutomationExecutionCommand' ? new Error('denied') : respond(call),
    );
    const result = await handler({
      operation: 'abort',
      scenarioId: SCENARIO.id,
      executionId: 'exec-1',
    });
    expect(result.note).toBe('no reason recorded');
    expect(sent(calls, 'PutParameterCommand')).toHaveLength(1);
    expect(warnings.join(' ')).toContain('failure-note-unavailable');
  });

  it('shouts, and then fails, when the copy could not be deleted', async () => {
    // The record and the notification come first — the abort is the last step
    // in the document, so failing it costs nothing that has not already been
    // lost — and the throw is what puts this on the conductor's error metric.
    const { handler, calls } = load((call) =>
      call.command === 'DeleteDBInstanceCommand' ? new Error('InvalidDBInstanceState') : respond(call),
    );
    await expect(
      handler({ operation: 'abort', scenarioId: SCENARIO.id, executionId: 'exec-1' }),
    ).rejects.toThrow(/could not be deleted/);
    const message = sent(calls, 'PublishCommand')[0].input.Message;
    expect(message).toContain('THE COPY COULD NOT BE DELETED');
    expect(message).toContain(COPY);
    expect(sent(calls, 'PutParameterCommand')).toHaveLength(1);
  });

  it('does not reset the rehearsal clock', async () => {
    const { handler, calls } = load(respond);
    await handler({ operation: 'abort', scenarioId: SCENARIO.id, executionId: 'exec-1' });
    const written = JSON.parse(sent(calls, 'PutParameterCommand')[0].input.Value);
    expect(written.lastAttempt.outcome).toBe('aborted');
    expect(written.lastMeasured).toBeUndefined();
  });
});

/* ── The unknown cases ────────────────────────────────────────────────────── */

describe('what it refuses outright', () => {
  it('refuses an operation it does not implement', async () => {
    const { handler } = load(() => ({}));
    await expect(
      handler({ operation: 'improvise', scenarioId: SCENARIO.id, executionId: 'x' }),
    ).rejects.toThrow(/Unknown operation/);
  });

  it('refuses a scenario it was not deployed with', async () => {
    // Which means the document and this function came from different revisions.
    const { handler } = load(() => ({}));
    await expect(
      handler({ operation: 'teardown', scenarioId: 'something-else', executionId: 'x' }),
    ).rejects.toThrow(/different revisions/);
  });
});

/* ── The second copy of the arithmetic ────────────────────────────────────── */

describe('the restore arithmetic agrees with lib/game-days.ts', () => {
  /*
   * `measureRestore` exists twice: once in `lib/game-days.ts`, where it is
   * tested and documented, and once inside the inline handler, because
   * `lambda.Code.fromInline` cannot import. This is what keeps them the same
   * function — a change to either is a failing assertion here rather than a
   * number nobody can reproduce.
   */
  const CASES: readonly (readonly [string, string, string])[] = [
    ['a fast restore', '2026-07-01T12:00:00Z', '2026-07-01T12:05:00Z'],
    ['one that just met the objective', '2026-07-01T12:00:00Z', '2026-07-01T12:30:00Z'],
    ['one that missed it', '2026-07-01T12:00:00Z', '2026-07-01T13:10:00Z'],
    ['a sub-second span, which rounds', '2026-07-01T12:00:00.400Z', '2026-07-01T12:00:00.900Z'],
    ['one spanning a day boundary', '2026-06-30T23:50:00Z', '2026-07-01T00:20:00Z'],
  ];

  it.each(CASES)('agrees on %s', async (_label, created, verified) => {
    const { handler } = load((call) => {
      if (call.command === 'DescribeDBInstancesCommand') {
        return { DBInstances: [{ ...copyInstance, InstanceCreateTime: created }] };
      }
      if (call.command === 'GetParameterCommand') return parameterNotFound();
      return {};
    });
    const result = await handler({
      operation: 'measure',
      scenarioId: SCENARIO.id,
      startedAt: created,
      restorePoint: RESTORE_POINT,
      verdict: 'verified',
      verifiedAt: verified,
      checksPassed: 'none',
      checksFailed: 'none',
      executionId: 'exec-1',
    });
    const library = measureRestore(new Date(created), new Date(verified));
    expect(Number(result.measuredRestoreSeconds)).toBe(library.restoreSeconds);
    expect(result.resolutionSeconds).toBe(library.resolutionSeconds);
  });

  it('agrees on refusing a negative span', async () => {
    const { handler } = load((call) => {
      if (call.command === 'DescribeDBInstancesCommand') {
        return { DBInstances: [{ ...copyInstance, InstanceCreateTime: VERIFIED_AT }] };
      }
      if (call.command === 'GetParameterCommand') return parameterNotFound();
      return {};
    });
    expect(() => measureRestore(new Date(VERIFIED_AT), new Date(CREATED_AT))).toThrow(
      /not about the same restore/,
    );
    await expect(
      handler({
        operation: 'measure',
        scenarioId: SCENARIO.id,
        startedAt: CREATED_AT,
        restorePoint: RESTORE_POINT,
        verdict: 'verified',
        verifiedAt: CREATED_AT,
        checksPassed: 'none',
        checksFailed: 'none',
        executionId: 'exec-1',
      }),
    ).rejects.toThrow(/not about the same restore/);
  });
});
