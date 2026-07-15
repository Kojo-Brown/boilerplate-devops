#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
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
import { AppConfigStack } from '../lib/appconfig-stack';
import { DbMigrationStack } from '../lib/db-migration-stack';
import { RollbackAutomationStack } from '../lib/rollback-automation-stack';
import { CostAnomalyStack } from '../lib/cost-anomaly-stack';
import { SecurityHubStack } from '../lib/security-hub-stack';
import { WafStack } from '../lib/waf-stack';
import { StaticSiteStack } from '../lib/static-site-stack';

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

new AppConfigStack(app, 'AppConfigStack', {
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

new DbMigrationStack(app, 'DbMigrationStack-Staging', {
  vpc: vpcStackStaging.vpc,
  envName: 'staging',
  migrationImageUri:
    process.env.MIGRATION_IMAGE_URI ??
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:migrate-latest',
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

new DbMigrationStack(app, 'DbMigrationStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  migrationImageUri:
    process.env.MIGRATION_IMAGE_URI ??
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:migrate-latest',
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
  enableGuardDutyCloudTrail: true,
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
  enableGuardDutyCloudTrail: true,
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
