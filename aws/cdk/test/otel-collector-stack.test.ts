import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { VpcStack } from '../lib/vpc-stack';
import { OtelCollectorStack, OtelCollectorStackProps } from '../lib/otel-collector-stack';
import { ADOT_COLLECTOR_IMAGE } from '../lib/base-images';
import {
  DEFAULT_TAIL_SAMPLING,
  HEALTH_CHECK_PORT,
  OTLP_GRPC_PORT,
} from '../lib/otel-collector-config';
import { flattenIntrinsic, resourceProps } from './support/cfn';

const ENV = { account: '123456789012', region: 'eu-west-1' };

interface Harness {
  readonly template: Template;
  readonly stack: OtelCollectorStack;
  readonly clientSg: ec2.SecurityGroup;
  readonly app: cdk.App;
  readonly vpc: ec2.IVpc;
}

const makeStack = (
  overrides: Partial<OtelCollectorStackProps> = {},
  id = 'TestOtelCollectorStack',
): Harness => {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, 'TestVpcStack', {
    envName: 'staging',
    maxAzs: 2,
    natGateways: 1,
    env: ENV,
  });

  const clientSg = new ec2.SecurityGroup(vpcStack, 'ClientSecurityGroup', {
    vpc: vpcStack.vpc,
    description: 'Stands in for EcsStack.taskSecurityGroup',
  });

  const stack = new OtelCollectorStack(app, id, {
    vpc: vpcStack.vpc,
    envName: 'staging',
    clientSecurityGroups: [clientSg],
    env: ENV,
    ...overrides,
  });

  return { template: Template.fromStack(stack), stack, clientSg, app, vpc: vpcStack.vpc };
};

/** The sampler container definition, as synthesised. */
const samplerContainer = (template: Template): Record<string, unknown> => {
  const [taskDefinition] = resourceProps(template, 'AWS::ECS::TaskDefinition');
  const containers = taskDefinition.ContainerDefinitions as Record<string, unknown>[];
  return containers[0];
};

/** The collector config the container is started with, parsed back. */
const containerConfig = (
  container: Record<string, unknown>,
): Record<string, unknown> => {
  const environment = container.Environment as { Name: string; Value: string }[];
  const entry = environment.find((variable) => variable.Name === 'OTEL_CONFIG_CONTENT');
  if (!entry) throw new Error('container carries no OTEL_CONFIG_CONTENT');
  return JSON.parse(entry.Value) as Record<string, unknown>;
};

/* ── Wiring the tiers together ────────────────────────────────────────────── */

describe('OtelCollectorStack', () => {
  it('registers the sampler tier in Cloud Map under the name the agents resolve', () => {
    const { template, stack } = makeStack();

    template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'otel.staging.internal',
    });

    // A records rather than SRV. An A registration carries no port, which is
    // why the agent config sets the resolver's `port` explicitly — the two
    // decisions are one decision and drift apart silently.
    template.hasResourceProperties('AWS::ServiceDiscovery::Service', {
      Name: 'sampler',
      DnsConfig: Match.objectLike({
        DnsRecords: [Match.objectLike({ Type: 'A' })],
      }),
    });

    expect(stack.agentSidecarOptions).toEqual({
      envName: 'staging',
      namespaceName: 'otel.staging.internal',
      samplerServiceName: 'sampler',
      metricsLogGroupName: '/ecs/staging/otel-collector-metrics',
    });
  });

  // The names an application stack needs must be derivable from envName alone,
  // or adding the sidecar means importing an output — and a cross-stack export
  // cannot be changed while anything references it, which for two stacks on
  // different release cadences means the collector stack freezes.
  it('derives the agent options from envName without reading the stack', () => {
    const { stack } = makeStack();

    expect(stack.agentSidecarOptions.namespaceName).toBe(
      OtelCollectorStack.namespaceName('staging'),
    );
    expect(stack.agentSidecarOptions.metricsLogGroupName).toBe(
      OtelCollectorStack.metricsLogGroupName('staging'),
    );
    for (const value of Object.values(stack.agentSidecarOptions)) {
      expect(cdk.Token.isUnresolved(value)).toBe(false);
    }
  });

  it('admits OTLP only from the security groups it was given', () => {
    const { template, clientSg } = makeStack();

    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: OTLP_GRPC_PORT,
      ToPort: OTLP_GRPC_PORT,
      IpProtocol: 'tcp',
      SourceSecurityGroupId: Match.anyValue(),
    });

    // The OTLP endpoint is unauthenticated: a span is an assertion about what
    // happened that the backend will believe. So the rule must name a security
    // group and never a CIDR — `CidrIp` is how a rule reads as scoped in review
    // and is in fact open to whatever range somebody typed.
    const ingressRules = resourceProps(template, 'AWS::EC2::SecurityGroupIngress');
    expect(ingressRules).toHaveLength(1);
    expect(ingressRules[0].CidrIp).toBeUndefined();
    expect(ingressRules[0].CidrIpv6).toBeUndefined();
    expect(ingressRules[0].SourceSecurityGroupId).toBeDefined();
    expect(clientSg).toBeDefined();
  });

  it('refuses to synthesise a tier nothing can reach', () => {
    // Otherwise: a healthy service, two tasks of cost, and no traces — a
    // failure whose only symptom is an absence.
    expect(() => makeStack({ clientSecurityGroups: [] })).toThrow(
      /clientSecurityGroups is empty/,
    );
  });

  it('does not attach a scaling policy to the sampler tier', () => {
    // Scaling reshapes the consistent hash ring: for one resolver interval the
    // agents disagree about which instance owns which trace, so traces in
    // flight across that window are split and both halves are decided on a
    // fragment. Automating that would do it at the traffic peak.
    const { template } = makeStack();
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 0);
  });

  it('keeps every existing task through a deployment', () => {
    // minHealthyPercent 100, not the 50 the application services use: at 50
    // half the ring is replaced at once.
    const { template } = makeStack();
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 100 }),
    });
  });
});

