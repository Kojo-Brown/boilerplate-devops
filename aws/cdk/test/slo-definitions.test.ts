import {
  BurnRateAlertPolicy,
  DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT,
  DEFAULT_BURN_RATE_ALERT_POLICIES,
  MAX_ALARM_WINDOW_MINUTES,
  SLO_CATALOGUE,
  SloDefinition,
  assertValidSlo,
  budgetFractionPerPolicy,
  describeMinutes,
  errorBudgetRatio,
  formatObjective,
  policiesFor,
  requireSlo,
  significanceFloorEvents,
  singleEventFloor,
  sloById,
  validateSloCatalogue,
  validateSloDefinition,
  windowFloorEvents,
  windowMinutes,
} from '../lib/slo-definitions';

/**
 * Tests for the catalogue and its rules.
 *
 * Every rule in here exists because the configuration it rejects deploys
 * cleanly, evaluates on schedule and reports nothing — so the tests are about
 * what stays green when it should not, rather than about what throws.
 */

const BASE: SloDefinition = {
  id: 'test-api-availability',
  service: 'api',
  envName: 'test',
  sli: { kind: 'availability', minimumEventsPerMinute: 15 },
  objective: 0.999,
  windowDays: 30,
  owner: 'platform-team',
  runbookUrl: 'https://example.invalid/runbooks/slo',
  description: 'Requests that did not fail',
  status: 'active',
};

const slo = (overrides: Partial<SloDefinition> = {}): SloDefinition => ({ ...BASE, ...overrides });

const rules = (definition: SloDefinition): string[] =>
  validateSloDefinition(definition).map((finding) => finding.rule);

const policy = (overrides: Partial<BurnRateAlertPolicy> = {}): BurnRateAlertPolicy => ({
  name: 'fast',
  burnRate: 14.4,
  longWindowMinutes: 60,
  shortWindowMinutes: 5,
  severity: 'page',
  description: 'test policy',
  ...overrides,
});

describe('arithmetic helpers', () => {
  it('computes the error budget without binary float noise', () => {
    // `1 - 0.999` is 0.0010000000000000009, which is what would be written into
    // a metric-math expression and read by whoever opens the alarm.
    expect(errorBudgetRatio(slo({ objective: 0.999 }))).toBe(0.001);
    expect(errorBudgetRatio(slo({ objective: 0.995 }))).toBe(0.005);
    expect(errorBudgetRatio(slo({ objective: 0.9995 }))).toBe(0.0005);
    expect(errorBudgetRatio(slo({ objective: 0.99999 }))).toBe(0.00001);
  });

  it('formats objectives and windows the way an alarm description reads', () => {
    expect(formatObjective(0.999)).toBe('99.9%');
    expect(formatObjective(0.99999)).toBe('99.999%');
    expect(describeMinutes(5)).toBe('5m');
    expect(describeMinutes(60)).toBe('1h');
    expect(describeMinutes(90)).toBe('1h30m');
    expect(describeMinutes(1440)).toBe('24h');
  });

  it('scales the traffic floor with the window rather than applying one count', () => {
    const definition = slo({ sli: { kind: 'availability', minimumEventsPerMinute: 15 } });
    expect(windowFloorEvents(definition, 5)).toBe(75);
    expect(windowFloorEvents(definition, 60)).toBe(900);
    expect(windowFloorEvents(definition, 1440)).toBe(21600);
  });

  it('never floors a window at zero events', () => {
    // A zero floor divides the error ratio by a zero denominator, which returns
    // no data for that datapoint rather than the zero the floor intends.
    const quiet = slo({ sli: { kind: 'availability', minimumEventsPerMinute: 0.01 } });
    expect(windowFloorEvents(quiet, 5)).toBe(1);
  });

  it('derives the single-event floor from the burn rate and the budget', () => {
    // One bad event in a window of n is a burn of 1 / (n × budget).
    expect(singleEventFloor(slo({ objective: 0.999 }), 14.4)).toBe(70);
    expect(singleEventFloor(slo({ objective: 0.999 }), 1)).toBe(1000);
    expect(singleEventFloor(slo({ objective: 0.995 }), 14.4)).toBe(14);
  });

  it('takes the largest per-policy floor for consumers that accept one count', () => {
    // The 1x policy is the binding one: the lower the burn rate, the more events
    // are needed before a single failure cannot reach it.
    expect(significanceFloorEvents(slo({ objective: 0.999 }))).toBe(1000);
    expect(significanceFloorEvents(slo({ objective: 0.995 }))).toBe(200);
  });

  it('computes the budget a policy spends inside its own window', () => {
    const definition = slo({ windowDays: 30 });
    expect(windowMinutes(definition)).toBe(43200);
    expect(budgetFractionPerPolicy(definition, policy({ burnRate: 14.4, longWindowMinutes: 60 }))).toBeCloseTo(
      0.02,
      10,
    );
    expect(budgetFractionPerPolicy(definition, policy({ burnRate: 6, longWindowMinutes: 360 }))).toBeCloseTo(
      0.05,
      10,
    );
  });
});

