/**
 * Percentage rollout, resolved on the application side.
 *
 * This is application code, not infrastructure. It lives in the CDK package for
 * one reason: everything here is compiled by `tsc` and run by `jest`, and a
 * bucketing function that was never executed is exactly the kind of thing that
 * looks right in review and assigns 70% of users to a 25% rollout. Copy it into
 * your service — it has no dependencies.
 *
 * ## Why the application has to do this
 *
 * AppConfig does not split traffic. Its deployment strategy shifts a *new
 * configuration* out to polling clients over a window (10%/minute here), which
 * controls how fast a change reaches your fleet — not how many users see the
 * feature. Once the deployment completes, every process has the same
 * configuration, and `rolloutPercentage: 25` is just a number sitting in it.
 * Something has to decide which quarter of users that number refers to, and
 * only the application knows who is asking.
 *
 * That is worth being explicit about because the two rollouts are easy to
 * confuse and behave completely differently under a rollback: undoing a
 * configuration deployment takes minutes and affects everyone, while lowering a
 * percentage takes effect on the next poll and affects exactly the users above
 * the new line.
 *
 * ## What the assignment has to guarantee
 *
 * **Stable.** The same subject gets the same answer on every request, from
 * every process, for the life of the rollout. A user who sees a feature on one
 * request and not the next has not been given a feature, they have been given a
 * bug — and no experiment measured that way means anything.
 *
 * **Independent per flag.** Bucketing on the subject alone would put the same
 * users in the first 10% of *every* rollout: one unlucky cohort receives every
 * unfinished feature in the product, and two experiments running at once are
 * silently correlated. Hashing the flag key together with the subject
 * decorrelates them.
 *
 * **Nested.** Raising 10% to 25% must keep the original 10% inside the new set.
 * Assigning a fixed position on a 0–99 line and comparing it against the
 * percentage does this by construction; drawing a fresh random number per
 * evaluation does not, and reshuffles the cohort on every change.
 *
 * **Cheap.** This runs on every request. FNV-1a is a non-cryptographic hash
 * chosen for that: it is a few instructions per byte with no allocation. Do not
 * use it where an adversary must not be able to find their own bucket — if
 * users can pay to be in the treatment group, hash a server-side secret in with
 * the key.
 */

/** A flag as it appears in the manifest, narrowed to what a rollout decision needs. */
export interface RolloutFlag {
  readonly enabled: boolean;
  /** Absent means "everyone, once enabled" — the common case for a kill switch. */
  readonly rolloutPercentage?: number;
}

/**
 * FNV-1a, 32-bit.
 *
 * Chosen over a hand-rolled multiply-and-add because the avalanche behaviour
 * matters here: adjacent subject ids (`user-1000`, `user-1001`) must not land in
 * adjacent buckets, or a rollout keyed on sequential ids serves a contiguous
 * block of accounts — typically the oldest ones — rather than a spread.
 */
export const fnv1a32 = (input: string): number => {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, in 32-bit arithmetic that stays inside a double.
    hash = Math.imul(hash, 0x01000193);
  }

  // `>>> 0` reinterprets the sign bit, since `Math.imul` returns a signed int32.
  return hash >>> 0;
};

/**
 * The subject's fixed position on a 0–99 line for one flag.
 *
 * Exported because it is the number to log when a rollout looks wrong: given a
 * subject that should have seen a feature and did not, this says which side of
 * the line they were on, without having to reproduce the request.
 */
export const rolloutBucket = (flagKey: string, subjectId: string): number =>
  fnv1a32(`${flagKey}:${subjectId}`) % 100;

/**
 * Whether `subjectId` is inside `flag`'s rollout.
 *
 * The subject is whatever the rollout is *about* — usually a stable user id,
 * an account id for a feature that must not differ between colleagues, or a
 * session id for anonymous traffic. It must not be a request id: a new value
 * per request re-rolls the dice on every page load.
 *
 * A flag that is off is off for everyone, whatever its percentage says; an
 * enabled flag with no percentage is on for everyone.
 */
export const isFlagEnabledFor = (
  flagKey: string,
  flag: RolloutFlag,
  subjectId: string,
): boolean => {
  if (!flag.enabled) return false;

  const percentage = flag.rolloutPercentage;
  if (percentage === undefined || percentage >= 100) return true;
  if (percentage <= 0) return false;

  // Strictly less-than: a bucket of 0 is inside a 1% rollout and a bucket of 99
  // is outside a 99% one, so exactly `percentage` of the hundred buckets match.
  return rolloutBucket(flagKey, subjectId) < percentage;
};
