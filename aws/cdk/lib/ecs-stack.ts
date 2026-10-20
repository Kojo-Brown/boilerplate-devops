import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NGINX_PLACEHOLDER_IMAGE } from './base-images';
import {
  type SpotWorkload,
  assertValidSpotCatalogue,
  spotCapacityProviderStrategies,
  usesSpot,
} from './spot-capacity';

export interface EcsStackProps extends cdk.StackProps {
  /** VPC from VpcStack (required) */
  readonly vpc: ec2.IVpc;
  /** ACM certificate ARN for the HTTPS listener (required) */
  readonly certificateArn: string;
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** Container image URI (default: the pinned nginx placeholder, for bootstrapping) */
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
  /**
   * Capacity posture for this service, from `lib/spot-capacity.ts`.
   *
   * Omitted means what this stack has always done: `launchType: FARGATE`, every
   * task on on-demand capacity, no capacity provider associated with the cluster.
   * That is the posture `production-application` declares and it is the default
   * because it is the safe one — a service that gains Spot capacity by being
   * forgotten is the failure this whole item is about.
   *
   * Supplied with a Spot-bearing entry, the service gets that entry's capacity
   * provider strategy, the container gets the entry's `stopTimeout`, and the
   * target group gets its deregistration delay — all three out of the one
   * declaration, because the three numbers are only correct together. See
   * docs/spot.md.
   */
  readonly capacity?: SpotWorkload;
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
    const capacity = props.capacity;
    const onSpot = capacity !== undefined && usesSpot(capacity);

    // Offline arithmetic, so a posture that cannot be satisfied fails here
    // rather than at deploy time or, worse, never.
    if (capacity) assertValidSpotCatalogue([capacity]);

    // What this stack used before any of this existed, and still uses without a
    // Spot posture. Thirty seconds is long enough for an in-flight request to
    // finish and short enough to fit a Spot reclaim's two-minute budget twice
    // over.
    const deregistrationDelaySeconds =
      capacity?.drainBudget?.deregistrationDelaySeconds ?? 30;

    // ── ECS Cluster ───────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${envName}-cluster`,
      vpc: props.vpc,
      // Required by the starvation alarm in `SpotInterruptionStack`:
      // `RunningTaskCount` and `DesiredTaskCount` are Container Insights
      // metrics, and without them the one signal that catches a Spot shortage
      // has no inputs. It was already on for the dashboards.
      containerInsights: true,
    });

    // A Fargate capacity provider is account-wide and does nothing until it is
    // associated with a cluster — and a service naming `FARGATE_SPOT` on a
    // cluster that has not associated it is rejected at deploy time, after the
    // template has passed every gate in this repository. The association is
    // made only where a Spot posture asks for it, so the production cluster's
    // template is unchanged and `tools/audit-spot-capacity.ts` can hold the two
    // halves together rather than registering both everywhere and never
    // checking.
    if (onSpot) {
      this.cluster.enableFargateCapacityProviders();
    }

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
      // ── Prerequisites for `aws:ecs:task-network-latency` ──────────────────
      // Three properties, and all three have to be here for the latency
      // experiment in `lib/fis-experiments.ts` to be able to run at all. They
      // are in this stack because the task definition is, which is the whole
      // reason `tools/audit-fis-experiments.ts` exists: every combination of
      // them deploys cleanly, the service stays healthy, FIS resolves its
      // targets, and the experiment fails when somebody starts it — during the
      // exercise, in front of the people who booked the hour.
      //
      // `enableFaultInjection` is the one with a cost attached, so it is worth
      // being explicit: it lets a process inside the container reach the ECS
      // fault-injection endpoint, which is how FIS injects without an agent of
      // its own. It is set in every environment rather than staging only,
      // because a task definition that differs in shape between environments
      // means the latency experiment is rehearsed against something other than
      // what production runs — which is the failure the experiment exists to
      // rule out. See docs/chaos-engineering.md#5-what-the-latency-experiment-needs-from-this-stack.
      enableFaultInjection: true,
      // `pidMode: task` puts the task's containers in one process namespace,
      // which is what lets the injection reach the application's network
      // interface rather than only its own sidecar's.
      pidMode: ecs.PidMode.TASK,
      // Not optional alongside `pidMode`: CDK refuses a Fargate task definition
      // that sets one without the other ("Specifying 'pidMode' requires that
      // operating system family also be provided"), and AWS only supports
      // `pidMode: task` on Linux platform 1.4.0 or later. Stating the platform
      // explicitly also pins what had been an implicit default.
      //
      // X86_64 rather than ARM64 for one reason, and it is not this stack's:
      // `containerImage` is what `workflow-templates/docker-build-push.yml`
      // built, and that is a single-platform `docker build`. ARM64 here
      // synthesises, deploys, and then fails at task placement. This is the
      // largest Graviton saving in the repository and it is gated on the
      // pipeline — see docs/graviton.md §4.
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry(
        props.containerImage ?? NGINX_PLACEHOLDER_IMAGE.reference,
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
      // Only with a Spot posture, and then from the declared budget. ECS
      // defaults an unset `stopTimeout` to 30 seconds, which is a quarter of
      // the warning Spot gives and is a number nobody chose; on on-demand
      // capacity the task is stopped by a deployment or a scale-in, both of
      // which wait for the deregistration delay and neither of which has a
      // deadline, so the default is harmless there and setting it would be a
      // property added to a production template for a reason that does not
      // apply to it.
      ...(capacity?.drainBudget
        ? { stopTimeout: cdk.Duration.seconds(capacity.drainBudget.stopTimeoutSeconds) }
        : {}),
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
      // The circuit breaker and a Spot posture interact, and it is worth being
      // explicit about why this combination is still safe: the breaker counts
      // tasks that fail to reach a steady state during a deployment, and a
      // reclaim mid-deployment is one of those. What keeps a good release from
      // being rolled back by AWS reclaiming capacity is the on-demand `base` —
      // it is placed before any weight applies, so the breaker's minimum
      // healthy count can be met without Spot. A `spot-with-base` entry whose
      // base is zero is refused by `validateSpotCatalogue` for this reason as
      // much as for the starvation one.
      circuitBreaker: { rollback: true },
      enableExecuteCommand,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      ...(onSpot && capacity
        ? { capacityProviderStrategies: [...spotCapacityProviderStrategies(capacity)] }
        : {}),
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
      // Spent *before* `SIGTERM` on a Spot reclaim — ECS deregisters the target
      // first — so on a Spot posture this and the container's `stopTimeout` come
      // out of the same two minutes. The ELB default is 300 seconds, which
      // exceeds the whole window on its own.
      deregistrationDelay: cdk.Duration.seconds(deregistrationDelaySeconds),
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
