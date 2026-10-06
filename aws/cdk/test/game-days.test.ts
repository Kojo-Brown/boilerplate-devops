import {
  DRILL_POLL_INTERVAL_SECONDS,
  GAME_DAY_METRICS,
  GAME_DAY_SCENARIOS,
  GameDayScenario,
  MAX_DRILL_INSTANCE_AGE_SECONDS,
  MAX_RESOLUTION_SECONDS,
  MAX_REHEARSAL_INTERVAL_DAYS,
  METRIC_CONNECT_SUCCESS,
  METRIC_MEASURED_RESTORE_SECONDS,
  METRIC_RESTORE_POINT_LAG,
  MIN_REHEARSAL_INTERVAL_DAYS,
  MIN_RTO_PERIODS,
  PROBE_SAMPLES_PER_INVOCATION,
  PROBE_SAMPLE_INTERVAL_SECONDS,
  PROBE_SCHEDULE_SECONDS,
  ProbeDatapoint,
  RECORDER_INTERVAL_SECONDS,
  RECOVERY_OBJECTIVES,
  RESTORED_BYTES_FLOOR,
  RESTORED_BYTES_TOLERANCE,
  RESTORE_VERIFICATION_CHECKS,
  RecoveryObjective,
  RehearsalRecord,
  RestoreVerificationCheck,
  assertValidGameDayCatalogue,
  drillInstanceIdentifier,
  gameDayDocumentName,
  lastMeasuredAt,
  measureRestore,
  measureRto,
  measurementResolutionSeconds,
  mergeRehearsalLog,
  objectiveFor,
  parseRehearsalLog,
  rehearsalFreshness,
  rehearsalParameterName,
  restorePointAlarmThresholdSeconds,
  restorePointIsFresh,
  restorePointLag,
  restorePointStaleAfterSeconds,
  restoreVerdict,
  restoredBytesMatch,
  scenariosFor,
  validateGameDayCatalogue,
  verdictFor,
} from '../lib/game-days';

/**
 * Tests for the catalogue and the arithmetic.
 *
 * The load-bearing ones are the refusals. Every branch in `measureRto` that
 * returns `conclusive: false` is a case where the obvious implementation returns
 * a plausible RTO instead — and the plausible answer is always the flattering
 * one, so a regression here does not produce a wrong number that somebody
 * queries. It produces a good number nobody has reason to doubt.
 */

const objective = (overrides: Partial<RecoveryObjective> = {}): RecoveryObjective => ({
  id: 'test-objective',
  title: 'A thing breaks',
  anchor: '#2-a-thing-breaks',
  owner: 'platform-team',
  path: 'multi-az-promotion',
  status: 'declared',
  rtoSeconds: 120,
  rpoSeconds: 0,
  rpoBasis: 'synchronous-replication',
  measuredBy: METRIC_CONNECT_SUCCESS,
  rehearsalIntervalDays: 90,
  summary: 'A summary long enough to be a sentence about what was promised.',
  ...overrides,
});

const scenario = (overrides: Partial<GameDayScenario> = {}): GameDayScenario => ({
  id: 'test-scenario',
  title: 'Break the thing',
  objectiveId: 'test-objective',
  fault: 'rds-force-failover',
  trigger: 'approval',
  allowedEnvironments: ['staging'],
  preflight: ['multi-az-enabled', 'probe-reporting'],
  abortIf: ['operator-abort'],
  expectedDurationMinutes: 20,
  summary: 'Reboot with ForceFailover and read the outage off the probe.',
  ...overrides,
});

const rules = (findings: { rule: string }[]): string[] => findings.map((finding) => finding.rule);

/* ── The shipped catalogue ────────────────────────────────────────────────── */

