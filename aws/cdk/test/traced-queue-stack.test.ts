import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import {
  TRACE_CONTEXT_MISSING_EVENT,
  TRACE_CONTEXT_TRUNCATED_EVENT,
  XRAY_SYSTEM_ATTRIBUTE,
} from '../lib/queue-trace-context';
import { DEFAULT_TAIL_SAMPLING } from '../lib/otel-collector-config';
import {
  DECISION_WAIT_TAG,
  QUEUE_TRACING_METRIC_NAMESPACE,
  SYSTEM_ATTRIBUTE_ENV_VAR,
  TRACED_QUEUE_TAG,
  TRACE_CONTEXT_MISSING_METRIC,
  TRACE_CONTEXT_TRUNCATED_METRIC,
  TracedQueueStack,
  TracedQueueStackProps,
} from '../lib/traced-queue-stack';
import { auditQueueTracing } from '../tools/audit-queue-tracing';
import { flattenIntrinsic, resourceProps } from './support/cfn';

/**
 * Tests for the queue half of the tracing path.
 *
 * The load-bearing ones are the two that hold a literal in this stack against a
 * literal somewhere else: the metric filter patterns against the event names
 * `queue-trace-context.ts` logs, and the whole synthesised template against
 * `tools/audit-queue-tracing.ts`. Both pairs are edited independently, nothing
 * in AWS reconciles them, and a mismatch in either produces a metric that
 * reports zero forever — which is what a healthy system also reports.
 */

const synth = (props: Partial<TracedQueueStackProps> = {}): Template => {
  const app = new cdk.App();
  const stack = new TracedQueueStack(app, 'TracedQueueStack-Test', {
    envName: 'production',
    queueName: 'orders',
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return Template.fromStack(stack);
};

describe('the queues', () => {
  const template = synth();

  it('encrypts both queues with a key this stack owns', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.allResourcesProperties('AWS::SQS::Queue', {
      KmsMasterKeyId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('dead-letters the work queue rather than retrying it forever', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'production-orders',
      VisibilityTimeout: 30,
      RedrivePolicy: { maxReceiveCount: 5 },
    });
  });

  // A dead-letter queue with no redrive-allow policy may be named by any queue
  // in the account, so another team's poison messages arrive in this worker's
  // redrive — carrying trace context that points into a different service.
  it('restricts who may dead-letter into the dead-letter queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'production-orders-dlq',
      RedriveAllowPolicy: {
        redrivePermission: 'byQueue',
        sourceQueueArns: [Match.anyValue()],
      },
    });
  });

  // The work queue's RedrivePolicy already holds a GetAtt on the dead-letter
  // queue, so a Ref back the other way is a cycle CloudFormation refuses. The
  // source is named by a formatted ARN instead, which is only possible because
  // both queues have explicit physical names.
  it('names the source queue by ARN, so the two do not reference each other', () => {
    const deadLetter = resourceProps(template, 'AWS::SQS::Queue').find(
      (queue) => queue.QueueName === 'production-orders-dlq',
    );
    const policy = deadLetter?.RedriveAllowPolicy as { sourceQueueArns: unknown[] };

    expect(flattenIntrinsic(policy.sourceQueueArns[0])).toContain('production-orders');
    expect(JSON.stringify(policy)).not.toContain('Fn::GetAtt');
  });

  it('denies plaintext access to both queues', () => {
    template.resourceCountIs('AWS::SQS::QueuePolicy', 2);
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
  });

  // Nothing in an SQS resource says whether trace context is supposed to cross
  // it, so the gate would otherwise have to apply these rules to every queue in
  // the repository — including a Lambda's dead-letter queue.
  it('tags the work queue with the contract the gate reads', () => {
    const workQueue = resourceProps(template, 'AWS::SQS::Queue').find(
      (queue) => queue.QueueName === 'production-orders',
    );
    const tags = Object.fromEntries(
      ((workQueue?.Tags as { Key: string; Value: string }[]) ?? []).map((tag) => [
        tag.Key,
        tag.Value,
      ]),
    );

    expect(tags[TRACED_QUEUE_TAG]).toBe('both');
    expect(tags[DECISION_WAIT_TAG]).toBe(String(DEFAULT_TAIL_SAMPLING.decisionWaitSeconds));
  });
});

