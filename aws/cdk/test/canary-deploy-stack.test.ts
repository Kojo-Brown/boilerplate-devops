import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match, Capture } from 'aws-cdk-lib/assertions';
import { CanaryDeployStack, CanaryDeployStackProps } from '../lib/canary-deploy-stack';
import { flattenIntrinsic, outputByExportName, resourceProps } from './support/cfn';

const CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

const makeStack = (overrides: Partial<CanaryDeployStackProps> = {}) => {
  const app = new cdk.App();
  const networkStack = new cdk.Stack(app, 'NetworkStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(networkStack, 'Vpc', { maxAzs: 2 });

  const stack = new CanaryDeployStack(app, 'TestCanaryStack', {
    vpc,
    certificateArn: CERTIFICATE_ARN,
    envName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  });

  return { template: Template.fromStack(stack), stack };
};

/**
 * The state machine definition, parsed back into an object.
 *
 * CDK renders `DefinitionString` as an `Fn::Join` because the definition embeds
 * Lambda and topic ARNs. Flattening substitutes a placeholder for each
 * intrinsic, which keeps the JSON parseable while leaving every literal — state
 * names, weights, conditions, wait durations — intact and assertable.
 */
const stateMachineDefinition = (template: Template): { States: Record<string, any> } => {
  const [stateMachine] = resourceProps(template, 'AWS::StepFunctions::StateMachine');
  return JSON.parse(flattenIntrinsic(stateMachine.DefinitionString));
};

/** Every IAM action granted by the stack's inline policies, with its resources. */
const policyStatements = (template: Template): { Sid?: string; Action: string | string[]; Resource: unknown }[] =>
  resourceProps(template, 'AWS::IAM::Policy').flatMap((policy) => {
    const { Statement } = policy.PolicyDocument as {
      Statement: { Sid?: string; Action: string | string[]; Resource: unknown }[];
    };
    return Statement;
  });

const actionsOf = (statement: { Action: string | string[] }): string[] =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];

