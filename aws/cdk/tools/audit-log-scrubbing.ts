#!/usr/bin/env node
/**
 * Audit the structured log pipeline: does everything leaving CloudWatch Logs
 * for durable storage actually pass through a scrubbing transform, and are the
 * paths that bypass it closed?
 *
 * Every other gate in this repository reasons about the artifact or the
 * account. This one reasons about the **data**, and it exists because a
 * scrubbing pipeline fails in exactly one direction that nobody sees: the
 * records still arrive, the dashboards stay green, the delivery metrics are
 * perfect, and what landed in S3 has an email address in it.
 *
 * Reads `cdk.out/*.template.json`, so it sees what synth wrote rather than the
 * TypeScript that produced it — a destination configured through an escape
 * hatch or a property override resolves in between.
 *
 * The failure modes it was written for, all of them one line in a template:
 *
 *   • **A destination with no processor.** A delivery stream that writes to S3
 *     with no `ProcessingConfiguration` is the whole pipeline minus the part
 *     that scrubs. It is also the default shape of every Firehose example, so
 *     it is what a second stream added later looks like.
 *
 *   • **Source record backup.** `S3BackupMode: Enabled` writes the
 *     **untransformed** records to S3 beside the transformed ones. It is one
 *     enum in a template and a checkbox in the console, its prefix says
 *     `backup`, and it archives precisely what the transform removed.
 *
 *   • **The error prefix inside the archive prefix.** Firehose writes records
 *     it could not transform to `ErrorOutputPrefix`, raw. Under `scrubbed/`
 *     they are in the dataset the archive's readers were given, and an Athena
 *     table over that prefix reads them as ordinary rows.
 *
 *   • **A second subscription.** A log group may carry two subscription
 *     filters. The second one — to a vendor's Lambda, an OpenSearch domain,
 *     another stream — is a complete copy of the unscrubbed logs leaving by a
 *     path this pipeline never touches.
 *
 *   • **An account data protection policy that audits without masking.** The
 *     API accepts a policy with only the audit half. It then reports findings
 *     for every identifier it sees and masks none of them, which reads in the
 *     console as a policy that is working.
 *
 * The rules, and the failure each one prevents:
 *
 *   delivery-without-transform     a stream that writes to S3 unscrubbed
 *   source-record-backup-enabled   untransformed records archived beside them
 *   quarantine-under-archive       raw error records inside the read dataset
 *   quarantine-never-expires       raw error records kept indefinitely
 *   processor-buffer-unset         1 MB of compressed input against a 6 MB
 *                                  response limit, taken by default
 *   processor-retries-zero         one transient failure delivers raw
 *   stream-not-encrypted           the transit copy unencrypted at rest
 *   subscription-off-pipeline      logs leaving by a second, unscrubbed path
 *   transform-log-group-unmanaged  the transform's own log group created by
 *                                  CloudWatch: no retention, no CMK
 *   data-protection-audit-only     a policy that finds everything and masks
 *                                  nothing
 *   data-protection-audit-recursion  findings scanned by the policy that wrote
 *                                  them
 *   data-protection-policy-conflict  two account-scoped policies in one account
 */
import * as fs from 'fs';
import * as path from 'path';

export type LogScrubbingRule =
  | 'delivery-without-transform'
  | 'source-record-backup-enabled'
  | 'quarantine-under-archive'
  | 'quarantine-never-expires'
  | 'processor-buffer-unset'
  | 'processor-retries-zero'
  | 'stream-not-encrypted'
  | 'subscription-off-pipeline'
  | 'transform-log-group-unmanaged'
  | 'data-protection-audit-only'
  | 'data-protection-audit-recursion'
  | 'data-protection-policy-conflict';

export interface Violation {
  readonly rule: LogScrubbingRule;
  readonly file: string;
  readonly location: string;
  readonly message: string;
}

