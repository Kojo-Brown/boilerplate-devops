import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  RollbackAutomationStack,
  RollbackAutomationStackProps,
} from '../lib/rollback-automation-stack';
import { flattenIntrinsic, managedPolicyArns, resourceProps } from './support/cfn';

const ALARM_ARN_1 =
  'arn:aws:cloudwatch:us-east-1:123456789012:alarm:production-alb-5xx-elb';
const ALARM_ARN_2 =
  'arn:aws:cloudwatch:us-east-1:123456789012:alarm:production-ecs-cpu-high';

const ROLLING_TARGET = {
  clusterName: 'production-cluster',
  serviceName: 'production-service',
};

const CODEDEPLOY_TARGET = {
  clusterName: 'production-bg-cluster',
  serviceName: 'production-bg-service',
  codeDeployApplication: 'production-ecs-app',
  codeDeployDeploymentGroup: 'production-ecs-dg',
};

const makeStack = (overrides: Partial<RollbackAutomationStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new RollbackAutomationStack(app, 'TestRollbackStack', {
    envName: 'test',
    triggerAlarmArns: [ALARM_ARN_1],
    rollbackTargets: [ROLLING_TARGET],
    env: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  });
  return { template: Template.fromStack(stack), stack };
};

/**
 * Every action granted across all inline policies in the stack.
 *
 * CDK renders a statement with a single action as a bare string and one with
 * several as an array, so both shapes are normalized here.
 */
const policyActions = (template: Template): string[] =>
  resourceProps(template, 'AWS::IAM::Policy').flatMap((policy) => {
    const { Statement } = policy.PolicyDocument as { Statement: { Action: string | string[] }[] };
    return Statement.flatMap((stmt) =>
      Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action],
    );
  });

