import {
  fnv1a32,
  isFlagEnabledFor,
  rolloutBucket,
} from '../lib/feature-flag-bucketing';

const subjects = (count: number, prefix = 'user-'): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);

const share = (flagKey: string, percentage: number, ids: readonly string[]): number =>
  ids.filter((id) => isFlagEnabledFor(flagKey, { enabled: true, rolloutPercentage: percentage }, id))
    .length / ids.length;

describe('fnv1a32', () => {
  it('matches the published FNV-1a 32-bit vectors', () => {
    // Without a known-answer test this is just "some function that returns a
    // number", and a transcription error in the offset basis or the prime would
    // be invisible: the distribution would still look plausible.
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('stays inside unsigned 32-bit range', () => {
    for (const id of subjects(500)) {
      const hash = fnv1a32(id);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('rolloutBucket', () => {
  it('is stable for the same flag and subject', () => {
    expect(rolloutBucket('newDashboard', 'user-42')).toBe(rolloutBucket('newDashboard', 'user-42'));
  });

  it('lands in 0..99', () => {
    for (const id of subjects(1000)) {
      const bucket = rolloutBucket('newDashboard', id);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it('spreads sequential ids rather than grouping them', () => {
    // The failure this catches: a weaker hash puts `user-1000..user-1099` in a
    // contiguous block of buckets, so a 10% rollout serves one continuous range
    // of accounts — in practice the oldest ones, who are the least
    // representative sample available.
    const buckets = subjects(100, 'user-10').map((id) => rolloutBucket('newDashboard', id));
    expect(new Set(buckets).size).toBeGreaterThan(50);
  });
});

describe('isFlagEnabledFor', () => {
  describe('the switch', () => {
    it('is off for everyone when the flag is off, whatever the percentage says', () => {
      const ids = subjects(500);
      expect(share('newDashboard', 0, ids)).toBe(0);
      expect(
        ids.filter((id) =>
          isFlagEnabledFor('newDashboard', { enabled: false, rolloutPercentage: 100 }, id),
        ),
      ).toEqual([]);
    });

    it('is on for everyone when there is no percentage at all', () => {
      const ids = subjects(500);
      expect(ids.every((id) => isFlagEnabledFor('maintenanceMode', { enabled: true }, id))).toBe(
        true,
      );
    });

    it('is on for everyone at 100', () => {
      expect(share('newDashboard', 100, subjects(500))).toBe(1);
    });
  });

  describe('the split', () => {
    it.each([1, 5, 10, 25, 50, 75, 99])('serves about %s%% of subjects', (percentage) => {
      // 20k subjects; ±1.5 points is roughly six standard errors, so this fails
      // on a real bias and not on the sample.
      const observed = share('newDashboard', percentage, subjects(20_000)) * 100;
      expect(Math.abs(observed - percentage)).toBeLessThan(1.5);
    });

    it('counts buckets exactly across the whole space', () => {
      // Every bucket 0..99 is one percent of the space, so a percentage
      // evaluated over one subject per bucket must match exactly. This is the
      // boundary test the statistical one above cannot be: strictly-less-than
      // versus less-than-or-equal is a one-point error that hides in sampling.
      const perBucket = new Map<number, string>();
      for (let i = 0; perBucket.size < 100 && i < 100_000; i += 1) {
        const id = `user-${i}`;
        const bucket = rolloutBucket('newDashboard', id);
        if (!perBucket.has(bucket)) perBucket.set(bucket, id);
      }
      expect(perBucket.size).toBe(100);

      const ids = [...perBucket.values()];
      expect(share('newDashboard', 1, ids) * 100).toBe(1);
      expect(share('newDashboard', 37, ids) * 100).toBe(37);
      expect(share('newDashboard', 99, ids) * 100).toBe(99);
    });
  });

  describe('the guarantees a rollout depends on', () => {
    it('keeps the same subjects when the percentage is raised', () => {
      // Nesting. If raising 10% to 25% reshuffled the cohort, a user who had
      // the feature would lose it as the rollout widened, and every metric
      // gathered before the change would describe a different population.
      const ids = subjects(5_000);
      const inTen = ids.filter((id) =>
        isFlagEnabledFor('newDashboard', { enabled: true, rolloutPercentage: 10 }, id),
      );
      const inTwentyFive = new Set(
        ids.filter((id) =>
          isFlagEnabledFor('newDashboard', { enabled: true, rolloutPercentage: 25 }, id),
        ),
      );

      expect(inTen.length).toBeGreaterThan(0);
      expect(inTen.every((id) => inTwentyFive.has(id))).toBe(true);
    });

    it('assigns each flag independently', () => {
      // Bucketing on the subject alone would make these sets identical: one
      // unlucky cohort would receive the first 10% of every rollout in the
      // product, and two experiments at once would be silently correlated.
      const ids = subjects(5_000);
      const first = new Set(
        ids.filter((id) => isFlagEnabledFor('newDashboard', { enabled: true, rolloutPercentage: 10 }, id)),
      );
      const second = ids.filter((id) =>
        isFlagEnabledFor('betaFeatures', { enabled: true, rolloutPercentage: 10 }, id),
      );

      const overlap = second.filter((id) => first.has(id)).length / second.length;
      // Independent 10% draws overlap on about 10% of the second set.
      expect(overlap).toBeLessThan(0.2);
      expect(overlap).toBeGreaterThan(0.02);
    });

    it('gives the same answer on every evaluation', () => {
      const flag = { enabled: true, rolloutPercentage: 30 };
      const first = subjects(200).map((id) => isFlagEnabledFor('newDashboard', flag, id));
      const second = subjects(200).map((id) => isFlagEnabledFor('newDashboard', flag, id));
      expect(first).toEqual(second);
    });
  });

  describe('percentages outside the range', () => {
    it('treats anything at or below zero as off and at or above 100 as on', () => {
      // `npm run audit:flags` rejects these before they can be deployed; this
      // is what the function does if one arrives anyway, and it is deliberately
      // the safe reading rather than an exception on a request path.
      const id = 'user-1';
      expect(isFlagEnabledFor('f', { enabled: true, rolloutPercentage: -10 }, id)).toBe(false);
      expect(isFlagEnabledFor('f', { enabled: true, rolloutPercentage: 250 }, id)).toBe(true);
    });
  });
});