describe('CanaryDeployStack', () => {
  describe('prop validation', () => {
    it('rejects an empty trafficSteps list', () => {
      expect(() => makeStack({ trafficSteps: [] })).toThrow(
        /trafficSteps must contain at least one step/,
      );
    });

    it('rejects a step of 100 — the stable group always keeps the remainder', () => {
      expect(() => makeStack({ trafficSteps: [10, 50, 100] })).toThrow(
        /between 1 and 99/,
      );
    });

    it('rejects a step of 0', () => {
      expect(() => makeStack({ trafficSteps: [0, 50] })).toThrow(/between 1 and 99/);
    });

    it('rejects a non-integer step', () => {
      expect(() => makeStack({ trafficSteps: [10.5] })).toThrow(/between 1 and 99/);
    });

    it('rejects steps that are not strictly increasing', () => {
      expect(() => makeStack({ trafficSteps: [50, 10] })).toThrow(
        /trafficSteps must be strictly increasing/,
      );
      expect(() => makeStack({ trafficSteps: [10, 10] })).toThrow(
        /trafficSteps must be strictly increasing/,
      );
    });

    it('rejects a canary service that would run no tasks', () => {
      expect(() => makeStack({ canaryDesiredCount: 0 })).toThrow(
        /canaryDesiredCount must be at least 1/,
      );
    });

    it('rejects an out-of-range error-rate threshold', () => {
      expect(() => makeStack({ analysis: { maxErrorRatePercent: 101 } })).toThrow(
        /maxErrorRatePercent must be between 0 and 100/,
      );
    });
  });

  describe('weighted target groups', () => {
    it('creates exactly two target groups', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
    });

    it('names them for the traffic they serve', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Name: 'staging-stable-tg',
      });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Name: 'staging-canary-tg',
      });
    });

    it('starts with all traffic on stable and none on canary', () => {
      const { template } = makeStack();
      const weights = new Capture();

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        DefaultActions: [
          {
            Type: 'forward',
            ForwardConfig: { TargetGroups: weights },
          },
        ],
      });

      expect(weights.asArray().map((tg) => tg.Weight)).toEqual([100, 0]);
    });

    it('leaves stickiness off so the split is per-request, not per-session', () => {
      const { template } = makeStack();
      const listeners = resourceProps(template, 'AWS::ElasticLoadBalancingV2::Listener');
      const httpsListener = listeners.find((l) => l.Port === 443);
      const forwardConfig = (httpsListener!.DefaultActions as any[])[0].ForwardConfig;
      expect(forwardConfig.TargetGroupStickinessConfig).toBeUndefined();
    });

    it('both target groups health-check the configured path', () => {
      const { template } = makeStack({ healthCheckPath: '/healthz' });
      const groups = resourceProps(template, 'AWS::ElasticLoadBalancingV2::TargetGroup');
      expect(groups).toHaveLength(2);
      for (const group of groups) {
        expect(group.HealthCheckPath).toBe('/healthz');
      }
    });
  });

  describe('load balancer', () => {
    it('drops invalid header fields rather than forwarding them', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: Match.arrayWith([
          { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        ]),
      });
    });

    it('redirects HTTP to HTTPS permanently', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        DefaultActions: [
          Match.objectLike({
            Type: 'redirect',
            RedirectConfig: { Port: '443', Protocol: 'HTTPS', StatusCode: 'HTTP_301' },
          }),
        ],
      });
    });

    it('enables deletion protection only for production', () => {
      const attributeValue = (template: Template) => {
        const [alb] = resourceProps(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
        const attributes = alb.LoadBalancerAttributes as { Key: string; Value: string }[];
        return attributes.find((a) => a.Key === 'deletion_protection.enabled')?.Value;
      };

      expect(attributeValue(makeStack({ envName: 'production' }).template)).toBe('true');
      expect(attributeValue(makeStack({ envName: 'staging' }).template)).toBe('false');
    });

    it('terminates TLS with a modern policy', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      });
    });
  });

  describe('ECS services', () => {
    it('creates a stable service and a canary service', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.resourceCountIs('AWS::ECS::Service', 2);
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: 'staging-stable-service',
      });
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: 'staging-canary-service',
      });
    });

    it('runs the canary at zero tasks between deployments', () => {
      const { template } = makeStack({ stableDesiredCount: 4 });
      const services = resourceProps(template, 'AWS::ECS::Service');
      const stable = services.find((s) => s.ServiceName === 'test-stable-service');
      const canary = services.find((s) => s.ServiceName === 'test-canary-service');

      expect(stable!.DesiredCount).toBe(4);
      expect(canary!.DesiredCount).toBe(0);
    });

    it('uses the ECS rolling controller — traffic shifting is this stack’s job', () => {
      const { template } = makeStack();
      for (const service of resourceProps(template, 'AWS::ECS::Service')) {
        // CODE_DEPLOY would take ownership of the listener away from the state
        // machine, which is exactly what this stack must not do.
        expect(service.DeploymentController).toEqual({ Type: 'ECS' });
      }
    });

    it('keeps the circuit breaker on for task-level rollout failures', () => {
      const { template } = makeStack();
      for (const service of resourceProps(template, 'AWS::ECS::Service')) {
        expect(service.DeploymentConfiguration).toMatchObject({
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        });
      }
    });

    it('shares one task-definition family across both services', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: 'test-canary-task',
      });
    });

    it('places tasks in private subnets without public IPs', () => {
      const { template } = makeStack();
      for (const service of resourceProps(template, 'AWS::ECS::Service')) {
        const config = service.NetworkConfiguration as any;
        expect(config.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED');
      }
    });
  });

  describe('state machine', () => {
    it('walks shift → bake → analyze once per traffic step', () => {
      const { template } = makeStack({ trafficSteps: [5, 40] });
      const { States } = stateMachineDefinition(template);

      for (const weight of [5, 40]) {
        expect(States[`ShiftTo${weight}Percent`]).toBeDefined();
        expect(States[`BakeAt${weight}Percent`]).toBeDefined();
        expect(States[`AnalyzeAt${weight}Percent`]).toBeDefined();
        expect(States[`VerdictAt${weight}Percent`]).toBeDefined();
      }

      expect(States.ShiftTo5Percent.Next).toBe('BakeAt5Percent');
      expect(States.BakeAt5Percent.Next).toBe('AnalyzeAt5Percent');
      expect(States.AnalyzeAt5Percent.Next).toBe('VerdictAt5Percent');
    });

    it('creates no step states for weights that were not configured', () => {
      const { template } = makeStack({ trafficSteps: [5] });
      const { States } = stateMachineDefinition(template);
      const shiftStates = Object.keys(States).filter((name) => name.startsWith('ShiftTo'));
      expect(shiftStates).toEqual(['ShiftTo5Percent']);
    });

    it('passes each step’s weight to the controller', () => {
      const { template } = makeStack({ trafficSteps: [5, 40] });
      const { States } = stateMachineDefinition(template);

      expect(States.ShiftTo5Percent.Parameters).toMatchObject({
        action: 'shift',
        canaryWeight: 5,
      });
      expect(States.ShiftTo40Percent.Parameters).toMatchObject({
        action: 'shift',
        canaryWeight: 40,
      });
    });

    it('chains each passing verdict into the next step and the last into promotion', () => {
      const { template } = makeStack({ trafficSteps: [5, 40] });
      const { States } = stateMachineDefinition(template);

      expect(States.VerdictAt5Percent.Choices).toEqual([
        expect.objectContaining({
          Variable: '$.analysis.verdict',
          StringEquals: 'PASS',
          Next: 'ShiftTo40Percent',
        }),
      ]);
      expect(States.VerdictAt40Percent.Choices[0].Next).toBe('PromoteToStable');
    });

    it('sends every failing verdict to rollback', () => {
      const { template } = makeStack({ trafficSteps: [5, 40] });
      const { States } = stateMachineDefinition(template);

      expect(States.VerdictAt5Percent.Default).toBe('Rollback');
      expect(States.VerdictAt40Percent.Default).toBe('Rollback');
    });

    it('bakes for the configured time at every step', () => {
      const { template } = makeStack({ trafficSteps: [5, 40], bakeTimeSeconds: 90 });
      const { States } = stateMachineDefinition(template);

      expect(States.BakeAt5Percent.Seconds).toBe(90);
      expect(States.BakeAt40Percent.Seconds).toBe(90);
    });

    it('analyzes the same window it baked for', () => {
      const { template } = makeStack({ trafficSteps: [5], bakeTimeSeconds: 90 });
      const { States } = stateMachineDefinition(template);

      expect(States.AnalyzeAt5Percent.Parameters).toMatchObject({
        canaryWeight: 5,
        windowSeconds: 90,
      });
    });

    it('polls canary health until it settles, then enters the first step', () => {
      const { template } = makeStack({ trafficSteps: [5] });
      const { States } = stateMachineDefinition(template);

      expect(States.DeployCanary.Next).toBe('InitCanaryHealth');
      expect(States.InitCanaryHealth.Next).toBe('WaitForCanary');
      expect(States.WaitForCanary.Next).toBe('CheckCanaryHealth');
      expect(States.CheckCanaryHealth.Next).toBe('IsCanaryHealthy');

      const [healthy, exhausted] = States.IsCanaryHealthy.Choices;
      expect(healthy).toMatchObject({
        Variable: '$.health.stable',
        BooleanEquals: true,
        Next: 'ShiftTo5Percent',
      });
      expect(exhausted).toMatchObject({
        Variable: '$.health.attempts',
        Next: 'Rollback',
      });
      expect(States.IsCanaryHealthy.Default).toBe('WaitForCanary');
    });

    it('bounds the health poll by maxHealthCheckAttempts', () => {
      const { template } = makeStack({ maxHealthCheckAttempts: 7 });
      const { States } = stateMachineDefinition(template);

      expect(States.IsCanaryHealthy.Choices[1].NumericGreaterThanEquals).toBe(7);
      expect(States.IsStableHealthy.Choices[1].NumericGreaterThanEquals).toBe(7);
    });

    it('waits the configured interval between health polls', () => {
      const { template } = makeStack({ healthCheckIntervalSeconds: 15 });
      const { States } = stateMachineDefinition(template);

      expect(States.WaitForCanary.Seconds).toBe(15);
      expect(States.WaitForStable.Seconds).toBe(15);
    });

    it('promotes onto stable, waits for it, then hands traffic back', () => {
      const { template } = makeStack();
      const { States } = stateMachineDefinition(template);

      expect(States.PromoteToStable.Next).toBe('InitStableHealth');
      expect(States.InitStableHealth.Next).toBe('WaitForStable');
      expect(States.WaitForStable.Next).toBe('CheckStableHealth');
      expect(States.CheckStableHealth.Next).toBe('IsStableHealthy');
      expect(States.IsStableHealthy.Choices[0].Next).toBe('ResetTraffic');
      expect(States.ResetTraffic.Next).toBe('NotifySuccess');
      expect(States.NotifySuccess.Next).toBe('DeploymentSucceeded');
      expect(States.DeploymentSucceeded.Type).toBe('Succeed');
    });

    it('carries the caller’s task definition into both service updates', () => {
      const { template } = makeStack();
      const { States } = stateMachineDefinition(template);

      expect(States.DeployCanary.Parameters).toMatchObject({
        action: 'deploy',
        'taskDefinitionArn.$': '$.taskDefinitionArn',
      });
      expect(States.PromoteToStable.Parameters).toMatchObject({
        action: 'promote',
        'taskDefinitionArn.$': '$.taskDefinitionArn',
      });
    });

    it('catches unexpected errors in every mutating state into rollback', () => {
      const { template } = makeStack({ trafficSteps: [5] });
      const { States } = stateMachineDefinition(template);

      const guarded = [
        'DeployCanary',
        'CheckCanaryHealth',
        'ShiftTo5Percent',
        'AnalyzeAt5Percent',
        'PromoteToStable',
        'CheckStableHealth',
        'ResetTraffic',
      ];

      for (const name of guarded) {
        expect(States[name].Catch).toEqual([
          expect.objectContaining({ ErrorEquals: ['States.ALL'], Next: 'Rollback' }),
        ]);
      }
    });

    it('still notifies when the rollback itself fails', () => {
      const { template } = makeStack();
      const { States } = stateMachineDefinition(template);

      expect(States.Rollback.Next).toBe('NotifyFailure');
      expect(States.Rollback.Catch).toEqual([
        expect.objectContaining({ ErrorEquals: ['States.ALL'], Next: 'NotifyFailure' }),
      ]);
      expect(States.NotifyFailure.Next).toBe('DeploymentFailed');
      expect(States.DeploymentFailed.Type).toBe('Fail');
    });

    it('restores traffic to stable on the rollback path', () => {
      const { template } = makeStack();
      const { States } = stateMachineDefinition(template);

      expect(States.Rollback.Parameters).toMatchObject({ action: 'rollback' });
      expect(States.ResetTraffic.Parameters).toMatchObject({ action: 'reset' });
    });

    it('records the stable revision before touching anything', () => {
      const { template } = makeStack();
      const definition = stateMachineDefinition(template) as { StartAt: string; States: any };

      expect(definition.StartAt).toBe('CaptureStableBaseline');
      expect(definition.States.CaptureStableBaseline.Parameters).toMatchObject({
        action: 'baseline',
      });
      expect(definition.States.CaptureStableBaseline.ResultPath).toBe('$.stableBaseline');
      expect(definition.States.CaptureStableBaseline.Next).toBe('DeployCanary');
    });

    it('hands the recorded revision to rollback so a late failure undoes promotion', () => {
      const { template } = makeStack();
      const { States } = stateMachineDefinition(template);

      expect(States.Rollback.Parameters).toMatchObject({
        'stableTaskDefinitionArn.$': '$.stableBaseline.taskDefinitionArn',
      });
    });

    it('does not send the baseline capture to rollback — nothing has changed yet', () => {
      const { template } = makeStack();
      const { States } = stateMachineDefinition(template);

      // Rollback dereferences $.stableBaseline, so catching this state into it
      // would fail on a path that does not exist yet.
      expect(States.CaptureStableBaseline.Catch).toEqual([
        expect.objectContaining({ ErrorEquals: ['States.ALL'], Next: 'NotifyFailure' }),
      ]);
    });

    it('enables tracing and full execution logging', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: 'test-canary-deployment',
        TracingConfiguration: { Enabled: true },
        LoggingConfiguration: Match.objectLike({
          Level: 'ALL',
          IncludeExecutionData: true,
        }),
      });
    });

    it('logs to a vendedlogs group, which is the only prefix Step Functions accepts', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/vendedlogs/states/test-canary-deployment',
      });
    });

    it('times out rather than running forever when a deployment wedges', () => {
      const { template } = makeStack({
        trafficSteps: [10],
        bakeTimeSeconds: 300,
        healthCheckIntervalSeconds: 30,
        maxHealthCheckAttempts: 10,
      });
      // The state machine timeout is expressed inside the ASL definition, not
      // as a CloudFormation property on the resource.
      const definition = stateMachineDefinition(template) as { TimeoutSeconds?: number };
      // 2 × (2 × 10 × 30 + 1 × (300 + 120)) = 2 × 1020
      expect(definition.TimeoutSeconds).toBe(2040);
    });
  });

  describe('analysis configuration', () => {
    it('defaults to failing an inconclusive window', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-canary-analyzer',
        Environment: {
          Variables: Match.objectLike({
            INCONCLUSIVE_VERDICT: 'fail',
            MINIMUM_REQUEST_COUNT: '100',
          }),
        },
      });
    });

    it('passes every threshold through to the analyzer', () => {
      const { template } = makeStack({
        analysis: {
          maxErrorRatePercent: 0.5,
          maxLatencyMs: 250,
          errorRateToleranceMultiplier: 3,
          latencyToleranceMultiplier: 1.25,
          minimumRequestCount: 500,
          inconclusiveVerdict: 'pass',
          latencyStatistic: 'p99',
        },
      });

      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-canary-analyzer',
        Environment: {
          Variables: Match.objectLike({
            MAX_ERROR_RATE_PERCENT: '0.5',
            MAX_LATENCY_MS: '250',
            ERROR_RATE_TOLERANCE_MULTIPLIER: '3',
            LATENCY_TOLERANCE_MULTIPLIER: '1.25',
            MINIMUM_REQUEST_COUNT: '500',
            INCONCLUSIVE_VERDICT: 'pass',
            LATENCY_STATISTIC: 'p99',
          }),
        },
      });
    });

    it('gives the analyzer both target groups so it can compare them', () => {
      const { template } = makeStack();
      const analyzer = resourceProps(template, 'AWS::Lambda::Function').find(
        (fn) => fn.FunctionName === 'test-canary-analyzer',
      );
      const variables = (analyzer!.Environment as any).Variables;

      expect(variables.STABLE_TARGET_GROUP_FULL_NAME).toBeDefined();
      expect(variables.CANARY_TARGET_GROUP_FULL_NAME).toBeDefined();
      expect(variables.LOAD_BALANCER_FULL_NAME).toBeDefined();
    });
  });

  describe('alarms', () => {
    it('watches the canary target group for 5xx and latency', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-canary-5xx',
        MetricName: 'HTTPCode_Target_5XX_Count',
        Namespace: 'AWS/ApplicationELB',
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-canary-latency',
        MetricName: 'TargetResponseTime',
      });
    });

    it('converts the millisecond threshold to the seconds the metric is published in', () => {
      const { template } = makeStack({ analysis: { maxLatencyMs: 750 } });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-canary-latency',
        Threshold: 0.75,
      });
    });

    it('thresholds latency at the configured statistic', () => {
      const { template } = makeStack({ analysis: { latencyStatistic: 'p99' } });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-canary-latency',
        ExtendedStatistic: 'p99',
      });
    });

    it('treats missing data as not breaching so it stays quiet between deployments', () => {
      const { template } = makeStack();
      for (const alarm of resourceProps(template, 'AWS::CloudWatch::Alarm')) {
        expect(alarm.TreatMissingData).toBe('notBreaching');
      }
    });

    it('routes both alarms to the notification topic', () => {
      const { template } = makeStack();
      const alarms = resourceProps(template, 'AWS::CloudWatch::Alarm');
      expect(alarms).toHaveLength(2);
      for (const alarm of alarms) {
        expect(alarm.AlarmActions).toHaveLength(1);
      }
    });
  });

  describe('notifications', () => {
    it('encrypts the topic at rest', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'test-canary-deployment-notifications',
        KmsMasterKeyId: Match.anyValue(),
      });
    });

    it('creates no subscriptions by default', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Subscription', 0);
    });

    it('subscribes each address supplied', () => {
      const { template } = makeStack({
        notificationEmails: ['ops@example.com', 'oncall@example.com'],
      });
      template.resourceCountIs('AWS::SNS::Subscription', 2);
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'ops@example.com',
      });
    });
  });

  describe('IAM', () => {
    it('scopes listener mutation to this stack’s listener', () => {
      const { template } = makeStack();
      const statement = policyStatements(template).find((s) => s.Sid === 'ShiftListenerWeights');

      expect(statement).toBeDefined();
      expect(actionsOf(statement!)).toEqual(['elasticloadbalancing:ModifyListener']);
      expect(flattenIntrinsic(statement!.Resource)).not.toBe('*');
    });

    it('scopes service updates to the stable and canary services only', () => {
      const { template } = makeStack();
      const statement = policyStatements(template).find(
        (s) => s.Sid === 'UpdateCanaryAndStableServices',
      );

      expect(statement).toBeDefined();
      expect(actionsOf(statement!).sort()).toEqual(['ecs:DescribeServices', 'ecs:UpdateService']);

      // Only the partition is a token, so both ARNs stay readable.
      const resources = (statement!.Resource as unknown[]).map(flattenIntrinsic);
      expect(resources).toHaveLength(2);
      expect(resources.join(' ')).toContain('service/test-canary-cluster/test-stable-service');
      expect(resources.join(' ')).toContain('service/test-canary-cluster/test-canary-service');
    });

    it('constrains PassRole to the ECS tasks service', () => {
      const { template } = makeStack();
      const statement = policyStatements(template).find((s) => s.Sid === 'PassTaskRoles') as any;

      expect(statement).toBeDefined();
      expect(statement.Condition).toEqual({
        StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
      });
    });

    it('grants the analyzer read-only metric access and nothing else', () => {
      const { template } = makeStack();
      const statement = policyStatements(template).find((s) => s.Sid === 'ReadCanaryMetrics');

      expect(statement).toBeDefined();
      expect(actionsOf(statement!)).toEqual(['cloudwatch:GetMetricData']);
    });

    it('uses a wildcard only for APIs that reject resource-level permissions', () => {
      const { template } = makeStack();
      const wildcardSids = policyStatements(template)
        .filter((s) => flattenIntrinsic(s.Resource) === '*')
        .map((s) => s.Sid)
        .filter((sid): sid is string => sid !== undefined);

      // Both ELBv2 Describe* and cloudwatch:GetMetricData are documented as not
      // supporting resource ARNs. Anything else appearing here is a regression.
      expect(wildcardSids.sort()).toEqual(['ReadCanaryMetrics', 'ReadListenerAndTargetHealth']);
    });

    it('bounds Lambda concurrency', () => {
      const { template } = makeStack({ lambdaReservedConcurrency: 3 });
      for (const fn of resourceProps(template, 'AWS::Lambda::Function')) {
        expect(fn.ReservedConcurrentExecutions).toBe(3);
      }
    });
  });

  describe('outputs', () => {
    it('exports the state machine ARN the deploy workflow needs', () => {
      const { template } = makeStack();
      expect(outputByExportName(template, 'test-canary-state-machine-arn')).toBeDefined();
    });

    it('exports the task-definition family new revisions are registered against', () => {
      const { template } = makeStack();
      const output = outputByExportName(template, 'test-canary-task-family');
      expect(output!.Value).toBe('test-canary-task');
    });

    it('exports the traffic steps that were actually configured', () => {
      const { template } = makeStack({ trafficSteps: [5, 40, 75] });
      const output = outputByExportName(template, 'test-canary-traffic-steps');
      expect(output!.Value).toBe('5,40,75');
    });

    it('exports both service names and the cluster', () => {
      const { template } = makeStack();
      for (const exportName of [
        'test-canary-cluster-name',
        'test-canary-stable-service-name',
        'test-canary-canary-service-name',
        'test-canary-notification-topic-arn',
        'test-canary-alb-dns',
      ]) {
        expect(outputByExportName(template, exportName)).toBeDefined();
      }
    });
  });

  describe('naming', () => {
    it('does not collide with EcsStack or BlueGreenDeployStack resource names', () => {
      const { template } = makeStack({ envName: 'production' });

      const [cluster] = resourceProps(template, 'AWS::ECS::Cluster');
      expect(cluster.ClusterName).toBe('production-canary-cluster');

      const [alb] = resourceProps(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
      expect(alb.Name).toBe('production-canary-alb');

      const targetGroupNames = resourceProps(
        template,
        'AWS::ElasticLoadBalancingV2::TargetGroup',
      ).map((tg) => tg.Name);
      // EcsStack owns `production-tg`; BlueGreenDeployStack owns
      // `production-blue-tg` / `production-green-tg`.
      expect(targetGroupNames).not.toContain('production-tg');
      expect(targetGroupNames).not.toContain('production-blue-tg');
      expect(targetGroupNames).not.toContain('production-green-tg');
    });

    it('keeps every ALB resource name within its 32-character limit', () => {
      const { template } = makeStack({ envName: 'production' });
      const names = [
        ...resourceProps(template, 'AWS::ElasticLoadBalancingV2::TargetGroup').map((tg) => tg.Name),
        ...resourceProps(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer').map((lb) => lb.Name),
      ] as string[];

      for (const name of names) {
        expect(name.length).toBeLessThanOrEqual(32);
      }
    });
  });
});
