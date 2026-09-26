#!/usr/bin/env node
/**
 * Audit runbook coverage: can the person woken by any alarm in this account get
 * from the notification to a first step without looking anything up?
 *
 * Reads `cdk.out/*.template.json` and `docs/runbooks.md`, so it sees what synth
 * wrote and what the link actually resolves to. Every failure it looks for has
 * the same shape — the runbook exists, the link is present, the automation
 * deploys, and the one thing that is missing is invisible until an incident:
 *
 *   An alarm nobody wrote a runbook for. It fires, it arrives, and it carries a
 *   threshold. This is the state the whole item exists to end, and it comes back
 *   one alarm at a time as stacks grow.
 *
 *   An alarm two runbooks claim. Worse than none: the enricher attaches the
 *   first match, so the page arrives looking complete and pointing at the wrong
 *   procedure.
 *
 *   A link whose anchor no longer exists. Renaming a heading does not break a
 *   GitHub anchor — the page returns 200 and lands at the top, on somebody
 *   else's runbook. Nothing reports it and the link looks fine in review.
 *
 *   A first step that needs input. An automation whose parameters are an ARN and
 *   a stream name is a form. Every parameter is either defaulted at synth time
 *   or filled by the enricher from the notification, and nothing else is
 *   executable at 04:00 from a phone.
 *
 *   A first step that changes something. `aws:executeScript`, an
 *   `aws:invokeLambdaFunction`, an `ecs:UpdateService` — each is a plausible
 *   line in a runbook and a bad thing to put one click from a page. The verb is
 *   checked, not the declaration.
 *
 *   An alarm on a topic the enricher never subscribed to. The most silent of the
 *   lot: the alarm works, the enricher works, the runbook is written, and the
 *   two are simply not connected. `ENRICHMENT_EXEMPTIONS` is where a gap is
 *   allowed, and it has to carry a reason.
 *
 * ## The rules
 *
 *   alarm-without-runbook        an alarm that notifies a human and matches no
 *                                catalogue entry
 *   alarm-matches-two-runbooks   two entries claim one alarm; the enricher takes
 *                                the first and the page looks answered
 *   runbook-without-alarms       an entry no alarm in the account reaches. It was
 *                                written for alarms that have since been renamed,
 *                                and it reads as coverage
 *   runbook-anchor-missing       the link resolves to the top of the page
 *   first-step-document-missing  the runbook names a document no stack creates
 *   first-step-action-not-a-read a step that is not a single read API call
 *   first-step-not-read-only     a read API whose verb is not Describe/Get/List
 *   first-step-parameter-unfillable  a parameter with no default that the
 *                                enricher cannot supply
 *   first-step-default-placeholder   a default that is empty or a placeholder
 *   alarm-topic-without-enricher an alarm topic nothing enriches and nothing
 *                                exempts
 *   exemption-matches-no-topic   an exemption describing a topic that no longer
 *                                exists, which is a hole held open for nothing
 *   enricher-without-dead-letter an enricher whose failed notifications are
 *                                dropped rather than recorded
 *
 * Plus every rule in `validateRunbookCatalogue` — see lib/runbooks.ts.
 *
 * See docs/runbooks.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ENRICHMENT_EXEMPTIONS,
  EnrichmentExemption,
  RUNBOOK_CATALOGUE,
  RUNBOOK_DOC_PATH,
  RunbookDefinition,
  exemptionForTopic,
  firstStepDocumentName,
  matchesPattern,
  runbooksForAlarm,
  validateRunbookCatalogue,
} from '../lib/runbooks';

/* ── Contract constants, restated ─────────────────────────────────────────── */

/*
 * Restated rather than imported from `lib/`, for the reason
 * `audit-synthetic-canaries.ts` gives: a gate that imports the constants it
 * checks cannot catch a change to them. The catalogue itself *is* imported,
 * because it is the input under review rather than a constant.
 * `test/audit-runbooks.test.ts` holds these against the library's exports, so a
 * deliberate rename is one failing assertion rather than a silently weakened
 * rule.
 */

/** The only SSM Automation action a first step may use. */
export const FIRST_STEP_ACTION = 'aws:executeAwsApi';

/** API verbs that cannot change anything. */
export const READ_ONLY_API_PREFIXES = ['Describe', 'Get', 'List'] as const;

