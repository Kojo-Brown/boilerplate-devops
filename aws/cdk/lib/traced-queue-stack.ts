import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { DEFAULT_TAIL_SAMPLING } from './otel-collector-config';
import { OtelCollectorStack } from './otel-collector-stack';
import {
  PropagationFormat,
  QueueConsumer,
  QueuePropagationSpec,
  TRACE_CONTEXT_MISSING_EVENT,
  TRACE_CONTEXT_TRUNCATED_EVENT,
  XRAY_SYSTEM_ATTRIBUTE,
  validateQueuePropagation,
} from './queue-trace-context';

/** CloudWatch namespace holding the two propagation-health metrics. */
export const QUEUE_TRACING_METRIC_NAMESPACE = 'Boilerplate/QueueTracing';

/**
 * Tag marking a queue as one trace context is supposed to cross, valued with
 * the wire format. Read by `tools/audit-queue-tracing.ts` — see the tag block
 * at the end of the constructor for why the gate needs it.
 */
export const TRACED_QUEUE_TAG = 'TraceContextPropagation';

/** Tag carrying the collector decision window this queue was sized against. */
export const DECISION_WAIT_TAG = 'TraceDecisionWaitSeconds';

/** Environment variable naming the system attributes a worker must ask for. */
export const SYSTEM_ATTRIBUTE_ENV_VAR = 'TRACE_MESSAGE_SYSTEM_ATTRIBUTE_NAMES';

/** Environment variable marking a container as a producer or worker here. */
export const QUEUE_URL_ENV_VAR = 'TRACED_QUEUE_URL';

/** Metric published by the missing-context filter. */
export const TRACE_CONTEXT_MISSING_METRIC = 'TraceContextMissing';
/** Metric published by the truncated-context filter. */
export const TRACE_CONTEXT_TRUNCATED_METRIC = 'TraceContextTruncated';

/**
 * The producer's and the worker's halves of the propagation contract, as the
 * caller states them. Everything else in {@link QueuePropagationSpec} is
 * derived from the queue this stack builds.
 */
export interface QueuePropagationOptions {
  /** Which wire formats the producer writes (default: `both`). */
  readonly format?: PropagationFormat;
  /** What consumes the queue (default: `ecs-poller`). */
  readonly consumer?: QueueConsumer;
  /**
   * Business message attributes the producer sends at most, context excluded.
   *
   * The maximum across every message shape, not the typical one: SQS enforces
   * its limit of ten per message, so the shape carrying the most attributes is
   * the one that fails, and it fails at `SendMessage` in production.
   */
  readonly businessAttributeCount?: number;
  /** Those attributes' names, checked for case and for reserved prefixes. */
  readonly attributeNames?: readonly string[];
  /** True when an SNS topic fans into this queue. */
  readonly viaSnsTopic?: boolean;
  /** `RawMessageDelivery` on that subscription. Required with `viaSnsTopic`. */
  readonly snsRawMessageDelivery?: boolean;
  /** Event source mapping batch size, for a Lambda consumer (default: 1). */
  readonly batchSize?: number;
  /** Whether the consumer opens a span per message rather than per batch. */
  readonly perMessageContext?: boolean;
}

export interface TracedQueueStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging. */
  readonly envName?: string;
  /**
   * Base name for the queue, its dead-letter queue and the worker log group.
   * Kebab case — it becomes part of a queue name and a log group path.
   */
  readonly queueName: string;
  /** The propagation contract this queue's producer and worker implement. */
  readonly propagation?: QueuePropagationOptions;
  /** Visibility timeout in seconds (default: 30). */
  readonly visibilityTimeoutSeconds?: number;
  /** Deliveries before a message is dead-lettered (default: 5). */
  readonly maxReceiveCount?: number;
  /** How long a message is retained, in days (default: 4). */
  readonly retentionDays?: number;
  /**
   * The collector's `decisionWaitSeconds` for this environment.
   *
   * Defaults to `DEFAULT_TAIL_SAMPLING`'s, and should be passed explicitly
   * whenever `OtelCollectorStack` for the same environment was given a
   * different `sampling`. It is the number the parent-or-link boundary and the
   * dwell alarm are both derived from, so a copy of it that has drifted moves
   * both of them silently.
   */
  readonly decisionWaitSeconds?: number;
  /**
   * Queue age, in seconds, at which the dwell alarm fires.
   *
   * Defaults to half the decision window. Must be below it — see the alarm's
   * description, and `validateQueuePropagation`.
   */
  readonly dwellAlarmSeconds?: number;
  /** Topic the alarms publish to — typically `CloudWatchAlarmsStack`'s. */
  readonly alarmTopic?: sns.ITopic;
  /** Retention for the worker's log group (default: one month). */
  readonly logRetention?: logs.RetentionDays;
  /** Create the queue as FIFO (default: false). */
  readonly fifo?: boolean;
}

