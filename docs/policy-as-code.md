# Policy as code

## 1. Why there are two IaC gates

The `Checkov` job and the `Policy gate` job both read the CloudFormation that
`cdk synth` wrote, and they ask different questions.

Checkov asks whether a template breaks a rule that is true of everyone's
infrastructure: an unencrypted volume, a bucket open to the world, a load
balancer with no access logs. Those rules ship with the tool, they are numbered
(`CKV_AWS_16`), and they are the same in this repository as in yours.

The Conftest pack in `policy/cloudformation/` asks whether a template breaks a
rule that is true of *ours*: which tags a resource must carry, which three ports
may face the internet, what a database tagged `Environment=production` owes that
one tagged `Environment=preview` does not. None of those is expressible as a
Checkov check, because none of them is a fact about CloudFormation — they are
decisions this organisation made, and the gate is where they are written down.

The split shows up most clearly in what each one has to do about a correct
template it dislikes. A public ALB listening on port 80 to redirect to 443 trips
`CKV_AWS_260`, and the only thing to do about it is add the finding to
`.checkov.baseline` — which then silences that check for every *future* port-80
rule anywhere in the repository. `policy/cloudformation/network.rego` inverts
it: it names 80, 443 and 8443 as the ports that may be world-reachable and
denies everything else, so the ALB passes on its merits and a new `0.0.0.0/0`
on 22 or 5432 fails by default rather than only if somebody remembered to turn
a check on.

Both jobs read the synthesised templates rather than the TypeScript. Defaults,
aspects, escape hatches and the L2 constructs' own opinions all resolve in
between, so a rule written against construct props can be satisfied by code that
deploys something else.

## 2. The rules

| Rule | What it prevents |
| --- | --- |
| `required-tags` | A resource with no `ManagedBy`/`Stack` tag: invisible to cost allocation, unattributable in an account sweep. |
| `tag-shape-unsupported` | Tags given as a map, which the pack cannot read — so no tag rule would apply, silently. |
| `environment-tag-value` | A fourth spelling of an environment, which cost and access reports read as a fourth environment. |
| `image-not-digest-pinned` | A task definition on a mutable tag. ECS resolves it per *task placement*, so two tasks in one service can run different images with no CloudFormation drift. |
| `image-resolved-at-deploy-time` | An image built from an intrinsic, which no gate here can read. |
| `database-not-encrypted` | Encryption at rest that cannot be turned on in place later. |
| `production-database-single-az` | An AZ failure becoming an outage that lasts as long as a restore. |
| `production-database-deletable` | A renamed stack or a `cdk destroy` against the wrong profile taking the data with it. |
| `production-database-backup-window` | `BackupRetentionPeriod: 0`, which is CDK's default when the prop is omitted and disables automated backups entirely. |
| `world-open-ingress` | Anything but 80/443/8443 reachable from the internet — including a *range* whose two ends are both allowed. |
| `world-open-all-protocols` | `IpProtocol: "-1"`, the widest rule CloudFormation can express, which names no port and so is invisible to a port allowlist. |
| `log-retention-unset` | A log group that retains forever. Nothing fails; the cost simply never stops. |
| `log-retention-invalid` | A retention CloudWatch rejects — a failed stack update at the end of a pipeline rather than a red check on the PR. |
| `production-log-retention-floor` | An incident review that starts on Monday and a log that expired on Sunday. |
| `lambda-runtime-unsupported` | A runtime that has stopped being patched, discovered on the day the function can no longer be redeployed. |
| `lambda-runtime-unset` | A function this pack cannot vouch for, which skipping would make indistinguishable from one it can. |

`Environment` is deliberately **not** a required tag. `AppConfigStack`,
`DoraMetricsStack` and `FeatureFlagLifecycleStack` are account-scoped rather
than environment-scoped and carry none, and inventing a value like `shared` for
them would read in Cost Explorer as a fourth environment rather than as "spans
all of them". Where the tag is applied, `environment-tag-value` holds it to the
set the stacks actually use.

## 3. What runs, and in what order

`.github/scripts/run-policy-gate.sh` has three phases, and each is worthless
without the one before it.

1. **`conftest verify`** — the policies' own unit tests, in
   `policy/cloudformation/*_test.rego`. A rule can be wrong in a way that makes
   it never fire, and a gate made of rules that never fire is green against
   every repository in the world. 55 of these run today; they assert on the
   *set of rule ids* a template produces rather than on a failure count, so a
   test cannot keep passing because an unrelated rule started firing in place
   of the one under test.

2. **The deny canary** — `policy/fixtures/deny-canary.json`, a synthetic
   template that trips every rule exactly once. This checks the *wiring* rather
   than the rules, and it is the phase §4 exists to explain. The gate fails
   unless the set of rule ids reported on the canary equals
   `policy/canary-expectations.txt` exactly, in both directions.

3. **The scan** — every `*.template.json` the `cdk` job uploaded, against the
   `cloudformation` namespace.

Run it locally the way CI does:

```bash
cd aws/cdk && npx cdk synth --quiet && cd -
.github/scripts/run-policy-gate.sh aws/cdk/cdk.out
```

