#!/usr/bin/env node
/**
 * Audit trace-context propagation across a queue: does the context the producer
 * writes actually reach the worker, and is there anything that would say so if
 * it stopped?
 *
 * Every other observability gate in this repository checks that telemetry is
 * produced. This one checks that it **joins up**, and it exists because a
 * broken queue boundary is the single most convincing kind of working tracing:
 * the API is instrumented, the worker is instrumented, both emit spans, both
 * appear in the service map, and the only thing missing is the edge between
 * them. Nobody notices until an incident, because the thing you look at in an
 * incident is the trace of the request that failed, and it ends at 202.
 *
 * Reads `cdk.out/*.template.json`, so it sees what synth wrote — an environment
 * variable set through an escape hatch or a `addPropertyOverride` resolves in
 * between.
 *
 * ## Why the tag
 *
 * An SQS queue that propagates trace context and one that does not are the same
 * CloudFormation resource. There is no property to read, so a gate over every
 * queue in the repository would report a Lambda's dead-letter queue for having
 * no dwell alarm. `TracedQueueStack` therefore tags the queues it owns with
 * `TraceContextPropagation`, and this tool reasons about those. A queue that is
 * supposed to be traced and carries no tag escapes — which is the honest
 * limitation of every tag-scoped gate, and why the worker-side rules below are
 * scoped by a *task definition's own environment* instead: those need no tag,
 * because a container carrying `TRACED_QUEUE_URL` has already declared itself.
 *
 * ## The rules, and the failure each one prevents
 *
 *   worker-without-system-attribute   ReceiveMessage never asks for
 *                                     AWSTraceHeader, so X-Ray context is
 *                                     absent from every message — no error
 *   worker-without-otel-endpoint      a worker that extracts context correctly
 *                                     and exports it nowhere
 *   sampler-not-parent-based          producer and consumer sample the same
 *                                     trace independently: half traces
 *   traced-queue-without-dlq          unbounded redelivery, so unbounded dwell
 *   dead-letter-queue-open-to-any-source  another team's poison messages land
 *                                     in this worker's redrive
 *   traced-queue-unencrypted          message bodies at rest in the clear
 *   dwell-alarm-missing               dwell past the decision window with no
 *                                     signal; the loss is silent by nature
 *   dwell-alarm-at-or-past-decision-window  an alarm that reports the loss
 *                                     rather than warning of it
 *   context-signal-missing            no metric filter over the worker's
 *                                     missing-context event: nothing can see it
 *   context-filter-pattern-mismatch   a filter whose pattern does not match the
 *                                     event the library logs — reports zero
 *                                     forever, which reads as healthy
 *   context-alarm-missing             the metric is published and nobody
 *                                     evaluates it
 */
import * as fs from 'fs';
import * as path from 'path';

export type QueueTracingRule =
  | 'worker-without-system-attribute'
  | 'worker-without-otel-endpoint'
  | 'sampler-not-parent-based'
  | 'traced-queue-without-dlq'
  | 'dead-letter-queue-open-to-any-source'
  | 'traced-queue-unencrypted'
  | 'dwell-alarm-missing'
  | 'dwell-alarm-at-or-past-decision-window'
  | 'context-signal-missing'
  | 'context-filter-pattern-mismatch'
  | 'context-alarm-missing';

export interface Violation {
  readonly rule: QueueTracingRule;
  readonly file: string;
  readonly location: string;
  readonly message: string;
}

const violation = (
  rule: QueueTracingRule,
  file: string,
  location: string,
  message: string,
): Violation => ({ rule, file, location, message });

export interface TemplateFile {
  readonly path: string;
  readonly document: unknown;
}

export interface AuditInput {
  readonly templates: readonly TemplateFile[];
}

export interface AuditResult {
  readonly violations: readonly Violation[];
  readonly tracedQueuesRead: number;
  readonly workerContainersRead: number;
}

/* ── Contract constants, restated ─────────────────────────────────────────── */

/*
 * Restated rather than imported from `lib/`. This tool reads a directory of
 * JSON and must run against templates synthesised by an older revision — and,
 * more to the point, a gate that imports the constants it is checking cannot
 * catch a change to them. `test/audit-queue-tracing.test.ts` asserts these
 * against the library's exports, which is where a deliberate rename shows up as
 * one failing assertion instead of a silently weakened rule.
 */