/**
 * An API → queue → worker path whose trace survives the queue, and the alarms
 * that say when it stopped.
 *
 * `lib/queue-trace-context.ts` is the contract — which carrier holds what, when
 * a worker span is a child and when it is a link, and the configurations that
 * deploy cleanly and trace nothing. This is the AWS half of it: the queue, the
 * dead-letter queue, the worker's log group, and four alarms.
 *
 * Three decisions are worth knowing before reading.
 *
 * **The worker's environment carries `AWSTraceHeader` as a deployed value, not
 * as documentation.** `ReceiveMessage` returns system attributes only when the
 * call names them, and the X-Ray context lives in one. A worker that forgets
 * the parameter gets a response with the field absent — no error, no warning,
 * and a fresh trace for every message it handles. Putting the name in
 * {@link workerEnvironment} means the wrong value is a diff in a template
 * rather than a line nobody wrote.
 *
 * **The dwell alarm is derived from the collector's decision window, not
 * chosen.** `OtelCollectorStack`'s tail sampler holds a trace for
 * `decisionWaitSeconds` after its first span and then decides it for good. A
 * message that waits longer than that is processed into a trace that has
 * already been exported, so the worker's spans are dropped as late arrivals and
 * the trace shows an API call that went nowhere. The alarm therefore fires at a
 * fraction of that window — before the loss, which is the only time an alarm
 * about it is worth anything.
 *
 * **Both propagation failures are reported by the worker, because nothing else
 * can see them.** A worker that found no context does exactly what a worker at
 * the start of a trace does: it starts a trace. There is no AWS metric for it,
 * no failed API call, and nothing in the queue's own telemetry that differs. So
 * the contract is that the worker logs {@link TRACE_CONTEXT_MISSING_EVENT}, and
 * this stack turns that into a metric and an alarm. The filter pattern here and
 * the string the worker writes are pinned together by
 * `test/traced-queue-stack.test.ts`; they are otherwise two literals in two
 * files with nothing reconciling them.
 *
 * What this stack does *not* do is deploy the worker. Application services come
 * from `EcsStack`; {@link workerEnvironment} and {@link grantConsume} are how a
 * worker is attached to this queue. See `docs/queue-tracing.md`.
 */
export class TracedQueueStack extends cdk.Stack {
  /** The work queue. */
  public readonly queue: sqs.Queue;
  /** Its dead-letter queue. Messages here will link rather than parent. */
  public readonly deadLetterQueue: sqs.Queue;
  /** The worker's log group — the two metric filters read it. */
  public readonly workerLogGroup: logs.LogGroup;
  /** KMS key encrypting both queues and the worker's log group. */
  public readonly encryptionKey: kms.Key;
  /** Alarms created by this stack, in the order documented in §6. */
  public readonly alarms: readonly cloudwatch.Alarm[];
  /** The validated contract, for the worker and producer stacks to read. */
  public readonly propagationSpec: QueuePropagationSpec;

  /**
   * Environment variables the *producer* (the API) container needs.
   *
   * `OtelCollectorStack.appEnvironment` on top of these: the producer is an
   * ordinary traced service that additionally sends messages.
   */
  static producerEnvironment(options: {
    readonly queueUrl: string;
    readonly format: PropagationFormat;
  }): Record<string, string> {
    return {
      [QUEUE_URL_ENV_VAR]: options.queueUrl,
      TRACE_PROPAGATION_FORMAT: options.format,
    };
  }

  /**
   * Environment variables the *worker* container needs.
   *
   * `TRACE_MESSAGE_SYSTEM_ATTRIBUTE_NAMES` is the one that decides whether any
   * X-Ray context arrives at all — see the class comment.
   * `TRACE_DECISION_WAIT_SECONDS` is what the worker hands
   * `propagationDecision`, so the parent-or-link boundary is the collector's
   * real decision window rather than a constant compiled into the worker.
   */
  static workerEnvironment(options: {
    readonly queueUrl: string;
    readonly queueName: string;
    readonly format: PropagationFormat;
    readonly decisionWaitSeconds: number;
  }): Record<string, string> {
    return {
      [QUEUE_URL_ENV_VAR]: options.queueUrl,
      TRACED_QUEUE_NAME: options.queueName,
      TRACE_PROPAGATION_FORMAT: options.format,
      TRACE_DECISION_WAIT_SECONDS: String(options.decisionWaitSeconds),
      [SYSTEM_ATTRIBUTE_ENV_VAR]: XRAY_SYSTEM_ATTRIBUTE,
    };
  }

