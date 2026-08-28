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
| Feature flag manifest + stale-flag sweep | `aws/appconfig/`, `aws/cdk/lib/feature-flag-lifecycle-stack.ts` |
| DORA four keys — collection + dashboard | `aws/cdk/lib/dora-metrics-stack.ts`, `workflow-templates/emit-dora-deployment.yml` |
| EKS cluster — managed node groups + IRSA | `aws/cdk/lib/eks-stack.ts` |
| Helm chart — per-environment values, schema-validated | `k8s/charts/app/` |
| Default-deny NetworkPolicy + allowlist, enforced by the CNI | `k8s/charts/app/templates/networkpolicy.yaml` |

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

## Feature flags

Flags are declared in `aws/appconfig/feature-flags*.json` with an owner, a kind,
a ticket, and the day they should be gone. `npm run audit:flags` refuses a flag
that arrives without them, and the same schema is attached to the AppConfig
configuration profile as a JSON Schema validator, so a malformed version is
rejected at `CreateHostedConfigurationVersion` rather than deployed.

Two things are easy to conflate and behave completely differently. AppConfig's
deployment strategy is a *configuration* rollout — it controls how fast a change
reaches your fleet, and it is what the rollback alarms watch. `rolloutPercentage`
is a *flag* rollout — which users see the feature — and AppConfig does not
implement it. `aws/cdk/lib/feature-flag-bucketing.ts` is the reference
implementation the application uses: stable per subject, independent per flag,
nested as the percentage rises, and cheap enough for a request path.

`FeatureFlagLifecycleStack` is the part that runs after the merge. Once a day it
reads what is *actually deployed* to each environment through the runtime Data
API and reports every flag that is past its removal date, finished rolling out,
or was never turned on — as CloudWatch metrics, an SNS summary, and a GitHub
issue in the owning team's backlog. It never deletes a flag: removing the
configuration before the code that reads it leaves running processes resolving
the key to `undefined`, which is falsy, which takes the branch the rollout was
moving away from.

See [docs/feature-flags.md](./docs/feature-flags.md) for the manifest reference,
the three flag kinds, and why expiry blocks a deploy rather than a build.

## DORA metrics

`DoraMetricsStack` collects the four keys — deployment frequency, lead time for
changes, change failure rate, and failed deployment recovery time — from two
event streams: a deployment event the pipeline emits
(`workflow-templates/emit-dora-deployment.yml`), and CloudWatch alarm state
changes for a declared set of alarms. Deployments and incidents land in DynamoDB
because attribution is retroactive: a failure at 14:40 has to find and mark the
deployment from 14:05, and a published metric datapoint cannot be revisited.

Each of the four keys is a ratio or a duration over two events, so the arithmetic
is trivial and every wrong pairing still produces a believable number. The four
this implementation is built around:

