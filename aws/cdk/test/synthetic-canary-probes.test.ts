import {
  CANARY_HANDLER,
  CANARY_HANDLER_SOURCE,
  CANARY_METRIC_NAMESPACE,
  ENVIRONMENT_DIMENSION,
  PROBE_DIMENSION,
  PROBE_FAILURE_METRIC,
  PROBE_LATENCY_METRIC,
  REGION_DIMENSION,
  REQUIRED_PROBE_ENV_VARS,
  SyntheticCanaryFleet,
  canaryNameFor,
  probeEnvironment,
  requireCanaryFleet,
  validateCanaryFleet,
} from '../lib/synthetic-canary-probes';

/**
 * Tests for the fleet contract.
 *
 * The rules are the part that is wrong in practice, and every one of them
 * describes a fleet AWS would accept, deploy and run — so each case below is
 * written as "this deploys cleanly and reports nothing", not as "this is
 * invalid input".
 *
 * The last block is the load-bearing one: it holds the handler script against
 * the constants the stacks and the audit gate read. They are otherwise three
 * copies of ten environment-variable names in three files, with nothing in AWS
 * reconciling them, and a mismatch produces a probe that fails every run or a
 * metric nothing publishes.
 */

const fleet = (overrides: Partial<SyntheticCanaryFleet> = {}): SyntheticCanaryFleet => ({
  envName: 'production',
  regions: ['us-east-1', 'eu-west-1', 'ap-southeast-1'],
  aggregationRegion: 'eu-west-1',
  quorum: 2,
  probes: [
    {
      name: 'health',
      url: 'https://www.example.com/healthz',
      bodyMarker: '"status":"ok"',
      latencyBudgetMs: 2_000,
    },
  ],
  ...overrides,
});

const rules = (spec: SyntheticCanaryFleet): string[] =>
  validateCanaryFleet(spec).violations.map((violation) => violation.rule);

describe('a fleet that would deploy and report nothing', () => {
  it('accepts the reference fleet', () => {
    expect(rules(fleet())).toEqual([]);
  });

  it('refuses a single probe region', () => {
    expect(rules(fleet({ regions: ['us-east-1'], quorum: 2 }))).toContain('single-region-fleet');
  });

  // Two canaries in one region are two votes from one place, so the sum
  // reaches a quorum of two on evidence from a single region.
  it('refuses a repeated region, which votes twice', () => {
    expect(rules(fleet({ regions: ['us-east-1', 'us-east-1'] }))).toContain(
      'duplicate-probe-region',
    );
  });

  it('refuses a quorum of one, which is what the per-region alarms already do', () => {
    expect(rules(fleet({ quorum: 1 }))).toContain('quorum-below-two');
  });

  // The alarm deploys, evaluates for ever, and cannot reach its threshold.
  it('refuses a quorum above the number of regions', () => {
    expect(rules(fleet({ quorum: 4 }))).toContain('quorum-exceeds-regions');
  });

  it('refuses more datapoints to alarm than evaluation periods', () => {
    expect(rules(fleet({ evaluationPeriods: 2, datapointsToAlarm: 3 }))).toContain(
      'datapoints-exceed-evaluation-periods',
    );
  });
});

describe('a probe that would pass against an outage', () => {
  const withProbe = (probe: Partial<SyntheticCanaryFleet['probes'][number]>): string[] =>
    rules(
      fleet({
        probes: [
          {
            name: 'health',
            url: 'https://www.example.com/healthz',
            bodyMarker: '"status":"ok"',
            latencyBudgetMs: 2_000,
            ...probe,
          },
        ],
      }),
    );

  it('refuses a probe with no body marker', () => {
    expect(withProbe({ bodyMarker: '   ' })).toContain('probe-without-body-marker');
  });

  it('refuses a plaintext URL, which cannot see a certificate expire', () => {
    expect(withProbe({ url: 'http://www.example.com/healthz' })).toContain(
      'probe-over-plaintext-http',
    );
  });

  it('refuses a probe that expects a redirect rather than the application', () => {
    expect(withProbe({ expectedStatus: 302 })).toContain('expected-status-not-success');
  });

  it('refuses a 204, which has no body for the marker to match', () => {
    expect(withProbe({ expectedStatus: 204 })).toContain('expected-status-without-body');
  });
});

