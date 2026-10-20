import {
  DRAIN_OVERRUN_METRIC,
  DRAIN_SECONDS_METRIC,
  DRAIN_UNMEASURED_METRIC,
  ECS_DEFAULT_STOP_TIMEOUT_SECONDS,
  ELB_DEFAULT_DEREGISTRATION_DELAY_SECONDS,
  FARGATE_MAX_STOP_TIMEOUT_SECONDS,
  FARGATE_SPOT_LIST_DISCOUNT,
  FARGATE_SPOT_WARNING_SECONDS,
  INTERRUPTION_METRIC,
  MINIMUM_REASON_LENGTH,
  ON_DEMAND_CAPACITY_PROVIDER,
  SPOT_CAPACITY_PROVIDER,
  SPOT_INTERRUPTION_STOP_CODE,
  SPOT_METRIC_NAMESPACE,
  SPOT_WORKLOADS,
  type SpotWorkload,
  assertValidSpotCatalogue,
  drainBudgetSeconds,
  drainSlackSeconds,
  maximumSavingPercent,
  postureTotals,
  renderSpotTable,
  spotCapacityProviderStrategies,
  spotWorkloadById,
  spotWorkloadMatches,
  spotWorkloadsFor,
  usesSpot,
  validateSpotCatalogue,
} from '../lib/spot-capacity';

/**
 * Tests for the Spot capacity catalogue.
 *
 * Two kinds. The first is the shipped catalogue, held to the rules it declares
 * — it is read at synth time by three stacks, so a bad entry is a failed build
 * and these assertions are what keep that from being the first time anybody
 * finds out.
 *
 * The second is every rule in `validateSpotCatalogue`, exercised against an
 * entry that breaks exactly one of them. Each of those entries *deploys*: a
 * `spot-with-base` with no base is a valid capacity provider strategy, a drain
 * budget of 300 seconds is a valid target group, and an SLO-bearing service on
 * Spot is a cheaper service. Nothing but this file and the gate says otherwise.
 */

const base: SpotWorkload = {
  id: 'fixture',
  stackPrefixes: ['FixtureStack-'],
  servicePathSuffix: 'Service/Service',
  posture: 'spot-with-base',
  criticality: 'staging-grade',
  reason:
    'A fixture whose reason is long enough to clear the floor the validator holds reasons to, ' +
    'and which names a failure: a reclaimed task here is replaced and nothing depends on it.',
  expectedResources: 1,
  onDemandBase: 1,
  spotWeight: 1,
  drainBudget: { deregistrationDelaySeconds: 30, stopTimeoutSeconds: 60 },
};

const rulesFor = (workload: Partial<SpotWorkload>): string[] =>
  validateSpotCatalogue([{ ...base, ...workload }]).map((finding) => finding.rule);

