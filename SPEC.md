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
- [ ] Feature-flag lifecycle: creation, rollout, and a stale-flag cleanup job
- [ ] Deployment metrics: DORA four keys collected and dashboarded

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

## Phase 8 — Kubernetes Track
- [ ] EKS cluster via CDK with managed node groups and IRSA
- [ ] Helm chart with values per environment and a schema-validated `values.yaml`
- [ ] Horizontal Pod Autoscaler + Cluster Autoscaler with load-tested thresholds
- [ ] Pod security: non-root, read-only rootfs, dropped capabilities, seccomp
- [ ] NetworkPolicy default-deny with explicit allowlists
- [ ] GitOps with ArgoCD: app-of-apps, sync waves, and drift detection
- [ ] Ingress with cert-manager, external-dns, and automatic TLS renewal

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
