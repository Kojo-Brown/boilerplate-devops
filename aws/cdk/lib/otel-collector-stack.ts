import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { ADOT_COLLECTOR_IMAGE } from './base-images';
import {
  AgentConfigSpec,
  DEFAULT_TAIL_SAMPLING,
  HEALTH_CHECK_PORT,
  OTLP_GRPC_PORT,
  OTLP_HTTP_PORT,
  TailSamplingSpec,
  buildAgentConfig,
  buildSamplerConfig,
  metricNamespace,
  renderCollectorConfig,
} from './otel-collector-config';

/** Where a rendered collector config is handed to the container. */
const CONFIG_ENV_VAR = 'OTEL_CONFIG_CONTENT';

/**
 * Everything `OtelCollectorStack.addAgentSidecar` needs, as plain strings.
 *
 * Plain strings and not CDK tokens on purpose. Every value here is derived from
 * `envName` and is therefore knowable without reading the collector stack's
 * outputs, so an application stack can add the sidecar without a
 * `Fn::ImportValue` — and without the deployment ordering an export imposes,
 * which for two stacks that are deployed by different pipelines would mean the
 * collector stack could never be updated while an app stack referenced it.
 */
export interface AgentSidecarOptions {
  readonly envName: string;
  readonly namespaceName: string;
  readonly samplerServiceName: string;
  readonly metricsLogGroupName: string;
  /** CPU units for the sidecar, taken from the task's total (default: 128). */
  readonly cpuUnits?: number;
  /** Memory for the sidecar, in MiB (default: 512). */
  readonly memoryLimitMiB?: number;
}

export interface OtelCollectorStackProps extends cdk.StackProps {
  /** VPC from VpcStack (required) */
  readonly vpc: ec2.IVpc;
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /**
   * Security groups of the tasks whose agent sidecars forward to this tier.
   *
   * Pass `EcsStack.taskSecurityGroup`. Nothing else may reach the sampler's
   * OTLP port: it is unauthenticated, and a span is an assertion about what
   * happened that the backend will believe.
   */
  readonly clientSecurityGroups: readonly ec2.ISecurityGroup[];
  /** Sampler tasks. Fixed — see the note on auto-scaling below (default: 2). */
  readonly desiredCount?: number;
  /** Fargate CPU units for a sampler task (default: 1024) */
  readonly cpu?: number;
  /** Fargate memory in MiB for a sampler task (default: 2048) */
  readonly memoryLimitMiB?: number;
  /** Tail-sampling policy parameters (default: {@link DEFAULT_TAIL_SAMPLING}) */
  readonly sampling?: TailSamplingSpec;
  /** Span attributes promoted to X-Ray annotations so they can be filtered on */
  readonly indexedAttributes?: readonly string[];
  /** Topic the alarms below publish to — typically CloudWatchAlarmsStack's */
  readonly alarmTopic?: sns.ITopic;
  /**
   * Also alarm when the sampler tier receives no spans at all.
   *
   * Off by default, and that is not timidity: before the first application is
   * instrumented the tier legitimately receives nothing, and an alarm that is
   * red from the day it is created is one somebody silences. Turn it on once
   * traffic is arriving — at which point silence means the agents stopped
   * reaching this tier, which nothing else here detects.
   */
  readonly alarmOnNoTracesReceived?: boolean;
  /** Log retention for the collector's own logs (default: one month) */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * Tail-sampling OpenTelemetry Collector deployment: a sampler service on ECS
 * Fargate, plus the agent sidecar that feeds it.
 *
 * `lib/otel-collector-config.ts` carries the argument for why this is two tiers
 * and what the configurations mean. This file is the AWS half of it, and the
 * decisions worth knowing before reading are these:
 *
 * **The sampler tier does not auto-scale, deliberately.** Every other ECS
 * service in this repository does. Here the instances are the backends of a
 * consistent hash ring: adding or removing one re-points roughly 1/N of trace
 * IDs at a different instance, and for the length of one resolver interval the
 * agents disagree about which instance owns which trace — so the spans of a
 * trace in flight across that window are split, and both halves are decided on
 * a fragment. A scaling policy would do that automatically, at the traffic peak
 * that is also when the traces matter most, and it would never show up as an
 * error. Size the tier for the peak and change it deliberately; the refused-
 * spans alarm below is what tells you it is too small.
 *
 * **Registration is DNS, discovery is not.** The sampler registers into a Cloud
 * Map private DNS namespace because that is what ECS service discovery writes
 * into, and nothing resolves it by DNS — the agent's resolver calls
 * `DiscoverInstances`. Cloud Map's DNS answers come back as Route 53 multivalue
 * records, which are capped at eight, so a ninth sampler task would be invisible
 * to DNS and, worse, different agents would see different eights and build
 * different rings.
 *
 * What this stack does *not* do is instrument anything. The application has to
 * emit OTLP and has to stop head-sampling first — see
 * {@link OtelCollectorStack.appEnvironment} and `docs/otel-collector.md` §3.
 */
export class OtelCollectorStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly namespace: servicediscovery.PrivateDnsNamespace;
  /** Ingress on OTLP/gRPC is granted here to each client security group. */
  public readonly samplerSecurityGroup: ec2.SecurityGroup;
  /** Alarms created by this stack, in the order documented in §6. */
  public readonly alarms: readonly cloudwatch.Alarm[];
  /** Everything an application stack needs to add the agent sidecar. */
  public readonly agentSidecarOptions: AgentSidecarOptions;