/** Tag `TracedQueueStack` marks its work queue with. */
export const TRACED_QUEUE_TAG = 'TraceContextPropagation';
/** Tag carrying the collector decision window the queue was sized against. */
export const DECISION_WAIT_TAG = 'TraceDecisionWaitSeconds';
/** Environment variable naming the system attributes a worker asks for. */
export const SYSTEM_ATTRIBUTE_ENV_VAR = 'TRACE_MESSAGE_SYSTEM_ATTRIBUTE_NAMES';
/** Environment variable a producer and a worker both carry. */
export const QUEUE_URL_ENV_VAR = 'TRACED_QUEUE_URL';
/** Environment variable only a worker carries — this is what distinguishes it. */
export const DECISION_WAIT_ENV_VAR = 'TRACE_DECISION_WAIT_SECONDS';
/** The reserved SQS system attribute holding the X-Ray header. */
export const XRAY_SYSTEM_ATTRIBUTE = 'AWSTraceHeader';
/** The structured event a worker logs when it found no context. */
export const TRACE_CONTEXT_MISSING_EVENT = 'trace_context_missing';
/** The metric the filter over that event publishes. */
export const TRACE_CONTEXT_MISSING_METRIC = 'TraceContextMissing';

/** Samplers that defer to the incoming context. */
const PARENT_BASED_SAMPLERS = [
  'parentbased_always_on',
  'parentbased_always_off',
  'parentbased_traceidratio',
  'parentbased_jaeger_remote',
];

/* ── Template reading ─────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export interface TemplateResource {
  readonly id: string;
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

/** The resources of one template, as `[logicalId, resource]` pairs. */
export const resourcesOf = (template: TemplateFile): TemplateResource[] => {
  const document = template.document;
  if (!isRecord(document) || !isRecord(document.Resources)) return [];
  return Object.entries(document.Resources).flatMap(([id, resource]) => {
    if (!isRecord(resource) || typeof resource.Type !== 'string') return [];
    return [
      {
        id,
        type: resource.Type,
        properties: isRecord(resource.Properties) ? resource.Properties : {},
      },
    ];
  });
};

/**
 * Render a template value as a string, with intrinsics flattened.
 *
 * `Fn::Join` is concatenated; `Ref` and `Fn::GetAtt` become the logical id they
 * name, so a value built from a reference still carries the one piece of
 * information the rules below need — which resource it points at.
 */
export const flatten = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flatten).join('');
  if (!isRecord(value)) return '';

  if ('Fn::Join' in value) {
    const join = value['Fn::Join'];
    if (Array.isArray(join) && join.length === 2) {
      const [delimiter, parts] = join as [unknown, unknown];
      return asList(parts).map(flatten).join(typeof delimiter === 'string' ? delimiter : '');
    }
  }
  if ('Ref' in value && typeof value.Ref === 'string') return value.Ref;
  if ('Fn::GetAtt' in value) {
    const attribute = value['Fn::GetAtt'];
    if (Array.isArray(attribute) && typeof attribute[0] === 'string') return attribute[0];
    if (typeof attribute === 'string') return attribute.split('.')[0];
  }
  return '';
};

/** The logical id a `Ref` or `Fn::GetAtt` points at, when it points in-template. */
const referencedLogicalId = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  if ('Ref' in value && typeof value.Ref === 'string') return value.Ref;
  if ('Fn::GetAtt' in value) {
    const attribute = value['Fn::GetAtt'];
    if (Array.isArray(attribute) && typeof attribute[0] === 'string') return attribute[0];
    if (typeof attribute === 'string') return attribute.split('.')[0];
  }
  return undefined;
};

/** A resource's tags, as a map. */
export const tagsOf = (resource: TemplateResource): Record<string, string> => {
  const tags: Record<string, string> = {};
  for (const entry of asList(resource.properties.Tags)) {
    if (!isRecord(entry)) continue;
    const key = flatten(entry.Key);
    if (key !== '') tags[key] = flatten(entry.Value);
  }
  return tags;
};

/* ── Worker and producer containers ───────────────────────────────────────── */

interface ContainerEnvironment {
  readonly templatePath: string;
  readonly taskDefinitionId: string;
  readonly containerName: string;
  readonly environment: Record<string, string>;
}

/** Every container in every task definition, with its environment flattened. */
const containersOf = (templates: readonly TemplateFile[]): ContainerEnvironment[] =>
  templates.flatMap((template) =>
    resourcesOf(template)
      .filter((resource) => resource.type === 'AWS::ECS::TaskDefinition')
      .flatMap((taskDefinition) =>
        asList(taskDefinition.properties.ContainerDefinitions).flatMap((container) => {
          if (!isRecord(container)) return [];
          const environment: Record<string, string> = {};
          for (const entry of asList(container.Environment)) {
            if (!isRecord(entry)) continue;
            const name = flatten(entry.Name);
            if (name !== '') environment[name] = flatten(entry.Value);
          }
          return [
            {
              templatePath: template.path,
              taskDefinitionId: taskDefinition.id,
              containerName: flatten(container.Name) || '<unnamed>',
              environment,
            },
          ];
        }),
      ),
  );