const violation = (
  rule: LogScrubbingRule,
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
  readonly streamsRead: number;
  readonly subscriptionsRead: number;
  readonly accountPoliciesRead: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** The resources of one template, as `[logicalId, resource]` pairs. */
export const resourcesOf = (
  template: TemplateFile,
): { readonly id: string; readonly type: string; readonly properties: Record<string, unknown> }[] => {
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
 * The logical id a `Ref` or `Fn::GetAtt` points at, if it points inside this
 * template.
 *
 * A cross-stack `Fn::ImportValue` resolves to nothing here on purpose: this
 * tool reads every template in `cdk.out` and still cannot tell which export a
 * string import will bind to, so the rules that depend on resolution say so
 * rather than assuming the reference is fine.
 */
export const referencedLogicalId = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.Ref === 'string') return value.Ref;
  const getAtt = value['Fn::GetAtt'];
  if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') return getAtt[0];
  return undefined;
};

/**
 * A template value read as text, or undefined when it is a reference.
 *
 * `Fn::Join` is flattened, with any nested intrinsic replaced by a placeholder,
 * because a string built from a CDK token — `${this.partition}` inside a policy
 * document, an account id inside a prefix — synthesises to a join rather than a
 * string. A rule that only accepted plain strings would silently skip exactly
 * those resources, which is a gate that reads nothing and reports success. The
 * first draft of this tool did that to its own data protection policy.
 */
export const readText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const join = value['Fn::Join'];
  if (!Array.isArray(join) || join.length !== 2) return undefined;
  const [delimiter, parts] = join as [unknown, unknown];
  if (typeof delimiter !== 'string' || !Array.isArray(parts)) return undefined;
  return parts.map((part) => readText(part) ?? '<intrinsic>').join(delimiter);
};

const literal = readText;

/** The first path segment of a prefix: `scrubbed/dt=…` → `scrubbed`. */
export const topSegment = (prefix: string): string => prefix.split('/')[0];

interface ProcessorView {
  readonly type: string;
  readonly parameters: Record<string, string>;
}

const processorsOf = (destination: Record<string, unknown>): ProcessorView[] => {
  const processing = destination.ProcessingConfiguration;
  if (!isRecord(processing)) return [];
  if (processing.Enabled === false) return [];
  return asList(processing.Processors).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.Type !== 'string') return [];
    const parameters: Record<string, string> = {};
    for (const parameter of asList(entry.Parameters)) {
      if (!isRecord(parameter)) continue;
      const name = literal(parameter.ParameterName);
      const value = parameter.ParameterValue;
      if (name === undefined) continue;
      parameters[name] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return [{ type: entry.Type, parameters }];
  });
};

interface DestinationView {
  readonly property: string;
  readonly config: Record<string, unknown>;
}

const S3_DESTINATION_PROPERTIES = [
  'ExtendedS3DestinationConfiguration',
  'S3DestinationConfiguration',
] as const;

const s3DestinationsOf = (properties: Record<string, unknown>): DestinationView[] =>
  S3_DESTINATION_PROPERTIES.flatMap((property) => {
    const config = properties[property];
    return isRecord(config) ? [{ property, config }] : [];
  });

/* ── Rules over delivery streams ──────────────────────────────────────────── */

