import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { BlueGreenDeployStack, BlueGreenDeployStackProps } from '../lib/blue-green-deploy-stack';

const CERT_ARN =
  'arn:aws:acm:us-east-1:123456789012:certificate/aaaabbbb-cccc-dddd-eeee-ffffffffffff';

const makeStacks = (props: Partial<BlueGreenDeployStackProps> = {}) => {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, 'TestVpcStack', {
    envName: 'test',
    maxAzs: 2,
    natGateways: 1,
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const bgStack = new BlueGreenDeployStack(app, 'TestBgStack', {
    vpc: vpcStack.vpc,
    certificateArn: CERT_ARN,
    envName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { template: Template.fromStack(bgStack), bgStack };
};

describe('BlueGreenDeployStack', () => {
  describe('ECS Cluster', () => {
    it('creates exactly one ECS cluster', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ECS::Cluster', 1);
    });

    it('names the cluster with bg prefix and env', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: 'staging-bg-cluster',
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

    it('uses Fargate launch type with correct family name', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: 'staging-bg-task',
        RequiresCompatibilities: ['FARGATE'],
        NetworkMode: 'awsvpc',
      });
    });

    it('respects custom cpu and memoryLimitMiB', () => {
      const { template } = makeStacks({ cpu: 1024, memoryLimitMiB: 2048 });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '1024',
        Memory: '2048',
      });
    });

    it('adds AppContainer with the correct port mapping', () => {
      const { template } = makeStacks({ containerPort: 8080 });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'AppContainer',
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

  describe('Target Groups', () => {
    it('creates exactly two target groups (blue and green)', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
    });

    it('creates a blue target group with correct naming', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Name: 'staging-blue-tg',
        TargetType: 'ip',
      });
    });

    it('creates a green target group with correct naming', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Name: 'staging-green-tg',
        TargetType: 'ip',
      });
    });

    it('configures health check on both target groups', () => {
      const { template } = makeStacks({ healthCheckPath: '/readiness' });
      const tgs = template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Properties: Match.objectLike({
          HealthCheckPath: '/readiness',
        }),
      });
      expect(Object.keys(tgs)).toHaveLength(2);
    });

    it('sets a short deregistration delay', () => {
      const { template } = makeStacks();
      const tgs = template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Properties: Match.objectLike({
          TargetGroupAttributes: Match.arrayWith([
            Match.objectLike({
              Key: 'deregistration_delay.timeout_seconds',
              Value: '30',
            }),
          ]),
        }),
      });
      expect(Object.keys(tgs)).toHaveLength(2);
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

    it('names the ALB with bg prefix and env', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Name: 'staging-bg-alb',
      });
    });

    it('enables deletion protection in production', () => {
      const { template } = makeStacks({ envName: 'production' });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: Match.arrayWith([
          Match.objectLike({ Key: 'deletion_protection.enabled', Value: 'true' }),
        ]),
      });
    });
  });

  describe('Listeners', () => {
    it('creates three listeners: HTTP redirect, production HTTPS, test HTTPS', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 3);
    });

    it('creates production listener on port 443', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        Protocol: 'HTTPS',
        Certificates: Match.arrayWith([
          Match.objectLike({ CertificateArn: CERT_ARN }),
        ]),
      });
    });

    it('creates test listener on port 8443', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 8443,
        Protocol: 'HTTPS',
        Certificates: Match.arrayWith([
          Match.objectLike({ CertificateArn: CERT_ARN }),
        ]),
      });
    });

    it('creates HTTP listener on port 80 with redirect to HTTPS', () => {
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

    it('sets explicit SSL policy on both HTTPS listeners', () => {
      const { template } = makeStacks();
      const httpsListeners = template.findResources('AWS::ElasticLoadBalancingV2::Listener', {
        Properties: Match.objectLike({
          Protocol: 'HTTPS',
          SslPolicy: Match.anyValue(),
        }),
      });
      expect(Object.keys(httpsListeners)).toHaveLength(2);
    });
  });

  describe('ECS Service', () => {
    it('creates exactly one ECS service', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ECS::Service', 1);
    });

    it('names the service with bg prefix and env', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: 'staging-bg-service',
      });
    });

    it('uses CODE_DEPLOY deployment controller', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::Service', {
        DeploymentController: { Type: 'CODE_DEPLOY' },
      });
    });

    it('uses FARGATE launch type', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ECS::Service', {
        LaunchType: 'FARGATE',
      });
    });

    it('sets the correct desired count', () => {
      const { template } = makeStacks({ desiredCount: 3 });
      template.hasResourceProperties('AWS::ECS::Service', {
        DesiredCount: 3,
      });
    });

    it('does NOT use ECS rolling circuit breaker (incompatible with CODE_DEPLOY)', () => {
      const { template } = makeStacks();
      const services = template.findResources('AWS::ECS::Service', {
        Properties: Match.objectLike({
          DeploymentConfiguration: Match.objectLike({
            DeploymentCircuitBreaker: Match.anyValue(),
          }),
        }),
      });
      expect(Object.keys(services)).toHaveLength(0);
    });
  });

  describe('CodeDeploy', () => {
    it('creates exactly one CodeDeploy application', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::CodeDeploy::Application', 1);
    });

    it('names the CodeDeploy application with env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::CodeDeploy::Application', {
        ApplicationName: 'staging-ecs-app',
        ComputePlatform: 'ECS',
      });
    });

    it('creates exactly one CodeDeploy deployment group', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 1);
    });

    it('names the deployment group with env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
        DeploymentGroupName: 'staging-ecs-dg',
      });
    });

    it('configures blue/green deployment style', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
        DeploymentStyle: Match.objectLike({
          DeploymentOption: 'WITH_TRAFFIC_CONTROL',
          DeploymentType: 'BLUE_GREEN',
        }),
      });
    });

    it('enables auto-rollback on failed deployment and alarm breach', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
        AutoRollbackConfiguration: Match.objectLike({
          Enabled: true,
          Events: Match.arrayWith([
            'DEPLOYMENT_FAILURE',
            'DEPLOYMENT_STOP_ON_ALARM',
          ]),
        }),
      });
    });

    it('uses LINEAR_10_PERCENT_EVERY_1_MINUTES config by default', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
        DeploymentConfigName: Match.stringLikeRegexp('Linear10Percent'),
      });
    });

    it('uses ALL_AT_ONCE config when specified', () => {
      const { template } = makeStacks({ deploymentConfigType: 'AllAtOnce' });
      template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
        DeploymentConfigName: Match.stringLikeRegexp('AllAtOnce'),
      });
    });

    it('uses CANARY_10_PERCENT_5_MINUTES config when specified', () => {
      const { template } = makeStacks({ deploymentConfigType: 'Canary10Percent5Minutes' });
      template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
        DeploymentConfigName: Match.stringLikeRegexp('Canary10Percent'),
      });
    });
  });

  describe('CloudWatch Alarm', () => {
    it('creates a built-in ALB 5xx alarm for rollback', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'staging-bg-alb-5xx-rollback',
        MetricName: 'HTTPCode_ELB_5XX_Count',
        Namespace: 'AWS/ApplicationELB',
        Threshold: 5,
        EvaluationPeriods: 2,
      });
    });
  });

  describe('Security Groups', () => {
    it('opens port 8443 on the ALB security group for the test listener', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443 }),
        ]),
      });
    });

    it('opens port 443 on the ALB security group for the production listener', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }),
        ]),
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the ALB DNS name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('AlbDnsName', {
        Export: { Name: 'test-bg-alb-dns' },
      });
    });

    it('exports the CodeDeploy application name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('CodeDeployApplicationName', {
        Export: { Name: 'test-codedeploy-app-name' },
      });
    });

    it('exports the CodeDeploy deployment group name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('CodeDeployDeploymentGroupName', {
        Export: { Name: 'test-codedeploy-dg-name' },
      });
    });

    it('exports the test listener port', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('TestListenerPort', {
        Export: { Name: 'test-bg-test-listener-port' },
      });
    });

    it('exports the cluster name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('ClusterName', {
        Export: { Name: 'test-bg-cluster-name' },
      });
    });

    it('exports the service name', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('ServiceName', {
        Export: { Name: 'test-bg-service-name' },
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