const auditContainers = (containers: readonly ContainerEnvironment[]): Violation[] => {
  const violations: Violation[] = [];

  for (const container of containers) {
    const environment = container.environment;
    const location = `${container.taskDefinitionId}/${container.containerName}`;

    // A producer carries the queue URL and the format; a worker carries the
    // decision window as well, because only a worker has a parent-or-link
    // boundary to draw. That is what tells the two apart here — the rest of a
    // task definition is identical.
    const isQueueParticipant = QUEUE_URL_ENV_VAR in environment;
    const isWorker = DECISION_WAIT_ENV_VAR in environment;
    if (!isQueueParticipant) continue;

    const format = environment.TRACE_PROPAGATION_FORMAT ?? 'both';

    if (isWorker && format !== 'w3c') {
      const requested = environment[SYSTEM_ATTRIBUTE_ENV_VAR] ?? '';
      if (!requested.split(',').map((name) => name.trim()).includes(XRAY_SYSTEM_ATTRIBUTE)) {
        violations.push(
          violation(
            'worker-without-system-attribute',
            container.templatePath,
            location,
            `This worker propagates \`${format}\` but its ${SYSTEM_ATTRIBUTE_ENV_VAR} does not ` +
              `name ${XRAY_SYSTEM_ATTRIBUTE}. The X-Ray context travels in that *system* ` +
              'attribute, and ReceiveMessage returns system attributes only when the call asks ' +
              'for them by name. It does not fail, warn, or report anything — the field is ' +
              'simply absent from every message, and the worker starts a new trace each time. ' +
              'Use TracedQueueStack.workerEnvironment(), which sets it.',
          ),
        );
      }
    }

    if (isWorker && environment.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
      violations.push(
        violation(
          'worker-without-otel-endpoint',
          container.templatePath,
          location,
          'This worker consumes a traced queue but has no OTEL_EXPORTER_OTLP_ENDPOINT, so ' +
            'whatever context it extracts is exported nowhere. Add ' +
            'OtelCollectorStack.appEnvironment() alongside the queue variables and the agent ' +
            'sidecar that listens on that endpoint.',
        ),
      );
    }

    const sampler = environment.OTEL_TRACES_SAMPLER;
    if (sampler !== undefined && !PARENT_BASED_SAMPLERS.includes(sampler)) {
      violations.push(
        violation(
          'sampler-not-parent-based',
          container.templatePath,
          location,
          `OTEL_TRACES_SAMPLER is \`${sampler}\`, which decides without reference to the ` +
            'incoming context. Across a queue that means the producer and the consumer sample ' +
            'the same trace independently, so most traces keep one half and drop the other. ' +
            'Every service involved looks correctly instrumented and the backend holds ' +
            `fragments. Use one of: ${PARENT_BASED_SAMPLERS.join(', ')}.`,
        ),
      );
    }
  }

  return violations;
};

/* ── Traced queues ────────────────────────────────────────────────────────── */

interface TracedQueue {
  readonly templatePath: string;
  readonly resource: TemplateResource;
  readonly queueName: string;
  readonly format: string;
  readonly decisionWaitSeconds?: number;
}

const tracedQueuesOf = (templates: readonly TemplateFile[]): TracedQueue[] =>
  templates.flatMap((template) =>
    resourcesOf(template)
      .filter((resource) => resource.type === 'AWS::SQS::Queue')
      .flatMap((resource) => {
        const tags = tagsOf(resource);
        const format = tags[TRACED_QUEUE_TAG];
        if (format === undefined) return [];
        const declared = Number(tags[DECISION_WAIT_TAG]);
        return [
          {
            templatePath: template.path,
            resource,
            queueName: flatten(resource.properties.QueueName) || resource.id,
            format,
            decisionWaitSeconds: Number.isFinite(declared) ? declared : undefined,
          },
        ];
      }),
  );

/** Whether an alarm dimension value names this queue, by literal or by ref. */
const dimensionNamesQueue = (value: unknown, queue: TracedQueue): boolean => {
  const referenced = referencedLogicalId(value);
  if (referenced === queue.resource.id) return true;
  return flatten(value) === queue.queueName;
};

const alarmsOf = (template: TemplateFile): TemplateResource[] =>
  resourcesOf(template).filter((resource) => resource.type === 'AWS::CloudWatch::Alarm');

