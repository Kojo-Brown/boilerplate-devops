import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/**
 * What the analyzer does when the canary served too little traffic to judge.
 *
 *   fail — roll back. A canary nobody exercised has not been shown to be safe,
 *          and promoting it silently is the exact failure this stack exists to
 *          prevent. This is the default.
 *   pass — promote anyway. Only appropriate for genuinely low-traffic
 *          environments where waiting for `minimumRequestCount` would stall
 *          every deployment.
 */
export type InconclusiveVerdict = 'fail' | 'pass';

/** Latency statistic the analyzer compares against its thresholds. */
export type LatencyStatistic = 'p50' | 'p90' | 'p95' | 'p99';

/**
 * Thresholds the automatic analysis judges each bake window against.
 *
 * Two kinds of check run at every step, and either one failing rolls the
 * deployment back:
 *
 *   Absolute — the canary must stay under a fixed error rate and latency.
 *              Catches a canary that is broken on its own terms.
 *   Relative — the canary must stay within a multiple of what the stable
 *              target group is serving in the same window. Catches a canary
 *              that is worse than what it replaces during an incident that is
 *              already pushing both above their absolute ceilings.
 */
export interface CanaryAnalysisConfig {
  /** Maximum canary 5xx rate, as a percentage of canary requests (default: 1). */
  readonly maxErrorRatePercent?: number;
  /** Maximum canary latency in milliseconds at `latencyStatistic` (default: 1000). */
  readonly maxLatencyMs?: number;
  /**
   * How many times the stable error rate the canary may reach before failing
   * (default: 2 — twice as many errors as stable is a regression).
   */
  readonly errorRateToleranceMultiplier?: number;
  /**
   * How many times the stable latency the canary may reach before failing
   * (default: 1.5).
   */
  readonly latencyToleranceMultiplier?: number;
  /**
   * Requests the canary must have served in the bake window before the
   * analysis is considered meaningful (default: 100). Below this the verdict is
   * decided by `inconclusiveVerdict` rather than by the measurements.
   */
  readonly minimumRequestCount?: number;
  /** Verdict for a window with too few requests (default: fail). */
  readonly inconclusiveVerdict?: InconclusiveVerdict;
  /** Latency percentile to threshold on (default: p95). */
  readonly latencyStatistic?: LatencyStatistic;
}

export interface CanaryDeployStackProps extends cdk.StackProps {
  /** VPC to deploy into (from VpcStack) */
  readonly vpc: ec2.IVpc;
  /** ACM certificate ARN for the HTTPS listener */
  readonly certificateArn: string;
  /** Environment name used for resource naming (default: production) */
  readonly envName?: string;
  /** Container image URI (default: nginx stable-alpine for bootstrapping) */
  readonly containerImage?: string;
  /** Port the container listens on (default: 3000) */
  readonly containerPort?: number;
  /** Fargate CPU units (default: 512) */
  readonly cpu?: number;
  /** Fargate memory in MiB (default: 1024) */
  readonly memoryLimitMiB?: number;
  /** Task count for the stable service (default: 2) */
  readonly stableDesiredCount?: number;
  /**
   * Task count for the canary service while a deployment is in flight
   * (default: 1). The canary is scaled back to zero once the deployment
   * finishes, so this is not steady-state capacity.
   */
  readonly canaryDesiredCount?: number;
  /** ALB health-check path (default: /health) */
  readonly healthCheckPath?: string;
  /**
   * Percentages of production traffic sent to the canary, in order. Each step
   * is shifted, baked, and analyzed before the next one begins
   * (default: [10, 25, 50]).
   *
   * The list describes the *canary* side only; the stable target group always
   * receives the remainder. A trailing 100 is not needed — promotion moves the
   * new revision onto the stable service rather than parking all traffic on the
   * canary service, which only runs `canaryDesiredCount` tasks.
   */
  readonly trafficSteps?: number[];
  /** Seconds to hold each traffic step before analyzing it (default: 300) */
  readonly bakeTimeSeconds?: number;
  /** Seconds between service-stability polls (default: 30) */
  readonly healthCheckIntervalSeconds?: number;
  /**
   * How many stability polls to allow before giving up and rolling back
   * (default: 20 — 10 minutes at the default interval).
   */
  readonly maxHealthCheckAttempts?: number;
  /** Thresholds for the automatic analysis */
  readonly analysis?: CanaryAnalysisConfig;
  /** Email addresses notified when a canary deployment succeeds or rolls back */
  readonly notificationEmails?: string[];
  /**
   * Reserved concurrency for the controller and analyzer Lambdas (default: 5).
   * Bounds what a runaway state machine can take from the account pool.
   */
  readonly lambdaReservedConcurrency?: number;
}

/**
 * Canary deployment on weighted ALB target groups, with automatic analysis.
 *
 * Architecture:
 *   Internet → ALB → HTTPS :443 listener
 *                      ├─ weight (100 − w) → Stable TG → stable ECS service
 *                      └─ weight        w  → Canary TG → canary ECS service
 *
 * A Step Functions state machine owns the deployment:
 *
 *   1. Record the revision the stable service is currently running.
 *   2. Point the canary service at the new task definition and scale it up.
 *   3. Poll until the canary service is stable and its targets are healthy.
 *   4. For each step in `trafficSteps`:
 *        shift the listener weights → bake → analyze the window →
 *        PASS continues, anything else rolls back.
 *   5. Promote: move the stable service onto the new task definition, wait for
 *      it, then reset weights to 100/0 and scale the canary back to zero.
 *   6. Publish the outcome to SNS either way.
 *
 * Rollback restores the weights to 100/0, scales the canary to zero, and — if
 * promotion had already run — puts the stable service back on the revision
 * recorded in step 1. That last part is what makes a late failure safe: without
 * it, handing all traffic back to "stable" would hand it to the revision being
 * rolled back.
 *
 * How this differs from `BlueGreenDeployStack`:
 *
 *   Blue/green hands traffic shifting to CodeDeploy, which shifts on a fixed
 *   schedule and only reacts to CloudWatch *alarms* — a binary signal on a
 *   threshold someone guessed in advance. This stack shifts traffic itself and
 *   judges each window by comparing the canary target group against the stable
 *   one over the same interval, so a regression is caught relative to what the
 *   deployment is actually replacing. That comparison is what "automatic
 *   analysis" means here, and it is why the weights live on the listener rather
 *   than inside a CodeDeploy deployment group.
 *
 *   Use blue/green when you want an instant, whole-fleet cutover with a fast
 *   rollback. Use this when you want a regression caught on 10% of traffic
 *   before the other 90% ever sees it.
 *
 * Operational note — listener weights and CloudFormation drift:
 *   The weights set here are the *initial* ones (100 stable / 0 canary). The
 *   state machine mutates them at runtime through the ELBv2 API, so the
 *   deployed listener legitimately drifts from this template while a
 *   deployment is in flight. A `cdk deploy` during that window resets the
 *   listener to 100/0 — traffic snaps back to stable, which is the safe
 *   direction, but the in-flight execution will then analyze a canary that is
 *   no longer receiving traffic and roll it back. Do not deploy this stack
 *   while a canary execution is running.
 */
