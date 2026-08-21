import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface VpcStackProps extends cdk.StackProps {
  /** CIDR block for the VPC (default: 10.0.0.0/16) */
  readonly vpcCidr?: string;
  /** Number of availability zones to span (default: 2) */
  readonly maxAzs?: number;
  /** Number of NAT Gateways — 1 (cost-optimised) or match maxAzs (HA) */
  readonly natGateways?: number;
  /** Retain VPC Flow Logs for this many days (default: 90) */
  readonly flowLogRetentionDays?: logs.RetentionDays;
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /**
   * Tag the subnets for Kubernetes load-balancer discovery (default: false).
   *
   * The AWS Load Balancer Controller picks the subnets for an Ingress or a
   * `Service type=LoadBalancer` by reading `kubernetes.io/role/elb` (public) and
   * `kubernetes.io/role/internal-elb` (private). Without the tags it finds no
   * eligible subnet and every load balancer stays pending — a failure that only
   * shows up the first time an application asks for one, long after the cluster
   * itself came up healthy.
   *
   * The tags live here rather than in {@link EksStack} because CloudFormation
   * cannot tag a resource another stack owns.
   */
  readonly tagSubnetsForEks?: boolean;
}

/**
 * VPC with public + private subnets across multiple AZs and NAT Gateway(s).
 *
 * Architecture:
 *   Public subnets  — internet-facing ALB, NAT Gateway EIPs
 *   Private subnets — ECS tasks, RDS, ElastiCache (egress via NAT)
 *   Isolated subnets (optional future use — no route to internet)
 *
 * Flow logs are written to CloudWatch Logs with a 90-day retention.
 */
export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly flowLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: VpcStackProps = {}) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const vpcCidr = props.vpcCidr ?? '10.0.0.0/16';
    const maxAzs = props.maxAzs ?? 2;
    const natGateways = props.natGateways ?? maxAzs; // default: one NAT per AZ for HA

    // ── Flow Logs ─────────────────────────────────────────────────────────────
    this.flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogGroup', {
      logGroupName: `/vpc/${envName}/flow-logs`,
      retention: props.flowLogRetentionDays ?? logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const flowLogRole = new iam.Role(this, 'VpcFlowLogRole', {
      assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
      description: 'Allows VPC Flow Logs to publish to CloudWatch Logs',
    });

    this.flowLogGroup.grantWrite(flowLogRole);

    // ── VPC ───────────────────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${envName}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      maxAzs,
      natGateways,

      // Subnet layout:  /20 public  (4 094 IPs each)
      //                 /20 private (4 094 IPs each)
      subnetConfiguration: [
        {
          cidrMask: 20,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          mapPublicIpOnLaunch: false, // explicitly disable auto-assign
        },
        {
          cidrMask: 20,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],

      // Disable the default SG rule that allows all traffic within the SG
      restrictDefaultSecurityGroup: true,

      // Enable DNS support for ECR, S3 VPC endpoints etc.
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // ── VPC Flow Logs ─────────────────────────────────────────────────────────
    new ec2.FlowLog(this, 'VpcFlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        this.flowLogGroup,
        flowLogRole,
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // ── VPC Endpoints (cost-free, reduces NAT traffic) ────────────────────────
    // S3 Gateway endpoint — free, dramatically reduces NAT usage for ECR pulls
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PUBLIC },
      ],
    });

    // DynamoDB Gateway endpoint — free
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    // ── Kubernetes subnet discovery tags ──────────────────────────────────────
    if (props.tagSubnetsForEks) {
      for (const subnet of this.vpc.publicSubnets) {
        cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
      }
      for (const subnet of this.vpc.privateSubnets) {
        cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
      }
    }

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: `${envName}-vpc-id`,
    });

    new cdk.CfnOutput(this, 'VpcCidr', {
      value: this.vpc.vpcCidrBlock,
      description: 'VPC CIDR block',
      exportName: `${envName}-vpc-cidr`,
    });

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: cdk.Fn.join(
        ',',
        this.vpc.publicSubnets.map((s) => s.subnetId),
      ),
      description: 'Comma-separated list of public subnet IDs',
      exportName: `${envName}-public-subnet-ids`,
    });

    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: cdk.Fn.join(
        ',',
        this.vpc.privateSubnets.map((s) => s.subnetId),
      ),
      description: 'Comma-separated list of private subnet IDs',
      exportName: `${envName}-private-subnet-ids`,
    });

    new cdk.CfnOutput(this, 'AvailabilityZones', {
      value: cdk.Fn.join(',', this.vpc.availabilityZones),
      description: 'AZs used by this VPC',
      exportName: `${envName}-availability-zones`,
    });

    new cdk.CfnOutput(this, 'FlowLogGroupName', {
      value: this.flowLogGroup.logGroupName,
      description: 'CloudWatch Log Group for VPC Flow Logs',
      exportName: `${envName}-vpc-flow-log-group`,
    });
  }
}
