# Feature flag lifecycle

A feature flag is a branch in production that someone promised to delete.

The promise is the whole bargain. Flags are cheap to add — one `if`, one JSON
key — and each one doubles the number of code paths that exist at runtime. Ten
flags is a thousand and twenty-four possible configurations of your application,
of which your test suite covers one. A codebase that adds flags faster than it
removes them ends up in a state nobody has reasoned about, and the way it gets
there is not negligence: it is that `if (flags.newDashboard)` keeps working
perfectly for eighteen months after the rollout finished, and nothing anywhere
notices.

So the lifecycle here has three parts, and the third is the one that matters:

| Stage | Where it lives | What enforces it |
|---|---|---|
| **Creation** | `aws/appconfig/feature-flags*.json` | `npm run audit:flags` in CI, plus a JSON Schema validator on the AppConfig profile |
| **Rollout** | `rolloutPercentage` in the manifest, resolved by `aws/cdk/lib/feature-flag-bucketing.ts` | the deployment workflow, and AppConfig's own rollback monitors |
| **Cleanup** | `FeatureFlagLifecycleStack` | a daily sweep that reads what is deployed and files the removal as work |

---

## 1. Creation

A flag is declared in the manifest, and the declaration is the contract:

```json
{
  "version": "1",
  "flags": {
    "newDashboard": {
      "description": "Rebuilt dashboard shell, served to a share of signed-in users.",
      "kind": "release",
      "owner": "@web-platform",
      "ticket": "WEB-1421",
      "createdOn": "2026-08-03",
      "expiresOn": "2026-10-15",
      "enabled": true,
      "rolloutPercentage": 25
    }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `description` | always | What the flag guards, in a sentence somebody who did not write it can read |
| `kind` | always | `release`, `experiment`, or `operational` — see below |
| `owner` | always | Team handle. The sweep addresses issues to it |
| `createdOn` | always | ISO calendar day |
| `enabled` | always | The switch. `false` is off for everyone, whatever the percentage says |
| `ticket` | `release`, `experiment` | Where the *removal* is tracked — not where the feature was built |
| `expiresOn` | `release`, `experiment` | The day by which the flag should be gone |
| `rolloutPercentage` | optional | Whole number 0–100. Absent means "everyone, once enabled" |
| `value` | `operational` only | A JSON payload delivered with the flag |

### The three kinds

**`release`** — a rollout in progress. Ends when the feature is on for everyone
and the flag is deleted.

**`experiment`** — a measured comparison. Ends when the measurement concludes.

**`operational`** — a control: a kill switch, a rate limit, a circuit breaker.
These are *not* unfinished work, so asking for their removal date is asking the
wrong question. They carry no `expiresOn`, need no ticket, are the only kind
allowed to carry a `value`, and the cleanup sweep never reports them.

The distinction is load-bearing. Without it, the only way to hold a permanent
kill switch is to give it a fake deadline and renew it forever, which teaches
everyone reading the manifest that deadlines here are decoration.

### What is enforced, and where

`npm run audit:flags` runs on every pull request. It rejects a flag with no
owner, no ticket, or no expiry; a kind outside the vocabulary; a date that is not
a real calendar day (`2026-02-30` is rejected, not rolled forward into March); a
deadline before the creation date; a percentage that is not one; a field nothing
reads (`rolloutPct: 50` deploys fine, reads as 100%, and looks like 50% in
review); and the two rollout states that read as one thing and mean another — a
percentage on a flag that is switched off, and a flag switched on at 0%.

It also rejects a **lifetime longer than 90 days**. A deadline a year out is not
a plan; nobody setting it expects to be the one who meets it.

It deliberately does **not** fail the build for a flag that is *past* its
deadline. A flag's expiry has nothing to do with whether the pull request in
front of you is correct, and a gate that turns every build in the repository red
on a date somebody else chose is a gate teams learn to route around. The deadline
is enforced where it belongs: at deploy time, and by the daily sweep. Run
`npm run audit:flags -- --now` to check expiry explicitly.

Behind all of that, the manifest schema is attached to the AppConfig
configuration profile as a JSON Schema validator, so AppConfig rejects a
malformed version at `CreateHostedConfigurationVersion`. That is the check that
still applies when somebody uploads a version by hand instead of through the
workflow.

---

## 2. Rollout

**AppConfig does not split traffic.** This is the single most confused point in
the whole system, so it is worth being exact.

There are two different rollouts here:

**The configuration rollout** is AppConfig's deployment strategy — 10% per
minute over ten minutes, then a five-minute bake. It controls *how fast a change
reaches your fleet*, and it is what the CloudWatch rollback monitors watch. When
it finishes, every process in the environment has the same configuration.

**The flag rollout** is `rolloutPercentage`, and it controls *which users see the
feature*. AppConfig only ships the number. Something has to decide which quarter
of users `25` refers to, and only the application knows who is asking.

The two behave differently under a rollback, which is the practical reason to
keep them straight: undoing a configuration deployment takes minutes and affects
everyone; lowering a percentage takes effect on the next poll and affects exactly
the users above the new line.

### Resolving a percentage

`aws/cdk/lib/feature-flag-bucketing.ts` is the reference implementation — no
dependencies, compiled and tested in CI rather than illustrated. Copy it into
your service.

```ts
import { isFlagEnabledFor } from './feature-flag-bucketing';