/** `<env>-rb-<key>`: how `RunbookStack` names a first-step document. */
export const DOCUMENT_NAME_INFIX = '-rb-';

/** Suffix of the enricher's function name. */
export const ENRICHER_FUNCTION_SUFFIX = '-runbook-enricher';

/**
 * Suffix of the topic enriched alerts land on.
 *
 * An alarm may notify this topic with no enricher behind it, and exactly one
 * does: the enricher's own failure alarm. Enriching that would mean asking the
 * broken component to explain itself.
 */
export const ENRICHED_TOPIC_SUFFIX = '-runbook-alerts';

/** Parameter name every document may leave to the automation service. */
export const ASSUME_ROLE_PARAMETER = 'AutomationAssumeRole';

/** Defaults that read as configured and are not. */
const PLACEHOLDER_DEFAULT = /^$|\$\{Token\[|TODO|FIXME|CHANGEME|changeme|example\.(com|org|net)/;

/* ── Types ────────────────────────────────────────────────────────────────── */

export type RunbookAuditRule =
  | 'alarm-without-runbook'
  | 'alarm-matches-two-runbooks'
  | 'runbook-without-alarms'
  | 'runbook-anchor-missing'
  | 'first-step-document-missing'
  | 'first-step-action-not-a-read'
  | 'first-step-not-read-only'
  | 'first-step-parameter-unfillable'
  | 'first-step-default-placeholder'
  | 'alarm-topic-without-enricher'
  | 'exemption-matches-no-topic'
  | 'enricher-without-dead-letter'
  | 'catalogue';

export interface Violation {
  readonly rule: RunbookAuditRule;
  readonly file: string;
  readonly location: string;
  readonly message: string;
}

export interface TemplateFile {
  readonly path: string;
  readonly document: unknown;
}

export interface AuditInput {
  readonly templates: readonly TemplateFile[];
  /** Contents of `docs/runbooks.md`. */
  readonly runbookDoc: string;
  readonly catalogue?: readonly RunbookDefinition[];
  readonly exemptions?: readonly EnrichmentExemption[];
}

export interface AuditResult {
  readonly violations: readonly Violation[];
  readonly alarmsRead: number;
  readonly documentsRead: number;
  readonly enrichedTopics: number;
}

/* ── Template reading ─────────────────────────────────────────────────────── */

interface Resource {
  readonly Type?: string;
  readonly Properties?: Record<string, any>;
}

const resourcesOf = (document: unknown): Record<string, Resource> => {
  const resources = (document as { Resources?: unknown } | null)?.Resources;
  return resources && typeof resources === 'object' ? (resources as Record<string, Resource>) : {};
};

const outputsOf = (document: unknown): Record<string, any> => {
  const outputs = (document as { Outputs?: unknown } | null)?.Outputs;
  return outputs && typeof outputs === 'object' ? (outputs as Record<string, any>) : {};
};

/**
 * Export name → topic name, across every template.
 *
 * A subscription in one stack references a topic in another as
 * `{"Fn::ImportValue": "OtherStack:ExportName"}`, and the alarm that notifies
 * that topic references it as a plain `Ref` inside its own template. Without
 * this map the two are different strings for the same topic and every
 * cross-stack subscription reads as missing.
 */
const buildExportIndex = (templates: readonly TemplateFile[]): Map<string, string> => {
  const index = new Map<string, string>();
  for (const template of templates) {
    const resources = resourcesOf(template.document);
    for (const output of Object.values(outputsOf(template.document))) {
      const exportName = output?.Export?.Name;
      const ref = output?.Value?.Ref;
      if (typeof exportName !== 'string' || typeof ref !== 'string') continue;
      const resource = resources[ref];
      if (resource?.Type !== 'AWS::SNS::Topic') continue;
      const topicName = resource.Properties?.TopicName;
      if (typeof topicName === 'string') index.set(exportName, topicName);
    }
  }
  return index;
};

/**
 * The SNS topic an alarm action or a subscription points at, by name.
 *
 * `undefined` for an action that is not a topic — a CodeDeploy rollback, an
 * Application Auto Scaling policy. Those are actuators rather than
 * notifications, and nobody is woken by one.
 */
const topicNameOf = (
  value: unknown,
  resources: Record<string, Resource>,
  exportIndex: Map<string, string>,
): string | undefined => {
  if (typeof value === 'string') {
    return value.startsWith('arn:') && value.includes(':sns:') ? value.split(':').pop() : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const ref = (value as Record<string, unknown>).Ref;
  if (typeof ref === 'string') {
    const resource = resources[ref];
    if (resource?.Type !== 'AWS::SNS::Topic') return undefined;
    const topicName = resource.Properties?.TopicName;
    return typeof topicName === 'string' ? topicName : undefined;
  }

  const imported = (value as Record<string, unknown>)['Fn::ImportValue'];
  if (typeof imported === 'string') return exportIndex.get(imported);

  return undefined;
};

interface AlarmRecord {
  readonly file: string;
  readonly logicalId: string;
  readonly name: string;
  readonly topics: readonly string[];
}

interface DocumentRecord {
  readonly file: string;
  readonly name: string;
  readonly content: Record<string, any>;
}

const isAlarm = (type: string | undefined): boolean =>
  type === 'AWS::CloudWatch::Alarm' || type === 'AWS::CloudWatch::CompositeAlarm';

const readAlarms = (
  templates: readonly TemplateFile[],
  exportIndex: Map<string, string>,
): AlarmRecord[] => {
  const alarms: AlarmRecord[] = [];
  for (const template of templates) {
    const resources = resourcesOf(template.document);
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (!isAlarm(resource.Type)) continue;
      const properties = resource.Properties ?? {};
      const actions = [
        ...(properties.AlarmActions ?? []),
        ...(properties.OKActions ?? []),
        ...(properties.InsufficientDataActions ?? []),
      ];
      const topics = actions
        .map((action: unknown) => topicNameOf(action, resources, exportIndex))
        .filter((name: string | undefined): name is string => name !== undefined);
      alarms.push({
        file: template.path,
        logicalId,
        name: properties.AlarmName ?? properties.CompositeAlarmName ?? logicalId,
        topics: [...new Set<string>(topics)],
      });
    }
  }
  return alarms;
};

const readDocuments = (templates: readonly TemplateFile[]): DocumentRecord[] => {
  const documents: DocumentRecord[] = [];
  for (const template of templates) {
    for (const resource of Object.values(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::SSM::Document') continue;
      const properties = resource.Properties ?? {};
      if (properties.DocumentType !== 'Automation') continue;
      if (typeof properties.Name !== 'string' || !properties.Name.includes(DOCUMENT_NAME_INFIX)) {
        continue;
      }
      documents.push({
        file: template.path,
        name: properties.Name,
        content: (properties.Content ?? {}) as Record<string, any>,
      });
    }
  }
  return documents;
};

interface EnricherRecord {
  readonly file: string;
  readonly functionName: string;
  readonly logicalId: string;
  readonly hasDeadLetterQueue: boolean;
}

const readEnrichers = (templates: readonly TemplateFile[]): EnricherRecord[] => {
  const enrichers: EnricherRecord[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::Lambda::Function') continue;
      const functionName = resource.Properties?.FunctionName;
      if (typeof functionName !== 'string' || !functionName.endsWith(ENRICHER_FUNCTION_SUFFIX)) {
        continue;
      }
      enrichers.push({
        file: template.path,
        functionName,
        logicalId,
        hasDeadLetterQueue: Boolean(resource.Properties?.DeadLetterConfig?.TargetArn),
      });
    }
  }
  return enrichers;
};

/** Topics an enricher is subscribed to, by topic name. */
const readEnrichedTopics = (
  templates: readonly TemplateFile[],
  exportIndex: Map<string, string>,
  enrichers: readonly EnricherRecord[],
): Set<string> => {
  const enrichedTopics = new Set<string>();
  const enricherIds = new Set(enrichers.map((enricher) => `${enricher.file}#${enricher.logicalId}`));

  for (const template of templates) {
    const resources = resourcesOf(template.document);
    for (const resource of Object.values(resources)) {
      if (resource.Type !== 'AWS::SNS::Subscription') continue;
      const properties = resource.Properties ?? {};
      if (properties.Protocol !== 'lambda') continue;

      const endpoint = properties.Endpoint;
      const target = endpoint?.['Fn::GetAtt']?.[0];
      if (typeof target !== 'string' || !enricherIds.has(`${template.path}#${target}`)) continue;

      const topicName = topicNameOf(properties.TopicArn, resources, exportIndex);
      if (topicName !== undefined) enrichedTopics.add(topicName);
    }
  }
  return enrichedTopics;
};

/* ── Anchors ──────────────────────────────────────────────────────────────── */

/**
 * GitHub's heading slug: lower-cased, punctuation dropped, spaces hyphenated.
 *
 * Reimplemented rather than approximated with a regex over the raw heading,
 * because the failure this rule exists for is a heading that changed by one
 * word — and a looser match would accept exactly that.
 */
export const headingSlug = (heading: string): string =>
  heading
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    // One hyphen per whitespace character, not per run: `github-slugger` does
    // exactly this, so a heading whose em dash left two spaces behind slugs to a
    // double hyphen. Collapsing them here would produce an anchor that does not
    // exist and report a heading that is perfectly fine.
    .replace(/\s/g, '-');

/** Every anchor `docs/runbooks.md` actually offers. */
export const anchorsIn = (markdown: string): Set<string> => {
  const anchors = new Set<string>();
  for (const line of markdown.split('\n')) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match) anchors.add(`#${headingSlug(match[1])}`);
  }
  return anchors;
};