describe('catalogue lookup', () => {
  it('finds an entry by id', () => {
    expect(sloById('production-api-availability')?.objective).toBe(0.999);
    expect(sloById('nope')).toBeUndefined();
  });

  it('throws with the available ids when an id does not exist', () => {
    // `bin/app.ts` wires by id, so a typo should fail at synth with a usable
        // message rather than produce a stack with no objectives in it.
    expect(() => requireSlo('produciton-api-availability')).toThrow(
      /No SLO definition with id 'produciton-api-availability'.*production-api-availability/s,
    );
  });
});

describe('the default policies', () => {
  it('are fast, medium and slow, and only the first two page', () => {
    expect(DEFAULT_BURN_RATE_ALERT_POLICIES.map((p) => p.name)).toEqual(['fast', 'medium', 'slow']);
    expect(DEFAULT_BURN_RATE_ALERT_POLICIES.map((p) => p.severity)).toEqual([
      'page',
      'page',
      'ticket',
    ]);
  });

  it('keep every long window inside the maximum alarm period', () => {
    // The workbook's third tier is 1x over three days, which no CloudWatch alarm
    // can evaluate. Exceeding this is a stack that deploys an alarm CloudFormation
    // rejects, or worse, one it silently rounds.
    for (const p of DEFAULT_BURN_RATE_ALERT_POLICIES) {
      expect(p.longWindowMinutes).toBeLessThanOrEqual(MAX_ALARM_WINDOW_MINUTES);
    }
  });

  it('spend the documented fraction of a 30-day budget', () => {
    const definition = slo({ windowDays: 30 });
    const spent = DEFAULT_BURN_RATE_ALERT_POLICIES.map((p) =>
      Math.round(budgetFractionPerPolicy(definition, p) * 1000) / 10,
    );
    expect(spent).toEqual([2, 5, 3.3]);
  });
});

