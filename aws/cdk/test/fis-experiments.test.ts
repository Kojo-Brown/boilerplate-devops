import {
  ALB_5XX_STOP_CONDITION,
  ACTION_FOR_FAULT_KIND,
  CHAOS_EXPERIMENTS,
  type ChaosExperiment,
  FIS_ACTIONS,
  MAX_FAULT_DURATION_SECONDS,
  MIN_FAULT_DURATION_SECONDS,
  PROBE_CONNECT_STOP_CONDITION,
  STOP_CONDITION_MARGIN,
  type StopConditionAlarm,
  assertValidChaosCatalogue,
  detectionWindowSeconds,
  experimentTemplateName,
  experimentsFor,
  formatFaultDuration,
  isTrafficIndependent,
  parseFaultDurationSeconds,
  resolvedTargetRange,
  validateChaosCatalogue,
} from '../lib/fis-experiments';
import { GAME_DAY_NAMESPACE, METRIC_CONNECT_SUCCESS } from '../lib/game-days';

/**
 * Tests for the chaos experiment catalogue.
 *
 * The rules are the subject, not the three entries: a validator that reports
 * nothing against a catalogue that happens to be correct is indistinguishable
 * from one whose rules never fire. So every rule below is exercised against an
 * entry built to violate it, and the real catalogue is asserted clean separately.
 */

const rules = (findings: ReturnType<typeof validateChaosCatalogue>): string[] =>
  findings.map((finding) => finding.rule);

/** A valid entry to mutate. Kept in sync with the catalogue by the first test. */
const baseline = (overrides: Partial<ChaosExperiment> = {}): ChaosExperiment => ({
  id: 'ecs-task-loss',
  title: 'A task disappears',
  anchor: '#2-a-task-disappears',
  owner: 'platform-team',
  faultKind: 'instance',
  action: 'ecs-stop-task',
  hypothesis:
    'Stopping one of two tasks is absorbed by the remaining task and the replacement is ' +
    'healthy inside one deregistration delay. Refuted by any ELB-generated 5XX.',
  selectionMode: 'COUNT(1)',
  targetPopulation: 2,
  duration: 'PT5M',
  stopConditions: [PROBE_CONNECT_STOP_CONDITION, ALB_5XX_STOP_CONDITION],
  allowedEnvironments: ['staging'],
  summary: 'The fault every autoscaling diagram assumes is survivable.',
  ...overrides,
});

describe('the shipped catalogue', () => {
  it('is valid', () => {
    expect(validateChaosCatalogue()).toEqual([]);
    expect(() => assertValidChaosCatalogue()).not.toThrow();
  });

  it('is the three faults the spec item names, one action each', () => {
    expect(CHAOS_EXPERIMENTS.map((experiment) => experiment.faultKind).sort()).toEqual([
      'availability-zone',
      'instance',
      'latency',
    ]);
    for (const experiment of CHAOS_EXPERIMENTS) {
      expect(experiment.action).toBe(ACTION_FOR_FAULT_KIND[experiment.faultKind]);
    }
  });

  it('pairs each action with the target key that action defines', () => {
    // The mapping is the thing that cannot be derived and is easy to get wrong:
    // an ECS action pointing at `Instances` is a template copied from an EC2
    // example. Pinned here so a rename is a test failure rather than a
    // ValidationException during an exercise.
    expect(FIS_ACTIONS['ecs-stop-task'].targetKey).toBe('Tasks');
    expect(FIS_ACTIONS['ecs-task-network-latency'].targetKey).toBe('Tasks');
    expect(FIS_ACTIONS['network-disrupt-connectivity'].targetKey).toBe('Subnets');
    expect(FIS_ACTIONS['network-disrupt-connectivity'].resourceType).toBe('aws:ec2:subnet');
  });

  it('gives the baseline fixture the same shape as the real entry it copies', () => {
    const real = CHAOS_EXPERIMENTS.find((experiment) => experiment.id === 'ecs-task-loss')!;
    const fixture = baseline();
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(real).sort());
    expect(validateChaosCatalogue([fixture])).toEqual([]);
  });

  it('allows the availability-zone fault in staging only', () => {
    const az = CHAOS_EXPERIMENTS.find((e) => e.faultKind === 'availability-zone')!;
    expect(az.allowedEnvironments).toEqual(['staging']);
    expect(experimentsFor('production').map((e) => e.id)).not.toContain(az.id);
    expect(experimentsFor('staging')).toHaveLength(CHAOS_EXPERIMENTS.length);
  });

  it('names every template after its environment and id', () => {
    expect(experimentTemplateName('staging', 'ecs-task-loss')).toBe(
      'staging-chaos-ecs-task-loss',
    );
  });
});