export class CanaryDeployStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly stableService: ecs.FargateService;
  public readonly canaryService: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly productionListener: elbv2.ApplicationListener;
  public readonly stableTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly canaryTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly stateMachine: sfn.StateMachine;
  public readonly notificationTopic: sns.Topic;
  /** Drives traffic shifting, service updates, promotion, and rollback */
  public readonly controllerFunction: lambda.Function;
  /** Judges each bake window against the configured thresholds */
  public readonly analyzerFunction: lambda.Function;
  /** Security group attached to Fargate tasks */
  public readonly taskSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: CanaryDeployStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const containerPort = props.containerPort ?? 3000;
    const cpu = props.cpu ?? 512;
    const memoryLimitMiB = props.memoryLimitMiB ?? 1024;
    const stableDesiredCount = props.stableDesiredCount ?? 2;
    const canaryDesiredCount = props.canaryDesiredCount ?? 1;
    const healthCheckPath = props.healthCheckPath ?? '/health';
    const trafficSteps = props.trafficSteps ?? [10, 25, 50];
    const bakeTimeSeconds = props.bakeTimeSeconds ?? 300;
    const healthCheckIntervalSeconds = props.healthCheckIntervalSeconds ?? 30;
    const maxHealthCheckAttempts = props.maxHealthCheckAttempts ?? 20;
    const lambdaReservedConcurrency = props.lambdaReservedConcurrency ?? 5;

    const analysis = props.analysis ?? {};
    const maxErrorRatePercent = analysis.maxErrorRatePercent ?? 1;
    const maxLatencyMs = analysis.maxLatencyMs ?? 1000;
    const errorRateToleranceMultiplier = analysis.errorRateToleranceMultiplier ?? 2;
    const latencyToleranceMultiplier = analysis.latencyToleranceMultiplier ?? 1.5;
    const minimumRequestCount = analysis.minimumRequestCount ?? 100;
    const inconclusiveVerdict = analysis.inconclusiveVerdict ?? 'fail';
    const latencyStatistic = analysis.latencyStatistic ?? 'p95';

    // ── Prop validation ─────────────────────────────────────────────────────────
    // These are all mistakes that would otherwise surface as a stuck or
    // silently-useless deployment rather than a synth-time error.
    if (trafficSteps.length === 0) {
      throw new Error('CanaryDeployStack: trafficSteps must contain at least one step');
    }
    if (trafficSteps.some((step) => !Number.isInteger(step) || step <= 0 || step >= 100)) {
      throw new Error(
        'CanaryDeployStack: every trafficSteps entry must be an integer between 1 and 99 ' +
          '(the stable target group always keeps the remainder, so 100 is not a valid step)',
      );
    }
    if (trafficSteps.some((step, i) => i > 0 && step <= trafficSteps[i - 1])) {
      throw new Error('CanaryDeployStack: trafficSteps must be strictly increasing');
    }
    if (canaryDesiredCount < 1) {
      throw new Error('CanaryDeployStack: canaryDesiredCount must be at least 1');
    }
    if (maxErrorRatePercent < 0 || maxErrorRatePercent > 100) {
      throw new Error('CanaryDeployStack: maxErrorRatePercent must be between 0 and 100');
    }

    // Physical names are bound once here: the IAM policies below scope
    // themselves to these exact ARNs, and the controller Lambda addresses the
    // services by name, so a rename has to happen in one place.
    const clusterName = `${envName}-canary-cluster`;
    const stableServiceName = `${envName}-stable-service`;
    const canaryServiceName = `${envName}-canary-service`;

    // ── ECS Cluster ─────────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName,
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ── Encryption key for logs and Lambda configuration ────────────────────────
    // One customer-managed key covers every log group in the stack and both
    // Lambdas' environment variables. The deployment logs record which revision
    // went to which percentage of production traffic and why it was rolled
    // back, which is exactly the operational history worth keeping out of a
    // plaintext-by-default store. CDK attaches the CloudWatch Logs service
    // grant and the Lambda decrypt grant to the key policy for us.
    const encryptionKey = new kms.Key(this, 'CanaryEncryptionKey', {
      alias: `alias/${envName}-canary-deployment`,
      description: `Encrypts canary deployment logs and Lambda configuration (${envName})`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── CloudWatch Log Group ────────────────────────────────────────────────────
    // Both services log here; the ECS log stream prefix distinguishes them, so a
    // single Log Insights query can compare stable and canary output side by side.
    const taskLogGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: `/ecs/${envName}/canary`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── IAM Roles for the tasks ─────────────────────────────────────────────────
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `${envName}-canary-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
      description: 'ECS task execution role for canary deployments',
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${envName}-canary-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime permissions for the canary/stable application container',
    });

    // ── Task Definition ─────────────────────────────────────────────────────────
    // One family serves both services. A deployment registers a new revision of
    // it and the state machine moves the canary service, then the stable
    // service, onto that revision.
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${envName}-canary-task`,
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
      logging: ecs.LogDrivers.awsLogs({ logGroup: taskLogGroup, streamPrefix: 'app' }),
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

    // ── Security Groups ─────────────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      securityGroupName: `${envName}-canary-alb-sg`,
      vpc: props.vpc,
      description: 'Canary ALB: HTTP redirect + HTTPS inbound',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet (redirected)');
    albSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP from internet IPv6 (redirected)');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS production listener');
    albSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS production listener IPv6');

    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      securityGroupName: `${envName}-canary-task-sg`,
      vpc: props.vpc,
      description: 'ECS canary/stable tasks: allow inbound from ALB on container port',
      allowAllOutbound: true,
    });
    this.taskSecurityGroup.addIngressRule(
      albSg,
      ec2.Port.tcp(containerPort),
      'From ALB on container port',
    );
    albSg.addEgressRule(this.taskSecurityGroup, ec2.Port.tcp(containerPort), 'To ECS tasks');

    // ── Application Load Balancer ───────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${envName}-canary-alb`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      deletionProtection: envName === 'production',
      idleTimeout: cdk.Duration.seconds(60),
    });

    // Headers the ALB cannot parse are dropped rather than forwarded, so a
    // malformed header cannot be smuggled past the load balancer into a target.
    this.alb.setAttribute('routing.http.drop_invalid_header_fields.enabled', 'true');

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

    const targetGroupHealthCheck: elbv2.HealthCheck = {
      path: healthCheckPath,
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      healthyHttpCodes: '200',
    };

    this.stableTargetGroup = new elbv2.ApplicationTargetGroup(this, 'StableTargetGroup', {
      targetGroupName: `${envName}-stable-tg`,
      vpc: props.vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: targetGroupHealthCheck,
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    this.canaryTargetGroup = new elbv2.ApplicationTargetGroup(this, 'CanaryTargetGroup', {
      targetGroupName: `${envName}-canary-tg`,
      vpc: props.vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: targetGroupHealthCheck,
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ── Production listener: weighted forward across both target groups ─────────
    // Stickiness is deliberately left off. Weighted stickiness pins a session to
    // whichever group it first landed on, which turns a 10% traffic split into
    // 10% of *sessions* seeing only the canary for the whole deployment — the
    // opposite of the broad, shallow exposure a canary is for, and it biases the
    // per-request metrics the analyzer reads.
    this.productionListener = this.alb.addListener('ProductionListener', {
      port: 443,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: elbv2.ListenerAction.weightedForward([
        { targetGroup: this.stableTargetGroup, weight: 100 },
        { targetGroup: this.canaryTargetGroup, weight: 0 },
      ]),
    });

    // ── ECS Services ────────────────────────────────────────────────────────────
    // Both use the ECS rolling controller: traffic shifting is this stack's job,
    // not the deployment controller's. The circuit breaker still guards the
    // task-level rollout (an image that will not start), which is a different
    // failure from the metric regression the analyzer looks for.
    this.stableService = new ecs.FargateService(this, 'StableService', {
      serviceName: stableServiceName,
      cluster: this.cluster,
      taskDefinition,
      desiredCount: stableDesiredCount,
      assignPublicIp: false,
      securityGroups: [this.taskSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      // The ECS default of 50% would drop the stable service to half capacity
      // during promotion — while the canary is still only running
      // `canaryDesiredCount` tasks, so the fleet as a whole would be down.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });
    this.stableService.attachToApplicationTargetGroup(this.stableTargetGroup);

    // Starts at zero tasks: the canary service only exists while a deployment is
    // in flight, and paying for idle canary capacity between deployments buys
    // nothing.
    this.canaryService = new ecs.FargateService(this, 'CanaryService', {
      serviceName: canaryServiceName,
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: false,
      securityGroups: [this.taskSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });
    this.canaryService.attachToApplicationTargetGroup(this.canaryTargetGroup);

    // ── SNS notifications ───────────────────────────────────────────────────────
    this.notificationTopic = new sns.Topic(this, 'CanaryNotificationTopic', {
      topicName: `${envName}-canary-deployment-notifications`,
      displayName: `${envName} Canary Deployment Notifications`,
      // Server-side encryption with the AWS-managed SNS key. An alias reference
      // costs nothing and needs no key policy, unlike a customer-managed key.
      masterKey: kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns'),
    });

    for (const email of props.notificationEmails ?? []) {
      this.notificationTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    // ── Controller Lambda ───────────────────────────────────────────────────────
    const controllerLogGroup = new logs.LogGroup(this, 'ControllerLogGroup', {
      logGroupName: `/aws/lambda/${envName}-canary-controller`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const controllerRole = new iam.Role(this, 'ControllerRole', {
      roleName: `${envName}-canary-controller-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Traffic shifting and service updates for ${envName} canary deployments`,
    });
    controllerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    controllerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ShiftListenerWeights',
        actions: ['elasticloadbalancing:ModifyListener'],
        resources: [this.productionListener.listenerArn],
      }),
    );

    // Describe* on ELBv2 does not support resource-level permissions — the API
    // rejects any ARN in the resource element — so the wildcard is required by
    // the service, not chosen for convenience. Scoped to read-only Describe
    // calls; every mutating action above is pinned to a specific ARN.
    controllerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadListenerAndTargetHealth',
        actions: [
          'elasticloadbalancing:DescribeListeners',
          'elasticloadbalancing:DescribeTargetGroups',
          'elasticloadbalancing:DescribeTargetHealth',
        ],
        resources: ['*'],
      }),
    );

    // Built from the literal names rather than from `service.serviceName`, which
    // is a CloudFormation ref: an ARN interpolated from a ref renders as an
    // opaque Fn::Join that neither a reviewer nor a test can read.
    const serviceArn = (serviceName: string) =>
      cdk.Stack.of(this).formatArn({
        service: 'ecs',
        resource: 'service',
        resourceName: `${clusterName}/${serviceName}`,
      });

    controllerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UpdateCanaryAndStableServices',
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: [serviceArn(stableServiceName), serviceArn(canaryServiceName)],
      }),
    );

    // UpdateService with a task definition the caller did not register still
    // requires PassRole for the roles that task definition names.
    controllerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassTaskRoles',
        actions: ['iam:PassRole'],
        resources: [executionRole.roleArn, taskRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );

    this.controllerFunction = new lambda.Function(this, 'ControllerFunction', {
      functionName: `${envName}-canary-controller`,
      description: `Shifts ALB weights and updates ECS services for ${envName} canary deployments`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: controllerRole,
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: lambdaReservedConcurrency,
      environmentEncryption: encryptionKey,
      logGroup: controllerLogGroup,
      environment: {
        LISTENER_ARN: this.productionListener.listenerArn,
        STABLE_TARGET_GROUP_ARN: this.stableTargetGroup.targetGroupArn,
        CANARY_TARGET_GROUP_ARN: this.canaryTargetGroup.targetGroupArn,
        CLUSTER_NAME: this.cluster.clusterName,
        STABLE_SERVICE_NAME: this.stableService.serviceName,
        CANARY_SERVICE_NAME: this.canaryService.serviceName,
        CANARY_DESIRED_COUNT: String(canaryDesiredCount),
        ENV_NAME: envName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(CONTROLLER_SOURCE),
    });

    // ── Analyzer Lambda ─────────────────────────────────────────────────────────
    const analyzerLogGroup = new logs.LogGroup(this, 'AnalyzerLogGroup', {
      logGroupName: `/aws/lambda/${envName}-canary-analyzer`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const analyzerRole = new iam.Role(this, 'AnalyzerRole', {
      roleName: `${envName}-canary-analyzer-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Reads CloudWatch metrics to judge ${envName} canary bake windows`,
    });
    analyzerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    // cloudwatch:GetMetricData has no resource-level permissions — metrics are
    // not resources — so this wildcard is imposed by the API. The role holds no
    // other permission, and the call is read-only.
    analyzerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCanaryMetrics',
        actions: ['cloudwatch:GetMetricData'],
        resources: ['*'],
      }),
    );

    this.analyzerFunction = new lambda.Function(this, 'AnalyzerFunction', {
      functionName: `${envName}-canary-analyzer`,
      description: `Compares canary and stable target-group metrics for ${envName}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: analyzerRole,
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: lambdaReservedConcurrency,
      environmentEncryption: encryptionKey,
      logGroup: analyzerLogGroup,
      environment: {
        LOAD_BALANCER_FULL_NAME: this.alb.loadBalancerFullName,
        STABLE_TARGET_GROUP_FULL_NAME: this.stableTargetGroup.targetGroupFullName,
        CANARY_TARGET_GROUP_FULL_NAME: this.canaryTargetGroup.targetGroupFullName,
        MAX_ERROR_RATE_PERCENT: String(maxErrorRatePercent),
        MAX_LATENCY_MS: String(maxLatencyMs),
        ERROR_RATE_TOLERANCE_MULTIPLIER: String(errorRateToleranceMultiplier),
        LATENCY_TOLERANCE_MULTIPLIER: String(latencyToleranceMultiplier),
        MINIMUM_REQUEST_COUNT: String(minimumRequestCount),
        INCONCLUSIVE_VERDICT: inconclusiveVerdict,
        LATENCY_STATISTIC: latencyStatistic,
        ENV_NAME: envName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(ANALYZER_SOURCE),
    });

    // ── Checkov exemptions, recorded on the resources they apply to ─────────────
    // These two checks do not describe a risk this stack carries, and the
    // exemption is written into the synthesized template rather than into the
    // repository baseline so that it travels with the resource into whatever
    // account this gets copied to — where a reviewer can see the reasoning
    // next to the thing being exempted.
    for (const fn of [this.controllerFunction, this.analyzerFunction]) {
      (fn.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
        skip: [
          {
            id: 'CKV_AWS_116',
            comment:
              'No DLQ: a Lambda DLQ only captures asynchronous invocations, and both ' +
              'functions are invoked synchronously by Step Functions. Failures are ' +
              'retried by the task and then caught into the rollback path, which is ' +
              'where a failed invocation needs to go — a DLQ would silently swallow it.',
          },
          {
            id: 'CKV_AWS_117',
            comment:
              'Not in a VPC: both functions call only regional control-plane APIs ' +
              '(ELBv2, ECS, CloudWatch) and touch no VPC resource. Attaching them to ' +
              'the VPC would require a NAT gateway or three interface endpoints to ' +
              'reach those APIs, adding cost and failure modes for no isolation gain.',
          },
        ],
      });
    }

    // ── CloudWatch alarms on the canary target group ────────────────────────────
    // The analyzer is the gate; these alarms are the out-of-band signal for
    // humans and for anything else subscribed to the topic. They watch the
    // canary target group specifically, so they stay quiet between deployments
    // when it has no targets.
    const canaryDimensions = {
      TargetGroup: this.canaryTargetGroup.targetGroupFullName,
      LoadBalancer: this.alb.loadBalancerFullName,
    };

    const canary5xxAlarm = new cloudwatch.Alarm(this, 'Canary5xxAlarm', {
      alarmName: `${envName}-canary-5xx`,
      alarmDescription: 'Canary target group is returning 5xx responses',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_Target_5XX_Count',
        dimensionsMap: canaryDimensions,
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const canaryLatencyAlarm = new cloudwatch.Alarm(this, 'CanaryLatencyAlarm', {
      alarmName: `${envName}-canary-latency`,
      alarmDescription: `Canary target group ${latencyStatistic} latency is above ${maxLatencyMs}ms`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'TargetResponseTime',
        dimensionsMap: canaryDimensions,
        statistic: latencyStatistic,
        period: cdk.Duration.minutes(1),
      }),
      // TargetResponseTime is published in seconds; the prop is in milliseconds.
      threshold: maxLatencyMs / 1000,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const snsAction = new cloudwatch_actions.SnsAction(this.notificationTopic);
    for (const alarm of [canary5xxAlarm, canaryLatencyAlarm]) {
      alarm.addAlarmAction(snsAction);
    }

    // ── State machine ───────────────────────────────────────────────────────────
    const invokeController = (
      stateId: string,
      payload: Record<string, unknown>,
      resultPath: string,
    ) =>
      new tasks.LambdaInvoke(this, stateId, {
        lambdaFunction: this.controllerFunction,
        payload: sfn.TaskInput.fromObject(payload),
        payloadResponseOnly: true,
        resultPath,
      }).addRetry({
        errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout'],
        interval: cdk.Duration.seconds(5),
        maxAttempts: 3,
        backoffRate: 2,
      });

    // Rollback path. Nothing here carries a catch back to itself: if the
    // rollback call fails we still want the notification to go out, so the
    // failure is caught into the notification rather than retried forever.
    const rollback = invokeController(
      'Rollback',
      {
        action: 'rollback',
        // Captured by CaptureStableBaseline before anything is mutated, so a
        // rollback that happens after promotion puts the stable service back on
        // the revision it was running when the deployment started.
        'stableTaskDefinitionArn.$': '$.stableBaseline.taskDefinitionArn',
      },
      '$.rollback',
    );

    const notifyFailure = new tasks.SnsPublish(this, 'NotifyFailure', {
      topic: this.notificationTopic,
      subject: `[${envName.toUpperCase()}] Canary deployment rolled back`,
      message: sfn.TaskInput.fromJsonPathAt('$'),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const deploymentFailed = new sfn.Fail(this, 'DeploymentFailed', {
      error: 'CanaryDeploymentFailed',
      cause: 'Canary analysis failed or the canary never became healthy; traffic was restored to the stable target group.',
    });

    rollback.addCatch(notifyFailure, { errors: ['States.ALL'], resultPath: '$.rollbackError' });
    rollback.next(notifyFailure);
    notifyFailure.next(deploymentFailed);

    /** Route any unexpected error in `state` through the rollback path. */
    const catchToRollback = (state: sfn.TaskStateBase): sfn.TaskStateBase =>
      state.addCatch(rollback, { errors: ['States.ALL'], resultPath: '$.error' });

    // 1. Record what stable is running before anything changes. This is the
    //    first state, and it is the one state that does not catch into
    //    rollback: nothing has been mutated yet, so there is nothing to undo,
    //    and rollback itself depends on the value this produces.
    const captureBaseline = invokeController(
      'CaptureStableBaseline',
      { action: 'baseline' },
      '$.stableBaseline',
    );
    captureBaseline.addCatch(notifyFailure, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    // 2. Point the canary service at the new revision and scale it up.
    const deployCanary = invokeController(
      'DeployCanary',
      {
        action: 'deploy',
        'taskDefinitionArn.$': '$.taskDefinitionArn',
      },
      '$.deploy',
    );
    catchToRollback(deployCanary);

    // 3. Poll the canary service until it is stable and its targets are healthy.
    //    `attempts` is threaded through the Lambda so the loop is bounded
    //    without a separate counter state.
    const initCanaryHealth = new sfn.Pass(this, 'InitCanaryHealth', {
      result: sfn.Result.fromObject({ attempts: 0, stable: false }),
      resultPath: '$.health',
    });

    const waitForCanary = new sfn.Wait(this, 'WaitForCanary', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(healthCheckIntervalSeconds)),
    });

    const checkCanaryHealth = invokeController(
      'CheckCanaryHealth',
      {
        action: 'health',
        target: 'canary',
        'attempts.$': '$.health.attempts',
      },
      '$.health',
    );
    catchToRollback(checkCanaryHealth);

    const canaryHealthy = new sfn.Choice(this, 'IsCanaryHealthy');

    // 4. Traffic steps: shift → bake → analyze → decide.
    const stepStates = trafficSteps.map((weight) => ({
      weight,
      shift: catchToRollback(
        invokeController('ShiftTo' + weight + 'Percent', { action: 'shift', canaryWeight: weight }, '$.shift'),
      ),
      bake: new sfn.Wait(this, 'BakeAt' + weight + 'Percent', {
        time: sfn.WaitTime.duration(cdk.Duration.seconds(bakeTimeSeconds)),
      }),
      analyze: catchToRollback(
        new tasks.LambdaInvoke(this, 'AnalyzeAt' + weight + 'Percent', {
          lambdaFunction: this.analyzerFunction,
          payload: sfn.TaskInput.fromObject({
            canaryWeight: weight,
            windowSeconds: bakeTimeSeconds,
          }),
          payloadResponseOnly: true,
          resultPath: '$.analysis',
        }).addRetry({
          errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout'],
          interval: cdk.Duration.seconds(5),
          maxAttempts: 3,
          backoffRate: 2,
        }),
      ),
      verdict: new sfn.Choice(this, 'VerdictAt' + weight + 'Percent'),
    }));

    // 5. Promotion: move the stable service onto the new revision, wait for it,
    //    then hand all traffic back to stable and retire the canary tasks.
    const promote = invokeController(
      'PromoteToStable',
      {
        action: 'promote',
        'taskDefinitionArn.$': '$.taskDefinitionArn',
      },
      '$.promote',
    );
    catchToRollback(promote);

    const initStableHealth = new sfn.Pass(this, 'InitStableHealth', {
      result: sfn.Result.fromObject({ attempts: 0, stable: false }),
      resultPath: '$.health',
    });

    const waitForStable = new sfn.Wait(this, 'WaitForStable', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(healthCheckIntervalSeconds)),
    });

    const checkStableHealth = invokeController(
      'CheckStableHealth',
      {
        action: 'health',
        target: 'stable',
        'attempts.$': '$.health.attempts',
      },
      '$.health',
    );
    catchToRollback(checkStableHealth);

    const stableHealthy = new sfn.Choice(this, 'IsStableHealthy');

    const resetTraffic = invokeController('ResetTraffic', { action: 'reset' }, '$.reset');
    catchToRollback(resetTraffic);

    const notifySuccess = new tasks.SnsPublish(this, 'NotifySuccess', {
      topic: this.notificationTopic,
      subject: `[${envName.toUpperCase()}] Canary deployment promoted`,
      message: sfn.TaskInput.fromJsonPathAt('$'),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const deploymentSucceeded = new sfn.Succeed(this, 'DeploymentSucceeded');

    // ── Wire the graph ──────────────────────────────────────────────────────────
    captureBaseline.next(deployCanary);
    deployCanary.next(initCanaryHealth);
    initCanaryHealth.next(waitForCanary);
    waitForCanary.next(checkCanaryHealth);
    checkCanaryHealth.next(canaryHealthy);
    canaryHealthy
      .when(sfn.Condition.booleanEquals('$.health.stable', true), stepStates[0].shift)
      .when(
        sfn.Condition.numberGreaterThanEquals('$.health.attempts', maxHealthCheckAttempts),
        rollback,
      )
      .otherwise(waitForCanary);

    stepStates.forEach((step, index) => {
      step.shift.next(step.bake);
      step.bake.next(step.analyze);
      step.analyze.next(step.verdict);
      const onPass = index + 1 < stepStates.length ? stepStates[index + 1].shift : promote;
      step.verdict
        .when(sfn.Condition.stringEquals('$.analysis.verdict', 'PASS'), onPass)
        .otherwise(rollback);
    });

    promote.next(initStableHealth);
    initStableHealth.next(waitForStable);
    waitForStable.next(checkStableHealth);
    checkStableHealth.next(stableHealthy);
    stableHealthy
      .when(sfn.Condition.booleanEquals('$.health.stable', true), resetTraffic)
      .when(
        sfn.Condition.numberGreaterThanEquals('$.health.attempts', maxHealthCheckAttempts),
        rollback,
      )
      .otherwise(waitForStable);

    resetTraffic.next(notifySuccess);
    notifySuccess.next(deploymentSucceeded);

    const stateMachineLogGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      // Step Functions requires the /aws/vendedlogs/ prefix to deliver its logs.
      logGroupName: `/aws/vendedlogs/states/${envName}-canary-deployment`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Worst case: every health poll is used up before the canary stabilises,
    // every step bakes in full, and the stable service takes the same number of
    // polls to come up. Doubling that leaves room for Lambda retries without
    // letting a wedged execution run indefinitely.
    const worstCaseSeconds =
      2 * maxHealthCheckAttempts * healthCheckIntervalSeconds +
      trafficSteps.length * (bakeTimeSeconds + 120);

    this.stateMachine = new sfn.StateMachine(this, 'CanaryDeploymentStateMachine', {
      stateMachineName: `${envName}-canary-deployment`,
      definitionBody: sfn.DefinitionBody.fromChainable(captureBaseline),
      timeout: cdk.Duration.seconds(2 * worstCaseSeconds),
      tracingEnabled: true,
      logs: {
        destination: stateMachineLogGroup,
        level: sfn.LogLevel.ALL,
        // The execution payload is task-definition ARNs and metric readings —
        // no secrets — and seeing the analyzer's numbers is the whole point when
        // reconstructing why a deployment rolled back.
        includeExecutionData: true,
      },
    });

    // ── Tags ────────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── CloudFormation Outputs ──────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'Canary ALB DNS name — create a CNAME pointing your domain here',
      exportName: `${envName}-canary-alb-dns`,
    });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description: 'Canary deployment state machine ARN — set as CANARY_STATE_MACHINE_ARN',
      exportName: `${envName}-canary-state-machine-arn`,
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS cluster name',
      exportName: `${envName}-canary-cluster-name`,
    });

    new cdk.CfnOutput(this, 'StableServiceName', {
      value: this.stableService.serviceName,
      description: 'ECS service serving stable traffic',
      exportName: `${envName}-canary-stable-service-name`,
    });

    new cdk.CfnOutput(this, 'CanaryServiceName', {
      value: this.canaryService.serviceName,
      description: 'ECS service serving canary traffic (scaled to zero between deployments)',
      exportName: `${envName}-canary-canary-service-name`,
    });

    new cdk.CfnOutput(this, 'TaskDefinitionFamily', {
      value: taskDefinition.family,
      description: 'Task definition family — the deploy workflow registers new revisions of this',
      exportName: `${envName}-canary-task-family`,
    });

    new cdk.CfnOutput(this, 'NotificationTopicArn', {
      value: this.notificationTopic.topicArn,
      description: 'SNS topic ARN for canary deployment outcomes',
      exportName: `${envName}-canary-notification-topic-arn`,
    });

    new cdk.CfnOutput(this, 'TrafficSteps', {
      value: trafficSteps.join(','),
      description: 'Canary traffic percentages, in the order they are applied',
      exportName: `${envName}-canary-traffic-steps`,
    });
  }
}

/**
 * Controller Lambda source.
 *
 * One function handles every mutating step so that the listener-weight format,
 * the service names, and the "what does healthy mean" definition live in one
 * place instead of being restated by five near-identical functions.
 *
 * Actions:
 *   deploy   — point the canary service at a task definition and scale it up
 *   health   — one bounded poll of a service's rollout and target health
 *   shift    — set the listener's canary/stable weights
 *   promote  — point the stable service at the task definition
 *   baseline — record the revision the stable service is running
 *   reset    — all traffic to stable, canary scaled to zero (success path)
 *   rollback — reset, plus undo the promotion if it already happened
 *
 * Exported so the unit tests can load and exercise the handler directly. Inline
 * Lambda code is otherwise only ever validated at deploy time, which is far too
 * late to learn that a decision branch is wrong.
 */
export const CONTROLLER_SOURCE = `
'use strict';
const {
  ElasticLoadBalancingV2Client,
  ModifyListenerCommand,
  DescribeTargetHealthCommand,
} = require('@aws-sdk/client-elastic-load-balancing-v2');
const { ECSClient, UpdateServiceCommand, DescribeServicesCommand } = require('@aws-sdk/client-ecs');

const region = process.env.AWS_REGION;
const elbv2 = new ElasticLoadBalancingV2Client({ region });
const ecs = new ECSClient({ region });

const LISTENER_ARN = process.env.LISTENER_ARN;
const STABLE_TG_ARN = process.env.STABLE_TARGET_GROUP_ARN;
const CANARY_TG_ARN = process.env.CANARY_TARGET_GROUP_ARN;
const CLUSTER_NAME = process.env.CLUSTER_NAME;
const STABLE_SERVICE_NAME = process.env.STABLE_SERVICE_NAME;
const CANARY_SERVICE_NAME = process.env.CANARY_SERVICE_NAME;
const CANARY_DESIRED_COUNT = parseInt(process.env.CANARY_DESIRED_COUNT, 10);

/**
 * Set the listener's default action to a weighted forward across both target
 * groups. ModifyListener replaces the default action wholesale, so both groups
 * are always restated — omitting one would drop it from the listener entirely.
 */
async function setWeights(canaryWeight) {
  const stableWeight = 100 - canaryWeight;
  await elbv2.send(new ModifyListenerCommand({
    ListenerArn: LISTENER_ARN,
    DefaultActions: [
      {
        Type: 'forward',
        ForwardConfig: {
          TargetGroups: [
            { TargetGroupArn: STABLE_TG_ARN, Weight: stableWeight },
            { TargetGroupArn: CANARY_TG_ARN, Weight: canaryWeight },
          ],
        },
      },
    ],
  }));
  return { canaryWeight, stableWeight };
}

async function updateService(serviceName, options) {
  await ecs.send(new UpdateServiceCommand(Object.assign({
    cluster: CLUSTER_NAME,
    service: serviceName,
  }, options)));
}

/**
 * A service is healthy when ECS reports exactly one deployment in COMPLETED
 * rollout state with its full task count running, and the ALB reports every
 * registered target healthy. Both halves matter: ECS can call a rollout
 * complete while the ALB is still failing its health checks.
 */
async function checkHealth(serviceName, targetGroupArn) {
  const described = await ecs.send(new DescribeServicesCommand({
    cluster: CLUSTER_NAME,
    services: [serviceName],
  }));
  const service = (described.services || [])[0];
  if (!service) {
    return { stable: false, reason: 'SERVICE_NOT_FOUND', serviceName };
  }

  const deployments = service.deployments || [];
  const primary = deployments.find((d) => d.status === 'PRIMARY');
  const rolloutState = primary ? primary.rolloutState : 'UNKNOWN';
  const runningCount = service.runningCount || 0;
  const desiredCount = service.desiredCount || 0;

  // A failed circuit breaker is terminal — ECS has already rolled the task
  // definition back and no amount of further polling will change the outcome.
  if (rolloutState === 'FAILED') {
    return {
      stable: false,
      terminal: true,
      reason: 'ROLLOUT_FAILED',
      serviceName,
      rolloutStateReason: primary ? primary.rolloutStateReason : undefined,
    };
  }

  const ecsSettled =
    deployments.length === 1 && rolloutState === 'COMPLETED' && runningCount >= desiredCount;

  if (!ecsSettled) {
    return {
      stable: false,
      reason: 'ECS_NOT_SETTLED',
      serviceName,
      rolloutState,
      runningCount,
      desiredCount,
      deploymentCount: deployments.length,
    };
  }

  const health = await elbv2.send(new DescribeTargetHealthCommand({
    TargetGroupArn: targetGroupArn,
  }));
  const descriptions = health.TargetHealthDescriptions || [];
  const healthy = descriptions.filter(
    (d) => d.TargetHealth && d.TargetHealth.State === 'healthy',
  ).length;

  if (descriptions.length === 0 || healthy !== descriptions.length) {
    return {
      stable: false,
      reason: 'TARGETS_NOT_HEALTHY',
      serviceName,
      healthyTargets: healthy,
      totalTargets: descriptions.length,
      runningCount,
      desiredCount,
    };
  }

  return {
    stable: true,
    reason: 'HEALTHY',
    serviceName,
    healthyTargets: healthy,
    totalTargets: descriptions.length,
    runningCount,
    desiredCount,
  };
}

exports.handler = async (event) => {
  console.log('Canary controller event:', JSON.stringify(event));
  const action = event.action;

  switch (action) {
    case 'deploy': {
      if (!event.taskDefinitionArn) {
        throw new Error('deploy requires taskDefinitionArn');
      }
      await updateService(CANARY_SERVICE_NAME, {
        taskDefinition: event.taskDefinitionArn,
        desiredCount: CANARY_DESIRED_COUNT,
        forceNewDeployment: true,
      });
      return {
        action,
        service: CANARY_SERVICE_NAME,
        taskDefinitionArn: event.taskDefinitionArn,
        desiredCount: CANARY_DESIRED_COUNT,
      };
    }

    case 'health': {
      const isStable = event.target === 'stable';
      const serviceName = isStable ? STABLE_SERVICE_NAME : CANARY_SERVICE_NAME;
      const targetGroupArn = isStable ? STABLE_TG_ARN : CANARY_TG_ARN;
      const attempts = (typeof event.attempts === 'number' ? event.attempts : 0) + 1;
      const result = await checkHealth(serviceName, targetGroupArn);
      // A terminal failure short-circuits the polling loop by reporting the
      // attempt budget as spent, which sends the state machine to rollback now
      // rather than after the remaining waits.
      const reportedAttempts = result.terminal ? Number.MAX_SAFE_INTEGER : attempts;
      console.log('Health check:', JSON.stringify(Object.assign({ attempts }, result)));
      return Object.assign({ attempts: reportedAttempts }, result);
    }

    case 'shift': {
      const canaryWeight = event.canaryWeight;
      if (typeof canaryWeight !== 'number' || canaryWeight < 0 || canaryWeight > 100) {
        throw new Error('shift requires a canaryWeight between 0 and 100');
      }
      const weights = await setWeights(canaryWeight);
      console.log('Shifted traffic:', JSON.stringify(weights));
      return Object.assign({ action }, weights);
    }

    case 'promote': {
      if (!event.taskDefinitionArn) {
        throw new Error('promote requires taskDefinitionArn');
      }
      await updateService(STABLE_SERVICE_NAME, {
        taskDefinition: event.taskDefinitionArn,
        forceNewDeployment: true,
      });
      return {
        action,
        service: STABLE_SERVICE_NAME,
        taskDefinitionArn: event.taskDefinitionArn,
      };
    }

    case 'baseline': {
      // The stable service's revision before anything is touched. Rollback
      // needs it: once promotion has run, sending all traffic back to stable
      // would otherwise mean sending it to the revision being rolled back.
      const described = await ecs.send(new DescribeServicesCommand({
        cluster: CLUSTER_NAME,
        services: [STABLE_SERVICE_NAME],
      }));
      const service = (described.services || [])[0];
      if (!service) {
        throw new Error('Stable service not found: ' + STABLE_SERVICE_NAME);
      }
      return { action, service: STABLE_SERVICE_NAME, taskDefinitionArn: service.taskDefinition };
    }

    case 'reset':
    case 'rollback': {
      // Weights first: stop sending traffic to the canary before its tasks are
      // torn out from under in-flight requests.
      const weights = await setWeights(0);
      await updateService(CANARY_SERVICE_NAME, { desiredCount: 0 });

      // On the rollback path, undo the promotion if it already happened.
      // Without this, restoring 100% of traffic to stable would restore it to
      // the very revision that just failed analysis.
      let stableRestoredTo = null;
      if (action === 'rollback' && event.stableTaskDefinitionArn) {
        const described = await ecs.send(new DescribeServicesCommand({
          cluster: CLUSTER_NAME,
          services: [STABLE_SERVICE_NAME],
        }));
        const service = (described.services || [])[0];
        if (service && service.taskDefinition !== event.stableTaskDefinitionArn) {
          await updateService(STABLE_SERVICE_NAME, {
            taskDefinition: event.stableTaskDefinitionArn,
            forceNewDeployment: true,
          });
          stableRestoredTo = event.stableTaskDefinitionArn;
          console.log('Reverted stable service to ' + stableRestoredTo);
        }
      }

      console.log(action + ' complete:', JSON.stringify(weights));
      return Object.assign({ action, canaryScaledTo: 0, stableRestoredTo }, weights);
    }

    default:
      throw new Error('Unknown action: ' + String(action));
  }
};
`;

/**
 * Analyzer Lambda source.
 *
 * Reads one bake window of ALB target-group metrics for both groups in a single
 * GetMetricData call and returns PASS or FAIL with the reasons and the readings
 * behind the decision. The state machine only branches on `verdict`; everything
 * else exists so that a rollback can be explained after the fact from the
 * execution history.
 *
 * Exported for the same reason as CONTROLLER_SOURCE: this is the logic the
 * whole item turns on, and it is worth testing against known metric windows
 * rather than trusting it to a production rollback.
 */
export const ANALYZER_SOURCE = `
'use strict';
const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });

const LB = process.env.LOAD_BALANCER_FULL_NAME;
const STABLE_TG = process.env.STABLE_TARGET_GROUP_FULL_NAME;
const CANARY_TG = process.env.CANARY_TARGET_GROUP_FULL_NAME;

const MAX_ERROR_RATE_PERCENT = parseFloat(process.env.MAX_ERROR_RATE_PERCENT);
const MAX_LATENCY_MS = parseFloat(process.env.MAX_LATENCY_MS);
const ERROR_RATE_TOLERANCE = parseFloat(process.env.ERROR_RATE_TOLERANCE_MULTIPLIER);
const LATENCY_TOLERANCE = parseFloat(process.env.LATENCY_TOLERANCE_MULTIPLIER);
const MINIMUM_REQUEST_COUNT = parseFloat(process.env.MINIMUM_REQUEST_COUNT);
const INCONCLUSIVE_VERDICT = process.env.INCONCLUSIVE_VERDICT;
const LATENCY_STATISTIC = process.env.LATENCY_STATISTIC;

const round = (value, places) => {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
};

function metricQuery(id, targetGroup, metricName, stat, period) {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ApplicationELB',
        MetricName: metricName,
        Dimensions: [
          { Name: 'TargetGroup', Value: targetGroup },
          { Name: 'LoadBalancer', Value: LB },
        ],
      },
      Period: period,
      Stat: stat,
    },
    ReturnData: true,
  };
}

