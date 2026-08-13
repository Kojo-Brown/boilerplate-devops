import { PREVIEW_REAPER_SOURCE } from '../lib/preview-environment-stack';

/**
 * Behavioural tests for the inline reaper handler.
 *
 * `lambda.Code.fromInline` ships this as a string, so nothing else in the build
 * ever parses it: `tsc` sees a template literal and `cdk synth` embeds it
 * verbatim. Both directions of failure in here are silent. Deleting too eagerly
 * takes away an environment somebody is reviewing, and there is no undo — the
 * stack is gone and the database with it. Deleting too timidly leaves a bill
 * nobody is looking at. So the handler is compiled and run against recording
 * stubs rather than asserted on as text.
 */

interface SdkCall {
  readonly command: string;
  readonly input: Record<string, any>;
}

type Handler = () => Promise<any>;

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

const ENV = {
  AWS_REGION: 'us-east-1',
  STACK_NAME_PREFIX: 'preview-pr-',
  SHARED_STACK_NAME: 'preview-shared',
  PREVIEW_TAG_KEY: 'PreviewEnvironment',
  PREVIEW_PR_NUMBER_TAG_KEY: 'PreviewPrNumber',
  MAX_LIFETIME_HOURS: '168',
  UNKNOWN_STATE_TTL_HOURS: '72',
  MAX_DELETIONS_PER_RUN: '10',
  REPOSITORY: 'example-org/example-repo',
  GITHUB_API_URL: 'https://api.github.com',
  GITHUB_TOKEN_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-github-token',
  SNS_TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:preview-reaper-notifications',
  DRY_RUN: 'false',
  DATABASE_ADMIN_CLUSTER: 'arn:aws:ecs:us-east-1:123456789012:cluster/preview-cluster',
  DATABASE_ADMIN_TASK_DEFINITION:
    'arn:aws:ecs:us-east-1:123456789012:task-definition/preview-db-admin',
  DATABASE_ADMIN_CONTAINER: 'DatabaseAdmin',
  DATABASE_ADMIN_SUBNETS: JSON.stringify(['subnet-aaaa1111', 'subnet-bbbb2222']),
  DATABASE_ADMIN_SECURITY_GROUPS: JSON.stringify(['sg-cccc3333']),
  PREVIEW_DATABASE_PREFIX: 'preview_pr_',
};

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-13T12:00:00Z');

interface StackFixture {
  readonly name?: string;
  readonly prNumber?: number | string;
  readonly ageHours?: number;
  readonly status?: string;
  readonly tagged?: boolean;
  /** Omit the pull-request tag entirely. */
  readonly untagged?: boolean;
}

const stackFixture = (fixture: StackFixture) => {
  const prNumber = fixture.prNumber ?? 1;
  const tags: { Key: string; Value: string }[] = [];

  if (fixture.tagged !== false) tags.push({ Key: 'PreviewEnvironment', Value: 'true' });
  if (!fixture.untagged) tags.push({ Key: 'PreviewPrNumber', Value: String(prNumber) });

  return {
    StackName: fixture.name ?? `preview-pr-${prNumber}`,
    StackStatus: fixture.status ?? 'CREATE_COMPLETE',
    CreationTime: new Date(NOW - (fixture.ageHours ?? 1) * HOUR).toISOString(),
    Tags: tags,
  };
};

interface RunOptions {
  readonly stacks: ReturnType<typeof stackFixture>[];
  /** Pull request state per number; anything absent is treated as an API error. */
  readonly pullRequests?: Record<number, 'open' | 'closed'>;
  readonly env?: Partial<typeof ENV>;
  /** Fail DeleteStack for these stack names. */
  readonly deleteFailures?: string[];
  /** Fail RunTask for these database names. */
  readonly dropFailures?: string[];
  /** Return no token at all, as an unconfigured reaper would. */
  readonly githubUnavailable?: boolean;
  /** Pages the DescribeStacks response, as a real account with many stacks does. */
  readonly paginate?: boolean;
}