describe('stop conditions', () => {
  it('treats only the scheduled probe metric as traffic-independent', () => {
    expect(isTrafficIndependent(PROBE_CONNECT_STOP_CONDITION)).toBe(true);
    expect(isTrafficIndependent(ALB_5XX_STOP_CONDITION)).toBe(false);
  });

  it('reads the probe alarm off the game-day constants rather than restating them', () => {
    // If `FailoverGameDayStack`'s probe metric is renamed, this catalogue's
    // guardrail has to move with it. Importing the constants is what makes that
    // a compile error; this asserts the import was actually used.
    expect(PROBE_CONNECT_STOP_CONDITION.namespace).toBe(GAME_DAY_NAMESPACE);
    expect(PROBE_CONNECT_STOP_CONDITION.metricName).toBe(METRIC_CONNECT_SUCCESS);
  });

  it('computes the detection window as period x evaluation periods', () => {
    expect(detectionWindowSeconds(PROBE_CONNECT_STOP_CONDITION)).toBe(120);
    expect(detectionWindowSeconds(ALB_5XX_STOP_CONDITION)).toBe(600);
  });

  it('refuses an experiment whose every guardrail is derived from traffic', () => {
    // The failure this rule exists for: all three faults reduce the requests
    // reaching a target, so in a quiet environment the error count is zero
    // whether the application is healthy or on fire.
    const findings = validateChaosCatalogue([
      baseline({ stopConditions: [ALB_5XX_STOP_CONDITION], duration: 'PT30M' }),
    ]);
    expect(rules(findings)).toContain('stop-conditions-all-traffic-dependent');
  });

  it('refuses an experiment with no guardrail at all', () => {
    expect(rules(validateChaosCatalogue([baseline({ stopConditions: [] })]))).toContain(
      'stop-condition-missing',
    );
  });

  it("refuses a guardrail that resolves to FIS's none", () => {
    const none: StopConditionAlarm = { ...PROBE_CONNECT_STOP_CONDITION, alarmName: 'none' };
    expect(rules(validateChaosCatalogue([baseline({ stopConditions: [none] })]))).toContain(
      'stop-condition-none',
    );
  });

  it('refuses a fault that ends before its fastest guardrail can change state', () => {
    // 120s window x 2 = 240s needed; PT3M is 180s.
    const findings = validateChaosCatalogue([baseline({ duration: 'PT3M' })]);
    expect(rules(findings)).toContain('duration-within-detection-window');
  });

  it('accepts a fault that clears the margin exactly', () => {
    const needed = detectionWindowSeconds(PROBE_CONNECT_STOP_CONDITION) * STOP_CONDITION_MARGIN;
    const findings = validateChaosCatalogue([
      baseline({ duration: formatFaultDuration(needed) }),
    ]);
    expect(rules(findings)).not.toContain('duration-within-detection-window');
  });

  it('measures the margin against the fastest guardrail, not the slowest', () => {
    // With the ALB alarm's 600s window the shipped PT5M faults would all be
    // refused. The rule is deliberately about the fastest, and this pins it so
    // the choice cannot be reversed by accident.
    const fast = detectionWindowSeconds(PROBE_CONNECT_STOP_CONDITION);
    const slow = detectionWindowSeconds(ALB_5XX_STOP_CONDITION);
    expect(fast).toBeLessThan(slow);
    expect(validateChaosCatalogue([baseline({ duration: 'PT5M' })])).toEqual([]);
  });
});

