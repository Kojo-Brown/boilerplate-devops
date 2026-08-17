import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as events from 'aws-cdk-lib/aws-events';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  DEFAULT_ISSUE_LABEL,
  FeatureFlagLifecycleStack,
  FeatureFlagLifecycleStackProps,
  STALE_REASONS,
} from '../lib/feature-flag-lifecycle-stack';
import { AppConfigStack } from '../lib/appconfig-stack';
import { flattenIntrinsic, resourceProps } from './support/cfn';

const TOKEN_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-github-token-AbCdEf';

type Overrides = Partial<Omit<FeatureFlagLifecycleStackProps, 'application'>>;

/**
 * A stack to hang imported constructs off.
 *
 * It carries a placeholder resource because CDK's template validator warns on a
 * stack with an empty `Resources` section, and an import synthesizes to nothing.
 * A `WaitConditionHandle` is the standard choice: it is free, creates nothing,
 * and needs no properties.
 */
const hostStack = (app: cdk.App, id = 'HostStack'): cdk.Stack => {
  const host = new cdk.Stack(app, id, {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  new cdk.CfnResource(host, 'Placeholder', {
    type: 'AWS::CloudFormation::WaitConditionHandle',
  });
  return host;
};

const makeStack = (props: Overrides = {}) => {
  const app = new cdk.App();

  // Identifiers rather than a live AppConfigStack, so the assertions below can
  // name the exact value that reaches the handler. The cross-stack wiring
  // `bin/app.ts` actually uses is covered separately at the end of this file.
  const application = appconfig.Application.fromApplicationId(hostStack(app), 'App', 'abc1234');

  const stack = new FeatureFlagLifecycleStack(app, 'TestFlagLifecycleStack', {
    application,
    configurationProfileId: 'def5678',
    environments: [
      { name: 'production', environmentId: 'env-prod' },
      { name: 'staging', environmentId: 'env-stg' },
    ],
    repository: 'example-org/example-repo',
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });

  return { stack, template: Template.fromStack(stack) };
};

/** The sweep function's environment block. */
const sweepEnvironment = (template: Template): Record<string, unknown> => {
  const [fn] = resourceProps(template, 'AWS::Lambda::Function');
  return (fn.Environment as { Variables: Record<string, unknown> }).Variables;
};

/** Every statement in every inline policy, flattened. */
const policyStatements = (template: Template): Record<string, any>[] =>
  resourceProps(template, 'AWS::IAM::Policy').flatMap(
    (policy) =>
      ((policy.PolicyDocument as { Statement: Record<string, any>[] }).Statement ?? []),
  );

const statementWithAction = (template: Template, action: string): Record<string, any> | undefined =>
  policyStatements(template).find((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.includes(action);
  });

describe('FeatureFlagLifecycleStack', () => {
  describe('the sweep function', () => {
    it('creates exactly one', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::Lambda::Function', 1);
    });

    it('runs on a supported Node runtime with a bounded timeout', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        Timeout: 300,
      });
    });

    it('runs one at a time', () => {
      // Two concurrent sweeps would both read the open-issue list before either
      // filed, and both would file — the duplicate is what the marker exists to
      // prevent, and concurrency is the one way past it.
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Lambda::Function', {
        ReservedConcurrentExecutions: 1,
      });
    });

    it('passes the application, profile, and every environment to the handler', () => {
      const { template } = makeStack();
      const environment = sweepEnvironment(template);

      expect(environment.APPLICATION_ID).toBe('abc1234');
      expect(environment.CONFIGURATION_PROFILE_ID).toBe('def5678');
      expect(JSON.parse(environment.ENVIRONMENTS as string)).toEqual([
        { name: 'production', id: 'env-prod' },
        { name: 'staging', id: 'env-stg' },
      ]);
    });

    it('carries the defaults the handler reads', () => {
      const { template } = makeStack();
      const environment = sweepEnvironment(template);

      expect(environment.WARN_WITHIN_DAYS).toBe('14');
      expect(environment.ABANDONED_AFTER_DAYS).toBe('30');
      expect(environment.ISSUE_LABEL).toBe(DEFAULT_ISSUE_LABEL);
      expect(environment.DRY_RUN).toBe('false');
      expect(environment.GITHUB_API_URL).toBe('https://api.github.com');
    });

    it('carries overrides through to the handler', () => {
      const { template } = makeStack({
        warnWithinDays: 30,
        abandonedAfterDays: 7,
        issueLabel: 'tech-debt',
        dryRun: true,
        githubApiUrl: 'https://github.example.com/api/v3',
      });
      const environment = sweepEnvironment(template);

      expect(environment.WARN_WITHIN_DAYS).toBe('30');
      expect(environment.ABANDONED_AFTER_DAYS).toBe('7');
      expect(environment.ISSUE_LABEL).toBe('tech-debt');
      expect(environment.DRY_RUN).toBe('true');
      expect(environment.GITHUB_API_URL).toBe('https://github.example.com/api/v3');
    });

    it('never puts a GitHub token in the environment', () => {
      // The ARN is a pointer; the token is read from Secrets Manager at
      // invocation. Lambda environment variables are readable by anyone with
      // GetFunctionConfiguration, which is a wider set than anyone who should
      // hold a token that can write issues.
      const { template } = makeStack({ githubTokenSecretArn: TOKEN_SECRET_ARN });
      const environment = sweepEnvironment(template);

      expect(environment.GITHUB_TOKEN_SECRET_ARN).toBe(TOKEN_SECRET_ARN);
      expect(JSON.stringify(environment)).not.toContain('mock-github-token-value');
    });

    it('refuses to be built with nothing to sweep', () => {
      expect(() => makeStack({ environments: [] })).toThrow(/at least one environment/);
    });
  });

  describe('schedule', () => {
    it('sweeps daily by default', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: 'cron(0 9 * * ? *)',
        State: 'ENABLED',
      });
    });

    it('accepts a different cadence', () => {
      const { template } = makeStack({ schedule: events.Schedule.rate(cdk.Duration.hours(6)) });
      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: 'rate(6 hours)',
      });
    });

    it('targets the sweep function', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::Lambda::Permission', 1);
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Principal: 'events.amazonaws.com',
      });
    });
  });

  describe('permissions', () => {
    it('can start a configuration session only under its own application', () => {
      const { template } = makeStack();
      const statement = statementWithAction(template, 'appconfig:StartConfigurationSession');
      expect(statement).toBeDefined();
      expect(flattenIntrinsic(statement!.Resource)).toContain('/environment/*');
    });

    it('can publish metrics only into the feature flag namespace', () => {
      // PutMetricData rejects any resource but `*`, so the namespace condition
      // is the whole of the scoping. Losing it would give the sweep write
      // access to every metric in the account.
      const { template } = makeStack();
      const statement = statementWithAction(template, 'cloudwatch:PutMetricData');

      expect(statement).toBeDefined();
      expect(statement!.Resource).toBe('*');
      expect(statement!.Condition).toEqual({
        StringEquals: { 'cloudwatch:namespace': 'FeatureFlags' },
      });
    });

    it('can read only the one secret it was given', () => {
      const { template } = makeStack({ githubTokenSecretArn: TOKEN_SECRET_ARN });
      const statement = statementWithAction(template, 'secretsmanager:GetSecretValue');

      expect(statement).toBeDefined();
      expect(statement!.Resource).toBe(TOKEN_SECRET_ARN);
    });

    it('asks for no secret access when it has no token to read', () => {
      const { template } = makeStack();
      expect(statementWithAction(template, 'secretsmanager:GetSecretValue')).toBeUndefined();
    });

    it('cannot write to AppConfig at all', () => {
      // The sweep reports; it never mutates. Deleting a flag before the code
      // that reads it is removed resolves the key to undefined in every running
      // process, which is falsy, which takes the branch the rollout moved away
      // from. Nothing in this role should make that reachable.
      const actions = policyStatements(template(makeStack())).flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action],
      );

      expect(actions).not.toContain('appconfig:DeleteHostedConfigurationVersion');
      expect(actions).not.toContain('appconfig:CreateHostedConfigurationVersion');
      expect(actions).not.toContain('appconfig:StartDeployment');
      expect(actions.filter((a: string) => a.startsWith('appconfig:')).sort()).toEqual([
        'appconfig:GetLatestConfiguration',
        'appconfig:StartConfigurationSession',
      ]);
    });
  });

  describe('alarms', () => {
    it('alarms on flags past their removal date', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'StaleFlags',
        Namespace: 'FeatureFlags',
        Dimensions: [{ Name: 'Reason', Value: 'expired' }],
        ComparisonOperator: 'GreaterThanThreshold',
        Threshold: 0,
      });
    });

    it('waits three days before firing on an expired flag', () => {
      // One overdue day is somebody merging the removal tomorrow. An alarm that
      // fires on the first day is an alarm that fires on every rollout that
      // lands a day late, and gets routed to a folder.
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'StaleFlags',
        EvaluationPeriods: 3,
        DatapointsToAlarm: 3,
      });
    });

    it('alarms separately when the sweep could not read the manifest', () => {
      // Without this, a sweep that has stopped working looks exactly like a
      // clean estate: no stale flags reported, no alarm, nothing to notice.
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'ManifestUnreadable',
        Namespace: 'FeatureFlags',
        ComparisonOperator: 'GreaterThanThreshold',
        Threshold: 0,
        EvaluationPeriods: 1,
      });
    });

    it('does not read a missing datapoint as breaching', () => {
      const alarms = resourceProps(template(makeStack()), 'AWS::CloudWatch::Alarm');
      expect(alarms).toHaveLength(2);
      expect(alarms.every((alarm) => alarm.TreatMissingData === 'notBreaching')).toBe(true);
    });

    it('sends both alarms somewhere', () => {
      const alarms = resourceProps(template(makeStack()), 'AWS::CloudWatch::Alarm');
      expect(alarms.every((alarm) => (alarm.AlarmActions as unknown[]).length === 1)).toBe(true);
    });

    it('exposes the same series the alarm watches', () => {
      // A dashboard that re-derived the dimensions would drift from the alarm
      // and disagree with it about what is on fire.
      const { stack } = makeStack();
      for (const reason of STALE_REASONS) {
        const metric = stack.staleFlagMetric(reason);
        expect(metric.namespace).toBe('FeatureFlags');
        expect(metric.metricName).toBe('StaleFlags');
        expect(metric.dimensions).toEqual({ Reason: reason });
      }
      expect(stack.staleFlagMetric('expired', 'production').dimensions).toEqual({
        Reason: 'expired',
        Environment: 'production',
      });
    });
  });

  describe('notifications', () => {
    it('creates an encrypted topic that refuses plaintext delivery', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Topic', 1);
      template.hasResourceProperties('AWS::SNS::Topic', {
        KmsMasterKeyId: Match.anyValue(),
      });
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
          ]),
        }),
      });
    });

    it('reuses a topic it is handed instead of creating another', () => {
      const app = new cdk.App();
      const host = hostStack(app);
      const application = appconfig.Application.fromApplicationId(host, 'App', 'abc1234');
      const topic = cdk.aws_sns.Topic.fromTopicArn(
        host,
        'Existing',
        'arn:aws:sns:us-east-1:123456789012:existing-alerts',
      );

      const stack = new FeatureFlagLifecycleStack(app, 'ReusingStack', {
        application,
        configurationProfileId: 'def5678',
        environments: [{ name: 'production', environmentId: 'env-prod' }],
        repository: 'example-org/example-repo',
        notificationTopic: topic,
        env: { account: '123456789012', region: 'us-east-1' },
      });

      Template.fromStack(stack).resourceCountIs('AWS::SNS::Topic', 0);
      expect(sweepEnvironment(Template.fromStack(stack)).SNS_TOPIC_ARN).toBe(
        'arn:aws:sns:us-east-1:123456789012:existing-alerts',
      );
    });
  });

  describe('logging', () => {
    it('keeps the sweep log for a month and no longer', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 30,
      });
    });
  });

  describe('wired to a real AppConfigStack, the way bin/app.ts wires it', () => {
    const app = new cdk.App();
    const appConfig = new AppConfigStack(app, 'HostAppConfigStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const stack = new FeatureFlagLifecycleStack(app, 'WiredFlagLifecycleStack', {
      application: appConfig.application,
      configurationProfileId: appConfig.featureFlagsConfig.configurationProfileId,
      environments: Object.entries(appConfig.environments).map(([name, environment]) => ({
        name,
        environmentId: environment.environmentId,
      })),
      repository: 'example-org/example-repo',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    it('sweeps every environment the AppConfig stack created', () => {
      // Each environment ID is an unresolved cross-stack import, so the value
      // is an `Fn::Join` rather than a string; flattening keeps the literal
      // segments around the tokens assertable.
      const environments = flattenIntrinsic(sweepEnvironment(template).ENVIRONMENTS);
      expect(environments).toContain('"name":"production"');
      expect(environments).toContain('"name":"staging"');
    });

    it('resolves the identifiers across the stack boundary rather than inlining them', () => {
      // A literal here would mean the sweep had been pointed at whatever
      // identifier was current when the template was written, and would keep
      // reading it after the application was replaced.
      const environment = sweepEnvironment(template);
      expect(typeof environment.APPLICATION_ID).toBe('object');
      expect(JSON.stringify(environment.APPLICATION_ID)).toContain('Fn::ImportValue');
      expect(JSON.stringify(environment.CONFIGURATION_PROFILE_ID)).toContain('Fn::ImportValue');
    });
  });
});

/** Small helper so the assertions above read as one expression. */
function template(made: { template: Template }): Template {
  return made.template;
}