/* ── The container ────────────────────────────────────────────────────────── */

describe('OtelCollectorStack sampler container', () => {
  const { template } = makeStack();
  const container = samplerContainer(template);

  it('runs the digest-pinned collector image', () => {
    expect(container.Image).toBe(ADOT_COLLECTOR_IMAGE.reference);
    expect(container.Image).toContain('@sha256:');
  });

  it('replaces the image default config rather than adding to it', () => {
    // The image's ENTRYPOINT is the collector and its CMD is a --config
    // pointing at a baked-in default, so overriding the command is what
    // displaces it.
    expect(container.Command).toEqual(['--config=env:OTEL_CONFIG_CONTENT']);
  });

  it('health-checks with the binary the image ships, not a shell', () => {
    // The image is FROM scratch. CMD-SHELL has no shell to run and the health
    // check fails forever, which ECS reports as an unhealthy task rather than
    // as a missing shell.
    expect(container.HealthCheck).toMatchObject({ Command: ['CMD', '/healthcheck'] });
  });

  it('exposes the health_check extension on the port that binary probes', () => {
    const config = containerConfig(container);
    const extensions = config.extensions as { health_check: { endpoint: string } };
    expect(extensions.health_check.endpoint).toBe(`0.0.0.0:${HEALTH_CHECK_PORT}`);
  });

  // ECS puts credentials and the metadata URI in a task's environment but not a
  // region, and the AWS SDK then falls back to a default. For the exporters
  // that means X-Ray in the wrong region.
  it('sets AWS_REGION explicitly', () => {
    const environment = container.Environment as { Name: string; Value: string }[];
    const region = environment.find((variable) => variable.Name === 'AWS_REGION');
    expect(region?.Value).toBe(ENV.region);
  });

  it('carries the validated tail-sampling config', () => {
    const config = containerConfig(container);
    const processors = config.processors as Record<string, Record<string, unknown>>;
    expect(processors.tail_sampling.decision_wait).toBe(
      `${DEFAULT_TAIL_SAMPLING.decisionWaitSeconds}s`,
    );
  });

  it('runs with a read-only root filesystem', () => {
    expect(container.ReadonlyRootFilesystem).toBe(true);
  });

  it('fails synth rather than deploy when the sampling spec is incoherent', () => {
    expect(() =>
      makeStack(
        { sampling: { ...DEFAULT_TAIL_SAMPLING, decisionWaitSeconds: 1 } },
        'IncoherentStack',
      ),
    ).toThrow(/decisionWaitSeconds/);
  });
});

/* ── IAM ──────────────────────────────────────────────────────────────────── */

describe('OtelCollectorStack permissions', () => {
  it('grants the sampler X-Ray writes and nothing broader', () => {
    const { template } = makeStack();

    template.hasResourceProperties('AWS::IAM::Role', {
      Description: 'Runtime permissions for the tail-sampling collector',
    });

    const policies = resourceProps(template, 'AWS::IAM::Policy');
    const statements = policies.flatMap(
      (policy) =>
        (policy.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
    );

    const xray = statements.find((statement) => statement.Sid === 'XRaySegmentWrite');
    expect(xray?.Action).toEqual([
      'xray:PutTraceSegments',
      'xray:PutTelemetryRecords',
    ]);

    // GetSamplingRules is absent deliberately: the sampler decides from the
    // trace, and granting it would let X-Ray's own sampling silently also
    // apply.
    expect(JSON.stringify(statements)).not.toContain('xray:GetSampling');
    expect(JSON.stringify(statements)).not.toContain('xray:*');
  });

  it('scopes the sampler log writes to its own metrics log group', () => {
    const { template } = makeStack();
    const policies = resourceProps(template, 'AWS::IAM::Policy');
    const statements = policies.flatMap(
      (policy) =>
        (policy.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
    );

    const logWrites = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes('logs:PutLogEvents'),
    );
    expect(logWrites.length).toBeGreaterThan(0);
    for (const statement of logWrites) {
      expect(flattenIntrinsic(statement.Resource)).not.toBe('*');
    }
  });
});

/* ── Alarms ───────────────────────────────────────────────────────────────── */

describe('OtelCollectorStack alarms', () => {
  it('alarms on the four silent failures', () => {
    const { template, stack } = makeStack();
    expect(stack.alarms).toHaveLength(4);

    for (const metricName of [
      'otelcol_processor_tail_sampling_sampling_trace_dropped_too_early',
      'otelcol_processor_refused_spans',
      'otelcol_exporter_send_failed_spans',
      'otelcol_loadbalancer_num_backends',
    ]) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'OTelCollector/staging',
        MetricName: metricName,
      });
    }
  });

  it('treats a zero-backend resolution as the failure it is', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'otelcol_loadbalancer_num_backends',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 1,
      Statistic: 'Minimum',
    });
  });

  it('does not alarm on silence by default', () => {
    // Before the first application is instrumented the tier legitimately
    // receives nothing, and an alarm that is red from the day it is created is
    // one somebody silences.
    const { template } = makeStack();
    const alarms = resourceProps(template, 'AWS::CloudWatch::Alarm');
    expect(
      alarms.some((alarm) => alarm.MetricName === 'otelcol_receiver_accepted_spans'),
    ).toBe(false);
  });

  it('treats missing data as breaching only for the silence alarm', () => {
    const { template } = makeStack(
      { alarmOnNoTracesReceived: true },
      'SilenceAlarmStack',
    );
    const alarms = resourceProps(template, 'AWS::CloudWatch::Alarm');

    const breaching = alarms.filter(
      (alarm) => alarm.TreatMissingData === 'breaching',
    );
    expect(breaching).toHaveLength(1);
    expect(breaching[0].MetricName).toBe('otelcol_receiver_accepted_spans');
  });
});

