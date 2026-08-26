# Spec: boilerplate-devops

> GitHub Actions + AWS CI/CD templates. Copy-paste ready. Spec-driven.

## Phase 0 — Green Baseline (blocks all feature work)
- [x] Confirm every CDK stack passes `cdk synth` cleanly
- [x] Confirm every workflow in `workflow-templates/` passes `actionlint`
- [x] Add a CI workflow that runs `cdk synth`, `actionlint`, and Checkov on every PR
- [x] Verify no template contains a hardcoded account id, ARN, or credential

## Phase 1 — GitHub Actions Workflows
- [x] Reusable workflow: `ci.yml` (lint → typecheck → test → build)
- [x] Reusable workflow: `docker-build-push.yml` (build + ECR push)
- [x] Reusable workflow: `deploy-ecs.yml` (ECS rolling deploy)
- [x] PR labeler + size check workflow
- [x] Dependabot config for npm + Docker + GitHub Actions

## Phase 2 — AWS Infrastructure (CDK / CloudFormation)
- [x] VPC with public + private subnets, NAT Gateway
- [x] ECS Fargate service + ALB + HTTPS (ACM)
- [x] RDS PostgreSQL (Multi-AZ) + Secrets Manager rotation
- [x] ElastiCache Redis cluster
- [x] ECR repository with lifecycle policy

## Phase 3 — Secrets & Config
- [x] AWS Secrets Manager integration pattern
- [x] Parameter Store hierarchy: `/app/{env}/{key}`
- [x] OIDC GitHub → AWS role assumption (no long-lived keys)
- [x] Secret scanning workflow (trufflehog)

## Phase 4 — Monitoring
- [x] CloudWatch dashboard: ECS CPU/memory, ALB 5xx, RDS connections
- [x] CloudWatch Alarms → SNS → PagerDuty
- [x] X-Ray tracing integration (Express + FastAPI)
- [x] Log Insights queries for error analysis

## Phase 5 — Advanced Deployment
- [x] Blue/green deployment via ECS with CodeDeploy
- [x] Feature flag deployment with AWS AppConfig
- [x] Database migration safety: run before traffic shift
- [x] Rollback automation on alarm breach

## Phase 6 — Cost & Security
- [x] AWS Cost Anomaly Detection + budget alerts
- [x] GuardDuty + Security Hub baseline config
- [x] WAF rules for OWASP top 10
- [x] S3 static site + CloudFront + Route53

