import {
  GAME_DAY_NAMESPACE,
  MAX_DRILL_INSTANCE_AGE_SECONDS,
  drillInstanceIdentifier,
  gameDayDocumentName,
} from '../lib/game-days';
import { RESTORE_DRILL_SWEEPER_SOURCE } from '../lib/backup-restore-drill-stack';
import { SdkCall, loadInlineHandler, makeSdkModule } from './support/inline-lambda';

/**
 * Tests for the restore drill's sweeper, compiled and run.
 *
 * It exists for one path, and the path is a human: SSM does not run a step's
 * `onFailure` for a *cancelled* execution, so somebody stopping a drill between
 * the restore and the teardown leaves a full-size copy of production running
 * with nothing to clean it up.
 *
 * Two behaviours carry the whole design and both are invisible in review.
 *
 * **Zero when there is no copy.** The obvious implementation publishes nothing,
 * which makes "no copy" and "the sweeper has stopped" identical on the graph —
 * and the second is the state in which an orphan runs forever.
 *
 * **It will not delete while a drill is in progress.** The one thing worse than
 * an orphaned copy is a copy deleted out from under a verification that was
 * still running, reported as a restore that could not be verified.
 */

const COPY = drillInstanceIdentifier('production');
const DOCUMENT = gameDayDocumentName('production', 'rds-pitr-drill');

const ENV = {
  ENV_NAME: 'production',
  NAMESPACE: GAME_DAY_NAMESPACE,
  TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:production-restore-drill',
  DRILL_INSTANCE: COPY,
  MAX_AGE_SECONDS: String(MAX_DRILL_INSTANCE_AGE_SECONDS),
  DOCUMENT_NAMES: JSON.stringify([DOCUMENT]),
};

type Handler = () => Promise<Record<string, any>>;

const notFound = (): Error => {
  const error = new Error('DBInstance not found');
  error.name = 'DBInstanceNotFoundFault';
  return error;
};

const load = (responder: (call: SdkCall) => unknown) => {
  const calls: SdkCall[] = [];
  const warnings: string[] = [];
  const handler = loadInlineHandler<Handler>({
    source: RESTORE_DRILL_SWEEPER_SOURCE,
    env: ENV,
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
        ['DescribeAutomationExecutionsCommand'],
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

const age = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

const copy = (ageSeconds: number, status = 'available') => ({
  DBInstanceIdentifier: COPY,
  DBInstanceStatus: status,
  InstanceCreateTime: age(ageSeconds),
});

const noExecutions = (call: SdkCall): unknown =>
  call.command === 'DescribeAutomationExecutionsCommand'
    ? { AutomationExecutionMetadataList: [] }
    : {};

describe('when there is no copy', () => {
  it('publishes zero rather than nothing, so its own silence is what pages', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'DescribeDBInstancesCommand' ? notFound() : noExecutions(call),
    );
    const result = await handler();
    expect(result.present).toBe(false);
    const published = sent(calls, 'PutMetricDataCommand')[0].input;
    expect(published.Namespace).toBe(GAME_DAY_NAMESPACE);
    expect(published.MetricData[0]).toMatchObject({
      MetricName: 'DrillInstanceAgeSeconds',
      Value: 0,
    });
    expect(sent(calls, 'DeleteDBInstanceCommand')).toHaveLength(0);
  });
});

describe('when a drill is running normally', () => {
  it('publishes the age and leaves the copy alone', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? { DBInstances: [copy(600)] }
        : noExecutions(call),
    );
    const result = await handler();
    expect(result.action).toBe('within-the-window');
    expect(sent(calls, 'PutMetricDataCommand')[0].input.MetricData[0].Value).toBeGreaterThan(500);
    expect(sent(calls, 'DeleteDBInstanceCommand')).toHaveLength(0);
    // And it does not even ask about executions: the age is inside the window,
    // so there is nothing to decide.
    expect(sent(calls, 'DescribeAutomationExecutionsCommand')).toHaveLength(0);
  });
});

describe('when a copy has outlived the window', () => {
  const old = MAX_DRILL_INSTANCE_AGE_SECONDS + 3600;

  it('deletes it, with its automated backups, and says what happened', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? { DBInstances: [copy(old)] }
        : noExecutions(call),
    );
    const result = await handler();
    expect(result.action).toBe('deleted');
    const deletion = sent(calls, 'DeleteDBInstanceCommand')[0].input;
    expect(deletion.DBInstanceIdentifier).toBe(COPY);
    expect(deletion.SkipFinalSnapshot).toBe(true);
    // Without this, every swept orphan leaves a month of a full copy of
    // production's data somewhere nobody is looking.
    expect(deletion.DeleteAutomatedBackups).toBe(true);
    const message = sent(calls, 'PublishCommand')[0].input.Message;
    expect(message).toContain('cancelled');
    expect(message).toContain(COPY);
  });

  it('publishes the age before it deletes, so the alarm fires either way', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? { DBInstances: [copy(old)] }
        : noExecutions(call),
    );
    await handler();
    const order = calls.map((call) => call.command);
    expect(order.indexOf('PutMetricDataCommand')).toBeLessThan(
      order.indexOf('DeleteDBInstanceCommand'),
    );
    expect(
      sent(calls, 'PutMetricDataCommand')[0].input.MetricData[0].Value,
    ).toBeGreaterThan(MAX_DRILL_INSTANCE_AGE_SECONDS);
  });

  it('refuses to delete while a drill execution is in progress', async () => {
    // A drill slower than the window is a finding about the restore path; a copy
    // deleted mid-verification is a finding about the sweeper that will be read
    // as one about the backups.
    const { handler, calls, warnings } = load((call) => {
      if (call.command === 'DescribeDBInstancesCommand') return { DBInstances: [copy(old)] };
      if (call.command === 'DescribeAutomationExecutionsCommand') {
        return { AutomationExecutionMetadataList: [{ AutomationExecutionId: 'exec-9' }] };
      }
      return {};
    });
    const result = await handler();
    expect(result.action).toBe('drill-in-progress');
    expect(result.executionId).toBe('exec-9');
    expect(sent(calls, 'DeleteDBInstanceCommand')).toHaveLength(0);
    expect(warnings.join(' ')).toContain('drill-in-progress');
  });

  it('asks about the drill\'s own document and only about InProgress executions', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? { DBInstances: [copy(old)] }
        : noExecutions(call),
    );
    await handler();
    const query = sent(calls, 'DescribeAutomationExecutionsCommand')[0].input;
    expect(query.Filters).toEqual([
      { Key: 'DocumentNamePrefix', Values: [DOCUMENT] },
      { Key: 'ExecutionStatus', Values: ['InProgress'] },
    ]);
  });

  it('leaves a copy that is already deleting alone', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'DescribeDBInstancesCommand'
        ? { DBInstances: [copy(old, 'deleting')] }
        : noExecutions(call),
    );
    const result = await handler();
    expect(result.action).toBe('already-deleting');
    expect(sent(calls, 'DeleteDBInstanceCommand')).toHaveLength(0);
  });
});

describe('what it does not swallow', () => {
  it('lets an unexpected DescribeDBInstances error reach the error metric', async () => {
    // Only `DBInstanceNotFound` means "there is no copy". Everything else is
    // "we could not look", and a sweeper that reported zero for that would be
    // publishing a healthy number it had not established.
    const { handler } = load((call) =>
      call.command === 'DescribeDBInstancesCommand' ? new Error('AccessDenied') : {},
    );
    await expect(handler()).rejects.toThrow(/AccessDenied/);
  });
});