describe('durations', () => {
  it.each([
    ['PT1M', 60],
    ['PT5M', 300],
    ['PT10M', 600],
    ['PT1H', 3600],
    ['PT1M30S', 90],
    ['PT45S', 45],
  ])('parses %s', (text, seconds) => {
    expect(parseFaultDurationSeconds(text)).toBe(seconds);
  });

  it.each(['PT5', '5M', 'P1D', 'PT', '', 'pt5m'])('refuses %s', (text) => {
    expect(parseFaultDurationSeconds(text)).toBeUndefined();
  });

  it('round-trips through the formatter', () => {
    for (const seconds of [60, 90, 300, 600, 3600, 3661]) {
      expect(parseFaultDurationSeconds(formatFaultDuration(seconds))).toBe(seconds);
    }
  });

  it('reports an unparseable duration rather than throwing', () => {
    expect(rules(validateChaosCatalogue([baseline({ duration: 'PT5' })]))).toContain(
      'duration-not-iso8601',
    );
  });

  it('refuses a duration outside the declared range', () => {
    const tooShort = formatFaultDuration(MIN_FAULT_DURATION_SECONDS - 1);
    const tooLong = formatFaultDuration(MAX_FAULT_DURATION_SECONDS + 60);
    expect(rules(validateChaosCatalogue([baseline({ duration: tooShort })]))).toContain(
      'duration-out-of-range',
    );
    expect(rules(validateChaosCatalogue([baseline({ duration: tooLong })]))).toContain(
      'duration-out-of-range',
    );
  });
});

describe('blast radius', () => {
  it.each([
    ['ALL', 2, { min: 2, max: 2 }],
    ['COUNT(1)', 2, { min: 1, max: 1 }],
    ['COUNT(5)', 2, { min: 2, max: 2 }],
    ['PERCENT(50)', 2, { min: 1, max: 1 }],
    ['PERCENT(100)', 2, { min: 2, max: 2 }],
  ])('resolves %s of %i', (mode, population, expected) => {
    expect(resolvedTargetRange(mode, population)).toEqual(expected);
  });

  it('reports a range, not a number, where the rounding decides the fault', () => {
    // PERCENT(25) of 2 is 0.5. Whether FIS rounds it up or down is the
    // difference between stopping a task and stopping nothing, and the template
    // reads the same either way — which is why this returns an interval.
    expect(resolvedTargetRange('PERCENT(25)', 2)).toEqual({ min: 0, max: 1 });
  });

  it('refuses a selection mode FIS does not accept', () => {
    expect(rules(validateChaosCatalogue([baseline({ selectionMode: 'HALF' })]))).toContain(
      'selection-mode-unparseable',
    );
    expect(resolvedTargetRange('HALF', 2)).toBeUndefined();
  });

  it('refuses a selection that can take every target', () => {
    for (const mode of ['ALL', 'COUNT(2)', 'PERCENT(100)']) {
      expect(rules(validateChaosCatalogue([baseline({ selectionMode: mode })]))).toContain(
        'selection-takes-every-target',
      );
    }
  });

  it('refuses a selection that can resolve no targets', () => {
    expect(rules(validateChaosCatalogue([baseline({ selectionMode: 'PERCENT(25)' })]))).toContain(
      'selection-may-resolve-no-targets',
    );
    expect(rules(validateChaosCatalogue([baseline({ selectionMode: 'COUNT(0)' })]))).toContain(
      'selection-may-resolve-no-targets',
    );
  });

  it('refuses any fault against a population of one', () => {
    expect(rules(validateChaosCatalogue([baseline({ targetPopulation: 1 })]))).toContain(
      'target-population-leaves-no-survivor',
    );
  });
});

