import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export type BlueGreenDeploymentConfigType =
  | 'AllAtOnce'
  | 'Canary10Percent5Minutes'
  | 'Linear10Percent1Minute';

export interface BlueGreenDeployStackProps extends cdk.StackProps {
  /** VPC to deploy into (from VpcStack) */
  readonly vpc: ec2.IVpc;
  /** ACM certificate ARN for HTTPS listeners */
  readonly certificateArn: string;
  /** Environment name used for resource naming */
  readonly envName?: string;
  /** Container image URI (default: nginx stable-alpine for bootstrapping) */
  readonly containerImage?: string;
  /** Port the container listens on (default: 3000) */
  readonly containerPort?: number;
  /** Fargate CPU units (default: 512) */
  readonly cpu?: number;
  /** Fargate memory in MiB (default: 1024) */
  readonly memoryLimitMiB?: number;
  /** Initial desired task count (default: 2) */
  readonly desiredCount?: number;
  /** ALB health-check path (default: /health) */
  readonly healthCheckPath?: string;
  /**
   * CodeDeploy traffic-shift strategy (default: Linear10Percent1Minute).
   *   AllAtOnce           — instant cutover; fastest but highest risk
   *   Canary10Percent5Minutes — 10 % to green for 5 min, then 100 %
   *   Linear10Percent1Minute  — +10 % every minute over 10 minutes
   */
  readonly deploymentConfigType?: BlueGreenDeploymentConfigType;
  /** Minutes to keep the old (blue) environment after full traffic shift (default: 5) */
  readonly terminationWaitMinutes?: number;
  /**
   * Minutes CodeDeploy waits for manual approval before auto-continuing.
   * Set to 0 for fully automated deployments (default: 0).
   */
  readonly deploymentApprovalWaitMinutes?: number;
  /** Additional CloudWatch Alarm ARNs that trigger an automatic rollback */
  readonly rollbackAlarmArns?: string[];
}

/**
 * ECS blue/green deployment via AWS CodeDeploy.
 *
 * Architecture:
 *   Internet → ALB → Production listener :443 → Blue TG (active)
 *                  → Test listener      :8443 → Green TG (replacement)
 *
 * Deployment flow (managed by CodeDeploy):
 *   1. GitHub Actions registers a new task-definition revision + appspec.yaml.
 *   2. CodeDeploy starts new tasks and routes them to the Green TG.
 *   3. The test listener (:8443) can be used for smoke-testing the Green TG.
 *   4. Traffic shifts from Blue → Green according to deploymentConfigType.
 *   5. Old (Blue) tasks are terminated after terminationWaitMinutes.
 *   6. On ALB 5xx spike or explicit alarm, CodeDeploy rolls back instantly.
 *
 * Key differences from rolling EcsStack:
 *   - ECS service uses DeploymentControllerType.CODE_DEPLOY (not ECS rolling)
 *   - Two target groups and two HTTPS listeners (prod + test)
 *   - No circuitBreaker — CodeDeploy handles failure detection via alarms
 */
