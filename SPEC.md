# Spec: boilerplate-devops

> GitHub Actions + AWS CI/CD templates. Copy-paste ready. Spec-driven.

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
- [ ] WAF rules for OWASP top 10
- [ ] S3 static site + CloudFront + Route53