/* ── The audit ────────────────────────────────────────────────────────────── */

export const auditRunbooks = (input: AuditInput): AuditResult => {
  const catalogue = input.catalogue ?? RUNBOOK_CATALOGUE;
  const exemptions = input.exemptions ?? ENRICHMENT_EXEMPTIONS;
  const violations: Violation[] = [];
  const add = (rule: RunbookAuditRule, file: string, location: string, message: string) =>
    violations.push({ rule, file, location, message });

  for (const finding of validateRunbookCatalogue(catalogue, exemptions)) {
    add('catalogue', 'lib/runbooks.ts', finding.runbookId, `[${finding.rule}] ${finding.message}`);
  }

  const exportIndex = buildExportIndex(input.templates);
  const alarms = readAlarms(input.templates, exportIndex);
  const documents = readDocuments(input.templates);
  const enrichers = readEnrichers(input.templates);
  const enrichedTopics = readEnrichedTopics(input.templates, exportIndex, enrichers);

  // ── Coverage: every alarm that reaches a human has exactly one runbook ──────
  const matchedRunbookIds = new Set<string>();
  const notifyingAlarms = alarms.filter((alarm) => alarm.topics.length > 0);

  for (const alarm of notifyingAlarms) {
    const matches = runbooksForAlarm(alarm.name, catalogue);
    for (const match of matches) matchedRunbookIds.add(match.id);

    if (matches.length === 0) {
      add(
        'alarm-without-runbook',
        alarm.file,
        alarm.name,
        `notifies ${alarm.topics.join(', ')} and matches no entry in lib/runbooks.ts. Whoever ` +
          'this wakes gets a name and a threshold. Add a pattern to the runbook that already ' +
          'covers this failure, or write one.',
      );
    } else if (matches.length > 1) {
      add(
        'alarm-matches-two-runbooks',
        alarm.file,
        alarm.name,
        `matches ${matches.map((match) => match.id).join(' and ')}. The enricher attaches the ` +
          'first, so the alert arrives carrying a runbook — one of them confidently wrong. ' +
          'Narrow the patterns.',
      );
    }
  }

  for (const runbook of catalogue) {
    if (!matchedRunbookIds.has(runbook.id)) {
      add(
        'runbook-without-alarms',
        'lib/runbooks.ts',
        runbook.id,
        `no alarm in ${input.templates.length} synthesised template(s) matches ` +
          `${runbook.alarmNamePatterns.join(', ')}. Either the alarms it was written for were ` +
          'renamed — in which case they are now uncovered — or it is documentation shaped like ' +
          'coverage.',
      );
    }
  }

  // ── The link ────────────────────────────────────────────────────────────────
  const anchors = anchorsIn(input.runbookDoc);
  for (const runbook of catalogue) {
    if (!anchors.has(runbook.anchor)) {
      add(
        'runbook-anchor-missing',
        RUNBOOK_DOC_PATH,
        runbook.id,
        `anchor '${runbook.anchor}' has no heading in ${RUNBOOK_DOC_PATH}. GitHub answers 200 ` +
          'for an anchor that does not exist and lands the reader at the top of the page, so ' +
          'this link is not broken in any way a responder can tell from the alert.',
      );
    }
  }

  // ── The first step ──────────────────────────────────────────────────────────
  const documentsByName = new Map(documents.map((document) => [document.name, document]));

  for (const runbook of catalogue) {
    // The same catalogue is deployed per environment, so a first step is
    // satisfied by any environment's copy of its document; the missing case is
    // a key no stack builds at all.
    const copies = documents.filter(
      (document) =>
        document.name.endsWith(`${DOCUMENT_NAME_INFIX}${runbook.firstStep.documentKey}`),
    );

    if (copies.length === 0) {
      add(
        'first-step-document-missing',
        'lib/runbooks.ts',
        runbook.id,
        `first step names document key '${runbook.firstStep.documentKey}' and no stack creates ` +
          `a '*${DOCUMENT_NAME_INFIX}${runbook.firstStep.documentKey}' document. The alert will ` +
          'carry a console link to a document that does not exist, which is discovered by ' +
          'clicking it during an incident.',
      );
      continue;
    }

    for (const document of copies) {
      auditDocument(document, runbook, add);
    }
  }

  // Documents nobody's first step names are not a finding on their own — a
  // consumer may create their own — but a document with a mutating verb is,
  // wherever it came from, because the role that runs it is the read-only one.
  for (const document of documentsByName.values()) {
    if (
      !catalogue.some((runbook) =>
        document.name.endsWith(`${DOCUMENT_NAME_INFIX}${runbook.firstStep.documentKey}`),
      )
    ) {
      auditDocument(document, undefined, add);
    }
  }

  // ── The seam: alarm topic → enricher ────────────────────────────────────────
  const allTopicNames = new Set(notifyingAlarms.flatMap((alarm) => alarm.topics));
  for (const alarm of notifyingAlarms) {
    for (const topic of alarm.topics) {
      if (enrichedTopics.has(topic)) continue;
      if (topic.endsWith(ENRICHED_TOPIC_SUFFIX)) continue;
      if (exemptionForTopic(topic, exemptions)) continue;

      add(
        'alarm-topic-without-enricher',
        alarm.file,
        alarm.name,
        `notifies '${topic}', which no runbook enricher subscribes to and no entry in ` +
          'ENRICHMENT_EXEMPTIONS covers. The alarm works, the runbook exists, and the two are ' +
          'not connected — which looks exactly like an alarm that has never fired.',
      );
    }
  }

  for (const exemption of exemptions) {
    const matched = [...allTopicNames].some((topic) =>
      matchesPattern(exemption.topicNamePattern, topic),
    );
    if (!matched) {
      add(
        'exemption-matches-no-topic',
        'lib/runbooks.ts',
        exemption.topicNamePattern,
        'no alarm topic in the synthesised templates matches this exemption. It is a hole held ' +
          'open for a topic that no longer exists, and the next topic named close enough to it ' +
          'will fall through.',
      );
    }
  }

  for (const enricher of enrichers) {
    if (!enricher.hasDeadLetterQueue) {
      add(
        'enricher-without-dead-letter',
        enricher.file,
        enricher.functionName,
        'has no dead-letter queue. A notification it fails to process after every retry is an ' +
          'alert that reached nobody, and without a queue there is no record that it happened.',
      );
    }
  }

  return {
    violations,
    alarmsRead: notifyingAlarms.length,
    documentsRead: documents.length,
    enrichedTopics: enrichedTopics.size,
  };
};