const metricFiltersOf = (template: TemplateFile): TemplateResource[] =>
  resourcesOf(template).filter((resource) => resource.type === 'AWS::Logs::MetricFilter');

const auditQueues = (templates: readonly TemplateFile[]): Violation[] => {
  const violations: Violation[] = [];
  const byPath = new Map(templates.map((template) => [template.path, template]));

  for (const queue of tracedQueuesOf(templates)) {
    const template = byPath.get(queue.templatePath);
    if (template === undefined) continue;
    const properties = queue.resource.properties;
    const location = `${queue.resource.id} (${queue.queueName})`;

    /* Encryption. ------------------------------------------------------- */
    const managedSse = properties.SqsManagedSseEnabled;
    if (properties.KmsMasterKeyId === undefined && managedSse !== true) {
      violations.push(
        violation(
          'traced-queue-unencrypted',
          queue.templatePath,
          location,
          'The queue has neither a KMS key nor SQS-managed encryption, so message bodies sit ' +
            'at rest in the clear. A traced queue is the one most likely to carry an ' +
            'identifier that joins to a person, because that is what a worker needs in order ' +
            'to do the work the request asked for.',
        ),
      );
    }

    /* Redrive. ---------------------------------------------------------- */
    const redrivePolicy = properties.RedrivePolicy;
    if (!isRecord(redrivePolicy)) {
      violations.push(
        violation(
          'traced-queue-without-dlq',
          queue.templatePath,
          location,
          'No RedrivePolicy, so a message that fails is retried until it is retained no ' +
            'longer — up to fourteen days. Beyond the ordinary cost, dwell is then unbounded ' +
            'and every retry is far outside the collector decision window, so nothing the ' +
            'worker does can ever be attributed to the request that enqueued it.',
        ),
      );
    } else {
      const deadLetterId = referencedLogicalId(redrivePolicy.deadLetterTargetArn);
      const deadLetter = deadLetterId
        ? resourcesOf(template).find((resource) => resource.id === deadLetterId)
        : undefined;
      // A cross-stack `Fn::ImportValue` resolves to nothing here, and this tool
      // cannot tell which export a string import binds to. Saying so is better
      // than reporting a queue it never read.
      if (deadLetter !== undefined && deadLetter.properties.RedriveAllowPolicy === undefined) {
        violations.push(
          violation(
            'dead-letter-queue-open-to-any-source',
            queue.templatePath,
            `${deadLetter.id} (dead-letter queue of ${queue.queueName})`,
            'The dead-letter queue has no RedriveAllowPolicy, so any queue in the account may ' +
              "name it as its dead-letter target. This worker's redrive then replays another " +
              "team's poison messages through this worker's handler — and they arrive carrying " +
              'trace context that points into a different service\'s traces, which is how the ' +
              'confusion outlives the incident.',
          ),
        );
      }
    }

    /* The dwell alarm. --------------------------------------------------- */
    const dwellAlarms = alarmsOf(template).filter((alarm) => {
      if (flatten(alarm.properties.MetricName) !== 'ApproximateAgeOfOldestMessage') return false;
      return asList(alarm.properties.Dimensions).some(
        (dimension) =>
          isRecord(dimension) &&
          flatten(dimension.Name) === 'QueueName' &&
          dimensionNamesQueue(dimension.Value, queue),
      );
    });

    if (dwellAlarms.length === 0) {
      violations.push(
        violation(
          'dwell-alarm-missing',
          queue.templatePath,
          location,
          'No alarm on ApproximateAgeOfOldestMessage for this queue. Once dwell reaches the ' +
            "collector's decision window the worker's spans arrive for a trace that has " +
            'already been decided and exported, and are dropped as late arrivals. Nothing ' +
            'else reports that: the queue is healthy, the worker is healthy, and the traces ' +
            'stop at the enqueue.',
        ),
      );
    }

    if (queue.decisionWaitSeconds !== undefined) {
      for (const alarm of dwellAlarms) {
        const threshold = Number(flatten(alarm.properties.Threshold));
        if (!Number.isFinite(threshold)) continue;
        if (threshold >= queue.decisionWaitSeconds) {
          violations.push(
            violation(
              'dwell-alarm-at-or-past-decision-window',
              queue.templatePath,
              `${alarm.id} (dwell alarm for ${queue.queueName})`,
              `The alarm fires at ${threshold}s and the collector decides a trace ` +
                `${queue.decisionWaitSeconds}s after its first span. At or past that window it ` +
                'is a record of traces already lost rather than a warning that they are about ' +
                'to be — by the time it fires there is nothing left to do about the traces it ' +
                'is describing. Set it below the window.',
            ),
          );
        }
      }
    }

    /* The signal that propagation broke. --------------------------------- */
    const filters = metricFiltersOf(template).filter((filter) =>
      asList(filter.properties.MetricTransformations).some(
        (transformation) =>
          isRecord(transformation) &&
          flatten(transformation.MetricName) === TRACE_CONTEXT_MISSING_METRIC,
      ),
    );

    if (filters.length === 0) {
      violations.push(
        violation(
          'context-signal-missing',
          queue.templatePath,
          location,
          `No metric filter publishing ${TRACE_CONTEXT_MISSING_METRIC}. A worker that found no ` +
            'context does exactly what a worker at the start of a trace does — it starts a ' +
            'trace — so there is no AWS metric, no failed call and nothing in the queue\'s own ' +
            'telemetry that differs. The worker saying so is the only signal there is.',
        ),
      );
    }

    for (const filter of filters) {
      const pattern = flatten(filter.properties.FilterPattern);
      if (!pattern.includes(TRACE_CONTEXT_MISSING_EVENT)) {
        violations.push(
          violation(
            'context-filter-pattern-mismatch',
            queue.templatePath,
            `${filter.id} (${TRACE_CONTEXT_MISSING_METRIC} filter)`,
            `The filter pattern \`${pattern}\` does not mention \`${TRACE_CONTEXT_MISSING_EVENT}\`, ` +
              'which is the event the worker logs. A pattern that matches nothing publishes ' +
              'zero forever, and a counter reporting zero is indistinguishable from a system ' +
              'in which nothing is wrong.',
          ),
        );
      }
    }

    if (filters.length > 0) {
      const namespaces = new Set(
        filters.flatMap((filter) =>
          asList(filter.properties.MetricTransformations).flatMap((transformation) =>
            isRecord(transformation) ? [flatten(transformation.MetricNamespace)] : [],
          ),
        ),
      );
      const alarmed = alarmsOf(template).some(
        (alarm) =>
          flatten(alarm.properties.MetricName) === TRACE_CONTEXT_MISSING_METRIC &&
          namespaces.has(flatten(alarm.properties.Namespace)),
      );
      if (!alarmed) {
        violations.push(
          violation(
            'context-alarm-missing',
            queue.templatePath,
            location,
            `${TRACE_CONTEXT_MISSING_METRIC} is published and nothing evaluates it. The metric ` +
              'exists so that a propagation failure is noticed without an incident; a metric ' +
              'nobody alarms on is noticed during one, on a dashboard, by whoever thinks to ' +
              'look.',
          ),
        );
      }
    }
  }

  return violations;
};

