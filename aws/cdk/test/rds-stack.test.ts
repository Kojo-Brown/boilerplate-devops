import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { RdsStack, RdsStackProps } from '../lib/rds-stack';

const makeStacks = (props: Partial<RdsStackProps> = {}) => {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, 'TestVpcStack', {
    envName: 'test',
    maxAzs: 2,
    natGateways: 1,
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const rdsStack = new RdsStack(app, 'TestRdsStack', {
    vpc: vpcStack.vpc,
    envName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { template: Template.fromStack(rdsStack), rdsStack };
};

describe('RdsStack', () => {
  describe('Security Group', () => {
    it('creates a security group for RDS', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: Match.stringLikeRegexp('RDS PostgreSQL'),
      });
    });

    it('names the security group with the env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupName: 'staging-rds-sg',
      });
    });

    it('adds a port-5432 ingress rule for each allowed SG', () => {
      const app = new cdk.App();
      const vpcStack = new VpcStack(app, 'VpcStack', {
        envName: 'test',
        maxAzs: 2,
        natGateways: 1,
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const allowedSg = new (require('aws-cdk-lib/aws-ec2').SecurityGroup)(
        vpcStack,
        'AllowedSg',
        { vpc: vpcStack.vpc, description: 'test' },
      );
      const rdsStack = new RdsStack(app, 'RdsStack', {
        vpc: vpcStack.vpc,
        envName: 'test',
        allowedSecurityGroups: [allowedSg],
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const template = Template.fromStack(rdsStack);
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        FromPort: 5432,
        ToPort: 5432,
        IpProtocol: 'tcp',
      });
    });
  });

  describe('Secrets Manager', () => {
    it('creates exactly one secret for master credentials', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    });

    it('names the secret at the expected path', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/staging/rds/master-credentials',
      });
    });

    it('generates a 32-character password for the postgres user', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        GenerateSecretString: Match.objectLike({
          SecretStringTemplate: JSON.stringify({ username: 'postgres' }),
          GenerateStringKey: 'password',
          ExcludePunctuation: true,
          PasswordLength: 32,
        }),
      });
    });
  });

  describe('Secret Rotation', () => {
    it('creates a rotation schedule', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
    });

    it('defaults to a 30-day rotation period', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
        RotationRules: Match.objectLike({ AutomaticallyAfterDays: 30 }),
      });
    });

    it('respects a custom rotation period', () => {
      const { template } = makeStacks({ secretRotationDays: 14 });
      template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
        RotationRules: Match.objectLike({ AutomaticallyAfterDays: 14 }),
      });
    });

    it('creates a rotation Lambda function', () => {
      const { template } = makeStacks();
      const lambdas = template.findResources('AWS::Lambda::Function');
      expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('RDS Instance', () => {
    it('creates exactly one DB instance', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::RDS::DBInstance', 1);
    });

    it('uses the PostgreSQL engine', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        Engine: 'postgres',
      });
    });

    it('names the instance with the env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        DBInstanceIdentifier: 'staging-postgres',
      });
    });

    it('enables Multi-AZ by default', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        MultiAZ: true,
      });
    });

    it('can disable Multi-AZ for dev environments', () => {
      const { template } = makeStacks({ multiAz: false });
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        MultiAZ: false,
      });
    });

    it('enables storage encryption', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        StorageEncrypted: true,
      });
    });

    it('uses GP3 storage type', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        StorageType: 'gp3',
      });
    });

    it('defaults to appdb as the database name', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        DBName: 'appdb',
      });
    });

    it('respects a custom database name', () => {
      const { template } = makeStacks({ databaseName: 'myapp' });
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        DBName: 'myapp',
      });
    });

    it('enables IAM database authentication', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        EnableIAMDatabaseAuthentication: true,
      });
    });

    it('enables Performance Insights', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        EnablePerformanceInsights: true,
      });
    });

    it('exports postgresql and upgrade logs to CloudWatch', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        EnableCloudwatchLogsExports: Match.arrayWith(['postgresql', 'upgrade']),
      });
    });

    it('respects custom allocated storage', () => {
      const { template } = makeStacks({ allocatedStorageGiB: 200 });
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        AllocatedStorage: '200',
      });
    });

    it('enables auto minor version upgrade', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        AutoMinorVersionUpgrade: true,
      });
    });

    it('sets backup window and maintenance window', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        PreferredBackupWindow: '03:00-04:00',
        PreferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      });
    });
  });

  describe('DB Subnet Group', () => {
    it('creates a DB subnet group', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
    });
  });

  describe('Parameter Group', () => {
    it('creates a DB parameter group', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::RDS::DBParameterGroup', 1);
    });

    it('sets slow-query logging threshold to 1 second', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
        Parameters: Match.objectLike({
          log_min_duration_statement: '1000',
        }),
      });
    });

    it('enables connection logging', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
        Parameters: Match.objectLike({
          log_connections: '1',
          log_disconnections: '1',
        }),
      });
    });

    it('loads pg_stat_statements', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
        Parameters: Match.objectLike({
          shared_preload_libraries: 'pg_stat_statements',
        }),
      });
    });
  });

  describe('Deletion Protection', () => {
    it('enables deletion protection for production by default', () => {
      const { template } = makeStacks({ envName: 'production' });
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        DeletionProtection: true,
      });
    });

    it('does not enable deletion protection for non-production by default', () => {
      const { template } = makeStacks({ envName: 'test' });
      const instances = template.findResources('AWS::RDS::DBInstance', {
        Properties: Match.objectLike({ DeletionProtection: true }),
      });
      expect(Object.keys(instances)).toHaveLength(0);
    });

    it('can override deletion protection regardless of env', () => {
      const { template } = makeStacks({ envName: 'staging', deletionProtection: true });
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        DeletionProtection: true,
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the RDS endpoint', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RdsEndpoint', {
        Export: { Name: 'test-rds-endpoint' },
      });
    });

    it('exports the RDS port', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RdsPort', {
        Export: { Name: 'test-rds-port' },
      });
    });

    it('exports the secret ARN', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RdsSecretArn', {
        Export: { Name: 'test-rds-secret-arn' },
      });
    });

    it('exports the database name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RdsDatabaseName', {
        Export: { Name: 'test-rds-database-name' },
      });
    });

    it('exports the instance identifier', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RdsInstanceId', {
        Export: { Name: 'test-rds-instance-id' },
      });
    });
  });

  describe('Tags', () => {
    it('tags all resources with the environment name', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'staging' }),
        ]),
      });
    });

    it('tags all resources as ManagedBy CDK', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' }),
        ]),
      });
    });
  });
});