/** The rules that read one synthesised document. */
const auditDocument = (
  document: DocumentRecord,
  runbook: RunbookDefinition | undefined,
  add: (rule: RunbookAuditRule, file: string, location: string, message: string) => void,
): void => {
  const steps: any[] = Array.isArray(document.content.mainSteps) ? document.content.mainSteps : [];

  if (steps.length !== 1) {
    add(
      'first-step-action-not-a-read',
      document.file,
      document.name,
      `has ${steps.length} step(s). A first step is one call whose answer is on the screen ` +
        'before the responder is; a document with a sequence in it is the runbook, not its ' +
        'first line.',
    );
  }

  for (const step of steps) {
    if (step?.action !== FIRST_STEP_ACTION) {
      add(
        'first-step-action-not-a-read',
        document.file,
        `${document.name}/${step?.name ?? '(unnamed)'}`,
        `uses '${step?.action}'. Only '${FIRST_STEP_ACTION}' is allowed here: every other ` +
          'action can run code, and code in a first step is a remediation nobody reviewed as ' +
          'one.',
      );
      continue;
    }

    const api = step?.inputs?.Api;
    if (typeof api !== 'string') {
      add(
        'first-step-not-read-only',
        document.file,
        `${document.name}/${step?.name ?? '(unnamed)'}`,
        'declares no Api input, so nothing here can tell what it calls.',
      );
      continue;
    }
    if (!READ_ONLY_API_PREFIXES.some((prefix) => api.startsWith(prefix))) {
      add(
        'first-step-not-read-only',
        document.file,
        `${document.name}/${step.name ?? '(unnamed)'}`,
        `calls ${step.inputs?.Service}:${api}, which is not a ` +
          `${READ_ONLY_API_PREFIXES.join('/')} call. The first step of a runbook is handed to ` +
          'someone ninety seconds awake, one click from a page; it reads and it does not act.',
      );
    }
  }

  const parameters: Record<string, any> =
    document.content.parameters && typeof document.content.parameters === 'object'
      ? document.content.parameters
      : {};

  for (const [name, parameter] of Object.entries(parameters)) {
    const hasDefault = parameter !== null && typeof parameter === 'object' && 'default' in parameter;

    if (!hasDefault) {
      const fillable =
        name === ASSUME_ROLE_PARAMETER ||
        (runbook?.firstStep.alarmFilledParameters as readonly string[] | undefined)?.includes(name);
      if (!fillable) {
        add(
          'first-step-parameter-unfillable',
          document.file,
          `${document.name}/${name}`,
          'has no default and is not one the enricher fills from the notification. Running the ' +
            'first step then means finding a value first, which is the lookup this whole thing ' +
            'exists to remove.',
        );
      }
      continue;
    }

    const value = parameter.default;
    // A default resolved from an intrinsic — `Fn::GetAtt` on the automation
    // role, most of them — is a real value at deploy time and cannot be checked
    // for placeholders here.
    if (typeof value === 'string' && PLACEHOLDER_DEFAULT.test(value)) {
      add(
        'first-step-default-placeholder',
        document.file,
        `${document.name}/${name}`,
        `default '${value}' is empty or a placeholder. The document deploys, the console ` +
          'prefills the field, and the execution fails on a resource that does not exist.',
      );
    }
  }
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations.map((v) => `  [${v.rule}] ${v.file} ${v.location}\n      ${v.message}`).join('\n');

export const readTemplates = (root: string, only?: string): TemplateFile[] => {
  const directory = path.join(root, 'aws', 'cdk', 'cdk.out');
  const base = fs.existsSync(directory) ? directory : root;
  return fs
    .readdirSync(base)
    .filter((name) => name.endsWith('.template.json'))
    .filter((name) => only === undefined || name.includes(only))
    .flatMap((name) => {
      try {
        const text = fs.readFileSync(path.join(base, name), 'utf8');
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

  const docPath = path.join(root, RUNBOOK_DOC_PATH);
  if (!fs.existsSync(docPath)) {
    console.error(
      `\n${RUNBOOK_DOC_PATH} does not exist. Every runbook link in every alert points into it.\n`,
    );
    process.exit(1);
  }

  const result = auditRunbooks({
    templates,
    runbookDoc: fs.readFileSync(docPath, 'utf8'),
  });

  if (result.documentsRead === 0) {
    console.error(
      `\nNo '*${DOCUMENT_NAME_INFIX}*' Automation documents in ${templates.length} template(s). ` +
        'Either RunbookStack was removed or its documents were renamed, and the second case ' +
        'leaves every first-step rule below unevaluated while this gate stays green.\n',
    );
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} runbook violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error('\nSee docs/runbooks.md.\n');
    process.exit(1);
  }

  console.log(
    `${result.alarmsRead} alarm(s) that notify a topic, across ${templates.length} template(s): ` +
      `each matches exactly one of ${RUNBOOK_CATALOGUE.length} runbooks, every runbook's anchor ` +
      `resolves in ${RUNBOOK_DOC_PATH}, every first step is a single read-only API call whose ` +
      `parameters are defaulted or filled from the alarm (${result.documentsRead} document(s)), ` +
      `and every alarm topic is either enriched (${result.enrichedTopics}) or exempt with a ` +
      'reason.',
  );
}