describe('the shipped catalogue', () => {
  it('is valid, which the stack asserts at synth time', () => {
    expect(validateGameDayCatalogue()).toEqual([]);
    expect(() => assertValidGameDayCatalogue()).not.toThrow();
  });

  it('declares one objective per recovery path, which is the point of the file', () => {
    const paths = RECOVERY_OBJECTIVES.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('claims a zero RPO only where the commit is synchronous', () => {
    for (const entry of RECOVERY_OBJECTIVES) {
      if (entry.rpoSeconds === 0) expect(entry.rpoBasis).toBe('synchronous-replication');
    }
  });

  it('measures every objective by a metric something publishes', () => {
    for (const entry of RECOVERY_OBJECTIVES) {
      expect(GAME_DAY_METRICS).toContain(entry.measuredBy);
    }
  });

  it('exercises every rehearsed objective exactly once, and no declared one', () => {
    for (const entry of RECOVERY_OBJECTIVES) {
      expect(scenariosFor(entry).length).toBe(entry.status === 'rehearsed' ? 1 : 0);
    }
  });

  it('resolves every scenario to an objective', () => {
    for (const entry of GAME_DAY_SCENARIOS) {
      expect(objectiveFor(entry)).toBeDefined();
    }
  });

  it('keeps every objective above the floor its own measurement can resolve', () => {
    for (const entry of RECOVERY_OBJECTIVES) {
      expect(entry.rtoSeconds).toBeGreaterThanOrEqual(
        MIN_RTO_PERIODS * PROBE_SAMPLE_INTERVAL_SECONDS,
      );
    }
  });

  it('samples often enough inside one invocation to beat the EventBridge floor', () => {
    // The whole reason the probe samples at all. If these drift apart so that
    // the samples no longer span the schedule, the series has a hole in it every
    // minute and every measurement is marginal.
    expect(PROBE_SAMPLE_INTERVAL_SECONDS * PROBE_SAMPLES_PER_INVOCATION).toBeGreaterThanOrEqual(
      PROBE_SCHEDULE_SECONDS - PROBE_SAMPLE_INTERVAL_SECONDS,
    );
    expect(PROBE_SAMPLE_INTERVAL_SECONDS * PROBE_SAMPLES_PER_INVOCATION).toBeLessThanOrEqual(
      PROBE_SCHEDULE_SECONDS,
    );
  });

  it('keeps the tolerated resolution a small fraction of the smallest legal objective', () => {
    expect(MAX_RESOLUTION_SECONDS).toBeLessThanOrEqual(
      (MIN_RTO_PERIODS * PROBE_SAMPLE_INTERVAL_SECONDS) / 5,
    );
  });
});

/* ── Names ────────────────────────────────────────────────────────────────── */

describe('names', () => {
  it('builds the document name the automation is registered under', () => {
    expect(gameDayDocumentName('production', 'rds-failover')).toBe(
      'production-gameday-rds-failover',
    );
  });

  it('builds an absolute parameter path, which SSM requires', () => {
    expect(rehearsalParameterName('staging', 'rds-multi-az-promotion')).toBe(
      '/staging/game-day/rds-multi-az-promotion/last-rehearsal',
    );
  });
});

/* ── Validation ───────────────────────────────────────────────────────────── */

describe('validateGameDayCatalogue', () => {
  it('reports an empty catalogue, which otherwise passes every other rule', () => {
    expect(rules(validateGameDayCatalogue([], []))).toContain('catalogue-empty');
  });

  it('refuses a zero RPO on a restore path — the conflation the file exists to stop', () => {
    const findings = validateGameDayCatalogue(
      [objective({ rpoSeconds: 0, rpoBasis: 'latest-restorable-time' })],
      [],
    );
    expect(rules(findings)).toContain('rpo-zero-without-synchronous-basis');
  });

  it('refuses a non-zero RPO on a synchronous path, which is the same error inverted', () => {
    const findings = validateGameDayCatalogue([objective({ rpoSeconds: 30 })], []);
    expect(rules(findings)).toContain('rpo-nonzero-on-synchronous-basis');
  });

  it('refuses an objective the probe cannot resolve', () => {
    const findings = validateGameDayCatalogue([objective({ rtoSeconds: 30 })], []);
    expect(rules(findings)).toContain('rto-below-measurable-resolution');
  });

  it('refuses an RTO of zero, which makes every measurement a miss', () => {
    expect(rules(validateGameDayCatalogue([objective({ rtoSeconds: 0 })], []))).toContain(
      'rto-not-positive',
    );
  });

  it('refuses a metric nothing publishes', () => {
    const findings = validateGameDayCatalogue(
      [objective({ measuredBy: 'NotAMetric' as never })],
      [],
    );
    expect(rules(findings)).toContain('measured-by-unknown-metric');
  });

  it('refuses a rehearsal interval that is a way of writing "never"', () => {
    expect(
      rules(
        validateGameDayCatalogue(
          [objective({ rehearsalIntervalDays: MAX_REHEARSAL_INTERVAL_DAYS + 1 })],
          [],
        ),
      ),
    ).toContain('rehearsal-interval-out-of-range');
    expect(
      rules(
        validateGameDayCatalogue(
          [objective({ rehearsalIntervalDays: MIN_REHEARSAL_INTERVAL_DAYS - 1 })],
          [],
        ),
      ),
    ).toContain('rehearsal-interval-out-of-range');
  });

  it('reports a rehearsed objective nothing exercises', () => {
    const findings = validateGameDayCatalogue([objective({ status: 'rehearsed' })], []);
    expect(rules(findings)).toContain('objective-rehearsed-without-scenario');
  });

  it('reports a declared objective something exercises, so the alarm is never armed', () => {
    const findings = validateGameDayCatalogue([objective({ status: 'declared' })], [scenario()]);
    expect(rules(findings)).toContain('objective-declared-with-scenario');
  });

  it('reports two scenarios over one objective, which overwrite each other\'s record', () => {
    const findings = validateGameDayCatalogue(
      [objective({ status: 'rehearsed' })],
      [scenario(), scenario({ id: 'second' })],
    );
    expect(rules(findings)).toContain('objective-with-two-scenarios');
  });

  it('reports an objective declared twice — one parameter path between them', () => {
    const findings = validateGameDayCatalogue([objective(), objective()], []);
    expect(rules(findings)).toContain('duplicate-objective-id');
  });

  it('reports two objectives on one recovery path', () => {
    const findings = validateGameDayCatalogue(
      [objective(), objective({ id: 'other', anchor: '#3-other' })],
      [],
    );
    expect(rules(findings)).toContain('duplicate-recovery-path');
  });

  it('reports two objectives claiming one section', () => {
    const findings = validateGameDayCatalogue(
      [objective(), objective({ id: 'other', path: 'point-in-time-restore', rpoSeconds: 300, rpoBasis: 'latest-restorable-time', measuredBy: METRIC_RESTORE_POINT_LAG })],
      [],
    );
    expect(rules(findings)).toContain('duplicate-objective-anchor');
  });

  it('refuses a malformed anchor and a non-kebab id', () => {
    const findings = validateGameDayCatalogue(
      [objective({ id: 'Not_Kebab', anchor: 'no-hash' })],
      [],
    );
    expect(rules(findings)).toEqual(
      expect.arrayContaining(['objective-id-not-kebab-case', 'objective-anchor-malformed']),
    );
  });

  it('refuses an owner who is a person', () => {
    const findings = validateGameDayCatalogue([objective({ owner: 'someone@example.com' })], []);
    expect(rules(findings)).toContain('objective-owner-is-an-individual');
  });

  it('refuses a scenario with no blast radius, and one with a wildcard', () => {
    expect(
      rules(validateGameDayCatalogue([objective()], [scenario({ allowedEnvironments: [] })])),
    ).toContain('scenario-without-allowed-environments');
    expect(
      rules(validateGameDayCatalogue([objective()], [scenario({ allowedEnvironments: ['*'] })])),
    ).toContain('scenario-allowed-environment-wildcard');
  });

  it('refuses a destructive scenario nobody has to approve', () => {
    const findings = validateGameDayCatalogue(
      [objective()],
      [scenario({ trigger: 'schedule', scheduleIntervalDays: 30 })],
    );
    // Both halves: the approval that is missing, and the schedule that is
    // there. A reader removing the schedule and a reader adding the approval
    // are fixing the same thing from opposite ends, and each should see that
    // the other finding agreed.
    expect(rules(findings)).toContain('destructive-scenario-without-approval');
    expect(rules(findings)).toContain('destructive-scenario-scheduled');
  });

  it('refuses a scheduled scenario with no cadence, and an approved one that declares one', () => {
    const drillObjective = objective({
      id: 'restore-objective',
      anchor: '#restore-objective',
      path: 'point-in-time-restore',
      rpoBasis: 'latest-restorable-time',
      rpoSeconds: 300,
      rtoSeconds: 1800,
      measuredBy: METRIC_MEASURED_RESTORE_SECONDS,
      rehearsalIntervalDays: 30,
    });
    const drill = scenario({
      id: 'restore-drill',
      objectiveId: 'restore-objective',
      fault: 'rds-point-in-time-restore',
      trigger: 'schedule',
      preflight: ['restore-point-available', 'no-drill-instance-present'],
      abortIf: ['operator-abort', 'verification-failed', 'restore-not-available-in-time'],
    });

    expect(
      rules(validateGameDayCatalogue([drillObjective], [drill])),
    ).toContain('scheduled-scenario-without-interval');

    expect(
      rules(validateGameDayCatalogue([objective()], [scenario({ scheduleIntervalDays: 30 })])),
    ).toContain('approval-scenario-with-interval');
  });

  it('refuses a cadence slower than the objective it is supposed to keep fresh', () => {
    // 60 days against a 30-day shelf life means the overdue alarm is red for
    // half of every cycle, with nothing anybody can do but widen the interval
    // they just chose.
    const drillObjective = objective({
      id: 'restore-objective',
      anchor: '#restore-objective',
      path: 'point-in-time-restore',
      rpoBasis: 'latest-restorable-time',
      rpoSeconds: 300,
      rtoSeconds: 1800,
      measuredBy: METRIC_MEASURED_RESTORE_SECONDS,
      rehearsalIntervalDays: 30,
    });
    const findings = validateGameDayCatalogue(
      [drillObjective],
      [
        scenario({
          id: 'restore-drill',
          objectiveId: 'restore-objective',
          fault: 'rds-point-in-time-restore',
          trigger: 'schedule',
          scheduleIntervalDays: 60,
          preflight: ['restore-point-available', 'no-drill-instance-present'],
          abortIf: ['operator-abort', 'verification-failed', 'restore-not-available-in-time'],
        }),
      ],
    );
    expect(rules(findings)).toContain('schedule-slower-than-rehearsal-interval');
  });

  it('refuses a restore drill without its own preflights and abort conditions', () => {
    const drillObjective = objective({
      id: 'restore-objective',
      anchor: '#restore-objective',
      path: 'point-in-time-restore',
      rpoBasis: 'latest-restorable-time',
      rpoSeconds: 300,
      rtoSeconds: 1800,
      measuredBy: METRIC_MEASURED_RESTORE_SECONDS,
      rehearsalIntervalDays: 30,
    });
    const findings = validateGameDayCatalogue(
      [drillObjective],
      [
        scenario({
          id: 'restore-drill',
          objectiveId: 'restore-objective',
          fault: 'rds-point-in-time-restore',
          trigger: 'schedule',
          scheduleIntervalDays: 30,
          preflight: [],
          abortIf: ['operator-abort'],
        }),
      ],
    );
    expect(rules(findings)).toContain('restore-drill-without-required-preflight');
    expect(rules(findings)).toContain('restore-drill-without-required-abort');
  });

  it('refuses a forced failover with no Multi-AZ preflight — the same call is a reboot', () => {
    const findings = validateGameDayCatalogue(
      [objective()],
      [scenario({ preflight: ['probe-reporting'] })],
    );
    expect(rules(findings)).toContain('failover-without-multi-az-preflight');
  });

  it('refuses a probe-measured scenario that does not check the probe is reporting', () => {
    const findings = validateGameDayCatalogue(
      [objective()],
      [scenario({ preflight: ['multi-az-enabled'] })],
    );
    expect(rules(findings)).toContain('scenario-without-probe-preflight');
  });

  it('refuses a probe preflight on a scenario whose measurement never touches the probe', () => {
    // A check that cannot fail for any reason the exercise cares about is the
    // kind of green that teaches people to stop reading the others.
    const drillObjective = objective({
      id: 'restore-objective',
      anchor: '#restore-objective',
      path: 'point-in-time-restore',
      rpoBasis: 'latest-restorable-time',
      rpoSeconds: 300,
      rtoSeconds: 1800,
      measuredBy: METRIC_MEASURED_RESTORE_SECONDS,
      rehearsalIntervalDays: 30,
    });
    const findings = validateGameDayCatalogue(
      [drillObjective],
      [
        scenario({
          id: 'restore-drill',
          objectiveId: 'restore-objective',
          fault: 'rds-point-in-time-restore',
          trigger: 'schedule',
          scheduleIntervalDays: 30,
          preflight: ['restore-point-available', 'no-drill-instance-present', 'probe-reporting'],
          abortIf: ['operator-abort', 'verification-failed', 'restore-not-available-in-time'],
        }),
      ],
    );
    expect(rules(findings)).toContain('scenario-with-irrelevant-probe-preflight');
  });

  it('refuses a preflight or an abort condition nothing implements', () => {
    const findings = validateGameDayCatalogue(
      [objective()],
      [
        scenario({
          preflight: ['multi-az-enabled', 'probe-reporting', 'looks-fine' as never],
          abortIf: ['operator-abort', 'someone-shouts' as never],
        }),
      ],
    );
    expect(rules(findings)).toEqual(
      expect.arrayContaining(['scenario-preflight-unknown', 'scenario-abort-condition-unknown']),
    );
  });

  it('refuses an exercise a human cannot stop', () => {
    const findings = validateGameDayCatalogue([objective()], [scenario({ abortIf: [] })]);
    expect(rules(findings)).toContain('scenario-without-operator-abort');
  });

  it('refuses a scenario naming an objective that is not there', () => {
    const findings = validateGameDayCatalogue([], [scenario({ objectiveId: 'gone' })]);
    expect(rules(findings)).toContain('scenario-objective-unknown');
  });

  it('reports a scenario declared twice — both map to one document name', () => {
    const findings = validateGameDayCatalogue([objective()], [scenario(), scenario()]);
    expect(rules(findings)).toContain('duplicate-scenario-id');
  });

  it('throws with every finding at once, not the first', () => {
    expect(() =>
      assertValidGameDayCatalogue([objective({ rtoSeconds: 0, rpoSeconds: 5 })], []),
    ).toThrow(/rto-not-positive[\s\S]*rpo-nonzero-on-synchronous-basis/);
  });
});

/* ── measureRto ───────────────────────────────────────────────────────────── */

const SAMPLE_MS = PROBE_SAMPLE_INTERVAL_SECONDS * 1000;
const T0 = new Date('2026-09-30T12:00:00.000Z');

/** A uniform series from `pattern`: 1 is a success, 0 a failure. */
const series = (pattern: readonly number[], start = T0): ProbeDatapoint[] =>
  pattern.map((connectSuccess, index) => ({
    timestamp: new Date(start.getTime() + index * SAMPLE_MS),
    connectSuccess,
  }));

const window = (datapoints: readonly ProbeDatapoint[]) => ({
  windowStart: new Date(T0.getTime() - SAMPLE_MS),
  windowEnd: new Date(
    datapoints[datapoints.length - 1].timestamp.getTime() + SAMPLE_MS,
  ),
});

describe('measureRto', () => {
  it('measures first failure to first success, not last success to first success', () => {
    // Success, then six failures, then success: the outage starts at the first
    // failing sample. Measuring from the last success would add a whole sample
    // interval, and a generous RTO is generous about how long a dependent
    // service should be willing to wait.
    const datapoints = series([1, 0, 0, 0, 0, 0, 0, 1]);
    const result = measureRto(datapoints, window(datapoints));
    expect(result.conclusive).toBe(true);
    if (!result.conclusive) return;
    expect(result.rtoSeconds).toBe(6 * PROBE_SAMPLE_INTERVAL_SECONDS);
    expect(result.failedDatapoints).toBe(6);
    expect(result.resolutionSeconds).toBe(PROBE_SAMPLE_INTERVAL_SECONDS);
    expect(result.outageStartedAt.toISOString()).toBe('2026-09-30T12:00:10.000Z');
    expect(result.recoveredAt.toISOString()).toBe('2026-09-30T12:01:10.000Z');
    expect(result.lastHealthyAt.toISOString()).toBe('2026-09-30T12:00:00.000Z');
  });

  it('refuses an empty window rather than averaging nothing to zero', () => {
    const result = measureRto([], { windowStart: T0, windowEnd: new Date(T0.getTime() + 60000) });
    expect(result).toEqual({ conclusive: false, reason: 'no-datapoints' });
  });

  it('refuses a window in which nothing failed — the fault missed, or the probe did', () => {
    const datapoints = series([1, 1, 1, 1]);
    expect(measureRto(datapoints, window(datapoints))).toEqual({
      conclusive: false,
      reason: 'no-outage-observed',
    });
  });

  it('refuses a window that opens on a failure: the outage began before it', () => {
    const datapoints = series([0, 0, 1]);
    expect(measureRto(datapoints, window(datapoints))).toEqual({
      conclusive: false,
      reason: 'outage-began-before-window',
    });
  });

  it('refuses a window that ends still failing, and says how long it has been', () => {
    const datapoints = series([1, 0, 0, 0, 0]);
    const result = measureRto(datapoints, window(datapoints));
    expect(result).toEqual({
      conclusive: false,
      reason: 'outage-unresolved-in-window',
      atLeastSeconds: 3 * PROBE_SAMPLE_INTERVAL_SECONDS,
    });
  });

  it('refuses a hole across the outage rather than reading it as a fast recovery', () => {
    // Success at t0, failure at t+10, then nothing for five minutes, then a
    // success. The true RTO is somewhere between 10s and 310s, and an
    // implementation that trusts adjacent datapoints would report 300 — or, with
    // the samples the other way round, 10.
    const datapoints: ProbeDatapoint[] = [
      { timestamp: T0, connectSuccess: 1 },
      { timestamp: new Date(T0.getTime() + SAMPLE_MS), connectSuccess: 0 },
      { timestamp: new Date(T0.getTime() + 300_000), connectSuccess: 1 },
    ];
    expect(measureRto(datapoints, window(datapoints))).toEqual({
      conclusive: false,
      reason: 'datapoint-gap-across-outage',
    });
  });

  it('reports the widest gap around the event as the measurement\'s resolution', () => {
    const datapoints: ProbeDatapoint[] = [
      { timestamp: T0, connectSuccess: 1 },
      { timestamp: new Date(T0.getTime() + 15_000), connectSuccess: 0 },
      { timestamp: new Date(T0.getTime() + 25_000), connectSuccess: 1 },
    ];
    const result = measureRto(datapoints, window(datapoints));
    expect(result.conclusive).toBe(true);
    if (!result.conclusive) return;
    expect(result.resolutionSeconds).toBe(15);
    expect(result.rtoSeconds).toBe(10);
  });

  it('tolerates a hole up to the limit it is given, and refuses one past it', () => {
    const datapoints: ProbeDatapoint[] = [
      { timestamp: T0, connectSuccess: 1 },
      { timestamp: new Date(T0.getTime() + 30_000), connectSuccess: 0 },
      { timestamp: new Date(T0.getTime() + 40_000), connectSuccess: 1 },
    ];
    expect(measureRto(datapoints, { ...window(datapoints), maxResolutionSeconds: 30 }).conclusive).toBe(
      true,
    );
    expect(
      measureRto(datapoints, { ...window(datapoints), maxResolutionSeconds: 29 }),
    ).toEqual({ conclusive: false, reason: 'datapoint-gap-across-outage' });
  });

  it('ignores datapoints outside the window, and sorts what is left', () => {
    const datapoints = series([1, 0, 0, 1]);
    const shuffled = [datapoints[2], datapoints[0], datapoints[3], datapoints[1]];
    const before: ProbeDatapoint = {
      timestamp: new Date(T0.getTime() - 3_600_000),
      connectSuccess: 0,
    };
    const result = measureRto([before, ...shuffled], window(datapoints));
    expect(result.conclusive).toBe(true);
    if (!result.conclusive) return;
    expect(result.rtoSeconds).toBe(2 * PROBE_SAMPLE_INTERVAL_SECONDS);
  });

  it('finds the first outage in the window and not the worst', () => {
    // A measurement is bounded by the exercise, so the first outage after the
    // fault is the exercise's. Picking the longest would attribute somebody
    // else's incident to the game day.
    const datapoints = series([1, 0, 1, 0, 0, 0, 0, 1]);
    const result = measureRto(datapoints, window(datapoints));
    expect(result.conclusive).toBe(true);
    if (!result.conclusive) return;
    expect(result.rtoSeconds).toBe(PROBE_SAMPLE_INTERVAL_SECONDS);
  });
});

/* ── verdictFor ───────────────────────────────────────────────────────────── */

describe('verdictFor', () => {
  const measured = (rtoSeconds: number, resolutionSeconds = PROBE_SAMPLE_INTERVAL_SECONDS) =>
    ({
      conclusive: true as const,
      lastHealthyAt: T0,
      outageStartedAt: T0,
      recoveredAt: T0,
      rtoSeconds,
      resolutionSeconds,
      failedDatapoints: 1,
    });

  it('meets the objective at the boundary', () => {
    expect(verdictFor(objective({ rtoSeconds: 120 }), measured(120))).toBe('met');
  });

  it('calls an overrun inside the measurement\'s own uncertainty what it is', () => {
    expect(verdictFor(objective({ rtoSeconds: 120 }), measured(129))).toBe(
      'within-measurement-error',
    );
  });

  it('misses when the overrun is larger than the uncertainty', () => {
    expect(verdictFor(objective({ rtoSeconds: 120 }), measured(131))).toBe('missed');
  });
});

/* ── restorePointLag ──────────────────────────────────────────────────────── */

describe('restorePointLag', () => {
  const now = new Date('2026-09-30T12:00:00.000Z');

  it('reports the age of the restore point', () => {
    expect(restorePointLag(new Date('2026-09-30T11:55:00.000Z'), now)).toEqual({
      usable: true,
      lagSeconds: 300,
    });
  });

  it('reports an absent timestamp as absent, not as a lag of zero', () => {
    // An instance with backup retention set to zero has no LatestRestorableTime.
    // The RPO is not small there; there is no restore path at all.
    expect(restorePointLag(undefined, now)).toEqual({ usable: false, reason: 'absent' });
  });

  it('refuses a timestamp in the future rather than clamping it to a perfect RPO', () => {
    expect(restorePointLag(new Date('2026-09-30T12:05:00.000Z'), now)).toEqual({
      usable: false,
      reason: 'in-the-future',
    });
  });
});

describe('restorePointAlarmThresholdSeconds', () => {
  it('clears the sawtooth by a sample interval', () => {
    const entry = objective({ rpoSeconds: 300, rpoBasis: 'latest-restorable-time' });
    expect(restorePointAlarmThresholdSeconds(entry)).toBe(300 + 2 * RECORDER_INTERVAL_SECONDS);
  });

  it('stays above what a sampler can see on a healthy instance', () => {
    // The whole reason the threshold is not the objective: the lag sawtooths up
    // to one step, and a sampler can miss the trough by up to one interval.
    const entry = objective({ rpoSeconds: 300, rpoBasis: 'latest-restorable-time' });
    expect(restorePointAlarmThresholdSeconds(entry)).toBeGreaterThan(
      entry.rpoSeconds + RECORDER_INTERVAL_SECONDS,
    );
  });
});

/* ── The record ───────────────────────────────────────────────────────────── */

const record = (overrides: Partial<RehearsalRecord> = {}): RehearsalRecord => ({
  objectiveId: 'test-objective',
  scenarioId: 'test-scenario',
  startedAt: '2026-09-30T12:00:00.000Z',
  completedAt: '2026-09-30T12:10:00.000Z',
  outcome: 'measured',
  measuredRtoSeconds: 90,
  resolutionSeconds: 10,
  executionId: 'exec-1',
  ...overrides,
});

describe('the rehearsal log', () => {
  it('keeps the last measurement when the latest attempt aborted', () => {
    // The whole reason there are two fields. With one, a preflight that refuses
    // resets the clock and the objective looks freshly rehearsed on the strength
    // of an exercise that injected nothing.
    const measured = mergeRehearsalLog(undefined, record());
    const aborted = mergeRehearsalLog(
      measured,
      record({ outcome: 'aborted', completedAt: '2026-10-05T09:00:00.000Z', note: 'an alarm was red' }),
    );
    expect(aborted.lastAttempt.outcome).toBe('aborted');
    expect(aborted.lastMeasured?.completedAt).toBe('2026-09-30T12:10:00.000Z');
    expect(lastMeasuredAt(aborted)?.toISOString()).toBe('2026-09-30T12:10:00.000Z');
  });

  it('has no last measurement when nothing has ever been measured', () => {
    const aborted = mergeRehearsalLog(undefined, record({ outcome: 'aborted', note: 'refused' }));
    expect(aborted.lastMeasured).toBeUndefined();
    expect(lastMeasuredAt(aborted)).toBeUndefined();
  });

  it('reads an absent or unparseable log as no log, rather than throwing', () => {
    // Throwing here takes the freshness metric off the air, and an objective
    // with no freshness metric has no overdue alarm.
    expect(parseRehearsalLog(undefined)).toBeUndefined();
    expect(parseRehearsalLog('not json')).toBeUndefined();
    expect(parseRehearsalLog('{"objectiveId":"x"}')).toBeUndefined();
    expect(lastMeasuredAt(undefined)).toBeUndefined();
    expect(lastMeasuredAt({ objectiveId: 'x', lastAttempt: record(), lastMeasured: record({ completedAt: 'nonsense' }) })).toBeUndefined();
  });

  it('round-trips through the parameter value', () => {
    const log = mergeRehearsalLog(undefined, record());
    expect(parseRehearsalLog(JSON.stringify(log))).toEqual(log);
  });
});

describe('rehearsalFreshness', () => {
  const entry = objective({ rehearsalIntervalDays: 90 });
  const now = new Date('2026-09-30T12:00:00.000Z');

  it('treats an objective that has never been measured as overdue immediately', () => {
    // Treating "no record" as "not due yet" would arm the alarm only once
    // somebody had already done the thing it exists to remind them of.
    expect(rehearsalFreshness(entry, undefined, now)).toEqual({ overdue: true });
  });

  it('is not overdue inside the interval, and says when it comes due', () => {
    const result = rehearsalFreshness(entry, new Date('2026-09-01T12:00:00.000Z'), now);
    expect(result.overdue).toBe(false);
    expect(result.hoursSince).toBeCloseTo(29 * 24, 5);
    expect(result.dueInDays).toBeCloseTo(61, 5);
  });

  it('is overdue past it', () => {
    const result = rehearsalFreshness(entry, new Date('2026-01-01T12:00:00.000Z'), now);
    expect(result.overdue).toBe(true);
    expect(result.dueInDays).toBeLessThan(0);
  });
});

/* ── The restore drill's arithmetic ───────────────────────────────────────── */

describe('measurementResolutionSeconds', () => {
  it('is the probe\'s interval for a probe-measured objective and the drill\'s poll for a drill', () => {
    const promotion = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-multi-az-promotion')!;
    const restore = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-point-in-time-restore')!;
    expect(measurementResolutionSeconds(promotion)).toBe(PROBE_SAMPLE_INTERVAL_SECONDS);
    expect(measurementResolutionSeconds(restore)).toBe(DRILL_POLL_INTERVAL_SECONDS);
  });

  it('is what the floor rule is written against, so each objective is judged by its own ruler', () => {
    // The restore objective is 1800s against a 30s poll — fine. It would have
    // been fine against the probe's 10s too; what matters is that the rule asks
    // the right question, which a single global constant could not.
    const restore = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-point-in-time-restore')!;
    expect(restore.rtoSeconds).toBeGreaterThanOrEqual(
      MIN_RTO_PERIODS * measurementResolutionSeconds(restore),
    );
    const tooShort: RecoveryObjective = { ...restore, rtoSeconds: 120 };
    expect(
      validateGameDayCatalogue([tooShort], []).map((finding) => finding.rule),
    ).toContain('rto-below-measurable-resolution');
  });
});

describe('restoreVerdict', () => {
  const pass = (check: RestoreVerificationCheck) => ({ check, passed: true, detail: 'ok' });

  it('is verified only when every check ran and every check passed', () => {
    expect(restoreVerdict(RESTORE_VERIFICATION_CHECKS.map(pass))).toBe('verified');
  });

  it('fails on one failing check, whichever it is', () => {
    for (const failing of RESTORE_VERIFICATION_CHECKS) {
      const results = RESTORE_VERIFICATION_CHECKS.map((check) =>
        check === failing ? { check, passed: false, detail: 'no' } : pass(check),
      );
      expect(restoreVerdict(results)).toBe('failed');
    }
  });

  it('fails on a check that produced no result, because a pass rate is not a verdict', () => {
    // The shape a verifier that threw halfway leaves behind. "The verifier
    // crashed after three checks" has to be as loud as "the data is not there":
    // from the outside they are the same amount of knowledge.
    const partial = RESTORE_VERIFICATION_CHECKS.slice(0, 3).map(pass);
    expect(restoreVerdict(partial)).toBe('failed');
  });
});

describe('restoredBytesMatch', () => {
  const GIB = 1024 * 1024 * 1024;
  /** 100 GiB allocated, `usedGiB` of it in use. */
  const usage = (allocatedGiB: number, usedGiB: number) => ({
    allocatedStorageGiB: allocatedGiB,
    freeStorageBytes: (allocatedGiB - usedGiB) * GIB,
  });

  it('matches a copy holding the source\'s bytes', () => {
    const comparison = restoredBytesMatch(usage(100, 40), usage(100, 40));
    expect(comparison.matches).toBe(true);
    expect(comparison.ratio).toBeCloseTo(1);
  });

  it('catches the restore that completed and brought back an empty volume', () => {
    // The failure this check exists for, and it is not a near miss: a few
    // hundred MB of engine files against 40 GiB of data.
    const comparison = restoredBytesMatch(usage(100, 40), usage(100, 0.3));
    expect(comparison.matches).toBe(false);
    expect(comparison).toMatchObject({ reason: 'restored-too-small' });
  });

  it('computes used bytes per instance, so storage autoscaling is not a mismatch', () => {
    // maxAllocatedStorage is set on the source, so the two volumes can differ
    // in size while holding the same data. Comparing free space directly would
    // report a good restore as a failure the first time the source grew.
    const comparison = restoredBytesMatch(usage(200, 40), usage(100, 40));
    expect(comparison.matches).toBe(true);
  });

  it('refuses to vouch for a source too small to tell an empty restore from a full one', () => {
    // Reported as a failed check rather than skipped: "this drill cannot tell
    // whether the data came back" is a finding about the drill.
    const comparison = restoredBytesMatch(usage(100, 0.5), usage(100, 0.5));
    expect(comparison.matches).toBe(false);
    expect(comparison).toMatchObject({ reason: 'source-too-small' });
    expect(comparison.sourceUsedBytes).toBeLessThan(RESTORED_BYTES_FLOOR);
  });

  it('is wide enough for WAL and narrow enough for an order of magnitude', () => {
    const sourceUsed = 40;
    const justInside = sourceUsed * (1 + RESTORED_BYTES_TOLERANCE * 0.9);
    const justOutside = sourceUsed * (1 + RESTORED_BYTES_TOLERANCE * 1.1);
    expect(restoredBytesMatch(usage(100, sourceUsed), usage(100, justInside)).matches).toBe(true);
    const over = restoredBytesMatch(usage(100, sourceUsed), usage(100, justOutside));
    expect(over.matches).toBe(false);
    expect(over).toMatchObject({ reason: 'restored-too-large' });
  });
});

describe('restorePointIsFresh', () => {
  const objective = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-point-in-time-restore')!;
  const ceiling = restorePointStaleAfterSeconds(objective);
  const point = new Date('2026-07-01T12:00:00Z');
  const after = (seconds: number) => new Date(point.getTime() + seconds * 1000);

  it('is two RPOs: one for the mechanism, one for the drill\'s own latency', () => {
    expect(ceiling).toBe(objective.rpoSeconds * 2);
  });

  it('accepts a copy created inside the ceiling and refuses one outside it', () => {
    expect(restorePointIsFresh(point, after(60), ceiling)).toBe(true);
    expect(restorePointIsFresh(point, after(ceiling), ceiling)).toBe(true);
    expect(restorePointIsFresh(point, after(ceiling + 1), ceiling)).toBe(false);
  });

  it('refuses a copy created before the restore point it claims to be from', () => {
    // The restore came from an older point than the one the preflight read,
    // which is the failure a point-in-time restore exists to avoid and which
    // every other check in the drill passes happily.
    expect(restorePointIsFresh(point, after(-1), ceiling)).toBe(false);
  });
});

describe('measureRestore', () => {
  it('is the span from the copy being created to it being verified', () => {
    const created = new Date('2026-07-01T12:00:00Z');
    const verified = new Date('2026-07-01T12:23:20Z');
    expect(measureRestore(created, verified)).toEqual({
      restoreSeconds: 1400,
      resolutionSeconds: DRILL_POLL_INTERVAL_SECONDS,
    });
  });

  it('carries the drill\'s poll interval as its uncertainty, which errs long', () => {
    const created = new Date('2026-07-01T12:00:00Z');
    const measurement = measureRestore(created, new Date('2026-07-01T12:30:00Z'));
    expect(measurement.resolutionSeconds).toBe(DRILL_POLL_INTERVAL_SECONDS);
    const objective = RECOVERY_OBJECTIVES.find(
      (entry) => entry.id === 'rds-point-in-time-restore',
    )!;
    // The same `verdictFor` the failover exercise uses, which is the point: a
    // restore measurement is an RTO measurement, and a second verdict function
    // for it would be a second place for the "within measurement error" rule to
    // drift. 1800s against an 1800s objective is `met`.
    expect(
      verdictFor(objective, {
        conclusive: true,
        lastHealthyAt: created,
        outageStartedAt: created,
        recoveredAt: new Date(created.getTime() + measurement.restoreSeconds * 1000),
        rtoSeconds: measurement.restoreSeconds,
        resolutionSeconds: measurement.resolutionSeconds,
        failedDatapoints: 1,
      }),
    ).toBe('met');

    // And one poll interval over the objective is within measurement error
    // rather than a miss, because the poll is what pushed it there.
    expect(
      verdictFor(objective, {
        conclusive: true,
        lastHealthyAt: created,
        outageStartedAt: created,
        recoveredAt: created,
        rtoSeconds: objective.rtoSeconds + DRILL_POLL_INTERVAL_SECONDS,
        resolutionSeconds: DRILL_POLL_INTERVAL_SECONDS,
        failedDatapoints: 1,
      }),
    ).toBe('within-measurement-error');
  });

  it('refuses a negative span rather than publishing one', () => {
    // Which happens when the instance described is a copy left over from an
    // earlier run. A negative RTO on a graph is worse than no datapoint.
    expect(() =>
      measureRestore(new Date('2026-07-01T12:30:00Z'), new Date('2026-07-01T12:00:00Z')),
    ).toThrow(/not about the same restore/);
  });
});

describe('the drill\'s names and windows', () => {
  it('names one copy per environment, as a literal a grant can be scoped to', () => {
    expect(drillInstanceIdentifier('production')).toBe('production-dr-drill');
    expect(drillInstanceIdentifier('staging')).toBe('staging-dr-drill');
  });

  it('leaves a wide margin between a drill and an abandoned copy', () => {
    const drill = GAME_DAY_SCENARIOS.find((entry) => entry.fault === 'rds-point-in-time-restore')!;
    // The sweeper deletes what it finds, so the only thing worse than an
    // orphaned copy is one deleted out from under a drill that was working.
    expect(MAX_DRILL_INSTANCE_AGE_SECONDS).toBeGreaterThan(
      drill.expectedDurationMinutes * 60 * 4,
    );
  });

  it('measures the restore objective by the metric the drill publishes', () => {
    const restore = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-point-in-time-restore')!;
    expect(restore.measuredBy).toBe(METRIC_MEASURED_RESTORE_SECONDS);
    expect(restore.status).toBe('rehearsed');
    expect(GAME_DAY_METRICS).toContain(METRIC_MEASURED_RESTORE_SECONDS);
  });
});
