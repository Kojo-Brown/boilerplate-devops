# Spec: boilerplate-devops

> GitHub Actions + AWS CI/CD templates. Copy-paste ready. Spec-driven.

## Phase 0 — Green Baseline (blocks all feature work)
- [ ] Confirm every CDK stack passes `cdk synth` cleanly
- [ ] Confirm every workflow in `workflow-templates/` passes `actionlint`
- [ ] Add a CI workflow that runs `cdk synth`, `actionlint`, and Checkov on every PR
- [ ] Verify no template contains a hardcoded account id, ARN, or credential

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
- [ ] Canary deployment with weighted ALB target groups and automatic analysis
- [ ] Automated rollback driven by SLO burn rate, not just alarm state
- [ ] Trunk-based development guardrails: merge queue, required checks, short-lived branches
- [ ] Preview environment per PR with seeded data and teardown on close
- [ ] Database expand/contract migration playbook with a zero-downtime worked example
- [ ] Feature-flag lifecycle: creation, rollout, and a stale-flag cleanup job
- [ ] Deployment metrics: DORA four keys collected and dashboarded

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