const run = async (options: RunOptions) => {
  const calls: SdkCall[] = [];
  const fetchCalls: string[] = [];

  const responder = (call: SdkCall): unknown => {
    switch (call.command) {
      case 'DescribeStacksCommand': {
        if (!options.paginate) return { Stacks: options.stacks };
        // One stack per page, so a handler that reads only the first page sees
        // exactly one environment and leaves the rest running.
        const index = call.input.NextToken ? Number(call.input.NextToken) : 0;
        return {
          Stacks: options.stacks.slice(index, index + 1),
          NextToken: index + 1 < options.stacks.length ? String(index + 1) : undefined,
        };
      }
      case 'GetSecretValueCommand':
        return options.githubUnavailable
          ? {}
          : { SecretString: JSON.stringify({ token: 'mock-github-token' }) };
      case 'RunTaskCommand': {
        const databaseName = call.input.overrides.containerOverrides[0].environment.find(
          (entry: { name: string }) => entry.name === 'PREVIEW_DB_NAME',
        ).value;
        if ((options.dropFailures ?? []).includes(databaseName)) {
          throw new Error('RunTask failed: no container instance capacity');
        }
        return {};
      }
      case 'DeleteStackCommand':
        if ((options.deleteFailures ?? []).includes(call.input.StackName)) {
          throw new Error('stack is in DELETE_FAILED and has a retained resource');
        }
        return {};
      default:
        return {};
    }
  };

  const modules: Record<string, unknown> = {
    '@aws-sdk/client-cloudformation': makeSdkModule(
      ['DescribeStacksCommand', 'DeleteStackCommand'],
      calls,
      responder,
      ['CloudFormationClient'],
    ),
    '@aws-sdk/client-ecs': makeSdkModule(['RunTaskCommand'], calls, responder, ['ECSClient']),
    '@aws-sdk/client-sns': makeSdkModule(['PublishCommand'], calls, responder, ['SNSClient']),
    '@aws-sdk/client-secrets-manager': makeSdkModule(
      ['GetSecretValueCommand'],
      calls,
      responder,
      ['SecretsManagerClient'],
    ),
  };

  const fetchStub = async (url: string) => {
    fetchCalls.push(url);
    const prNumber = Number(url.split('/').pop());
    const state = (options.pullRequests ?? {})[prNumber];

    if (!state) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ state }) };
  };

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
    'fetch',
    'Date',
    PREVIEW_REAPER_SOURCE,
  );

  // A fixed clock: every threshold in the handler is measured against `now`,
  // and a test that depended on the wall clock would pass or fail by how long
  // the suite took to reach it.
  class FixedDate extends Date {
    constructor(...args: any[]) {
      // @ts-expect-error — forwarding a variadic Date constructor
      super(...(args.length ? args : [NOW]));
    }
    static now() {
      return NOW;
    }
  }

  factory(
    requireStub,
    module,
    module.exports,
    { env: { ...ENV, ...options.env } },
    { log: () => {}, error: () => {} },
    fetchStub,
    FixedDate,
  );

  if (!module.exports.handler) throw new Error('handler was not exported');

  const summary = await module.exports.handler();
  return { summary, calls, fetchCalls };
};

const deletedStacks = (calls: SdkCall[]): string[] =>
  calls.filter((c) => c.command === 'DeleteStackCommand').map((c) => c.input.StackName);

const droppedDatabases = (calls: SdkCall[]): string[] =>
  calls
    .filter((c) => c.command === 'RunTaskCommand')
    .map(
      (c) =>
        c.input.overrides.containerOverrides[0].environment.find(
          (e: { name: string }) => e.name === 'PREVIEW_DB_NAME',
        ).value,
    );

