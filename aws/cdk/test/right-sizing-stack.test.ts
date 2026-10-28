import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import {
  ACCOUNT_SCOPE,
  DEFAULT_SWEEP_SCHEDULE_HOURS,
  DEFAULT_SWEEP_STALE_HOURS,
  RIGHT_SIZING_LOG_SCHEMA_VERSION,
  RIGHT_SIZING_SWEEPER_SOURCE,
  RightSizingStack,
  SCOPE_DIMENSION,
  type RightSizingStackProps,
} from '../lib/right-sizing-stack';
import {
  COVERAGE_GAP_METRIC,
  ENROLLED_METRIC,
  ENROLMENT_ACTIVE,
  RIGHT_SIZING_METRIC_NAMESPACE,
  RIGHT_SIZING_WORKLOADS,
  SWEEP_SUCCESS_METRIC,
  rightSizingWorkloadById,
} from '../lib/right-sizing';

/**
 * Tests for the Compute Optimizer sweeper and its alarms.
 *
 * The properties asserted here are the ones whose absence deploys cleanly and
 * reads as working: a staleness alarm that tolerates missing data is green
 * through the outage where the sweep stopped running; a role with one write
 * action turns a proposal into drift the next deploy reverts; a schedule with no
 * dead-letter queue leaves a schedule that stopped delivering and a sweep that
 * found nothing publishing the same thing.
 */

const ENV = { account: '123456789012', region: 'us-east-1' };

const synthWith = (props: Partial<RightSizingStackProps> = {}) => {
  const app = new cdk.App();
  const topicStack = new cdk.Stack(app, 'Topics', { env: ENV });
  const alarmTopic = new sns.Topic(topicStack, 'AlarmTopic', {
    topicName: 'production-cloudwatch-alarms',
  });

  const stack = new RightSizingStack(app, 'RightSizingStack-Test', {
    alarmTopic,
    workloads: RIGHT_SIZING_WORKLOADS,
    env: ENV,
    ...props,
  });
  return { stack, template: Template.fromStack(stack) };
};

describe('the sweeper function', () => {
  it('runs on arm64 on a supported runtime, with one concurrent execution', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: 'nodejs22.x',
      ReservedConcurrentExecutions: 1,
    });
  });

  it('carries the catalogue, the enrolment value and the AWS thresholds', () => {
    const { template } = synthWith();
    const functions = template.findResources('AWS::Lambda::Function');
    const variables = Object.values(functions)[0].Properties.Environment.Variables;

    expect(variables.METRIC_NAMESPACE).toBe(RIGHT_SIZING_METRIC_NAMESPACE);
    expect(variables.SCOPE).toBe(ACCOUNT_SCOPE);
    expect(variables.EXPECTED_ENROLMENT).toBe(ENROLMENT_ACTIVE);
    expect(variables.LOG_SCHEMA_VERSION).toBe(String(RIGHT_SIZING_LOG_SCHEMA_VERSION));

    // Every entry, including the uncovered ones: without them in the sweeper's
    // hands a missing finding is just a missing finding.
    const catalogue = JSON.parse(variables.CATALOGUE);
    expect(catalogue).toHaveLength(RIGHT_SIZING_WORKLOADS.length);
    expect(catalogue.map((entry: { id: string }) => entry.id)).toContain('production-application');
  });

  it('writes to a log group with an explicit retention', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });
  });

  it('dead-letters what EventBridge cannot deliver, on an encrypted queue', () => {
    const { template } = synthWith();
    // The AWS-managed SQS key rather than SSE-SQS: both encrypt at rest with no
    // key to rotate, and only this one satisfies CKV_AWS_27. CDK renders the
    // alias as a joined ARN, so the assertion is on what ships.
    const queues = template.findResources('AWS::SQS::Queue');
    expect(Object.keys(queues)).toHaveLength(1);
    const queue = Object.values(queues)[0];
    // CDK renders the alias as a joined ARN, so the assertion is on what ships.
    expect(JSON.stringify(queue.Properties.KmsMasterKeyId)).toContain(':alias/aws/sqs');
    expect(queue.Properties.MessageRetentionPeriod).toBe(1209600);
    // enforceSSL adds the aws:SecureTransport deny, which is a separate
    // resource rather than a queue property.
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      DeadLetterConfig: { TargetArn: Match.anyValue() },
    });
  });
});

describe('the sweeper role', () => {
  const statementsOf = (template: Template): Record<string, any>[] => {
    const policies = template.findResources('AWS::IAM::Policy');
    return Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Record<string, any>[],
    );
  };

  it('holds three Compute Optimizer reads and nothing else on compute', () => {
    const { template } = synthWith();
    const actions = statementsOf(template).flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );

    expect(actions).toEqual(
      expect.arrayContaining([
        'compute-optimizer:GetEnrollmentStatus',
        'compute-optimizer:GetECSServiceRecommendations',
        'compute-optimizer:GetLambdaFunctionRecommendations',
      ]),
    );

    // The whole design rests on this: a resize applied outside CloudFormation
    // is reverted by the next deploy, and the revert is as silent as the change.
    // `UpdateEnrollmentStatus` is here too — it creates a service-linked role,
    // and it is the write that does not look like one.
    for (const action of actions) {
      expect(action).not.toMatch(/^ecs:/);
      expect(action).not.toMatch(/^application-autoscaling:/);
      expect(action).not.toMatch(/^lambda:/);
      expect(action).not.toMatch(/^compute-optimizer:(?!Get)/);
    }
  });

  it('scopes PutMetricData to the one namespace it publishes to', () => {
    const { template } = synthWith();
    const metricStatement = statementsOf(template).find((statement) =>
      String(statement.Action).includes('cloudwatch:PutMetricData'),
    );
    expect(metricStatement?.Condition).toEqual({
      StringEquals: { 'cloudwatch:namespace': RIGHT_SIZING_METRIC_NAMESPACE },
    });
  });
});