describe('RollbackAutomationStack', () => {
  describe('validation', () => {
    it('throws when triggerAlarmArns is empty', () => {
      expect(() =>
        makeStack({ triggerAlarmArns: [], rollbackTargets: [ROLLING_TARGET] }),
      ).toThrow(/triggerAlarmArns must contain at least one ARN/);
    });

    it('throws when rollbackTargets is empty', () => {
      expect(() =>
        makeStack({ triggerAlarmArns: [ALARM_ARN_1], rollbackTargets: [] }),
      ).toThrow(/rollbackTargets must contain at least one target/);
    });
  });

  describe('SNS Notification Topic', () => {
    it('creates exactly one SNS topic', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    it('names the topic with env prefix', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'staging-rollback-notifications',
        DisplayName: 'staging Rollback Automation Notifications',
      });
    });

    it('creates no subscriptions when notificationEmails is absent', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Subscription', 0);
    });

    it('creates email subscriptions for each address provided', () => {
      const { template } = makeStack({
        notificationEmails: ['ops@example.com', 'oncall@example.com'],
      });
      template.resourceCountIs('AWS::SNS::Subscription', 2);
    });

    it('creates email subscriptions with correct protocol', () => {
      const { template } = makeStack({
        notificationEmails: ['ops@example.com'],
      });
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'ops@example.com',
      });
    });
  });

  describe('Lambda Function', () => {
    it('creates exactly one Lambda function', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::Lambda::Function', 1);
    });

    it('names the Lambda with rollback-automation suffix', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'staging-rollback-automation',
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
      });
    });

    it('uses the default timeout of 60 seconds', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 60,
      });
    });

    it('respects a custom lambdaTimeoutSeconds', () => {
      const { template } = makeStack({ lambdaTimeoutSeconds: 120 });
      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 120,
      });
    });

    it('sets SNS_TOPIC_ARN environment variable', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            SNS_TOPIC_ARN: Match.anyValue(),
          }),
        },
      });
    });

    it('sets ROLLBACK_TARGETS environment variable', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            ROLLBACK_TARGETS: Match.anyValue(),
          }),
        },
      });
    });

    it('sets ENV_NAME environment variable', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            ENV_NAME: 'staging',
          }),
        },
      });
    });
  });

  describe('IAM Role', () => {
    it('creates a Lambda execution role', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'staging-rollback-automation-lambda-role',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'lambda.amazonaws.com' },
            }),
          ]),
        }),
      });
    });

    it('attaches AWSLambdaBasicExecutionRole managed policy', () => {
      const { template } = makeStack();
      const [role] = resourceProps(template, 'AWS::IAM::Role');
      expect(managedPolicyArns(role)).toContainEqual(
        expect.stringContaining('AWSLambdaBasicExecutionRole'),
      );
    });

    it('grants ecs:DescribeServices permission', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'ecs:DescribeServices',
              Sid: 'DescribeEcsServices',
            }),
          ]),
        }),
      });
    });

    it('grants ecs:UpdateService scoped to rollback target resources', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'ecs:UpdateService',
              Sid: 'UpdateEcsService',
            }),
          ]),
        }),
      });
    });

    // Scoped to the deployment groups this stack was given. `"*"` here let the
    // Lambda halt any deployment anywhere in the account — including one
    // belonging to a service it is not a rollback target for, at the moment
    // that deployment was shifting traffic. `SloBurnRateRollbackStack` has
    // scoped the identical three actions since PR #28. See
    // docs/iam-least-privilege.md §2.
    it('grants CodeDeploy rollback actions on the target deployment groups', () => {
      const { template } = makeStack({
        rollbackTargets: [ROLLING_TARGET, CODEDEPLOY_TARGET],
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'codedeploy:ListDeployments',
                'codedeploy:GetDeployment',
                'codedeploy:StopDeployment',
              ]),
              Sid: 'CodeDeployRollback',
            }),
          ]),
        }),
      });

      // The resource is built from `stack.partition`, so it synthesizes to an
      // Fn::Join rather than a literal — asserting the obvious string form here
      // would silently never match. See test/support/cfn.ts.
      const statement = resourceProps(template, 'AWS::IAM::Policy')
        .flatMap(
          (policy) =>
            (policy.PolicyDocument as { Statement: { Sid?: string; Resource?: unknown }[] })
              .Statement,
        )
        .find((s) => s.Sid === 'CodeDeployRollback');
      expect(statement).toBeDefined();
      const resources = Array.isArray(statement!.Resource)
        ? statement!.Resource
        : [statement!.Resource];
      expect(resources.map(flattenIntrinsic)).toEqual([
        'arn:<token>:codedeploy:us-east-1:123456789012:deploymentgroup:production-ecs-app/production-ecs-dg',
      ]);
    });

    // The deployment id is not in the ARN: it does not exist until the
    // deployment does, and CodeDeploy authorizes both calls against the group.
    it('grants no CodeDeploy access at all when no target uses CodeDeploy', () => {
      const { template } = makeStack({ rollbackTargets: [ROLLING_TARGET] });
      expect(policyActions(template)).not.toContain('codedeploy:StopDeployment');
    });

    it('grants SNS publish permission to the notification topic', () => {
      const { template } = makeStack();
      expect(policyActions(template)).toContain('sns:Publish');
    });
  });

  describe('EventBridge Rule', () => {
    it('creates exactly one EventBridge rule', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::Events::Rule', 1);
    });

    it('names the rule with env prefix', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'staging-rollback-on-alarm-breach',
      });
    });

    it('filters on aws.cloudwatch source', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          source: ['aws.cloudwatch'],
        }),
      });
    });

    it('filters on CloudWatch Alarm State Change detail type', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          'detail-type': ['CloudWatch Alarm State Change'],
        }),
      });
    });

    it('filters on ALARM state value', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          detail: Match.objectLike({
            state: { value: ['ALARM'] },
          }),
        }),
      });
    });

    it('filters on the specific alarm name extracted from the ARN', () => {
      const { template } = makeStack({ triggerAlarmArns: [ALARM_ARN_1] });
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          detail: Match.objectLike({
            alarmName: ['production-alb-5xx-elb'],
          }),
        }),
      });
    });

    it('includes all alarm names when multiple ARNs are provided', () => {
      const { template } = makeStack({ triggerAlarmArns: [ALARM_ARN_1, ALARM_ARN_2] });
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          detail: Match.objectLike({
            alarmName: Match.arrayWith([
              'production-alb-5xx-elb',
              'production-ecs-cpu-high',
            ]),
          }),
        }),
      });
    });

    it('adds the Lambda function as the rule target', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.anyValue(),
          }),
        ]),
      });
    });

    it('creates a Lambda permission for EventBridge to invoke the function', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunction',
        Principal: 'events.amazonaws.com',
      });
    });
  });

  describe('CloudWatch Log Group', () => {
    it('creates exactly one log group for the Lambda', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::Logs::LogGroup', 1);
    });

    it('names the log group with the Lambda function name', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/lambda/staging-rollback-automation',
        RetentionInDays: 30,
      });
    });
  });

  describe('CodeDeploy target', () => {
    it('serialises CodeDeploy fields into ROLLBACK_TARGETS env var', () => {
      const { template } = makeStack({
        rollbackTargets: [CODEDEPLOY_TARGET],
      });
      const resources = template.findResources('AWS::Lambda::Function');
      const lambdaResource = Object.values(resources)[0] as {
        Properties: { Environment: { Variables: Record<string, string> } };
      };
      const targets = JSON.parse(
        lambdaResource.Properties.Environment.Variables.ROLLBACK_TARGETS,
      ) as typeof CODEDEPLOY_TARGET[];
      expect(targets[0].codeDeployApplication).toBe(CODEDEPLOY_TARGET.codeDeployApplication);
      expect(targets[0].codeDeployDeploymentGroup).toBe(
        CODEDEPLOY_TARGET.codeDeployDeploymentGroup,
      );
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the rollback Lambda ARN', () => {
      const { template } = makeStack({ envName: 'test' });
      template.hasOutput('RollbackLambdaArn', {
        Export: { Name: 'test-rollback-lambda-arn' },
      });
    });

    it('exports the notification topic ARN', () => {
      const { template } = makeStack({ envName: 'test' });
      template.hasOutput('NotificationTopicArn', {
        Export: { Name: 'test-rollback-notification-topic-arn' },
      });
    });

    it('exports the EventBridge rule name', () => {
      const { template } = makeStack({ envName: 'test' });
      template.hasOutput('EventRuleName', {
        Export: { Name: 'test-rollback-event-rule-name' },
      });
    });
  });

  describe('Tags', () => {
    it('tags resources with the environment name', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::SNS::Topic', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'staging' }),
        ]),
      });
    });

    it('tags resources as ManagedBy CDK', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::SNS::Topic', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' }),
        ]),
      });
    });
  });
});
