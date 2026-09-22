import {
  TRACEPARENT_ATTRIBUTE,
  TRACE_CONTEXT_MISSING_EVENT as LIBRARY_MISSING_EVENT,
  XRAY_SYSTEM_ATTRIBUTE as LIBRARY_SYSTEM_ATTRIBUTE,
} from '../lib/queue-trace-context';
import {
  DECISION_WAIT_TAG as STACK_DECISION_WAIT_TAG,
  QUEUE_URL_ENV_VAR as STACK_QUEUE_URL_ENV_VAR,
  SYSTEM_ATTRIBUTE_ENV_VAR as STACK_SYSTEM_ATTRIBUTE_ENV_VAR,
  TRACED_QUEUE_TAG as STACK_TRACED_QUEUE_TAG,
  TRACE_CONTEXT_MISSING_METRIC as STACK_MISSING_METRIC,
} from '../lib/traced-queue-stack';
import {
  AuditInput,
  DECISION_WAIT_ENV_VAR,
  DECISION_WAIT_TAG,
  QUEUE_URL_ENV_VAR,
  SYSTEM_ATTRIBUTE_ENV_VAR,
  TRACED_QUEUE_TAG,
  TRACE_CONTEXT_MISSING_EVENT,
  TRACE_CONTEXT_MISSING_METRIC,
  TemplateFile,
  XRAY_SYSTEM_ATTRIBUTE,
  auditQueueTracing,
  flatten,
  formatViolations,
  tagsOf,
} from '../tools/audit-queue-tracing';

/**
 * Tests for the queue-tracing gate.
 *
 * Each case is a template that deploys, delivers and processes — and loses the
 * edge between the request and the work it caused. None of them is an error
 * anywhere in AWS, which is the whole reason this gate reads templates instead
 * of waiting for a metric.
 */

type Json = Record<string, any>;

const QUEUE_NAME = 'production-orders';
const METRIC_NAMESPACE = 'Boilerplate/QueueTracing';
const DECISION_WAIT = 30;

const template = (resources: Json, path = 'Test.template.json'): TemplateFile => ({
  path,
  document: { Resources: resources },
});

/** A queue path with nothing wrong with it. Every case below mutates it. */
const healthyQueue = (overrides: { queue?: Json; extra?: Json; remove?: string[] } = {}) => {
  const resources: Json = {
    WorkQueue: {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: QUEUE_NAME,
        KmsMasterKeyId: { 'Fn::GetAtt': ['Key', 'Arn'] },
        RedrivePolicy: {
          deadLetterTargetArn: { 'Fn::GetAtt': ['Dlq', 'Arn'] },
          maxReceiveCount: 5,
        },
        Tags: [
          { Key: TRACED_QUEUE_TAG, Value: 'both' },
          { Key: DECISION_WAIT_TAG, Value: String(DECISION_WAIT) },
        ],
      },
    },
    Dlq: {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: `${QUEUE_NAME}-dlq`,
        KmsMasterKeyId: { 'Fn::GetAtt': ['Key', 'Arn'] },
        RedriveAllowPolicy: { redrivePermission: 'byQueue', sourceQueueArns: ['arn:aws:sqs:…'] },
      },
    },
    DwellAlarm: {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        MetricName: 'ApproximateAgeOfOldestMessage',
        Namespace: 'AWS/SQS',
        Dimensions: [{ Name: 'QueueName', Value: QUEUE_NAME }],
        Threshold: 15,
      },
    },
    MissingContextFilter: {
      Type: 'AWS::Logs::MetricFilter',
      Properties: {
        FilterPattern: `{ $.event = "${TRACE_CONTEXT_MISSING_EVENT}" }`,
        MetricTransformations: [
          { MetricName: TRACE_CONTEXT_MISSING_METRIC, MetricNamespace: METRIC_NAMESPACE },
        ],
      },
    },
    MissingContextAlarm: {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        MetricName: TRACE_CONTEXT_MISSING_METRIC,
        Namespace: METRIC_NAMESPACE,
        Threshold: 0,
      },
    },
    ...(overrides.extra ?? {}),
  };

  // A `null` override removes the property rather than setting it to null: a
  // real template omits what it does not set, and a rule written against an
  // explicit null would be a rule no synthesised template can trip.
  for (const [name, value] of Object.entries(overrides.queue ?? {})) {
    if (value === null) delete resources.WorkQueue.Properties[name];
    else resources.WorkQueue.Properties[name] = value;
  }
  for (const id of overrides.remove ?? []) delete resources[id];
  return template(resources);
};

const environment = (entries: Record<string, string>): Json[] =>
  Object.entries(entries).map(([Name, Value]) => ({ Name, Value }));

