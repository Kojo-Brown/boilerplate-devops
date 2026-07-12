import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { VpcStack } from '../lib/vpc-stack';
import { RdsStack } from '../lib/rds-stack';
import { DbMigrationStack, DbMigrationStackProps } from '../lib/db-migration-stack';

const DB_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:/production/rds/master-credentials-AbCdEf';

const makeStacks = (overrides: Partial<DbMigrationStackProps> = {}) => {
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
    multiAz: false,
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const migrationStack = new DbMigrationStack(app, 'TestDbMigrationStack', {
    vpc: vpcStack.vpc,
    envName: 'test',
    migrationImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:migrate-abc123',
    dbSecretArn: DB_SECRET_ARN,
    dbSecurityGroup: rdsStack.securityGroup,
    env: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  });

  return {
    template: Template.fromStack(migrationStack),
    migrationStack,
  };
};

describe('DbMigrationStack', () => {
  describe('ECS Cluster', () => {
    it('creates exactly one ECS cluster', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ECS::Cluster', 1);
    });

    it('names the cluster with migration prefix and env', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: 'staging-migration-cluster',
      });
    });

    it('enables Container Insights on the migration cluster', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterSettings: Match.arrayWith([
          Match.objectLike({ Name: 'containerInsights', Value: 'enabled' }),
        ]),
      });
    });
  });

  describe('Task Definition', () => {
    it('creates exactly one Fargate task definition', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    });

    it('names the task definition family with migration suffix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: 'staging-migration-task',
        RequiresCompatibilities: ['FARGATE'],
        NetworkMode: 'awsvpc',
      });
    });

    it('uses default CPU and memory', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '256',
        Memory: '512',
      });
    });

    it('respects custom cpu and memoryLimitMiB', () => {
      const { template } = makeStacks({ cpu: 512, memoryLimitMiB: 1024 });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '512',
        Memory: '1024',
      });
    });

    it('adds MigrationContainer with correct image', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'MigrationContainer',
            Image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:migrate-abc123',
          }),
        ]),
      });
    });

    it('sets NODE_ENV and DB_SECRET_ARN environment variables', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'NODE_ENV', Value: 'staging' }),
              Match.objectLike({ Name: 'DB_SECRET_ARN', Value: DB_SECRET_ARN }),
            ]),
          }),
        ]),
      });
    });

    it('injects the DB secret as an ECS secret', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: 'DB_SECRET_JSON' }),
            ]),
          }),
        ]),
      });
    });

    it('configures awslogs log driver', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            LogConfiguration: Match.objectLike({ LogDriver: 'awslogs' }),
          }),
        ]),
      });
    });
  });

  describe('Security Groups', () => {
    it('creates a security group for migration tasks', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: Match.stringLikeRegexp('migration'),
      });
    });

    it('adds an ingress rule on port 5432 to the RDS security group', () => {
      const { template } = makeStacks();
      // The RDS SG is in a different stack, so we look for the ingress rule
      // that the migration stack adds to the RDS SG via addIngressRule
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
      });
    });
  });

  describe('IAM Roles', () => {
    it('creates a task execution role', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'staging-migration-execution-role',
        AssumedBy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'ecs-tasks.amazonaws.com' },
            }),
          ]),
        }),
      });
    });

    it('attaches AmazonECSTaskExecutionRolePolicy to execution role', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: Match.arrayWith([
          Match.stringLikeRegexp('AmazonECSTaskExecutionRolePolicy'),
        ]),
      });
    });

    it('grants execution role access to the DB secret', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'secretsmanager:GetSecretValue',
              Resource: DB_SECRET_ARN,
            }),
          ]),
        }),
      });
    });

    it('creates a Lambda execution role for the lifecycle hook', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'staging-migration-hook-lambda-role',
        AssumedBy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'lambda.amazonaws.com' },
            }),
          ]),
        }),
      });
    });

    it('attaches AWSLambdaVPCAccessExecutionRole to Lambda role', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: Match.arrayWith([
          Match.stringLikeRegexp('AWSLambdaVPCAccessExecutionRole'),
        ]),
      });
    });

    it('grants Lambda role ecs:RunTask permission scoped to migration task def', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'ecs:RunTask',
              Sid: 'RunMigrationTask',
            }),
          ]),
        }),
      });
    });

    it('grants Lambda role ecs:DescribeTasks and ecs:StopTask', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ecs:DescribeTasks', 'ecs:StopTask']),
              Sid: 'ObserveMigrationTask',
            }),
          ]),
        }),
      });
    });

    it('grants Lambda role codedeploy:PutLifecycleEventHookExecutionStatus', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'codedeploy:PutLifecycleEventHookExecutionStatus',
              Sid: 'ReportLifecycleHookStatus',
            }),
          ]),
        }),
      });
    });

    it('grants Lambda role iam:PassRole with PassedToService condition', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'iam:PassRole',
              Sid: 'PassEcsRoles',
              Condition: Match.objectLike({
                StringEquals: {
                  'iam:PassedToService': 'ecs-tasks.amazonaws.com',
                },
              }),
            }),
          ]),
        }),
      });
    });
  });

  describe('Lambda Function', () => {
    it('creates exactly one Lambda function', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::Lambda::Function', 1);
    });

    it('names the Lambda with migration-hook suffix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'staging-migration-hook',
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
      });
    });

    it('sets Lambda timeout to 15 minutes', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 900, // 15 * 60
      });
    });

    it('sets CLUSTER_ARN environment variable', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            CLUSTER_ARN: Match.anyValue(),
          }),
        },
      });
    });

    it('sets TASK_DEFINITION_ARN environment variable', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            TASK_DEFINITION_ARN: Match.anyValue(),
          }),
        },
      });
    });

    it('sets SUBNETS environment variable', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            SUBNETS: Match.anyValue(),
          }),
        },
      });
    });

    it('sets MIGRATION_TIMEOUT_MS based on migrationTimeoutMinutes', () => {
      const { template } = makeStacks({ migrationTimeoutMinutes: 10 });
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            MIGRATION_TIMEOUT_MS: '600000', // 10 * 60 * 1000
          }),
        },
      });
    });

    it('adds a resource-based policy allowing CodeDeploy to invoke the Lambda', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunction',
        Principal: 'codedeploy.amazonaws.com',
      });
    });
  });

  describe('CloudWatch Log Groups', () => {
    it('creates two log groups (ECS migration + Lambda)', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::Logs::LogGroup', 2);
    });

    it('creates an ECS migration log group', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/ecs/staging/migration',
      });
    });

    it('creates a Lambda log group with two-week retention', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/lambda/staging-migration-hook',
        RetentionInDays: 14,
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports MigrationHookLambdaArn', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('MigrationHookLambdaArn', {
        Export: { Name: 'test-migration-hook-lambda-arn' },
      });
    });

    it('exports MigrationClusterArn', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('MigrationClusterArn', {
        Export: { Name: 'test-migration-cluster-arn' },
      });
    });

    it('exports MigrationTaskDefinitionArn', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('MigrationTaskDefinitionArn', {
        Export: { Name: 'test-migration-task-def-arn' },
      });
    });

    it('exports MigrationClusterName', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('MigrationClusterName', {
        Export: { Name: 'test-migration-cluster-name' },
      });
    });

    it('exports MigrationSecurityGroupId', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('MigrationSecurityGroupId', {
        Export: { Name: 'test-migration-sg-id' },
      });
    });
  });

  describe('Tags', () => {
    it('tags resources with the Environment name', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::Cluster', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'staging' }),
        ]),
      });
    });

    it('tags resources as ManagedBy CDK', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::Cluster', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' }),
        ]),
      });
    });
  });
});