describe('the catalogue this repository ships', () => {
  it('has no findings', () => {
    expect(validateSpotCatalogue()).toEqual([]);
    expect(() => assertValidSpotCatalogue()).not.toThrow();
  });

  it('classifies all eleven ECS services, and nine of them stay on on-demand', () => {
    const totals = postureTotals();
    expect(totals).toEqual({ 'spot-only': 1, 'spot-with-base': 1, 'on-demand-only': 9 });
    expect(totals['spot-only'] + totals['spot-with-base'] + totals['on-demand-only']).toBe(11);
  });

  it('gives every entry a reason that names a failure rather than a label', () => {
    for (const workload of SPOT_WORKLOADS) {
      expect(workload.reason.trim().length).toBeGreaterThanOrEqual(MINIMUM_REASON_LENGTH);
    }
  });

  it('keeps every declared drain budget inside the warning, with slack', () => {
    for (const workload of SPOT_WORKLOADS.filter(usesSpot)) {
      const budget = workload.drainBudget;
      expect(budget).toBeDefined();
      expect(drainBudgetSeconds(budget!)).toBeLessThan(FARGATE_SPOT_WARNING_SECONDS);
      // Slack rather than "fits": AWS does not bound the gap between the event
      // being emitted and SIGTERM arriving, so a budget equal to the warning
      // would be betting on an unpublished number.
      expect(drainSlackSeconds(budget!)).toBeGreaterThan(0);
      expect(budget!.stopTimeoutSeconds).toBeLessThanOrEqual(FARGATE_MAX_STOP_TIMEOUT_SECONDS);
    }
  });

  it('puts nothing with an objective, a release mechanism or instance affinity on Spot', () => {
    for (const workload of SPOT_WORKLOADS.filter(usesSpot)) {
      expect(['staging-grade', 'ephemeral']).toContain(workload.criticality);
    }
  });

  it('gives the one staging-grade workload a base and the ephemeral one none', () => {
    expect(spotWorkloadById('staging-application').onDemandBase).toBe(1);
    expect(spotWorkloadById('preview-pr-service').onDemandBase).toBeUndefined();
  });

  it('throws on an id that does not exist, rather than silently meaning on-demand', () => {
    expect(() => spotWorkloadById('staging-aplication')).toThrow(/No Spot capacity workload/);
    expect(() => spotWorkloadById('staging-aplication')).toThrow(/staging-application/);
  });

  it('restates the platform constants it reasons about', () => {
    expect(FARGATE_SPOT_WARNING_SECONDS).toBe(120);
    expect(FARGATE_MAX_STOP_TIMEOUT_SECONDS).toBe(120);
    expect(ECS_DEFAULT_STOP_TIMEOUT_SECONDS).toBe(30);
    expect(ELB_DEFAULT_DEREGISTRATION_DELAY_SECONDS).toBe(300);
    expect(SPOT_INTERRUPTION_STOP_CODE).toBe('SpotInterruption');
    expect(SPOT_CAPACITY_PROVIDER).toBe('FARGATE_SPOT');
    expect(ON_DEMAND_CAPACITY_PROVIDER).toBe('FARGATE');
  });

  it('names the metrics the recorder publishes and the alarms read', () => {
    expect(SPOT_METRIC_NAMESPACE).toBe('Boilerplate/Spot');
    expect([
      INTERRUPTION_METRIC,
      DRAIN_SECONDS_METRIC,
      DRAIN_OVERRUN_METRIC,
      DRAIN_UNMEASURED_METRIC,
    ]).toEqual(['Interruptions', 'DrainSeconds', 'DrainOverruns', 'DrainUnmeasured']);
  });

  it('marks the discount unmeasured, with its source', () => {
    expect(FARGATE_SPOT_LIST_DISCOUNT.measured).toBe(false);
    expect(FARGATE_SPOT_LIST_DISCOUNT.percent).toBe(70);
    expect(FARGATE_SPOT_LIST_DISCOUNT.source).toMatch(/AWS/);
  });
});

describe('matching a service to an entry', () => {
  const resource = {
    stackName: 'FixtureStack-Staging',
    constructPath: 'Service/Service',
  };

  it('needs both the stack prefix and the construct path', () => {
    expect(spotWorkloadMatches(base, resource)).toBe(true);
    expect(spotWorkloadMatches(base, { ...resource, stackName: 'OtherStack' })).toBe(false);
    expect(
      spotWorkloadMatches(base, { ...resource, constructPath: 'Canary/Service/Other' }),
    ).toBe(false);
  });

  it('matches the per-pull-request stacks by prefix, since CI names them', () => {
    const preview = spotWorkloadById('preview-pr-service');
    for (const prNumber of [1, 42, 99999]) {
      expect(
        spotWorkloadMatches(preview, {
          stackName: `PreviewPrStack-${prNumber}`,
          constructPath: 'Service/Service',
        }),
      ).toBe(true);
    }
  });

  it('keeps the two canary services apart, which `endsWith` alone would not', () => {
    const stable = spotWorkloadsFor({
      stackName: 'CanaryDeployStack-Staging',
      constructPath: 'StableService/Service',
    });
    const canary = spotWorkloadsFor({
      stackName: 'CanaryDeployStack-Staging',
      constructPath: 'CanaryService/Service',
    });
    expect(stable.map((workload) => workload.id)).toEqual(['canary-deploy-services']);
    expect(canary.map((workload) => workload.id)).toEqual(['canary-deploy-canary-services']);
  });

  it('claims every service in the shipped app exactly once', () => {
    const services = [
      ['EcsStack-Staging', 'Service/Service'],
      ['EcsStack-Production', 'Service/Service'],
      ['BlueGreenDeployStack-Staging', 'Service/Service'],
      ['BlueGreenDeployStack-Production', 'Service/Service'],
      ['CanaryDeployStack-Staging', 'StableService/Service'],
      ['CanaryDeployStack-Staging', 'CanaryService/Service'],
      ['CanaryDeployStack-Production', 'StableService/Service'],
      ['CanaryDeployStack-Production', 'CanaryService/Service'],
      ['OtelCollectorStack-Staging', 'Service/Service'],
      ['OtelCollectorStack-Production', 'Service/Service'],
      ['PreviewPrStack-1', 'Service/Service'],
    ] as const;
    for (const [stackName, constructPath] of services) {
      expect(spotWorkloadsFor({ stackName, constructPath })).toHaveLength(1);
    }
  });
});

