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
| GitOps delivery — app-of-apps, sync waves, drift detection | `k8s/argocd/` |
| Log pipeline — PII scrubbed before the archive ingests it | `aws/cdk/lib/log-pipeline-stack.ts`, `aws/cdk/lib/log-scrubbing.ts` |

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
HorizontalPodAutoscaler, a pair of NetworkPolicies and a TLS-only Ingress,
installed with
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
chart's to close — plus an allowlist that permits cluster DNS, HTTPS to
AWS outbound, and the ingress controller inbound. What makes that more than a
manifest is one
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

The chart's Ingress is TLS-only, and the four controllers behind it are the
reason. ingress-nginx gives the object an address, external-dns publishes the
record from that address, cert-manager issues the certificate through a DNS-01
challenge against Route 53, and a `ClusterIssuer` per cluster decides which ACME
endpoint — staging deliberately uses Let's Encrypt's *staging* directory,
because Let's Encrypt counts its 50-certificates-per-week limit on the
registered domain rather than the subdomain, so a staging cluster that reissues
on every merge spends production's quota. `EksStack` creates the two IRSA roles those controllers need,
scoped by hosted zone *and* by record type: neither of them ever writes an `NS`
or `SOA` record, and a role that can rewrite the delegation can take the domain
off the internet.

What makes this worth a document rather than a paragraph is that an Ingress has
one status field and it says nothing about DNS, nothing about TLS, and nothing
about whether any controller claimed the object. An Ingress that names no class
is admitted and served by nothing; one annotated for cert-manager with no
`spec.tls` produces no certificate and no error; and an enabled Ingress with an
empty NetworkPolicy allowlist returns 503 while DNS, TLS, the Service, the
endpoints and the pods all report healthy. `npm run audit:helm` fails the last
two, and `values.schema.json` refuses the shapes that make the first possible.
See [docs/ingress.md](./docs/ingress.md).

`k8s/argocd/` is how it gets there. One Argo CD per cluster and one root
Application per Argo CD, applied by hand once; from then on the cluster follows
`main`, and no pipeline holds cluster credentials. The root applies two
AppProjects and six Applications per environment — metrics-server, which the HPA
above reads and which none of the four add-ons `EksStack` installs provides;
cert-manager, its ClusterIssuer, ingress-nginx and external-dns, which are the
Ingress story below; and the release itself — ordered by sync waves and kept
converged by `selfHeal`.

Three things about that are easy to get wrong and hard to notice. Sync waves
between child Applications do **not** wait for the wave underneath them unless
the health assessment Argo CD removed in 1.8 is restored in `argocd-cm`, so an
ordering that reads correctly is not one. Self-heal only reconciles resources an
Application already manages, so the Deployment somebody created beside the
release during an incident is reverted by nothing — that is what
`orphanedResources` on the project reports. And self-heal lives inside
`automated`, so a production application on manual sync is the one place drift is
detected and then kept; the price of automated sync in production is that Argo CD
refuses to roll back, and a revert commit becomes the way back.

