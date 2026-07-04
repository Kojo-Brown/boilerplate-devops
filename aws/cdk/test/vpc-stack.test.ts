import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';

describe('VpcStack', () => {
  const makeTemplate = (props?: ConstructorParameters<typeof VpcStack>[2]) => {
    const app = new cdk.App();
    const stack = new VpcStack(app, 'TestVpcStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      ...props,
    });
    return { template: Template.fromStack(stack), stack };
  };

  describe('VPC resource', () => {
    it('creates exactly one VPC', () => {
      const { template } = makeTemplate();
      template.resourceCountIs('AWS::EC2::VPC', 1);
    });

    it('uses the default CIDR 10.0.0.0/16', () => {
      const { template } = makeTemplate();
      template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: '10.0.0.0/16',
      });
    });

    it('respects a custom CIDR', () => {
      const { template } = makeTemplate({ vpcCidr: '172.16.0.0/16' });
      template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: '172.16.0.0/16',
      });
    });

    it('enables DNS hostnames and DNS support', () => {
      const { template } = makeTemplate();
      template.hasResourceProperties('AWS::EC2::VPC', {
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
      });
    });
  });

  describe('Subnets', () => {
    it('creates 4 subnets across 2 AZs (2 public + 2 private)', () => {
      const { template } = makeTemplate({ maxAzs: 2 });
      template.resourceCountIs('AWS::EC2::Subnet', 4);
    });

    it('creates public subnets with MapPublicIpOnLaunch disabled', () => {
      const { template } = makeTemplate();
      // All subnets with MapPublicIpOnLaunch set should have it false
      const subnets = template.findResources('AWS::EC2::Subnet', {
        Properties: Match.objectLike({ MapPublicIpOnLaunch: true }),
      });
      expect(Object.keys(subnets)).toHaveLength(0);
    });
  });

  describe('Internet Gateway', () => {
    it('creates an Internet Gateway', () => {
      const { template } = makeTemplate();
      template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    });

    it('attaches the Internet Gateway to the VPC', () => {
      const { template } = makeTemplate();
      template.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 1);
    });
  });

  describe('NAT Gateways', () => {
    it('creates 2 NAT Gateways by default (one per AZ)', () => {
      const { template } = makeTemplate({ maxAzs: 2 });
      template.resourceCountIs('AWS::EC2::NatGateway', 2);
    });

    it('creates 1 NAT Gateway when natGateways=1', () => {
      const { template } = makeTemplate({ maxAzs: 2, natGateways: 1 });
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    it('allocates Elastic IPs for NAT Gateways', () => {
      const { template } = makeTemplate({ maxAzs: 2 });
      // One EIP per NAT Gateway
      template.resourceCountIs('AWS::EC2::EIP', 2);
    });
  });

  describe('Route Tables', () => {
    it('creates a route table for each subnet', () => {
      const { template } = makeTemplate({ maxAzs: 2 });
      // 4 subnets → 4 route table associations minimum
      const associations = template.findResources(
        'AWS::EC2::SubnetRouteTableAssociation',
      );
      expect(Object.keys(associations).length).toBeGreaterThanOrEqual(4);
    });

    it('creates routes via the Internet Gateway for public subnets', () => {
      const { template } = makeTemplate();
      template.hasResourceProperties('AWS::EC2::Route', {
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: Match.anyValue(),
      });
    });

    it('creates routes via NAT Gateways for private subnets', () => {
      const { template } = makeTemplate();
      template.hasResourceProperties('AWS::EC2::Route', {
        DestinationCidrBlock: '0.0.0.0/0',
        NatGatewayId: Match.anyValue(),
      });
    });
  });

  describe('VPC Endpoints', () => {
    it('creates an S3 Gateway endpoint', () => {
      const { template } = makeTemplate();
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.stringLikeRegexp('s3'),
        VpcEndpointType: 'Gateway',
      });
    });

    it('creates a DynamoDB Gateway endpoint', () => {
      const { template } = makeTemplate();
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        ServiceName: Match.stringLikeRegexp('dynamodb'),
        VpcEndpointType: 'Gateway',
      });
    });
  });

  describe('VPC Flow Logs', () => {
    it('creates a CloudWatch Log Group for flow logs', () => {
      const { template } = makeTemplate({ envName: 'test' });
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/vpc/test/flow-logs',
      });
    });

    it('creates a flow log resource', () => {
      const { template } = makeTemplate();
      template.resourceCountIs('AWS::EC2::FlowLog', 1);
    });

    it('sets flow log traffic type to ALL', () => {
      const { template } = makeTemplate();
      template.hasResourceProperties('AWS::EC2::FlowLog', {
        TrafficType: 'ALL',
      });
    });

    it('creates an IAM role for flow logs', () => {
      const { template } = makeTemplate();
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'vpc-flow-logs.amazonaws.com' },
            }),
          ]),
        }),
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the VPC ID', () => {
      const { template } = makeTemplate({ envName: 'test' });
      template.hasOutput('VpcId', {
        Export: { Name: 'test-vpc-id' },
      });
    });

    it('exports public subnet IDs', () => {
      const { template } = makeTemplate({ envName: 'test' });
      template.hasOutput('PublicSubnetIds', {
        Export: { Name: 'test-public-subnet-ids' },
      });
    });

    it('exports private subnet IDs', () => {
      const { template } = makeTemplate({ envName: 'test' });
      template.hasOutput('PrivateSubnetIds', {
        Export: { Name: 'test-private-subnet-ids' },
      });
    });

    it('exports the flow log group name', () => {
      const { template } = makeTemplate({ envName: 'test' });
      template.hasOutput('FlowLogGroupName', {
        Export: { Name: 'test-vpc-flow-log-group' },
      });
    });
  });

  describe('Tags', () => {
    it('tags all resources with the environment name', () => {
      const { template } = makeTemplate({ envName: 'staging' });
      template.hasResourceProperties('AWS::EC2::VPC', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'staging' }),
        ]),
      });
    });

    it('tags all resources as ManagedBy CDK', () => {
      const { template } = makeTemplate();
      template.hasResourceProperties('AWS::EC2::VPC', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' }),
        ]),
      });
    });
  });
});