describe('the strategy a posture produces', () => {
  it('emits no strategy at all for on-demand-only, which is LaunchType: FARGATE', () => {
    expect(spotCapacityProviderStrategies(spotWorkloadById('production-application'))).toEqual([]);
  });

  it('emits Spot alone for spot-only', () => {
    expect(spotCapacityProviderStrategies(spotWorkloadById('preview-pr-service'))).toEqual([
      { capacityProvider: 'FARGATE_SPOT', weight: 1 },
    ]);
  });

  it('places the base before any weight for spot-with-base', () => {
    expect(spotCapacityProviderStrategies(spotWorkloadById('staging-application'))).toEqual([
      { capacityProvider: 'FARGATE', base: 1, weight: 0 },
      { capacityProvider: 'FARGATE_SPOT', weight: 1 },
    ]);
  });

  it('omits a zero base rather than emitting one that reads like a decision', () => {
    const strategies = spotCapacityProviderStrategies({
      ...base,
      posture: 'spot-only',
      criticality: 'ephemeral',
      onDemandBase: undefined,
      onDemandWeight: 2,
    });
    expect(strategies[0]).toEqual({ capacityProvider: 'FARGATE', weight: 2 });
    expect(strategies[0]).not.toHaveProperty('base');
  });
});

describe('the drain budget arithmetic', () => {
  it('adds the two intervals rather than taking the larger', () => {
    // ECS deregisters the target before it signals the container, so the two do
    // not overlap. Taking the maximum would call a 90-second shutdown a
    // 60-second one and pass a budget that does not fit.
    expect(drainBudgetSeconds({ deregistrationDelaySeconds: 30, stopTimeoutSeconds: 60 })).toBe(90);
    expect(drainSlackSeconds({ deregistrationDelaySeconds: 30, stopTimeoutSeconds: 60 })).toBe(30);
  });

  it('reports the ELB default as over budget on its own', () => {
    const budget = {
      deregistrationDelaySeconds: ELB_DEFAULT_DEREGISTRATION_DELAY_SECONDS,
      stopTimeoutSeconds: ECS_DEFAULT_STOP_TIMEOUT_SECONDS,
    };
    expect(drainBudgetSeconds(budget)).toBe(330);
    expect(drainSlackSeconds(budget)).toBeLessThan(0);
  });
});

describe('the saving, as a bound', () => {
  it('is zero while the base consumes the whole desired count', () => {
    // Which is staging today: desiredCount 1, base 1. Stated as a test because
    // it is the thing a reader is most likely to assume away.
    expect(maximumSavingPercent(spotWorkloadById('staging-application'), 1)).toBe(0);
  });

  it('rises with the burst, not with the base', () => {
    const staging = spotWorkloadById('staging-application');
    expect(maximumSavingPercent(staging, 2)).toBe(35);
    expect(maximumSavingPercent(staging, 4)).toBe(52.5);
  });

  it('is the whole discount where there is no base', () => {
    expect(maximumSavingPercent(spotWorkloadById('preview-pr-service'), 1)).toBe(70);
  });

  it('is zero for an on-demand workload and for a count of zero', () => {
    expect(maximumSavingPercent(spotWorkloadById('otel-sampler-service'), 4)).toBe(0);
    expect(maximumSavingPercent(spotWorkloadById('preview-pr-service'), 0)).toBe(0);
  });
});