describe('validateSloDefinition', () => {
  it('accepts a well-formed objective', () => {
    expect(validateSloDefinition(slo())).toEqual([]);
  });

  it('rejects an objective written as a percentage', () => {
    // The single most likely typo, and `1 - 99.9` is a negative error budget: the
    // burn rate inverts and the alarm reads healthy while the service fails.
    expect(rules(slo({ objective: 99.9 }))).toEqual(['objective-out-of-range']);
    expect(rules(slo({ objective: 0 }))).toEqual(['objective-out-of-range']);
    expect(rules(slo({ objective: 1 }))).toEqual(['objective-out-of-range']);
  });

  it('reports nothing else once the objective is nonsensical', () => {
    // Every remaining rule divides by the error budget, so reporting them against
    // a bad objective would bury the one finding that matters.
    const findings = validateSloDefinition(slo({ objective: 42, owner: '', runbookUrl: 'nope' }));
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('objective-out-of-range');
  });

  it('rejects a burn-rate policy that can never fire', () => {
    // 14.4x against a 90% objective needs a 144% error ratio. The alarm deploys,
    // evaluates, and stays green through a total outage.
    const findings = validateSloDefinition(
      slo({ objective: 0.9, sli: { kind: 'availability', minimumEventsPerMinute: 200 } }),
    );
    const unreachable = findings.filter((f) => f.rule === 'policy-unreachable');
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].message).toContain('144%');
    // The message names the highest burn rate the objective can express.
    expect(unreachable[0].message).toContain('10');
  });

  it('accepts a policy at exactly the reachable limit', () => {
    // burnRate × budget === 1 is an error ratio of exactly 100%: reachable, if
    // only by a total outage. The boundary belongs on the accepting side.
    expect(
      rules(
        slo({
          objective: 0.9,
          sli: { kind: 'availability', minimumEventsPerMinute: 1 },
          burnRatePolicies: [policy({ burnRate: 10, shortWindowMinutes: 10 })],
        }),
      ),
    ).toEqual([]);
  });

  it('rejects a traffic floor at which one bad event crosses the threshold', () => {
    // This is the defect the repository shipped: 60 requests per window under a
    // 99.9% objective with a 14.4x policy needs 70, so at exactly the traffic
    // floor a single failed request crossed the threshold in both windows.
    const findings = validateSloDefinition(
      slo({
        sli: { kind: 'availability', minimumEventsPerMinute: 12 },
        burnRatePolicies: [policy()],
      }),
    );
    expect(findings.map((f) => f.rule)).toEqual(['traffic-floor-single-event']);
    expect(findings[0].message).toContain('60 events');
    expect(findings[0].message).toContain('below the 70 needed');
    // And it names the rate that would fix it: 70 events over 5 minutes.
    expect(findings[0].message).toContain('minimumEventsPerMinute to 14');
  });

  it('checks the traffic floor against the short window, which is the binding one', () => {
    // 15/min clears the 5-minute window at 75 events. Nothing about the hour-long
    // window could have failed here, and a rule that checked it would pass a
    // configuration that pages on one request.
    expect(rules(slo({ burnRatePolicies: [policy()] }))).toEqual([]);
    expect(
      rules(slo({ burnRatePolicies: [policy({ shortWindowMinutes: 4 })] })),
    ).toEqual(['traffic-floor-single-event']);
  });

  it('rejects windows that are not nested', () => {
    expect(rules(slo({ burnRatePolicies: [policy({ shortWindowMinutes: 60 })] }))).toContain(
      'policy-windows-not-nested',
    );
  });

  it('rejects a long window beyond the maximum alarm period', () => {
    expect(
      rules(slo({ burnRatePolicies: [policy({ longWindowMinutes: 4320 })] })),
    ).toContain('policy-window-exceeds-alarm-maximum');
  });

  it('rejects fractional and non-positive windows', () => {
    // CloudWatch periods are whole minutes; an alarm rounding its own window
    // evaluates a different burn rate from the one written down.
    expect(rules(slo({ burnRatePolicies: [policy({ shortWindowMinutes: 2.5 })] }))).toContain(
      'policy-window-invalid',
    );
    expect(rules(slo({ burnRatePolicies: [policy({ longWindowMinutes: 0 })] }))).toContain(
      'policy-window-invalid',
    );
  });

  it('rejects a policy claiming more budget than exists', () => {
    // 100x over 24 hours against a 1-day window is 10,000% of the budget: the
    // window and the burn rate disagree about which SLO window is meant.
    const findings = validateSloDefinition(
      slo({
        objective: 0.5,
        windowDays: 1,
        sli: { kind: 'availability', minimumEventsPerMinute: 10 },
        burnRatePolicies: [policy({ burnRate: 2, longWindowMinutes: 1440, shortWindowMinutes: 120 })],
      }),
    );
    expect(findings.map((f) => f.rule)).toContain('policy-spends-more-than-the-budget');
  });

  it('rejects duplicate and badly named policies', () => {
    const findings = rules(
      slo({ burnRatePolicies: [policy(), policy(), policy({ name: 'Fast_Burn' })] }),
    );
    expect(findings).toContain('duplicate-policy-name');
    expect(findings).toContain('policy-name-not-kebab-case');
  });

  it('rejects an empty policy list', () => {
    expect(rules(slo({ burnRatePolicies: [] }))).toEqual(['no-burn-rate-policies']);
  });

  it('requires a kebab-case id', () => {
    // The id becomes part of an alarm name and a metric dimension value.
    expect(rules(slo({ id: 'Production API' }))).toContain('id-not-kebab-case');
  });

  it('requires a team as the owner, not a person', () => {
    expect(rules(slo({ owner: '' }))).toContain('owner-missing');
    expect(rules(slo({ owner: 'someone@example.invalid' }))).toContain('owner-is-an-individual');
  });

  it('rejects a runbook link nobody can follow', () => {
    expect(rules(slo({ runbookUrl: 'see the wiki' }))).toContain('runbook-url-invalid');
    expect(rules(slo({ runbookUrl: 'http://runbooks.internal/slo' }))).toContain(
      'runbook-url-invalid',
    );
    expect(rules(slo({ runbookUrl: 'https://example.com/TODO' }))).toContain(
      'runbook-url-placeholder',
    );
  });

  it('holds status and blockedOn in step', () => {
    expect(rules(slo({ status: 'proposed' }))).toEqual(['proposed-without-blocker']);
    expect(rules(slo({ status: 'proposed', blockedOn: 'the SLI has no source' }))).toEqual([]);
    expect(rules(slo({ blockedOn: 'stale note' }))).toEqual(['active-with-blocker']);
  });

  it('rejects window lengths the budget reporter cannot read', () => {
    expect(rules(slo({ windowDays: 0 }))).toContain('window-days-invalid');
    expect(rules(slo({ windowDays: 30.5 }))).toContain('window-days-invalid');
    expect(rules(slo({ windowDays: 500 }))).toContain('window-days-too-long');
  });

  it('rejects a traffic rate of zero', () => {
    expect(rules(slo({ sli: { kind: 'availability', minimumEventsPerMinute: 0 } }))).toContain(
      'traffic-rate-invalid',
    );
  });

  it('rejects a latency SLI with no threshold', () => {
    expect(
      rules(slo({ sli: { kind: 'latency', thresholdSeconds: 0, minimumEventsPerMinute: 15 } })),
    ).toContain('latency-threshold-invalid');
  });

  it('rejects budget alert thresholds at the ends of the range', () => {
    // At 100 the alarm is in ALARM from the first failed request; at 0 it never
    // fires before the budget is gone, which is the exhausted alarm's job.
    expect(rules(slo({ budgetAlertThresholdPercent: 100 }))).toContain(
      'budget-alert-threshold-invalid',
    );
    expect(rules(slo({ budgetAlertThresholdPercent: 0 }))).toContain(
      'budget-alert-threshold-invalid',
    );
    expect(rules(slo({ budgetAlertThresholdPercent: DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT }))).toEqual(
      [],
    );
  });
});

