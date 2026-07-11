import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { VpcStack } from '../lib/vpc-stack';
import { EcsStack } from '../lib/ecs-stack';
import { XRayStack } from '../lib/xray-stack';

const CERT_ARN =
  'arn:aws:acm:us-east-1:123456789012:certificate/aaaabbbb-cccc-dddd-eeee-ffffffffffff';

interface TestStacks {
  xrayTemplate: Template;
  roleTemplate: Template;
  xrayStack: XRayStack;
  taskRole: iam.Role;
}

/**
 * makeStacks creates:
 *   - roleStack: holds the mock ECS task role (simulates EcsStack.taskRole)
 *   - xrayStack: the stack under test; adds IAM policies to roleStack.taskRole
 *
 * IAM policy assertions must use roleTemplate (policies live in the role's stack).
 * X-Ray resource assertions use xrayTemplate.
 */
const makeStacks = (
  xrayOverrides: Partial<ConstructorParameters<typeof XRayStack>[2]> = {},
): TestStacks => {
  const app = new cdk.App();

  // Simulate the ECS stack's VPC dependency
  const vpcStack = new VpcStack(app, 'TestVpcStack', {
    envName: 'test',
    maxAzs: 2,
    natGateways: 1,
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const ecsStack = new EcsStack(app, 'TestEcsStack', {
    vpc: vpcStack.vpc,
    certificateArn: CERT_ARN,
    envName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
  });

  // Role stack simulates the ECS task role created by EcsStack.
  // IAM policies added via addToPrincipalPolicy are placed in the ROLE's stack,
  // so assertions on those policies target roleTemplate, not xrayTemplate.
  const roleStack = new cdk.Stack(app, 'TestRoleStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const taskRole = new iam.Role(roleStack, 'MockTaskRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  });

  const xrayStack = new XRayStack(app, 'TestXRayStack', {
    envName: 'test',
    clusterName: ecsStack.cluster.clusterName,
    serviceName: 'test-api',
    taskRole,
    env: { account: '123456789012', region: 'us-east-1' },
    ...xrayOverrides,
  });

  return {
    xrayTemplate: Template.fromStack(xrayStack),
    roleTemplate: Template.fromStack(roleStack),
    xrayStack,
    taskRole,
  };
};

describe('XRayStack', () => {
  describe('IAM permissions', () => {
    it('grants X-Ray daemon write permissions to the task role', () => {
      const { roleTemplate } = makeStacks();
      roleTemplate.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'XRayDaemonWrite',
              Effect: 'Allow',
              Action: Match.arrayWith([
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords',
                'xray:GetSamplingRules',
                'xray:GetSamplingTargets',
                'xray:GetSamplingStatisticSummaries',
              ]),
              Resource: '*',
            }),
          ]),
        }),
      });
    });

    it('attaches the X-Ray policy to the ECS task role', () => {
      const { roleTemplate } = makeStacks();
      roleTemplate.resourceCountIs('AWS::IAM::Policy', 1);
    });
  });

  describe('X-Ray Group', () => {
    it('creates exactly one X-Ray group for the service', () => {
      const { xrayTemplate } = makeStacks();
      xrayTemplate.resourceCountIs('AWS::XRay::Group', 1);
    });

    it('names the group with env and service name', () => {
      const { xrayTemplate } = makeStacks({ envName: 'staging', serviceName: 'my-api' });
      xrayTemplate.hasResourceProperties('AWS::XRay::Group', {
        GroupName: 'staging-my-api',
      });
    });

    it('sets a filter expression that matches environment annotation', () => {
      const { xrayTemplate } = makeStacks({ envName: 'production', serviceName: 'user-service' });
      xrayTemplate.hasResourceProperties('AWS::XRay::Group', {
        FilterExpression: Match.stringLikeRegexp('annotation\\.environment.*production'),
      });
    });

    it('sets a filter expression that matches service annotation', () => {
      const { xrayTemplate } = makeStacks({ envName: 'staging', serviceName: 'payment-api' });
      xrayTemplate.hasResourceProperties('AWS::XRay::Group', {
        FilterExpression: Match.stringLikeRegexp('annotation\\.service.*payment-api'),
      });
    });

    it('disables Insights by default', () => {
      const { xrayTemplate } = makeStacks();
      xrayTemplate.hasResourceProperties('AWS::XRay::Group', {
        InsightsConfiguration: Match.objectLike({
          InsightsEnabled: false,
        }),
      });
    });

    it('enables Insights and notifications when insightsEnabled is true', () => {
      const { xrayTemplate } = makeStacks({ insightsEnabled: true });
      xrayTemplate.hasResourceProperties('AWS::XRay::Group', {
        InsightsConfiguration: Match.objectLike({
          InsightsEnabled: true,
          NotificationsEnabled: true,
        }),
      });
    });
  });

  describe('X-Ray Sampling Rules', () => {
    it('creates two sampling rules (service rule + health-check exclusion)', () => {
      const { xrayTemplate } = makeStacks();
      xrayTemplate.resourceCountIs('AWS::XRay::SamplingRule', 2);
    });

    it('creates a service-level sampling rule with default rate', () => {
      const { xrayTemplate } = makeStacks({ envName: 'production', serviceName: 'my-api' });
      xrayTemplate.hasResourceProperties('AWS::XRay::SamplingRule', {
        SamplingRule: Match.objectLike({
          RuleName: 'production-my-api-rule',
          FixedRate: 0.05,
          ReservoirSize: 10,
          ServiceName: 'my-api',
          ServiceType: 'AWS::ECS::Container',
          Priority: 1000,
        }),
      });
    });

    it('respects custom sampling rate', () => {
      const { xrayTemplate } = makeStacks({ samplingRate: 0.1 });
      xrayTemplate.hasResourceProperties('AWS::XRay::SamplingRule', {
        SamplingRule: Match.objectLike({
          FixedRate: 0.1,
        }),
      });
    });

    it('respects custom reservoir size', () => {
      const { xrayTemplate } = makeStacks({ reservoirSize: 25 });
      xrayTemplate.hasResourceProperties('AWS::XRay::SamplingRule', {
        SamplingRule: Match.objectLike({
          ReservoirSize: 25,
        }),
      });
    });

    it('creates a health-check exclusion rule at higher priority (lower number)', () => {
      const { xrayTemplate } = makeStacks({ envName: 'staging', serviceName: 'api' });
      xrayTemplate.hasResourceProperties('AWS::XRay::SamplingRule', {
        SamplingRule: Match.objectLike({
          RuleName: 'staging-api-health-check-exclude',
          FixedRate: 0,
          ReservoirSize: 0,
          UrlPath: '/health',
          Priority: 100,
        }),
      });
    });

    it('health-check exclusion rule has lower priority number than service rule', () => {
      const { xrayTemplate } = makeStacks();
      const resources = xrayTemplate.findResources('AWS::XRay::SamplingRule');
      const priorities = Object.values(resources).map(
        (r: { Properties: { SamplingRule: { Priority: number } } }) =>
          r.Properties.SamplingRule.Priority,
      );
      expect(Math.min(...priorities)).toBe(100);
      expect(Math.max(...priorities)).toBe(1000);
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the X-Ray group name', () => {
      const { xrayTemplate } = makeStacks({ envName: 'test' });
      xrayTemplate.hasOutput('XRayGroupName', {
        Export: { Name: 'test-xray-group-name' },
      });
    });

    it('exports the X-Ray sampling rule name', () => {
      const { xrayTemplate } = makeStacks({ envName: 'test' });
      xrayTemplate.hasOutput('XRaySamplingRuleName', {
        Export: { Name: 'test-xray-sampling-rule-name' },
      });
    });

    it('exports the X-Ray daemon address hint', () => {
      const { xrayTemplate } = makeStacks({ envName: 'test' });
      xrayTemplate.hasOutput('XRayDaemonAddress', {
        Value: 'localhost:2000',
        Export: { Name: 'test-xray-daemon-address' },
      });
    });
  });

  describe('Tags', () => {
    it('tags X-Ray resources with the environment name', () => {
      const { xrayTemplate } = makeStacks({ envName: 'staging' });
      xrayTemplate.hasResourceProperties('AWS::XRay::Group', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'staging' }),
        ]),
      });
    });

    it('tags resources as ManagedBy CDK', () => {
      const { xrayTemplate } = makeStacks();
      xrayTemplate.hasResourceProperties('AWS::XRay::Group', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' }),
        ]),
      });
    });
  });

  describe('addDaemonSidecar static method', () => {
    it('adds an X-Ray daemon container to a Fargate task definition', () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const taskDef = new ecs.FargateTaskDefinition(stack, 'Task', {
        cpu: 512,
        memoryLimitMiB: 1024,
      });

      XRayStack.addDaemonSidecar(taskDef);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'xray-daemon',
            Essential: false,
            PortMappings: Match.arrayWith([
              Match.objectLike({ ContainerPort: 2000, Protocol: 'udp' }),
            ]),
          }),
        ]),
      });
    });

    it('uses default 32 CPU units and 256 MiB for the daemon sidecar', () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack2', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const taskDef = new ecs.FargateTaskDefinition(stack, 'Task', {
        cpu: 512,
        memoryLimitMiB: 1024,
      });

      XRayStack.addDaemonSidecar(taskDef);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'xray-daemon',
            Cpu: 32,
            Memory: 256,
          }),
        ]),
      });
    });

    it('respects custom CPU and memory overrides for the daemon sidecar', () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack3', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const taskDef = new ecs.FargateTaskDefinition(stack, 'Task', {
        cpu: 1024,
        memoryLimitMiB: 2048,
      });

      XRayStack.addDaemonSidecar(taskDef, { cpuUnits: 64, memoryMiB: 512 });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'xray-daemon',
            Cpu: 64,
            Memory: 512,
          }),
        ]),
      });
    });

    it('marks the daemon container as non-essential so app can survive daemon restarts', () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack4', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const taskDef = new ecs.FargateTaskDefinition(stack, 'Task', {
        cpu: 512,
        memoryLimitMiB: 1024,
      });

      XRayStack.addDaemonSidecar(taskDef);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'xray-daemon',
            Essential: false,
          }),
        ]),
      });
    });

    it('uses the official X-Ray daemon image from public ECR', () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack5', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const taskDef = new ecs.FargateTaskDefinition(stack, 'Task', {
        cpu: 512,
        memoryLimitMiB: 1024,
      });

      XRayStack.addDaemonSidecar(taskDef);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Image: Match.stringLikeRegexp('aws-xray-daemon'),
          }),
        ]),
      });
    });
  });
});