describe('preview reaper handler', () => {
  describe('what it will and will not touch', () => {
    it('deletes a preview whose pull request has closed', async () => {
      const { calls } = await run({
        stacks: [stackFixture({ prNumber: 42, ageHours: 2 })],
        pullRequests: { 42: 'closed' },
      });

      expect(deletedStacks(calls)).toEqual(['preview-pr-42']);
    });

    it('keeps a preview whose pull request is open, however long the review takes', async () => {
      const { summary, calls } = await run({
        stacks: [stackFixture({ prNumber: 42, ageHours: 100 })],
        pullRequests: { 42: 'open' },
      });

      expect(deletedStacks(calls)).toEqual([]);
      expect(summary.kept).toEqual([
        expect.objectContaining({ stackName: 'preview-pr-42', reason: 'pull-request-open' }),
      ]);
    });

    it('deletes an open pull request that has outlived the absolute limit', async () => {
      // GitHub is authoritative about whether work is finished, not about
      // whether an environment is still worth paying for.
      const { summary, calls } = await run({
        stacks: [stackFixture({ prNumber: 42, ageHours: 200 })],
        pullRequests: { 42: 'open' },
      });

      expect(deletedStacks(calls)).toEqual(['preview-pr-42']);
      expect(summary.deleted[0].reason).toBe('max-lifetime-exceeded');
    });

    it('never deletes the shared stack, even if somebody tags it', async () => {
      const { calls } = await run({
        stacks: [
          { ...stackFixture({ prNumber: 1 }), StackName: 'preview-shared' },
          stackFixture({ prNumber: 42 }),
        ],
        pullRequests: { 42: 'closed' },
      });

      expect(deletedStacks(calls)).toEqual(['preview-pr-42']);
    });

    it('ignores a stack without the marker tag', async () => {
      // The tag, the number, and the name prefix must all agree. Anything
      // less and a stack has to be mislabelled once to be destroyed.
      const { summary, calls } = await run({
        stacks: [stackFixture({ prNumber: 42, tagged: false })],
        pullRequests: { 42: 'closed' },
      });

      expect(deletedStacks(calls)).toEqual([]);
      expect(summary.examined).toBe(0);
    });

    it('ignores a stack without a usable pull request number', async () => {
      const { summary } = await run({
        stacks: [
          stackFixture({ prNumber: 42, untagged: true }),
          stackFixture({ name: 'preview-pr-x', prNumber: 'not-a-number' }),
        ],
      });

      expect(summary.examined).toBe(0);
    });

    it('ignores a stack outside the name prefix its IAM policy allows', async () => {
      const { summary } = await run({
        stacks: [{ ...stackFixture({ prNumber: 42 }), StackName: 'production-api' }],
        pullRequests: { 42: 'closed' },
      });

      expect(summary.examined).toBe(0);
    });

    it.each(['DELETE_IN_PROGRESS', 'DELETE_COMPLETE'])(
      'leaves a stack already in %s alone',
      async (status) => {
        const { summary } = await run({
          stacks: [stackFixture({ prNumber: 42, status })],
          pullRequests: { 42: 'closed' },
        });

        expect(summary.examined).toBe(0);
      },
    );

    it('retries a stack stuck in DELETE_FAILED', async () => {
      // A failed delete is the case most in need of another attempt, and its
      // status is not one of the two that mean "already handled".
      const { calls } = await run({
        stacks: [stackFixture({ prNumber: 42, status: 'DELETE_FAILED' })],
        pullRequests: { 42: 'closed' },
      });

      expect(deletedStacks(calls)).toEqual(['preview-pr-42']);
    });

    it('reads every page of stacks', async () => {
      const { calls } = await run({
        stacks: [
          stackFixture({ prNumber: 1 }),
          stackFixture({ prNumber: 2 }),
          stackFixture({ prNumber: 3 }),
        ],
        pullRequests: { 1: 'closed', 2: 'closed', 3: 'closed' },
        paginate: true,
      });

      expect(deletedStacks(calls).sort()).toEqual([
        'preview-pr-1',
        'preview-pr-2',
        'preview-pr-3',
      ]);
    });
  });

  describe('when GitHub cannot be reached', () => {
    it('keeps a recent preview rather than guessing it is closed', async () => {
      // An environment deleted mid-review because of a GitHub incident cannot
      // be given back. The lifetime bound still caps the cost of being wrong.
      const { summary, calls } = await run({
        stacks: [stackFixture({ prNumber: 42, ageHours: 10 })],
        pullRequests: {},
      });

      expect(deletedStacks(calls)).toEqual([]);
      expect(summary.kept[0].reason).toBe('within-limits');
    });

    it('deletes it once the unknown-state fallback has elapsed', async () => {
      const { summary, calls } = await run({
        stacks: [stackFixture({ prNumber: 42, ageHours: 80 })],
        pullRequests: {},
      });

      expect(deletedStacks(calls)).toEqual(['preview-pr-42']);
      expect(summary.deleted[0].reason).toBe('pull-request-state-unknown');
    });

    it('treats a 404 as unknown, not as closed', async () => {
      // A repository rename or a revoked token both look like a missing pull
      // request, and neither is evidence the work is finished.
      const { summary } = await run({
        stacks: [stackFixture({ prNumber: 42, ageHours: 10 })],
        pullRequests: {},
        env: { GITHUB_API_URL: 'https://api.github.com' },
      });

      expect(summary.deleted).toEqual([]);
    });

    it('does not call GitHub at all when no token secret is configured', async () => {
      const { fetchCalls, summary } = await run({
        stacks: [stackFixture({ prNumber: 42, ageHours: 10 })],
        env: { GITHUB_TOKEN_SECRET_ARN: '' },
      });

      expect(fetchCalls).toEqual([]);
      expect(summary.kept[0].reason).toBe('within-limits');
    });

    it('falls back to age when the secret holds no token', async () => {
      const { summary } = await run({
        stacks: [stackFixture({ prNumber: 42, ageHours: 80 })],
        githubUnavailable: true,
      });

      expect(summary.deleted[0].reason).toBe('pull-request-state-unknown');
    });
  });

  describe('dropping the database', () => {
    it('drops the pull request database before deleting the stack', async () => {
      // The reverse order would need the reaper to remember, across
      // invocations, which vanished stacks still owed a database.
      const { calls } = await run({
        stacks: [stackFixture({ prNumber: 42 })],
        pullRequests: { 42: 'closed' },
      });

      const ordered = calls
        .map((call) => call.command)
        .filter((name) => name === 'RunTaskCommand' || name === 'DeleteStackCommand');

      expect(ordered).toEqual(['RunTaskCommand', 'DeleteStackCommand']);
      expect(droppedDatabases(calls)).toEqual(['preview_pr_42']);
    });

    it('runs the drop in the shared cluster with private networking', async () => {
      const { calls } = await run({
        stacks: [stackFixture({ prNumber: 42 })],
        pullRequests: { 42: 'closed' },
      });

      const [runTask] = calls.filter((call) => call.command === 'RunTaskCommand');

      expect(runTask.input.cluster).toBe(ENV.DATABASE_ADMIN_CLUSTER);
      expect(runTask.input.networkConfiguration.awsvpcConfiguration).toEqual({
        subnets: ['subnet-aaaa1111', 'subnet-bbbb2222'],
        securityGroups: ['sg-cccc3333'],
        assignPublicIp: 'DISABLED',
      });
    });

    it('does not delete the stack when the drop could not be started', async () => {
      // Deleting anyway would strand the database with nothing left to name
      // it: the stack carrying the pull request number would be gone, and the
      // next sweep has no record that this one is owed a drop. Leaving the
      // stack in place is what makes the retry possible.
      const { summary, calls } = await run({
        stacks: [stackFixture({ prNumber: 42 })],
        pullRequests: { 42: 'closed' },
        dropFailures: ['preview_pr_42'],
      });

      expect(deletedStacks(calls)).toEqual([]);
      expect(summary.deleted).toEqual([]);
      expect(summary.failed[0]).toEqual(
        expect.objectContaining({ stackName: 'preview-pr-42', error: expect.stringMatching(/RunTask/) }),
      );
    });
  });

  describe('bounding the damage a bad sweep can do', () => {
    it('stops at the per-run cap and says what it did not get to', async () => {
      const stacks = [1, 2, 3, 4, 5].map((prNumber) => stackFixture({ prNumber, ageHours: 200 }));

      const { summary, calls } = await run({
        stacks,
        pullRequests: {},
        env: { MAX_DELETIONS_PER_RUN: '2' },
      });

      expect(deletedStacks(calls)).toHaveLength(2);
      expect(summary.deferredByCap).toHaveLength(3);
    });

    it('takes the oldest first, so a capped run reduces the bill fastest', async () => {
      const { calls } = await run({
        stacks: [
          stackFixture({ prNumber: 1, ageHours: 200 }),
          stackFixture({ prNumber: 2, ageHours: 400 }),
          stackFixture({ prNumber: 3, ageHours: 300 }),
        ],
        pullRequests: {},
        env: { MAX_DELETIONS_PER_RUN: '1' },
      });

      expect(deletedStacks(calls)).toEqual(['preview-pr-2']);
    });

    it('deletes nothing in dry-run mode but still reports the verdicts', async () => {
      const { summary, calls } = await run({
        stacks: [stackFixture({ prNumber: 42 })],
        pullRequests: { 42: 'closed' },
        env: { DRY_RUN: 'true' },
      });

      expect(deletedStacks(calls)).toEqual([]);
      expect(droppedDatabases(calls)).toEqual([]);
      expect(summary.kept[0].reason).toBe('dry-run:pull-request-closed');
    });

    it('keeps going after one deletion fails, and reports the failure', async () => {
      // One stack with a retained resource must not stop the sweep collecting
      // the others.
      const { summary, calls } = await run({
        stacks: [stackFixture({ prNumber: 1 }), stackFixture({ prNumber: 2 })],
        pullRequests: { 1: 'closed', 2: 'closed' },
        deleteFailures: ['preview-pr-1'],
      });

      expect(deletedStacks(calls)).toEqual(['preview-pr-1', 'preview-pr-2']);
      expect(summary.deleted.map((entry: { stackName: string }) => entry.stackName)).toEqual([
        'preview-pr-2',
      ]);
      expect(summary.failed[0]).toEqual(
        expect.objectContaining({ stackName: 'preview-pr-1', error: expect.any(String) }),
      );
    });
  });

  describe('notifications', () => {
    const publishes = (calls: SdkCall[]) => calls.filter((c) => c.command === 'PublishCommand');

    it('says nothing when a sweep finds nothing to do', async () => {
      // Hourly, forever. A notification per sweep is a notification nobody
      // reads by the second day.
      const { calls } = await run({
        stacks: [stackFixture({ prNumber: 42 })],
        pullRequests: { 42: 'open' },
      });

      expect(publishes(calls)).toEqual([]);
    });

    it('reports deletions', async () => {
      const { calls } = await run({
        stacks: [stackFixture({ prNumber: 42 })],
        pullRequests: { 42: 'closed' },
      });

      expect(publishes(calls)[0].input.Subject).toContain('deleted 1 environment');
    });

    it('reports failures in preference to deletions', async () => {
      const { calls } = await run({
        stacks: [stackFixture({ prNumber: 1 }), stackFixture({ prNumber: 2 })],
        pullRequests: { 1: 'closed', 2: 'closed' },
        deleteFailures: ['preview-pr-1'],
      });

      expect(publishes(calls)).toHaveLength(1);
      expect(publishes(calls)[0].input.Subject).toContain('1 deletion(s) failed');
    });
  });
});