export class BlueGreenDeployStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly productionListener: elbv2.ApplicationListener;
  public readonly testListener: elbv2.ApplicationListener;
  public readonly blueTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly greenTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly codeDeployApp: codedeploy.EcsApplication;
  public readonly deploymentGroup: codedeploy.EcsDeploymentGroup;
  /** Security group attached to Fargate tasks */
  public readonly taskSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: BlueGreenDeployStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const containerPort = props.containerPort ?? 3000;
    const cpu = props.cpu ?? 512;
    const memoryLimitMiB = props.memoryLimitMiB ?? 1024;
    const desiredCount = props.desiredCount ?? 2;
    const healthCheckPath = props.healthCheckPath ?? '/health';
    const terminationWaitMinutes = props.terminationWaitMinutes ?? 5;
    const deploymentApprovalWaitMinutes = props.deploymentApprovalWaitMinutes ?? 0;

    const deploymentConfigMap: Record<BlueGreenDeploymentConfigType, codedeploy.IEcsDeploymentConfig> = {
      AllAtOnce: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
      Canary10Percent5Minutes: codedeploy.EcsDeploymentConfig.CANARY_10_PERCENT_5_MINUTES,
      Linear10Percent1Minute: codedeploy.EcsDeploymentConfig.LINEAR_10_PERCENT_EVERY_1_MINUTES,
    };
    const deploymentConfig =
      deploymentConfigMap[props.deploymentConfigType ?? 'Linear10Percent1Minute'];

    // ── ECS Cluster ─────────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${envName}-bg-cluster`,
      vpc: props.vpc,
      containerInsights: true,
    });

    // ── CloudWatch Log Group ─────────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: `/ecs/${envName}/bg-service`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── IAM Roles ────────────────────────────────────────────────────────────────
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `${envName}-ecs-bg-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
      description: 'ECS task execution role for blue/green deployments',
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${envName}-ecs-bg-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime permissions for blue/green application container',
    });

    // ── Task Definition ──────────────────────────────────────────────────────────
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${envName}-bg-task`,
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
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'app' }),
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
      essential: true,
    });

    // ── Security Groups ──────────────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      securityGroupName: `${envName}-bg-alb-sg`,
      vpc: props.vpc,
      description: 'Blue/green ALB: HTTP/HTTPS + test listener inbound',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
    albSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP from internet IPv6');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS production listener');
    albSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS production listener IPv6');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8443), 'HTTPS test listener (green smoke tests)');
    albSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(8443), 'HTTPS test listener IPv6');

    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      securityGroupName: `${envName}-bg-task-sg`,
      vpc: props.vpc,
      description: 'ECS blue/green tasks: allow inbound from ALB on container port',
      allowAllOutbound: true,
    });
    this.taskSecurityGroup.addIngressRule(
      albSg,
      ec2.Port.tcp(containerPort),
      'From ALB on container port',
    );
    albSg.addEgressRule(this.taskSecurityGroup, ec2.Port.tcp(containerPort), 'To ECS tasks');

    // ── Application Load Balancer ────────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${envName}-bg-alb`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      deletionProtection: envName === 'production',
      idleTimeout: cdk.Duration.seconds(60),
    });

    // HTTP :80 — permanent redirect to HTTPS
    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
        permanent: true,
      }),
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'Certificate',
      props.certificateArn,
    );

    // ── Blue Target Group (initially active) ─────────────────────────────────────
    this.blueTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueTargetGroup', {
      targetGroupName: `${envName}-blue-tg`,
      vpc: props.vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
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

    // ── Green Target Group (replacement during deployments) ──────────────────────
    this.greenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'GreenTargetGroup', {
      targetGroupName: `${envName}-green-tg`,
      vpc: props.vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
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

    // ── Production Listener :443 (serves Blue TG initially) ──────────────────────
    this.productionListener = this.alb.addListener('ProductionListener', {
      port: 443,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED,
      defaultAction: elbv2.ListenerAction.forward([this.blueTargetGroup]),
    });

    // ── Test Listener :8443 (smoke-test Green TG before traffic cutover) ─────────
    this.testListener = this.alb.addListener('TestListener', {
      port: 8443,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED,
      defaultAction: elbv2.ListenerAction.forward([this.greenTargetGroup]),
    });

    // ── ECS Fargate Service — CodeDeploy controller ───────────────────────────────
    // DeploymentControllerType.CODE_DEPLOY disables ECS rolling updates entirely;
    // all deployments go through CodeDeploy which manages the Blue/Green swap.
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `${envName}-bg-service`,
      cluster: this.cluster,
      taskDefinition,
      desiredCount,
      assignPublicIp: false,
      securityGroups: [this.taskSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      deploymentController: { type: ecs.DeploymentControllerType.CODE_DEPLOY },
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });

    // Attach the service to the blue target group so initial tasks register
    this.service.attachToApplicationTargetGroup(this.blueTargetGroup);

    // ── CodeDeploy Application ────────────────────────────────────────────────────
    this.codeDeployApp = new codedeploy.EcsApplication(this, 'CodeDeployApplication', {
      applicationName: `${envName}-ecs-app`,
    });

    // ── CloudWatch Alarm — ALB 5xx rate triggers auto-rollback ────────────────────
    const alb5xxAlarm = new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmName: `${envName}-bg-alb-5xx-rollback`,
      alarmDescription: 'Triggers CodeDeploy rollback when ALB 5xx count is elevated during deployment',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_ELB_5XX_Count',
        dimensionsMap: { LoadBalancer: this.alb.loadBalancerFullName },
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const rollbackAlarms: cloudwatch.IAlarm[] = [
      alb5xxAlarm,
      ...(props.rollbackAlarmArns ?? []).map((arn, i) =>
        cloudwatch.Alarm.fromAlarmArn(this, `RollbackAlarm${i}`, arn),
      ),
    ];

    // ── CodeDeploy Deployment Group ───────────────────────────────────────────────
    this.deploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'DeploymentGroup', {
      deploymentGroupName: `${envName}-ecs-dg`,
      application: this.codeDeployApp,
      service: this.service,
      blueGreenDeploymentConfig: {
        blueTargetGroup: this.blueTargetGroup,
        greenTargetGroup: this.greenTargetGroup,
        listener: this.productionListener,
        testListener: this.testListener,
        terminationWaitTime: cdk.Duration.minutes(terminationWaitMinutes),
        deploymentApprovalWaitTime: cdk.Duration.minutes(deploymentApprovalWaitMinutes),
      },
      deploymentConfig,
      alarms: rollbackAlarms,
      autoRollback: {
        failedDeployment: true,
        deploymentInAlarm: true,
        stoppedDeployment: true,
      },
    });

    // ── Tags ──────────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── CloudFormation Outputs ────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'Blue/green ALB DNS name — create a CNAME pointing your domain here',
      exportName: `${envName}-bg-alb-dns`,
    });

    new cdk.CfnOutput(this, 'CodeDeployApplicationName', {
      value: this.codeDeployApp.applicationName,
      description: 'CodeDeploy application name — set in workflow as codedeploy-application',
      exportName: `${envName}-codedeploy-app-name`,
    });

    new cdk.CfnOutput(this, 'CodeDeployDeploymentGroupName', {
      value: this.deploymentGroup.deploymentGroupName,
      description: 'CodeDeploy deployment group name — set in workflow as codedeploy-deployment-group',
      exportName: `${envName}-codedeploy-dg-name`,
    });

    new cdk.CfnOutput(this, 'TestListenerPort', {
      value: '8443',
      description: 'Test listener port — smoke-test the Green environment before cutover',
      exportName: `${envName}-bg-test-listener-port`,
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS Cluster name',
      exportName: `${envName}-bg-cluster-name`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: 'ECS Service name (uses CodeDeploy controller)',
      exportName: `${envName}-bg-service-name`,
    });
  }
}
