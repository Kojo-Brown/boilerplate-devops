import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import {
  CONTAINER_INSIGHTS_NAMESPACE,
  DEFAULT_INTERRUPTIONS_PER_HOUR_THRESHOLD,
  DESIRED_TASK_COUNT_METRIC,
  RUNNING_TASK_COUNT_METRIC,
  SPOT_LOG_SCHEMA_VERSION,
  SPOT_RECORDER_SOURCE,
  STARVATION_EVALUATION_PERIODS,
  SpotInterruptionStack,
  type SpotInterruptionStackProps,
} from '../lib/spot-interruption-stack';
import {
  FARGATE_SPOT_WARNING_SECONDS,
  SPOT_INTERRUPTION_STOP_CODE,
  SPOT_METRIC_NAMESPACE,
  spotWorkloadById,
} from '../lib/spot-capacity';

/**
 * Tests for the interruption recorder and its alarms.
 *
 * The properties asserted here are the ones whose absence deploys cleanly and
 * reads as working: a starvation alarm that ignores missing data is green
 * through the shortage it was written for; a rule with no `stopCode` filter
 * counts every deployment as a reclaim; a rule with no dead-letter queue drops
 * the datapoint that cannot be re-collected, because the task is already gone.
 */

const ENV = { account: '123456789012', region: 'us-east-1' };

const CLUSTER_ARNS = [
  'arn:aws:ecs:us-east-1:123456789012:cluster/staging-cluster',
  'arn:aws:ecs:us-east-1:123456789012:cluster/preview-cluster',
];

const synthWith = (props: Partial<SpotInterruptionStackProps> = {}) => {
  const app = new cdk.App();
  const topicStack = new cdk.Stack(app, 'Topics', { env: ENV });
  const alarmTopic = new sns.Topic(topicStack, 'AlarmTopic', {
    topicName: 'staging-cloudwatch-alarms',
  });

  const stack = new SpotInterruptionStack(app, 'SpotInterruptionStack-Test', {
    envName: 'staging',
    alarmTopic,
    monitoredClusterArns: CLUSTER_ARNS,
    workloads: [
      { serviceNamePattern: 'staging-service', workload: spotWorkloadById('staging-application') },
      { serviceNamePattern: 'preview-pr-*', workload: spotWorkloadById('preview-pr-service') },
    ],
    starvationTarget: {
      clusterName: 'staging-cluster',
      serviceName: 'staging-service',
      onDemandBase: 1,
    },
    env: ENV,
    ...props,
  });

  return { stack, template: Template.fromStack(stack), alarmTopic };
};

const alarmByName = (template: Template, alarmName: string): Record<string, any> => {
  const alarms = template.findResources('AWS::CloudWatch::Alarm');
  const found = Object.values(alarms).find(
    (alarm) => (alarm.Properties as any).AlarmName === alarmName,
  );
  if (!found) throw new Error(`no alarm named ${alarmName}`);
  return (found as any).Properties;
};

describe('refusing to synthesise something inert', () => {
  it('refuses an empty cluster list, which an event pattern reads as "all of them"', () => {
    expect(() => synthWith({ monitoredClusterArns: [] })).toThrow(/matches every task state change/);
  });

  it('refuses no workloads, which leaves the overrun metric structurally zero', () => {
    expect(() => synthWith({ workloads: [] })).toThrow(/nothing to measure an overrun against/);
  });

  it('refuses a workload the catalogue would reject', () => {
    expect(() =>
      synthWith({
        workloads: [
          {
            serviceNamePattern: 'staging-service',
            workload: { ...spotWorkloadById('staging-application'), onDemandBase: 0 },
          },
        ],
      }),
    ).toThrow(/\[base-missing\]/);
  });
});