describe('the schedule', () => {
  it('runs on the default interval and dead-letters its target', () => {
    const { template } = synthWith();
    // CDK renders `Duration.hours(24)` as `rate(1 day)`, which is the same
    // schedule EventBridge would have built from 24 hours and is asserted as
    // what ships rather than as what was asked for.
    expect(DEFAULT_SWEEP_SCHEDULE_HOURS).toBe(24);
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 day)',
      Targets: Match.arrayWith([
        Match.objectLike({ DeadLetterConfig: { Arn: Match.anyValue() } }),
      ]),
    });
  });

  it('takes an interval', () => {
    const { template } = synthWith({ sweepScheduleHours: 6, sweepStaleHours: 24 });
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(6 hours)',
    });
  });
});

describe('the alarms', () => {
  it('creates the five, with no environment prefix on the names', () => {
    const { template } = synthWith();
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
      (alarm) => alarm.Properties.AlarmName,
    );
    expect(alarms.sort()).toEqual([
      'right-sizing-coverage-gap',
      'right-sizing-not-enrolled',
      'right-sizing-sweep-stale',
      'right-sizing-sweep-undelivered',
      'right-sizing-sweeper-errors',
    ]);
  });

  /**
   * The single property that makes "the integration stopped" visible. A disabled
   * rule, a deleted schedule or a role that lost `compute-optimizer:Get*`
   * produce no datapoints at all, and the other four alarms go quiet with them.
   */
  it('treats missing data as breaching on the staleness alarm and only there', () => {
    const { template } = synthWith();
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      const expected =
        alarm.Properties.AlarmName === 'right-sizing-sweep-stale' ? 'breaching' : 'notBreaching';
      expect(alarm.Properties.TreatMissingData).toBe(expected);
    }
  });

  it('alarms on the three metrics whose silence is mistaken for success', () => {
    const { template } = synthWith();
    for (const metricName of [ENROLLED_METRIC, SWEEP_SUCCESS_METRIC, COVERAGE_GAP_METRIC]) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: RIGHT_SIZING_METRIC_NAMESPACE,
        MetricName: metricName,
        Dimensions: [{ Name: SCOPE_DIMENSION, Value: ACCOUNT_SCOPE }],
      });
    }
  });

  it('fires the coverage alarm on a single gap', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: COVERAGE_GAP_METRIC,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  it('notifies the topic on both alarm and recovery', () => {
    const { template } = synthWith();
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toHaveLength(5);
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
      expect(alarm.Properties.OKActions).toHaveLength(1);
    }
  });
});

describe('tags', () => {
  /**
   * The stack is account-scoped, so there is no true `Environment` value to give
   * it and inventing one reads in Cost Explorer as a fourth environment.
   * `policy/cloudformation/tags.rego` requires ManagedBy and Stack for exactly
   * this reason.
   */
  it('carries ManagedBy and Stack and deliberately no Environment', () => {
    const { template } = synthWith();
    const queue = Object.values(template.findResources('AWS::SQS::Queue'))[0];
    const keys = (queue.Properties.Tags as { Key: string }[]).map((tag) => tag.Key);
    expect(keys).toContain('ManagedBy');
    expect(keys).toContain('Stack');
    expect(keys).not.toContain('Environment');
  });
});

describe('construction refuses what would deploy quietly', () => {
  it('refuses an empty catalogue', () => {
    expect(() => synthWith({ workloads: [] })).toThrow(/no workloads/);
  });

  it('refuses a staleness window no longer than the schedule', () => {
    expect(() => synthWith({ sweepScheduleHours: 24, sweepStaleHours: 24 })).toThrow(
      /must exceed sweepScheduleHours/,
    );
  });

  it('refuses a catalogue that would not pass its own validation', () => {
    const broken = [{ ...rightSizingWorkloadById('blue-green-service'), floor: undefined }];
    expect(() => synthWith({ workloads: broken })).toThrow(/Invalid right-sizing catalogue/);
  });

  it('uses the documented defaults', () => {
    expect(DEFAULT_SWEEP_SCHEDULE_HOURS).toBe(24);
    expect(DEFAULT_SWEEP_STALE_HOURS).toBe(48);
    expect(DEFAULT_SWEEP_STALE_HOURS).toBeGreaterThan(DEFAULT_SWEEP_SCHEDULE_HOURS);
  });
});

describe('the shipped handler source', () => {
  it('reads enrolment before any recommendation call', () => {
    const enrolmentAt = RIGHT_SIZING_SWEEPER_SOURCE.indexOf('GetEnrollmentStatusCommand({})');
    const recommendationAt = RIGHT_SIZING_SWEEPER_SOURCE.indexOf(
      'GetECSServiceRecommendationsCommand(token',
    );
    expect(enrolmentAt).toBeGreaterThan(-1);
    expect(recommendationAt).toBeGreaterThan(enrolmentAt);
  });

  it('publishes SweepSuccess last, after everything it reports on', () => {
    const successAt = RIGHT_SIZING_SWEEPER_SOURCE.indexOf(`name: '${SWEEP_SUCCESS_METRIC}'`);
    const coverageAt = RIGHT_SIZING_SWEEPER_SOURCE.indexOf(`name: '${COVERAGE_GAP_METRIC}'`);
    expect(coverageAt).toBeGreaterThan(-1);
    expect(successAt).toBeGreaterThan(coverageAt);
  });
});
