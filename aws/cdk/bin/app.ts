#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
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
import { BlueGreenDeployStack } from '../lib/blue-green-deploy-stack';

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