export const auditDeliveryStreams = (templates: readonly TemplateFile[]): Violation[] => {
  const violations: Violation[] = [];

  for (const template of templates) {
    const resources = resourcesOf(template);
    const buckets = new Map(
      resources.filter((r) => r.type === 'AWS::S3::Bucket').map((r) => [r.id, r.properties]),
    );

    for (const stream of resources.filter((r) => r.type === 'AWS::KinesisFirehose::DeliveryStream')) {
      const location = `${stream.id} (${stream.type})`;

      if (!isRecord(stream.properties.DeliveryStreamEncryptionConfigurationInput)) {
        violations.push(
          violation(
            'stream-not-encrypted',
            template.path,
            location,
            'the delivery stream sets no server-side encryption, so records sit unencrypted in ' +
              'its buffer — which is where they are while they still hold whatever the transform ' +
              'is about to remove. Set `encryption` on the DeliveryStream.',
          ),
        );
      }

      for (const destination of s3DestinationsOf(stream.properties)) {
        const config = destination.config;
        const where = `${location} → ${destination.property}`;
        const processors = processorsOf(config);
        const lambdaProcessor = processors.find((processor) => processor.type === 'Lambda');

        if (lambdaProcessor === undefined) {
          violations.push(
            violation(
              'delivery-without-transform',
              template.path,
              where,
              'writes to S3 with no enabled Lambda processor, so records are archived exactly as ' +
                'they left the log group. This is the default shape of a Firehose destination ' +
                'and it is the whole pipeline minus the part that scrubs.',
            ),
          );
        } else {
          if (lambdaProcessor.parameters.BufferSizeInMBs === undefined) {
            violations.push(
              violation(
                'processor-buffer-unset',
                template.path,
                where,
                'the Lambda processor does not set BufferSizeInMBs, so Firehose buffers its ' +
                  'default 1 MB per invocation. That bound is on **compressed** input while the ' +
                  "transform's response limit — 6 MB — is on expanded output, and structured logs " +
                  'gzip well past 6:1. Set it deliberately (0.2 is what the CloudWatch Logs ' +
                  'blueprint uses).',
              ),
            );
          }
          if (lambdaProcessor.parameters.NumberOfRetries === '0') {
            violations.push(
              violation(
                'processor-retries-zero',
                template.path,
                where,
                'NumberOfRetries is 0, so the first throttle or timeout sends that batch to the ' +
                  'error prefix untransformed. Retries are the difference between a transient ' +
                  'Lambda failure and unscrubbed records in S3.',
              ),
            );
          }
        }

        if (literal(config.S3BackupMode) === 'Enabled' || isRecord(config.S3BackupConfiguration)) {
          violations.push(
            violation(
              'source-record-backup-enabled',
              template.path,
              where,
              'source record backup is enabled, which writes the **untransformed** records to S3 ' +
                'beside the transformed ones. It is one enum here and one checkbox in the ' +
                'console, and it archives exactly what the transform removed.',
            ),
          );
        }

        const dataPrefix = literal(config.Prefix);
        const errorPrefix = literal(config.ErrorOutputPrefix);

        if (errorPrefix === undefined) {
          violations.push(
            violation(
              'quarantine-under-archive',
              template.path,
              where,
              'no ErrorOutputPrefix, so records Firehose could not transform are written to the ' +
                'bucket root — untransformed, in the same listing as the archive.',
            ),
          );
        } else if (dataPrefix !== undefined && topSegment(errorPrefix) === topSegment(dataPrefix)) {
          violations.push(
            violation(
              'quarantine-under-archive',
              template.path,
              where,
              `ErrorOutputPrefix (${errorPrefix}) shares its top-level prefix with Prefix ` +
                `(${dataPrefix}). Whatever grant, lifecycle rule or Athena table covers the ` +
                'archive then covers the raw records too — and those are the records that ' +
                'reached S3 without being scrubbed.',
            ),
          );
        }

        if (errorPrefix !== undefined) {
          const bucketId = referencedLogicalId(config.BucketARN);
          const bucket = bucketId === undefined ? undefined : buckets.get(bucketId);
          if (bucket !== undefined) {
            const rules = asList(
              isRecord(bucket.LifecycleConfiguration) ? bucket.LifecycleConfiguration.Rules : [],
            );
            const segment = topSegment(errorPrefix);
            const expires = rules.some((rule) => {
              if (!isRecord(rule)) return false;
              if (rule.Status !== 'Enabled') return false;
              const prefix = literal(rule.Prefix);
              if (prefix === undefined || topSegment(prefix) !== segment) return false;
              return typeof rule.ExpirationInDays === 'number';
            });
            if (!expires) {
              violations.push(
                violation(
                  'quarantine-never-expires',
                  template.path,
                  where,
                  `nothing expires objects under ${segment}/ on the destination bucket. That ` +
                    'prefix holds the records the transform never saw, so without a lifecycle ' +
                    'rule the one place unscrubbed data lands is also the one place it is kept ' +
                    'forever.',
                ),
              );
            }
          }
        }
      }
    }
  }

  return violations;
};

/* ── Rules over subscriptions ─────────────────────────────────────────────── */

