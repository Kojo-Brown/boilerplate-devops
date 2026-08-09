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

## OIDC Setup (no long-lived AWS keys)
See `aws/cloudformation/github-oidc-role.yml` for the IAM role template.

## Guardrails

Everything here is meant to be copied into someone else's account, so CI blocks
the two mistakes that survive a copy:

| Gate | What it blocks | Where |
|------|----------------|-------|
| `npm run scan:identifiers` | Hardcoded AWS account IDs (including those embedded in ARNs and ECR image URIs), AWS access keys, PEM private keys, and provider tokens | `aws/cdk/tools/scan-hardcoded-identifiers.ts` |
| TruffleHog | Secrets with no distinctive shape, detected by entropy and verification | `workflow-templates/secret-scanning.yml` |

Placeholders must use one of the AWS documentation account IDs
(`123456789012`, `111122223333`, …) — the scan permits those and nothing else.
For a genuine exception, add `scan-allow: <rule-id> <reason>` to the line; a
suppression without a reason is rejected.

## Spec Progress
See [SPEC.md](./SPEC.md).