describe('validateSloCatalogue', () => {
  it('reports duplicate ids', () => {
    const findings = validateSloCatalogue([slo(), slo()]);
    expect(findings.map((f) => f.rule)).toEqual(['duplicate-id']);
  });

  it('reports every entry rather than stopping at the first', () => {
    const findings = validateSloCatalogue([
      slo({ id: 'first', owner: '' }),
      slo({ id: 'second', runbookUrl: 'nope' }),
    ]);
    expect(findings.map((f) => f.sloId).sort()).toEqual(['first', 'second']);
  });
});

describe('assertValidSlo', () => {
  it('lists every violation in one throw', () => {
    // Fixing them one synth at a time is how the last one gets committed.
    expect(() => assertValidSlo(slo({ owner: '', runbookUrl: 'nope' }))).toThrow(
      /owner-missing[\s\S]*runbook-url-invalid/,
    );
  });

  it('passes a valid objective through', () => {
    expect(() => assertValidSlo(slo())).not.toThrow();
  });
});

describe('the shipped catalogue', () => {
  it('has no violations', () => {
    expect(validateSloCatalogue()).toEqual([]);
  });

  it('declares at least one active objective', () => {
    expect(SLO_CATALOGUE.filter((s) => s.status === 'active').length).toBeGreaterThan(0);
  });

  it('gives every objective a traffic rate that clears every policy it uses', () => {
    // The assertion the catalogue is most likely to drift out of: tightening an
    // objective shrinks the error budget, which raises every single-event floor,
    // and nothing about the traffic rate changes to say so.
    for (const definition of SLO_CATALOGUE) {
      for (const p of policiesFor(definition)) {
        expect(windowFloorEvents(definition, p.shortWindowMinutes)).toBeGreaterThanOrEqual(
          singleEventFloor(definition, p.burnRate),
        );
      }
    }
  });

  it('keeps the proposed latency objective unbuildable-by-ALB on purpose', () => {
    const latency = requireSlo('production-api-latency');
    expect(latency.status).toBe('proposed');
    expect(latency.sli.kind).toBe('latency');
    expect(latency.blockedOn).toMatch(/TargetResponseTime/);
  });
});