const workerEnvironment = (overrides: Record<string, string | null> = {}): Record<string, string> => {
  const base: Record<string, string> = {
    [QUEUE_URL_ENV_VAR]: 'https://sqs.us-east-1.amazonaws.com/123456789012/production-orders',
    [DECISION_WAIT_ENV_VAR]: String(DECISION_WAIT),
    TRACE_PROPAGATION_FORMAT: 'both',
    [SYSTEM_ATTRIBUTE_ENV_VAR]: XRAY_SYSTEM_ATTRIBUTE,
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
    OTEL_TRACES_SAMPLER: 'parentbased_always_on',
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  return base;
};

const workerTemplate = (overrides: Record<string, string | null> = {}): TemplateFile =>
  template(
    {
      WorkerTaskDefinition: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          ContainerDefinitions: [
            { Name: 'worker', Environment: environment(workerEnvironment(overrides)) },
          ],
        },
      },
    },
    'Worker.template.json',
  );

const audit = (...templates: TemplateFile[]): AuditInput => ({ templates });
const rules = (input: AuditInput): string[] =>
  auditQueueTracing(input).violations.map((violation) => violation.rule);

describe('a path that is wired correctly', () => {
  it('reports nothing', () => {
    const result = auditQueueTracing(audit(healthyQueue(), workerTemplate()));

    expect(result.violations).toEqual([]);
    expect(result.tracedQueuesRead).toBe(1);
    expect(result.workerContainersRead).toBe(1);
  });

  // A tag-scoped gate is a gate over what it was told about. Saying so is
  // better than leaving a reader to assume a Lambda's dead-letter queue was
  // checked and passed.
  it('leaves untagged queues alone', () => {
    const untagged = template({
      SomeOtherQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'lambda-dlq' } },
    });

    expect(auditQueueTracing(audit(untagged)).tracedQueuesRead).toBe(0);
    expect(rules(audit(untagged))).toEqual([]);
  });
});

describe('the worker', () => {
  // ReceiveMessage returns system attributes only when the call names them, and
  // the X-Ray context lives in one. Nothing about the response says it was
  // omitted; the field is just absent from every message.
  it('is reported when it never asks for the AWSTraceHeader system attribute', () => {
    expect(rules(audit(workerTemplate({ [SYSTEM_ATTRIBUTE_ENV_VAR]: null })))).toEqual([
      'worker-without-system-attribute',
    ]);
  });

  it('is reported when it asks for some other system attribute instead', () => {
    expect(rules(audit(workerTemplate({ [SYSTEM_ATTRIBUTE_ENV_VAR]: 'SentTimestamp' })))).toEqual(
      ['worker-without-system-attribute'],
    );
  });

  it('accepts the attribute in a list beside others', () => {
    expect(
      rules(
        audit(
          workerTemplate({
            [SYSTEM_ATTRIBUTE_ENV_VAR]: `SentTimestamp, ${XRAY_SYSTEM_ATTRIBUTE}`,
          }),
        ),
      ),
    ).toEqual([]);
  });

  // A W3C-only path carries nothing in the system attribute, so asking for it
  // would be noise.
  it('does not need it on a W3C-only path', () => {
    expect(rules(audit(workerTemplate({ TRACE_PROPAGATION_FORMAT: 'w3c' })))).toEqual([]);
  });

  it('is reported when it extracts context and exports it nowhere', () => {
    expect(rules(audit(workerTemplate({ OTEL_EXPORTER_OTLP_ENDPOINT: null })))).toEqual([
      'worker-without-otel-endpoint',
    ]);
  });

  // The producer carries the queue URL too; only the worker carries a decision
  // window, because only the worker has a parent-or-link boundary to draw.
  it('is told apart from a producer by the decision window', () => {
    const producer = template(
      {
        ApiTaskDefinition: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'api',
                Environment: environment({
                  [QUEUE_URL_ENV_VAR]: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
                  TRACE_PROPAGATION_FORMAT: 'both',
                  OTEL_TRACES_SAMPLER: 'parentbased_always_on',
                }),
              },
            ],
          },
        },
      },
      'Api.template.json',
    );

    expect(auditQueueTracing(audit(producer)).workerContainersRead).toBe(0);
    expect(rules(audit(producer))).toEqual([]);
  });

  it('ignores a container that has nothing to do with the queue', () => {
    const unrelated = template({
      TaskDefinition: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          ContainerDefinitions: [
            { Name: 'sidecar', Environment: environment({ OTEL_TRACES_SAMPLER: 'traceidratio' }) },
          ],
        },
      },
    });

    expect(rules(audit(unrelated))).toEqual([]);
  });
});