export const auditSubscriptions = (templates: readonly TemplateFile[]): Violation[] => {
  const violations: Violation[] = [];

  for (const template of templates) {
    const resources = resourcesOf(template);
    const streamIds = new Set(
      resources
        .filter((r) => r.type === 'AWS::KinesisFirehose::DeliveryStream')
        .map((r) => r.id),
    );

    for (const filter of resources.filter((r) => r.type === 'AWS::Logs::SubscriptionFilter')) {
      const destination = filter.properties.DestinationArn;
      const referenced = referencedLogicalId(destination);
      if (referenced !== undefined && streamIds.has(referenced)) continue;

      const described =
        referenced ?? (typeof destination === 'string' ? destination : JSON.stringify(destination));
      violations.push(
        violation(
          'subscription-off-pipeline',
          template.path,
          `${filter.id} (${filter.type})`,
          `forwards log events to ${described}, which is not a delivery stream this template ` +
            'declares — so nothing here can show that what it receives is scrubbed. A second ' +
            'subscription on a log group is a complete copy of the unscrubbed logs leaving by ' +
            'another path; CloudWatch Logs allows two per group, and this is the second one. If ' +
            'the destination does scrub, declare it in the same template so this can see it.',
        ),
      );
    }
  }

  return violations;
};

/* ── Rules over the transform's own log group ─────────────────────────────── */

export const auditTransformLogGroups = (templates: readonly TemplateFile[]): Violation[] => {
  const violations: Violation[] = [];

  for (const template of templates) {
    const resources = resourcesOf(template);
    const functionsById = new Map(
      resources.filter((r) => r.type === 'AWS::Lambda::Function').map((r) => [r.id, r.properties]),
    );
    const logGroupNames = new Set(
      resources
        .filter((r) => r.type === 'AWS::Logs::LogGroup')
        .map((r) => literal(r.properties.LogGroupName))
        .filter((name): name is string => name !== undefined),
    );

    for (const stream of resources.filter((r) => r.type === 'AWS::KinesisFirehose::DeliveryStream')) {
      for (const destination of s3DestinationsOf(stream.properties)) {
        for (const processor of processorsOf(destination.config)) {
          if (processor.type !== 'Lambda') continue;
          const arn = processor.parameters.LambdaArn;
          if (arn === undefined) continue;

          let functionName: string | undefined;
          try {
            const parsed: unknown = JSON.parse(arn);
            const id = referencedLogicalId(parsed);
            const properties = id === undefined ? undefined : functionsById.get(id);
            functionName = properties === undefined ? undefined : literal(properties.FunctionName);
          } catch {
            functionName = undefined;
          }
          if (functionName === undefined) continue;

          if (!logGroupNames.has(`/aws/lambda/${functionName}`)) {
            violations.push(
              violation(
                'transform-log-group-unmanaged',
                template.path,
                `${stream.id} → ${functionName}`,
                'the transform declares no log group of its own, so CloudWatch creates ' +
                  `/aws/lambda/${functionName} on first invocation with no retention and no ` +
                  'customer-managed key. That is the one log group in the account the pipeline ' +
                  'cannot scrub — it is written after the scrub — so it is the one whose ' +
                  'retention has to be a decision rather than a default of forever.',
              ),
            );
          }
        }
      }
    }
  }

  return violations;
};

/* ── Rules over account-wide data protection policies ─────────────────────── */

interface ParsedPolicy {
  readonly template: string;
  readonly id: string;
  readonly document: Record<string, unknown>;
  readonly selectionCriteria?: string;
}

const DATA_PROTECTION = 'DATA_PROTECTION_POLICY';