/**
 * Sum every datapoint in the window. GetMetricData returns one value per
 * period, and the window may span several periods when the bake time is long.
 */
const sumValues = (result) => (result && result.Values ? result.Values : []).reduce((a, b) => a + b, 0);

/**
 * Average the per-period percentile values. Averaging percentiles is not itself
 * a percentile, but across the handful of equal-length periods in one bake
 * window it is a fair summary and avoids a second query per period.
 */
const averageValues = (result) => {
  const values = result && result.Values ? result.Values : [];
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
};

const maxValue = (result) => {
  const values = result && result.Values ? result.Values : [];
  return values.length === 0 ? 0 : Math.max.apply(null, values);
};

exports.handler = async (event) => {
  console.log('Canary analysis request:', JSON.stringify(event));

  const windowSeconds = typeof event.windowSeconds === 'number' ? event.windowSeconds : 300;
  // GetMetricData periods must be a multiple of 60 for a window this long.
  const period = Math.max(60, Math.floor(windowSeconds / 60) * 60);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - windowSeconds * 1000);

  const response = await cloudwatch.send(new GetMetricDataCommand({
    StartTime: startTime,
    EndTime: endTime,
    ScanBy: 'TimestampAscending',
    MetricDataQueries: [
      metricQuery('canaryRequests', CANARY_TG, 'RequestCount', 'Sum', period),
      metricQuery('canaryErrors', CANARY_TG, 'HTTPCode_Target_5XX_Count', 'Sum', period),
      metricQuery('canaryLatency', CANARY_TG, 'TargetResponseTime', LATENCY_STATISTIC, period),
      metricQuery('canaryUnhealthy', CANARY_TG, 'UnHealthyHostCount', 'Maximum', period),
      metricQuery('stableRequests', STABLE_TG, 'RequestCount', 'Sum', period),
      metricQuery('stableErrors', STABLE_TG, 'HTTPCode_Target_5XX_Count', 'Sum', period),
      metricQuery('stableLatency', STABLE_TG, 'TargetResponseTime', LATENCY_STATISTIC, period),
    ],
  }));

  const byId = {};
  for (const result of response.MetricDataResults || []) {
    byId[result.Id] = result;
  }

  const canaryRequests = sumValues(byId.canaryRequests);
  const canaryErrors = sumValues(byId.canaryErrors);
  const stableRequests = sumValues(byId.stableRequests);
  const stableErrors = sumValues(byId.stableErrors);
  const canaryUnhealthy = maxValue(byId.canaryUnhealthy);

  // TargetResponseTime is published in seconds; every threshold here is in ms.
  const canaryLatencySeconds = averageValues(byId.canaryLatency);
  const stableLatencySeconds = averageValues(byId.stableLatency);
  const canaryLatencyMs = canaryLatencySeconds === null ? null : canaryLatencySeconds * 1000;
  const stableLatencyMs = stableLatencySeconds === null ? null : stableLatencySeconds * 1000;

  const canaryErrorRate = canaryRequests > 0 ? (canaryErrors / canaryRequests) * 100 : 0;
  const stableErrorRate = stableRequests > 0 ? (stableErrors / stableRequests) * 100 : 0;

  const metrics = {
    windowSeconds,
    canaryWeight: event.canaryWeight,
    canaryRequests,
    canaryErrors,
    canaryErrorRatePercent: round(canaryErrorRate, 4),
    canaryLatencyMs: canaryLatencyMs === null ? null : round(canaryLatencyMs, 2),
    canaryUnhealthyHosts: canaryUnhealthy,
    stableRequests,
    stableErrors,
    stableErrorRatePercent: round(stableErrorRate, 4),
    stableLatencyMs: stableLatencyMs === null ? null : round(stableLatencyMs, 2),
    latencyStatistic: LATENCY_STATISTIC,
  };

  const reasons = [];

  if (canaryUnhealthy > 0) {
    reasons.push(canaryUnhealthy + ' canary target(s) reported unhealthy during the window');
  }

  // Too little traffic to judge. Reported before the threshold checks so the
  // verdict is never a false PASS built on two requests.
  if (canaryRequests < MINIMUM_REQUEST_COUNT) {
    const inconclusiveReason =
      'canary served ' + canaryRequests + ' requests, below the minimum of ' +
      MINIMUM_REQUEST_COUNT + ' needed to judge the window';
    const verdict = INCONCLUSIVE_VERDICT === 'pass' && reasons.length === 0 ? 'PASS' : 'FAIL';
    reasons.push(inconclusiveReason);
    const outcome = {
      verdict,
      inconclusive: true,
      reasons,
      metrics,
    };
    console.log('Canary analysis outcome:', JSON.stringify(outcome));
    return outcome;
  }

  if (canaryErrorRate > MAX_ERROR_RATE_PERCENT) {
    reasons.push(
      'canary error rate ' + round(canaryErrorRate, 3) + '% exceeds the maximum of ' +
      MAX_ERROR_RATE_PERCENT + '%',
    );
  }

  // Relative check: only meaningful once stable has served enough traffic for
  // its own rate to mean something.
  if (stableRequests >= MINIMUM_REQUEST_COUNT && stableErrorRate > 0 &&
      canaryErrorRate > stableErrorRate * ERROR_RATE_TOLERANCE) {
    reasons.push(
      'canary error rate ' + round(canaryErrorRate, 3) + '% is more than ' + ERROR_RATE_TOLERANCE +
      'x the stable rate of ' + round(stableErrorRate, 3) + '%',
    );
  }

  if (canaryLatencyMs !== null && canaryLatencyMs > MAX_LATENCY_MS) {
    reasons.push(
      'canary ' + LATENCY_STATISTIC + ' latency ' + round(canaryLatencyMs, 1) +
      'ms exceeds the maximum of ' + MAX_LATENCY_MS + 'ms',
    );
  }

  if (canaryLatencyMs !== null && stableLatencyMs !== null && stableLatencyMs > 0 &&
      stableRequests >= MINIMUM_REQUEST_COUNT &&
      canaryLatencyMs > stableLatencyMs * LATENCY_TOLERANCE) {
    reasons.push(
      'canary ' + LATENCY_STATISTIC + ' latency ' + round(canaryLatencyMs, 1) + 'ms is more than ' +
      LATENCY_TOLERANCE + 'x the stable latency of ' + round(stableLatencyMs, 1) + 'ms',
    );
  }

  const outcome = {
    verdict: reasons.length === 0 ? 'PASS' : 'FAIL',
    inconclusive: false,
    reasons,
    metrics,
  };
  console.log('Canary analysis outcome:', JSON.stringify(outcome));
  return outcome;
};
`;
