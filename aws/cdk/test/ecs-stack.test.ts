import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { EcsStack, EcsStackProps } from '../lib/ecs-stack';

const CERT_ARN =
  'arn:aws:acm:us-east-1:123456789012:certificate/aaaabbbb-cccc-dddd-eeee-ffffffffffff';

const makeStacks = (props: Partial<EcsStackProps> = {}) => {
  const app = new cdk.App();
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
    ...props,
  });
  return { template: Template.fromStack(ecsStack), ecsStack };
};

describe('EcsStack', () => {
  describe('ECS Cluster', () => {
    it('creates exactly one ECS cluster', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ECS::Cluster', 1);
    });

    it('names the cluster with the env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: 'staging-cluster',
      });
    });

    it('enables Container Insights', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterSettings: Match.arrayWith([
          Match.objectLike({ Name: 'containerInsights', Value: 'enabled' }),
        ]),
      });
    });
  });

  describe('Task Definition', () => {
    it('creates exactly one task definition', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    });

    it('uses Fargate launch type with default CPU and memory', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        RequiresCompatibilities: ['FARGATE'],
        NetworkMode: 'awsvpc',
        Cpu: '512',
        Memory: '1024',
      });
    });

    it('respects custom cpu and memoryLimitMiB', () => {
      const { template } = makeStacks({ cpu: 1024, memoryLimitMiB: 2048 });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '1024',
        Memory: '2048',
      });
    });

    it('adds a container definition with the correct port', () => {
      const { template } = makeStacks({ containerPort: 8080 });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            PortMappings: Match.arrayWith([
              Match.objectLike({ ContainerPort: 8080 }),
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

  describe('IAM Roles', () => {
    it('creates a task execution role', () => {
      const { template } = makeStacks({ envName: 'prod' });
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'prod-ecs-execution-role',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'ecs-tasks.amazonaws.com' },
            }),
          ]),
        }),
        ManagedPolicyArns: Match.arrayWith([
          Match.stringLikeRegexp('AmazonECSTaskExecutionRolePolicy'),
        ]),
      });
    });

    it('creates a task runtime role', () => {
      const { template } = makeStacks({ envName: 'prod' });
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'prod-ecs-task-role',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'ecs-tasks.amazonaws.com' },
            }),
          ]),
        }),
      });
    });

    it('grants ECS Exec (SSM) permissions to the task role', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'EcsExec',
              Action: Match.arrayWith([
                'ssmmessages:CreateControlChannel',
                'ssmmessages:OpenControlChannel',
              ]),
            }),
          ]),
        }),
      });
    });

    it('does not add SSM permissions when enableExecuteCommand is false', () => {
      const { template } = makeStacks({ enableExecuteCommand: false });
      const policies = template.findResources('AWS::IAM::Policy', {
        Properties: Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({ Sid: 'EcsExec' }),
            ]),
          }),
        }),
      });
      expect(Object.keys(policies)).toHaveLength(0);
    });
  });

  describe('Application Load Balancer', () => {
    it('creates exactly one ALB', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    });

    it('is internet-facing', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
        Type: 'application',
      });
    });

    it('names the ALB with the env prefix', () => {
      const { template } = makeStacks({ envName: 'dev' });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Name: 'dev-alb',
      });
    });

    it('enables deletion protection in production', () => {
      const { template } = makeStacks({ envName: 'production' });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: Match.arrayWith([
          Match.objectLike({
            Key: 'deletion_protection.enabled',
            Value: 'true',
          }),
        ]),
      });
    });

    it('does not enable deletion protection in non-production', () => {
      const { template } = makeStacks({ envName: 'staging' });
      const lbs = template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Properties: Match.objectLike({
          LoadBalancerAttributes: Match.arrayWith([
            Match.objectLike({
              Key: 'deletion_protection.enabled',
              Value: 'true',
            }),
          ]),
        }),
      });
      expect(Object.keys(lbs)).toHaveLength(0);
    });
  });

  describe('Listeners', () => {
    it('creates two listeners (HTTP and HTTPS)', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
    });

    it('creates an HTTPS listener on port 443', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        Protocol: 'HTTPS',
        Certificates: Match.arrayWith([
          Match.objectLike({ CertificateArn: CERT_ARN }),
        ]),
      });
    });

    it('sets an explicit SSL policy on the HTTPS listener', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        SslPolicy: Match.anyValue(),
      });
    });

    it('creates an HTTP listener on port 80 with redirect action', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        DefaultActions: Match.arrayWith([
          Match.objectLike({
            Type: 'redirect',
            RedirectConfig: Match.objectLike({
              Port: '443',
              Protocol: 'HTTPS',
              StatusCode: 'HTTP_301',
            }),
          }),
        ]),
      });
    });
  });

  describe('Target Group', () => {
    it('creates exactly one target group', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
    });

    it('uses IP target type (required for Fargate)', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        TargetType: 'ip',
      });
    });

    it('names the target group with the env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Name: 'staging-tg',
      });
    });

    it('sets health check path to /health by default', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: '/health',
        HealthCheckIntervalSeconds: 30,
      });
    });

    it('respects a custom health check path', () => {
      const { template } = makeStacks({ healthCheckPath: '/readiness' });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: '/readiness',
      });
    });

    it('sets a short deregistration delay for rolling updates', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        TargetGroupAttributes: Match.arrayWith([
          Match.objectLike({
            Key: 'deregistration_delay.timeout_seconds',
            Value: '30',
          }),
        ]),
      });
    });
  });

  describe('ECS Service', () => {
    it('creates exactly one ECS service', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ECS::Service', 1);
    });

    it('sets the desired task count', () => {
      const { template } = makeStacks({ desiredCount: 3 });
      template.hasResourceProperties('AWS::ECS::Service', {
        DesiredCount: 3,
      });
    });

    it('uses FARGATE launch type', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::Service', {
        LaunchType: 'FARGATE',
      });
    });

    it('enables ECS Exec by default', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::Service', {
        EnableExecuteCommand: true,
      });
    });

    it('enables the circuit breaker with rollback', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::Service', {
        DeploymentConfiguration: Match.objectLike({
          DeploymentCircuitBreaker: Match.objectLike({
            Enable: true,
            Rollback: true,
          }),
        }),
      });
    });

    it('names the service with the env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: 'staging-service',
      });
    });
  });

  describe('Auto-scaling', () => {
    it('creates an application auto-scaling target for the ECS service', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 1);
    });

    it('creates CPU and memory scaling policies', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 2);
    });

    it('scales to 4× desiredCount maximum', () => {
      const { template } = makeStacks({ desiredCount: 3 });
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
        MaxCapacity: 12,
        MinCapacity: 3,
      });
    });
  });

  describe('Security Groups', () => {
    it('creates security groups for ALB and tasks', () => {
      const { template } = makeStacks();
      const sgs = template.findResources('AWS::EC2::SecurityGroup');
      expect(Object.keys(sgs).length).toBeGreaterThanOrEqual(2);
    });

    it('allows HTTP inbound on the ALB security group', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 80, ToPort: 80 }),
        ]),
      });
    });

    it('allows HTTPS inbound on the ALB security group', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }),
        ]),
      });
    });
  });

  describe('CloudWatch Log Group', () => {
    it('creates a log group for task logs', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/ecs/test/service',
        RetentionInDays: 30,
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the ALB DNS name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('AlbDnsName', {
        Export: { Name: 'test-alb-dns' },
      });
    });

    it('exports the ECS cluster name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('ClusterName', {
        Export: { Name: 'test-ecs-cluster-name' },
      });
    });

    it('exports the ECS service name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('ServiceName', {
        Export: { Name: 'test-ecs-service-name' },
      });
    });

    it('exports the task log group name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('TaskLogGroupName', {
        Export: { Name: 'test-ecs-task-log-group' },
      });
    });
  });

  describe('Tags', () => {
    it('tags all resources with the environment name', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::Cluster', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'staging' }),
        ]),
      });
    });

    it('tags all resources as ManagedBy CDK', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::Cluster', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' }),
        ]),
      });
    });
  });
});