`npm run audit:argocd` checks the manifests on every pull request — a project
that does not exist, a destination the project does not permit, a chart version
that is a range, a staging Application rendering `values-production.yaml`, a
manifest in the tree that the root's `include` glob does not match — and
`workflow-templates/argocd-drift-report.yml` is the scheduled read of a running
Argo CD that catches what self-heal cannot fix. See
[docs/gitops-argocd.md](./docs/gitops-argocd.md).

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
| `npm run audit:argocd` | Argo CD manifests the API server accepts and Argo CD then misreads: a project that does not exist, a destination or repository the project does not permit, an Application without `selfHeal` or the cascade-delete finalizer, a chart version range, one environment rendering another's values file, a manifest in the GitOps tree that the root Application's glob does not apply | `aws/cdk/tools/audit-argocd.ts` |
| `npm run audit:sbom` | A workflow that publishes a release artifact without inventorying it; an SBOM in SPDX (the generator's default) rather than CycloneDX; a container image inventoried from the source tree instead of the image; a scan that runs after the push and so gates nothing; an image SBOM kept only in a workflow artifact that expires; an unpinned scanner; an SBOM nothing verifies, so `"components": []` ships unnoticed | `aws/cdk/tools/audit-sbom.ts` |
| `npm run audit:signing` | An image published without a signature, or signed over a mutable tag; a signature made before the push, or one nothing verifies before the image ships; keyless signing in a workflow with no `id-token: write`; signing with a long-lived key; a deploy that never verifies, one that verifies `--certificate-identity-regexp '.*'` — "signed by anyone" — and one that verifies a digest and then deploys a tag; an unpinned cosign | `aws/cdk/tools/audit-image-signing.ts` |
| `npm run audit:vulns` | An artifact published without ever being scanned for known vulnerabilities; a scan that cannot fail the build, which is what both scanners do by default; a scan that runs after the push, or reads the source tree while shipping an image; a threshold left to the tool, or set below HIGH and CRITICAL; a gate that blocks on findings no build can fix, and so gets disabled; an unpinned scanner; the plain-text `.trivyignore`, and a YAML exception with no id, reason, or expiry — or with a typo'd key Trivy silently ignores | `aws/cdk/tools/audit-vulnerability-scanning.ts` |
| `npm run audit:iam` | A policy granting `Action: "*"` or `s3:*`, or written as `NotAction`/`NotResource` so every action AWS ships next is included; `iam:PassRole` on `"*"` — which an `iam:PassedToService` condition does not scope, since it constrains which service receives the role and not which role is handed over; `AdministratorAccess`/`PowerUserAccess` under any name, and `ReadOnlyAccess` where `ViewOnlyAccess` was meant; `Resource: "*"` with no condition on an action that reads data, changes what runs, or grants access; a wildcard principal with nothing narrowing it; a GitHub OIDC trust with no `aud` check or a `sub` not pinned to one repository; and an Access Analyzer report that is missing, unpinned, or cannot fail | `aws/cdk/tools/audit-iam-least-privilege.ts` |
| `npm run audit:provenance` | An image published with no record of how it was built; an attestation over a path on the runner rather than the pushed digest, or one that never reaches the registry and so cannot be found from the digest; an attestation that is not provenance, because `sbom-path` or `predicate-type` quietly switched the mode; an attesting job with no `attestations: write`; an attestation nothing verifies, one verified with a catch-all identity, and one verified over a tag; an unpinned attesting action | `aws/cdk/tools/audit-provenance.ts` |

Placeholders must use one of the AWS documentation account IDs
(`123456789012`, `111122223333`, …) — the scan permits those and nothing else.
For a genuine exception, add `scan-allow: <rule-id> <reason>` to the line; a
suppression without a reason is rejected.

## Software bills of materials

Every artifact these templates publish is inventoried in CycloneDX JSON before
it ships, and the inventory travels with it: a container image gets its SBOM
attached in ECR as an [OCI 1.1 referrer], findable with `oras discover` long
after the build logs and the workflow artifact are gone; a static-site bundle
gets one uploaded as a workflow artifact, and `workflow-templates/sbom.yml` will
attach it to a GitHub Release. The image is scanned rather than the source tree,
because a scan of `.` cannot see the base image's OS packages — the layers CVEs
are usually found in.

The scan runs *before* the push, so a build nobody can inventory never becomes a
release, and each template asserts the document is a non-empty CycloneDX SBOM
naming the right subject. That assertion is the point: Syft exits 0 and writes a
schema-valid CycloneDX document when it finds nothing at all, so
`"components": []` otherwise passes every check in the pipeline and reaches the
registry looking like a successful scan.

See [docs/sbom.md](./docs/sbom.md) for the retrieval commands, why the SBOM is
deliberately kept out of the public site bucket, and what `npm run audit:sbom`
can and cannot prove.

[OCI 1.1 referrer]: https://github.com/opencontainers/distribution-spec/blob/main/spec.md#listing-referrers

## Known vulnerabilities

The SBOM records what is in an artifact. This asks whether any of it is known to
be exploitable — a question none of the other gates here answers, because a
pinned, signed, inventoried, fully attested image with a critical CVE in its
base layer satisfies every one of them.

Both publishing templates scan with Trivy before the artifact ships and **fail
on fixable HIGH and CRITICAL findings**. `--exit-code 1` is the whole of it:
both `aquasecurity/trivy-action`'s `exit-code` input and the `trivy` CLI's flag
default to `0`, so a scan with nothing said about them prints a table of CVEs
into a log nobody reads and succeeds. That is the default, not a mistake anyone
has to make, and it is what most "we scan our images" pipelines are.

The gate blocks on *fixable* findings only. An unfixable CRITICAL is real,
recorded, and worth an alert — and blocking on it holds every unrelated deploy
until upstream ships, which is what turns an exit code into a `0`. A separate
non-blocking step records every severity, so the threshold hides nothing.

Two things a scan does not assert about itself are asserted here: that it
scanned anything at all — Trivy exits 0 with no `Results` key when it cannot
read the artifact, exactly as Syft writes `"components": []` — and that its
vulnerability database is current, since a stale one reports fewer findings and
looks identical to a clean scan. The scanner itself is pinned by digest, for the
same reason TruffleHog is.

Exceptions live in `.trivyignore.yaml` and need a `statement` and an
`expired_at`. The plain-text `.trivyignore` is refused outright: it is a list of
identifiers with nowhere to say why or until when, so every entry in it is
permanent by construction.

See [docs/vulnerability-scanning.md](./docs/vulnerability-scanning.md) for the
full severity policy, how to accept a risk, and the three gaps this leaves —
chiefly that nothing re-checks an image against advisories published after it
was built.

## Image signing

Every image `docker-build-push.yml` pushes is signed with cosign, keylessly,
using the build's own GitHub OIDC identity — there is no signing key to store or
steal, and what the signature records is *which workflow, in which repository,
at which ref* produced the image. The build verifies its own signature before it
reports success, so a signature no deploy can check never ships looking healthy.

Signing happens *after* the push, because until then there is no manifest in the
registry to sign — the mirror image of the SBOM's ordering — and always over the
digest, never a tag.

Every deploy path here (`deploy-ecs.yml`, `blue-green-deploy.yml`,
`canary-deploy.yml`, `preview-environment.yml`) verifies before the image
reaches a runtime, against a `signer-identity-regexp` the caller must supply. A
pattern that matches every signer is refused at run time and in review: cosign
requires an identity, so `.*` — not omission — is what a defeated gate actually
looks like. Verification resolves the reference to a digest and the deploy uses
*that*, because verifying a tag and then deploying it are two registry reads and
only the second one runs.

See [docs/image-signing.md](./docs/image-signing.md) for the identity patterns,
the two extra IAM permissions a deploy role needs, and what this does not
cover — cluster-side admission control, and anything that is not a container
image.

## Build provenance

Every image `docker-build-push.yml` pushes also carries SLSA build provenance:
a signed statement of which repository and commit it was built from, which
workflow at which ref built it, and on what kind of runner — bound to the same
digest, and pushed to the registry as an OCI referrer so it is findable from
that digest alone rather than only through GitHub's API.

It is a third claim, not a restatement of the other two. The SBOM says what is
inside the image and the signature says who published it; neither records how it
was built, which is the question a rollback or a post-mortem opens with.

The build verifies its own attestation before reporting success, reading it back
*out of the registry* so a push that did not land fails here rather than in a
consumer's pipeline. It also asserts the predicate type, because `actions/attest`
picks its mode from its inputs: an `sbom-path` or a `predicate-type` produces a
perfectly valid attestation that is not provenance, and satisfies any gate that
only asks whether one exists.

This is SLSA Build **L2**, not L3: the build and the attestation run in the same
job, so anything that can influence that job can influence what the provenance
says. L3 needs a trusted builder the caller cannot reach into. Provenance is
also not yet enforced at deploy — the deploy paths gate on the signature.

See [docs/provenance.md](./docs/provenance.md) for the verification commands,
the `attestations: write` permission consumers of the reusable workflow have to
grant too, and both gaps in full.

## Dependency pinning

The three gates above are about the image this pipeline *publishes*. Everything
it *consumes* is pinned by content: actions by commit SHA, third-party container
images by manifest digest.

`uses: actions/checkout@v4` is not a version — it is a mutable ref in someone
else's repository, resolved when the job starts, and whatever it points at then
runs with the job's `GITHUB_TOKEN`, OIDC identity and secrets. Moving it
produces no diff here and nothing in the run log. A task definition holding
`:latest` has the same shape: it resolves at every task placement, so two tasks
in one service can be running different images while CloudFormation reports no
drift, and a rollback rolls back to the same moving tag.

Pinning without labelling is the other half of the failure, so `npm run
audit:pins` requires a `# v4.4.0` beside every SHA: bare SHAs are unreviewable,
and Dependabot reads that comment to know which release it is offering to move
you off. Eight rules cover unpinned actions, unpinned `docker://` actions,
missing and non-version labels, one action pinned to two different commits,
untagged and malformed image digests, and image literals written into a stack
instead of `lib/base-images.ts`. Run against the tree before this landed, it
reports 64 violations.

Your own application image is deliberately out of scope — its digest is decided
per release, and that it reaches a runtime by digest is enforced more strictly
by the signing gate, which requires the digest a `cosign verify` just resolved.

See [docs/dependency-pinning.md](./docs/dependency-pinning.md) for how to
resolve a pin, why the `^{}` in `git ls-remote` matters, and what has no
automated proposer today.

## Policy as code

Two jobs read the CloudFormation `cdk synth` writes. Checkov asks whether a
template breaks a rule that is true of everyone's infrastructure; the Conftest
pack in `policy/cloudformation/` asks whether it breaks one that is true of
*ours* — which tags a resource must carry, which three ports may face the
internet, what a database tagged `Environment=production` owes that one tagged
`Environment=preview` does not. Sixteen rules, `package cloudformation`,
enforced by `.github/scripts/run-policy-gate.sh`.

The difference shows in what each does with a correct template it dislikes. A
public ALB on port 80 redirecting to 443 trips `CKV_AWS_260`, and the only
answer is `.checkov.baseline` — which then silences that check for every future
port-80 rule in the repository. The Rego rule names 80, 443 and 8443 as the
ports that may be world-reachable and denies the rest, so the ALB passes on its
merits and a new `0.0.0.0/0` on 5432 fails by default.

The wiring is the part that fails quietly. conftest evaluates the `main` package
and nothing else unless told otherwise: pointed at this pack without a
`--namespace`, or with a misspelt one, it prints `0 tests, 0 passed, 0 failures`
and exits 0. So the gate runs a deny canary — a template that trips every rule
exactly once — and refuses to pass unless the rule ids it reports match
`policy/canary-expectations.txt` exactly, in both directions. `npm run
audit:policy` covers the same ground in review with ten rules: a `warn` written
where a `deny` was meant, a rule named `denied` that conftest never queries, a
rule with no unit test or no canary case, and an install of the scanner with no
exact version or no checksum.

See [docs/policy-as-code.md](./docs/policy-as-code.md) for the rule table, how
to add one, and what is enforced in the pipeline rather than at the account.

## IAM least privilege

Every other gate here reasons about an artifact. This one reasons about what the
account lets the pipeline *do*, which is the blast radius of all of them: an
attacker who gets a step to run arbitrary code inherits the job's role, and what
happens next is decided entirely by that role's policy.

It is two gates, and the split is forced rather than chosen.
`cfn-policy-validator` calls `sts:GetCallerIdentity` before it does anything
else, so the IAM Access Analyzer report needs an account — and a pull request
from a fork gets no `id-token: write` and cannot assume one. So the blocking
gate is `npm run audit:iam`, which reads the synthesised CloudFormation offline
and runs on every pull request, and
[`iam-access-analyzer.yml`](./.github/workflows/iam-access-analyzer.yml) runs the
exhaustive check wherever credentials exist: same-repository pull requests,
pushes to `main`, and weekly — weekly because AWS adds checks, so a policy clean
in March can be reported in June with nobody having touched it.

Being the blocking half offline makes the offline half deliberately *curated*.
45 statements here use `Resource: "*"` and most of them have to:
`cloudwatch:GetMetricData`, `ec2:DescribeSubnets`, `ecr:GetAuthorizationToken`
and `ecs:RegisterTaskDefinition` take no resource at all. A gate reporting all
45 would have a baseline file within a week with the real findings inside it, so
`Resource: "*"` is a finding only for a curated privileged set, and the model
questions go to Access Analyzer, which has the model.

The first run found ten, all fixed rather than baselined. The one worth reading
twice had a condition and a sid that said what it was for:

```ts
new iam.PolicyStatement({
  sid: 'PassRoleToECS',
  actions: ['iam:PassRole'],
  resources: ['*'],
  conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
})
```

`iam:PassedToService` constrains which service receives the role, not which role
is handed over. Two statements above it the same role held
`ecs:RegisterTaskDefinition`, so anything reaching those credentials could
register a task definition naming any role in the account that ECS tasks can
assume, and run it.

See [docs/iam-least-privilege.md](./docs/iam-least-privilege.md) for the rule
table, the two carve-outs and why each is narrow, and the three flags that turn
the analyzer report green without touching a policy.

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

## Tracing with tail-based sampling

`OtelCollectorStack` deploys an OpenTelemetry collector tier that decides which
traces to keep **after** the trace is complete. Head sampling — which is what
every SDK default and `XRayStack`'s sampling rule do — decides at the root span,
before the request has failed or been slow, so a 5% head sample keeps 5% of
errors and keeps them by accident.

The price is a constraint the processor's own README states and that a load
balancer breaks by construction: every span of a trace must reach the same
collector instance. So it is two tiers — an agent sidecar in each application
task, forwarding with a `load_balancing` exporter keyed by trace ID, in front of
a sampler service whose instances are that hash ring's backends.

```ts
const agent = OtelCollectorStack.addAgentSidecar(
  taskDefinition,
  otelCollectorStack.agentSidecarOptions,
);
appContainer.addContainerDependencies({
  container: agent,
  condition: ecs.ContainerDependencyCondition.HEALTHY,
});
```

The application container also needs `OtelCollectorStack.appEnvironment(...)`,
whose `OTEL_TRACES_SAMPLER=parentbased_always_on` is the setting everything else
depends on: leave the SDK head-sampling and the collector can only choose among
the traces that survived it.

Three numbers decide whether the tier works, and two are checked at synth time —
`decision_wait` must exceed the latency policy's threshold, or the slow traces
that policy exists to catch are the ones it never observes; and `num_traces`
must hold a decision window of arrivals, or the buffer evicts traces before
deciding them. Both produce a config the collector starts on and a stream of
silently dropped traces, which is why they fail the build instead.

The sampler tier deliberately does not auto-scale: scaling reshapes the hash
ring, and the traces in flight across that window are split between two owners
and decided on fragments.

See [docs/otel-collector.md](./docs/otel-collector.md) for the policy table, the
Cloud Map resolver settings that fail silently when wrong, the five alarms and
what each one means, and the known gaps.

## Service level objectives

This repository had burn-rate alarms before it had SLOs. The objective they
burned against was a literal in `bin/app.ts` — enough to drive an actuator, not
enough to be an objective: nothing recorded who owned the number, what it was
measured on, or what happens when the budget runs out.

The objectives now live in
[`aws/cdk/lib/slo-definitions.ts`](./aws/cdk/lib/slo-definitions.ts) as data with
no CDK tokens in it, which is what makes them reviewable in a diff and readable
by `npm run audit:slo`. `SloStack` turns each one into three signals, because
each is blind to what the others see:

- **Burn-rate alarms** — multi-window (long decides significance, short decides
  currency), at 14.4x/1h, 6x/6h and 1x/24h. Fast, and structurally unable to see
  slow drift.
- **An error-budget reporter** — a CloudWatch alarm evaluates at most a 24-hour
  period, so a 30-day window cannot be alarmed on directly. A Lambda reads the
  window with `GetMetricData` every 15 minutes and republishes it as
  `ErrorBudgetRemainingPercent`, which can be. That is the only signal that sees
  a month of small regressions, none of them crossing a burn threshold, spending
  the whole budget.
- **A no-data alarm** — the only one here that treats missing data as breaching.
  Every other signal degrades quietly to green when the SLI stops arriving: a
  burn rate over zero requests is zero, and an unspent budget is a full one.

Two things are checked at synth time because both look correct in review. A
burn-rate threshold above `1 / error budget` can **never fire** — 14.4x against a
90% objective needs a 144% error ratio — so the alarm deploys, evaluates, and
stays green through a total outage. And a traffic floor below
`1 / (burn rate × error budget)` pages on a *single* failed request, but only at
the traffic floor, which is exactly where the floor was meant to protect it. The
floor is therefore declared as a rate rather than a count: one number applied to
a 5-minute window and a 24-hour window is wrong for one of them by construction.

A latency SLO is deliberately **not** shipped active. An SLI is a ratio of good
events to valid events, ALB publishes no count of requests under a threshold, and
CloudWatch cannot aggregate a `TargetResponseTime` percentile into one — so
`SloStack` rejects an `alb` source on a latency SLI rather than approximating it
with an alarm that reads like an SLO and produces no burn rate.

See [docs/slo.md](./docs/slo.md) for the catalogue, the arithmetic, the EMF
contract a latency SLI needs, the on-call procedure the alarms link to, and the
known gaps.

## Structured logs with PII scrubbing

An application logs an email address by accident roughly once per feature — not
in a field called `email`, which gets reviewed, but interpolated into a message
while somebody was debugging a support ticket. The line is correct, the deploy is
green, and the address is now in a store that is backed up, indexed and kept for
a year.

`LogPipelineStack` stops that at the last point where stopping it is possible:
CloudWatch Logs → subscription filter → Firehose → a Lambda transform that
redacts and tokenises → S3. The CloudWatch copy is transit and expires in weeks;
the archive is what is kept, and nothing reaches it without passing through the
transform.

**"Before ingest" has to name an ingest.** The `awslogs` driver's write *is* the
ingest, so nothing can scrub before it — what CloudWatch offers there is an
account-wide data protection policy, which masks managed identifiers at ingest
for every reader without `logs:Unmask` and records a finding. That is an access
control over data the account still holds, which is why the transit groups are
short-lived and the real scrubbing happens before S3.

**The transform never returns `ProcessingFailed`.** Firehose's three outcomes are
`Ok`, `Dropped`, and `ProcessingFailed` — and the third retries and then writes
**the original record** to the error prefix. That is what every transform
blueprint returns for a record it could not handle, and in a scrubbing pipeline
it is the leak: the record that defeated the scrubber is the one that lands
unscrubbed. Anything unreadable is dropped, counted and alarmed on instead.
Losing a log line is recoverable; writing it unscrubbed is not.

Three more things that are one line each and invisible in review:

- **`S3BackupMode: Enabled`** writes the *untransformed* records to S3 beside
  the transformed ones, under a prefix called `backup`.
- **An error prefix inside the archive prefix** puts the records Firehose could
  not transform in the dataset the archive's readers were given. Here
  `quarantine/` is a separate top level, denied by bucket policy to everyone not
  named, alarmed on, and expiring in seven days.
- **Firehose adds no separator between records.** A transform returning bare
  JSON produces objects that are one unparseable line, which Athena reports as
  zero rows rather than as an error.

Identifiers are tokenised rather than masked — `tkn:email:9f2c…`, stable per
subject — so "what did this user do before the error?" still has an answer. That
is pseudonymisation, not anonymisation: the domain of an email address is small
enough to enumerate, so the archive is personal data with the values removed. If
the HMAC key cannot be read, tokenisation degrades to masking rather than to
passing the value through, and an alarm says so.

The ruleset is data with a synth-time validator, because every way of getting it
wrong deploys cleanly: a pattern that does not compile throws at cold start and
delivers the batch raw, a pattern matching the empty string turns every line into
markers, a `g` flag gives the shared RegExp a `lastIndex` that survives between
records, and a key that is both masked and tokenised is masked — killing the
correlation silently. `npm run audit:logs` is the review gate over the
synthesised templates.

See [docs/log-pipeline.md](./docs/log-pipeline.md) for the rules, the quarantine
policy, the Athena layout and the known gaps.

## Spec Progress
See [SPEC.md](./SPEC.md).