/* ── The agent sidecar ────────────────────────────────────────────────────── */

describe('OtelCollectorStack.addAgentSidecar', () => {
  interface SidecarHarness {
    readonly template: Template;
    readonly container: ecs.ContainerDefinition;
  }

  const makeSidecar = (): SidecarHarness => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'AppStack', { env: ENV });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TaskDefinition', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: new iam.Role(stack, 'TaskRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      }),
    });

    // The application container, so the task definition is valid.
    taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry('example.com/app@sha256:' + 'a'.repeat(64)),
      essential: true,
      environment: OtelCollectorStack.appEnvironment({
        serviceName: 'api',
        envName: 'staging',
      }),
    });

    const container = OtelCollectorStack.addAgentSidecar(taskDefinition, {
      envName: 'staging',
      namespaceName: OtelCollectorStack.namespaceName('staging'),
      samplerServiceName: OtelCollectorStack.samplerServiceName(),
      metricsLogGroupName: OtelCollectorStack.metricsLogGroupName('staging'),
    });

    return { template: Template.fromStack(stack), container };
  };

  it('adds a non-essential sidecar so a broken collector cannot stop the app', () => {
    // Losing traces is an incident. Losing the service because telemetry
    // failed is a worse one.
    const { container } = makeSidecar();
    expect(container.essential).toBe(false);
  });

  it('grants the application task role Cloud Map discovery', () => {
    const { template } = makeSidecar();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'OtelAgentDiscoverSamplers',
            Action: 'servicediscovery:DiscoverInstances',
          }),
        ]),
      }),
    });
  });

  it('scopes the agent metrics writes to the collector stack log group', () => {
    const { template } = makeSidecar();
    const policies = resourceProps(template, 'AWS::IAM::Policy');
    const statements = policies.flatMap(
      (policy) =>
        (policy.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
    );
    const metrics = statements.find(
      (statement) => statement.Sid === 'OtelAgentPublishOwnMetrics',
    );

    expect(flattenIntrinsic(metrics?.Resource)).toContain(
      '/ecs/staging/otel-collector-metrics',
    );
  });

  it('sets AWS_REGION, without which the resolver queries the wrong region', () => {
    // The Cloud Map resolver falls back to a hard-coded us-east-1 when the SDK
    // finds no region — which is a healthy task resolving zero backends and
    // dropping every span, with nothing but a debug log to say so.
    const { template } = makeSidecar();
    const [taskDefinition] = resourceProps(template, 'AWS::ECS::TaskDefinition');
    const containers = taskDefinition.ContainerDefinitions as Record<string, unknown>[];
    const agent = containers.find((entry) => entry.Name === 'otel-agent');
    const environment = agent?.Environment as { Name: string; Value: string }[];

    expect(
      environment.find((variable) => variable.Name === 'AWS_REGION')?.Value,
    ).toBe(ENV.region);
  });

  it('points the application at the sidecar and stops it head-sampling', () => {
    const environment = OtelCollectorStack.appEnvironment({
      serviceName: 'api',
      envName: 'staging',
    });

    expect(environment.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      `http://localhost:${OTLP_GRPC_PORT}`,
    );

    // The setting the whole item depends on. At 5% head sampling, "keep every
    // error" keeps every error in the 5% — which is 5% of errors, and looks
    // exactly like tail sampling working.
    expect(environment.OTEL_TRACES_SAMPLER).toBe('parentbased_always_on');

    // The ALB stamps X-Amzn-Trace-Id; an app configured for W3C alone starts a
    // new trace at every hop that only speaks the X-Ray header.
    expect(environment.OTEL_PROPAGATORS).toContain('xray');
  });
});