describe('limits AWS enforces at deploy time and CDK does not', () => {
  // CDK's own canary-name validation allows 255 characters; CloudWatch
  // Synthetics allows 21. Without this rule the failure is a CREATE_FAILED in
  // every probe region at once, with nothing in review that predicted it.
  it('refuses a canary name over 21 characters', () => {
    expect(
      rules(
        fleet({
          probes: [
            {
              name: 'checkout-and-payment',
              url: 'https://www.example.com/checkout',
              bodyMarker: 'basket',
              latencyBudgetMs: 2_000,
            },
          ],
        }),
      ),
    ).toContain('canary-name-too-long');
    expect(canaryNameFor('production', 'checkout-and-payment')).toHaveLength(31);
  });

  it('refuses a canary name Synthetics will not accept', () => {
    expect(
      rules(
        fleet({
          envName: 'Production',
          probes: [
            {
              name: 'health',
              url: 'https://www.example.com/healthz',
              bodyMarker: 'ok',
              latencyBudgetMs: 2_000,
            },
          ],
        }),
      ),
    ).toContain('canary-name-invalid-characters');
  });

  it('refuses a schedule outside the rate() range Synthetics accepts', () => {
    expect(
      rules(
        fleet({
          probes: [
            {
              name: 'health',
              url: 'https://www.example.com/healthz',
              bodyMarker: 'ok',
              latencyBudgetMs: 2_000,
              scheduleMinutes: 90,
            },
          ],
        }),
      ),
    ).toContain('schedule-outside-synthetics-range');
  });

  it('refuses a timeout that would overlap runs', () => {
    expect(
      rules(
        fleet({
          probes: [
            {
              name: 'health',
              url: 'https://www.example.com/healthz',
              bodyMarker: 'ok',
              latencyBudgetMs: 2_000,
              scheduleMinutes: 1,
              timeoutSeconds: 120,
            },
          ],
        }),
      ),
    ).toContain('timeout-exceeds-schedule');
  });

  it('refuses a timeout above the 14-minute ceiling', () => {
    expect(
      rules(
        fleet({
          probes: [
            {
              name: 'health',
              url: 'https://www.example.com/healthz',
              bodyMarker: 'ok',
              latencyBudgetMs: 2_000,
              scheduleMinutes: 60,
              timeoutSeconds: 900,
            },
          ],
        }),
      ),
    ).toContain('timeout-exceeds-maximum');
  });

  // The run is killed before the assertion is reached, so the budget is a
  // number in a runbook that no run can ever breach.
  it('refuses a latency budget at or above the run timeout', () => {
    expect(
      rules(
        fleet({
          probes: [
            {
              name: 'health',
              url: 'https://www.example.com/healthz',
              bodyMarker: 'ok',
              latencyBudgetMs: 60_000,
              timeoutSeconds: 60,
            },
          ],
        }),
      ),
    ).toContain('latency-budget-exceeds-timeout');
  });
});

describe('arithmetic that reads correct', () => {
  it('refuses a detection budget the schedule cannot meet', () => {
    const violations = validateCanaryFleet(
      fleet({
        maxDetectionMinutes: 5,
        datapointsToAlarm: 2,
        probes: [
          {
            name: 'health',
            url: 'https://www.example.com/healthz',
            bodyMarker: 'ok',
            latencyBudgetMs: 2_000,
            scheduleMinutes: 10,
          },
        ],
      }),
    ).violations;
    expect(violations.map((v) => v.rule)).toContain('detection-slower-than-declared');
    expect(violations[0].message).toContain('20 minutes');
  });

  it('reports the detection time each probe actually achieves', () => {
    const { resolved } = validateCanaryFleet(fleet({ datapointsToAlarm: 2 }));
    expect(resolved.probes[0].scheduleMinutes).toBe(5);
    expect(resolved.probes[0].detectionMinutes).toBe(10);
    expect(resolved.probes[0].alarmPeriodSeconds).toBe(300);
  });
});

