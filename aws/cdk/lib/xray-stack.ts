import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as xray from 'aws-cdk-lib/aws-xray';
import { Construct } from 'constructs';

export interface XRayStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** ECS cluster name — used in the X-Ray group filter expression */
  readonly clusterName: string;
  /** ECS service name — used in the X-Ray group filter expression */
  readonly serviceName: string;
  /**
   * ECS task role to grant X-Ray daemon write permissions.
   * Pass EcsStack.service.taskDefinition.taskRole, or use
   * iam.Role.fromRoleArn() for cross-stack / cross-account scenarios.
   */
  readonly taskRole: iam.IRole;
  /**
   * Fraction of requests to sample (0–1, default: 0.05 = 5 %).
   * Production: keep low (1–5 %) to control costs.
   * Staging: higher is fine (10–50 %) for better visibility.
   */
  readonly samplingRate?: number;
  /**
   * Reservoir of requests per second that bypass the sampling rate cap.
   * Ensures at least this many traces per second regardless of traffic (default: 10).
   */
  readonly reservoirSize?: number;
  /** Enable X-Ray Insights for automatic anomaly detection (default: false) */
  readonly insightsEnabled?: boolean;
}

/**
 * X-Ray tracing infrastructure for Express and FastAPI services on ECS Fargate.
 *
 * What this stack provisions:
 *   - X-Ray service group scoped to the ECS service for filtered console views
 *   - Custom sampling rule (reservoir + fixed-rate) to control trace volume
 *   - X-Ray daemon write permissions on the ECS task role
 *
 * What you must do in your ECS task definition (see addDaemonSidecar below):
 *   1. Add the X-Ray daemon as a sidecar container
 *   2. Set AWS_XRAY_DAEMON_ADDRESS=localhost:2000 in your app container
 *
 * Application-level integration:
 *   - Express: see tracing/express-xray.ts
 *   - FastAPI: see tracing/fastapi-xray.py
 */
export class XRayStack extends cdk.Stack {
  public readonly group: xray.CfnGroup;
  public readonly samplingRule: xray.CfnSamplingRule;

  /**
   * Add the X-Ray daemon as a sidecar container to a Fargate task definition.
   *
   * Call this on the FargateTaskDefinition BEFORE calling addContainer for your
   * app container so the daemon starts first.
   *
   * Usage (inside EcsStack or app.ts after exposing taskDefinition):
   *   XRayStack.addDaemonSidecar(taskDefinition);
   *   appContainer.addContainerDependencies({
   *     container: daemonContainer,
   *     condition: ecs.ContainerDependencyCondition.START,
   *   });
   *
   * Remember to set this environment variable on your app container:
   *   AWS_XRAY_DAEMON_ADDRESS=localhost:2000
   */
  static addDaemonSidecar(
    taskDefinition: ecs.FargateTaskDefinition,
    opts: { cpuUnits?: number; memoryMiB?: number } = {},
  ): ecs.ContainerDefinition {
    return taskDefinition.addContainer('XRayDaemon', {
      containerName: 'xray-daemon',
      image: ecs.ContainerImage.fromRegistry(
        'public.ecr.aws/xray/aws-xray-daemon:latest',
      ),
      cpu: opts.cpuUnits ?? 32,
      memoryLimitMiB: opts.memoryMiB ?? 256,
      portMappings: [
        // UDP — receives trace segments from the app
        { containerPort: 2000, protocol: ecs.Protocol.UDP },
      ],
      command: ['--bind', '0.0.0.0:2000'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'xray-daemon',
      }),
      essential: false,
      readonlyRootFilesystem: false,
      healthCheck: {
        command: ['CMD-SHELL', 'curl -s http://localhost:2000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });
  }

  constructor(scope: Construct, id: string, props: XRayStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const samplingRate = props.samplingRate ?? 0.05;
    const reservoirSize = props.reservoirSize ?? 10;
    const insightsEnabled = props.insightsEnabled ?? false;

    // ── IAM: grant task role X-Ray daemon write access ────────────────────────
    // The daemon sidecar needs these permissions to forward segments to the
    // X-Ray service and retrieve sampling rules at startup.
    props.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'XRayDaemonWrite',
        effect: iam.Effect.ALLOW,
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
          'xray:GetSamplingStatisticSummaries',
        ],
        resources: ['*'],
      }),
    );

    // ── X-Ray Group ───────────────────────────────────────────────────────────
    // Scopes the X-Ray console "service map" view to this ECS service.
    // Filter expression uses the annotation set by the SDK middleware.
    this.group = new xray.CfnGroup(this, 'ServiceGroup', {
      groupName: `${envName}-${props.serviceName}`,
      filterExpression: `annotation.environment = "${envName}" AND annotation.service = "${props.serviceName}"`,
      insightsConfiguration: {
        insightsEnabled,
        notificationsEnabled: insightsEnabled,
      },
    });

    // ── X-Ray Sampling Rule ───────────────────────────────────────────────────
    // Priority 1000 catches all requests for this service; adjust as needed.
    // Health-check paths are typically excluded (see reservoirSize + rate docs).
    this.samplingRule = new xray.CfnSamplingRule(this, 'SamplingRule', {
      samplingRule: {
        ruleName: `${envName}-${props.serviceName}-rule`,
        priority: 1000,
        reservoirSize,
        fixedRate: samplingRate,
        host: '*',
        httpMethod: '*',
        resourceArn: '*',
        serviceName: props.serviceName,
        serviceType: 'AWS::ECS::Container',
        urlPath: '*',
        version: 1,
      },
    });

    // Health-check exclusion rule — higher priority (lower number) to skip /health
    new xray.CfnSamplingRule(this, 'HealthCheckExclusionRule', {
      samplingRule: {
        ruleName: `${envName}-${props.serviceName}-health-check-exclude`,
        priority: 100,
        reservoirSize: 0,
        fixedRate: 0,
        host: '*',
        httpMethod: 'GET',
        resourceArn: '*',
        serviceName: props.serviceName,
        serviceType: 'AWS::ECS::Container',
        urlPath: '/health',
        version: 1,
      },
    });

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'XRayGroupName', {
      value: this.group.groupName ?? `${envName}-${props.serviceName}`,
      description: 'X-Ray service group name for filtered console views',
      exportName: `${envName}-xray-group-name`,
    });

    new cdk.CfnOutput(this, 'XRaySamplingRuleName', {
      value: this.samplingRule.attrRuleName,
      description: 'X-Ray sampling rule name',
      exportName: `${envName}-xray-sampling-rule-name`,
    });

    new cdk.CfnOutput(this, 'XRayDaemonAddress', {
      value: 'localhost:2000',
      description:
        'Set AWS_XRAY_DAEMON_ADDRESS to this value in your app container environment',
      exportName: `${envName}-xray-daemon-address`,
    });
  }
}