describe("the worker's log group and the signal on it", () => {
  const template = synth();

  it('creates the log group rather than leaving it to the awslogs driver', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/production/orders-worker',
      RetentionInDays: 30,
      KmsKeyId: Match.anyValue(),
    });
  });

  // The filter pattern and the string the worker logs are two literals in two
  // files. A pattern that matches nothing publishes zero forever, and a counter
  // reporting zero is indistinguishable from a system in which nothing is wrong.
  it.each([
    [TRACE_CONTEXT_MISSING_EVENT, TRACE_CONTEXT_MISSING_METRIC],
    [TRACE_CONTEXT_TRUNCATED_EVENT, TRACE_CONTEXT_TRUNCATED_METRIC],
  ])('matches the %s event the library logs', (event, metricName) => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: `{ $.event = "${event}" }`,
      MetricTransformations: [
        Match.objectLike({
          MetricName: metricName,
          MetricNamespace: QUEUE_TRACING_METRIC_NAMESPACE,
          MetricValue: '1',
          // Without a default the metric has no datapoint when nothing matched,
          // so the alarm spends most of its life in INSUFFICIENT_DATA rather
          // than in OK.
          DefaultValue: 0,
        }),
      ],
    });
  });
});

describe('the alarms', () => {
  const template = synth();

  it('creates all four', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  });

  // The alarm exists to warn that traces are about to start arriving after they
  // are decided. At or past the decision window it would describe traces
  // already lost.
  it('fires the dwell alarm below the collector decision window', () => {
    const alarm = resourceProps(template, 'AWS::CloudWatch::Alarm').find(
      (properties) => properties.MetricName === 'ApproximateAgeOfOldestMessage',
    );

    expect(alarm?.Threshold).toBe(DEFAULT_TAIL_SAMPLING.decisionWaitSeconds / 2);
    expect(alarm?.Threshold as number).toBeLessThan(DEFAULT_TAIL_SAMPLING.decisionWaitSeconds);
    expect(alarm?.ComparisonOperator).toBe('GreaterThanThreshold');
  });

  it('derives the dwell threshold from the window it is given', () => {
    const alarm = resourceProps(synth({ decisionWaitSeconds: 60 }), 'AWS::CloudWatch::Alarm').find(
      (properties) => properties.MetricName === 'ApproximateAgeOfOldestMessage',
    );

    expect(alarm?.Threshold).toBe(30);
  });

  // Missing data on these two means the worker logged nothing at all, which is
  // a worker that is not running — the ECS service alarms own that, and
  // duplicating it here would leave these red for a reason they cannot fix.
  it.each([TRACE_CONTEXT_MISSING_METRIC, TRACE_CONTEXT_TRUNCATED_METRIC])(
    'treats missing data on %s as not breaching',
    (metricName) => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: metricName,
        Namespace: QUEUE_TRACING_METRIC_NAMESPACE,
        Threshold: 0,
        TreatMissingData: 'notBreaching',
      });
    },
  );

  it('alarms on anything reaching the dead-letter queue', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 0,
      EvaluationPeriods: 1,
    });
  });

  it('publishes to the topic it is given, on alarm and on recovery', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Host', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const topic = new sns.Topic(stack, 'Alarms');
    const withTopic = Template.fromStack(
      new TracedQueueStack(app, 'TracedQueueStack-WithTopic', {
        envName: 'production',
        queueName: 'orders',
        alarmTopic: topic,
        env: { account: '123456789012', region: 'us-east-1' },
      }),
    );

    for (const alarm of resourceProps(withTopic, 'AWS::CloudWatch::Alarm')) {
      expect(alarm.AlarmActions).toHaveLength(1);
      expect(alarm.OKActions).toHaveLength(1);
    }
  });
});