  /* ── Names, derived from envName alone ─────────────────────────────────── */

  /** Cloud Map namespace for an environment's collector tier. */
  static namespaceName(envName: string): string {
    return `otel.${envName}.internal`;
  }

  /** Cloud Map service name the sampler tier registers under. */
  static samplerServiceName(): string {
    return 'sampler';
  }

  /** Log group both tiers publish their own metrics to, as EMF. */
  static metricsLogGroupName(envName: string): string {
    return `/ecs/${envName}/otel-collector-metrics`;
  }

  /**
   * Environment variables the *application* container needs.
   *
   * The second entry is the one that decides whether any of this works.
   * `OTEL_TRACES_SAMPLER` defaults to `parentbased_always_on` in the
   * specification, but every "how to reduce trace cost" guide sets it to
   * `parentbased_traceidratio` with a ratio, and `XRayStack` configures the
   * same reduction on the X-Ray side. Either one leaves the collector choosing
   * among the traces that survived head sampling: at 5% head sampling, "keep
   * every error" keeps every error *in the 5%*, which is 5% of errors. The
   * whole point of tail sampling is that the SDK stops deciding, so this is set
   * explicitly here rather than left to a default somebody will override.
   *
   * `OTEL_PROPAGATORS` includes `xray` because the ALB stamps `X-Amzn-Trace-Id`
   * on inbound requests and nothing else in this repository reads `traceparent`
   * — an app configured for W3C alone starts a new trace at every hop that only
   * speaks the X-Ray header.
   */
  static appEnvironment(options: {
    readonly serviceName: string;
    readonly envName: string;
  }): Record<string, string> {
    return {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${OTLP_GRPC_PORT}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      OTEL_TRACES_SAMPLER: 'parentbased_always_on',
      OTEL_PROPAGATORS: 'xray,tracecontext,baggage',
      OTEL_SERVICE_NAME: options.serviceName,
      OTEL_RESOURCE_ATTRIBUTES: `service.name=${options.serviceName},deployment.environment=${options.envName}`,
    };
  }

