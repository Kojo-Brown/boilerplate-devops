import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  SloBurnRateRollbackStack,
  SloBurnRateRollbackStackProps,
  BurnRatePolicy,
  DEFAULT_BURN_RATE_POLICIES,
} from '../lib/slo-burn-rate-rollback-stack';
import {
  TOKEN,
  flattenIntrinsic,
  managedPolicyArns,
  outputByExportName,
  resourceProps,
} from './support/cfn';

const LB_FULL_NAME = 'app/test-alb/1111111111111111';
const TG_FULL_NAME = 'targetgroup/test-tg/2222222222222222';

const ROLLING_TARGET = {
  clusterName: 'test-cluster',
  serviceName: 'test-service',
};

const CODEDEPLOY_TARGET = {
  clusterName: 'test-bg-cluster',
  serviceName: 'test-bg-service',
  codeDeployApplication: 'test-ecs-app',
  codeDeployDeploymentGroup: 'test-ecs-dg',
};

const makeStack = (overrides: Partial<SloBurnRateRollbackStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new SloBurnRateRollbackStack(app, 'TestBurnRateStack', {
    envName: 'test',
    loadBalancerFullName: LB_FULL_NAME,
    targetGroupFullName: TG_FULL_NAME,
    slo: { target: 0.999 },
    rollbackTargets: [ROLLING_TARGET],
    env: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  });
  return { template: Template.fromStack(stack), stack };
};

/** The `Metrics` array of the alarm with a given name. */
const alarmMetrics = (template: Template, alarmName: string): Record<string, any>[] => {
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter(
    (resource) => (resource.Properties as Record<string, unknown>).AlarmName === alarmName,
  );
  expect(alarms).toHaveLength(1);
  return (alarms[0].Properties as Record<string, any>).Metrics;
};

/** The single expression in an alarm's metric math that returns data. */
const returnedExpression = (template: Template, alarmName: string): string => {
  const returned = alarmMetrics(template, alarmName).filter((metric) => metric.ReturnData);
  expect(returned).toHaveLength(1);
  return returned[0].Expression;
};

/** Every action granted across all inline policies in the stack. */
const policyActions = (template: Template): string[] =>
  resourceProps(template, 'AWS::IAM::Policy').flatMap((policy) => {
    const { Statement } = policy.PolicyDocument as { Statement: { Action: string | string[] }[] };
    return Statement.flatMap((stmt) => (Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]));
  });

/** A statement by its Sid, across every inline policy in the stack. */
const statementBySid = (template: Template, sid: string): Record<string, any> | undefined =>
  resourceProps(template, 'AWS::IAM::Policy')
    .flatMap(
      (policy) => (policy.PolicyDocument as { Statement: Record<string, any>[] }).Statement,
    )
    .find((statement) => statement.Sid === sid);

const lambdaEnvironment = (template: Template): Record<string, string> =>
  (resourceProps(template, 'AWS::Lambda::Function')[0].Environment as { Variables: Record<string, string> })
    .Variables;

