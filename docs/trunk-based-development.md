# Trunk-based development guardrails

Trunk-based development is a working agreement: everyone commits to one branch,
several times a day, behind flags rather than behind branches. The agreement
survives contact with a real team only if the repository makes the alternative
inconvenient, so this repository ships three guardrails and the audit that keeps
them honest.

| Guardrail | Where it lives | What it stops |
|-----------|----------------|---------------|
| Required status checks | `.github/rulesets/trunk-based-main.json` | Merging trunk red |
| Merge queue | the same ruleset | Merging a batch that was never tested together |
| Short-lived branches | `.github/workflows/trunk-guardrails.yml` | Branches that stop being branches |
| Audit of all three | `npm run audit:trunk` | The three quietly disagreeing |

## Applying the ruleset

The ruleset is config-as-code and is **not** applied automatically. Review it,
then apply it with the GitHub CLI:

```bash
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/Kojo-Brown/boilerplate-devops/rulesets \
  --input .github/rulesets/trunk-based-main.json
```

To update an existing ruleset, find its id and `PUT` the same file:

```bash
gh api /repos/Kojo-Brown/boilerplate-devops/rulesets --jq '.[] | "\(.id)\t\(.name)"'
gh api --method PUT /repos/Kojo-Brown/boilerplate-devops/rulesets/<id> \
  --input .github/rulesets/trunk-based-main.json
```

Applying it requires admin on the repository, which CI deliberately does not
have. The file is the source of truth; the API call is a deployment of it.

Turning the ruleset on for the first time also needs **Settings → General →
Pull Requests → Allow merge queue** to be enabled, because the ruleset's
`merge_queue` rule configures a queue but does not create the option.

## Required status checks

A check may be required **only if it reports on every event that can merge**.
That is one rule with two halves, and the second half is the one that gets
missed.

```json
{ "context": "CDK typecheck, test, synth", "integration_id": 15368 }
```

- **`context`** is the check-run name, which is a job's `name:` if it has one
  and its key under `jobs:` otherwise. Renaming the job renames the check and
  orphans the rule.
- **`integration_id`** binds the name to the app allowed to report it — `15368`
  is GitHub Actions. Without it the rule is satisfied by *any* app, or any token
  with `checks:write`, posting a green check of that name. A required check that
  anyone can report is a required check in name only.

Checks that come from a third-party app are deliberately absent from the
ruleset. An app that does not run on `merge_group` cannot report inside the
queue, and a required check that never reports does not fail the entry — it
holds it until `check_response_timeout_minutes` expires and then evicts it,
along with everything queued behind it.

`strict_required_status_checks_policy` is `false` on purpose. It means "the
branch must be up to date with the base before merging", which is precisely the
job the merge queue does, and enabling both restores the rebase-and-wait
serialisation the queue exists to remove.

## Merge queue

Without a queue, two pull requests that are individually green can be red
together: each was tested against trunk as it was, not against trunk as it will
be. The queue tests the combination — it builds a temporary
`gh-readonly-queue/main/pr-N-<sha>` branch containing trunk plus every entry
ahead of this one, runs the required checks against it, and merges only if they
pass.

Two consequences follow, and both are load-bearing:

**Every required check must trigger on `merge_group`.** Nothing else fires for
a queue branch — not `push`, not `pull_request`. A workflow that only knows
about pull requests contributes nothing to the queue and stalls it.

**No required check may be skippable.** Three ways a check silently stops
reporting, all of which the audit rejects:

- a `paths:` or `paths-ignore:` filter on the trigger — the workflow does not
  run at all, and its checks are never created;
- a job-level `if:` — the job reports *skipped*, which rulesets do not count as
  passing;
- a matrix — the legs report `Name (22)` and `Name (24)`, never `Name`.

The fix for the first two is the same: keep the job unconditional so it always
reports, and put the condition on the steps inside it.
`.github/workflows/trunk-guardrails.yml` is written that way, and does nothing
but say so when it runs on a queue entry.

**Concurrency groups must vary per entry.** `cancel-in-progress: true` on a
group that is the same string for every queue branch means each entry cancels
the one ahead of it. The cancelled run reports as failed, its pull request is
evicted having never been tested, and the whole thing presents as flaky CI.
Including `github.ref` in the group is enough: it is
`refs/heads/gh-readonly-queue/main/pr-N-<sha>`, distinct per entry.

