#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { VpcStack } from '../lib/vpc-stack';
import { EcsStack } from '../lib/ecs-stack';
import { RdsStack } from '../lib/rds-stack';
import { ElastiCacheStack } from '../lib/elasticache-stack';
import { EcrStack } from '../lib/ecr-stack';
import { SecretsManagerStack } from '../lib/secrets-manager-stack';
import { ParameterStoreStack } from '../lib/parameter-store-stack';
import { GitHubOidcStack } from '../lib/github-oidc-stack';
import { CloudWatchDashboardStack } from '../lib/cloudwatch-dashboard-stack';
import { CloudWatchAlarmsStack } from '../lib/cloudwatch-alarms-stack';
import { LogInsightsStack } from '../lib/log-insights-stack';
import { LogPipelineStack } from '../lib/log-pipeline-stack';
import { BlueGreenDeployStack } from '../lib/blue-green-deploy-stack';
import { CanaryDeployStack } from '../lib/canary-deploy-stack';
import { AppConfigStack } from '../lib/appconfig-stack';
import { FeatureFlagLifecycleStack } from '../lib/feature-flag-lifecycle-stack';
import { DbMigrationStack } from '../lib/db-migration-stack';
import { RollbackAutomationStack } from '../lib/rollback-automation-stack';
import { SloBurnRateRollbackStack } from '../lib/slo-burn-rate-rollback-stack';
import { SloStack } from '../lib/slo-stack';
import { requireSlo, significanceFloorEvents } from '../lib/slo-definitions';
import { CostAnomalyStack } from '../lib/cost-anomaly-stack';
import { SecurityHubStack } from '../lib/security-hub-stack';
import { WafStack } from '../lib/waf-stack';
import { StaticSiteStack } from '../lib/static-site-stack';
import { PreviewEnvironmentStack } from '../lib/preview-environment-stack';
import { PreviewPrStack } from '../lib/preview-pr-stack';
import { NGINX_PLACEHOLDER_IMAGE } from '../lib/base-images';
import { DoraMetricsStack } from '../lib/dora-metrics-stack';
import { EksStack } from '../lib/eks-stack';
import { OtelCollectorStack } from '../lib/otel-collector-stack';
import { TracedQueueStack } from '../lib/traced-queue-stack';
import { DEFAULT_TAIL_SAMPLING } from '../lib/otel-collector-config';

const app = new cdk.App();

// ACM certificate ARNs must be created/imported outside CDK and supplied via
// CDK context or environment variables before deploying the ECS stacks.
// Usage:  cdk deploy --context stagingCertificateArn=arn:aws:acm:...
//    or:  STAGING_ACM_CERTIFICATE_ARN=arn:aws:acm:... cdk deploy
const stagingCertArn =
  (app.node.tryGetContext('stagingCertificateArn') as string | undefined) ??
  process.env.STAGING_ACM_CERTIFICATE_ARN ??
  'arn:aws:acm:REGION:ACCOUNT:certificate/REPLACE-ME-STAGING';

const productionCertArn =
  (app.node.tryGetContext('productionCertificateArn') as string | undefined) ??
  process.env.PRODUCTION_ACM_CERTIFICATE_ARN ??
  'arn:aws:acm:REGION:ACCOUNT:certificate/REPLACE-ME-PRODUCTION';