export const auditDataProtectionPolicies = (templates: readonly TemplateFile[]): Violation[] => {
  const violations: Violation[] = [];
  const parsed: ParsedPolicy[] = [];

  for (const template of templates) {
    for (const resource of resourcesOf(template)) {
      if (resource.type !== 'AWS::Logs::AccountPolicy') continue;
      if (literal(resource.properties.PolicyType) !== DATA_PROTECTION) continue;

      const raw = resource.properties.PolicyDocument;
      const text = literal(raw);
      if (text === undefined) continue;
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isRecord(document)) continue;
      parsed.push({
        template: template.path,
        id: resource.id,
        document,
        selectionCriteria: literal(resource.properties.SelectionCriteria),
      });
    }
  }

  for (const policy of parsed) {
    const statements = asList(policy.document.Statement).filter(isRecord);
    const audits = statements.filter((statement) => isRecord(statement.Operation) && isRecord(statement.Operation.Audit));
    const deidentifies = statements.filter(
      (statement) => isRecord(statement.Operation) && isRecord(statement.Operation.Deidentify),
    );
    const location = `${policy.id} (AWS::Logs::AccountPolicy)`;

    if (deidentifies.length === 0) {
      violations.push(
        violation(
          'data-protection-audit-only',
          policy.template,
          location,
          'the policy has no Deidentify statement, so it finds every identifier it is configured ' +
            'for and masks none of them. The API accepts this, the findings destination fills up, ' +
            'and the console shows a data protection policy that is working.',
        ),
      );
    }

    for (const statement of audits) {
      const operation = statement.Operation as Record<string, unknown>;
      const audit = operation.Audit as Record<string, unknown>;
      const destination = isRecord(audit.FindingsDestination) ? audit.FindingsDestination : {};
      const cloudWatch = isRecord(destination.CloudWatchLogs) ? destination.CloudWatchLogs : undefined;
      const group = cloudWatch === undefined ? undefined : literal(cloudWatch.LogGroup);
      if (group === undefined) continue;

      const criteria = policy.selectionCriteria ?? '';
      if (!criteria.includes(group)) {
        violations.push(
          violation(
            'data-protection-audit-recursion',
            policy.template,
            location,
            `findings are written to ${group}, which the policy's own selection criteria do not ` +
              'exclude. An account-scoped policy covers log groups created after it, this one ' +
              'included, so every finding is scanned and produces a finding — billed per ' +
              'ingested byte. Exclude it with `LogGroupNamePrefix NOT IN [...]`.',
          ),
        );
      }
    }
  }

  if (parsed.length > 1) {
    const described = parsed.map((policy) => `${policy.template}:${policy.id}`).join(', ');
    violations.push(
      violation(
        'data-protection-policy-conflict',
        parsed[1].template,
        parsed[1].id,
        `${parsed.length} account-scoped data protection policies are declared (${described}). ` +
          'They are account- and region-scoped: two with the same name fight over it on every ' +
          'deploy, and two with different names both apply — every log group scanned twice, ' +
          'every finding recorded twice, at a per-byte price. One stack owns it.',
      ),
    );
  }

  return violations;
};

/* ── Entry point ──────────────────────────────────────────────────────────── */

export const auditLogScrubbing = (input: AuditInput): AuditResult => {
  const violations = [
    ...auditDeliveryStreams(input.templates),
    ...auditSubscriptions(input.templates),
    ...auditTransformLogGroups(input.templates),
    ...auditDataProtectionPolicies(input.templates),
  ];

  let streamsRead = 0;
  let subscriptionsRead = 0;
  let accountPoliciesRead = 0;
  for (const template of input.templates) {
    for (const resource of resourcesOf(template)) {
      if (resource.type === 'AWS::KinesisFirehose::DeliveryStream') streamsRead += 1;
      if (resource.type === 'AWS::Logs::SubscriptionFilter') subscriptionsRead += 1;
      if (resource.type === 'AWS::Logs::AccountPolicy') accountPoliciesRead += 1;
    }
  }

  return { violations, streamsRead, subscriptionsRead, accountPoliciesRead };
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

  const result = auditLogScrubbing({ templates });

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} log-pipeline violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error('\nSee docs/log-pipeline.md.\n');
    process.exit(1);
  }

  console.log(
    `${result.streamsRead} delivery stream(s), ${result.subscriptionsRead} subscription filter(s) ` +
      `and ${result.accountPoliciesRead} account policy(ies) across ${templates.length} template(s): ` +
      'every S3 destination transforms before it writes, no source-record backup, quarantine ' +
      'separated and expiring, and nothing leaving CloudWatch Logs by an unscrubbed path.',
  );
}
