import { CONTROLLER_SOURCE, ANALYZER_SOURCE } from '../lib/canary-deploy-stack';

/**
 * Behavioural tests for the two inline Lambda handlers.
 *
 * `lambda.Code.fromInline` ships these as strings, so nothing in the normal CDK
 * pipeline ever parses them, let alone runs them: `tsc` sees a template
 * literal, and `cdk synth` embeds it verbatim. A typo or an inverted comparison
 * would first surface as a failed production deployment — and for the analyzer,
 * a wrong comparison does not fail loudly at all, it just promotes a bad
 * revision or rolls back a good one.
 *
 * Each handler is loaded into a function scope with `require` and `process`
 * supplied as parameters, so the AWS SDK clients can be replaced by recording
 * stubs without touching the module registry.
 */

interface SdkCall {
  readonly command: string;
  readonly input: Record<string, any>;
}

type Handler = (event: Record<string, any>) => Promise<any>;

/**
 * Build a stub AWS SDK module.
 *
 * Every `XxxCommand` constructor stores its name and input, and the client's
 * `send` records the call and returns the next queued response, so a test can
 * assert on exactly what the handler asked the API for.
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

  // The handler source is a string by construction (lambda.Code.fromInline),
  // so compiling it here is the only way to run it at all.
  const factory = new Function('require', 'module', 'exports', 'process', 'console', source);
  factory(requireStub, module, module.exports, { env }, { log: () => {}, error: () => {} });

  if (!module.exports.handler) throw new Error('handler was not exported');
  return module.exports.handler;
};

// ── Analyzer ──────────────────────────────────────────────────────────────────

const ANALYZER_ENV = {
  AWS_REGION: 'us-east-1',
  LOAD_BALANCER_FULL_NAME: 'app/test-canary-alb/abc123',
  STABLE_TARGET_GROUP_FULL_NAME: 'targetgroup/test-stable-tg/aaa',
  CANARY_TARGET_GROUP_FULL_NAME: 'targetgroup/test-canary-tg/bbb',
  MAX_ERROR_RATE_PERCENT: '1',
  MAX_LATENCY_MS: '1000',
  ERROR_RATE_TOLERANCE_MULTIPLIER: '2',
  LATENCY_TOLERANCE_MULTIPLIER: '1.5',
  MINIMUM_REQUEST_COUNT: '100',
  INCONCLUSIVE_VERDICT: 'fail',
  LATENCY_STATISTIC: 'p95',
  ENV_NAME: 'test',
};

interface Window {
  canaryRequests?: number[];
  canaryErrors?: number[];
  /** Seconds, as CloudWatch publishes TargetResponseTime. */
  canaryLatency?: number[];
  canaryUnhealthy?: number[];
  stableRequests?: number[];
  stableErrors?: number[];
  stableLatency?: number[];
}

/** A window with no problems: plenty of traffic, no errors, fast. */
const HEALTHY: Window = {
  canaryRequests: [1000],
  canaryErrors: [0],
  canaryLatency: [0.1],
  canaryUnhealthy: [0],
  stableRequests: [9000],
  stableErrors: [0],
  stableLatency: [0.1],
};

const runAnalyzer = async (
  window: Window,
  envOverrides: Partial<typeof ANALYZER_ENV> = {},
  event: Record<string, any> = { canaryWeight: 10, windowSeconds: 300 },
) => {
  const calls: SdkCall[] = [];
  const values = { ...HEALTHY, ...window };

  const modules = {
    '@aws-sdk/client-cloudwatch': makeSdkModule(
      ['GetMetricDataCommand'],
      calls,
      (call) => ({
        MetricDataResults: (call.input.MetricDataQueries as { Id: string }[]).map((query) => ({
          Id: query.Id,
          Values: (values as Record<string, number[] | undefined>)[query.Id] ?? [],
        })),
      }),
      ['CloudWatchClient'],
    ),
  };

  const handler = loadHandler(ANALYZER_SOURCE, { ...ANALYZER_ENV, ...envOverrides }, modules);
  const result = await handler(event);
  return { result, calls };
};

