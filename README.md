# boilerplate-devops

> GitHub Actions · AWS ECS · CDK · ECR · OIDC · CloudWatch

Reusable CI/CD workflows and AWS infrastructure templates.

## What's here

| Template | Where |
|----------|-------|
| Reusable CI workflow | `.github/workflows/ci.yml` |
| Docker build + ECR push | `.github/workflows/docker-build-push.yml` |
| ECS rolling deploy | `.github/workflows/deploy-ecs.yml` |
| ECS canary deploy (weighted target groups) | `.github/workflows/canary-deploy.yml` |
| AWS CDK VPC + ECS stack | `aws/cdk/` |
| CloudFormation templates | `aws/cloudformation/` |
| Dependabot config | `.github/dependabot.yml` |
| Trunk-based ruleset (required checks + merge queue) | `.github/rulesets/trunk-based-main.json` |
| Short-lived branch check | `.github/workflows/trunk-guardrails.yml` |
| Per-PR preview environment (deploy + teardown) | `.github/workflows/preview-environment.yml` |
| Expand/contract migration playbook + worked example | `db/migrations/` |

## Usage

**Call the reusable CI workflow from your repo:**
```yaml
jobs:
  ci:
    uses: Kojo-Brown/boilerplate-devops/.github/workflows/ci.yml@main
    with:
      node-version: "22"
```

**Deploy to ECS:**
```yaml
jobs:
  build:
    uses: Kojo-Brown/boilerplate-devops/.github/workflows/docker-build-push.yml@main
    with:
      image-name: my-app
    secrets:
      AWS_ROLE_ARN: ${{ secrets.AWS_ROLE_ARN }}
  deploy:
    needs: build
    uses: Kojo-Brown/boilerplate-devops/.github/workflows/deploy-ecs.yml@main
    with:
      image-uri: ${{ needs.build.outputs.image-uri }}
      cluster: production
      service: my-app
      container-name: app
      task-definition: my-app-prod
    secrets:
      AWS_ROLE_ARN: ${{ secrets.AWS_ROLE_ARN }}
```

## Progressive delivery

Three deployment strategies ship here. They are alternatives, not layers — each
owns an ALB and an ECS service for the same application, so pick one per
environment and delete the stacks for the others.

| Strategy | Stack | How traffic moves | What decides to roll back |
|----------|-------|-------------------|---------------------------|
| Rolling | `EcsStack` | ECS replaces tasks in place | ECS deployment circuit breaker |
| Blue/green | `BlueGreenDeployStack` | CodeDeploy shifts between two target groups on a schedule | A CloudWatch alarm crossing a fixed threshold |
| Canary | `CanaryDeployStack` | A Step Functions state machine sets weights on one listener | Per-step analysis comparing canary metrics against stable |

**Canary deployment.** `CanaryDeployStack` puts a stable and a canary target
group behind a single weighted HTTPS listener and drives the deployment from a
state machine: point the canary service at the new revision, wait for it to be
healthy, then for each configured percentage shift the weights, bake, and
analyze. Analysis fails the step — and rolls the whole deployment back — when
the canary breaches an absolute error-rate or latency threshold, *or* when it is
measurably worse than what the stable group served in the same window. A window
with too little canary traffic to judge is a rollback by default rather than a
silent promotion.

```yaml
jobs:
  build:
    uses: Kojo-Brown/boilerplate-devops/.github/workflows/docker-build-push.yml@main
    with:
      image-name: my-app
    secrets:
      AWS_ROLE_ARN: ${{ secrets.AWS_ROLE_ARN }}
  canary:
    needs: build
    uses: Kojo-Brown/boilerplate-devops/.github/workflows/canary-deploy.yml@main
    with:
      image-uri: ${{ needs.build.outputs.image-uri }}
      task-definition: production-canary-task          # CanaryDeployStack output TaskDefinitionFamily
      state-machine-arn: ${{ vars.CANARY_STATE_MACHINE_ARN }}
      container-name: AppContainer
    secrets:
      AWS_ROLE_ARN: ${{ secrets.AWS_ROLE_ARN }}
```

The job registers a task-definition revision, starts the state machine, and
polls it, writing each step's verdict and the metrics behind it into the run
summary. Cancelling the job stops the polling, not the deployment — use
`aws stepfunctions stop-execution` to abort one, which runs the state machine's
rollback path.

Tune the steps and thresholds per environment in `aws/cdk/bin/app.ts`
(`trafficSteps`, `bakeTimeSeconds`, `analysis`). Do not run `cdk deploy` on
these stacks while an execution is in flight: the listener weights are runtime
state the state machine owns, and a deploy resets them underneath it.

**Rollback after the deployment is done.** All three strategies above decide
during a deployment. `SloBurnRateRollbackStack` decides afterwards, on how fast
the service is consuming its error budget:

```
burn rate = (failed requests / total requests) / (1 − SLO target)
```

A burn rate of 1x spends the whole 30-day budget in 30 days; 14.4x spends 2% of
it in an hour. Each policy alarms only when a long window *and* a short window
are both over the threshold — the long one refuses to react to a spike, the
short one refuses to react to an incident that has already ended. A breach rolls
back only services that deployed recently, because a rollback treats the symptom
only if a deployment caused it.