## Phase 7 — Progressive Delivery
- [x] Canary deployment with weighted ALB target groups and automatic analysis — `CanaryDeployStack` shifts the listener weights itself from a Step Functions state machine and judges each bake window by comparing the canary target group against the stable one, so a regression is caught relative to what the deployment is replacing rather than against a fixed alarm threshold; a window with too little traffic to judge rolls back in production instead of promoting unmeasured (PR #27)
- [x] Automated rollback driven by SLO burn rate, not just alarm state — `SloBurnRateRollbackStack` measures the error ratio against the budget the objective implies, so 1% errors against three nines reads as a 10x burn rather than "over 1%", and each policy fires only when a long *and* a short window agree: the long one refuses to react to a spike, the short one refuses to react to an incident that has already ended. The handler attributes before it acts — it re-reads the metrics, aborts if the burn has recovered, and rolls back only services whose deployment started recently, because burning budget is a symptom a rollback treats only if a deployment caused it (PR #28)
- [x] Trunk-based development guardrails: merge queue, required checks, short-lived branches — the three settings live in three places and nothing in GitHub reconciles them, so a ruleset requiring a check no workflow produces (or a workflow that stopped producing one) is silent until a PR hangs at "waiting for status to be reported" — and with a queue enabled it stalls the queue rather than one PR. `.github/rulesets/trunk-based-main.json` declares required checks (pinned to integration_id 15368) and a squash-only ALLGREEN queue as config; `ci.yml` gained the `merge_group` trigger without which none of its checks report inside the queue; `.github/workflows/trunk-guardrails.yml` measures what GitHub has no setting for (branch age from the author date, since a rebase rewrites the committer date of exactly the branches old enough to need rebasing, plus lines changed against the merge base); and `npm run audit:trunk` fails the build when the three disagree. Self-applied at 1200 lines in warn mode, calibrated from this repo's own 438–3280 line distribution — the shipped 400/error defaults would have failed every conforming PR. The ruleset is not applied and the queue is not enabled: that needs repository admin (PR #29)
- [x] Preview environment per PR with seeded data and teardown on close — everything slow or expensive is shared (`PreviewEnvironmentStack`: one ALB, one ECS cluster, one Postgres instance), because a preview is only worth having if opening a pull request is enough to get one, and a VPC and database each is fifteen minutes of provisioning per branch. `PreviewPrStack` adds a service, a target group, and a listener rule, and deliberately declares the service with **zero tasks**: CloudFormation creates the task definition and the service in one operation, and the seed cannot run until the task definition exists, so one task would start the application against a schemaless database inside that same operation and fail the first deploy. The workflow creates the database, deploys, seeds from the image under review, then scales up. Teardown has two mechanisms because the `closed` event silently fails to reach a runner whenever a run is cancelled or Actions is degraded: an hourly reaper Lambda deletes stacks whose pull request has closed and stacks past their lifetime, and never confuses *cannot reach GitHub* with *closed* — an environment deleted mid-review by a 500 cannot be given back. Both paths call `DeleteStack` rather than `cdk destroy`, since the branch is usually gone by then. Two Checkov findings were fixed rather than suppressed: the ALB drops invalid header fields, and the listener uses `RECOMMENDED_TLS` — `SslPolicy.RECOMMENDED` is still the 2016 policy and negotiates TLS 1.0 (PR #30)
- [x] Database expand/contract migration playbook with a zero-downtime worked example — `DbMigrationStack` runs migrations from CodeDeploy's `BeforeAllowTraffic` hook, which means that at the moment a migration commits, the only code running is the *old* code; a migration that needs the new release to already be deployed fails at the start of the rollout, against the version being replaced. Nothing here said so and nothing checked for it. `docs/expand-contract-migrations.md` is the playbook (release timeline, lock table, what is reversible, how to check a `safe-after:` claim); `db/migrations/` splits `users.full_name` into `first_name`/`last_name` across five releases, with a sync trigger rather than application dual-write — which only holds while every writer runs a version that does it, and during a rollout it does not — a batched resumable backfill, and `NOT VALID` → `VALIDATE` → `SET NOT NULL` so no step takes a full scan under ACCESS EXCLUSIVE; `npm run audit:migrations` enforces the mechanical half on every PR across seventeen rules, reading inside dollar-quoted bodies because a `DROP TABLE` is no less destructive for being wrapped in PL/pgSQL (PR #31)
- [x] Feature-flag lifecycle: creation, rollout, and a stale-flag cleanup job — a flag is a branch in production that someone promised to delete, and nothing held anyone to the promise: `AppConfigStack` shipped a flat map of booleans with no owner, no reason and no removal date. The manifest now declares all three plus a kind, and `npm run audit:flags` rejects a flag missing any of them, a date that is not a real calendar day (`2026-02-30` is rejected rather than rolled into March), a deadline over 90 days out or before its own creation, a field nothing reads (`rolloutPct: 50` deploys fine, reads as 100%, looks like 50% in review), and the two rollout states that read as one thing and mean another; the same schema is attached to the AppConfig profile as a validator, so a malformed version is rejected at `CreateHostedConfigurationVersion`. The "gradual rollout" already here was a *configuration* rollout — AppConfig shifts a new version out to polling clients and every process converges on the same value — so `rolloutPercentage` had no implementation at all; `lib/feature-flag-bucketing.ts` is it, stable per subject, decorrelated per flag, and nested so raising 10% to 25% keeps the original cohort. `FeatureFlagLifecycleStack` sweeps daily over what is *actually deployed* via the runtime Data API, classifies expired / readyToRemove / abandoned / expiring, and files the first three as GitHub issues; every reason is published as a metric every run including the zeroes, and an environment it cannot read is `ManifestUnreadable` rather than zero stale flags. It never deletes a flag and its role has no AppConfig write permission — deleting configuration ahead of the code that reads it resolves the key to `undefined`, which is falsy, which takes the branch the rollout moved away from. Expiry blocks a deploy rather than a build, since a gate that reddens every build on a date the pull request did not choose is one teams route around (PR #32)
- [x] Deployment metrics: DORA four keys collected and dashboarded — each key is a ratio or a duration over two events, so the arithmetic is trivial and every wrong pairing still produces a believable number, which is why a wrong DORA dashboard survives for years. Lead time is measured from the *first commit on the branch*, read from the pull request: under the squash-merge policy this repo's own ruleset requires, the deployed commit is authored at merge time, so measuring from it reports deploy-pipeline duration — minutes, elite against any threshold, regardless of how long the change sat in review; the fallback is still published but under `Source=headCommit` in its own colour, so a team measuring the wrong thing can see it. Change failure rate excludes deployments younger than the attribution window from *both* sides, because a deploy from four minutes ago is already in the denominator while the incident it is about to cause has not happened — and publishes no rate at all when nothing is ripe, since zero over zero renders identically to a clean month. Only incidents traceable to a deployment count, otherwise the rate rises when the deploy cadence *falls*; the flag lives on the deployment, so one bad deploy tripping three alarms is one change failure. A flapping alarm is one incident, not six failures each recovering in a minute. DynamoDB rather than metrics alone because attribution is retroactive and a published datapoint cannot be revisited; alarms are mapped to services explicitly because a name-prefix rule reads `production-alb-5xx-elb` as a service called "alb", which matches no deployment and reads as zero failures forever. Nothing gates a deploy; `LeadTimeUnmeasurable` and its alarm cover the real failure mode, a score that quietly stopped being a measurement (PR #33)

Item 1 complete as of PR #27 (2026-08-08). All four checks green: the CDK job
(typecheck, identifier scan, synth of 39 stacks, 819 tests), actionlint,
Checkov, and GitGuardian.

`CanaryDeployStack` is an *alternative* to `EcsStack` and `BlueGreenDeployStack`,
not a companion — all three own an ALB and an ECS service for the same
application, so a real deployment picks one and deletes the others. `bin/app.ts`
defines all of them because this is a boilerplate.

Checkov gained zero new findings and `.checkov.baseline` was not touched, which
required real fixes rather than suppressions: a customer-managed KMS key over all
four log groups and both Lambdas' environment variables, `TLS13-1-2` on the
listener, `drop_invalid_header_fields`, reserved Lambda concurrency, and Step
Functions tracing plus logging. The two genuine non-applicable checks
(`CKV_AWS_116` DLQ, `CKV_AWS_117` VPC) are exempted as `Metadata.checkov.skip` on
the resources themselves, so the reasoning copies out with them.

Known gaps carried forward: **nothing here has been deployed to AWS** — the
verification is synth, unit tests, and static analysis, so the state machine's
behaviour against a live ALB and real ECS rollouts is unproven. Listener weights
are runtime state the state machine owns, so `cdk deploy` during an in-flight
execution resets them to 100/0 and that execution will then analyze a canary
receiving no traffic; do not deploy while one is running. The analyzer reads
ALB-level signals only (5xx, latency, unhealthy hosts) — application-level canary
metrics would need a custom namespace. The older deploy workflows still sit in
`workflow-templates/` rather than `.github/workflows/`; only the new
`canary-deploy.yml` follows the stated convention.

Item 2 complete as of PR #28 (2026-08-09). All four checks green: the CDK job
(typecheck, identifier scan, synth of 41 stacks, 899 tests), actionlint, Checkov,
and GitGuardian. 80 of those tests are new; 35 of them compile and run the inline
Lambda handler against recording SDK stubs, which is the only thing in the build
that parses it at all — `tsc` sees a template literal and `cdk synth` embeds it
verbatim, so an inverted comparison would otherwise first surface as a rollback
that silently did not happen. Writing them caught two real defects before push:
the recovery check disagreed with the alarm at exactly the threshold, and
CodeDeploy targets were calling `DescribeServices` unnecessarily.

`SloBurnRateRollbackStack` composes with `RollbackAutomationStack` rather than
replacing it — alarm state for hard failures, burn rate for the slow regressions
a fixed threshold either misses or over-reacts to. Unlike the three deployment
strategies it does not own an ALB or a service, so it stacks on whichever one an
environment picks.

Checkov gained zero new findings and `.checkov.baseline` was not touched: a
customer-managed KMS key over the log group and the Lambda environment, SNS
encryption, reserved concurrency of 2 so a metric storm cannot stack rollbacks,
and IAM scoped to the exact ECS service and CodeDeploy deployment-group ARNs. The
two non-applicable checks are `Metadata.checkov.skip` on the function itself.

Known gaps carried forward: **nothing here has been deployed to AWS** — synth,
unit tests, and static analysis are the whole of the verification, so the alarms
against a live ALB and the rollback against a real ECS rollout are unproven. The
metric-math expressions synthesize and read correctly but have never been
evaluated by CloudWatch; `IF`/`FILL` behaviour on a zero-traffic window is
reasoned about, not observed, which is why the denominator is guarded
independently of the traffic floor. The SLO is measured on ALB 5xx and request
count only — an objective on latency, or on an application-level definition of
"good", would need a second metric source. `minimumRequestsPerWindow` is the
setting most likely to be wrong for a given environment's traffic.

Item 7 complete as of PR #33 (2026-08-19). All five checks green: the CDK job
(typecheck, identifier scan, three audits, synth of 40 stacks, 1307 tests),
actionlint, Checkov, GitGuardian, and the short-lived-branch guardrail.

`DoraMetricsStack` is a *companion* to the deployment stacks rather than an
alternative to any of them — it observes whichever one you picked. It is a
single stack, not one per environment, deliberately: the four keys are a
comparison, and staging and production on the same axes is how "we deploy to
staging twenty times a day and to production twice a month" becomes visible.

Checkov gained zero new findings and `.checkov.baseline` was not touched. The
one new finding raised — `CKV_AWS_27` on the recorder's dead letter queue — was
fixed rather than suppressed, using the `alias/aws/sqs` KMS alias instead of
SSE-SQS: identical encryption at rest, no key to rotate, and it satisfies the
check honestly. Both Lambdas carry `Metadata.checkov.skip` for the genuinely
non-applicable checks (VPC, env-var CMK, and DLQ on the aggregator only), so the
reasoning travels with the resource.

Known gaps carried forward: **nothing here has been deployed to AWS** — the
verification is synth, unit tests and static analysis, so the handlers'
behaviour against live EventBridge deliveries and real alarm transitions is
unproven. The pipeline is not emitting events yet either;
`workflow-templates/emit-dora-deployment.yml` ships as a template and wiring it
into a deploy job plus granting `events:PutEvents` is a consumer step, so until
then the dashboard is correctly empty rather than broken. One artefact is
disclosed rather than fixed: merging a flapping episode is retroactive, so the
close that gets undone has already published a short `RecoveryTimeSeconds`
datapoint that CloudWatch cannot retract, pulling p50 recovery down slightly —
incident counts and change failure rate are unaffected, and withholding every
recovery time for the flap window would delay the honest majority to correct the
rare exception. `RemovalPolicy.RETAIN` on the table means a redeploy after `cdk
destroy` fails on the table name until the retained table is deleted or
imported; that is intentional, since the attribution state is the only record of
how the delivery system performed and the events that produced it are long gone.
Author dates understate lead time for a branch rebased with `--reset-author`;
no better signal exists in the git object graph.


## Phase 8 — Kubernetes Track
- [x] EKS cluster via CDK with managed node groups and IRSA — private API endpoint, one managed node group, four EKS-managed add-ons, and an OIDC provider; the node role is thin because the CNI holds its ENI permissions through IRSA instead (PR #34)
- [x] Helm chart with values per environment and a schema-validated `values.yaml` — `k8s/charts/app`, installed with `values-staging.yaml` or `values-production.yaml`; the schema closes every object, and two gates plus five must-fail fixtures keep it from quietly stopping to catch anything (PR #35)
- [x] Horizontal Pod Autoscaler + Cluster Autoscaler with load-tested thresholds — an `autoscaling/v2` HPA in the chart and the upstream Cluster Autoscaler in `EksStack`, pinned to the cluster's Kubernetes version and discovering node groups by ASG tag; the thresholds are derived rather than measured, because there is no cluster to measure against (PR #36)
- [x] Pod security: non-root, read-only rootfs, dropped capabilities, seccomp — the chart had no `securityContext` at all, which is not neutral: root, containerd's default 14 capabilities, a writable rootfs and seccomp Unconfined are what Kubernetes does when the fields are absent. Both contexts are now `const` in the schema rather than defaults, so an environment file cannot relax one (PR #37)
- [ ] NetworkPolicy default-deny with explicit allowlists
- [ ] GitOps with ArgoCD: app-of-apps, sync waves, and drift detection
- [ ] Ingress with cert-manager, external-dns, and automatic TLS renewal

Item 1 complete as of PR #34 (2026-08-21). What made this one item rather than
two is that a managed node group without IRSA is a security posture, not an
unfinished feature: an SDK call from a pod is signed with whatever the instance
metadata service returns, which is the node's role, so every pod on a node holds
the union of every permission any pod there needs. So the node role carries the
worker and ECR-read policies only, the VPC CNI's ENI permissions moved to a role
bound to `kube-system/aws-node`, and nodes require IMDSv2 at a hop limit of 1 —
without that last one a compromised pod can ask for the node role and ignore
IRSA entirely. Every trust policy conditions on both `:sub` and `:aud`.

Checkov needed a deliberate decision. The CDK EKS module emits its own
deployment-time handlers, and five checks fire on resources no construct prop
reaches: 25 new findings per environment. `placeClusterHandlerInVpc` fixed the
VPC finding for real; the rest are suppressed per resource with written reasons
in `lib/checkov-suppressions.ts`, through an aspect scoped to CDK-internal
construct paths and pinned by `test/checkov-suppressions.test.ts` so the escape
hatch cannot spread to resources this repository writes. `.checkov.baseline` was
deliberately not touched — it records what predated the gate, and new
infrastructure entering it is the regression the gate exists to catch.

Known gaps carried into item 2: nothing is deployed, so every gate here is
synth-and-scan — CI proves the templates are well-formed and clean, not that a
cluster comes up. Pod Security Standards are not enforced cluster-wide (item 4),
there is no ingress controller or `AWSLoadBalancerControllerIAMPolicy` yet
(item 7 — the subnet tags it needs are in place behind `tagSubnetsForEks`), and
the cluster has no application delivery path at all until items 2 and 6. Add-on
versions are unpinned by choice; a CI artifact narrowed to `*.template.json`
keeps the two staged Lambda layers out of the upload.

Item 2 complete as of PR #35 (2026-08-23). `k8s/charts/app` is the delivery path
the cluster did not have: Deployment, Service, ServiceAccount annotated for
IRSA, a config ConfigMap hashed into the pod template, and a
PodDisruptionBudget, with `values-staging.yaml` and `values-production.yaml`
carrying only what each environment changes.

The schema is the item, and its point is not documentation. `replicas: 3` is
the Deployment field and not this chart's value; without
`additionalProperties: false` it installs the default replica count and reports
success — invisible in review, invisible at deploy, and visible later as
capacity that was never there. So every object in `values.schema.json` closes,
and the policy rules ride along with the typing: no moving image tags (a
rollback needs a fixed target), `resources` required rather than optional
(BestEffort scheduling and an unbounded memory limit both fail only under
load), and string-typed `config` values (ConfigMap data is string-valued, so an
unquoted `PORT: 8080` is otherwise rejected by the API server after the release
has started).

Two gates, because a schema is only a gate while it still rejects something and
the way that stops being true is quiet — one dropped line reopens a subtree and
nothing else changes. `npm run audit:helm` runs in the CDK job, validates with
ajv so it needs no Helm binary, walks the schema for objects that have drifted
open, checks environment coverage in both directions, and enforces what JSON
Schema cannot express because it compares two properties: `minAvailable` below
`replicaCount`, no single-replica production, and a values file whose
`environment` disagrees with its own filename. The new `Helm chart` job runs
`helm lint --strict` and `helm template` per environment, because the validator
that decides whether a real `helm upgrade` succeeds is Helm's own
`xeipuuv/gojsonschema` and not ajv. `schema-fixtures/` holds five values files
that must each be rejected, asserted against the specific keyword that should
catch each one, by both validators. Checked against the failure it names:
removing the root `additionalProperties: false` makes the script exit 1 on
`unknown-key.yaml` and the audit exit 1 with `schema-open-object`.

`get.helm.sh` is blocked by the scheduled agent's egress policy (403 on
CONNECT), so the local Helm was 3.10.1 from the `helm-binary-linux` npm package
while CI installs 3.19.0 through `azure/setup-helm@v4`. That is why
`--kube-version` is passed on `template` and not on `lint`, which did not accept
the flag before Helm 3.12 — and passing it explicitly is right anyway, since the
render should not depend on which Kubernetes version the local Helm build
defaults to.

Known gaps carried into item 3: the rendered pods run with the cluster's
security defaults, which is exactly item 3's scope — and Checkov deliberately
does not scan the rendered manifests yet for the same reason, since its
Kubernetes checks are almost entirely those pod-security checks and wiring the
scan up now would mean implementing item 3 early or writing a suppression list
that then has to be unwound. Nothing is deployed: both gates are
lint-and-render, so there are no `helm test` hooks and no chart-testing install
test, and no `deploy-helm.yml` template — the rollout path is item 6, and a
`helm upgrade` workflow written now would be replaced by it. `azure/setup-helm`
is on `node20` at its latest major, so the runner's Node 20 deprecation warning
now names it alongside the `actions/*@v4` pins Dependabot is already opening
pull requests against.

Item 3 complete as of PR #36 (2026-08-25). One item rather than two because
neither half is useful alone: an HPA with no room underneath it turns a spike
into Pending pods and reports success, and a Cluster Autoscaler under a fixed
replica count adds nodes nothing schedules onto. The chart gains an
`autoscaling/v2` HPA with an explicit `behavior` — up fast, down slowly — and
`EksStack` gains the upstream Cluster Autoscaler, IRSA-authorised and
discovering node groups by ASG tag.

Two decisions inside the chart look like bugs and are not. The Deployment
renders **no `replicas` field** while the HPA is on: `replicas` is part of the
manifest, so every `helm upgrade` writes whatever the template says, and with an
HPA also writing it the two fight — a capacity dip on every deploy, worst when
the fleet is largest. The cost is that a first install starts at one pod until
the HPA's next sync, which is documented rather than papered over. And the
`behavior` policies are named keys (`percent`, `pods`) rather than the API's
array, because Helm replaces arrays wholesale: an environment file changing one
policy in a list would have to restate the others, and the one it forgot would
vanish.

The autoscaler discovers by ASG tag rather than by name because EKS, not
CloudFormation, creates the ASG behind a managed node group — no name exists at
synth time. Its chart version is pinned to the cluster's Kubernetes version
(9.51.0 → autoscaler v1.33.0) for the same reason `kubectlLayer` is: the
autoscaler reads scheduler internals to decide whether a pending pod would fit a
hypothetical node, so it is not skew tolerant. The IRSA role splits into reads
on `*` — none of those actions supports resource-level permissions, and the
autoscaler has to see groups it does not manage to answer "would this pod fit
anywhere" — and two mutating actions scoped to ASG ARNs under this cluster's
ownership tag, without which the role could resize every group in the account. A
test asserts every action in the wildcard statement is a `Describe`/`Get`/`List`,
which is what keeps that statement safe as it grows.

`audit:helm` now checks availability against the fleet's **floor** rather than
its nominal size. `minAvailable: 4` looks generous against eight replicas and
permits no disruption at all once the HPA settles to four — and the drain that
matters is the one that arrives at 4am. Two new rules join it: an HPA whose
ceiling is not above its floor (accepted by Kubernetes, reports itself healthy,
scales nothing) and a `replicaCount` outside the HPA's range, which is inert
while autoscaling is on and becomes the fleet size the moment it is turned off.

**The spec item says "load-tested thresholds" and nothing was load tested.**
There is no cluster in CI and none was created, so `docs/autoscaling.md` §3
ships the arithmetic every threshold falls out of and states explicitly that its
four inputs are the reference profile's stated characteristics, not numbers read
off a run. `k8s/load-test/hpa-ramp.js` is the k6 ramp that produces those inputs
— an open-model staircase with a trough long enough to observe scale-down — and
it is a procedure, not a gate. The one arithmetic tie nobody else checks is
worth repeating: `maxReplicas × requests.cpu` above what the node group's
`maxSize` can supply does not fail anywhere, it just leaves Pending pods behind
a dashboard that says the autoscaler is working.

Known gaps carried into item 4: **no metrics-server**, which the HPA reads and
EKS does not ship as a managed add-on — without it the HPA reports `<unknown>`
and scales nothing, so this is the first thing to install before any of the
above runs. The single node group means the autoscaler leaves a couple of nodes
pinned above the group's minimum, because it will not drain a node running a
kube-system Deployment; the fix is a second node group, not a flag. Item 4's pod
security context is still the reason Checkov does not scan the rendered
manifests. No custom or external metrics (CPU is a poor proxy for a service that
blocks on I/O), no VPA, no Karpenter, and no pod topology spread — four replicas
over three AZs is what the scheduler happens to do, not something the chart
requires, and that belongs with item 4 since it is the next thing to touch the
pod spec.

Item 4 complete as of PR #37 (2026-08-26). The pod context fixes the identity
(non-root, UID/GID/fsGroup 10001, seccomp `RuntimeDefault`) and the container
context fixes the behaviour (`allowPrivilegeEscalation: false`,
`privileged: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`).
Together they satisfy the restricted Pod Security Standard, so a namespace
carrying the enforce label admits these pods — applying that label stays the
cluster operator's call, but a chart that cannot pass the standard takes the
option away from them.

The split between the two blocks is the Kubernetes API's, not a style choice:
`capabilities`, `readOnlyRootFilesystem` and `allowPrivilegeEscalation` do not
exist in a `PodSecurityContext`, and `fsGroup`/`seccompProfile` do not exist in a
container one. Both objects are closed in the schema, so a field written into the
wrong block fails to render rather than being accepted and ignored.

Every security field is a `const` rather than a default. That is the deliberate
decision in this item: an environment file setting `privileged: true` or
`readOnlyRootFilesystem: false` is not overriding a value, it is leaving the
posture the rest of the chart assumes, and it now fails at `helm lint` with no
`--set` past it. The cost of `readOnlyRootFilesystem` is real and is paid in
`writableVolumes` rather than by turning the flag off: nearly every runtime
writes to `/tmp` — Node's inspector socket, the JVM's `hsperfdata`, Go's
`os.CreateTemp` — so the chart mounts one size-limited `emptyDir` there.
`sizeLimit` is required, because an unbounded `emptyDir` draws on the node's
shared ephemeral storage and a service that leaks temporary files evicts its
neighbours before itself. The volumes are disk-backed rather than
`medium: Memory`, which would count against a memory limit equal to the request
and turn a full `/tmp` into an OOMKill with no stack.

Four rules go to `audit:helm`, because each compares two values and each
describes a pod Kubernetes accepts and then does something unhelpful with: a
capability granted back after `drop: [ALL]` (allowed only from
`ALLOWED_ADDED_CAPABILITIES`, today just `NET_BIND_SERVICE`); `NET_BIND_SERVICE`
held by a container binding an unprivileged port; a `containerPort` below 1024 on
a non-root container that dropped it, which is admitted, rolls out, and then
fails with `EACCES` on `bind()`; and two scratch volumes sharing a name or a
mount path. `schema-fixtures/` goes from seven files to twelve, each asserted
against the keyword that must catch it — `contains` for the capability list,
`minimum` on the UID for root — because each of the five new ones has a near-miss
a bare "some error" assertion would let through.

Known gaps carried into item 5: **there is still no NetworkPolicy**, so anything
in the cluster can reach these pods — `docs/eks.md` now says that on its own
rather than lumping it in with the pod-security gap this closes. No namespace
enforces the `restricted` label, so nothing stops a *different* workload from
running privileged; the chart being admissible is what makes applying that label
a one-line change rather than a migration. `seccompProfile.type: Localhost` is
schema-valid and untested against a real node — the schema catches the failure
that matters at deploy time (`Localhost` with no `localhostProfile`), but whether
a named profile exists on a node is a cluster fact this repository has no cluster
to check. Checkov still does not scan the rendered manifests; that needs the
Helm job to render into an artifact the Checkov job reads, which is its own
change. Pod topology spread is still not required by the chart, and the
metrics-server gap from item 3 is unchanged.

## Phase 9 — Supply-Chain Security
- [ ] SBOM generation (CycloneDX) attached to every release artifact
- [ ] Container image signing with cosign + verification enforced at deploy
- [ ] SLSA provenance attestation in the build workflow
- [ ] Dependency pinning by digest for Actions and base images
- [ ] Trivy/Grype vulnerability gate with a documented severity policy
- [ ] IaC scanning with Checkov + a policy-as-code gate (OPA/Conftest)
- [ ] Least-privilege IAM audit with an access-analyzer report in CI

## Phase 10 — Observability & SRE
- [ ] OpenTelemetry Collector deployment with tail-based sampling
- [ ] SLO definitions with error budgets and burn-rate alerts
- [ ] Structured log pipeline with PII scrubbing before ingest
- [ ] Distributed tracing across API → queue → worker with context propagation
- [ ] Synthetic canary checks from multiple regions
- [ ] Runbook automation: alert links to a runbook with an executable first step
- [ ] Incident postmortem template + a blameless review checklist

## Phase 11 — Resilience & Cost
- [ ] Multi-AZ failover game day with a documented RTO/RPO measurement
- [ ] Backup and restore drill for RDS with automated verification
- [ ] Chaos engineering with AWS FIS: instance, latency, and AZ fault templates
- [ ] Graviton/ARM migration guide with a cost-and-benchmark comparison
- [ ] Spot instance strategy for non-critical workloads with interruption handling
- [ ] Right-sizing automation driven by Compute Optimizer findings
- [ ] Tagging policy enforced by SCP with a cost-allocation dashboard