describe('the environment handed to the producer and the worker', () => {
  // ReceiveMessage returns system attributes only when the call names them, and
  // the X-Ray context lives in one. Deploying the name makes the wrong value a
  // template diff rather than a line nobody wrote.
  it("names the system attribute in the worker's environment", () => {
    const environment = TracedQueueStack.workerEnvironment({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/production-orders',
      queueName: 'production-orders',
      format: 'both',
      decisionWaitSeconds: 30,
    });

    expect(environment[SYSTEM_ATTRIBUTE_ENV_VAR]).toBe(XRAY_SYSTEM_ATTRIBUTE);
    expect(environment.TRACE_DECISION_WAIT_SECONDS).toBe('30');
  });

  // The producer has no parent-or-link boundary to draw, which is what the gate
  // uses to tell a producer container from a worker one.
  it('gives the producer no decision window', () => {
    const environment = TracedQueueStack.producerEnvironment({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/production-orders',
      format: 'both',
    });

    expect(environment.TRACE_DECISION_WAIT_SECONDS).toBeUndefined();
    expect(environment.TRACE_PROPAGATION_FORMAT).toBe('both');
  });
});

describe('grants', () => {
  const grantTemplate = (grant: 'produce' | 'consume'): Template => {
    const app = new cdk.App();
    const stack = new TracedQueueStack(app, `TracedQueueStack-${grant}`, {
      envName: 'production',
      queueName: 'orders',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const role = new iam.Role(stack, 'Grantee', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    if (grant === 'produce') stack.grantProduce(role);
    else stack.grantConsume(role);
    return Template.fromStack(stack);
  };

  // A customer-managed key means the queue grant is not enough on its own;
  // `grantSendMessages` adds the KMS actions, which is why neither caller needs
  // a separate key grant.
  it('grants the producer send and the key actions that go with it', () => {
    const statements = JSON.stringify(
      resourceProps(grantTemplate('produce'), 'AWS::IAM::Policy'),
    );

    expect(statements).toContain('sqs:SendMessage');
    expect(statements).toContain('kms:GenerateDataKey');
    expect(statements).not.toContain('sqs:ReceiveMessage');
  });

  it('grants the worker receive and delete', () => {
    const statements = JSON.stringify(
      resourceProps(grantTemplate('consume'), 'AWS::IAM::Policy'),
    );

    expect(statements).toContain('sqs:ReceiveMessage');
    expect(statements).toContain('sqs:DeleteMessage');
    expect(statements).not.toContain('sqs:SendMessage');
  });
});

describe('configurations refused at synth', () => {
  // Every one of these deploys cleanly and traces nothing, which is why they
  // fail at the line that declared them rather than in an incident.
  it('refuses a dwell alarm at or past the decision window', () => {
    expect(() => synth({ decisionWaitSeconds: 30, dwellAlarmSeconds: 30 })).toThrow(
      /record of the loss rather than a warning/,
    );
  });

  it('refuses a non-raw SNS subscription carrying W3C context', () => {
    expect(() =>
      synth({ propagation: { viaSnsTopic: true, snsRawMessageDelivery: false } }),
    ).toThrow(/notification envelope/);
  });

  it('refuses a producer with no attribute slot left for context', () => {
    expect(() => synth({ propagation: { businessAttributeCount: 10 } })).toThrow(
      /over SQS's limit of 10/,
    );
  });

  it('refuses a batching Lambda consumer with no span per message', () => {
    expect(() => synth({ propagation: { consumer: 'lambda', batchSize: 10 } })).toThrow(
      /poller invocation/,
    );
  });
});

// The gate reads `cdk.out`, so the stack it is supposed to pass and the rules
// it enforces are otherwise never run against each other until CI. A rule that
// no longer matches what this stack synthesises would go unnoticed in both
// directions: the gate would pass every template, and this stack would pass
// every gate.
describe('against tools/audit-queue-tracing.ts', () => {
  it('synthesises a template the gate reports nothing on', () => {
    const result = auditQueueTracing({
      templates: [{ path: 'TracedQueueStack-Test.template.json', document: synth().toJSON() }],
    });

    expect(result.violations).toEqual([]);
    expect(result.tracedQueuesRead).toBe(1);
  });
});