- **Lead time is measured from the first commit on the branch**, read from the
  pull request — not from the deployed commit. Under a squash-merge policy (which
  this repo's own ruleset requires) the deployed commit is authored at merge
  time, so measuring from it turns lead time into deploy-pipeline duration:
  single-digit minutes, elite by any threshold. When no pull request number is
  available the fallback is still published, but under a separate `Source`
  dimension and its own colour on the graph, so a team measuring the wrong thing
  can see that it is.
- **Change failure rate excludes deployments too recent to have failed yet.** A
  deploy from four minutes ago is already in the denominator while the incident
  it is about to cause has not happened, so the naive rate improves the instant
  you ship. Excluded deployments are graphed beside the rate, and when nothing in
  the window is ripe no rate is published at all — zero over zero is undefined,
  not zero percent.
- **Only incidents traceable to a deployment count as change failures.** Counting
  all incidents makes the rate rise when the deploy cadence *falls*. The
  attribution flag lives on the deployment, so one bad deploy that trips three
  alarms is one change failure.
- **A flapping alarm is one incident.** Six oscillations in five minutes would
  otherwise report six failures each recovering in a minute — pushing two of the
  four keys wrong in opposite directions at once.

Nothing here gates a deployment: a measurement that can block the thing it
measures stops being one. `LeadTimeUnmeasurable` and an alarm on it cover the
real failure mode, which is not a bad score but a score that quietly stopped
being a measurement.

See [docs/dora-metrics.md](./docs/dora-metrics.md) for the wiring, the event
shape, the full metric list, and the performance bands.

## Kubernetes

`EksStack` provisions a cluster with a private API server endpoint, one managed
node group, the four EKS-managed add-ons, and the OIDC provider behind IRSA.

The point of IRSA is what the node role is *not* allowed to do. Without it, an
SDK call from a pod is signed with credentials the instance metadata service
hands out — the node's role — so every pod on a node holds the union of every
permission any pod there needs. So the node role carries the worker and ECR-read
policies and nothing else: the VPC CNI's ENI permissions live on its own role,
attached to the `aws-node` service account, and nodes require IMDSv2 at a hop
limit of 1, which puts the metadata service out of reach of a container while
leaving it reachable to the kubelet. A compromised pod that could simply ask for
the node role would make the rest of it decoration.

The endpoint is private by default, so `kubectl` works from inside the VPC and
not from the open internet; `publicApiAccessCidrs` opens it to named ranges and
refuses `0.0.0.0/0` at synth time. Cluster administrators are granted through
EKS access entries declared in `bin/app.ts`, not by hand-editing `aws-auth`
after the fact.

The Cluster Autoscaler runs in `kube-system`, discovering the managed node
groups by the ASG tags EKS applies to them and growing them when a pod cannot be
scheduled. Its IRSA role splits in two: reads on `*`, because none of those
actions supports a resource ARN, and the two mutating actions scoped to Auto
Scaling group ARNs and conditioned on this cluster's ownership tag — without
that condition the role could resize every ASG in the account.

See [docs/eks.md](./docs/eks.md) for the IRSA trust policy, the
version/kubectl-layer pairing, the subnet tags the load-balancer controller
needs, and what is deliberately left to later Phase 8 items.

`k8s/charts/app` is what gets deployed onto it: a Deployment, Service,
ServiceAccount annotated for IRSA, ConfigMap, PodDisruptionBudget,
HorizontalPodAutoscaler and a pair of NetworkPolicies, installed with
`values-staging.yaml` or `values-production.yaml`.

Every value is constrained by `values.schema.json`, and the point of that is not
documentation — it is that `replicas: 3`, which is the Deployment field and not
the chart's, fails the release instead of installing the default replica count
and reporting success. Two gates keep the schema honest: `npm run audit:helm`
validates every environment's merged values, walks the schema for objects that
have drifted open, and checks the rules JSON Schema cannot express
(`minAvailable` below the fleet's floor, a values file whose `environment`
disagrees with its own filename); the `Helm chart` job runs `helm lint --strict`
and `helm template` per environment, because the validator that decides whether
a real upgrade succeeds is Helm's own and not ajv's. `schema-fixtures/` holds
sixteen values files that must each be rejected, so a schema that has stopped
catching anything fails rather than passing quietly, and `render-fixtures/` is
its mirror image — values that must render, covering the template paths no
environment file reaches.

The pods run non-root as UID 10001, under `RuntimeDefault` seccomp, with a
read-only root filesystem, `allowPrivilegeEscalation: false` and every Linux
capability dropped — the [restricted Pod Security Standard][pss], so a namespace
enforcing that label admits them. Those fields are `const` in the schema rather
than defaults: an environment file cannot relax one, because doing so is not
tuning a value but leaving the posture the rest of the chart assumes. The cost of
a read-only root filesystem is real and is paid in `writableVolumes` — one
size-limited `emptyDir` at `/tmp`, since nearly every runtime writes there —
rather than by turning the flag off.

[pss]: https://kubernetes.io/docs/concepts/security/pod-security-standards/

The pod network is closed the same way. The chart renders a default-deny
NetworkPolicy over its own pods — never the whole namespace, which is not a
chart's to close — plus an allowlist that today permits cluster DNS and HTTPS to
AWS outbound and nothing inbound. What makes that more than a manifest is one
line in `EksStack`: Kubernetes ships no NetworkPolicy controller, so on a CNI
that does not implement policy the objects are stored, listed by `kubectl`,
described correctly and enforced by nothing, with no status field anywhere that
says so. The VPC CNI add-on is configured with `enableNetworkPolicy` for exactly
that reason. `npm run audit:helm` covers the rules a schema cannot: an ingress
entry naming `service.port` (which kube-proxy has already rewritten, so it
matches nothing and the traffic is dropped), an egress block that leaves the
instance metadata address reachable, and a default-deny with no route to DNS.
See [docs/network-policies.md](./docs/network-policies.md).

Scaling is two loops, and they only work together. The chart's HPA moves pods
against CPU as a fraction of the request and reacts in about ninety seconds; the
Cluster Autoscaler moves nodes and takes two to four minutes. An HPA whose
`maxReplicas` exceeds what the node group can hold does not fail — it produces
Pending pods and a dashboard that says the autoscaler is working — so
[docs/autoscaling.md](./docs/autoscaling.md) does that arithmetic explicitly, for
both environments, along with where every threshold comes from and what has not
been measured.

See [docs/helm-chart.md](./docs/helm-chart.md) for the deploy commands, the
per-environment differences, the `null`-deletes-the-default trap, and how to add
an environment.

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
| `npm run audit:flags` | Feature flags with no owner, ticket, or removal date; deadlines beyond 90 days or before the creation date; a field nothing reads; a percentage on a flag that is off, or a flag on at 0% | `aws/cdk/tools/audit-feature-flags.ts` |
| `npm run audit:helm` | Chart values that fail the schema once merged; a schema object that accepts unknown keys and so catches nothing; an environment with no values file, or a values file for one that does not exist; `key: null`, which deletes a chart default rather than overriding it; a PodDisruptionBudget that permits no drain | `aws/cdk/tools/audit-helm-values.ts` |

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