It needs `conftest` and `jq` on `PATH`. Install conftest the way the workflow
does — an exact version with its SHA-256 checked — not with `go install` or a
package manager, or your local run and CI are running different rule engines.

## 4. Why the canary exists

conftest evaluates the `main` package and nothing else unless told otherwise.
Point it at this pack, which declares `package cloudformation`, without a
`--namespace` and it prints:

```
0 tests, 0 passed, 0 warnings, 0 failures, 0 exceptions
```

and exits **0**. So does `--namespace cloudfromation`: a namespace matching no
package is not an error. The output of a gate that evaluated nothing and one
that found nothing differ by a number nobody reads, and the check is green
either way.

That is the class of failure this whole file is arranged around, and it has
three more members:

- **A `warn` where a `deny` was meant.** A `warn` rule prints a yellow line and
  exits 0 unless `--fail-on-warn` is passed. Two characters in the source, no
  other difference, and the gate stops being one. There are no `warn` rules in
  this pack; `audit-policy-gate.ts` fails the build if one appears without the
  flag.

- **A rule name conftest does not collect.** It gathers `deny`, `violation`,
  `warn` and their `deny_*` suffixed forms. `denied`, `denies` and `Deny` are
  ordinary Rego rules that nothing ever queries — no parse error, no warning,
  no finding, ever.

- **A rule nobody has seen fire.** A rule that silently stopped matching —
  because a property moved, or an OPA upgrade changed what a builtin returns —
  reports nothing, which looks exactly like a repository with nothing wrong in
  it.

The canary closes the last one at run time and `npm run audit:policy` closes it
in review: every `[rule-id]` in the sources must appear in
`canary-expectations.txt`, so adding a rule without a canary case fails on the
pull request that adds it.

## 5. The gate in review

`npm run audit:policy` (`aws/cdk/tools/audit-policy-gate.ts`) runs in the CDK
job and reads the policy tree, the gate script and the workflows as text. Its
rules:

| Rule | What it prevents |
| --- | --- |
| `policy-tree-empty` | An empty pack, which conftest reports as "0 tests" and a green check. |
| `rule-not-collectable` | `denied`/`Deny`/`warns` — valid Rego that is never queried. |
| `rule-id-missing` | A message with no `[rule-id]`, which puts the rule outside the canary's reach. |
| `package-not-scanned` | A package no `--namespace` in the gate names. It resolves the shell variable, so a typo in the assignment is caught and a coincidental mention of the package name in a path is not accepted as coverage. |
| `warn-without-fail-on-warn` | A warn rule with nothing making warnings fatal. |
| `rule-without-test` | A rule with no unit test. The canary proves a rule fires on one handcrafted resource; only a test says what it does *not* fire on. |
| `canary-expectation-missing` | A rule the canary is not required to trip. |
| `canary-expectation-orphan` | An expectation for a rule that no longer exists. |
| `conftest-unpinned` | An install with no exact version, or one that does not verify the bytes it downloaded. A release asset can be replaced in place, and this binary decides whether the build may merge. |
| `gate-not-run-in-ci` | A policy pack nothing invokes, which is documentation of an intention. |

## 6. Adding a rule

1. Write it in the right file under `policy/cloudformation/`, with a message
   beginning `[your-rule-id]`.
2. Add a case to the matching `*_test.rego` — at least one template it denies
   and one it must not.
3. Add a resource to `policy/fixtures/deny-canary.json` that trips it exactly
   once, and add the id to `policy/canary-expectations.txt`.
4. `conftest verify --policy policy/cloudformation && npm run audit:policy`.

Steps 2 and 3 are not optional in the sense that skipping them is a failed
build, not a missing nicety.

## 7. What this does not cover

- **Only CloudFormation.** The Kubernetes manifests under `k8s/` and the Helm
  values go through `npm run audit:helm` and `helm lint`, not through this pack.
  Conftest reads YAML as happily as JSON and a second namespace would be the
  natural home for them; nothing here does that yet, and `--namespace` is passed
  explicitly rather than `--all-namespaces` so that adding one is a deliberate
  edit rather than an automatic widening of what this gate covers.

- **Nothing is enforced at the account.** Every rule here runs in a pipeline. A
  resource created in the console, by another pipeline, or by a `kubectl apply`
  never passes through it. AWS Config rules or an SCP are what close that, and
  neither is in this repository.

- **The runtime allowlist is a maintenance burden by design.**
  `supported_lambda_runtimes` has to be edited before a new runtime can be used.
  That is the moment to check the one being replaced is gone from every stack;
  letting the list drift open is how the check stops being one.

- **`actionlint`'s own install is not checksum-verified.** The policy gate pins
  and verifies conftest; the `actionlint` job a few lines above it downloads a
  release by version alone. That is a real inconsistency and it predates this
  gate.

- **An intrinsic image reference is reported, not evaluated.**
  `image-resolved-at-deploy-time` says a template's image cannot be checked
  here; it does not tell you what will be pulled. Resolving the digest in the
  pipeline and passing it in is the fix, and `docs/image-signing.md` is where
  the deploy-time half of that lives.