  constructor(scope: Construct, id: string, props: TracedQueueStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const visibilityTimeoutSeconds = props.visibilityTimeoutSeconds ?? 30;
    const maxReceiveCount = props.maxReceiveCount ?? 5;
    const retentionDays = props.retentionDays ?? 4;
    const decisionWaitSeconds =
      props.decisionWaitSeconds ?? DEFAULT_TAIL_SAMPLING.decisionWaitSeconds;
    const dwellAlarmSeconds = props.dwellAlarmSeconds ?? Math.floor(decisionWaitSeconds / 2);
    const logRetention = props.logRetention ?? logs.RetentionDays.ONE_MONTH;
    const fifo = props.fifo ?? false;
    const options = props.propagation ?? {};
    const format = options.format ?? 'both';

    const suffix = fifo ? '.fifo' : '';
    const queueName = `${envName}-${props.queueName}${suffix}`;
    const deadLetterQueueName = `${envName}-${props.queueName}-dlq${suffix}`;
    const workerLogGroupName = `/ecs/${envName}/${props.queueName}-worker`;

    // ── The contract ──────────────────────────────────────────────────────────
    // Validated before anything is created, so a configuration that would trace
    // nothing fails at `cdk synth` on the line that declared it rather than in
    // an incident three months later. Every rule is a shape AWS accepts.
    this.propagationSpec = {
      queueName,
      format,
      consumer: options.consumer ?? 'ecs-poller',
      // Not a claim about the worker's code: it is the value
      // `workerEnvironment` puts in the task definition, which is what the
      // worker reads to build its receive call. The gate in
      // `tools/audit-queue-tracing.ts` checks that the deployed task definition
      // still carries it.
      requestsSystemAttributes: true,
      businessAttributeCount: options.businessAttributeCount ?? 0,
      attributeNames: options.attributeNames,
      viaSnsTopic: options.viaSnsTopic,
      snsRawMessageDelivery: options.snsRawMessageDelivery,
      batchSize: options.batchSize,
      perMessageContext: options.perMessageContext,
      // The application half of this is `OtelCollectorStack.appEnvironment`,
      // which sets exactly this value; restating it here is what lets the
      // validator refuse a worker that head-samples independently of the
      // producer, which is otherwise a green pipeline emitting half traces.
      consumerSampler: OtelCollectorStack.appEnvironment({
        serviceName: `${props.queueName}-worker`,
        envName,
      }).OTEL_TRACES_SAMPLER,
      decisionWaitSeconds,
      dwellAlarmSeconds,
      visibilityTimeoutSeconds,
      maxReceiveCount,
    };
    validateQueuePropagation(this.propagationSpec);

    // ── Encryption ────────────────────────────────────────────────────────────
    // A message body is application data and the worker's log group quotes it
    // when a handler fails, so both are encrypted with a key this stack owns
    // rather than the account's `alias/aws/sqs`. A customer-managed key is also
    // what makes "who read this queue" answerable from CloudTrail's KMS events.
    this.encryptionKey = new kms.Key(this, 'QueueTracingKey', {
      alias: `alias/${envName}-${props.queueName}-tracing`,
      description: `Encrypts the ${envName} ${props.queueName} queue, its dead-letter queue and the worker's logs`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch Logs encrypts with a key it can use, and `LogGroup`'s
    // `encryptionKey` prop does not add this: without it the log group fails to
    // create with `InvalidParameterException`, at deploy time. The condition
    // keeps the grant to log groups in this account and region.
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    );

    // ── Dead-letter queue ─────────────────────────────────────────────────────
    // Retained far longer than the work queue: a message here is one whose
    // trace has already been decided and closed, so the only remaining record
    // of what it was doing is the message itself.
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: deadLetterQueueName,
      fifo: fifo || undefined,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.encryptionKey,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.queue = new sqs.Queue(this, 'WorkQueue', {
      queueName,
      fifo: fifo || undefined,
      contentBasedDeduplication: fifo || undefined,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.encryptionKey,
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(visibilityTimeoutSeconds),
      retentionPeriod: cdk.Duration.days(retentionDays),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // A dead-letter queue with no redrive-allow policy may be named as the DLQ
    // of any queue in the account, which for a queue holding failed messages of
    // a known shape is a way for another team's poison messages to arrive in
    // this worker's redrive.
    //
    // The source queue is referenced by a formatted ARN rather than by
    // `this.queue`, and that is not a style choice: the work queue's
    // `RedrivePolicy` already holds a `Fn::GetAtt` on the dead-letter queue, so
    // a `Ref` back the other way is a circular dependency and CloudFormation
    // refuses the template. Both queues have explicit names, so the ARN is
    // knowable without a reference.
    const workQueueArn = this.formatArn({ service: 'sqs', resource: queueName });
    const cfnDeadLetterQueue = this.deadLetterQueue.node.defaultChild as sqs.CfnQueue;
    cfnDeadLetterQueue.redriveAllowPolicy = {
      redrivePermission: 'byQueue',
      sourceQueueArns: [workQueueArn],
    };

    // ── The worker's log group ────────────────────────────────────────────────
    // Created here rather than by the worker's awslogs driver because the two
    // metric filters below have to exist before the first message is processed.
    // A log group CloudWatch creates on first write has no retention and no
    // key, and nothing is watching it.
    this.workerLogGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      logGroupName: workerLogGroupName,
      retention: logRetention,
      encryptionKey: this.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dimensions = { Queue: queueName, Environment: envName };

    // Both filters match on `$.event`, which is why
    // `queue-trace-context.ts` exports the event names as constants: a filter
    // pattern and the string a worker logs are two literals in two files, and
    // nothing in AWS reconciles them. A pattern that matches nothing is a
    // filter that reports zero forever, which is indistinguishable from health.
    const missingContextFilter = this.workerLogGroup.addMetricFilter(
      'TraceContextMissingFilter',
      {
        filterName: `${envName}-${props.queueName}-trace-context-missing`,
        filterPattern: logs.FilterPattern.stringValue('$.event', '=', TRACE_CONTEXT_MISSING_EVENT),
        metricNamespace: QUEUE_TRACING_METRIC_NAMESPACE,
        metricName: TRACE_CONTEXT_MISSING_METRIC,
        metricValue: '1',
        // Without a default the metric has no datapoint when nothing matched,
        // and an alarm over a sparse metric spends most of its life in
        // INSUFFICIENT_DATA. Zero is the true value of this counter when the
        // worker is running and finding context.
        defaultValue: 0,
        dimensions,
        unit: cloudwatch.Unit.COUNT,
      },
    );

    const truncatedContextFilter = this.workerLogGroup.addMetricFilter(
      'TraceContextTruncatedFilter',
      {
        filterName: `${envName}-${props.queueName}-trace-context-truncated`,
        filterPattern: logs.FilterPattern.stringValue(
          '$.event',
          '=',
          TRACE_CONTEXT_TRUNCATED_EVENT,
        ),
        metricNamespace: QUEUE_TRACING_METRIC_NAMESPACE,
        metricName: TRACE_CONTEXT_TRUNCATED_METRIC,
        metricValue: '1',
        defaultValue: 0,
        dimensions,
        unit: cloudwatch.Unit.COUNT,
      },
    );

    // ── Alarms ────────────────────────────────────────────────────────────────
    const alarms: cloudwatch.Alarm[] = [];

    alarms.push(
      new cloudwatch.Alarm(this, 'TraceContextMissingAlarm', {
        alarmName: `${envName}-${props.queueName}-trace-context-missing`,
        alarmDescription:
          'The worker received messages with no usable trace context, so each one started a ' +
          'new trace and the request that enqueued it is unreachable from the work it caused. ' +
          'Causes, in order of how often they are it: the receive call stopped asking for the ' +
          'AWSTraceHeader system attribute; an SNS subscription had RawMessageDelivery turned ' +
          'off, which moves the publisher\'s message attributes inside the notification ' +
          'envelope; or the producer ran out of the ten message-attribute slots. Nothing else ' +
          'in AWS reports any of these. See docs/queue-tracing.md §6.',
        metric: missingContextFilter.metric({
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
          dimensionsMap: dimensions,
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        // Missing data here means the worker logged nothing at all, which is a
        // worker that is not running — the ECS service alarms own that, and
        // duplicating it would make this alarm red for a reason it cannot fix.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    alarms.push(
      new cloudwatch.Alarm(this, 'TraceContextTruncatedAlarm', {
        alarmName: `${envName}-${props.queueName}-trace-context-truncated`,
        alarmDescription:
          'The producer gave up `tracestate` or `baggage` to stay inside SQS\'s limit of ten ' +
          'message attributes. The trace still joins up — `traceparent` is never the one ' +
          'dropped — but sampling hints and baggage are being lost on the message shapes that ' +
          'carry the most attributes. Move business attributes into the body; trace context ' +
          'cannot follow them there, because FIFO deduplication hashes the body.',
        metric: truncatedContextFilter.metric({
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
          dimensionsMap: dimensions,
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    alarms.push(
      new cloudwatch.Alarm(this, 'QueueDwellAlarm', {
        alarmName: `${envName}-${props.queueName}-dwell-approaching-decision-window`,
        alarmDescription:
          `The oldest message has been waiting longer than ${dwellAlarmSeconds}s. The tail ` +
          `sampler decides a trace ${decisionWaitSeconds}s after its first span and then ` +
          'exports it, so once dwell reaches that window the worker\'s spans arrive for a ' +
          'trace that is already closed and are dropped as late arrivals — the trace shows an ' +
          'API call that enqueued something and nothing after it. Past this point the worker ' +
          'links rather than parents, which keeps the traces complete and separate. This ' +
          'alarm is set below the window on purpose: after it, the loss has already happened.',
        metric: this.queue.metricApproximateAgeOfOldestMessage({
          statistic: 'Maximum',
          period: cdk.Duration.minutes(1),
        }),
        threshold: dwellAlarmSeconds,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    alarms.push(
      new cloudwatch.Alarm(this, 'DeadLetterQueueAlarm', {
        alarmName: `${envName}-${props.queueName}-dlq-not-empty`,
        alarmDescription:
          'Messages reached the dead-letter queue. Beyond the tracing consequence — a redriven ' +
          'message is separated from its original trace by however long it sat here, so it ' +
          'links rather than parents and the two are separate traces — this is the ordinary ' +
          'signal that a handler is failing repeatedly.',
        metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          statistic: 'Maximum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

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

    // These two are not descriptive. `tools/audit-queue-tracing.ts` reads the
    // synthesised template and has to answer "which of these queues is supposed
    // to carry a trace, and against which decision window?" — neither of which
    // is derivable from an SQS resource, whose properties are identical whether
    // or not anything propagates through it. The alternative was for the gate
    // to apply the tracing rules to every queue in the repository, which would
    // report a Lambda dead-letter queue for having no dwell alarm.
    cdk.Tags.of(this.queue).add(TRACED_QUEUE_TAG, format);
    cdk.Tags.of(this.queue).add(DECISION_WAIT_TAG, String(decisionWaitSeconds));

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'TracedQueueUrl', {
      value: this.queue.queueUrl,
      description: 'Work queue URL — set TRACED_QUEUE_URL to this in the producer and worker',
      exportName: `${envName}-${props.queueName}-queue-url`,
    });

    new cdk.CfnOutput(this, 'TracedQueueDlqUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'Dead-letter queue URL',
      exportName: `${envName}-${props.queueName}-dlq-url`,
    });

    new cdk.CfnOutput(this, 'TracedQueueWorkerLogGroup', {
      value: workerLogGroupName,
      description:
        'Log group the worker must write to — the propagation metric filters read it, so a ' +
        'worker logging elsewhere leaves both alarms reporting zero forever',
      exportName: `${envName}-${props.queueName}-worker-log-group`,
    });

    new cdk.CfnOutput(this, 'TracedQueueDecisionWaitSeconds', {
      value: String(decisionWaitSeconds),
      description:
        "The collector's decision window, which is the worker's parent-or-link boundary",
      exportName: `${envName}-${props.queueName}-decision-wait-seconds`,
    });
  }

  /**
   * Let a producer send to the work queue.
   *
   * `grantSendMessages` also grants the KMS actions the queue's customer-managed
   * key needs, which is why the producer does not need a separate key grant.
   */
  grantProduce(grantee: iam.IGrantable): iam.Grant {
    return this.queue.grantSendMessages(grantee);
  }

  /**
   * Let a worker consume the work queue.
   *
   * There is no separate permission for the `AWSTraceHeader` system attribute —
   * `sqs:ReceiveMessage` covers it, and it is returned or not purely on whether
   * the call asked. That is precisely why nothing in IAM can catch the mistake
   * and {@link TracedQueueStack.workerEnvironment} carries the name instead.
   */
  grantConsume(grantee: iam.IGrantable): iam.Grant {
    return this.queue.grantConsumeMessages(grantee);
  }
}