if (isFlagEnabledFor('newDashboard', flags.newDashboard, user.id)) {
  return renderNewDashboard();
}
```

It guarantees four things, each of which is a bug if you get it wrong:

- **Stable.** The same subject gets the same answer on every request from every
  process. A user who sees a feature on one request and not the next has not been
  given a feature, they have been given a bug.
- **Independent per flag.** The flag key is hashed together with the subject. Without
  that, the same unlucky cohort lands in the first 10% of *every* rollout in the
  product, and two experiments running at once are silently correlated.
- **Nested.** Raising 10% to 25% keeps the original 10% inside the new set. A fresh
  random draw per evaluation would reshuffle the cohort on every change and
  invalidate every measurement taken before it.
- **Cheap.** FNV-1a, a few instructions per byte, no allocation. It is not
  cryptographic: if users can profit from knowing their own bucket, hash a
  server-side secret in with the flag key.

The subject is whatever the rollout is *about* — a stable user id, an account id
for a feature that must not differ between colleagues, a session id for anonymous
traffic. It must never be a request id.

### Shipping a change

```yaml
jobs:
  deploy-flags:
    uses: Kojo-Brown/boilerplate-devops/.github/workflows/deploy-feature-flags.yml@main
    with:
      config-file: aws/appconfig/feature-flags.json
      app-id: ${{ vars.APP_ID }}
      profile-id: ${{ vars.PROFILE_ID }}
      env-id: ${{ vars.PROD_ENV_ID }}
    secrets:
      AWS_ROLE_ARN: ${{ secrets.APPCONFIG_DEPLOY_ROLE_ARN }}
```

The workflow validates the manifest before it touches AWS, and **refuses to
deploy a manifest containing a flag that is already past its removal date**.
That is the deploy-time half of the expiry rule: you can merge with an overdue
flag, but you cannot ship another change on top of it without dealing with it.

Raising a percentage is an ordinary manifest change through the same path. There
is no separate "promote" step, and no state living in a console somewhere that
the repository does not know about.

---

## 3. Cleanup

`FeatureFlagLifecycleStack` runs a sweep once a day. It reads the configuration
that is **actually deployed** to each environment through the runtime Data API —
the same two calls your application makes — rather than the latest version in the
profile, because a version that was never deployed guards nothing and a version
that was deployed and rolled back still does.

Every flag it finds is classified:

| Reason | Meaning | Files an issue |
|---|---|---|
| `expired` | Past its removal date and still shipping | yes |
| `readyToRemove` | A temporary flag at 100% — the rollout is over, what is left is an unremoved branch | yes |
| `abandoned` | Older than 30 days and never turned on | yes |
| `expiring` | Within 14 days of its deadline | no — a heads-up, not yet work |

Each becomes a CloudWatch metric under the `FeatureFlags` namespace
(`StaleFlags` by `Reason` and `Environment`, plus `DeployedFlags`), a line in an
SNS summary, and — for the actionable three — a GitHub issue in the owning team's
backlog carrying the flag key, its owner, its ticket, and the removal
instructions.

The issue is the point. A metric tells you the debt exists. An issue with a name
on it is the smallest unit of work someone can pick up.

Issues are deduplicated by a `[flag:key@environment]` marker in the title, and
filed per environment, because a flag can be overdue in production and still
rolling out in staging. If the sweep cannot list the issues that are already
open, it files **none** that run rather than duplicating the backlog.

### It never deletes a flag

Removing a flag is three changes, in this order:

1. Delete the branch the flag guards, keeping the side that is live. Ship it.
2. Once that is deployed everywhere, remove the flag from the manifest.
3. Deploy the manifest.

The order is not a style preference. Delete the configuration first and every
running process reads a key that is no longer there — `undefined`, which is
falsy, which silently takes the branch the rollout was moving *away* from. An
automated cleanup that turned a finished 100% rollout back off in production
would be the most damaging thing in this repository, so the sweep escalates and
never mutates. Its IAM role has no AppConfig write permission at all, and a test
asserts that.

### When the sweep cannot see

A manifest it cannot parse, a version it does not understand, an environment it
cannot reach — each is reported as `ManifestUnreadable` and **does not count as
zero stale flags**. A sweep that cannot see is not a sweep that found nothing,
and an alarm wired to "stale flags = 0" would read a broken sweep as a clean
estate. `UnreadableManifestAlarm` covers exactly that case.

`ExpiredFlagsAlarm` needs the condition to hold across three consecutive daily
sweeps before it fires. One overdue day is somebody merging the removal tomorrow;
three is a flag nobody picked up.

### Configuration

```ts
new FeatureFlagLifecycleStack(app, 'FeatureFlagLifecycleStack', {
  application: appConfigStack.application,
  configurationProfileId: appConfigStack.featureFlagsConfig.configurationProfileId,
  environments: [{ name: 'production', environmentId: '...' }],
  repository: 'your-org/your-repo',
  githubTokenSecretArn: 'arn:aws:secretsmanager:...',  // needs issues: write
  warnWithinDays: 14,
  abandonedAfterDays: 30,
  dryRun: false,
});
```

Without `githubTokenSecretArn` the sweep still measures and notifies — it simply
cannot turn a measurement into somebody's work. Start with `dryRun: true` against
a real estate to see what it would file before it files it.