  /**
   * Add the collector agent as a sidecar to an application task definition.
   *
   * Call this on the application's `FargateTaskDefinition`; it adds the
   * container and the two permissions the agent needs on the task role. The
   * application container should then carry {@link appEnvironment} and declare
   * a dependency on this container so it does not start emitting into a socket
   * nothing is listening on:
   *
   *   const agent = OtelCollectorStack.addAgentSidecar(taskDefinition, opts);
   *   appContainer.addContainerDependencies({
   *     container: agent,
   *     condition: ecs.ContainerDependencyCondition.HEALTHY,
   *   });
   */
  static addAgentSidecar(
    taskDefinition: ecs.FargateTaskDefinition,
    options: AgentSidecarOptions,
  ): ecs.ContainerDefinition {
    const stack = cdk.Stack.of(taskDefinition);

    const agentConfig: AgentConfigSpec = {
      envName: options.envName,
      namespaceName: options.namespaceName,
      samplerServiceName: options.samplerServiceName,
      metricsLogGroupName: options.metricsLogGroupName,
    };

    // Resolving the backends is an AWS API call, and the SDK on ECS has no
    // region unless one is given: ECS sets the credential and metadata
    // variables in a task's environment but not AWS_REGION, and the resolver
    // falls back to a hard-coded us-east-1 default. In any other region that
    // means a healthy collector querying a namespace that does not exist,
    // resolving zero backends, and dropping every span — with a passing health
    // check and no error anywhere but the collector's own debug log.
    const environment: Record<string, string> = {
      AWS_REGION: stack.region,
      [CONFIG_ENV_VAR]: renderCollectorConfig(buildAgentConfig(agentConfig)),
    };

    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'OtelAgentDiscoverSamplers',
        effect: iam.Effect.ALLOW,
        actions: ['servicediscovery:DiscoverInstances'],
        // DiscoverInstances is addressed by namespace and service *name*, not
        // by ARN. It does accept `servicediscovery:NamespaceArn` as a condition
        // key, but the namespace's id is not knowable in this stack without an
        // import from the collector stack — which is the cross-stack coupling
        // AgentSidecarOptions exists to avoid. The action is read-only and
        // returns registered addresses. See docs/otel-collector.md §7.
        resources: ['*'],
      }),
    );

    const metricsLogGroupArn = stack.formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: `${options.metricsLogGroupName}:*`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'OtelAgentPublishOwnMetrics',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogStream',
          'logs:DescribeLogStreams',
          'logs:PutLogEvents',
        ],
        resources: [metricsLogGroupArn],
      }),
    );

    return taskDefinition.addContainer('OtelAgent', {
      containerName: 'otel-agent',
      image: ecs.ContainerImage.fromRegistry(ADOT_COLLECTOR_IMAGE.reference),
      cpu: options.cpuUnits ?? 128,
      memoryLimitMiB: options.memoryLimitMiB ?? 512,
      // The image's ENTRYPOINT is the collector and its CMD is a --config
      // pointing at the baked-in default, so overriding the command is what
      // replaces that default rather than adding to it.
      command: [`--config=env:${CONFIG_ENV_VAR}`],
      environment,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'otel-agent' }),
      healthCheck: {
        // The image is FROM scratch — no shell, so CMD-SHELL cannot work. It
        // ships a `/healthcheck` binary that probes the health_check extension
        // on its default port, which is why the agent config declares that
        // extension on exactly that port.
        command: ['CMD', '/healthcheck'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
      // Not essential: a collector that cannot start must not take the
      // application down with it. Losing traces is an incident; losing the
      // service because telemetry failed is a worse one.
      essential: false,
      readonlyRootFilesystem: true,
    });
  }

  constructor(scope: Construct, id: string, props: OtelCollectorStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const desiredCount = props.desiredCount ?? 2;
    const cpu = props.cpu ?? 1024;
    const memoryLimitMiB = props.memoryLimitMiB ?? 2048;
    const sampling = props.sampling ?? DEFAULT_TAIL_SAMPLING;
    const logRetention = props.logRetention ?? logs.RetentionDays.ONE_MONTH;
    const indexedAttributes = props.indexedAttributes ?? [
      'http.route',
      'http.response.status_code',
      'deployment.environment',
    ];

    if (props.clientSecurityGroups.length === 0) {
      // A sampler tier nothing may reach is a service that passes its health
      // check, costs two tasks, and receives nothing — and the only symptom is
      // an absence, which is the hardest thing to notice.
      throw new Error(
        `${id}: clientSecurityGroups is empty, so nothing can reach the sampler tier's OTLP ` +
          `port. Pass the security group of the tasks carrying the agent sidecar, normally ` +
          `EcsStack.taskSecurityGroup.`,
      );
    }

    const namespaceName = OtelCollectorStack.namespaceName(envName);
    const samplerServiceName = OtelCollectorStack.samplerServiceName();
    const metricsLogGroupName = OtelCollectorStack.metricsLogGroupName(envName);

    // ── Encryption key ────────────────────────────────────────────────────────
    // Traces are request data: paths, status codes, and whatever attributes an
    // application chose to attach. The collector's own logs quote them when it
    // rejects a batch, so the log groups here hold the same material the
    // database stacks encrypt.
    const encryptionKey = new kms.Key(this, 'CollectorEncryptionKey', {
      alias: `alias/${envName}-otel-collector`,
      description: `Encrypts OpenTelemetry collector logs and metrics (${envName})`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskLogGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: `/ecs/${envName}/otel-collector`,
      retention: logRetention,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The EMF log group is where both tiers' own metrics land. CloudWatch reads
    // the embedded metric format out of these log events and publishes the
    // metrics the alarms below read, so this log group is not a convenience:
    // deleting it stops the alarms having anything to evaluate.
    const metricsLogGroup = new logs.LogGroup(this, 'MetricsLogGroup', {
      logGroupName: metricsLogGroupName,
      retention: logRetention,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Cluster and service discovery ─────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${envName}-otel-cluster`,
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    this.namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: namespaceName,
      vpc: props.vpc,
      description: `Service discovery for the ${envName} OpenTelemetry collector tier`,
    });

    // ── IAM ───────────────────────────────────────────────────────────────────
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `${envName}-otel-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
      description: 'Allows ECS to pull the collector image and write task logs',
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${envName}-otel-sampler-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime permissions for the tail-sampling collector',
    });

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'XRaySegmentWrite',
        effect: iam.Effect.ALLOW,
        // None of these accept a resource ARN — X-Ray's write API is
        // account-scoped by design, which is why `Resource: "*"` here is the
        // only expressible form rather than an unscoped grant. GetSampling* is
        // absent deliberately: the sampler makes its decision from the trace,
        // not from an X-Ray sampling rule, and granting it would let the two
        // mechanisms silently both apply.
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'],
      }),
    );

    metricsLogGroup.grantWrite(taskRole);

    // ── Task definition ───────────────────────────────────────────────────────
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${envName}-otel-sampler`,
      cpu,
      memoryLimitMiB,
      executionRole,
      taskRole,
    });

    const samplerConfig = buildSamplerConfig({
      envName,
      sampling,
      metricsLogGroupName,
      indexedAttributes,
    });

    taskDefinition.addContainer('SamplerContainer', {
      containerName: 'otel-sampler',
      image: ecs.ContainerImage.fromRegistry(ADOT_COLLECTOR_IMAGE.reference),
      command: [`--config=env:${CONFIG_ENV_VAR}`],
      environment: {
        // Same reason as the agent's: the X-Ray and EMF exporters are AWS SDK
        // clients, and ECS does not put a region in a task's environment.
        AWS_REGION: this.region,
        [CONFIG_ENV_VAR]: renderCollectorConfig(samplerConfig),
      },
      portMappings: [{ containerPort: OTLP_GRPC_PORT, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: taskLogGroup,
        streamPrefix: 'sampler',
      }),
      healthCheck: {
        command: ['CMD', '/healthcheck'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
      essential: true,
      readonlyRootFilesystem: true,
    });

    // ── Network ───────────────────────────────────────────────────────────────
    this.samplerSecurityGroup = new ec2.SecurityGroup(this, 'SamplerSecurityGroup', {
      securityGroupName: `${envName}-otel-sampler-sg`,
      vpc: props.vpc,
      description: 'Tail-sampling collector: OTLP/gRPC from instrumented tasks only',
      // Outbound to the X-Ray, CloudWatch Logs and ECR endpoints, all HTTPS.
      allowAllOutbound: true,
    });

    for (const [index, clientSg] of props.clientSecurityGroups.entries()) {
      this.samplerSecurityGroup.addIngressRule(
        clientSg,
        ec2.Port.tcp(OTLP_GRPC_PORT),
        `OTLP/gRPC from agent sidecars (client ${index})`,
      );
    }

    // ── Service ───────────────────────────────────────────────────────────────
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `${envName}-otel-sampler`,
      cluster: this.cluster,
      taskDefinition,
      desiredCount,
      assignPublicIp: false,
      securityGroups: [this.samplerSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // 100, not the 50 the application services use. Replacing half the ring
      // at once re-points half the trace IDs; keeping every existing task while
      // the new ones come up means the ring only ever grows during a deploy,
      // and grows back down once draining finishes.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      cloudMapOptions: {
        name: samplerServiceName,
        cloudMapNamespace: this.namespace,
        // A records, not SRV: an A registration is one address per task, which
        // is what the resolver turns into a backend. It carries no port, hence
        // the explicit `port` in the resolver config.
        dnsRecordType: servicediscovery.DnsRecordType.A,
        // Short, and only relevant to anything resolving this by DNS — which
        // the agents do not. Kept low so a human debugging with `dig` sees the
        // same tasks the agents are using.
        dnsTtl: cdk.Duration.seconds(15),
      },
    });

    // Deliberately no `autoScaleTaskCount`. See the class comment: scaling this
    // tier reshapes the hash ring, and the traces in flight across that window
    // are decided on fragments.

    this.agentSidecarOptions = {
      envName,
      namespaceName,
      samplerServiceName,
      metricsLogGroupName,
    };

    // ── Alarms ────────────────────────────────────────────────────────────────
    // Every one of these is on a metric the collector publishes about itself,
    // because the failures this deployment has are all silent: a dropped trace
    // and a trace that was never sent look identical at the backend.
    const namespaceForMetrics = metricNamespace(envName);

    const collectorMetric = (
      metricName: string,
      statistic: string,
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: namespaceForMetrics,
        metricName,
        statistic,
        period: cdk.Duration.minutes(5),
      });

    const alarms: cloudwatch.Alarm[] = [];

    alarms.push(
      new cloudwatch.Alarm(this, 'TracesDroppedBeforeDecisionAlarm', {
        alarmName: `${envName}-otel-traces-dropped-before-decision`,
        alarmDescription:
          'The tail sampler evicted traces from its buffer before their decision timer ' +
          'fired, so they were dropped without any policy being applied to them. The ' +
          'buffer holds num_traces; raise it, shorten decision_wait, or add tasks. ' +
          'Nothing downstream records that these traces existed.',
        metric: collectorMetric(
          'otelcol_processor_tail_sampling_sampling_trace_dropped_too_early',
          'Sum',
        ),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        // No datapoints means the counter never incremented, which is the
        // healthy state for a counter that is zero when nothing is wrong.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    alarms.push(
      new cloudwatch.Alarm(this, 'SpansRefusedAlarm', {
        alarmName: `${envName}-otel-spans-refused`,
        alarmDescription:
          'The memory limiter refused spans, which is back-pressure: the sender either ' +
          'retried into a queue that will also fill, or dropped them. The tier is ' +
          'undersized for its arrival rate.',
        metric: collectorMetric('otelcol_processor_refused_spans', 'Sum'),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    alarms.push(
      new cloudwatch.Alarm(this, 'ExportFailuresAlarm', {
        alarmName: `${envName}-otel-export-failures`,
        alarmDescription:
          'An exporter gave up on spans after its retries. On an agent this is the ' +
          'sampler tier being unreachable; on the sampler it is X-Ray rejecting ' +
          'segments — most often because the SDK is not using the X-Ray id generator, ' +
          'so the timestamp embedded in the trace id is not a plausible one.',
        metric: collectorMetric('otelcol_exporter_send_failed_spans', 'Sum'),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    alarms.push(
      new cloudwatch.Alarm(this, 'NoSamplerBackendsAlarm', {
        alarmName: `${envName}-otel-no-sampler-backends`,
        alarmDescription:
          'An agent resolved zero sampler backends and is dropping every span it ' +
          'receives, while passing its health check. Check AWS_REGION on the sidecar, ' +
          'the Cloud Map namespace name, and the DiscoverInstances permission on the ' +
          'application task role. Note this cannot fire when no agent is reporting at ' +
          'all — that is what alarmOnNoTracesReceived is for.',
        metric: collectorMetric('otelcol_loadbalancer_num_backends', 'Minimum'),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    if (props.alarmOnNoTracesReceived ?? false) {
      alarms.push(
        new cloudwatch.Alarm(this, 'NoTracesReceivedAlarm', {
          alarmName: `${envName}-otel-no-traces-received`,
          alarmDescription:
            'The sampler tier accepted no spans for fifteen minutes. Either the agents ' +
            'stopped reaching it or the applications stopped emitting; both look ' +
            'identical from the backend, where the only evidence is an absence.',
          metric: collectorMetric('otelcol_receiver_accepted_spans', 'Sum'),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          evaluationPeriods: 3,
          // The one alarm here where missing data *is* the failure: a collector
          // publishing nothing is exactly the state this alarm is looking for.
          treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        }),
      );
    }

    if (props.alarmTopic) {
      const action = new cloudwatchActions.SnsAction(props.alarmTopic);
      for (const alarm of alarms) {
        alarm.addAlarmAction(action);
        alarm.addOkAction(action);
      }
    }

    this.alarms = alarms;

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'OtelNamespaceName', {
      value: namespaceName,
      description: 'Cloud Map namespace the agent sidecars resolve the sampler tier in',
      exportName: `${envName}-otel-namespace-name`,
    });

    new cdk.CfnOutput(this, 'OtelSamplerServiceName', {
      value: samplerServiceName,
      description: 'Cloud Map service name of the tail-sampling tier',
      exportName: `${envName}-otel-sampler-service-name`,
    });

    new cdk.CfnOutput(this, 'OtelAgentEndpoint', {
      value: `http://localhost:${OTLP_GRPC_PORT}`,
      description:
        'Set OTEL_EXPORTER_OTLP_ENDPOINT to this in the application container ' +
        `(OTLP/HTTP is on ${OTLP_HTTP_PORT}, health check on ${HEALTH_CHECK_PORT})`,
      exportName: `${envName}-otel-agent-endpoint`,
    });

    new cdk.CfnOutput(this, 'OtelMetricNamespace', {
      value: namespaceForMetrics,
      description: "CloudWatch namespace holding the collector's own metrics",
      exportName: `${envName}-otel-metric-namespace`,
    });
  }
}
