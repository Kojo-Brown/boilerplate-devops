#!/usr/bin/env node
/**
 * Audit the recovery objectives and the game day that measures them: is the
 * number in the DR document something anybody has actually observed, and is the
 * exercise that observes it one a human has to start?
 *
 * Reads `cdk.out/*.template.json` and `docs/game-days.md`, so it sees what synth
 * wrote and what the links resolve to. Every failure it looks for has the same
 * shape — the stack deploys, the exercise runs, the record is written, and the
 * thing that is wrong is invisible until somebody quotes the number in an
 * incident:
 *
 *   A document in an environment its scenario never sanctioned. The blast
 *   radius here is structural rather than checked, which is stronger — but only
 *   if the two agree, and a scenario narrowed from ['staging', 'production'] to
 *   ['staging'] leaves a perfectly working document in production.
 *
 *   An exercise a machine can start. `aws:approve` is the one property that
 *   makes a deliberate production outage safe, and the step reads like any other
 *   in a diff. So does a `NotificationArn` that is absent, which produces an
 *   approval request nobody is told about and an exercise that times out an hour
 *   later.
 *
 *   A failover that is a reboot. `ForceFailover` absent is a valid
 *   `RebootDBInstance` call: the instance goes away, comes back, the probe
 *   records an outage, and the exercise reports a measured RTO for a promotion
 *   that never happened. So is a missing Multi-AZ assertion, which is the same
 *   result on a Single-AZ instance with the flag present.
 *
 *   A wait that is satisfied before anything happens. For a few seconds after
 *   the reboot call the instance still reads `available`, so a
 *   `waitForAwsResourceProperty` placed before the settle period returns
 *   immediately and the measurement runs over a window in which nothing has
 *   occurred. The ordering is the whole of it, and ordering is what nobody
 *   reviews in a nine-step document.
 *
 *   A step with no abort path. SSM Automation's default for a failed step is to
 *   end the execution, so a step without `onFailure` produces an exercise that
 *   stopped and left nothing behind — which is indistinguishable from an
 *   exercise nobody ran, and the refusals are the most useful thing this
 *   mechanism produces.
 *
 *   A probe that has quietly stopped being able to measure anything. One sample
 *   per invocation, or standard-resolution metrics, each turn a ten-second ruler
 *   back into a sixty-second one — against an RTO of two minutes. Neither
 *   changes a single alarm or breaks a single test.
 *
 *   An alarm threshold that is red in normal operation. `LatestRestorableTime`
 *   advances in steps, so a restore-point alarm set at the objective pages most
 *   afternoons, and an alarm that is usually red is an alarm with a filter rule
 *   on it.
 *
 *   An overdue alarm that cannot fire. Both freshness signals are absent when
 *   there is nothing to report — never rehearsed, no restore point at all — so
 *   both alarms have to breach on missing data. `notBreaching` there means the
 *   alarm arms itself only once somebody has already done the thing it exists to
 *   remind them of.
 *
 * ## The rules
 *
 *   objective-anchor-missing        an objective whose section is not in the doc
 *   doc-anchor-missing              an alarm description linking to a heading
 *                                   that does not exist
 *   scenario-document-missing       a sanctioned environment with no document
 *   document-in-forbidden-environment  a document where the scenario says no
 *   document-without-approval       the exercise does not start from aws:approve
 *   approval-without-approvers      an approve step with no approvers to ask
 *   approval-without-notification   an approval request nobody is told about
 *   failover-without-multi-az-assert  no assertion that the instance is Multi-AZ
 *   failover-without-force-failover a reboot rather than a promotion
 *   wait-before-settle              the status wait is satisfied before the
 *                                   failover starts
 *   step-without-abort-path         a step whose failure leaves no record
 *   abort-step-missing              nothing records an aborted exercise
 *   probe-not-in-vpc                a probe that measures a path nothing uses
 *   probe-resolution-too-coarse     high-resolution storage or per-invocation
 *                                   sampling turned off
 *   probe-silence-not-alarmed       nothing reports a probe that stopped
 *   restore-point-threshold-wrong   a threshold that is red in normal operation
 *   freshness-alarm-not-breaching   an absent signal treated as a healthy one
 *   rehearsal-alarm-missing         a rehearsed objective nothing reports as stale
 *   failover-write-unscoped         rds:RebootDBInstance on every database in
 *                                   the account
 *   automation-role-holds-other-writes  the exercise's role can change something
 *                                   other than the one thing it is for
 *
 * Plus every rule in `validateGameDayCatalogue` — see lib/game-days.ts.
 *
 * See docs/game-days.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  GAME_DAY_SCENARIOS,
  GameDayScenario,
  RECOVERY_OBJECTIVES,
  RecoveryObjective,
  gameDayDocumentName,
  validateGameDayCatalogue,
} from '../lib/game-days';
import { anchorsIn } from './audit-runbooks';

/* ── Contract constants, restated ─────────────────────────────────────────── */