describe('the rule', () => {
  it('filters on the stop code, so a deployment is not counted as a reclaim', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: Match.objectLike({ stopCode: [SPOT_INTERRUPTION_STOP_CODE] }),
      }),
    });
  });

  it('names the clusters rather than matching every task stop in the account', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        detail: Match.objectLike({ clusterArn: CLUSTER_ARNS }),
      }),
    });
  });

  it('does not filter on lastStatus, because both halves of the reclaim matter', () => {
    // The warning arrives with lastStatus RUNNING and desiredStatus STOPPED;
    // the timestamps the overrun is measured from arrive with lastStatus
    // STOPPED. Filtering to either loses half the signal.
    const { template } = synthWith();
    const rules = template.findResources('AWS::Events::Rule');
    const pattern = (Object.values(rules)[0] as any).Properties.EventPattern;
    expect(pattern.detail.lastStatus).toBeUndefined();
    expect(pattern.detail.desiredStatus).toBeUndefined();
  });

  it('dead-letters its target, since an undelivered reclaim cannot be re-collected', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          DeadLetterConfig: { Arn: Match.anyValue() },
          RetryPolicy: Match.objectLike({ MaximumRetryAttempts: 3 }),
        }),
      ]),
    });
  });
});

describe('the recorder', () => {
  it('runs on arm64 on a supported managed runtime', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: 'nodejs22.x',
      ReservedConcurrentExecutions: 1,
      DeadLetterConfig: { TargetArn: Match.anyValue() },
    });
  });

  it('is handed the declared budgets rather than a constant of its own', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          METRIC_NAMESPACE: SPOT_METRIC_NAMESPACE,
          ENVIRONMENT_NAME: 'staging',
          EXPECTED_STOP_CODE: SPOT_INTERRUPTION_STOP_CODE,
          WARNING_SECONDS: String(FARGATE_SPOT_WARNING_SECONDS),
          LOG_SCHEMA_VERSION: String(SPOT_LOG_SCHEMA_VERSION),
          // 30 + 60 for staging, 5 + 30 for a preview.
          DRAIN_BUDGETS: JSON.stringify({ 'staging-service': 90, 'preview-pr-*': 35 }),
        }),
      },
    });
  });

  it('can publish Spot metrics and nothing else, and needs no ECS permission', () => {
    const { template } = synthWith();
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (policy) => (policy.Properties as any).PolicyDocument.Statement,
    );

    const putMetric = statements.find((statement: any) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(
        'cloudwatch:PutMetricData',
      ),
    );
    expect(putMetric.Condition).toEqual({
      StringEquals: { 'cloudwatch:namespace': SPOT_METRIC_NAMESPACE },
    });

    const actions = statements.flatMap((statement: any) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );
    expect(actions.filter((action: string) => action.startsWith('ecs:'))).toEqual([]);
    expect(actions).not.toContain('*');
  });

  it('keeps undeliverable events for two weeks, encrypted, over TLS', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
      KmsMasterKeyId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      }),
    });
  });

  it('retains its log group rather than keeping logs forever', () => {
    const { template } = synthWith();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });
  });
});

describe('the starvation alarm', () => {
  it('compares running tasks with desired, FILL()ing both terms', () => {
    const alarm = alarmByName(synthWith().template, 'staging-spot-capacity-starved');
    const expression = alarm.Metrics.find((metric: any) => metric.Expression);
    expect(expression.Expression).toBe('FILL(running, 0) - FILL(desired, REPEAT)');

    const metricNames = alarm.Metrics.filter((metric: any) => metric.MetricStat).map(
      (metric: any) => metric.MetricStat.Metric.MetricName,
    );
    expect(metricNames.sort()).toEqual([DESIRED_TASK_COUNT_METRIC, RUNNING_TASK_COUNT_METRIC]);
    for (const metric of alarm.Metrics.filter((metric: any) => metric.MetricStat)) {
      expect(metric.MetricStat.Metric.Namespace).toBe(CONTAINER_INSIGHTS_NAMESPACE);
      expect(metric.MetricStat.Metric.Dimensions).toEqual([
        { Name: 'ClusterName', Value: 'staging-cluster' },
        { Name: 'ServiceName', Value: 'staging-service' },
      ]);
    }
  });

  it('treats missing data as breaching, because the symptom is an absence', () => {
    const alarm = alarmByName(synthWith().template, 'staging-spot-capacity-starved');
    expect(alarm.TreatMissingData).toBe('breaching');
    expect(alarm.Threshold).toBe(-1);
    expect(alarm.ComparisonOperator).toBe('LessThanOrEqualToThreshold');
  });

  it('waits out a deployment before it pages', () => {
    const alarm = alarmByName(synthWith().template, 'staging-spot-capacity-starved');
    expect(alarm.EvaluationPeriods).toBe(STARVATION_EVALUATION_PERIODS);
    expect(alarm.DatapointsToAlarm).toBe(STARVATION_EVALUATION_PERIODS);
    expect(STARVATION_EVALUATION_PERIODS).toBeGreaterThanOrEqual(15);
  });
});