`grouping_strategy: ALLGREEN` requires every entry in a batch to be green, so a
failing entry takes only itself out. `HEADGREEN` merges the batch if the head
entry is green, which is faster and merges untested combinations; do not use it
with a required-checks rule that is meant to mean something.

## Short-lived branches

There is no GitHub setting for this, so it is measured on the pull request by
`.github/workflows/trunk-guardrails.yml`.

| Measure | Default | Why |
|---------|---------|-----|
| `max-branch-age-hours` | 48 | Age of the oldest commit unique to the branch |
| `max-changed-lines` | 400 | Added plus deleted lines against the merge base |

Both are needed. Age alone lets a one-hour branch land a 4,000-line rewrite —
a big-bang merge that happened to be written quickly. Size alone lets a
three-line branch sit open for a fortnight, drifting from trunk the entire time.

Age is taken from the **author** date, not the committer date. A rebase rewrites
the committer date of every commit it touches, so committer date would restart
the clock on exactly the branches that have been alive long enough to need
rebasing.

Lockfiles are excluded from the line count by default
(`size-exclude-paths`). They are generated, they are not read in review, and a
dependency bump would otherwise fail a guardrail aimed at review burden.

What the check does *not* measure is how far behind trunk the branch is. With a
merge queue, that is the queue's problem: it rebuilds each entry on current
trunk before merging. Gating on it as well would be the same mistake as
`strict_required_status_checks_policy`.

Both thresholds are advisory in the sense that matters — they describe a
practice, not a correctness property — so `enforcement: warn` annotates and
passes. Use it to find the current distribution before turning it on hard.

### What this repository runs

The defaults above are the conventional numbers for an application repository.
This repository is not one: its unit of work is one `SPEC.md` item — a CDK
stack or a workflow template, with its tests and its documentation — and the
twenty merged changes before this feature measure 438 to 3,280 lines excluding
lockfiles, median ≈ 920. A 400-line cap would fail every conforming pull
request, and a limit nobody can meet is not enforcement, it is noise that
teaches people to ignore a red check.

So this repository self-applies at **1,200 lines** (roughly the 75th percentile
of that distribution, so it annotates the genuinely large ones) in **warn**
mode, which is the advice above taken at face value. The age limit is unchanged
at 48h — nothing in the working agreement argues for a long-lived branch.

Those numbers are the literals on the right of each `||` in the workflow's `env`
block; the `default:` values on the inputs are what callers get. The two differ
deliberately and the block says so.

### Using it from another repository

```yaml
jobs:
  guardrails:
    uses: Kojo-Brown/boilerplate-devops/.github/workflows/trunk-guardrails.yml@main
    with:
      max-branch-age-hours: "24"
      max-changed-lines: "300"
      enforcement: warn
```

The workflow triggers on `pull_request` and `merge_group` as well as
`workflow_call`, so it guards this repository directly and is callable from
others. Because the `inputs` context is empty for events other than
`workflow_call`, each input is read as `inputs.x || '<default>'` rather than
relying on the declared `default:`, which only applies to the called form.

## When a branch fails the check

Splitting is the answer, not raising the limit:

1. Land the part that is finished, behind a flag if it is not ready to be used.
   `aws/appconfig/feature-flags.example.json` and
   `workflow-templates/deploy-feature-flags.yml` are the mechanism here.
2. Branch again from trunk for the rest.
3. Keep the flag's removal on the backlog — a flag that outlives its rollout is
   a long-lived branch that moved into the source tree.

Raising `max-changed-lines` for one pull request raises it for every pull
request after it, which is how a guardrail becomes a formality.

## The audit

`npm run audit:trunk` (in `aws/cdk`, and a step in the `CDK` CI job) reads every
ruleset under `.github/rulesets/` and every workflow under `.github/workflows/`
and checks that they agree.

Nothing in GitHub does this. A ruleset can require a check no workflow produces,
and a workflow can stop producing a check the ruleset still requires; both edits
are accepted, and both surface only when a pull request that looked ready sits
at *"Expected — waiting for status to be reported"*. With a queue enabled, the
same mistake stalls the queue rather than one pull request.

The rules and the failure each prevents are listed in the header comment of
`aws/cdk/tools/audit-trunk-guardrails.ts`, and each has a test in
`aws/cdk/test/audit-trunk-guardrails.test.ts` that proves it fires.
