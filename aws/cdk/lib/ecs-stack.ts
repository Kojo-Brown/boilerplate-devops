import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface EcsStackProps extends cdk.StackProps {
  /** VPC from VpcStack (required) */
  readonly vpc: ec2.IVpc;
  /** ACM certificate ARN for the HTTPS listener (required) */
  readonly certificateArn: string;
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** Container image URI (default: nginx stable-alpine for bootstrapping) */
  readonly containerImage?: string;
  /** Port the container listens on (default: 3000) */
  readonly containerPort?: number;
  /** Fargate CPU units — 256 | 512 | 1024 | 2048 | 4096 (default: 512) */
  readonly cpu?: number;
  /** Fargate memory in MiB — must be compatible with cpu (default: 1024) */
  readonly memoryLimitMiB?: number;
  /** Initial desired task count (default: 2) */
  readonly desiredCount?: number;
  /** ALB health-check path (default: /health) */
  readonly healthCheckPath?: string;
  /** Enable ECS Exec for interactive container debugging (default: true) */
  readonly enableExecuteCommand?: boolean;
}

/**
 * ECS Fargate service behind an internet-facing ALB with HTTPS termination.
 *
 * Architecture:
 *   Internet → ALB (public subnets) → HTTPS listener (ACM cert)
 *              HTTP :80 → 301 redirect to HTTPS
 *              HTTPS :443 → Target Group → Fargate tasks (private subnets)
 *
 * Security:
 *   ALB SG  — ingress 80/443 from 0.0.0.0/0, egress to task SG only
 *   Task SG — ingress from ALB SG on containerPort, egress 443 (ECR/SSM/etc.)
 *
 * Deployment:
 *   Circuit breaker with auto-rollback; ECS Exec enabled for debugging.
 *   CPU (60%) and memory (80%) target-tracking auto-scaling policies.
 */
export class EcsStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpsListener: elbv2.ApplicationListener;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  /** Security group attached to Fargate tasks — pass to RdsStack.allowedSecurityGroups */
  public readonly taskSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const containerPort = props.containerPort ?? 3000;
    const cpu = props.cpu ?? 512;
    const memoryLimitMiB = props.memoryLimitMiB ?? 1024;
    const desiredCount = props.desiredCount ?? 2;
    const healthCheckPath = props.healthCheckPath ?? '/health';
    const enableExecuteCommand = props.enableExecuteCommand ?? true;

    // ── ECS Cluster ───────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${envName}-cluster`,
      vpc: props.vpc,
      containerInsights: true,
    });

    // ── Log Group ─────────────────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: `/ecs/${envName}/service`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── IAM Roles ─────────────────────────────────────────────────────────────
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `${envName}-ecs-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
      description: 'Allows ECS to pull images from ECR and write to CloudWatch Logs',
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${envName}-ecs-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime permissions for the application container',
    });

    // ECS Exec requires SSM messaging permissions on the task role
    if (enableExecuteCommand) {
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'EcsExec',
          actions: [
            'ssmmessages:CreateControlChannel',
            'ssmmessages:CreateDataChannel',
            'ssmmessages:OpenControlChannel',
            'ssmmessages:OpenDataChannel',
          ],
          resources: ['*'],
        }),
      );
    }

    // ── Task Definition ───────────────────────────────────────────────────────
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu,
      memoryLimitMiB,
      executionRole,
      taskRole,
    });

    taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry(
        props.containerImage ?? 'public.ecr.aws/nginx/nginx:stable-alpine',
      ),
      portMappings: [{ containerPort, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'app',
      }),
      environment: {
        NODE_ENV: envName,
        PORT: String(containerPort),
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          `curl -sf http://localhost:${containerPort}${healthCheckPath} || exit 1`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      readonlyRootFilesystem: false,
      essential: true,
    });

    // ── Security Groups ───────────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      securityGroupName: `${envName}-alb-sg`,
      vpc: props.vpc,
      description: 'Internet-facing ALB: allow HTTP/HTTPS inbound, container port outbound',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
    albSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP from internet IPv6');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');
    albSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS from internet IPv6');

    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      securityGroupName: `${envName}-ecs-task-sg`,
      vpc: props.vpc,
      description: 'ECS Fargate tasks: allow inbound from ALB on container port',
      allowAllOutbound: true,
    });
    const taskSg = this.taskSecurityGroup;
    taskSg.addIngressRule(
      albSg,
      ec2.Port.tcp(containerPort),
      'From ALB on container port',
    );

    // ALB egress must explicitly target the task SG
    albSg.addEgressRule(taskSg, ec2.Port.tcp(containerPort), 'To ECS tasks');

    // ── Application Load Balancer ─────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${envName}-alb`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      deletionProtection: envName === 'production',
      idleTimeout: cdk.Duration.seconds(60),
    });

    // ── Listeners ─────────────────────────────────────────────────────────────
    // HTTP :80 — permanent redirect to HTTPS
    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
        permanent: true,
      }),
    });

    // HTTPS :443 — TLS terminated at the ALB; traffic to tasks is plain HTTP
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'Certificate',
      props.certificateArn,
    );

    this.httpsListener = this.alb.addListener('HttpsListener', {
      port: 443,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED,
    });

    // ── Fargate Service ───────────────────────────────────────────────────────
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `${envName}-service`,
      cluster: this.cluster,
      taskDefinition,
      desiredCount,
      assignPublicIp: false,
      securityGroups: [taskSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      enableExecuteCommand,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });

    // ── Target Group ──────────────────────────────────────────────────────────
    this.targetGroup = this.httpsListener.addTargets('ServiceTargets', {
      targetGroupName: `${envName}-tg`,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        this.service.loadBalancerTarget({
          containerName: 'AppContainer',
          containerPort,
        }),
      ],
      healthCheck: {
        path: healthCheckPath,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ── Auto-scaling ──────────────────────────────────────────────────────────
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: desiredCount,
      maxCapacity: desiredCount * 4,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name — create a CNAME record pointing your domain here',
      exportName: `${envName}-alb-dns`,
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS Cluster name',
      exportName: `${envName}-ecs-cluster-name`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: 'ECS Service name',
      exportName: `${envName}-ecs-service-name`,
    });

    new cdk.CfnOutput(this, 'TaskLogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group for ECS task logs',
      exportName: `${envName}-ecs-task-log-group`,
    });
  }
}