/*
 * Restated rather than imported from `lib/`, for the reason
 * `audit-synthetic-canaries.ts` gives: a gate that imports the constants it
 * checks cannot catch a change to them. The catalogue itself *is* imported,
 * because it is the input under review rather than a constant.
 * `test/audit-game-days.test.ts` holds these against the library's exports, so a
 * deliberate rename is one failing assertion rather than a silently weakened
 * rule.
 */

/** Where the objectives are documented. */
export const GAME_DAY_DOC_PATH = 'docs/game-days.md';

/** `<env>-gameday-<scenario>`: how the stack names an exercise. */
export const DOCUMENT_NAME_INFIX = '-gameday-';

/** The action the exercise has to begin with. */
export const APPROVAL_ACTION = 'aws:approve';

/** The step that injects the fault, and the flag that makes it a promotion. */
export const FAILOVER_API = 'RebootDBInstance';

/** JSON path the Multi-AZ assertion has to be about. */
export const MULTI_AZ_SELECTOR = '$.DBInstances[0].MultiAZ';

/** JSON path the status wait has to be about. */
export const STATUS_SELECTOR = '$.DBInstances[0].DBInstanceStatus';

/** Suffix of the probe's function name. */
export const PROBE_FUNCTION_SUFFIX = '-game-day-probe';

/** Alarm suffixes this gate requires to exist per environment. */
export const REQUIRED_ALARM_SUFFIXES = ['-db-connect-failing', '-game-day-probe-silent'] as const;

/** Suffix of the restore-point alarm. */
export const RESTORE_POINT_ALARM_SUFFIX = '-restore-point-stale';

/** Prefix of an overdue alarm's objective-scoped name. */
export const REHEARSAL_ALARM_INFIX = '-rehearsal-overdue-';

/**
 * Seconds between probe samples, and the storage resolution.
 *
 * Restated: the measurement's precision is these two numbers, and an objective
 * of 120s cannot be measured by a probe that has quietly gone back to one
 * sample a minute at standard resolution.
 */
export const EXPECTED_SAMPLE_INTERVAL_SECONDS = 10;
export const EXPECTED_STORAGE_RESOLUTION = 1;
export const EXPECTED_SAMPLES_PER_INVOCATION = 6;
export const EXPECTED_RECORDER_INTERVAL_SECONDS = 300;

/**
 * The restore-point alarm's threshold, restated.
 *
 * `rpoSeconds + 2 × recorder interval`. The derivation is in
 * `lib/game-days.ts`; what matters here is that a threshold edited in the stack
 * fails the build rather than paging somebody every afternoon.
 */
export const expectedRestorePointThreshold = (objective: RecoveryObjective): number =>
  objective.rpoSeconds + 2 * EXPECTED_RECORDER_INTERVAL_SECONDS;

/**
 * Non-read IAM actions the exercise's role may hold.
 *
 * Three, and each is the exercise itself: inject the fault, run the conductor,
 * ask for the approval. Anything else is a role that can change production for
 * reasons nobody wrote down.
 */
export const PERMITTED_AUTOMATION_WRITES = [
  'rds:RebootDBInstance',
  'lambda:InvokeFunction',
  'sns:Publish',
  // Publishing to a topic with a customer-managed key needs these two, and
  // `grantPublish` adds them without saying so — they are on the key's resource
  // policy side of the same permission, not a second capability. Writing the
  // list without them is how this rule was first tried, and it reported the
  // approval request as an unexplained write.
  'kms:Decrypt',
  'kms:GenerateDataKey*',
] as const;

const READ_ONLY_PREFIXES = ['Describe', 'Get', 'List'];

/* ── Types ────────────────────────────────────────────────────────────────── */