This composes with `RollbackAutomationStack` rather than replacing it: alarm
state for hard failures, burn rate for the slow regressions a fixed threshold
either misses or over-reacts to. See
[docs/slo-burn-rate-rollback.md](./docs/slo-burn-rate-rollback.md) for the
arithmetic, the defaults, and what the handler checks before it acts.

## Preview environments

Every open pull request gets a running copy of the application at
`pr-<number>.preview.example.com`, seeded from that pull request's own commit
and deleted when it closes. `PreviewEnvironmentStack` holds everything shared —
one ALB, one ECS cluster, one Postgres instance — and `PreviewPrStack` adds only
a service, a target group, and a listener rule, so a preview appears in about a
minute instead of the fifteen a per-PR VPC and database would take.

The service is declared with zero tasks on purpose. A preview's database has no
schema until the seed task has run, and the seed task cannot run until the task
definition exists — which is the same CloudFormation operation that creates the
service. So the workflow creates the database, deploys, seeds, and only then
scales up.

Teardown has two mechanisms because one is not enough. The `closed` event is the
fast path; an hourly reaper Lambda is the guarantee, because a cancelled run, a
degraded Actions installation, or a workflow file missing from the branch all
leave an environment running and billing, silently. The reaper deletes stacks
whose pull request has closed, and stacks that have outlived their limit
whatever GitHub says — but it never confuses *cannot reach GitHub* with
*closed*.

See [docs/preview-environments.md](./docs/preview-environments.md) for the
seeding contract, the fork policy, the ALB limits, and the cost model.

## Zero-downtime database migrations

`DbMigrationStack` runs migrations from CodeDeploy's `BeforeAllowTraffic` hook,
so a failed migration rolls the deployment back before a single request reaches
the new tasks. The corollary is the part that catches teams out: at the moment a
migration commits, the **only code running is the old code**. A migration that
needs the new release to already be deployed does not fail at the end of the
rollout — it fails at the start of it, against the version you were replacing.

Expand/contract is what makes that survivable. `db/migrations/` is a worked
example of the hard case — splitting `users.full_name` into `first_name` and
`last_name` across five releases — with the trigger that keeps both shapes in
step, a batched resumable backfill, the `NOT VALID` → `VALIDATE` →
`SET NOT NULL` sequence that adds a constraint without a table scan, and the
irreversible drop three releases behind the last reader.

`npm run audit:migrations` enforces the mechanical half on every PR: renames and
in-place type changes, `NOT NULL` columns with no default, indexes built without
`CONCURRENTLY`, constraints added without `NOT VALID`, unbounded backfills, and
any file that both adds and removes schema — which leaves no release you can
roll back to. It reads inside `DO` blocks and function bodies, because a
`DROP TABLE` is no less destructive for being wrapped in PL/pgSQL.

See [docs/expand-contract-migrations.md](./docs/expand-contract-migrations.md)
for the release timeline, the lock table, and what the audit cannot check for
you.

## OIDC Setup (no long-lived AWS keys)
See `aws/cloudformation/github-oidc-role.yml` for the IAM role template.

## Guardrails

Everything here is meant to be copied into someone else's account, so CI blocks
the two mistakes that survive a copy:

| Gate | What it blocks | Where |
|------|----------------|-------|
| `npm run scan:identifiers` | Hardcoded AWS account IDs (including those embedded in ARNs and ECR image URIs), AWS access keys, PEM private keys, and provider tokens | `aws/cdk/tools/scan-hardcoded-identifiers.ts` |
| TruffleHog | Secrets with no distinctive shape, detected by entropy and verification | `workflow-templates/secret-scanning.yml` |
| `npm run audit:migrations` | Migrations that cannot survive a deployment window: renames, in-place type changes, scans and rewrites under `ACCESS EXCLUSIVE`, unbounded backfills, expand and contract in one file | `aws/cdk/tools/audit-migrations.ts` |

Placeholders must use one of the AWS documentation account IDs
(`123456789012`, `111122223333`, …) — the scan permits those and nothing else.
For a genuine exception, add `scan-allow: <rule-id> <reason>` to the line; a
suppression without a reason is rejected.

## Trunk-based development

Required status checks and a merge queue are declared in
`.github/rulesets/trunk-based-main.json` and applied with `gh api`; branch
lifetime is measured on the pull request by
`.github/workflows/trunk-guardrails.yml` (48h and 400 changed lines by default,
both configurable, both callable from another repository).

The three settings are edited independently and nothing in GitHub reconciles
them, so `npm run audit:trunk` does: it fails the build when a required check
has no producing job, when a producer cannot report inside the merge queue
(missing `merge_group` trigger, a path filter, a job-level `if`, a matrix), or
when a concurrency group lets one queue entry cancel another. Each of those
mistakes is invisible until a pull request hangs at *"waiting for status to be
reported"*.

See [docs/trunk-based-development.md](./docs/trunk-based-development.md) for the
apply commands, the reasoning behind each rule, and what to do when a branch
fails the size or age limit.

## Spec Progress
See [SPEC.md](./SPEC.md).