describe('SloBurnRateRollbackStack', () => {
  describe('validation', () => {
    it('rejects an SLO target expressed as a percentage rather than a fraction', () => {
      // 99.9 instead of 0.999 is the mistake worth catching: it produces a
      // negative error budget, which silently inverts every comparison.
      expect(() => makeStack({ slo: { target: 99.9 } })).toThrow(
        /must be a fraction strictly between 0 and 1/,
      );
    });

    it('rejects an SLO target of 1, which leaves no error budget to burn', () => {
      expect(() => makeStack({ slo: { target: 1 } })).toThrow(
        /must be a fraction strictly between 0 and 1/,
      );
    });

    it('rejects an empty rollback target list', () => {
      expect(() => makeStack({ rollbackTargets: [] })).toThrow(
        /rollbackTargets must contain at least one target/,
      );
    });

    it('rejects an empty policy list', () => {
      expect(() => makeStack({ burnRatePolicies: [] })).toThrow(
        /burnRatePolicies must contain at least one policy/,
      );
    });

    it('rejects a short window that is not shorter than the long window', () => {
      expect(() =>
        makeStack({
          burnRatePolicies: [
            { ...DEFAULT_BURN_RATE_POLICIES[0], longWindowMinutes: 30, shortWindowMinutes: 30 },
          ],
        }),
      ).toThrow(/not shorter than its long window/);
    });

    it('rejects a fractional window, which CloudWatch would round behind our back', () => {
      expect(() =>
        makeStack({
          burnRatePolicies: [{ ...DEFAULT_BURN_RATE_POLICIES[0], shortWindowMinutes: 2.5 }],
        }),
      ).toThrow(/must be a positive whole number of minutes/);
    });

    it('rejects a long window beyond the 24-hour CloudWatch alarm maximum', () => {
      expect(() =>
        makeStack({
          burnRatePolicies: [
            { ...DEFAULT_BURN_RATE_POLICIES[0], longWindowMinutes: 1441, shortWindowMinutes: 60 },
          ],
        }),
      ).toThrow(/exceeds the 24-hour maximum/);
    });
  });

  describe('burn-rate metric math', () => {
    it('divides the error ratio by the error budget, not by a fixed threshold', () => {
      const { template } = makeStack({ slo: { target: 0.999 } });
      // The whole point of the item: 0.001 is the budget implied by three
      // nines, so a 1% error ratio reads as 10x rather than "above 1%".
      expect(returnedExpression(template, 'test-slo-burn-rate-fast-long')).toContain('/ 0.001,');
    });

    it('writes the error budget without binary floating-point noise', () => {
      const { template } = makeStack({ slo: { target: 0.999 } });
      // `1 - 0.999` is 0.0010000000000000009 unrounded, and that string is what
      // an on-call engineer would read in the console.
      expect(returnedExpression(template, 'test-slo-burn-rate-fast-long')).not.toContain(
        '0.0010000000000000009',
      );
    });

    it('derives the budget from the configured objective', () => {
      const { template } = makeStack({ slo: { target: 0.995 } });
      expect(returnedExpression(template, 'test-slo-burn-rate-fast-long')).toContain('/ 0.005,');
    });

    it('floors the burn rate at zero below the minimum request count', () => {
      const { template } = makeStack({ slo: { target: 0.999, minimumRequestsPerWindow: 250 } });
      expect(returnedExpression(template, 'test-slo-burn-rate-fast-short')).toContain(
        'IF(req >= 250,',
      );
    });

    it('guards the denominator independently of the traffic floor', () => {
      // CloudWatch evaluates both branches of IF element-wise, so a zero-request
      // window would divide by zero inside the discarded branch and return no
      // data instead of the floored zero.
      const { template } = makeStack();
      expect(returnedExpression(template, 'test-slo-burn-rate-fast-long')).toContain(
        'IF(req > 0, req, 1)',
      );
    });

    it('counts ELB-generated 5xx as well as target 5xx', () => {
      // A deployment with a broken image produces 502/503 at the load balancer;
      // those requests never reach a target and so never appear in the
      // target-scoped metric.
      const { template } = makeStack();
      const metricNames = alarmMetrics(template, 'test-slo-burn-rate-fast-long')
        .filter((metric) => metric.MetricStat)
        .map((metric) => metric.MetricStat.Metric.MetricName);
      expect(metricNames).toEqual(
        expect.arrayContaining([
          'RequestCount',
          'HTTPCode_Target_5XX_Count',
          'HTTPCode_ELB_5XX_Count',
        ]),
      );
    });

    it('fills missing datapoints with zero on every input', () => {
      // A target group with no traffic publishes no datapoint at all rather
      // than a zero, which would otherwise make the whole expression missing.
      const { template } = makeStack();
      const expressions = alarmMetrics(template, 'test-slo-burn-rate-fast-long')
        .filter((metric) => metric.Expression && !metric.ReturnData)
        .map((metric) => metric.Expression);
      expect(expressions).toEqual(
        expect.arrayContaining(['FILL(rc, 0)', 'FILL(t5, 0) + FILL(e5, 0)']),
      );
    });

    it('scopes both windows to the configured load balancer and target group', () => {
      const { template } = makeStack();
      const dimensions = alarmMetrics(template, 'test-slo-burn-rate-fast-short')
        .filter((metric) => metric.MetricStat)
        .map((metric) => metric.MetricStat.Metric.Dimensions);
      for (const dimensionSet of dimensions) {
        expect(dimensionSet).toEqual(
          expect.arrayContaining([
            { Name: 'LoadBalancer', Value: LB_FULL_NAME },
            { Name: 'TargetGroup', Value: TG_FULL_NAME },
          ]),
        );
      }
    });
  });

  describe('alarms', () => {
    it('creates a long and a short window alarm for every policy', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::CloudWatch::Alarm', DEFAULT_BURN_RATE_POLICIES.length * 2);
    });

    it('sets each alarm period to its own window length', () => {
      const { template } = makeStack();
      const periodOf = (alarmName: string) => {
        const withStat = alarmMetrics(template, alarmName).filter((metric) => metric.MetricStat);
        expect(withStat.length).toBeGreaterThan(0);
        return withStat[0].MetricStat.Period;
      };

      expect(periodOf('test-slo-burn-rate-fast-long')).toBe(60 * 60);
      expect(periodOf('test-slo-burn-rate-fast-short')).toBe(5 * 60);
      expect(periodOf('test-slo-burn-rate-slow-long')).toBe(360 * 60);
      expect(periodOf('test-slo-burn-rate-slow-short')).toBe(30 * 60);
    });

    it('evaluates exactly one period, because the window is the period', () => {
      const { template } = makeStack();
      template.allResourcesProperties('AWS::CloudWatch::Alarm', {
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    });

    it('treats missing data as not breaching', () => {
      // Missing data means the metric stopped arriving, which is a monitoring
      // failure. Rolling back on it turns a CloudWatch outage into a service one.
      const { template } = makeStack();
      template.allResourcesProperties('AWS::CloudWatch::Alarm', {
        TreatMissingData: 'notBreaching',
      });
    });

    it('thresholds both windows of a policy at its burn rate', () => {
      const { template } = makeStack();
      const thresholds = resourceProps(template, 'AWS::CloudWatch::Alarm').map(
        (props) => props.Threshold,
      );
      expect(thresholds.filter((threshold) => threshold === 14.4)).toHaveLength(2);
      expect(thresholds.filter((threshold) => threshold === 6)).toHaveLength(2);
    });

    it('ANDs the two windows into one composite alarm per policy', () => {
      const { template } = makeStack();
      template.resourceCountIs(
        'AWS::CloudWatch::CompositeAlarm',
        DEFAULT_BURN_RATE_POLICIES.length,
      );
      for (const props of resourceProps(template, 'AWS::CloudWatch::CompositeAlarm')) {
        const rule = flattenIntrinsic(props.AlarmRule);
        expect(rule).toContain('AND');
        expect(rule.startsWith('(ALARM(')).toBe(true);
      }
    });

    it('notifies on every composite alarm, including the notify-only policy', () => {
      const { template } = makeStack();
      for (const props of resourceProps(template, 'AWS::CloudWatch::CompositeAlarm')) {
        expect(props.AlarmActions).toHaveLength(1);
      }
    });

    it('names composite alarms after the policy so the handler can match them', () => {
      const { template, stack } = makeStack();
      const names = resourceProps(template, 'AWS::CloudWatch::CompositeAlarm').map(
        (props) => props.AlarmName,
      );
      expect(names.sort()).toEqual(['test-slo-burn-rate-fast', 'test-slo-burn-rate-slow']);
      expect(stack.compositeAlarms).toHaveLength(2);
    });
  });

  describe('EventBridge wiring', () => {
    it('invokes the handler only for policies that roll back', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['aws.cloudwatch'],
          'detail-type': ['CloudWatch Alarm State Change'],
          detail: {
            state: { value: ['ALARM'] },
            // The slow policy is notify-only: it fires hours after the change
            // that caused it, when a rollback is as likely wrong as right.
            alarmName: ['test-slo-burn-rate-fast'],
          },
        },
        State: 'ENABLED',
      });
    });

    it('matches every policy that does roll back', () => {
      const bothRollBack: BurnRatePolicy[] = DEFAULT_BURN_RATE_POLICIES.map((policy) => ({
        ...policy,
        triggersRollback: true,
      }));
      const { template } = makeStack({ burnRatePolicies: bothRollBack });
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          detail: { alarmName: ['test-slo-burn-rate-fast', 'test-slo-burn-rate-slow'] },
        },
      });
    });

    it('disables the rule and attaches no target when no policy rolls back', () => {
      // An event pattern with an empty name list matches every alarm in the
      // account rather than none, so the rule has to be switched off instead.
      const notifyOnly: BurnRatePolicy[] = DEFAULT_BURN_RATE_POLICIES.map((policy) => ({
        ...policy,
        triggersRollback: false,
      }));
      const { template } = makeStack({ burnRatePolicies: notifyOnly });
      template.hasResourceProperties('AWS::Events::Rule', { State: 'DISABLED' });
      expect(resourceProps(template, 'AWS::Events::Rule')[0].Targets).toBeUndefined();
      template.resourceCountIs('AWS::Lambda::Permission', 0);
    });

    it('retries a failed invocation', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 2 } }),
        ]),
      });
    });
  });

  describe('rollback handler configuration', () => {
    it('ships only the rollback policies to the handler', () => {
      const { template } = makeStack();
      const policies = JSON.parse(lambdaEnvironment(template).ROLLBACK_POLICIES);
      expect(policies).toEqual([
        {
          alarmName: 'test-slo-burn-rate-fast',
          name: 'fast',
          burnRate: 14.4,
          longWindowMinutes: 60,
          shortWindowMinutes: 5,
        },
      ]);
    });

    it('passes the same traffic floor the alarms use', () => {
      const { template } = makeStack({ slo: { target: 0.999, minimumRequestsPerWindow: 250 } });
      expect(lambdaEnvironment(template).MINIMUM_REQUESTS_PER_WINDOW).toBe('250');
    });

    it('defaults the deployment attribution window to two hours', () => {
      const { template } = makeStack();
      expect(lambdaEnvironment(template).DEPLOYMENT_ATTRIBUTION_WINDOW_MINUTES).toBe('120');
    });

    it('defaults the SLO window to 30 days', () => {
      const { template } = makeStack();
      expect(lambdaEnvironment(template).SLO_WINDOW_DAYS).toBe('30');
    });

    it('carries every rollback target, including CodeDeploy mode', () => {
      const { template } = makeStack({ rollbackTargets: [ROLLING_TARGET, CODEDEPLOY_TARGET] });
      expect(JSON.parse(lambdaEnvironment(template).ROLLBACK_TARGETS)).toEqual([
        ROLLING_TARGET,
        CODEDEPLOY_TARGET,
      ]);
    });

    it('caps concurrency so a metric storm cannot stack rollbacks', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Lambda::Function', {
        ReservedConcurrentExecutions: 2,
      });
    });
  });

  describe('IAM', () => {
    it('grants no mutating permission beyond rollback and notification', () => {
      const { template } = makeStack({ rollbackTargets: [ROLLING_TARGET, CODEDEPLOY_TARGET] });
      expect(policyActions(template).sort()).toEqual([
        'cloudwatch:GetMetricData',
        'codedeploy:GetDeployment',
        'codedeploy:ListDeployments',
        'codedeploy:StopDeployment',
        'ecs:DescribeServices',
        'ecs:UpdateService',
        // No kms:* here by design: the CMK is in this stack, so CDK grants the
        // role through the key policy rather than widening the role's own.
        'sns:Publish',
      ]);
    });

    it('scopes ecs:UpdateService to the exact service ARNs', () => {
      const { template } = makeStack({ rollbackTargets: [ROLLING_TARGET] });
      const statement = statementBySid(template, 'UpdateEcsServices');
      expect(statement).toBeDefined();
      const resources = Array.isArray(statement!.Resource)
        ? statement!.Resource
        : [statement!.Resource];
      expect(resources.map(flattenIntrinsic)).toEqual([
        `arn:${TOKEN}:ecs:us-east-1:123456789012:service/test-cluster/test-service`,
      ]);
    });

    it('omits the CodeDeploy grant entirely when no target uses CodeDeploy', () => {
      const { template } = makeStack({ rollbackTargets: [ROLLING_TARGET] });
      expect(statementBySid(template, 'StopCodeDeployDeployments')).toBeUndefined();
    });

    it('scopes the CodeDeploy grant to the configured deployment groups', () => {
      const { template } = makeStack({ rollbackTargets: [ROLLING_TARGET, CODEDEPLOY_TARGET] });
      const statement = statementBySid(template, 'StopCodeDeployDeployments');
      expect(statement).toBeDefined();
      const resources = Array.isArray(statement!.Resource)
        ? statement!.Resource
        : [statement!.Resource];
      // Deployment-group ARNs use a colon between the resource type and name.
      expect(resources.map(flattenIntrinsic)).toEqual([
        `arn:${TOKEN}:codedeploy:us-east-1:123456789012:deploymentgroup:test-ecs-app/test-ecs-dg`,
      ]);
    });

    it('attaches only the basic execution managed policy', () => {
      const { template } = makeStack();
      const roles = resourceProps(template, 'AWS::IAM::Role').filter(
        (role) => managedPolicyArns(role).length > 0,
      );
      expect(roles).toHaveLength(1);
      expect(managedPolicyArns(roles[0])).toEqual([
        expect.stringContaining('service-role/AWSLambdaBasicExecutionRole'),
      ]);
    });
  });

  describe('encryption', () => {
    it('encrypts the log group and the Lambda environment with a rotating CMK', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        KmsKeyId: Match.anyValue(),
        RetentionInDays: 30,
      });
      template.hasResourceProperties('AWS::Lambda::Function', {
        KmsKeyArn: Match.anyValue(),
      });
    });

    it('encrypts the notification topic', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
    });

    it('subscribes each notification email', () => {
      const { template } = makeStack({
        notificationEmails: ['oncall@example.invalid', 'sre@example.invalid'],
      });
      template.resourceCountIs('AWS::SNS::Subscription', 2);
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'oncall@example.invalid',
      });
    });
  });

  describe('dashboard', () => {
    it('graphs both windows of every policy against its threshold', () => {
      const { template } = makeStack();
      const body = flattenIntrinsic(
        resourceProps(template, 'AWS::CloudWatch::Dashboard')[0].DashboardBody,
      );
      expect(body).toContain('fast burn (1h window, 14.4x)');
      expect(body).toContain('fast burn (5m window, 14.4x)');
      expect(body).toContain('slow burn (6h window, 6x)');
      expect(body).toContain('slow burn (30m window, 6x)');
    });
  });

  describe('outputs', () => {
    it('exports the composite alarm names for use as CodeDeploy deployment alarms', () => {
      const { template } = makeStack();
      const output = outputByExportName(template, 'test-slo-burn-rate-composite-alarm-names');
      expect(output).toBeDefined();
      expect(flattenIntrinsic(output!.Value)).toBe(
        'test-slo-burn-rate-fast,test-slo-burn-rate-slow',
      );
    });

    it('states the objective the alarms measure against', () => {
      const { template } = makeStack({ slo: { target: 0.999, windowDays: 28 } });
      const output = outputByExportName(template, 'test-slo-burn-rate-objective');
      expect(flattenIntrinsic(output!.Value)).toBe('99.9% over 28 days (budget 0.001)');
    });
  });

  describe('Checkov exemptions', () => {
    it('records the DLQ and VPC exemptions on the function itself', () => {
      const { template } = makeStack();
      const [functionResource] = Object.values(
        template.findResources('AWS::Lambda::Function'),
      ) as Record<string, any>[];
      const skips = functionResource.Metadata.checkov.skip.map(
        (skip: { id: string }) => skip.id,
      );
      expect(skips.sort()).toEqual(['CKV_AWS_116', 'CKV_AWS_117']);
      for (const skip of functionResource.Metadata.checkov.skip) {
        expect(skip.comment.length).toBeGreaterThan(40);
      }
    });
  });
});
