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
- [ ] Automated rollback driven by SLO burn rate, not just alarm state
- [ ] Trunk-based development guardrails: merge queue, required checks, short-lived branches
- [ ] Preview environment per PR with seeded data and teardown on close
- [ ] Database expand/contract migration playbook with a zero-downtime worked example
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