describe('per-fault requirements', () => {
  const latency = (overrides: Partial<ChaosExperiment> = {}): ChaosExperiment =>
    baseline({
      id: 'ecs-task-network-latency',
      anchor: '#3-the-network-gets-slow-rather-than-broken',
      faultKind: 'latency',
      action: 'ecs-task-network-latency',
      delayMilliseconds: 200,
      taskDefinitionRequirement: { pidMode: 'task', enableFaultInjection: true },
      ...overrides,
    });

  const az = (overrides: Partial<ChaosExperiment> = {}): ChaosExperiment =>
    baseline({
      id: 'availability-zone-partition',
      anchor: '#4-an-availability-zone-is-cut-off',
      faultKind: 'availability-zone',
      action: 'network-disrupt-connectivity',
      disruptScope: 'availability-zone',
      ...overrides,
    });

  it('accepts the two shapes the catalogue actually ships', () => {
    expect(validateChaosCatalogue([latency()])).toEqual([]);
    expect(validateChaosCatalogue([az()])).toEqual([]);
  });

  it('refuses a fault kind injected with the wrong action', () => {
    const findings = validateChaosCatalogue([latency({ action: 'ecs-stop-task' })]);
    expect(rules(findings)).toContain('fault-kind-action-mismatch');
  });

  it('requires a latency experiment to state its delay and its task-definition needs', () => {
    expect(rules(validateChaosCatalogue([latency({ delayMilliseconds: undefined })]))).toContain(
      'latency-experiment-without-delay',
    );
    expect(rules(validateChaosCatalogue([latency({ delayMilliseconds: 0 })]))).toContain(
      'latency-experiment-without-delay',
    );
    expect(
      rules(validateChaosCatalogue([latency({ taskDefinitionRequirement: undefined })])),
    ).toContain('latency-experiment-without-task-definition-requirement');
  });

  it('requires an availability-zone experiment to state its scope', () => {
    expect(rules(validateChaosCatalogue([az({ disruptScope: undefined })]))).toContain(
      'az-experiment-without-scope',
    );
  });

  it('refuses a scope or a task-definition requirement on a fault that has no use for it', () => {
    // FIS ignores parameters an action does not define, so either field on the
    // wrong fault is a statement of intent nothing enforces.
    expect(rules(validateChaosCatalogue([baseline({ disruptScope: 'all' })]))).toContain(
      'disrupt-scope-on-non-network-fault',
    );
    expect(
      rules(
        validateChaosCatalogue([
          baseline({ taskDefinitionRequirement: { pidMode: 'task', enableFaultInjection: true } }),
        ]),
      ),
    ).toContain('task-definition-requirement-on-non-latency-fault');
  });
});

describe('catalogue hygiene', () => {
  it('refuses a non-kebab id and a malformed anchor', () => {
    expect(rules(validateChaosCatalogue([baseline({ id: 'Ecs_Task_Loss' })]))).toContain(
      'experiment-id-not-kebab',
    );
    expect(rules(validateChaosCatalogue([baseline({ anchor: '2-a-task-disappears' })]))).toContain(
      'experiment-anchor-malformed',
    );
  });

  it('refuses an owner who is a person and a hypothesis that is a mood', () => {
    expect(rules(validateChaosCatalogue([baseline({ owner: 'alex' })]))).toContain(
      'experiment-owner-not-a-team',
    );
    expect(
      rules(validateChaosCatalogue([baseline({ hypothesis: 'The system is resilient.' })])),
    ).toContain('experiment-hypothesis-missing');
  });

  it('refuses an experiment deployed nowhere, or to an environment nothing knows', () => {
    expect(rules(validateChaosCatalogue([baseline({ allowedEnvironments: [] })]))).toContain(
      'experiment-without-environment',
    );
    expect(rules(validateChaosCatalogue([baseline({ allowedEnvironments: ['preprod'] })]))).toContain(
      'experiment-environment-unknown',
    );
  });

  it('refuses a duplicate id, which would silently deploy one of the two', () => {
    expect(rules(validateChaosCatalogue([baseline(), baseline()]))).toContain(
      'duplicate-experiment-id',
    );
  });

  it('reports every violation rather than the first', () => {
    // Fixing a bad entry one `cdk synth` at a time is how the last violation
    // gets committed, so all of them come back together.
    const findings = validateChaosCatalogue([
      baseline({ id: 'BAD', selectionMode: 'ALL', duration: 'PT1M', stopConditions: [] }),
    ]);
    expect(rules(findings).sort()).toEqual([
      'experiment-id-not-kebab',
      'selection-takes-every-target',
      'stop-condition-missing',
    ]);
    // The duration rules are deliberately absent: PT1M is exactly the floor, and
    // the margin rule has no guardrail to measure against once stopConditions
    // is empty — `stop-condition-missing` is the finding in that case.
    expect(rules(findings)).not.toContain('duration-within-detection-window');
  });

  it('throws with every finding named', () => {
    expect(() => assertValidChaosCatalogue([baseline({ selectionMode: 'ALL' })])).toThrow(
      /selection-takes-every-target/,
    );
  });
});
