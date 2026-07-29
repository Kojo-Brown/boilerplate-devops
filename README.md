# boilerplate-devops

> GitHub Actions · AWS ECS · CDK · ECR · OIDC · CloudWatch

Reusable CI/CD workflows and AWS infrastructure templates.

## What's here

| Template | Where |
|----------|-------|
| Reusable CI workflow | `.github/workflows/ci.yml` |
| Docker build + ECR push | `.github/workflows/docker-build-push.yml` |
| ECS rolling deploy | `.github/workflows/deploy-ecs.yml` |
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