/**
 * Every rule, as data rather than as a union alone.
 *
 * `test/audit-game-days.test.ts` walks this list and fails on a rule with no
 * entry in the header above and on one with no fixture that trips it. A rule
 * that fires on nothing is a green check over nothing, and the header is where
 * a reviewer finds out what this gate claims to cover.
 */
export const GAME_DAY_AUDIT_RULES = [
  'objective-anchor-missing',
  'doc-anchor-missing',
  'scenario-document-missing',
  'document-in-forbidden-environment',
  'document-without-approval',
  'approval-without-approvers',
  'approval-without-notification',
  'failover-without-multi-az-assert',
  'failover-without-force-failover',
  'wait-before-settle',
  'step-without-abort-path',
  'abort-step-missing',
  'probe-not-in-vpc',
  'probe-resolution-too-coarse',
  'probe-silence-not-alarmed',
  'restore-point-threshold-wrong',
  'freshness-alarm-not-breaching',
  'rehearsal-alarm-missing',
  'failover-write-unscoped',
  'automation-role-holds-other-writes',
  'catalogue',
] as const;

export type GameDayAuditRule = (typeof GAME_DAY_AUDIT_RULES)[number];

export interface Violation {
  readonly rule: GameDayAuditRule;
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
  /** Contents of {@link GAME_DAY_DOC_PATH}. */
  readonly gameDayDoc: string;
  readonly objectives?: readonly RecoveryObjective[];
  readonly scenarios?: readonly GameDayScenario[];
}

export interface AuditResult {
  readonly violations: readonly Violation[];
  readonly documentsRead: number;
  readonly alarmsRead: number;
  readonly environmentsRead: readonly string[];
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

interface DocumentRecord {
  readonly file: string;
  readonly name: string;
  /** Environment, from the name: `<env>-gameday-<scenario>`. */
  readonly envName: string;
  readonly scenarioId: string;
  readonly content: Record<string, any>;
}

interface AlarmRecord {
  readonly file: string;
  readonly logicalId: string;
  readonly name: string;
  readonly description: string;
  readonly threshold: unknown;
  readonly treatMissingData: string | undefined;
}

interface FunctionRecord {
  readonly file: string;
  readonly logicalId: string;
  readonly name: string;
  readonly environment: Record<string, unknown>;
  readonly hasVpcConfig: boolean;
}

interface StatementRecord {
  readonly file: string;
  readonly logicalId: string;
  readonly roleName: string | undefined;
  readonly actions: readonly string[];
  readonly resources: readonly unknown[];
}

export const readGameDayDocuments = (templates: readonly TemplateFile[]): DocumentRecord[] => {
  const documents: DocumentRecord[] = [];
  for (const template of templates) {
    for (const resource of Object.values(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::SSM::Document') continue;
      const properties = resource.Properties ?? {};
      if (properties.DocumentType !== 'Automation') continue;
      const name = properties.Name;
      if (typeof name !== 'string' || !name.includes(DOCUMENT_NAME_INFIX)) continue;
      const [envName, scenarioId] = name.split(DOCUMENT_NAME_INFIX);
      documents.push({
        file: template.path,
        name,
        envName,
        scenarioId,
        content: (properties.Content ?? {}) as Record<string, any>,
      });
    }
  }
  return documents;
};

const readAlarms = (templates: readonly TemplateFile[]): AlarmRecord[] => {
  const alarms: AlarmRecord[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::CloudWatch::Alarm') continue;
      const properties = resource.Properties ?? {};
      alarms.push({
        file: template.path,
        logicalId,
        name: typeof properties.AlarmName === 'string' ? properties.AlarmName : logicalId,
        description: typeof properties.AlarmDescription === 'string' ? properties.AlarmDescription : '',
        threshold: properties.Threshold,
        treatMissingData:
          typeof properties.TreatMissingData === 'string' ? properties.TreatMissingData : undefined,
      });
    }
  }
  return alarms;
};

const readFunctions = (templates: readonly TemplateFile[]): FunctionRecord[] => {
  const functions: FunctionRecord[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::Lambda::Function') continue;
      const properties = resource.Properties ?? {};
      const name = properties.FunctionName;
      if (typeof name !== 'string') continue;
      const variables = properties.Environment?.Variables;
      functions.push({
        file: template.path,
        logicalId,
        name,
        environment: variables && typeof variables === 'object' ? variables : {},
        hasVpcConfig:
          properties.VpcConfig !== undefined &&
          Array.isArray(properties.VpcConfig?.SubnetIds) &&
          properties.VpcConfig.SubnetIds.length > 0,
      });
    }
  }
  return functions;
};

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