describe('requireCanaryFleet', () => {
  it('names every rule it refused, not just the first', () => {
    expect(() => requireCanaryFleet(fleet({ regions: ['us-east-1'], quorum: 1 }))).toThrow(
      /single-region-fleet[\s\S]*quorum-below-two/,
    );
  });

  it('returns the resolved fleet when the spec is sound', () => {
    expect(requireCanaryFleet(fleet()).probes[0].canaryName).toBe('production-health');
  });
});

describe('the handler and the constants around it', () => {
  const environment = probeEnvironment({
    probe: requireCanaryFleet(fleet()).probes[0],
    envName: 'production',
    region: 'us-east-1',
    aggregationRegion: 'eu-west-1',
  });

  it('sets every variable the handler requires', () => {
    for (const name of REQUIRED_PROBE_ENV_VARS) {
      expect(environment[name]).toBeDefined();
      expect(environment[name]).not.toBe('');
    }
  });

  it('publishes from the probe region to the aggregation region', () => {
    expect(environment.PROBE_REGION).toBe('us-east-1');
    expect(environment.PROBE_AGGREGATION_REGION).toBe('eu-west-1');
    expect(environment.PROBE_METRIC_NAMESPACE).toBe(CANARY_METRIC_NAMESPACE);
  });

  // The script and the constants are edited independently and nothing in AWS
  // reconciles them: a renamed variable produces a probe that throws on its
  // first line, and a renamed dimension produces a metric the quorum alarm
  // will never find.
  it('reads exactly the variables the stack sets', () => {
    for (const name of REQUIRED_PROBE_ENV_VARS) {
      expect(CANARY_HANDLER_SOURCE).toContain(`process.env.${name}`);
    }
    expect(CANARY_HANDLER_SOURCE).toContain(JSON.stringify(REQUIRED_PROBE_ENV_VARS));
  });

  it('publishes the metrics and dimensions the alarms read', () => {
    for (const literal of [
      PROBE_FAILURE_METRIC,
      PROBE_LATENCY_METRIC,
      ENVIRONMENT_DIMENSION,
      PROBE_DIMENSION,
      REGION_DIMENSION,
    ]) {
      expect(CANARY_HANDLER_SOURCE).toContain(`'${literal}'`);
    }
  });

  it('fails the run rather than adapting when configuration is missing', () => {
    expect(CANARY_HANDLER_SOURCE).toContain('Probe misconfigured, missing: ');
  });

  // The verdict has to be published on the failure path too: the quorum alarm
  // reads the republished series, and a thrown run that published nothing is a
  // gap rather than a failure.
  it('publishes before it rethrows', () => {
    const publishAt = CANARY_HANDLER_SOURCE.indexOf('await publish(cfg,');
    const rethrowAt = CANARY_HANDLER_SOURCE.indexOf('throw failure;');
    expect(publishAt).toBeGreaterThan(0);
    expect(rethrowAt).toBeGreaterThan(publishAt);
  });

  // Inline code is the only form CDK accepts an arbitrary handler name for —
  // and it does not accept one.
  it('uses the handler name inline code requires', () => {
    expect(CANARY_HANDLER).toBe('index.handler');
    expect(CANARY_HANDLER_SOURCE).toContain('exports.handler');
  });

  // The artifact bucket would otherwise accumulate a copy of every response
  // the probe ever received, for as long as the lifecycle rule keeps it.
  it('keeps response bodies out of the artifact bucket', () => {
    expect(CANARY_HANDLER_SOURCE).toContain('includeResponseBody: false');
    expect(CANARY_HANDLER_SOURCE).toContain('includeRequestBody: false');
  });
});
