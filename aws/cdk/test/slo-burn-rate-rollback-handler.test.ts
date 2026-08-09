import { BURN_RATE_ROLLBACK_SOURCE } from '../lib/slo-burn-rate-rollback-stack';

/**
 * Behavioural tests for the inline rollback handler.
 *
 * `lambda.Code.fromInline` ships this as a string, so nothing else in the build
 * ever parses it: `tsc` sees a template literal and `cdk synth` embeds it
 * verbatim. Every decision in here is one that fails silently in the wrong
 * direction — a rollback that does not happen during an incident, or one that
 * pulls a healthy revision out of production — so the handler is compiled and
 * run against recording stubs rather than asserted on as text.
 */

interface SdkCall {
  readonly command: string;
  readonly input: Record<string, any>;
}

type Handler = (event: Record<string, any>) => Promise<any>;

/**
 * Build a stub AWS SDK module: every `XxxCommand` records its name and input,
 * and the client's `send` returns the responder's answer, so a test can assert
 * on exactly what the handler asked the API for.
 */
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
  source: string,
  env: Record<string, string>,
  modules: Record<string, unknown>,
): Handler => {
  const module = { exports: {} as { handler?: Handler } };
  const requireStub = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require: ${id}`);
    return modules[id];
  };

  const factory = new Function('require', 'module', 'exports', 'process', 'console', source);
  factory(requireStub, module, module.exports, { env }, { log: () => {}, error: () => {} });

  if (!module.exports.handler) throw new Error('handler was not exported');
  return module.exports.handler;
};

const ROLLING_TARGET = {
  clusterName: 'test-cluster',
  serviceName: 'test-service',
};

const CODEDEPLOY_TARGET = {
  clusterName: 'test-bg-cluster',
  serviceName: 'test-bg-service',
  codeDeployApplication: 'test-ecs-app',
  codeDeployDeploymentGroup: 'test-ecs-dg',
};

const ENV = {
  AWS_REGION: 'us-east-1',
  LOAD_BALANCER_FULL_NAME: 'app/test-alb/1111111111111111',
  TARGET_GROUP_FULL_NAME: 'targetgroup/test-tg/2222222222222222',
  SLO_TARGET: '0.999',
  SLO_WINDOW_DAYS: '30',
  MINIMUM_REQUESTS_PER_WINDOW: '60',
  ROLLBACK_POLICIES: JSON.stringify([
    {
      alarmName: 'test-slo-burn-rate-fast',
      name: 'fast',
      burnRate: 14.4,
      longWindowMinutes: 60,
      shortWindowMinutes: 5,
    },
  ]),
  ROLLBACK_TARGETS: JSON.stringify([ROLLING_TARGET]),
  DEPLOYMENT_ATTRIBUTION_WINDOW_MINUTES: '120',
  SNS_TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:test-slo-burn-rate-notifications',
  ENV_NAME: 'test',
};

const ALARM_EVENT = {
  source: 'aws.cloudwatch',
  'detail-type': 'CloudWatch Alarm State Change',
  detail: { alarmName: 'test-slo-burn-rate-fast', state: { value: 'ALARM' } },
};

const TASK_DEF_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/test-app:42';

/** Requests and 5xx counts per window, keyed by the window length in minutes. */
interface MetricWindows {
  readonly [minutes: number]: { requests: number; targetErrors?: number; elbErrors?: number };
}

interface ServiceState {
  /** Minutes since the PRIMARY deployment was created. */
  readonly deploymentAgeMinutes?: number | null;
  readonly rolloutState?: string;
  readonly taskDefinition?: string;
  /** Return no service at all, as ECS does for a deleted one. */
  readonly missing?: boolean;
  readonly noPrimary?: boolean;
}

const HEALTHY_SERVICE: ServiceState = {
  deploymentAgeMinutes: 10,
  rolloutState: 'COMPLETED',
  taskDefinition: TASK_DEF_ARN,
};

/**
 * A burn well over the fast threshold: 5% of requests failing is a 50x burn
 * against a 0.001 budget.
 */
const BURNING: MetricWindows = {
  5: { requests: 1000, targetErrors: 50 },
  60: { requests: 12000, targetErrors: 600 },
  43200: { requests: 5_000_000, targetErrors: 2500 },
};

const runHandler = async (options: {
  metrics?: MetricWindows;
  service?: ServiceState;
  env?: Partial<typeof ENV>;
  event?: Record<string, any>;
  codeDeployDeployments?: string[];
  failUpdateService?: string;
} = {}) => {
  const metrics = options.metrics ?? BURNING;
  const service = { ...HEALTHY_SERVICE, ...(options.service ?? {}) };
  const calls: SdkCall[] = [];
  const now = Date.now();

  const cloudwatch = makeSdkModule(
    ['GetMetricDataCommand'],
    calls,
    (call) => {
      const minutes = Math.round(
        ((call.input.EndTime as Date).getTime() - (call.input.StartTime as Date).getTime()) / 60000,
      );
      const window = metrics[minutes] ?? { requests: 0 };
      const valueFor = (id: string) => {
        if (id === 'requests') return window.requests;
        if (id === 'targetErrors') return window.targetErrors ?? 0;
        return window.elbErrors ?? 0;
      };
      return {
        MetricDataResults: (call.input.MetricDataQueries as { Id: string }[]).map((query) => ({
          Id: query.Id,
          Values: [valueFor(query.Id)],
        })),
      };
    },
    ['CloudWatchClient'],
  );

  const ecs = makeSdkModule(
    ['DescribeServicesCommand', 'UpdateServiceCommand'],
    calls,
    (call) => {
      if (call.command === 'UpdateServiceCommand') {
        if (options.failUpdateService) throw new Error(options.failUpdateService);
        return {};
      }
      if (service.missing) return { services: [] };
      const createdAt =
        service.deploymentAgeMinutes === null || service.deploymentAgeMinutes === undefined
          ? undefined
          : new Date(now - service.deploymentAgeMinutes * 60000);
      return {
        services: [
          {
            serviceName: (call.input.services as string[])[0],
            taskDefinition: service.taskDefinition,
            deployments: service.noPrimary
              ? [{ status: 'ACTIVE', rolloutState: 'COMPLETED', createdAt }]
              : [{ status: 'PRIMARY', rolloutState: service.rolloutState, createdAt }],
          },
        ],
      };
    },
    ['ECSClient'],
  );

  const codedeploy = makeSdkModule(
    ['ListDeploymentsCommand', 'StopDeploymentCommand'],
    calls,
    (call) =>
      call.command === 'ListDeploymentsCommand'
        ? { deploymentIds: options.codeDeployDeployments ?? [] }
        : {},
    ['CodeDeployClient'],
  );

  const sns = makeSdkModule(['PublishCommand'], calls, () => ({}), ['SNSClient']);

  const handler = loadHandler(
    BURN_RATE_ROLLBACK_SOURCE,
    { ...ENV, ...(options.env ?? {}) },
    {
      '@aws-sdk/client-cloudwatch': cloudwatch,
      '@aws-sdk/client-ecs': ecs,
      '@aws-sdk/client-codedeploy': codedeploy,
      '@aws-sdk/client-sns': sns,
    },
  );

  const result = await handler(options.event ?? ALARM_EVENT);
  return { result, calls };
};

const commandsOf = (calls: SdkCall[], command: string) =>
  calls.filter((call) => call.command === command);

describe('SLO burn-rate rollback handler', () => {
  describe('burn-rate arithmetic', () => {
    it('reports the error ratio as a multiple of the error budget', async () => {
      // 50 failures in 1000 requests is a 5% error ratio. Against a 0.001
      // budget (99.9%) that is 50x, not "5% of requests".
      const { result } = await runHandler();
      expect(result.shortWindow.burnRate).toBe(50);
      expect(result.longWindow.burnRate).toBe(50);
    });

    it('scales the burn rate with the objective', async () => {
      // The same 5% error ratio against a 99.5% objective is a 10x burn.
      const { result } = await runHandler({ env: { SLO_TARGET: '0.995' } });
      expect(result.shortWindow.burnRate).toBe(10);
    });

    it('counts ELB-generated 5xx alongside target 5xx', async () => {
      const { result } = await runHandler({
        metrics: {
          5: { requests: 1000, targetErrors: 10, elbErrors: 40 },
          60: { requests: 12000, targetErrors: 600 },
          43200: { requests: 5_000_000, targetErrors: 2500 },
        },
      });
      expect(result.shortWindow.errors).toBe(50);
      expect(result.shortWindow.burnRate).toBe(50);
    });

    it('reports remaining error budget over the SLO window', async () => {
      // 2500 failures in 5,000,000 requests is a 0.05% error ratio — half the
      // 0.1% the objective affords, so half the budget is left.
      const { result } = await runHandler();
      expect(result.errorBudget.consumedPercent).toBe(50);
      expect(result.errorBudget.remainingPercent).toBe(50);
    });

    it('clamps remaining budget at zero once it is overspent', async () => {
      const { result } = await runHandler({
        metrics: {
          5: { requests: 1000, targetErrors: 50 },
          60: { requests: 12000, targetErrors: 600 },
          43200: { requests: 1_000_000, targetErrors: 5000 },
        },
      });
      expect(result.errorBudget.consumedPercent).toBe(500);
      expect(result.errorBudget.remainingPercent).toBe(0);
    });

    it('reads the SLO window at an hourly period so it fits in one query', async () => {
      const { calls } = await runHandler();
      const sloQuery = commandsOf(calls, 'GetMetricDataCommand').find(
        (call) =>
          Math.round(
            ((call.input.EndTime as Date).getTime() - (call.input.StartTime as Date).getTime()) /
              60000,
          ) === 43200,
      );
      expect(sloQuery).toBeDefined();
      expect(sloQuery!.input.MetricDataQueries[0].MetricStat.Period).toBe(3600);
    });

    it('reads each policy window at a period equal to the window', async () => {
      const { calls } = await runHandler();
      for (const call of commandsOf(calls, 'GetMetricDataCommand')) {
        const minutes = Math.round(
          ((call.input.EndTime as Date).getTime() - (call.input.StartTime as Date).getTime()) /
            60000,
        );
        if (minutes === 43200) continue;
        expect(call.input.MetricDataQueries[0].MetricStat.Period).toBe(minutes * 60);
      }
    });
  });

  describe('traffic floor', () => {
    it('reports a zero burn rate below the minimum request count', async () => {
      // One failure out of three is a 33% error ratio and a 333x burn on paper.
      // Every quiet night would roll back production without the floor.
      const { result, calls } = await runHandler({
        metrics: {
          5: { requests: 3, targetErrors: 1 },
          60: { requests: 40, targetErrors: 2 },
          43200: { requests: 5_000_000, targetErrors: 2500 },
        },
      });
      expect(result.shortWindow.burnRate).toBe(0);
      expect(result.decision).toBe('ABORTED_BURN_RECOVERED');
      expect(commandsOf(calls, 'UpdateServiceCommand')).toHaveLength(0);
    });

    it('uses the configured floor rather than a hardcoded one', async () => {
      const { result } = await runHandler({
        env: { MINIMUM_REQUESTS_PER_WINDOW: '2000' },
      });
      // 1000 requests is now below the floor, so the same burn reads as zero.
      expect(result.shortWindow.burnRate).toBe(0);
    });

    it('does not divide by zero on a window with no traffic at all', async () => {
      const { result } = await runHandler({
        metrics: { 5: { requests: 0 }, 60: { requests: 0 }, 43200: { requests: 0 } },
      });
      expect(result.shortWindow.burnRate).toBe(0);
      expect(result.errorBudget.consumedPercent).toBe(0);
      expect(result.errorBudget.remainingPercent).toBe(100);
    });
  });

  describe('recovery check', () => {
    it('aborts when the short window has fallen back under the threshold', async () => {
      // The long window stays high for another hour after an incident ends —
      // that is what it is for. Rolling back now would be a deployment during
      // recovery.
      const { result, calls } = await runHandler({
        metrics: {
          5: { requests: 1000, targetErrors: 1 },
          60: { requests: 12000, targetErrors: 600 },
          43200: { requests: 5_000_000, targetErrors: 2500 },
        },
      });
      expect(result.decision).toBe('ABORTED_BURN_RECOVERED');
      expect(result.rolledBack).toEqual([]);
      expect(commandsOf(calls, 'DescribeServicesCommand')).toHaveLength(0);
    });

    it('still notifies when it aborts', async () => {
      const { calls } = await runHandler({
        metrics: {
          5: { requests: 1000, targetErrors: 1 },
          60: { requests: 12000, targetErrors: 600 },
          43200: { requests: 5_000_000, targetErrors: 2500 },
        },
      });
      expect(commandsOf(calls, 'PublishCommand')).toHaveLength(1);
    });

    it('aborts on a burn sitting exactly at the threshold', async () => {
      // 1440 failures in 100,000 requests is a 1.44% ratio — exactly 14.4x
      // against a 0.001 budget. The alarm compares GreaterThanThreshold, so
      // that burn did not fire it, and it must not justify a rollback here.
      const { result } = await runHandler({
        metrics: {
          5: { requests: 100000, targetErrors: 1440 },
          60: { requests: 100000, targetErrors: 1440 },
          43200: { requests: 5_000_000, targetErrors: 2500 },
        },
      });
      expect(result.shortWindow.burnRate).toBe(14.4);
      expect(result.decision).toBe('ABORTED_BURN_RECOVERED');
    });

    it('proceeds on a burn just above the threshold', async () => {
      const { result } = await runHandler({
        metrics: {
          5: { requests: 100000, targetErrors: 1450 },
          60: { requests: 100000, targetErrors: 1450 },
          43200: { requests: 5_000_000, targetErrors: 2500 },
        },
      });
      expect(result.shortWindow.burnRate).toBe(14.5);
      expect(result.decision).toBe('ROLLBACK');
    });
  });

  describe('deployment attribution', () => {
    it('rolls back a service that deployed inside the attribution window', async () => {
      const { result, calls } = await runHandler({ service: { deploymentAgeMinutes: 30 } });

      expect(result.decision).toBe('ROLLBACK');
      expect(result.rolledBack).toEqual(['test-service']);

      const [update] = commandsOf(calls, 'UpdateServiceCommand');
      expect(update.input).toMatchObject({
        cluster: 'test-cluster',
        service: 'test-service',
        taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/test-app:41',
        forceNewDeployment: true,
      });
    });

    it('leaves a service alone when nothing has deployed recently', async () => {
      // Burning budget is a symptom; a rollback only treats it if a deployment
      // caused it. A week-old revision is not the cause of today's incident.
      const { result, calls } = await runHandler({
        service: { deploymentAgeMinutes: 7 * 24 * 60 },
      });

      expect(result.skipped).toEqual(['test-service (NO_RECENT_DEPLOYMENT)']);
      expect(result.rolledBack).toEqual([]);
      expect(commandsOf(calls, 'UpdateServiceCommand')).toHaveLength(0);
    });

    it('honours a widened attribution window', async () => {
      const { result } = await runHandler({
        service: { deploymentAgeMinutes: 7 * 24 * 60 },
        env: { DEPLOYMENT_ATTRIBUTION_WINDOW_MINUTES: '20160' },
      });
      expect(result.rolledBack).toEqual(['test-service']);
    });

    it('rolls back regardless of deployment age when attribution is disabled', async () => {
      const { result } = await runHandler({
        service: { deploymentAgeMinutes: 7 * 24 * 60 },
        env: { DEPLOYMENT_ATTRIBUTION_WINDOW_MINUTES: '0' },
      });
      expect(result.rolledBack).toEqual(['test-service']);
    });

    it('refuses to roll back a deployment whose age it cannot establish', async () => {
      // Attribution is the whole reason for the check; rolling back anyway
      // would be exactly the alarm-state behaviour this replaces.
      const { result } = await runHandler({ service: { deploymentAgeMinutes: null } });
      expect(result.skipped).toEqual(['test-service (DEPLOYMENT_AGE_UNKNOWN)']);
    });

    it('records the deployment age it decided on in the notification', async () => {
      const { calls } = await runHandler({ service: { deploymentAgeMinutes: 30 } });
      const [publish] = commandsOf(calls, 'PublishCommand');
      // Rounded to a tenth of a minute, and the stub's clock is read a moment
      // before the handler's, so match the whole-minute part only.
      expect(publish.input.Message).toMatch(/"deploymentAgeMinutes": 30(\.\d)?/);
    });

    it('does not describe an ECS service for a CodeDeploy target', async () => {
      // CodeDeploy owns that service's rollout, so the ECS-side deployment
      // state says nothing about it — and the call is a failure mode on a path
      // that only ever runs during an incident.
      const { calls } = await runHandler({
        env: { ROLLBACK_TARGETS: JSON.stringify([CODEDEPLOY_TARGET]) },
        codeDeployDeployments: ['d-ABC123'],
      });
      expect(commandsOf(calls, 'DescribeServicesCommand')).toHaveLength(0);
    });
  });

  describe('in-flight deployment guard', () => {
    it('skips a service whose deployment is still rolling out', async () => {
      // Covers both a deploy the ECS circuit breaker still owns and a rollback
      // this handler issued on a previous alarm transition. Issuing another
      // would walk the service backwards a revision per alarm re-fire.
      const { result, calls } = await runHandler({
        service: { rolloutState: 'IN_PROGRESS' },
      });
      expect(result.skipped).toEqual(['test-service (DEPLOYMENT_IN_PROGRESS)']);
      expect(commandsOf(calls, 'UpdateServiceCommand')).toHaveLength(0);
    });

    it('skips a service with no primary deployment', async () => {
      const { result } = await runHandler({ service: { noPrimary: true } });
      expect(result.skipped).toEqual(['test-service (NO_PRIMARY_DEPLOYMENT)']);
    });

    it('skips a service that no longer exists', async () => {
      const { result } = await runHandler({ service: { missing: true } });
      expect(result.skipped).toEqual(['test-service (SERVICE_NOT_FOUND)']);
    });

    it('skips a service already at its first task-definition revision', async () => {
      const { result } = await runHandler({
        service: {
          taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/test-app:1',
        },
      });
      expect(result.skipped).toEqual(['test-service (ALREADY_AT_FIRST_REVISION)']);
    });
  });

  describe('CodeDeploy targets', () => {
    it('stops the in-progress deployment with auto-rollback enabled', async () => {
      const { result, calls } = await runHandler({
        env: { ROLLBACK_TARGETS: JSON.stringify([CODEDEPLOY_TARGET]) },
        codeDeployDeployments: ['d-ABC123'],
      });

      expect(result.rolledBack).toEqual(['test-bg-service']);
      const [stop] = commandsOf(calls, 'StopDeploymentCommand');
      expect(stop.input).toEqual({ deploymentId: 'd-ABC123', autoRollbackEnabled: true });
      // Traffic shifts back via the deployment group's own rollback config, so
      // the ECS service task definition is never touched directly.
      expect(commandsOf(calls, 'UpdateServiceCommand')).toHaveLength(0);
    });

    it('lists only in-progress deployments for the configured group', async () => {
      const { calls } = await runHandler({
        env: { ROLLBACK_TARGETS: JSON.stringify([CODEDEPLOY_TARGET]) },
        codeDeployDeployments: ['d-ABC123'],
      });
      const [list] = commandsOf(calls, 'ListDeploymentsCommand');
      expect(list.input).toEqual({
        applicationName: 'test-ecs-app',
        deploymentGroupName: 'test-ecs-dg',
        includeOnlyStatuses: ['InProgress'],
      });
    });

    it('skips when CodeDeploy has nothing in flight', async () => {
      const { result } = await runHandler({
        env: { ROLLBACK_TARGETS: JSON.stringify([CODEDEPLOY_TARGET]) },
        codeDeployDeployments: [],
      });
      expect(result.skipped).toEqual(['test-bg-service (NO_IN_PROGRESS_DEPLOYMENT)']);
    });

    it('handles rolling and CodeDeploy targets in the same run', async () => {
      const { result, calls } = await runHandler({
        env: { ROLLBACK_TARGETS: JSON.stringify([ROLLING_TARGET, CODEDEPLOY_TARGET]) },
        codeDeployDeployments: ['d-ABC123'],
      });
      expect(result.rolledBack).toEqual(['test-service', 'test-bg-service']);
      expect(commandsOf(calls, 'UpdateServiceCommand')).toHaveLength(1);
      expect(commandsOf(calls, 'StopDeploymentCommand')).toHaveLength(1);
    });
  });

  describe('unknown alarms', () => {
    it('ignores an alarm it has no policy for rather than guessing', async () => {
      const { result, calls } = await runHandler({
        event: { detail: { alarmName: 'some-other-alarm', state: { value: 'ALARM' } } },
      });
      expect(result).toEqual({
        alarmName: 'some-other-alarm',
        action: 'IGNORED',
        reason: 'UNKNOWN_ALARM',
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('notification', () => {
    it('publishes the burn rate, the budget, and what it did', async () => {
      const { calls } = await runHandler({ service: { deploymentAgeMinutes: 30 } });
      const [publish] = commandsOf(calls, 'PublishCommand');

      expect(publish.input.TopicArn).toBe(ENV.SNS_TOPIC_ARN);
      expect(publish.input.Subject).toBe('[TEST] SLO burn rate fast: ROLLBACK');
      expect(publish.input.Message).toContain('Burn rate 50x over 5m (50/1000 requests failed)');
      expect(publish.input.Message).toContain('50% remaining of the 30-day budget');
      expect(publish.input.Message).toContain('Rolled back: test-service');
    });

    it('does not let a failed notification hide a successful rollback', async () => {
      const calls: SdkCall[] = [];
      const handler = loadHandler(BURN_RATE_ROLLBACK_SOURCE, ENV, {
        '@aws-sdk/client-cloudwatch': makeSdkModule(
          ['GetMetricDataCommand'],
          calls,
          (call) => ({
            MetricDataResults: (call.input.MetricDataQueries as { Id: string }[]).map((query) => ({
              Id: query.Id,
              Values: [query.Id === 'requests' ? 1000 : query.Id === 'targetErrors' ? 50 : 0],
            })),
          }),
          ['CloudWatchClient'],
        ),
        '@aws-sdk/client-ecs': makeSdkModule(
          ['DescribeServicesCommand', 'UpdateServiceCommand'],
          calls,
          (call) =>
            call.command === 'UpdateServiceCommand'
              ? {}
              : {
                  services: [
                    {
                      taskDefinition: TASK_DEF_ARN,
                      deployments: [
                        {
                          status: 'PRIMARY',
                          rolloutState: 'COMPLETED',
                          createdAt: new Date(Date.now() - 10 * 60000),
                        },
                      ],
                    },
                  ],
                },
          ['ECSClient'],
        ),
        '@aws-sdk/client-codedeploy': makeSdkModule(
          ['ListDeploymentsCommand', 'StopDeploymentCommand'],
          calls,
          () => ({}),
          ['CodeDeployClient'],
        ),
        '@aws-sdk/client-sns': makeSdkModule(
          ['PublishCommand'],
          calls,
          () => {
            throw new Error('SNS is down');
          },
          ['SNSClient'],
        ),
      });

      const result = await handler(ALARM_EVENT);
      expect(result.rolledBack).toEqual(['test-service']);
      expect(commandsOf(calls, 'UpdateServiceCommand')).toHaveLength(1);
    });
  });

  describe('failures', () => {
    it('throws after notifying when a rollback call fails', async () => {
      // EventBridge retries on the throw, and the notification has already gone
      // out — an operator learns about the failed rollback either way.
      await expect(
        runHandler({ failUpdateService: 'AccessDeniedException' }),
      ).rejects.toThrow(/test-service: AccessDeniedException/);
    });

    it('notifies before it throws', async () => {
      const calls: SdkCall[] = [];
      let published = 0;
      const handler = loadHandler(BURN_RATE_ROLLBACK_SOURCE, ENV, {
        '@aws-sdk/client-cloudwatch': makeSdkModule(
          ['GetMetricDataCommand'],
          calls,
          (call) => ({
            MetricDataResults: (call.input.MetricDataQueries as { Id: string }[]).map((query) => ({
              Id: query.Id,
              Values: [query.Id === 'requests' ? 1000 : query.Id === 'targetErrors' ? 50 : 0],
            })),
          }),
          ['CloudWatchClient'],
        ),
        '@aws-sdk/client-ecs': makeSdkModule(
          ['DescribeServicesCommand', 'UpdateServiceCommand'],
          calls,
          () => {
            throw new Error('ClusterNotFoundException');
          },
          ['ECSClient'],
        ),
        '@aws-sdk/client-codedeploy': makeSdkModule(
          ['ListDeploymentsCommand', 'StopDeploymentCommand'],
          calls,
          () => ({}),
          ['CodeDeployClient'],
        ),
        '@aws-sdk/client-sns': makeSdkModule(
          ['PublishCommand'],
          calls,
          () => {
            published += 1;
            return {};
          },
          ['SNSClient'],
        ),
      });

      await expect(handler(ALARM_EVENT)).rejects.toThrow(/ClusterNotFoundException/);
      expect(published).toBe(1);
    });

    it('keeps going after one target fails so the others still roll back', async () => {
      const calls: SdkCall[] = [];
      const handler = loadHandler(
        BURN_RATE_ROLLBACK_SOURCE,
        { ...ENV, ROLLBACK_TARGETS: JSON.stringify([ROLLING_TARGET, CODEDEPLOY_TARGET]) },
        {
          '@aws-sdk/client-cloudwatch': makeSdkModule(
            ['GetMetricDataCommand'],
            calls,
            (call) => ({
              MetricDataResults: (call.input.MetricDataQueries as { Id: string }[]).map((query) => ({
                Id: query.Id,
                Values: [query.Id === 'requests' ? 1000 : query.Id === 'targetErrors' ? 50 : 0],
              })),
            }),
            ['CloudWatchClient'],
          ),
          '@aws-sdk/client-ecs': makeSdkModule(
            ['DescribeServicesCommand', 'UpdateServiceCommand'],
            calls,
            () => {
              throw new Error('ClusterNotFoundException');
            },
            ['ECSClient'],
          ),
          '@aws-sdk/client-codedeploy': makeSdkModule(
            ['ListDeploymentsCommand', 'StopDeploymentCommand'],
            calls,
            (call) =>
              call.command === 'ListDeploymentsCommand' ? { deploymentIds: ['d-ABC123'] } : {},
            ['CodeDeployClient'],
          ),
          '@aws-sdk/client-sns': makeSdkModule(['PublishCommand'], calls, () => ({}), ['SNSClient']),
        },
      );

      await expect(handler(ALARM_EVENT)).rejects.toThrow(/test-service: ClusterNotFoundException/);
      expect(commandsOf(calls, 'StopDeploymentCommand')).toHaveLength(1);
    });
  });
});