describe('the sampling decision', () => {
  // The producer and the consumer then sample the same trace independently, so
  // most traces keep one half and drop the other. Every service involved looks
  // correctly instrumented.
  it.each(['traceidratio', 'always_on', 'always_off'])(
    'is reported when the sampler is %s',
    (sampler) => {
      expect(rules(audit(workerTemplate({ OTEL_TRACES_SAMPLER: sampler })))).toEqual([
        'sampler-not-parent-based',
      ]);
    },
  );

  it.each(['parentbased_always_on', 'parentbased_traceidratio', 'parentbased_always_off'])(
    'accepts %s',
    (sampler) => {
      expect(rules(audit(workerTemplate({ OTEL_TRACES_SAMPLER: sampler })))).toEqual([]);
    },
  );
});

describe('the queue', () => {
  it('is reported when it has no dead-letter queue', () => {
    expect(rules(audit(healthyQueue({ queue: { RedrivePolicy: null } })))).toContain(
      'traced-queue-without-dlq',
    );
  });

  it('is reported when nothing encrypts it', () => {
    expect(rules(audit(healthyQueue({ queue: { KmsMasterKeyId: null } })))).toContain(
      'traced-queue-unencrypted',
    );
  });

  it('accepts SQS-managed encryption in place of a key', () => {
    expect(
      rules(audit(healthyQueue({ queue: { KmsMasterKeyId: null, SqsManagedSseEnabled: true } }))),
    ).toEqual([]);
  });

  it('reports a dead-letter queue any queue in the account may write to', () => {
    const open = healthyQueue();
    delete (open.document as Json).Resources.Dlq.Properties.RedriveAllowPolicy;

    expect(rules(audit(open))).toEqual(['dead-letter-queue-open-to-any-source']);
  });

  // A cross-stack import resolves to nothing here, and this tool cannot tell
  // which export a string import binds to. Reporting a queue it never read
  // would be worse than saying nothing about it.
  it('says nothing about a dead-letter queue in another stack', () => {
    expect(
      rules(
        audit(
          healthyQueue({
            queue: {
              RedrivePolicy: {
                deadLetterTargetArn: { 'Fn::ImportValue': 'shared-dlq-arn' },
                maxReceiveCount: 5,
              },
            },
            remove: ['Dlq'],
          }),
        ),
      ),
    ).toEqual([]);
  });
});

describe('the dwell alarm', () => {
  it('is reported when it is missing', () => {
    expect(rules(audit(healthyQueue({ remove: ['DwellAlarm'] })))).toEqual(['dwell-alarm-missing']);
  });

  it('is not credited to a different queue', () => {
    const elsewhere = healthyQueue();
    (elsewhere.document as Json).Resources.DwellAlarm.Properties.Dimensions = [
      { Name: 'QueueName', Value: 'production-invoices' },
    ];

    expect(rules(audit(elsewhere))).toEqual(['dwell-alarm-missing']);
  });

  // The dimension can be a literal or a reference depending on whether the
  // queue's physical name was given, and an alarm that is credited to no queue
  // reads exactly like an alarm that does not exist.
  it('is credited when the dimension is a reference to the queue', () => {
    const byReference = healthyQueue();
    (byReference.document as Json).Resources.DwellAlarm.Properties.Dimensions = [
      { Name: 'QueueName', Value: { 'Fn::GetAtt': ['WorkQueue', 'QueueName'] } },
    ];

    expect(rules(audit(byReference))).toEqual([]);
  });

  // At or past the decision window it describes traces that have already been
  // decided on their producer half — a record of the loss, not a warning.
  it.each([DECISION_WAIT, DECISION_WAIT + 30])(
    'is reported at a threshold of %ss',
    (threshold) => {
      const late = healthyQueue();
      (late.document as Json).Resources.DwellAlarm.Properties.Threshold = threshold;

      expect(rules(audit(late))).toEqual(['dwell-alarm-at-or-past-decision-window']);
    },
  );

  it('cannot judge the threshold when the queue declares no window', () => {
    const untagged = healthyQueue({
      queue: { Tags: [{ Key: TRACED_QUEUE_TAG, Value: 'both' }] },
    });
    (untagged.document as Json).Resources.DwellAlarm.Properties.Threshold = 600;

    expect(rules(audit(untagged))).toEqual([]);
  });
});

