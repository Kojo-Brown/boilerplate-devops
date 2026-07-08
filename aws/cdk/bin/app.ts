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

new RdsStack(app, 'RdsStack-Staging', {
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

new RdsStack(app, 'RdsStack-Production', {
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