/* ── Entry point ──────────────────────────────────────────────────────────── */

export const auditQueueTracing = (input: AuditInput): AuditResult => {
  const containers = containersOf(input.templates);

  return {
    violations: [...auditContainers(containers), ...auditQueues(input.templates)],
    tracedQueuesRead: tracedQueuesOf(input.templates).length,
    workerContainersRead: containers.filter(
      (container) => DECISION_WAIT_ENV_VAR in container.environment,
    ).length,
  };
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations
    .map((v) => `${v.file}  ${v.location}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');

export const readTemplates = (
  root: string,
  relative = path.join('aws', 'cdk', 'cdk.out'),
): TemplateFile[] => {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.template.json'))
    .sort()
    .flatMap((name) => {
      const text = fs.readFileSync(path.join(directory, name), 'utf8');
      try {
        return [{ path: name, document: JSON.parse(text) as unknown }];
      } catch {
        // `cdk synth` fails loudly on its own in the step before this one.
        return [];
      }
    });
};

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const templates = readTemplates(root, process.argv[3]);

  // A gate that reports nothing because it read nothing passes identically to
  // one that read everything and found nothing.
  if (templates.length === 0) {
    console.error(
      `\nNo synthesised templates under ${root}. Run \`npx cdk synth\` first — this gate reads ` +
        'what synth wrote, not the TypeScript that produced it.\n',
    );
    process.exit(1);
  }

  const result = auditQueueTracing({ templates });

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} queue-tracing violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error('\nSee docs/queue-tracing.md.\n');
    process.exit(1);
  }

  console.log(
    `${result.tracedQueuesRead} traced queue(s) and ${result.workerContainersRead} worker ` +
      `container(s) across ${templates.length} template(s): every worker asks for the ` +
      'AWSTraceHeader system attribute and defers to the incoming sampling decision, every ' +
      'traced queue dead-letters and is alarmed below the collector decision window, and the ' +
      'missing-context event has a filter and an alarm over it.',
  );
}