describe('the signal that propagation broke', () => {
  it('is reported when no metric filter publishes it', () => {
    expect(
      rules(audit(healthyQueue({ remove: ['MissingContextFilter', 'MissingContextAlarm'] }))),
    ).toEqual(['context-signal-missing']);
  });

  // A pattern that matches nothing publishes zero forever, and a counter
  // reporting zero is indistinguishable from a system in which nothing is
  // wrong.
  it('is reported when the pattern does not match the event the worker logs', () => {
    const mismatched = healthyQueue();
    (mismatched.document as Json).Resources.MissingContextFilter.Properties.FilterPattern =
      '{ $.event = "traceContextMissing" }';

    expect(rules(audit(mismatched))).toEqual(['context-filter-pattern-mismatch']);
  });

  it('is reported when the metric is published and nobody evaluates it', () => {
    expect(rules(audit(healthyQueue({ remove: ['MissingContextAlarm'] })))).toEqual([
      'context-alarm-missing',
    ]);
  });

  it('does not credit an alarm in a different metric namespace', () => {
    const wrongNamespace = healthyQueue();
    (wrongNamespace.document as Json).Resources.MissingContextAlarm.Properties.Namespace =
      'AWS/Logs';

    expect(rules(audit(wrongNamespace))).toEqual(['context-alarm-missing']);
  });
});

describe('several findings at once', () => {
  it('reports each of them, with the file and the resource', () => {
    const result = auditQueueTracing(
      audit(
        healthyQueue({
          queue: { KmsMasterKeyId: null, RedrivePolicy: null },
          remove: ['DwellAlarm'],
        }),
        workerTemplate({ [SYSTEM_ATTRIBUTE_ENV_VAR]: null, OTEL_TRACES_SAMPLER: 'always_on' }),
      ),
    );

    expect(result.violations.map((violation) => violation.rule).sort()).toEqual([
      'dwell-alarm-missing',
      'sampler-not-parent-based',
      'traced-queue-unencrypted',
      'traced-queue-without-dlq',
      'worker-without-system-attribute',
    ]);

    const report = formatViolations(result.violations);
    expect(report).toContain('Worker.template.json');
    expect(report).toContain('WorkQueue (production-orders)');
    expect(report).toContain('[traced-queue-unencrypted]');
  });
});

describe('helpers', () => {
  it('flattens the intrinsics a value can be built from', () => {
    expect(flatten({ 'Fn::Join': ['-', ['production', 'orders']] })).toBe('production-orders');
    expect(flatten({ Ref: 'WorkQueue' })).toBe('WorkQueue');
    expect(flatten({ 'Fn::GetAtt': ['WorkQueue', 'QueueName'] })).toBe('WorkQueue');
    expect(flatten({ 'Fn::ImportValue': 'other-stack-export' })).toBe('');
    expect(flatten(30)).toBe('30');
  });

  it('reads tags built from intrinsics', () => {
    expect(
      tagsOf({
        id: 'WorkQueue',
        type: 'AWS::SQS::Queue',
        properties: { Tags: [{ Key: 'Environment', Value: { 'Fn::Join': ['', ['prod']] } }] },
      }),
    ).toEqual({ Environment: 'prod' });
  });

  it('survives a template with no Resources block', () => {
    expect(rules(audit({ path: 'Empty.template.json', document: {} }))).toEqual([]);
    expect(rules(audit({ path: 'Broken.template.json', document: 'not an object' }))).toEqual([]);
  });
});

/*
 * The gate restates the contract rather than importing it, so that a rename in
 * `lib/` cannot silently turn a rule into one that matches nothing. These are
 * the assertions that make such a rename one failing test instead.
 */
describe('the constants the gate restates', () => {
  it('still match the library and the stack', () => {
    expect(TRACED_QUEUE_TAG).toBe(STACK_TRACED_QUEUE_TAG);
    expect(DECISION_WAIT_TAG).toBe(STACK_DECISION_WAIT_TAG);
    expect(SYSTEM_ATTRIBUTE_ENV_VAR).toBe(STACK_SYSTEM_ATTRIBUTE_ENV_VAR);
    expect(QUEUE_URL_ENV_VAR).toBe(STACK_QUEUE_URL_ENV_VAR);
    expect(TRACE_CONTEXT_MISSING_METRIC).toBe(STACK_MISSING_METRIC);
    expect(TRACE_CONTEXT_MISSING_EVENT).toBe(LIBRARY_MISSING_EVENT);
    expect(XRAY_SYSTEM_ATTRIBUTE).toBe(LIBRARY_SYSTEM_ATTRIBUTE);
  });

  it('keeps the W3C attribute name lowercase, as the specification has it', () => {
    expect(TRACEPARENT_ATTRIBUTE).toBe(TRACEPARENT_ATTRIBUTE.toLowerCase());
  });
});