describe('the other four alarms', () => {
  it('treats no datapoints as healthy, since the recorder publishes on an event', () => {
    const { template } = synthWith();
    for (const alarmName of [
      'staging-spot-interruptions-high',
      'staging-spot-drain-overrun',
      'staging-spot-recorder-errors',
      'staging-spot-events-undelivered',
    ]) {
      expect(alarmByName(template, alarmName).TreatMissingData).toBe('notBreaching');
    }
  });

  it('tolerates no overrun at all', () => {
    const alarm = alarmByName(synthWith().template, 'staging-spot-drain-overrun');
    expect(alarm.Threshold).toBe(1);
    expect(alarm.ComparisonOperator).toBe('GreaterThanOrEqualToThreshold');
    expect(alarm.Namespace).toBe(SPOT_METRIC_NAMESPACE);
    expect(alarm.MetricName).toBe('DrainOverruns');
  });

  it('reads the interruption rate over an hour at the declared threshold', () => {
    const alarm = alarmByName(synthWith().template, 'staging-spot-interruptions-high');
    expect(alarm.Threshold).toBe(DEFAULT_INTERRUPTIONS_PER_HOUR_THRESHOLD);
    expect(alarm.Period).toBe(3600);
    expect(alarm.Statistic).toBe('Sum');
    expect(alarm.Dimensions).toEqual([{ Name: 'Environment', Value: 'staging' }]);
  });

  it('takes the threshold from the caller when it is given one', () => {
    const { template } = synthWith({ interruptionsPerHourThreshold: 2 });
    expect(alarmByName(template, 'staging-spot-interruptions-high').Threshold).toBe(2);
  });
});

describe('every alarm', () => {
  it('notifies the topic the enricher is already subscribed to, on both transitions', () => {
    const { template } = synthWith();
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms)).toHaveLength(5);
    for (const alarm of Object.values(alarms)) {
      const properties = alarm.Properties as any;
      expect(properties.AlarmActions).toHaveLength(1);
      // The OK action matters as much as the alarm one: an alarm that never
      // reports recovery leaves the enriched page as the last thing anybody
      // saw.
      expect(properties.OKActions).toEqual(properties.AlarmActions);
    }
  });

  it('points at docs/runbooks.md from its description', () => {
    const { template } = synthWith();
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      expect((alarm.Properties as any).AlarmDescription).toContain('docs/runbooks.md');
    }
  });
});

describe('tagging', () => {
  it('carries the tags the policy pack requires on everything it creates', () => {
    const { template } = synthWith();
    for (const type of ['AWS::SQS::Queue', 'AWS::Lambda::Function', 'AWS::Logs::LogGroup']) {
      for (const resource of Object.values(template.findResources(type))) {
        const tags = (resource.Properties as any).Tags ?? [];
        const keys = tags.map((tag: any) => tag.Key);
        expect(keys).toContain('ManagedBy');
        expect(keys).toContain('Stack');
        expect(tags.find((tag: any) => tag.Key === 'Environment').Value).toBe('staging');
      }
    }
  });
});

describe('the handler source', () => {
  it('names the metrics the alarms read, so a rename cannot pass silently', () => {
    for (const metric of ['Interruptions', 'DrainSeconds', 'DrainOverruns', 'DrainUnmeasured']) {
      expect(SPOT_RECORDER_SOURCE).toContain(`name: '${metric}'`);
    }
  });

  it('re-checks the stop code the rule already filters on', () => {
    expect(SPOT_RECORDER_SOURCE).toContain('detail.stopCode !== EXPECTED_STOP_CODE');
  });
});