// ── ECR (shared; repositories exist once per AWS account, not per environment) ─
new EcrStack(app, 'EcrStack-Staging', {
  envName: 'staging',
  repositoryName: 'staging-app',
  maxTaggedImageCount: 20,
  untaggedImageExpiryDays: 7,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging ECR repository with lifecycle policy',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new EcrStack(app, 'EcrStack-Production', {
  envName: 'production',
  repositoryName: 'production-app',
  maxTaggedImageCount: 30,
  untaggedImageExpiryDays: 7,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production ECR repository with lifecycle policy (images retained)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── GitHub OIDC ───────────────────────────────────────────────────────────────
// Provisions a GitHub Actions OIDC identity provider and scoped IAM roles.
// Deploy once per environment; one OIDC provider is shared across all stacks.
// Replace YOUR_ORG/YOUR_REPO with your actual GitHub organisation and repo.
//
// After deployment, add the CloudFormation outputs to GitHub Secrets:
//   STAGING_CI_ROLE_ARN     ← GitHubOidcStack-Staging.CIRoleArn
//   STAGING_DEPLOY_ROLE_ARN ← GitHubOidcStack-Staging.DeployRoleArn
//   PROD_DEPLOY_ROLE_ARN    ← GitHubOidcStack-Production.DeployRoleArn

new GitHubOidcStack(app, 'GitHubOidcStack-Staging', {
  envName: 'staging',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'GitHub Actions OIDC provider + IAM roles for staging (no long-lived keys)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new GitHubOidcStack(app, 'GitHubOidcStack-Production', {
  envName: 'production',
  createOidcProvider: false, // provider already created by the staging stack (one per account)
  existingOidcProviderArn: `arn:aws:iam::${process.env.CDK_DEFAULT_ACCOUNT ?? 'ACCOUNT_ID'}:oidc-provider/token.actions.githubusercontent.com`,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'GitHub Actions IAM roles for production (reuses staging OIDC provider)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Secrets Manager ───────────────────────────────────────────────────────────
// Manages application-level secrets (API keys, OAuth tokens, etc.) separate from
// the database credentials that live in RdsStack.  Deploy this stack first, then
// populate secret values via the AWS Console or CLI before deploying ECS tasks.
//
// After deployment, grant ECS task roles access:
//   secretsStackStaging.grantRead(ecsTaskDef.executionRole)
//   taskDef.addContainer('App', {
//     secrets: secretsStackStaging.toEcsSecrets(['stripe-api-key']),
//   });

const commonSecrets = [
  {
    key: 'stripe-api-key',
    description: 'Stripe secret key for payment processing',
  },
  {
    key: 'sendgrid-api-key',
    description: 'SendGrid API key for transactional email',
  },
  {
    key: 'jwt-signing-secret',
    description: 'HMAC secret for signing JWTs',
    generateRandomPassword: true,
    passwordLength: 64,
  },
  {
    key: 'oauth-client-secret',
    description: 'OAuth 2.0 client secret for third-party SSO',
  },
];

new SecretsManagerStack(app, 'SecretsManagerStack-Staging', {
  envName: 'staging',
  secrets: commonSecrets,
  enableKmsEncryption: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging application secrets — KMS encrypted, REPLACE_ME placeholders',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new SecretsManagerStack(app, 'SecretsManagerStack-Production', {
  envName: 'production',
  secrets: commonSecrets,
  enableKmsEncryption: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production application secrets — KMS encrypted, retention enabled',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Parameter Store ───────────────────────────────────────────────────────────
// Runtime configuration values (non-secret) stored under /app/{env}/{key}.
// Deploy before ECS tasks; populate real values via the AWS Console or CLI.
// Grant task roles access: paramStoreStaging.grantRead(ecsTaskDef.taskRole)
//
// Load all parameters at runtime:
//   aws ssm get-parameters-by-path \
//     --path /app/staging/ \
//     --with-decryption \
//     --recursive

const commonParameters = [
  {
    key: 'log-level',
    description: 'Application log level (error | warn | info | debug)',
    value: 'info',
  },
  {
    key: 'api-endpoint',
    description: 'Base URL for the internal API service',
    value: 'https://api.example.com',
  },
  {
    key: 'db-pool-size',
    description: 'PostgreSQL connection pool size',
    value: '10',
  },
  {
    key: 'cache-ttl-seconds',
    description: 'Default Redis cache TTL in seconds',
    value: '300',
  },
  {
    key: 'allowed-origins',
    description: 'Comma-separated CORS allowed origins',
    type: 'StringList' as const,
    value: 'https://app.example.com,https://admin.example.com',
  },
  {
    key: 'feature/dark-mode',
    description: 'Feature flag: enable dark mode UI',
    value: 'false',
  },
];

new ParameterStoreStack(app, 'ParameterStoreStack-Staging', {
  envName: 'staging',
  parameters: commonParameters,
  enableKmsEncryption: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging SSM Parameter Store hierarchy — /app/staging/* with KMS encryption',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new ParameterStoreStack(app, 'ParameterStoreStack-Production', {
  envName: 'production',
  parameters: commonParameters,
  enableKmsEncryption: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production SSM Parameter Store hierarchy — /app/production/* with KMS encryption',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Staging ───────────────────────────────────────────────────────────────────
const vpcStackStaging = new VpcStack(app, 'VpcStack-Staging', {
  envName: 'staging',
  vpcCidr: '10.1.0.0/16',
  maxAzs: 2,
  natGateways: 1,
  // EksStack-Staging runs in this VPC; see the EKS section at the end of the file.
  tagSubnetsForEks: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging VPC — public + private subnets across 2 AZs',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

const ecsStackStaging = new EcsStack(app, 'EcsStack-Staging', {
  vpc: vpcStackStaging.vpc,
  envName: 'staging',
  certificateArn: stagingCertArn,
  containerImage: process.env.CONTAINER_IMAGE,
  containerPort: 3000,
  cpu: 512,
  memoryLimitMiB: 1024,
  desiredCount: 1,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging ECS Fargate service + ALB + HTTPS',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

const rdsStackStaging = new RdsStack(app, 'RdsStack-Staging', {
  vpc: vpcStackStaging.vpc,
  envName: 'staging',
  multiAz: false, // single-AZ for cost-optimised staging
  allocatedStorageGiB: 20,
  maxAllocatedStorageGiB: 100,
  allowedSecurityGroups: [ecsStackStaging.taskSecurityGroup],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging RDS PostgreSQL (single-AZ) + Secrets Manager rotation',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new ElastiCacheStack(app, 'ElastiCacheStack-Staging', {
  vpc: vpcStackStaging.vpc,
  envName: 'staging',
  // Single node (no replicas) for cost-optimised staging
  numReadReplicas: 0,
  cacheNodeType: 'cache.t3.micro',
  allowedSecurityGroups: [ecsStackStaging.taskSecurityGroup],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging ElastiCache Redis (single-node)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new CloudWatchDashboardStack(app, 'CloudWatchDashboardStack-Staging', {
  envName: 'staging',
  clusterName: ecsStackStaging.cluster.clusterName,
  serviceName: ecsStackStaging.service.serviceName,
  albFullName: ecsStackStaging.alb.loadBalancerFullName,
  rdsInstanceId: rdsStackStaging.instance.instanceIdentifier,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging CloudWatch Dashboard — ECS CPU/memory, ALB 5xx, RDS connections',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Production ────────────────────────────────────────────────────────────────
const vpcStackProduction = new VpcStack(app, 'VpcStack-Production', {
  envName: 'production',
  vpcCidr: '10.0.0.0/16',
  maxAzs: 2,
  natGateways: 2,
  // EksStack-Production runs in this VPC; see the EKS section at the end of the file.
  tagSubnetsForEks: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production VPC — public + private subnets across 2 AZs (HA NAT)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

const ecsStackProduction = new EcsStack(app, 'EcsStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  certificateArn: productionCertArn,
  containerImage: process.env.CONTAINER_IMAGE,
  containerPort: 3000,
  cpu: 1024,
  memoryLimitMiB: 2048,
  desiredCount: 2,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production ECS Fargate service + ALB + HTTPS (deletion-protected)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

const rdsStackProduction = new RdsStack(app, 'RdsStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  multiAz: true, // Multi-AZ standby for production HA
  allocatedStorageGiB: 100,
  maxAllocatedStorageGiB: 500,
  allowedSecurityGroups: [ecsStackProduction.taskSecurityGroup],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production RDS PostgreSQL (Multi-AZ) + Secrets Manager rotation',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new ElastiCacheStack(app, 'ElastiCacheStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  // 1 replica → Multi-AZ automatic failover in ~20 s
  numReadReplicas: 1,
  cacheNodeType: 'cache.t3.small',
  allowedSecurityGroups: [ecsStackProduction.taskSecurityGroup],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production ElastiCache Redis (Multi-AZ, 1 replica)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new CloudWatchDashboardStack(app, 'CloudWatchDashboardStack-Production', {
  envName: 'production',
  clusterName: ecsStackProduction.cluster.clusterName,
  serviceName: ecsStackProduction.service.serviceName,
  albFullName: ecsStackProduction.alb.loadBalancerFullName,
  rdsInstanceId: rdsStackProduction.instance.instanceIdentifier,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production CloudWatch Dashboard — ECS CPU/memory, ALB 5xx, RDS connections',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── CloudWatch Alarms → SNS → PagerDuty ─────────────────────────────────────
// Each alarm publishes ALARM and OK events to an SNS topic.  Supply the
// PagerDuty Events API v2 HTTPS endpoint via CDK context or environment
// variable to wire up the SNS subscription automatically:
//
//   cdk deploy --context stagingPagerDutyUrl=https://events.pagerduty.com/integration/<key>/enqueue
//   STAGING_PAGERDUTY_URL=https://...  cdk deploy
//
// Without a URL the SNS topic is created and its ARN is exported; wire the
// subscription manually via the AWS Console, CLI, or a separate PagerDuty CDK construct.

const stagingPagerDutyUrl =
  (app.node.tryGetContext('stagingPagerDutyUrl') as string | undefined) ??
  process.env.STAGING_PAGERDUTY_URL;

const productionPagerDutyUrl =
  (app.node.tryGetContext('productionPagerDutyUrl') as string | undefined) ??
  process.env.PRODUCTION_PAGERDUTY_URL;

new CloudWatchAlarmsStack(app, 'CloudWatchAlarmsStack-Staging', {
  envName: 'staging',
  clusterName: ecsStackStaging.cluster.clusterName,
  serviceName: ecsStackStaging.service.serviceName,
  albFullName: ecsStackStaging.alb.loadBalancerFullName,
  rdsInstanceId: rdsStackStaging.instance.instanceIdentifier,
  pagerDutyIntegrationUrl: stagingPagerDutyUrl,
  // Relaxed thresholds for staging — alert earlier to catch regressions
  ecsCpuThreshold: 70,
  ecsMemoryThreshold: 70,
  alb5xxThreshold: 5,
  rdsConnectionsThreshold: 50,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging CloudWatch Alarms → SNS → PagerDuty',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new CloudWatchAlarmsStack(app, 'CloudWatchAlarmsStack-Production', {
  envName: 'production',
  clusterName: ecsStackProduction.cluster.clusterName,
  serviceName: ecsStackProduction.service.serviceName,
  albFullName: ecsStackProduction.alb.loadBalancerFullName,
  rdsInstanceId: rdsStackProduction.instance.instanceIdentifier,
  pagerDutyIntegrationUrl: productionPagerDutyUrl,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production CloudWatch Alarms → SNS → PagerDuty',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── CloudWatch Logs Insights saved queries ────────────────────────────────────
// Pre-built error-analysis queries visible in the CloudWatch console under
// "Saved queries".  Supply accessLogGroupName / rdsLogGroupName to enable the
// access-log and RDS query groups automatically.
//
// Log group naming conventions:
//   app    /ecs/{envName}/{serviceName}      (awslogs driver default)
//   access /aws/elasticloadbalancing/{albName}  (ALB → Firehose → CW Logs)
//   rds    /aws/rds/instance/{id}/postgresql (enabled in RDS Parameter Group)

new LogInsightsStack(app, 'LogInsightsStack-Staging', {
  envName: 'staging',
  appLogGroupName: `/ecs/staging/${ecsStackStaging.service.serviceName}`,
  accessLogGroupName: process.env.STAGING_ACCESS_LOG_GROUP,
  rdsLogGroupName: `/aws/rds/instance/${rdsStackStaging.instance.instanceIdentifier}/postgresql`,
  slowRequestThresholdSeconds: 1.0,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging CloudWatch Logs Insights saved queries for error analysis',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new LogInsightsStack(app, 'LogInsightsStack-Production', {
  envName: 'production',
  appLogGroupName: `/ecs/production/${ecsStackProduction.service.serviceName}`,
  accessLogGroupName: process.env.PRODUCTION_ACCESS_LOG_GROUP,
  rdsLogGroupName: `/aws/rds/instance/${rdsStackProduction.instance.instanceIdentifier}/postgresql`,
  slowRequestThresholdSeconds: 1.0,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production CloudWatch Logs Insights saved queries for error analysis',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Structured log pipeline with PII scrubbing ────────────────────────────────
// Application logs leave CloudWatch Logs through a subscription filter, are
// rewritten by a Firehose transform that redacts and tokenises PII, and land in
// S3 as line-delimited JSON. The transit log groups are the short-lived copy;
// the archive is the one that is kept and queried.
//
// The account-wide data protection policy is owned by the production stack
// alone. It is account- and region-scoped, so two stacks declaring one either
// fight over the same name on every deploy or both apply — doubling the audit
// findings and the per-byte cost — and neither failure surfaces as an error.

new LogPipelineStack(app, 'LogPipelineStack-Staging', {
  envName: 'staging',
  sourceLogGroupNames: [`/ecs/staging/${ecsStackStaging.service.serviceName}`],
  // Shorter than production's: staging's archive exists to prove the pipeline
  // works, not to answer a question about last quarter.
  archiveRetentionDays: 90,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging structured log pipeline — PII scrubbed before the archive ingests it',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new LogPipelineStack(app, 'LogPipelineStack-Production', {
  envName: 'production',
  sourceLogGroupNames: [`/ecs/production/${ecsStackProduction.service.serviceName}`],
  manageAccountDataProtectionPolicy: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production structured log pipeline — PII scrubbed before the archive ingests it',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Blue/Green Deployment via CodeDeploy ──────────────────────────────────────
// Separate ECS service (CODE_DEPLOY controller) with two ALB target groups and
// listeners.  Shift traffic gradually with Linear/Canary config; auto-rollback on
// ALB 5xx alarm.  Use workflow-templates/blue-green-deploy.yml in CI/CD.
//
// Outputs after deployment:
//   BlueGreenDeployStack-Staging.CodeDeployApplicationName  → CODEDEPLOY_APP secret
//   BlueGreenDeployStack-Staging.CodeDeployDeploymentGroupName → CODEDEPLOY_DG secret
//   BlueGreenDeployStack-Staging.ClusterName               → ECS_CLUSTER secret
//   BlueGreenDeployStack-Staging.ServiceName               → ECS_SERVICE secret
//
// Port 8443 (test listener) must be opened in your firewall / security group for
// smoke-testing the Green environment before CodeDeploy completes the cutover.

new BlueGreenDeployStack(app, 'BlueGreenDeployStack-Staging', {
  vpc: vpcStackStaging.vpc,
  envName: 'staging',
  certificateArn: stagingCertArn,
  containerImage: process.env.CONTAINER_IMAGE,
  containerPort: 3000,
  cpu: 512,
  memoryLimitMiB: 1024,
  desiredCount: 1,
  deploymentConfigType: 'Linear10Percent1Minute',
  terminationWaitMinutes: 5,
  deploymentApprovalWaitMinutes: 0,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging blue/green ECS service via CodeDeploy (linear traffic shift)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new BlueGreenDeployStack(app, 'BlueGreenDeployStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  certificateArn: productionCertArn,
  containerImage: process.env.CONTAINER_IMAGE,
  containerPort: 3000,
  cpu: 1024,
  memoryLimitMiB: 2048,
  desiredCount: 2,
  deploymentConfigType: 'Canary10Percent5Minutes',
  terminationWaitMinutes: 15,
  deploymentApprovalWaitMinutes: 0,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production blue/green ECS service via CodeDeploy (canary traffic shift)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Canary deployment on weighted ALB target groups ──────────────────────────
// An alternative to the blue/green stacks above, not a companion to them. Both
// own an ALB, an ECS cluster, and the deployment path for the same application,
// so a real deployment picks one. They are both defined here because this is a
// boilerplate: deploy the stacks for the strategy you want and delete the other.
//
//   Blue/green — CodeDeploy shifts on a schedule and reacts to alarms.
//   Canary     — this stack shifts the listener weights itself and compares the
//                canary target group against the stable one at every step.
//
// After CDK deploy, copy the stack outputs into GitHub Secrets / Variables:
//   CANARY_STATE_MACHINE_ARN ← CanaryDeployStack-*.StateMachineArn
//   ECS_CLUSTER              ← CanaryDeployStack-*.ClusterName
//   TASK_DEFINITION          ← CanaryDeployStack-*.TaskDefinitionFamily
//
// Do not run `cdk deploy` on these stacks while a canary execution is in
// flight — the listener weights are runtime state the state machine owns, and
// a deploy resets them to 100/0 underneath it.

new CanaryDeployStack(app, 'CanaryDeployStack-Staging', {
  vpc: vpcStackStaging.vpc,
  envName: 'staging',
  certificateArn: stagingCertArn,
  containerImage: process.env.CONTAINER_IMAGE,
  containerPort: 3000,
  cpu: 512,
  memoryLimitMiB: 1024,
  stableDesiredCount: 1,
  canaryDesiredCount: 1,
  // Two short steps: staging exists to prove the pipeline works, not to
  // accumulate statistical confidence.
  trafficSteps: [25, 50],
  bakeTimeSeconds: 120,
  analysis: {
    maxErrorRatePercent: 2,
    maxLatencyMs: 1500,
    // Staging rarely sees production-shaped traffic, so a window with too few
    // requests promotes rather than blocking every deployment.
    minimumRequestCount: 20,
    inconclusiveVerdict: 'pass',
  },
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging canary ECS deployment on weighted ALB target groups with automatic analysis',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new CanaryDeployStack(app, 'CanaryDeployStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  certificateArn: productionCertArn,
  containerImage: process.env.CONTAINER_IMAGE,
  containerPort: 3000,
  cpu: 1024,
  memoryLimitMiB: 2048,
  stableDesiredCount: 2,
  canaryDesiredCount: 1,
  trafficSteps: [10, 25, 50],
  bakeTimeSeconds: 300,
  analysis: {
    maxErrorRatePercent: 1,
    maxLatencyMs: 1000,
    errorRateToleranceMultiplier: 2,
    latencyToleranceMultiplier: 1.5,
    minimumRequestCount: 100,
    // Production refuses to promote a canary it could not measure.
    inconclusiveVerdict: 'fail',
    latencyStatistic: 'p95',
  },
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production canary ECS deployment on weighted ALB target groups with automatic analysis',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Feature Flags via AWS AppConfig ──────────────────────────────────────────
// Deploys feature flags gradually using a linear traffic-shift strategy so
// any misconfiguration can be caught by CloudWatch alarms and rolled back
// automatically before all users are affected.
//
// After CDK deploy, copy the stack outputs into GitHub Secrets / Variables:
//   APP_ID       ← AppConfigStack.ApplicationId
//   PROFILE_ID   ← AppConfigStack.ConfigProfileId
//   PROD_ENV_ID  ← AppConfigStack.EnvIdProduction
//   STG_ENV_ID   ← AppConfigStack.EnvIdStaging
//
// Then call workflow-templates/deploy-feature-flags.yml from your CI pipeline:
//   jobs:
//     deploy-flags:
//       uses: Kojo-Brown/boilerplate-devops/.github/workflows/deploy-feature-flags.yml@main
//       with:
//         config-file: aws/appconfig/feature-flags.json
//         app-id: ${{ vars.APP_ID }}
//         profile-id: ${{ vars.PROFILE_ID }}
//         env-id: ${{ vars.PROD_ENV_ID }}
//       secrets:
//         AWS_ROLE_ARN: ${{ secrets.APPCONFIG_DEPLOY_ROLE_ARN }}
//
// ECS task runtime reads:
//   Attach AppConfigReadPolicyArn to the ECS task role, then call:
//     StartConfigurationSession → GetLatestConfiguration (poll every 30–60 s)

const appConfigStack = new AppConfigStack(app, 'AppConfigStack', {
  appName: 'boilerplate',
  deploymentGrowthFactor: 10,
  deploymentDurationMinutes: 10,
  finalBakeTimeMinutes: 5,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'AppConfig feature flags — gradual rollout with auto-rollback on alarm',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Feature Flag Lifecycle ────────────────────────────────────────────────────
// The half of the lifecycle that runs after the merge. AppConfigStack ships
// flags; this stack reads back what is actually deployed, once a day, and
// reports the ones that are past their declared removal date, finished rolling
// out, or were never turned on at all — as CloudWatch metrics, an SNS summary,
// and a GitHub issue in the owning team's backlog.
//
// It never deletes a flag. Removing the configuration before the code that
// reads it leaves running processes resolving the key to undefined, which is
// falsy, which takes the branch the rollout was moving away from. See
// docs/feature-flags.md.
//
// `githubTokenSecretArn` is optional: without it the sweep still measures and
// notifies, it just cannot turn a measurement into somebody's work.
new FeatureFlagLifecycleStack(app, 'FeatureFlagLifecycleStack', {
  application: appConfigStack.application,
  configurationProfileId: appConfigStack.featureFlagsConfig.configurationProfileId,
  environments: Object.entries(appConfigStack.environments).map(([name, environment]) => ({
    name,
    environmentId: environment.environmentId,
  })),
  repository: 'YOUR_ORG/YOUR_REPO',
  githubTokenSecretArn: process.env.FLAG_SWEEP_GITHUB_TOKEN_SECRET_ARN,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Daily sweep for expired, finished, and abandoned feature flags',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Database Migration Safety ─────────────────────────────────────────────────
// Provisions the CodeDeploy BeforeAllowTraffic lifecycle hook Lambda and the
// migration ECS task definition.  The Lambda runs the migration task and only
// reports Succeeded once it exits 0; CodeDeploy shifts traffic from Blue → Green
// only after receiving Succeeded.  If the migration fails, CodeDeploy rolls back.
//
// After deploying this stack:
//   1. Register MigrationHookLambdaArn as the BeforeAllowTraffic hook in the
//      CodeDeploy deployment group (BlueGreenDeployStack):
//
//        aws deploy update-deployment-group \
//          --application-name <CodeDeployApplicationName> \
//          --current-deployment-group-name <DeploymentGroupName> \
//          # ... existing params ... \
//          # In Console: Deployment Group → Edit → Lifecycle event hooks → BeforeAllowTraffic
//
//   2. Alternatively, use workflow-templates/db-migration-deploy.yml as a
//      GitHub Actions job that runs BEFORE blue-green-deploy.yml:
//
//        jobs:
//          migrate:
//            uses: ./.github/workflows/db-migration-deploy.yml
//            with:
//              cluster: <MigrationClusterName>
//              task-definition: <task-definition-family>
//              subnets: <private-subnet-ids>
//              security-groups: <MigrationSecurityGroupId>
//            secrets:
//              AWS_ROLE_ARN: ${{ secrets.DEPLOY_ROLE_ARN }}
//          deploy:
//            needs: migrate
//            uses: ./.github/workflows/blue-green-deploy.yml
//            ...
//
// Replace MIGRATION_IMAGE_URI with your actual ECR migration image URI.
// The image must run the migration on startup (e.g. `npm run migrate`, `alembic upgrade head`).
//
// Pass it **by digest**, not by tag. The placeholder below is a digest of all
// zeroes so that it is obviously fake and so that copying its shape produces a
// correct reference. `docker-build-push.yml` already outputs the digest the
// push returned; `db-migration-deploy.yml` is what forwards it here. A tag is
// resolved once per task placement rather than once per deployment, so a
// retried migration task can pull a different image from the one the pipeline
// verified — and the `image-not-digest-pinned` policy in policy/cloudformation
// fails the build on one.

new DbMigrationStack(app, 'DbMigrationStack-Staging', {
  vpc: vpcStackStaging.vpc,
  envName: 'staging',
  migrationImageUri:
    process.env.MIGRATION_IMAGE_URI ??
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/app@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  dbSecretArn: rdsStackStaging.secret.secretArn,
  dbSecurityGroup: rdsStackStaging.securityGroup,
  migrationCommand: ['npm', 'run', 'migrate'],
  cpu: 256,
  memoryLimitMiB: 512,
  migrationTimeoutMinutes: 14,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging DB migration — BeforeAllowTraffic hook + ECS task definition',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Rollback Automation ───────────────────────────────────────────────────────
// Watches CloudWatch alarms via EventBridge and automatically rolls back ECS
// services when any monitored alarm enters ALARM state.
//
// How it works:
//   CloudWatch Alarm → ALARM
//     → EventBridge rule (alarm-state-change)
//       → Lambda
//           ├─ Rolling ECS: UpdateService(previousTaskDefRevision)
//           ├─ CodeDeploy ECS: StopDeployment (CodeDeploy autoRollback restores Blue)
//           └─ SNS notification email / PagerDuty
//
// After deployment:
//   - Confirm the SNS email subscription sent to each notificationEmail address.
//   - Export RollbackAutomationStack-Staging.RollbackLambdaArn to your ops runbook.
//   - For additional alarm coverage, add alarm ARNs from CloudWatchAlarmsStack outputs
//     to the triggerAlarmArns array and redeploy.

const stagingAlarmsAlb5xxArn = `arn:aws:cloudwatch:${process.env.CDK_DEFAULT_REGION ?? 'us-east-1'}:${process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012'}:alarm:staging-alb-5xx-elb`;
const stagingAlarmsEcsCpuArn = `arn:aws:cloudwatch:${process.env.CDK_DEFAULT_REGION ?? 'us-east-1'}:${process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012'}:alarm:staging-ecs-cpu-high`;

new RollbackAutomationStack(app, 'RollbackAutomationStack-Staging', {
  envName: 'staging',
  triggerAlarmArns: [stagingAlarmsAlb5xxArn, stagingAlarmsEcsCpuArn],
  rollbackTargets: [
    // Rolling ECS service (EcsStack)
    {
      clusterName: ecsStackStaging.cluster.clusterName,
      serviceName: ecsStackStaging.service.serviceName,
    },
    // Blue/green ECS service (BlueGreenDeployStack) — CodeDeploy mode
    {
      clusterName: `staging-bg-cluster`,
      serviceName: `staging-bg-service`,
      codeDeployApplication: `staging-ecs-app`,
      codeDeployDeploymentGroup: `staging-ecs-dg`,
    },
  ],
  notificationEmails: process.env.STAGING_ROLLBACK_NOTIFY_EMAIL
    ? [process.env.STAGING_ROLLBACK_NOTIFY_EMAIL]
    : [],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging rollback automation — EventBridge alarm → Lambda → ECS/CodeDeploy rollback',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

const productionAlarmsAlb5xxArn = `arn:aws:cloudwatch:${process.env.CDK_DEFAULT_REGION ?? 'us-east-1'}:${process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012'}:alarm:production-alb-5xx-elb`;
const productionAlarmsEcsCpuArn = `arn:aws:cloudwatch:${process.env.CDK_DEFAULT_REGION ?? 'us-east-1'}:${process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012'}:alarm:production-ecs-cpu-high`;

new RollbackAutomationStack(app, 'RollbackAutomationStack-Production', {
  envName: 'production',
  triggerAlarmArns: [productionAlarmsAlb5xxArn, productionAlarmsEcsCpuArn],
  rollbackTargets: [
    // Rolling ECS service (EcsStack)
    {
      clusterName: ecsStackProduction.cluster.clusterName,
      serviceName: ecsStackProduction.service.serviceName,
    },
    // Blue/green ECS service (BlueGreenDeployStack) — CodeDeploy mode
    {
      clusterName: `production-bg-cluster`,
      serviceName: `production-bg-service`,
      codeDeployApplication: `production-ecs-app`,
      codeDeployDeploymentGroup: `production-ecs-dg`,
    },
  ],
  notificationEmails: process.env.PRODUCTION_ROLLBACK_NOTIFY_EMAIL
    ? [process.env.PRODUCTION_ROLLBACK_NOTIFY_EMAIL]
    : [],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production rollback automation — EventBridge alarm → Lambda → ECS/CodeDeploy rollback',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Service Level Objectives ──────────────────────────────────────────────────
// The objectives themselves live in `lib/slo-definitions.ts`, as data with no
// CDK tokens in it — which is what makes them reviewable in a diff and readable
// by `npm run audit:slo`. Everything here only supplies the metrics that measure
// them in this account, and the two stacks below take their numbers from the
// same entries rather than restating them.
//
// `SloStack` builds three signals per objective, because each is blind to what
// the others see: multi-window burn-rate alarms (fast, and structurally unable
// to see slow drift), an error-budget reporter republishing the 30-day window as
// a metric an alarm *can* evaluate — a CloudWatch alarm period stops at 24 hours
// — and a no-data alarm, because every other signal here degrades quietly to
// green when the SLI stops arriving.
//
// After deployment:
//   - Confirm the SNS email subscriptions on `<env>-slo-page` and
//     `<env>-slo-ticket`, and point the paging topic at the rota rather than at a
//     mailbox nobody reads at 04:00.
//   - Watch the `production-slo` dashboard for a week before trusting the budget
//     number. `minimumEventsPerMinute` in the catalogue is the setting most
//     likely to need tuning to real traffic, and it is what decides whether a
//     quiet hour reads as zero burn or as an incident.
//   - `production-api-latency` is `proposed` and deliberately not wired: ALB
//     publishes no count of requests under a latency threshold. docs/slo.md §5
//     has the EMF contract the application has to emit before it can be made
//     active.

const stagingAvailabilitySlo = requireSlo('staging-api-availability');
const productionAvailabilitySlo = requireSlo('production-api-availability');

new SloStack(app, 'SloStack-Staging', {
  envName: 'staging',
  slos: [
    {
      sloId: 'staging-api-availability',
      source: {
        kind: 'alb',
        loadBalancerFullName: ecsStackStaging.alb.loadBalancerFullName,
        targetGroupFullName: ecsStackStaging.targetGroup.targetGroupFullName,
      },
    },
  ],
  // Staging evaluates the same policies as production and wakes nobody, so a
  // change to them is exercised before it reaches the rota.
  downgradePagesToTickets: true,
  ticketEmails: process.env.STAGING_SLO_NOTIFY_EMAIL
    ? [process.env.STAGING_SLO_NOTIFY_EMAIL]
    : [],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging SLOs — burn-rate alarms, error-budget reporting, and a dashboard',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new SloStack(app, 'SloStack-Production', {
  envName: 'production',
  slos: [
    {
      sloId: 'production-api-availability',
      source: {
        kind: 'alb',
        loadBalancerFullName: ecsStackProduction.alb.loadBalancerFullName,
        targetGroupFullName: ecsStackProduction.targetGroup.targetGroupFullName,
      },
    },
  ],
  pageEmails: process.env.PRODUCTION_SLO_PAGE_EMAIL
    ? [process.env.PRODUCTION_SLO_PAGE_EMAIL]
    : [],
  ticketEmails: process.env.PRODUCTION_SLO_TICKET_EMAIL
    ? [process.env.PRODUCTION_SLO_TICKET_EMAIL]
    : [],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production SLOs — burn-rate alarms, error-budget reporting, and a dashboard',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── SLO Burn-Rate Rollback ────────────────────────────────────────────────────
// The companion to RollbackAutomationStack above, not a replacement for it.
// That stack answers "is a threshold crossed right now"; this one answers "is
// this deployment costing more reliability than the objective can afford".
//
// How it works:
//   ALB metrics → burn rate (errors / requests / error budget)
//     → long-window alarm AND short-window alarm → composite alarm
//       → EventBridge → Lambda
//           ├─ re-reads the burn and the remaining budget
//           ├─ rolls back only services that deployed recently
//           └─ SNS notification with the numbers behind the decision
//
// Staging runs a looser objective (99.5%) than production (99.9%) deliberately:
// a boilerplate that pages on staging noise gets its alarms muted, and a muted
// alarm is worse than no alarm.
//
// After deployment:
//   - Confirm the SNS email subscription sent to each notificationEmail address.
//   - Feed SloBurnRateRollbackStack-Production.CompositeAlarmNames into the
//     CodeDeploy deployment group's alarm configuration so a burn-rate breach
//     also aborts an in-flight blue/green shift.
//   - Watch the `production-slo-burn-rate` dashboard for a week before letting
//     the fast policy roll back unattended; the traffic floor is the setting
//     most likely to need tuning to your request volume.

new SloBurnRateRollbackStack(app, 'SloBurnRateRollbackStack-Staging', {
  envName: 'staging',
  loadBalancerFullName: ecsStackStaging.alb.loadBalancerFullName,
  targetGroupFullName: ecsStackStaging.targetGroup.targetGroupFullName,
  slo: {
    target: stagingAvailabilitySlo.objective,
    windowDays: stagingAvailabilitySlo.windowDays,
    // The conservative floor, not the SLI's own: this stack mutates production
    // traffic, and `significanceFloorEvents` is the count at which a single
    // failed request cannot cross the tightest policy on its own. See
    // docs/slo.md §6.
    minimumRequestsPerWindow: significanceFloorEvents(stagingAvailabilitySlo),
  },
  rollbackTargets: [
    {
      clusterName: ecsStackStaging.cluster.clusterName,
      serviceName: ecsStackStaging.service.serviceName,
    },
  ],
  notificationEmails: process.env.STAGING_ROLLBACK_NOTIFY_EMAIL
    ? [process.env.STAGING_ROLLBACK_NOTIFY_EMAIL]
    : [],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging SLO burn-rate rollback — multi-window burn alarms → Lambda → ECS rollback',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new SloBurnRateRollbackStack(app, 'SloBurnRateRollbackStack-Production', {
  envName: 'production',
  loadBalancerFullName: ecsStackProduction.alb.loadBalancerFullName,
  targetGroupFullName: ecsStackProduction.targetGroup.targetGroupFullName,
  slo: {
    target: productionAvailabilitySlo.objective,
    windowDays: productionAvailabilitySlo.windowDays,
    minimumRequestsPerWindow: significanceFloorEvents(productionAvailabilitySlo),
  },
  rollbackTargets: [
    {
      clusterName: ecsStackProduction.cluster.clusterName,
      serviceName: ecsStackProduction.service.serviceName,
    },
    // Blue/green ECS service (BlueGreenDeployStack) — CodeDeploy mode
    {
      clusterName: `production-bg-cluster`,
      serviceName: `production-bg-service`,
      codeDeployApplication: `production-ecs-app`,
      codeDeployDeploymentGroup: `production-ecs-dg`,
    },
  ],
  notificationEmails: process.env.PRODUCTION_ROLLBACK_NOTIFY_EMAIL
    ? [process.env.PRODUCTION_ROLLBACK_NOTIFY_EMAIL]
    : [],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description:
    'Production SLO burn-rate rollback — multi-window burn alarms → Lambda → ECS/CodeDeploy rollback',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new DbMigrationStack(app, 'DbMigrationStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  migrationImageUri:
    process.env.MIGRATION_IMAGE_URI ??
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/app@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  dbSecretArn: rdsStackProduction.secret.secretArn,
  dbSecurityGroup: rdsStackProduction.securityGroup,
  migrationCommand: ['npm', 'run', 'migrate'],
  cpu: 256,
  memoryLimitMiB: 512,
  migrationTimeoutMinutes: 14,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production DB migration — BeforeAllowTraffic hook + ECS task definition',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Cost Anomaly Detection + Budget Alerts ────────────────────────────────────
// Cost Anomaly Detection is account-wide; deploy in us-east-1.
// Set a monthly budget and get alerted when actual or forecasted spend crosses
// the threshold, or when an AI-detected spending anomaly exceeds a dollar amount.
//
// After deployment:
//   - Confirm the SNS email subscription sent to each notificationEmail address.
//   - Export CostAnomalyStack-Staging.CostAlertTopicArn to your ops runbook.
//   - Subscribe additional endpoints (Slack, PagerDuty) to the SNS topic.
//
// Usage:
//   STAGING_NOTIFY_EMAIL=ops@example.com  cdk deploy CostAnomalyStack-Staging
//   PRODUCTION_NOTIFY_EMAIL=cto@example.com  cdk deploy CostAnomalyStack-Production

const stagingNotifyEmails = process.env.STAGING_NOTIFY_EMAIL
  ? [process.env.STAGING_NOTIFY_EMAIL]
  : [];

const productionNotifyEmails = process.env.PRODUCTION_NOTIFY_EMAIL
  ? [process.env.PRODUCTION_NOTIFY_EMAIL]
  : [];

new CostAnomalyStack(app, 'CostAnomalyStack-Staging', {
  envName: 'staging',
  monthlyBudgetUsd: 500,
  actualThresholdPercent: 80,
  forecastedThresholdPercent: 100,
  anomalyThresholdUsd: 50,
  anomalyFrequency: 'DAILY',
  notificationEmails: stagingNotifyEmails,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Staging cost anomaly detection + $500/month budget alerts',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── GuardDuty + Security Hub ──────────────────────────────────────────────────
// Enables threat detection (GuardDuty) and security posture management (Security Hub)
// with FSBP and CIS Benchmark standards.  Deploy once per region.
//
// Only one GuardDuty detector can exist per account per region — if you already
// have a detector, set enableGuardDuty: false and import the existing detector.
//
// After deployment:
//   - Confirm SNS email subscriptions (sent to each notificationEmail).
//   - Wire SecurityFindingsTopicArn to your incident response runbook / PagerDuty.
//   - Export GuardDutyDetectorId for reference in ops playbooks.
//
// Usage:
//   STAGING_SECURITY_EMAIL=sec@example.com  cdk deploy SecurityHubStack-Staging
//   PRODUCTION_SECURITY_EMAIL=ciso@example.com  cdk deploy SecurityHubStack-Production

const stagingSecurityEmails = process.env.STAGING_SECURITY_EMAIL
  ? [process.env.STAGING_SECURITY_EMAIL]
  : [];

const productionSecurityEmails = process.env.PRODUCTION_SECURITY_EMAIL
  ? [process.env.PRODUCTION_SECURITY_EMAIL]
  : [];

new SecurityHubStack(app, 'SecurityHubStack-Staging', {
  envName: 'staging',
  enableGuardDuty: true,
  enableGuardDutyS3Logs: true,
  enableFsbpStandard: true,
  enableCisStandard: true,
  enablePciStandard: false,
  findingAlertSeverity: 'HIGH',
  notificationEmails: stagingSecurityEmails,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging GuardDuty + Security Hub baseline (FSBP + CIS), HIGH+ alerts',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new SecurityHubStack(app, 'SecurityHubStack-Production', {
  envName: 'production',
  enableGuardDuty: true,
  enableGuardDutyS3Logs: true,
  enableFsbpStandard: true,
  enableCisStandard: true,
  enablePciStandard: false,
  findingAlertSeverity: 'HIGH',
  guardDutyPublishingFrequency: 'ONE_HOUR',
  notificationEmails: productionSecurityEmails,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production GuardDuty + Security Hub baseline (FSBP + CIS), HIGH+ alerts, 1-hour publishing',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new CostAnomalyStack(app, 'CostAnomalyStack-Production', {
  envName: 'production',
  monthlyBudgetUsd: 2000,
  actualThresholdPercent: 80,
  forecastedThresholdPercent: 100,
  anomalyThresholdUsd: 100,
  anomalyFrequency: 'IMMEDIATE',
  notificationEmails: productionNotifyEmails,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Production cost anomaly detection + $2000/month budget alerts (immediate notifications)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── WAF: OWASP Top 10 Rules ───────────────────────────────────────────────────
// Attaches a WAFv2 Web ACL containing AWS managed rule groups that collectively
// cover the OWASP Top 10:
//   A1  Injection           — AWSManagedRulesCommonRuleSet + AWSManagedRulesSQLiRuleSet
//   A2  Broken Auth         — rate-based rule (per-IP, 2,000 req/5 min)
//   A3  Sensitive Exposure  — AWSManagedRulesLinuxRuleSet (path traversal)
//   A5  Broken Access Ctrl  — AWSManagedRulesAdminProtectionRuleSet
//   A6  Security Misconfig  — AWSManagedRulesKnownBadInputsRuleSet (log4j, SSRF)
//   A7  XSS                 — AWSManagedRulesCommonRuleSet
//   A8  Insecure Deserial.  — AWSManagedRulesKnownBadInputsRuleSet
//  Reputation               — AWSManagedRulesAmazonIpReputationList
//
// REGIONAL scope covers ALB and API Gateway.  To protect a CloudFront distribution:
//   - Set scope: 'CLOUDFRONT' and deploy the stack to us-east-1.
//   - Set associatedResourceArn to the CloudFront distribution ARN.
//
// To associate with an ALB set associatedResourceArn to the ALB's ARN after
// the ECS stack has deployed.
//
// Usage:
//   STAGING_WAF_EMAIL=sec@example.com  cdk deploy WafStack-Staging
//   PRODUCTION_WAF_EMAIL=ciso@example.com  cdk deploy WafStack-Production
//
// To evaluate rules before enforcing them, override individual rules to COUNT:
//   coreRuleSetOverrides: [{ ruleName: 'SizeRestrictions_BODY', action: 'COUNT' }]

const stagingWafEmails = process.env.STAGING_WAF_EMAIL ? [process.env.STAGING_WAF_EMAIL] : [];
const productionWafEmails = process.env.PRODUCTION_WAF_EMAIL
  ? [process.env.PRODUCTION_WAF_EMAIL]
  : [];

new WafStack(app, 'WafStack-Staging', {
  envName: 'staging',
  scope: 'REGIONAL',
  enableCoreRuleSet: true,
  enableKnownBadInputs: true,
  enableSqlDatabase: true,
  enableLinuxRuleSet: true,
  enablePhpRuleSet: true,
  enableAdminProtection: true,
  enableAmazonIpReputation: true,
  enableAnonymousIpList: false,
  rateLimitPerIp: 2000,
  blockedRequestsAlarmThreshold: 100,
  notificationEmails: stagingWafEmails,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging WAFv2 Web ACL — OWASP Top 10 managed rule groups on ALB',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new WafStack(app, 'WafStack-Production', {
  envName: 'production',
  scope: 'REGIONAL',
  enableCoreRuleSet: true,
  enableKnownBadInputs: true,
  enableSqlDatabase: true,
  enableLinuxRuleSet: true,
  enablePhpRuleSet: true,
  enableAdminProtection: true,
  enableAmazonIpReputation: true,
  enableAnonymousIpList: true,
  rateLimitPerIp: 2000,
  blockedRequestsAlarmThreshold: 100,
  notificationEmails: productionWafEmails,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production WAFv2 Web ACL — OWASP Top 10 + Anonymous IP managed rule groups on ALB',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── S3 Static Site + CloudFront + Route 53 ───────────────────────────────────
// Hosts a static web application (React, Vue, Next.js static export, etc.) on
// S3 behind a CloudFront distribution with HTTPS and optional Route 53 DNS.
//
// Architecture:
//   Browser → CloudFront (HTTPS, OAC, gzip/brotli) → S3 bucket (private)
//
// Deployment workflow:
//   Use workflow-templates/deploy-static-site.yml to build and sync your app:
//
//   jobs:
//     deploy:
//       uses: Kojo-Brown/boilerplate-devops/.github/workflows/deploy-static-site.yml@main
//       with:
//         environment: staging
//         build-command: pnpm build
//         build-output-dir: dist
//         s3-bucket: ${{ vars.STAGING_S3_BUCKET_NAME }}       # StaticSiteStack output
//         cloudfront-dist-id: ${{ vars.STAGING_CF_DIST_ID }} # StaticSiteStack output
//       secrets:
//         aws-role-arn: ${{ secrets.STAGING_STATIC_SITE_ROLE_ARN }}
//
// Custom domain (optional):
//   1. Create an ACM certificate in us-east-1 for your domain.
//   2. Set domainName + certificateArn below.
//   3. Set hostedZoneId (preferred) or hostedZoneName for Route 53 auto-wiring.
//   4. After deploy, verify A/AAAA records point at the CloudFront distribution.
//
// Stack must be deployed to us-east-1 (CloudFront ACM certificate requirement).
//
// Outputs to capture in GitHub Secrets / Variables:
//   STAGING_S3_BUCKET_NAME   ← StaticSiteStack-Staging.SiteBucketName
//   STAGING_CF_DIST_ID       ← StaticSiteStack-Staging.DistributionId
//   PRODUCTION_S3_BUCKET_NAME ← StaticSiteStack-Production.SiteBucketName
//   PRODUCTION_CF_DIST_ID     ← StaticSiteStack-Production.DistributionId

const stagingStaticSiteCertArn =
  (app.node.tryGetContext('stagingStaticSiteCertificateArn') as string | undefined) ??
  process.env.STAGING_STATIC_SITE_CERTIFICATE_ARN;

const productionStaticSiteCertArn =
  (app.node.tryGetContext('productionStaticSiteCertificateArn') as string | undefined) ??
  process.env.PRODUCTION_STATIC_SITE_CERTIFICATE_ARN;

const stagingStaticSiteDomain =
  (app.node.tryGetContext('stagingStaticSiteDomain') as string | undefined) ??
  process.env.STAGING_STATIC_SITE_DOMAIN;

const productionStaticSiteDomain =
  (app.node.tryGetContext('productionStaticSiteDomain') as string | undefined) ??
  process.env.PRODUCTION_STATIC_SITE_DOMAIN;

const stagingHostedZoneId =
  (app.node.tryGetContext('stagingHostedZoneId') as string | undefined) ??
  process.env.STAGING_HOSTED_ZONE_ID;

const productionHostedZoneId =
  (app.node.tryGetContext('productionHostedZoneId') as string | undefined) ??
  process.env.PRODUCTION_HOSTED_ZONE_ID;

const stagingHostedZoneName =
  (app.node.tryGetContext('stagingHostedZoneName') as string | undefined) ??
  process.env.STAGING_HOSTED_ZONE_NAME;

const productionHostedZoneName =
  (app.node.tryGetContext('productionHostedZoneName') as string | undefined) ??
  process.env.PRODUCTION_HOSTED_ZONE_NAME;

new StaticSiteStack(app, 'StaticSiteStack-Staging', {
  envName: 'staging',
  domainName: stagingStaticSiteDomain,
  certificateArn: stagingStaticSiteCertArn,
  hostedZoneId: stagingHostedZoneId,
  hostedZoneName: stagingHostedZoneName,
  spaMode: true,
  enableVersioning: true,
  noncurrentVersionsToKeep: 5,
  enableAccessLogging: false,
  priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1', // CloudFront stacks must be in us-east-1
  },
  description: 'Staging S3 static site + CloudFront + Route 53 (SPA mode, US/EU edge)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new StaticSiteStack(app, 'StaticSiteStack-Production', {
  envName: 'production',
  domainName: productionStaticSiteDomain,
  certificateArn: productionStaticSiteCertArn,
  hostedZoneId: productionHostedZoneId,
  hostedZoneName: productionHostedZoneName,
  spaMode: true,
  enableVersioning: true,
  noncurrentVersionsToKeep: 10,
  enableAccessLogging: true,
  priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1', // CloudFront stacks must be in us-east-1
  },
  description: 'Production S3 static site + CloudFront + Route 53 (SPA mode, global edge, access logging)',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Preview environments (one per open pull request) ──────────────────────────
// `PreviewEnvironmentStack` is the shared half — ALB, cluster, database, reaper —
// and is deployed once. `PreviewPrStack` is the per-pull-request half and is
// deployed and destroyed by `.github/workflows/preview-environment.yml`.
//
// The pull request number comes from context so CI can synthesise a real one:
//   cdk deploy preview-pr-123 --context previewPrNumber=123 \
//     --context previewImageUri=<account>.dkr.ecr.<region>.amazonaws.com/app:sha-abc123
//
// The default of 1 exists so `cdk synth` with no context still produces a
// per-PR template for Checkov to scan. Previews share the staging VPC: a
// preview is a staging-grade workload and a VPC of its own would add a NAT
// gateway's standing cost to a system whose whole point is being cheap.
//
// See docs/preview-environments.md.
const previewCertArn =
  (app.node.tryGetContext('previewCertificateArn') as string | undefined) ??
  process.env.PREVIEW_ACM_CERTIFICATE_ARN ??
  'arn:aws:acm:REGION:ACCOUNT:certificate/REPLACE-ME-PREVIEW-WILDCARD';

const previewDomain =
  (app.node.tryGetContext('previewDomain') as string | undefined) ??
  process.env.PREVIEW_DOMAIN ??
  'preview.example.com';

const previewRepository =
  (app.node.tryGetContext('previewRepository') as string | undefined) ??
  process.env.PREVIEW_REPOSITORY ??
  'YOUR_ORG/YOUR_REPO';

// Omit to run the reaper on age alone; see docs/preview-environments.md for the
// difference that makes.
const previewGitHubTokenSecretArn =
  (app.node.tryGetContext('previewGitHubTokenSecretArn') as string | undefined) ??
  process.env.PREVIEW_GITHUB_TOKEN_SECRET_ARN;

const previewEnvironmentStack = new PreviewEnvironmentStack(app, 'PreviewEnvironmentStack', {
  stackName: 'preview-shared',
  vpc: vpcStackStaging.vpc,
  certificateArn: previewCertArn,
  previewDomain,
  repository: previewRepository,
  githubTokenSecretArn: previewGitHubTokenSecretArn,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Shared preview infrastructure: ALB, ECS cluster, Postgres, and the reaper',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

const previewPrNumber = Number(
  (app.node.tryGetContext('previewPrNumber') as string | number | undefined) ??
    process.env.PREVIEW_PR_NUMBER ??
    1,
);

const previewImageUri =
  (app.node.tryGetContext('previewImageUri') as string | undefined) ??
  process.env.PREVIEW_IMAGE_URI ??
  NGINX_PLACEHOLDER_IMAGE.reference;

new PreviewPrStack(app, `PreviewPrStack-${previewPrNumber}`, {
  prNumber: previewPrNumber,
  repository: previewRepository,
  imageUri: previewImageUri,
  vpc: vpcStackStaging.vpc,
  cluster: previewEnvironmentStack.cluster,
  httpsListener: previewEnvironmentStack.httpsListener,
  taskSecurityGroup: previewEnvironmentStack.taskSecurityGroup,
  logGroup: previewEnvironmentStack.logGroup,
  databaseHost: previewEnvironmentStack.database.instanceEndpoint.hostname,
  databasePort: cdk.Token.asString(previewEnvironmentStack.database.instanceEndpoint.port),
  databaseSecret: previewEnvironmentStack.databaseSecret,
  previewDomain: previewEnvironmentStack.previewDomain,
  envName: previewEnvironmentStack.envName,
  containerPort: previewEnvironmentStack.containerPort,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: `Preview environment for pull request #${previewPrNumber}`,
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── DORA Four Keys ────────────────────────────────────────────────────────────
// Deployment frequency, lead time for changes, change failure rate, and failed
// deployment recovery time — collected from two event streams and dashboarded.
//
// One stack, not one per environment: the four keys are a comparison. Staging
// and production on the same axes is how "we deploy to staging twenty times a
// day and to production twice a month" becomes visible, and that gap is usually
// the finding.
//
// Wiring, in order:
//
//   1. Deploy this stack. It creates the DynamoDB table, both handlers, the
//      EventBridge rules, and the dashboard.
//   2. Grant the deploy pipeline `events:PutEvents` on the default bus (add it
//      to the GitHubOidcStack role, or a dedicated one) and call
//      `workflow-templates/emit-dora-deployment.yml` from every deploy job.
//   3. Put a GitHub token with `contents: read` in Secrets Manager as
//      `{"token": "..."}` and set DORA_GITHUB_TOKEN_SECRET_ARN. Without it the
//      other three keys still work and lead time reports as unmeasurable.
//
// The alarm names below must match CloudWatchAlarmsStack's, which builds them
// as `{envName}-{metricId}`. They are declared with their service rather than
// parsed, because "production-alb-5xx-elb" parses to a service called "alb"
// that no deployment ever writes — see docs/dora-metrics.md.

new DoraMetricsStack(app, 'DoraMetricsStack', {
  services: [
    { environment: 'staging', service: 'api' },
    { environment: 'production', service: 'api' },
  ],
  incidentAlarms: [
    { alarmName: 'staging-alb-5xx-elb', environment: 'staging', service: 'api' },
    { alarmName: 'staging-alb-5xx-target', environment: 'staging', service: 'api' },
    { alarmName: 'staging-ecs-cpu-high', environment: 'staging', service: 'api' },
    { alarmName: 'production-alb-5xx-elb', environment: 'production', service: 'api' },
    { alarmName: 'production-alb-5xx-target', environment: 'production', service: 'api' },
    { alarmName: 'production-ecs-cpu-high', environment: 'production', service: 'api' },
  ],
  repository: 'YOUR_ORG/YOUR_REPO',
  githubTokenSecretArn: process.env.DORA_GITHUB_TOKEN_SECRET_ARN,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'DORA four keys — deployment and incident collection, rates, and dashboard',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── EKS (Kubernetes track) ────────────────────────────────────────────────────
// Both clusters keep the API server endpoint private, so `kubectl` reaches them
// from inside the VPC — a bastion, a VPN, or an SSM port-forward. To expose the
// endpoint to an office or VPN range instead, pass the CIDRs:
//
//   cdk deploy --context stagingEksPublicAccessCidrs=203.0.113.0/24,198.51.100.7/32
//   STAGING_EKS_PUBLIC_ACCESS_CIDRS=203.0.113.0/24 cdk deploy
//
// An open CIDR is rejected by the stack rather than silently deployed.
//
// Cluster administrators are granted through EKS access entries, so the roles
// that operate the cluster are named here rather than edited into aws-auth by
// hand after the fact:
//
//   cdk deploy --context productionEksAdminRoleArns=arn:aws:iam::<account>:role/PlatformAdmin
const parseList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const stagingEksPublicAccessCidrs = parseList(
  (app.node.tryGetContext('stagingEksPublicAccessCidrs') as string | undefined) ??
    process.env.STAGING_EKS_PUBLIC_ACCESS_CIDRS,
);

const productionEksPublicAccessCidrs = parseList(
  (app.node.tryGetContext('productionEksPublicAccessCidrs') as string | undefined) ??
    process.env.PRODUCTION_EKS_PUBLIC_ACCESS_CIDRS,
);

const stagingEksAdminRoleArns = parseList(
  (app.node.tryGetContext('stagingEksAdminRoleArns') as string | undefined) ??
    process.env.STAGING_EKS_ADMIN_ROLE_ARNS,
);

const productionEksAdminRoleArns = parseList(
  (app.node.tryGetContext('productionEksAdminRoleArns') as string | undefined) ??
    process.env.PRODUCTION_EKS_ADMIN_ROLE_ARNS,
);

// Route 53 access for external-dns and cert-manager, which publish the record
// and issue the certificate behind the Ingress in `k8s/charts/app`:
//
//   cdk deploy --context stagingEksHostedZoneIds=Z0123456789ABCDEFGHIJ
//   PRODUCTION_EKS_HOSTED_ZONE_IDS=Z0123456789ABCDEFGHIJ cdk deploy
//
// Left unset, neither role is created — and that is the default rather than a
// placeholder zone, because an IAM policy naming a zone that is not yours grants
// nothing and fails as an access denied against a zone the reader has never
// seen. The Argo CD Applications annotate their service accounts with
// `<environment>-external-dns` and `<environment>-cert-manager`, which are the
// role names `EksStack` creates here. See docs/ingress.md §2.
const stagingEksHostedZoneIds = parseList(
  (app.node.tryGetContext('stagingEksHostedZoneIds') as string | undefined) ??
    process.env.STAGING_EKS_HOSTED_ZONE_IDS,
);

const productionEksHostedZoneIds = parseList(
  (app.node.tryGetContext('productionEksHostedZoneIds') as string | undefined) ??
    process.env.PRODUCTION_EKS_HOSTED_ZONE_IDS,
);

new EksStack(app, 'EksStack-Staging', {
  vpc: vpcStackStaging.vpc,
  envName: 'staging',
  publicApiAccessCidrs: stagingEksPublicAccessCidrs,
  clusterAdminRoleArns: stagingEksAdminRoleArns,
  dns:
    stagingEksHostedZoneIds.length > 0 ? { hostedZoneIds: stagingEksHostedZoneIds } : undefined,
  systemNodeGroup: {
    instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE)],
    minSize: 2,
    maxSize: 4,
    diskSizeGiB: 30,
  },
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging EKS cluster — managed node group + IRSA',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new EksStack(app, 'EksStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  publicApiAccessCidrs: productionEksPublicAccessCidrs,
  clusterAdminRoleArns: productionEksAdminRoleArns,
  dns:
    productionEksHostedZoneIds.length > 0
      ? { hostedZoneIds: productionEksHostedZoneIds }
      : undefined,
  systemNodeGroup: {
    instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.M6I, ec2.InstanceSize.LARGE)],
    minSize: 3,
    maxSize: 9,
    diskSizeGiB: 50,
  },
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production EKS cluster — managed node group + IRSA',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── OpenTelemetry Collector with tail-based sampling ──────────────────────────
// A tail-sampling collector tier per environment, plus the agent sidecar an
// application task adds to feed it. Head sampling — which is what the SDKs and
// `XRayStack`'s sampling rule do — decides at the root span, before the request
// has failed or been slow; tail sampling decides once the trace is complete, at
// the cost of a hard constraint: every span of a trace must reach the same
// collector instance. That is what the two tiers are for, and it is why the
// sampler tier deliberately does not auto-scale. See docs/otel-collector.md.
//
// `clientSecurityGroups` is the one required wiring: the sampler's OTLP port is
// unauthenticated, so it admits the application task security group and nothing
// else. Adding the sidecar to an application task is a separate, explicit step:
//
//   const agent = OtelCollectorStack.addAgentSidecar(
//     taskDefinition,
//     otelCollectorStaging.agentSidecarOptions,
//   );
//   appContainer.addContainerDependencies({
//     container: agent,
//     condition: ecs.ContainerDependencyCondition.HEALTHY,
//   });
//
// and the application container needs OtelCollectorStack.appEnvironment(...),
// whose OTEL_TRACES_SAMPLER=parentbased_always_on is what stops the SDK
// discarding 95% of the traces before the collector can judge any of them.
new OtelCollectorStack(app, 'OtelCollectorStack-Staging', {
  vpc: vpcStackStaging.vpc,
  envName: 'staging',
  clientSecurityGroups: [ecsStackStaging.taskSecurityGroup],
  desiredCount: 2,
  // Staging sees a fraction of production's traffic, so a higher baseline is
  // both affordable and more useful: it is the environment where you are
  // looking for a trace you can reproduce rather than one you cannot.
  sampling: {
    ...DEFAULT_TAIL_SAMPLING,
    expectedNewTracesPerSec: 200,
    numTraces: 50_000,
    baselinePercentage: 25,
  },
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging OpenTelemetry collector — agent sidecar + tail-sampling tier',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new OtelCollectorStack(app, 'OtelCollectorStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  clientSecurityGroups: [ecsStackProduction.taskSecurityGroup],
  desiredCount: 3,
  sampling: DEFAULT_TAIL_SAMPLING,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production OpenTelemetry collector — agent sidecar + tail-sampling tier',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

// ── Distributed tracing across API → queue → worker ───────────────────────────
// `OtelCollectorStack` above traces a request while it is a request. The moment
// it becomes a message the trace ends: the producer's span closes when the API
// returns 202 and the worker opens a span with no parent, so the backend holds
// two unrelated traces and nothing says they are the same piece of work.
//
// `TracedQueueStack` is the queue that keeps them joined — the carriers, the
// parent-or-link boundary and the two alarms that say when propagation stopped.
// `lib/queue-trace-context.ts` is the contract the producer and the worker
// implement; `npm run audit:tracing` checks that what synth wrote still
// satisfies it. See docs/queue-tracing.md.
//
// `decisionWaitSeconds` is passed explicitly rather than defaulted. It is the
// collector's tail-sampling window, and the parent-or-link boundary and the
// dwell alarm are both derived from it — so if an environment's `sampling` is
// changed above and this is left behind, the queue is measured against a window
// that no longer exists, and nothing reports it.
new TracedQueueStack(app, 'TracedQueueStack-Staging', {
  envName: 'staging',
  queueName: 'orders',
  decisionWaitSeconds: 30,
  propagation: {
    format: 'both',
    consumer: 'ecs-poller',
    // The reference producer sends an order id, a tenant and a schema version.
    // Stated here because SQS enforces its limit of ten *per message*: the
    // shape carrying the most attributes is the one SendMessage rejects, and it
    // is never the shape a test sends.
    businessAttributeCount: 3,
    attributeNames: ['orderId', 'tenant', 'schemaVersion'],
  },
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Staging traced work queue — trace context survives API → queue → worker',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});

new TracedQueueStack(app, 'TracedQueueStack-Production', {
  envName: 'production',
  queueName: 'orders',
  decisionWaitSeconds: DEFAULT_TAIL_SAMPLING.decisionWaitSeconds,
  // Production keeps failed messages longer before dead-lettering, because a
  // redrive here is a message whose original trace is long decided — it links
  // rather than parents, and the message body is then the only record of what
  // it was doing.
  maxReceiveCount: 5,
  retentionDays: 7,
  propagation: {
    format: 'both',
    consumer: 'ecs-poller',
    businessAttributeCount: 3,
    attributeNames: ['orderId', 'tenant', 'schemaVersion'],
  },
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Production traced work queue — trace context survives API → queue → worker',
  tags: { Project: 'boilerplate', CostCenter: 'engineering' },
});