describe('canary analyzer handler', () => {
  it('passes a window with plenty of traffic, no errors, and low latency', async () => {
    const { result } = await runAnalyzer({});
    expect(result.verdict).toBe('PASS');
    expect(result.reasons).toEqual([]);
    expect(result.inconclusive).toBe(false);
  });

  it('queries both target groups over the bake window', async () => {
    const { calls } = await runAnalyzer({}, {}, { canaryWeight: 10, windowSeconds: 600 });

    expect(calls).toHaveLength(1);
    const queries = calls[0].input.MetricDataQueries as any[];
    expect(queries.map((q) => q.Id).sort()).toEqual([
      'canaryErrors',
      'canaryLatency',
      'canaryRequests',
      'canaryUnhealthy',
      'stableErrors',
      'stableLatency',
      'stableRequests',
    ]);

    const window =
      (calls[0].input.EndTime as Date).getTime() - (calls[0].input.StartTime as Date).getTime();
    expect(window).toBe(600_000);
    // Period must be a multiple of 60 for a window this long.
    expect(queries[0].MetricStat.Period % 60).toBe(0);
  });

  it('reads latency at the configured percentile', async () => {
    const { calls } = await runAnalyzer({}, { LATENCY_STATISTIC: 'p99' });
    const queries = calls[0].input.MetricDataQueries as any[];
    const latency = queries.find((q) => q.Id === 'canaryLatency');
    expect(latency.MetricStat.Stat).toBe('p99');
  });

  it('fails a canary above the absolute error-rate ceiling', async () => {
    // 30 errors in 1000 requests is 3%, over the 1% ceiling.
    const { result } = await runAnalyzer({ canaryErrors: [30] });

    expect(result.verdict).toBe('FAIL');
    expect(result.reasons.join(' ')).toMatch(/error rate 3% exceeds the maximum of 1%/);
    expect(result.metrics.canaryErrorRatePercent).toBe(3);
  });

  it('fails a canary that is disproportionately worse than stable', async () => {
    // 0.8% canary vs 0.1% stable: under the 1% ceiling, but 8× stable.
    const { result } = await runAnalyzer({
      canaryErrors: [8],
      stableErrors: [9],
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.reasons.join(' ')).toMatch(/more than 2x the stable rate/);
  });

  it('does not hold a canary against a stable group that is equally broken', async () => {
    // Both at 0.5%: a regression relative to nothing, and under the ceiling.
    const { result } = await runAnalyzer({
      canaryErrors: [5],
      stableErrors: [45],
    });

    expect(result.verdict).toBe('PASS');
  });

  it('fails a canary above the absolute latency ceiling', async () => {
    // 1.2 seconds published → 1200ms, over the 1000ms ceiling.
    const { result } = await runAnalyzer({ canaryLatency: [1.2], stableLatency: [1.2] });

    expect(result.verdict).toBe('FAIL');
    expect(result.reasons.join(' ')).toMatch(/p95 latency 1200ms exceeds the maximum of 1000ms/);
    expect(result.metrics.canaryLatencyMs).toBe(1200);
  });

  it('fails a canary meaningfully slower than stable', async () => {
    // 300ms vs 100ms is 3×, past the 1.5× tolerance, but under the ceiling.
    const { result } = await runAnalyzer({ canaryLatency: [0.3], stableLatency: [0.1] });

    expect(result.verdict).toBe('FAIL');
    expect(result.reasons.join(' ')).toMatch(/more than 1.5x the stable latency/);
  });

  it('allows latency within the tolerance', async () => {
    // 140ms vs 100ms is 1.4×, inside the 1.5× tolerance.
    const { result } = await runAnalyzer({ canaryLatency: [0.14], stableLatency: [0.1] });
    expect(result.verdict).toBe('PASS');
  });

  it('averages percentile readings across the periods in the window', async () => {
    const { result } = await runAnalyzer({ canaryLatency: [0.1, 0.3], stableLatency: [0.2] });
    expect(result.metrics.canaryLatencyMs).toBe(200);
  });

  it('sums counts across the periods in the window', async () => {
    const { result } = await runAnalyzer({ canaryRequests: [400, 600], canaryErrors: [1, 2] });
    expect(result.metrics.canaryRequests).toBe(1000);
    expect(result.metrics.canaryErrors).toBe(3);
  });

  describe('too little traffic to judge', () => {
    it('fails by default rather than promoting an unmeasured canary', async () => {
      const { result } = await runAnalyzer({ canaryRequests: [12], canaryErrors: [0] });

      expect(result.verdict).toBe('FAIL');
      expect(result.inconclusive).toBe(true);
      expect(result.reasons.join(' ')).toMatch(/below the minimum of 100/);
    });

    it('promotes when the environment opts into it', async () => {
      const { result } = await runAnalyzer(
        { canaryRequests: [12], canaryErrors: [0] },
        { INCONCLUSIVE_VERDICT: 'pass' },
      );

      expect(result.verdict).toBe('PASS');
      expect(result.inconclusive).toBe(true);
    });

    it('still fails on unhealthy targets even in pass mode', async () => {
      const { result } = await runAnalyzer(
        { canaryRequests: [12], canaryUnhealthy: [2] },
        { INCONCLUSIVE_VERDICT: 'pass' },
      );

      expect(result.verdict).toBe('FAIL');
      expect(result.reasons.join(' ')).toMatch(/2 canary target\(s\) reported unhealthy/);
    });
  });

  it('fails on unhealthy canary targets even when the metrics look fine', async () => {
    const { result } = await runAnalyzer({ canaryUnhealthy: [1] });

    expect(result.verdict).toBe('FAIL');
    expect(result.reasons.join(' ')).toMatch(/reported unhealthy/);
  });

  it('skips the relative checks when stable has too little traffic of its own', async () => {
    // Stable served 10 requests with 5 errors (50%); comparing against that
    // would be noise, so only the absolute checks should apply — and the canary
    // passes those.
    const { result } = await runAnalyzer({ stableRequests: [10], stableErrors: [5] });
    expect(result.verdict).toBe('PASS');
  });

  it('reports a canary with no traffic at all as inconclusive, not as zero errors', async () => {
    const { result } = await runAnalyzer({ canaryRequests: [], canaryErrors: [], canaryLatency: [] });

    expect(result.verdict).toBe('FAIL');
    expect(result.inconclusive).toBe(true);
    expect(result.metrics.canaryLatencyMs).toBeNull();
  });

  it('echoes the weight it judged so the execution history explains itself', async () => {
    const { result } = await runAnalyzer({}, {}, { canaryWeight: 25, windowSeconds: 120 });

    expect(result.metrics.canaryWeight).toBe(25);
    expect(result.metrics.windowSeconds).toBe(120);
    expect(result.metrics.latencyStatistic).toBe('p95');
  });
});

// ── Controller ────────────────────────────────────────────────────────────────

const CONTROLLER_ENV = {
  AWS_REGION: 'us-east-1',
  LISTENER_ARN: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/test/aaa/bbb',
  STABLE_TARGET_GROUP_ARN: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/test-stable-tg/aaa',
  CANARY_TARGET_GROUP_ARN: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/test-canary-tg/bbb',
  CLUSTER_NAME: 'test-canary-cluster',
  STABLE_SERVICE_NAME: 'test-stable-service',
  CANARY_SERVICE_NAME: 'test-canary-service',
  CANARY_DESIRED_COUNT: '2',
  ENV_NAME: 'test',
};

const STABLE_TASK_DEF = 'arn:aws:ecs:us-east-1:123456789012:task-definition/test-canary-task:41';
const NEW_TASK_DEF = 'arn:aws:ecs:us-east-1:123456789012:task-definition/test-canary-task:42';

interface ControllerWorld {
  /** What DescribeServices reports, keyed by service name. */
  services?: Record<string, any>;
  /** What DescribeTargetHealth reports. */
  targetHealth?: { TargetHealth: { State: string } }[];
}

const settledService = (taskDefinition: string, count = 2) => ({
  taskDefinition,
  runningCount: count,
  desiredCount: count,
  deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
});

const runController = async (event: Record<string, any>, world: ControllerWorld = {}) => {
  const calls: SdkCall[] = [];
  const services = world.services ?? {
    'test-stable-service': settledService(STABLE_TASK_DEF),
    'test-canary-service': settledService(NEW_TASK_DEF),
  };
  const targetHealth = world.targetHealth ?? [
    { TargetHealth: { State: 'healthy' } },
    { TargetHealth: { State: 'healthy' } },
  ];

  const respond = (call: SdkCall) => {
    switch (call.command) {
      case 'DescribeServicesCommand':
        return { services: [services[call.input.services[0]]].filter(Boolean) };
      case 'DescribeTargetHealthCommand':
        return { TargetHealthDescriptions: targetHealth };
      default:
        return {};
    }
  };

  const modules = {
    '@aws-sdk/client-elastic-load-balancing-v2': makeSdkModule(
      ['ModifyListenerCommand', 'DescribeTargetHealthCommand'],
      calls,
      respond,
      ['ElasticLoadBalancingV2Client'],
    ),
    '@aws-sdk/client-ecs': makeSdkModule(
      ['UpdateServiceCommand', 'DescribeServicesCommand'],
      calls,
      respond,
      ['ECSClient'],
    ),
  };

  const handler = loadHandler(CONTROLLER_SOURCE, CONTROLLER_ENV, modules);
  const result = await handler(event);
  return { result, calls };
};

const callsOf = (calls: SdkCall[], command: string) => calls.filter((c) => c.command === command);

describe('canary controller handler', () => {
  it('rejects an unknown action rather than silently doing nothing', async () => {
    await expect(runController({ action: 'nope' })).rejects.toThrow(/Unknown action: nope/);
  });

  describe('deploy', () => {
    it('points the canary service at the new revision and scales it up', async () => {
      const { calls } = await runController({ action: 'deploy', taskDefinitionArn: NEW_TASK_DEF });
      const [update] = callsOf(calls, 'UpdateServiceCommand');

      expect(update.input).toMatchObject({
        cluster: 'test-canary-cluster',
        service: 'test-canary-service',
        taskDefinition: NEW_TASK_DEF,
        desiredCount: 2,
        forceNewDeployment: true,
      });
    });

    it('never touches the stable service', async () => {
      const { calls } = await runController({ action: 'deploy', taskDefinitionArn: NEW_TASK_DEF });
      const updated = callsOf(calls, 'UpdateServiceCommand').map((c) => c.input.service);
      expect(updated).not.toContain('test-stable-service');
    });

    it('refuses to deploy without a task definition', async () => {
      await expect(runController({ action: 'deploy' })).rejects.toThrow(
        /deploy requires taskDefinitionArn/,
      );
    });
  });

  describe('shift', () => {
    it('gives the canary its weight and stable the remainder', async () => {
      const { result, calls } = await runController({ action: 'shift', canaryWeight: 25 });
      const [modify] = callsOf(calls, 'ModifyListenerCommand');
      const groups = modify.input.DefaultActions[0].ForwardConfig.TargetGroups;

      expect(groups).toEqual([
        { TargetGroupArn: CONTROLLER_ENV.STABLE_TARGET_GROUP_ARN, Weight: 75 },
        { TargetGroupArn: CONTROLLER_ENV.CANARY_TARGET_GROUP_ARN, Weight: 25 },
      ]);
      expect(result).toMatchObject({ canaryWeight: 25, stableWeight: 75 });
    });

    it('always restates both target groups, since ModifyListener replaces the action', async () => {
      const { calls } = await runController({ action: 'shift', canaryWeight: 100 });
      const [modify] = callsOf(calls, 'ModifyListenerCommand');
      expect(modify.input.DefaultActions[0].ForwardConfig.TargetGroups).toHaveLength(2);
    });

    it('rejects a weight outside 0–100', async () => {
      await expect(runController({ action: 'shift', canaryWeight: 150 })).rejects.toThrow(
        /canaryWeight between 0 and 100/,
      );
      await expect(runController({ action: 'shift' })).rejects.toThrow(
        /canaryWeight between 0 and 100/,
      );
    });
  });

  describe('health', () => {
    it('reports a settled service with healthy targets as stable', async () => {
      const { result } = await runController({ action: 'health', target: 'canary', attempts: 0 });

      expect(result.stable).toBe(true);
      expect(result.reason).toBe('HEALTHY');
      expect(result.attempts).toBe(1);
    });

    it('counts attempts so the state machine can bound the loop', async () => {
      const { result } = await runController({ action: 'health', target: 'canary', attempts: 4 });
      expect(result.attempts).toBe(5);
    });

    it('is not stable while ECS is still rolling out', async () => {
      const { result } = await runController(
        { action: 'health', target: 'canary' },
        {
          services: {
            'test-canary-service': {
              taskDefinition: NEW_TASK_DEF,
              runningCount: 1,
              desiredCount: 2,
              deployments: [
                { status: 'PRIMARY', rolloutState: 'IN_PROGRESS' },
                { status: 'ACTIVE', rolloutState: 'COMPLETED' },
              ],
            },
          },
        },
      );

      expect(result.stable).toBe(false);
      expect(result.reason).toBe('ECS_NOT_SETTLED');
    });

    it('is not stable while the ALB still has an unhealthy target', async () => {
      const { result } = await runController(
        { action: 'health', target: 'canary' },
        {
          targetHealth: [
            { TargetHealth: { State: 'healthy' } },
            { TargetHealth: { State: 'unhealthy' } },
          ],
        },
      );

      expect(result.stable).toBe(false);
      expect(result.reason).toBe('TARGETS_NOT_HEALTHY');
      expect(result.healthyTargets).toBe(1);
    });

    it('is not stable when no targets are registered at all', async () => {
      const { result } = await runController({ action: 'health', target: 'canary' }, { targetHealth: [] });
      expect(result.stable).toBe(false);
      expect(result.reason).toBe('TARGETS_NOT_HEALTHY');
    });

    it('short-circuits the polling loop when the circuit breaker has already failed', async () => {
      const { result } = await runController(
        { action: 'health', target: 'canary', attempts: 1 },
        {
          services: {
            'test-canary-service': {
              taskDefinition: NEW_TASK_DEF,
              runningCount: 0,
              desiredCount: 2,
              deployments: [
                {
                  status: 'PRIMARY',
                  rolloutState: 'FAILED',
                  rolloutStateReason: 'circuit breaker tripped',
                },
              ],
            },
          },
        },
      );

      expect(result.stable).toBe(false);
      expect(result.reason).toBe('ROLLOUT_FAILED');
      // Reported as an exhausted budget so the Choice state rolls back now
      // instead of waiting out the remaining polls on a doomed rollout.
      expect(result.attempts).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('checks the stable service and its target group when asked for stable', async () => {
      const { calls } = await runController({ action: 'health', target: 'stable' });

      expect(callsOf(calls, 'DescribeServicesCommand')[0].input.services).toEqual([
        'test-stable-service',
      ]);
      expect(callsOf(calls, 'DescribeTargetHealthCommand')[0].input.TargetGroupArn).toBe(
        CONTROLLER_ENV.STABLE_TARGET_GROUP_ARN,
      );
    });

    it('reports a missing service instead of throwing', async () => {
      const { result } = await runController({ action: 'health', target: 'canary' }, { services: {} });
      expect(result.stable).toBe(false);
      expect(result.reason).toBe('SERVICE_NOT_FOUND');
    });
  });

  describe('baseline', () => {
    it('records the revision the stable service is running', async () => {
      const { result } = await runController({ action: 'baseline' });
      expect(result.taskDefinitionArn).toBe(STABLE_TASK_DEF);
      expect(result.service).toBe('test-stable-service');
    });

    it('throws when the stable service is missing, rather than recording nothing', async () => {
      await expect(runController({ action: 'baseline' }, { services: {} })).rejects.toThrow(
        /Stable service not found/,
      );
    });
  });

  describe('reset and rollback', () => {
    it('takes traffic off the canary before scaling it down', async () => {
      const { calls } = await runController({ action: 'reset' });
      const order = calls.map((c) => c.command);

      expect(order.indexOf('ModifyListenerCommand')).toBeLessThan(
        order.indexOf('UpdateServiceCommand'),
      );
    });

    it('returns all traffic to stable and retires the canary tasks', async () => {
      const { result, calls } = await runController({ action: 'reset' });
      const [modify] = callsOf(calls, 'ModifyListenerCommand');
      const groups = modify.input.DefaultActions[0].ForwardConfig.TargetGroups;

      expect(groups.map((g: any) => g.Weight)).toEqual([100, 0]);
      expect(callsOf(calls, 'UpdateServiceCommand')[0].input).toMatchObject({
        service: 'test-canary-service',
        desiredCount: 0,
      });
      expect(result.canaryScaledTo).toBe(0);
    });

    it('reverts the stable service when rolling back after promotion', async () => {
      // Stable has already been promoted onto the new revision.
      const { result, calls } = await runController(
        { action: 'rollback', stableTaskDefinitionArn: STABLE_TASK_DEF },
        {
          services: {
            'test-stable-service': settledService(NEW_TASK_DEF),
            'test-canary-service': settledService(NEW_TASK_DEF),
          },
        },
      );

      const stableUpdate = callsOf(calls, 'UpdateServiceCommand').find(
        (c) => c.input.service === 'test-stable-service',
      );

      expect(stableUpdate).toBeDefined();
      expect(stableUpdate!.input).toMatchObject({
        taskDefinition: STABLE_TASK_DEF,
        forceNewDeployment: true,
      });
      expect(result.stableRestoredTo).toBe(STABLE_TASK_DEF);
    });

    it('leaves the stable service alone when promotion had not happened yet', async () => {
      const { result, calls } = await runController({
        action: 'rollback',
        stableTaskDefinitionArn: STABLE_TASK_DEF,
      });

      const stableUpdate = callsOf(calls, 'UpdateServiceCommand').find(
        (c) => c.input.service === 'test-stable-service',
      );

      expect(stableUpdate).toBeUndefined();
      expect(result.stableRestoredTo).toBeNull();
    });

    it('never reverts the stable service on the success path', async () => {
      // `reset` runs after a promotion that passed analysis; reverting there
      // would undo the deployment that just succeeded.
      const { calls } = await runController(
        { action: 'reset', stableTaskDefinitionArn: STABLE_TASK_DEF },
        {
          services: {
            'test-stable-service': settledService(NEW_TASK_DEF),
            'test-canary-service': settledService(NEW_TASK_DEF),
          },
        },
      );

      const stableUpdate = callsOf(calls, 'UpdateServiceCommand').find(
        (c) => c.input.service === 'test-stable-service',
      );
      expect(stableUpdate).toBeUndefined();
    });
  });

  describe('promote', () => {
    it('moves the stable service onto the new revision', async () => {
      const { calls } = await runController({ action: 'promote', taskDefinitionArn: NEW_TASK_DEF });
      const [update] = callsOf(calls, 'UpdateServiceCommand');

      expect(update.input).toMatchObject({
        service: 'test-stable-service',
        taskDefinition: NEW_TASK_DEF,
        forceNewDeployment: true,
      });
    });

    it('does not change the stable task count while promoting', async () => {
      const { calls } = await runController({ action: 'promote', taskDefinitionArn: NEW_TASK_DEF });
      expect(callsOf(calls, 'UpdateServiceCommand')[0].input.desiredCount).toBeUndefined();
    });

    it('refuses to promote without a task definition', async () => {
      await expect(runController({ action: 'promote' })).rejects.toThrow(
        /promote requires taskDefinitionArn/,
      );
    });
  });
});