describe('every rule, against an entry that breaks exactly one', () => {
  it('accepts the fixture it starts from', () => {
    expect(rulesFor({})).toEqual([]);
  });

  it('refuses two entries sharing an id', () => {
    expect(validateSpotCatalogue([base, { ...base, expectedResources: 2 }]).map((f) => f.rule)).toContain(
      'workload-duplicate-id',
    );
  });

  it('refuses an entry that claims everything', () => {
    expect(rulesFor({ stackPrefixes: [] })).toContain('workload-no-stack-prefix');
    expect(rulesFor({ servicePathSuffix: '  ' })).toContain('workload-no-path-suffix');
  });

  it('refuses an entry that expects to match nothing', () => {
    expect(rulesFor({ expectedResources: 0 })).toContain('workload-expects-nothing');
  });

  it('refuses a reason that is a label', () => {
    expect(rulesFor({ reason: 'critical' })).toContain('workload-reason-too-short');
  });

  it('refuses a spot posture with no drain budget', () => {
    expect(rulesFor({ drainBudget: undefined })).toContain('spot-without-drain-budget');
  });

  it('refuses a grace period above what Fargate accepts', () => {
    expect(
      rulesFor({ drainBudget: { deregistrationDelaySeconds: 0, stopTimeoutSeconds: 121 } }),
    ).toContain('stop-timeout-above-platform-maximum');
  });

  it('refuses a grace period of zero', () => {
    expect(
      rulesFor({ drainBudget: { deregistrationDelaySeconds: 5, stopTimeoutSeconds: 0 } }),
    ).toContain('stop-timeout-not-positive');
  });

  it('refuses a negative deregistration delay', () => {
    expect(
      rulesFor({ drainBudget: { deregistrationDelaySeconds: -1, stopTimeoutSeconds: 30 } }),
    ).toContain('deregistration-delay-negative');
  });

  it('refuses a budget that does not fit the warning', () => {
    const rules = rulesFor({
      drainBudget: { deregistrationDelaySeconds: 61, stopTimeoutSeconds: 60 },
    });
    expect(rules).toContain('drain-budget-exceeds-warning');
  });

  it('refuses spot-with-base with no base, which is spot-only renamed', () => {
    expect(rulesFor({ onDemandBase: 0 })).toContain('base-missing');
    expect(rulesFor({ onDemandBase: undefined })).toContain('base-missing');
  });

  it('refuses spot-only carrying a base, since the template follows the base', () => {
    expect(rulesFor({ posture: 'spot-only', criticality: 'ephemeral', onDemandBase: 1 })).toContain(
      'spot-only-with-base',
    );
  });

  it('refuses a Spot weight of zero, which places nothing on Spot', () => {
    expect(rulesFor({ spotWeight: 0 })).toContain('spot-weight-not-positive');
  });

  it('refuses an SLO-bearing workload on Spot', () => {
    expect(rulesFor({ criticality: 'user-facing-slo' })).toContain('slo-workload-on-spot');
  });

  it('refuses a release mechanism or a hash-ring member on Spot', () => {
    expect(rulesFor({ criticality: 'release-mechanism' })).toContain('mechanism-workload-on-spot');
    expect(rulesFor({ criticality: 'instance-affinity' })).toContain('mechanism-workload-on-spot');
  });

  it('refuses a staging-grade workload with no base', () => {
    expect(
      rulesFor({ posture: 'spot-only', onDemandBase: undefined, spotWeight: 1 }),
    ).toContain('staging-workload-without-base');
  });

  it('refuses inert weights and budgets on an on-demand entry', () => {
    const inert = {
      posture: 'on-demand-only' as const,
      criticality: 'user-facing-slo' as const,
    };
    expect(rulesFor({ ...inert, onDemandBase: undefined, spotWeight: undefined })).toContain(
      'on-demand-with-drain-budget',
    );
    expect(rulesFor({ ...inert, drainBudget: undefined })).toContain('on-demand-with-weights');
  });

  it('throws from the assert form, with the rule and the subject in the message', () => {
    expect(() => assertValidSpotCatalogue([{ ...base, onDemandBase: 0 }])).toThrow(
      /\[base-missing\] fixture/,
    );
  });
});

describe('the published table', () => {
  it('renders one row per entry, with the budget broken into its two halves', () => {
    const table = renderSpotTable();
    const lines = table.split('\n');
    expect(lines).toHaveLength(SPOT_WORKLOADS.length + 2);
    expect(lines[0]).toContain('| Posture |');
    expect(table).toContain('| `staging-application` | 1 | spot-with-base | 1 | staging-grade | 90s (30s + 60s), 30s spare |');
    // An on-demand entry has no base and no budget, and shows neither as a zero
    // — a `0` in the base column reads as a decision somebody made.
    expect(table).toContain('| `production-application` | 1 | on-demand-only | — | user-facing-slo | — |');
  });
});