const readStatements = (templates: readonly TemplateFile[]): StatementRecord[] => {
  const statements: StatementRecord[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::IAM::Policy' && resource.Type !== 'AWS::IAM::ManagedPolicy') {
        continue;
      }
      const properties = resource.Properties ?? {};
      const roles = asList(properties.Roles).filter((role) => role !== undefined);
      const roleName = roles
        .map((role) => (typeof role === 'object' && role !== null ? (role as any).Ref : role))
        .find((name): name is string => typeof name === 'string');
      for (const statement of asList(properties.PolicyDocument?.Statement)) {
        if (!statement || typeof statement !== 'object') continue;
        const entry = statement as Record<string, unknown>;
        if (entry.Effect !== 'Allow') continue;
        statements.push({
          file: template.path,
          logicalId,
          roleName,
          actions: asList(entry.Action).filter((action): action is string => typeof action === 'string'),
          resources: asList(entry.Resource),
        });
      }
    }
  }
  return statements;
};

/** Links into the game-day doc, from anywhere in a template. */
const docAnchorsIn = (text: string): string[] =>
  [...text.matchAll(/game-days\.md(#[a-z0-9-]+)/g)].map((match) => match[1]);

/* ── The audit ────────────────────────────────────────────────────────────── */

export const auditGameDays = (input: AuditInput): AuditResult => {
  const objectives = input.objectives ?? RECOVERY_OBJECTIVES;
  const scenarios = input.scenarios ?? GAME_DAY_SCENARIOS;
  const violations: Violation[] = [];
  const add = (rule: GameDayAuditRule, file: string, location: string, message: string) =>
    violations.push({ rule, file, location, message });

  for (const finding of validateGameDayCatalogue(objectives, scenarios)) {
    add('catalogue', 'lib/game-days.ts', finding.subject, `[${finding.rule}] ${finding.message}`);
  }

  const documents = readGameDayDocuments(input.templates);
  const alarms = readAlarms(input.templates);
  const functions = readFunctions(input.templates);
  const statements = readStatements(input.templates);

  // Environments are discovered from what synth wrote rather than passed in: a
  // gate told which environments to expect cannot report one that disappeared.
  const environments = [
    ...new Set([
      ...documents.map((document) => document.envName),
      ...functions
        .filter((fn) => fn.name.endsWith(PROBE_FUNCTION_SUFFIX))
        .map((fn) => fn.name.slice(0, -PROBE_FUNCTION_SUFFIX.length)),
    ]),
  ].sort();

  // ── The documentation ──────────────────────────────────────────────────────
  const anchors = anchorsIn(input.gameDayDoc);
  for (const objective of objectives) {
    if (!anchors.has(objective.anchor)) {
      add(
        'objective-anchor-missing',
        GAME_DAY_DOC_PATH,
        objective.id,
        `anchor '${objective.anchor}' has no heading in ${GAME_DAY_DOC_PATH}. GitHub answers 200 ` +
          'for an anchor that does not exist and lands the reader at the top of the page, so the ' +
          'link is not broken in any way anybody can tell from the alert.',
      );
    }
  }

  for (const alarm of alarms) {
    for (const anchor of docAnchorsIn(alarm.description)) {
      if (!anchors.has(anchor)) {
        add(
          'doc-anchor-missing',
          alarm.file,
          alarm.name,
          `its description links to ${GAME_DAY_DOC_PATH}${anchor}, which no heading in that ` +
            'document produces. The responder reading it at 04:00 lands on somebody else\'s ' +
            'section.',
        );
      }
    }
  }

  // ── The blast radius ───────────────────────────────────────────────────────
  for (const scenario of scenarios) {
    for (const envName of scenario.allowedEnvironments) {
      if (!environments.includes(envName)) continue;
      const expected = gameDayDocumentName(envName, scenario.id);
      if (!documents.some((document) => document.name === expected)) {
        add(
          'scenario-document-missing',
          'bin/app.ts',
          expected,
          `'${scenario.id}' names '${envName}' in allowedEnvironments and no document for it was ` +
            'synthesised. The objective it measures is then rehearsed by nothing, and its ' +
            'overdue alarm will be red forever with nothing anybody can run to clear it.',
        );
      }
    }
  }

  for (const document of documents) {
    const scenario = scenarios.find((candidate) => candidate.id === document.scenarioId);
    if (scenario === undefined) {
      add(
        'document-in-forbidden-environment',
        document.file,
        document.name,
        `no scenario with id '${document.scenarioId}' is in the catalogue, so this exercise has ` +
          'no declared blast radius, no objective and nowhere to record a result — and it is ' +
          'deployed and runnable.',
      );
      continue;
    }
    if (!scenario.allowedEnvironments.includes(document.envName)) {
      add(
        'document-in-forbidden-environment',
        document.file,
        document.name,
        `'${scenario.id}' permits ${scenario.allowedEnvironments.join(', ')} and this document is ` +
          `in '${document.envName}'. The blast radius here is enforced by which documents exist, ` +
          'so a scenario narrowed in the catalogue leaves a perfectly working exercise behind in ' +
          'the environment it was narrowed out of.',
      );
    }

    auditDocument(document, add);
  }

  // ── The probe ──────────────────────────────────────────────────────────────
  for (const fn of functions) {
    if (!fn.name.endsWith(PROBE_FUNCTION_SUFFIX)) continue;

    if (!fn.hasVpcConfig) {
      add(
        'probe-not-in-vpc',
        fn.file,
        fn.name,
        'has no VpcConfig. The probe stands in for the application, which reaches the database ' +
          'over private subnets and a security group; from outside the VPC it would measure a ' +
          'path nothing uses — and it would report healthy while the application could not ' +
          'connect at all.',
      );
    }

    const resolution = Number(fn.environment.STORAGE_RESOLUTION);
    const sampleInterval = Number(fn.environment.SAMPLE_INTERVAL_MS) / 1000;
    const samples = Number(fn.environment.SAMPLES_PER_INVOCATION);

    if (resolution !== EXPECTED_STORAGE_RESOLUTION) {
      add(
        'probe-resolution-too-coarse',
        fn.file,
        fn.name,
        `STORAGE_RESOLUTION is ${fn.environment.STORAGE_RESOLUTION}, not ` +
          `${EXPECTED_STORAGE_RESOLUTION}. At standard resolution CloudWatch aggregates every ` +
          'sample an invocation takes into the minute it landed in, which hands the measurement ' +
          'back the sixty-second ruler the sampling exists to escape — and nothing about the ' +
          'stack, the alarms or the exercise changes.',
      );
    }
    if (!Number.isFinite(samples) || samples < EXPECTED_SAMPLES_PER_INVOCATION) {
      add(
        'probe-resolution-too-coarse',
        fn.file,
        fn.name,
        `SAMPLES_PER_INVOCATION is ${fn.environment.SAMPLES_PER_INVOCATION}, below ` +
          `${EXPECTED_SAMPLES_PER_INVOCATION}. EventBridge cannot schedule faster than once a ` +
          'minute, so sampling inside the invocation is the only thing that resolves a ' +
          'two-minute RTO to better than half of itself.',
      );
    }
    if (sampleInterval !== EXPECTED_SAMPLE_INTERVAL_SECONDS) {
      add(
        'probe-resolution-too-coarse',
        fn.file,
        fn.name,
        `SAMPLE_INTERVAL_MS is ${fn.environment.SAMPLE_INTERVAL_MS}, which is not ` +
          `${EXPECTED_SAMPLE_INTERVAL_SECONDS}s. Every RTO measured from this probe carries this ` +
          'number as its uncertainty, and lib/game-days.ts refuses an objective worth fewer than ' +
          'ten of them.',
      );
    }
  }

  for (const envName of environments) {
    for (const suffix of REQUIRED_ALARM_SUFFIXES) {
      const expected = `${envName}${suffix}`;
      if (!alarms.some((alarm) => alarm.name === expected)) {
        add(
          'probe-silence-not-alarmed',
          'lib/failover-game-day-stack.ts',
          expected,
          `no alarm named '${expected}'. Without the first, a caller-side database outage is ` +
            'reported by nothing in this repository; without the second, a probe that stopped ' +
            'reporting produces windows full of nothing, and nothing averages to health.',
        );
      }
    }
  }

  const silenceAlarms = alarms.filter((alarm) => alarm.name.endsWith('-game-day-probe-silent'));
  for (const alarm of silenceAlarms) {
    if (alarm.treatMissingData !== 'breaching') {
      add(
        'freshness-alarm-not-breaching',
        alarm.file,
        alarm.name,
        `TreatMissingData is '${alarm.treatMissingData ?? 'unset'}'. The entire subject of this ` +
          'alarm is the absence of data, so any other setting makes it an alarm that cannot fire.',
      );
    }
  }

  // ── The freshness signals ──────────────────────────────────────────────────
  for (const envName of environments) {
    for (const objective of objectives) {
      if (objective.rpoBasis === 'latest-restorable-time') {
        const alarm = alarms.find((candidate) => candidate.name === `${envName}${RESTORE_POINT_ALARM_SUFFIX}`);
        if (alarm === undefined) {
          add(
            'rehearsal-alarm-missing',
            'lib/failover-game-day-stack.ts',
            `${envName}${RESTORE_POINT_ALARM_SUFFIX}`,
            `'${objective.id}' declares an RPO measured from LatestRestorableTime and nothing ` +
              'alarms on it. That timestamp is the one DR number that goes wrong with nothing ' +
              'failing: the instance stays healthy, the backups stay "enabled", and the data you ' +
              'could get back gets older.',
          );
        } else {
          const expected = expectedRestorePointThreshold(objective);
          if (alarm.threshold !== expected) {
            add(
              'restore-point-threshold-wrong',
              alarm.file,
              alarm.name,
              `threshold is ${String(alarm.threshold)}, expected ${expected} — the objective's ` +
                `${objective.rpoSeconds}s plus two recorder intervals. LatestRestorableTime ` +
                'advances in steps of about one objective, so a sampler sees a sawtooth peaking ' +
                'at a step plus a sample interval: a threshold at or below that is red during ' +
                'normal operation, which is how an alarm about data loss acquires a filter rule.',
            );
          }
          if (alarm.treatMissingData !== 'breaching') {
            add(
              'freshness-alarm-not-breaching',
              alarm.file,
              alarm.name,
              `TreatMissingData is '${alarm.treatMissingData ?? 'unset'}'. The recorder publishes ` +
                'nothing when LatestRestorableTime is absent, which is what an instance with no ' +
                'backup retention looks like — and "there is no restore path" is not a small lag.',
            );
          }
        }
      }

      if (objective.status !== 'rehearsed') continue;
      const expectedName = `${envName}${REHEARSAL_ALARM_INFIX}${objective.id}`;
      const alarm = alarms.find((candidate) => candidate.name === expectedName);
      if (alarm === undefined) {
        add(
          'rehearsal-alarm-missing',
          'lib/failover-game-day-stack.ts',
          expectedName,
          `'${objective.id}' is 'rehearsed' and nothing reports it going stale. An engine ` +
            'upgrade, an instance-class change or a new connection pool each move the RTO, and ' +
            'none of them is a change anybody files under disaster recovery — so without this ' +
            'the number ages silently and is quoted anyway.',
        );
        continue;
      }
      const expectedThreshold = objective.rehearsalIntervalDays * 24;
      if (alarm.threshold !== expectedThreshold) {
        add(
          'restore-point-threshold-wrong',
          alarm.file,
          alarm.name,
          `threshold is ${String(alarm.threshold)} hours, expected ${expectedThreshold} — the ` +
            `objective's ${objective.rehearsalIntervalDays}-day interval. The interval is the ` +
            'objective\'s shelf life, and a threshold that disagrees with it means the alarm is ' +
            'enforcing an interval nobody declared.',
        );
      }
      if (alarm.treatMissingData !== 'breaching') {
        add(
          'freshness-alarm-not-breaching',
          alarm.file,
          alarm.name,
          `TreatMissingData is '${alarm.treatMissingData ?? 'unset'}'. An objective that has ` +
            'never been rehearsed has no datapoint, and that is the state this alarm exists for. ' +
            'Anything but breaching means it arms itself only once somebody has already done the ' +
            'thing it is reminding them to do.',
        );
      }
    }
  }

  // ── The one write ──────────────────────────────────────────────────────────
  for (const statement of statements) {
    const failoverActions = statement.actions.filter((action) => action.endsWith(`:${FAILOVER_API}`));
    if (failoverActions.length > 0) {
      const unscoped = statement.resources.some((resource) => resource === '*');
      if (unscoped) {
        add(
          'failover-write-unscoped',
          statement.file,
          `${statement.logicalId}/${failoverActions.join(',')}`,
          'is granted on "*", which is a grant to reboot every database in the account. It ' +
            'reads in a diff exactly like the scoped version, and the exercise works identically ' +
            'either way.',
        );
      }
    }

    // Only the exercise's own role. Every other role in these templates is
    // read-only by design and is covered by `audit-iam-least-privilege.ts`.
    if (!statement.file.includes('FailoverGameDay')) continue;
    if (!(statement.roleName ?? '').includes('GameDayAutomationRole')) continue;
    for (const action of statement.actions) {
      const verb = action.split(':')[1] ?? '';
      if (READ_ONLY_PREFIXES.some((prefix) => verb.startsWith(prefix))) continue;
      if ((PERMITTED_AUTOMATION_WRITES as readonly string[]).includes(action)) continue;
      add(
        'automation-role-holds-other-writes',
        statement.file,
        `${statement.logicalId}/${action}`,
        `is a write the exercise does not need. This role is the only one in this repository ` +
          'that can change production, and the three things it is for are ' +
          `${PERMITTED_AUTOMATION_WRITES.join(', ')}. Anything else widens a deliberate outage ` +
          'into a general-purpose one.',
      );
    }
  }

  return {
    violations,
    documentsRead: documents.length,
    alarmsRead: alarms.length,
    environmentsRead: environments,
  };
};

/* ── One exercise ─────────────────────────────────────────────────────────── */

export const auditDocument = (
  document: DocumentRecord,
  add: (rule: GameDayAuditRule, file: string, location: string, message: string) => void,
): void => {
  const steps: Record<string, any>[] = Array.isArray(document.content.mainSteps)
    ? document.content.mainSteps
    : [];
  const parameters: Record<string, any> =
    document.content.parameters && typeof document.content.parameters === 'object'
      ? document.content.parameters
      : {};

  const first = steps[0];
  if (first === undefined || first.action !== APPROVAL_ACTION) {
    add(
      'document-without-approval',
      document.file,
      document.name,
      `its first step is '${first?.action ?? '(none)'}' rather than '${APPROVAL_ACTION}'. This ` +
        'is the only automation here that deliberately breaks production, and the thing that ' +
        'makes that safe is that a human starts it — a document that begins with the fault can ' +
        'be started by a schedule, an EventBridge rule or a rollback that meant well.',
    );
  } else {
    const approvers = first.inputs?.Approvers;
    const declared = parameters.Approvers?.default;
    const empty =
      approvers === undefined ||
      (Array.isArray(declared) && declared.length === 0) ||
      (approvers === '{{ Approvers }}' && declared === undefined);
    if (empty) {
      add(
        'approval-without-approvers',
        document.file,
        document.name,
        'its approve step names nobody who can approve it. The document deploys cleanly, passes ' +
          'every other rule here, and fails at run time — during the exercise somebody put in ' +
          'the calendar.',
      );
    }
    if (first.inputs?.NotificationArn === undefined) {
      add(
        'approval-without-notification',
        document.file,
        document.name,
        'its approve step has no NotificationArn, so the approval request reaches nobody. The ' +
          'exercise starts, waits, and times out an hour later with no record of having asked.',
      );
    }
  }

  const assertsMultiAz = steps.some(
    (step) =>
      step.action === 'aws:assertAwsResourceProperty' &&
      step.inputs?.PropertySelector === MULTI_AZ_SELECTOR,
  );
  const failoverIndex = steps.findIndex(
    (step) => step.action === 'aws:executeAwsApi' && step.inputs?.Api === FAILOVER_API,
  );

  if (failoverIndex !== -1) {
    if (!assertsMultiAz) {
      add(
        'failover-without-multi-az-assert',
        document.file,
        document.name,
        `injects ${FAILOVER_API} without asserting ${MULTI_AZ_SELECTOR} first. On a Single-AZ ` +
          'instance that call is a reboot: the probe records an outage, the exercise reports a ' +
          'measured RTO, and the number describes a promotion that never happened — which is ' +
          'then quoted for a year.',
      );
    }
    if (steps[failoverIndex].inputs?.ForceFailover !== true) {
      add(
        'failover-without-force-failover',
        document.file,
        `${document.name}/${steps[failoverIndex].name ?? '(unnamed)'}`,
        `calls ${FAILOVER_API} without ForceFailover. That is a valid reboot of the primary, ` +
          'with an outage and no promotion, and the two are indistinguishable in everything ' +
          'except this flag.',
      );
    }

    const sleepIndex = steps.findIndex((step) => step.action === 'aws:sleep');
    const waitIndex = steps.findIndex(
      (step) =>
        step.action === 'aws:waitForAwsResourceProperty' &&
        step.inputs?.PropertySelector === STATUS_SELECTOR,
    );
    if (waitIndex !== -1 && (sleepIndex === -1 || waitIndex < sleepIndex)) {
      add(
        'wait-before-settle',
        document.file,
        document.name,
        'waits for DBInstanceStatus to be available before any settle period. For a few seconds ' +
          `after ${FAILOVER_API} returns the instance still reads 'available', so the wait is ` +
          'satisfied immediately and the measurement runs over a window in which nothing has ' +
          'happened yet — producing either no outage at all or a fraction of one.',
      );
    }
  }

  // Every step but the last has to route its failure somewhere, and that
  // somewhere has to be a step that exists. SSM's default is to end the
  // execution, which leaves an exercise that stopped and no record of it.
  const stepNames = new Set(steps.map((step) => step.name));
  const abortTargets = new Set<string>();
  for (const step of steps) {
    const onFailure = step.onFailure;
    if (typeof onFailure === 'string' && onFailure.startsWith('step:')) {
      abortTargets.add(onFailure.slice('step:'.length));
    }
  }

  for (const step of steps) {
    if (step.isEnd === true) continue;
    if (abortTargets.has(step.name)) continue;
    const onFailure = step.onFailure;
    if (typeof onFailure !== 'string' || !onFailure.startsWith('step:')) {
      add(
        'step-without-abort-path',
        document.file,
        `${document.name}/${step.name ?? '(unnamed)'}`,
        `has onFailure '${String(onFailure ?? '(unset)')}'. SSM ends the execution on a failed ` +
          'step, so this one failing leaves an exercise that stopped halfway and wrote nothing ' +
          'down — which cannot be told apart from an exercise nobody ran, and the refusals are ' +
          'the most useful output this mechanism has.',
      );
      continue;
    }
    if (!stepNames.has(onFailure.slice('step:'.length))) {
      add(
        'step-without-abort-path',
        document.file,
        `${document.name}/${step.name ?? '(unnamed)'}`,
        `routes failure to '${onFailure}', which is not a step in this document. SSM rejects ` +
          'that at registration, so the document does not deploy — but it reads correct in a ' +
          'diff and the first anybody hears of it is a failed stack update.',
      );
    }
  }

  if (abortTargets.size === 0) {
    add(
      'abort-step-missing',
      document.file,
      document.name,
      'no step is the destination of an onFailure, so nothing records an exercise that did not ' +
        'finish. Three aborted attempts in a row is a finding about the environment; three ' +
        'executions that vanished is not a finding about anything.',
    );
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

  const docPath = path.join(root, GAME_DAY_DOC_PATH);
  if (!fs.existsSync(docPath)) {
    console.error(
      `\n${GAME_DAY_DOC_PATH} does not exist. Every objective's anchor and every game-day alarm ` +
        'description points into it.\n',
    );
    process.exit(1);
  }

  const result = auditGameDays({
    templates,
    gameDayDoc: fs.readFileSync(docPath, 'utf8'),
  });

  if (result.documentsRead === 0) {
    console.error(
      `\nNo '*${DOCUMENT_NAME_INFIX}*' Automation documents in ${templates.length} template(s). ` +
        'Either FailoverGameDayStack was removed or its documents were renamed, and the second ' +
        'case leaves every exercise rule below unevaluated while this gate stays green.\n',
    );
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} game-day violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error('\nSee docs/game-days.md.\n');
    process.exit(1);
  }

  console.log(
    `${RECOVERY_OBJECTIVES.length} recovery objective(s) and ${GAME_DAY_SCENARIOS.length} ` +
      `scenario(s) across ${result.environmentsRead.join(', ')}: every objective is documented, ` +
      'every RPO of zero is on a synchronous path, every exercise starts from an approval and ' +
      `asserts Multi-AZ before forcing a failover (${result.documentsRead} document(s)), no step ` +
      'can end an exercise without a record, the probe samples inside its invocation at ' +
      `one-second resolution, and every freshness alarm breaches on missing data ` +
      `(${result.alarmsRead} alarm(s) read).`,
  );
}
