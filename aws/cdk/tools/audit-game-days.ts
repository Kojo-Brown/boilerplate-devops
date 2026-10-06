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
 *   An exercise nothing starts. The restore drill is the opposite case and it
 *   fails the opposite way: it runs without an approval precisely so that
 *   nobody has to remember it, so an `aws:approve` step in it is an execution
 *   that a schedule starts and that then waits forever for somebody who was
 *   never told — and a missing EventBridge rule is a drill that exists, is
 *   perfect, and never runs. Both read as working automation.
 *
 *   A drill that puts a copy of production on a public endpoint.
 *   `RestoreDBInstanceToPointInTime` takes `PubliclyAccessible` from the
 *   request and defaults it from the subnet group, so the flag being absent is
 *   not a smaller version of the same thing — it is a full copy of the
 *   database, reachable from the internet, once a month, deleted before anybody
 *   notices.
 *
 *   A copy nothing can delete. The teardown is one grant and one step, and
 *   without either the drill works exactly as well — it restores, it verifies,
 *   it measures, it reports — and leaves a full-size instance running. The same
 *   grant widened to `*` is a role that can delete any database in the account
 *   and reads identically in a diff.
 *
 *   A drill that can write to the instance it is supposed to only read. The
 *   whole safety argument for running this without an approval is that it
 *   touches nothing live, and that argument is an IAM policy rather than an
 *   intention.
 *
 *   A verification nobody can see. A drill whose only output is the execution's
 *   status cannot report "the copy came back and it is not the data": the
 *   execution has to end green so that the teardown runs. So the verdict is a
 *   metric with an alarm over it, and without that alarm the one finding this
 *   whole item exists to produce goes into a log.
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
 *   drill-document-with-approval    a scheduled drill that waits for a human
 *   drill-schedule-missing          a scheduled drill nothing schedules
 *   drill-schedule-interval-wrong   a cadence that disagrees with the catalogue
 *   drill-restore-not-point-in-time a drill that does not restore to a point
 *   drill-restore-publicly-accessible  a copy of production on a public endpoint
 *   drill-restore-deletion-protected   a copy the teardown cannot delete
 *   drill-verification-missing      a drill that checks nothing, or checks after
 *                                   it has already reported
 *   drill-teardown-missing          a drill that leaves the copy running
 *   drill-delete-not-scoped-to-the-copy  nothing can delete the copy, or
 *                                   something can delete every database
 *   drill-role-can-write-the-source the drill can change the instance it reads
 *   restore-unverified-not-alarmed  nothing reports a copy that came back wrong
 *   drill-orphan-not-alarmed        nothing reports a copy that outlived a drill
 *   drill-sweeper-missing           nothing removes a copy a cancelled execution
 *                                   left behind
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
  drillInstanceIdentifier,
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

/** The API a restore drill restores with, and the one it tears down with. */
export const RESTORE_API = 'RestoreDBInstanceToPointInTime';
export const DELETE_API = 'DeleteDBInstance';

/** Suffixes of the restore drill's three function names. */
export const VERIFIER_FUNCTION_SUFFIX = '-restore-drill-verifier';
export const CONDUCTOR_FUNCTION_SUFFIX = '-restore-drill-conductor';
export const SWEEPER_FUNCTION_SUFFIX = '-restore-drill-sweeper';

/** Alarm suffixes the restore drill is required to publish, per environment. */
export const RESTORE_UNVERIFIED_ALARM_SUFFIX = '-restore-unverified';
export const DRILL_ORPHAN_ALARM_SUFFIX = '-restore-drill-instance-orphaned';

/**
 * Non-read IAM actions the *drill's* automation role may hold.
 *
 * Three, and conspicuously without a delete. The teardown is the conductor's
 * and the sweeper's, each scoped to the one copy, because the role that an
 * EventBridge schedule can hand to SSM unattended is the last place in this
 * repository that should be able to delete a database.
 */
export const PERMITTED_DRILL_AUTOMATION_WRITES = [
  'rds:RestoreDBInstanceToPointInTime',
  'rds:AddTagsToResource',
  'lambda:InvokeFunction',
] as const;

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
  'drill-document-with-approval',
  'drill-schedule-missing',
  'drill-schedule-interval-wrong',
  'drill-restore-not-point-in-time',
  'drill-restore-publicly-accessible',
  'drill-restore-deletion-protected',
  'drill-verification-missing',
  'drill-teardown-missing',
  'drill-delete-not-scoped-to-the-copy',
  'drill-role-can-write-the-source',
  'restore-unverified-not-alarmed',
  'drill-orphan-not-alarmed',
  'drill-sweeper-missing',
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

/**
 * An ARN as text a rule can match on, intrinsics and all.
 *
 * Every ARN a CDK stack builds from `this.account` or `this.region`
 * synthesises as `Fn::Join` over a list containing a `Ref`, so a gate that
 * compares against plain strings sees only the hardcoded ARNs — which are the
 * ones least likely to be wrong. The parts are concatenated with each intrinsic
 * rendered as a placeholder, which leaves the literal tail (`:db:prod-dr-drill`)
 * exactly where a suffix match can find it.
 */
export const arnText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const entry = value as Record<string, unknown>;
  const join = entry['Fn::Join'];
  if (Array.isArray(join) && Array.isArray(join[1])) {
    return (join[1] as unknown[]).map((part) => arnText(part)).join(String(join[0] ?? ''));
  }
  if (typeof entry.Ref === 'string') return `\${${entry.Ref}}`;
  if (entry['Fn::GetAtt'] !== undefined) return '${GetAtt}';
  if (typeof entry['Fn::Sub'] === 'string') return entry['Fn::Sub'];
  return '';
};

interface ScheduleRecord {
  readonly file: string;
  readonly logicalId: string;
  readonly name: string | undefined;
  readonly scheduleExpression: string | undefined;
  readonly state: string | undefined;
  /** Target ARNs, as strings. A target built from `Fn::Join` is left out. */
  readonly targetArns: readonly string[];
}

/**
 * Every EventBridge rule in the templates, with its targets' ARNs.
 *
 * The drill's schedule points at an `automation-definition/<name>:$DEFAULT`
 * ARN, which {@link arnText} flattens out of the `Fn::Join` the account id puts
 * it in. A target this cannot read at all is dropped rather than guessed at, and
 * a drill whose schedule became unreadable fails `drill-schedule-missing` —
 * which is the right direction for a gate to fail in.
 */
const readSchedules = (templates: readonly TemplateFile[]): ScheduleRecord[] => {
  const schedules: ScheduleRecord[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::Events::Rule') continue;
      const properties = resource.Properties ?? {};
      schedules.push({
        file: template.path,
        logicalId,
        name: typeof properties.Name === 'string' ? properties.Name : undefined,
        scheduleExpression:
          typeof properties.ScheduleExpression === 'string'
            ? properties.ScheduleExpression
            : undefined,
        state: typeof properties.State === 'string' ? properties.State : undefined,
        targetArns: asList(properties.Targets)
          .filter((target): target is Record<string, unknown> => !!target && typeof target === 'object')
          .map((target) => arnText(target.Arn))
          .filter((arn) => arn.length > 0),
      });
    }
  }
  return schedules;
};

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
  const schedules = readSchedules(input.templates);

  // Environments are discovered from what synth wrote rather than passed in: a
  // gate told which environments to expect cannot report one that disappeared.
  const environments = [
    ...new Set([
      ...documents.map((document) => document.envName),
      ...functions
        .filter((fn) => fn.name.endsWith(PROBE_FUNCTION_SUFFIX))
        .map((fn) => fn.name.slice(0, -PROBE_FUNCTION_SUFFIX.length)),
      ...functions
        .filter((fn) => fn.name.endsWith(VERIFIER_FUNCTION_SUFFIX))
        .map((fn) => fn.name.slice(0, -VERIFIER_FUNCTION_SUFFIX.length)),
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

    auditDocument(document, scenario, add);
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

  // ── The drill ──────────────────────────────────────────────────────────────
  // Everything above is about an exercise a human starts. This is about the one
  // that nothing has to start, which is a different set of ways to be silently
  // broken: a schedule that is not there, a copy that is public, a copy nothing
  // deletes, and a verdict that only ever reaches a log.
  const drillScenarios = scenarios.filter(
    (scenario) => scenario.fault === 'rds-point-in-time-restore',
  );

  for (const scenario of drillScenarios) {
    for (const envName of scenario.allowedEnvironments) {
      if (!environments.includes(envName)) continue;
      const documentName = gameDayDocumentName(envName, scenario.id);
      // A missing document is `scenario-document-missing` above; here the
      // subject is whether anything starts the one that exists.
      if (!documents.some((document) => document.name === documentName)) continue;

      const targeting = schedules.filter((schedule) =>
        schedule.targetArns.some((arn) => arn.includes(`automation-definition/${documentName}`)),
      );
      if (scenario.trigger !== 'schedule') {
        // Not a rule of its own: `destructive-scenario-scheduled` in the
        // catalogue covers the dangerous direction, and an approval-triggered
        // exercise with a schedule attached is caught there too.
        continue;
      }
      if (targeting.length === 0) {
        add(
          'drill-schedule-missing',
          'lib/backup-restore-drill-stack.ts',
          documentName,
          `'${scenario.id}' has trigger 'schedule' and no EventBridge rule targets it. The ` +
            'drill then exists, deploys, passes every other rule here, and never runs — and the ' +
            'only thing that reports it is the overdue alarm, months later, with nothing to ' +
            'explain why nobody ran the drill that nobody was supposed to have to run.',
        );
      }
      for (const schedule of targeting) {
        const expected = `rate(${scenario.scheduleIntervalDays} days)`;
        if (schedule.scheduleExpression !== expected) {
          add(
            'drill-schedule-interval-wrong',
            schedule.file,
            schedule.name ?? schedule.logicalId,
            `its schedule is '${schedule.scheduleExpression ?? '(unset)'}', expected ` +
              `'${expected}' — the catalogue's scheduleIntervalDays. The cadence and the ` +
              "objective's shelf life are checked against each other in lib/game-days.ts, so a " +
              'rule that disagrees with the catalogue is an overdue alarm that is red on a ' +
              'cycle nobody chose.',
          );
        }
        if (schedule.state !== 'ENABLED') {
          add(
            'drill-schedule-missing',
            schedule.file,
            schedule.name ?? schedule.logicalId,
            `its State is '${schedule.state ?? '(unset)'}'. A disabled rule is the same outcome ` +
              'as a missing one and is harder to see: the rule is in the console, with the right ' +
              'target and the right cadence, and nothing fires.',
          );
        }
      }
    }
  }

  for (const envName of environments) {
    const drillsHere = drillScenarios.filter((scenario) =>
      scenario.allowedEnvironments.includes(envName),
    );
    if (drillsHere.length === 0) continue;

    const requiredAlarms: readonly (readonly [GameDayAuditRule, string, string])[] = [
      [
        'restore-unverified-not-alarmed',
        RESTORE_UNVERIFIED_ALARM_SUFFIX,
        'A drill that restores a copy and finds it unusable has to end green so that the ' +
          'teardown runs, so the execution status cannot be the signal. Without this alarm the ' +
          'one finding this whole item exists to produce — the backups returned something that ' +
          'is not the data — reaches a CloudWatch log and nothing else.',
      ],
      [
        'drill-orphan-not-alarmed',
        DRILL_ORPHAN_ALARM_SUFFIX,
        'SSM does not run a step\'s onFailure for a *cancelled* execution, so a human stopping ' +
          'a drill between the restore and the teardown leaves a full-size copy of production ' +
          'running. Nothing else goes red: it serves no traffic, breaches no threshold, and ' +
          'looks exactly like a database somebody meant to create.',
      ],
    ];
    for (const [rule, suffix, why] of requiredAlarms) {
      const expected = `${envName}${suffix}`;
      if (!alarms.some((alarm) => alarm.name === expected)) {
        add(rule, 'lib/backup-restore-drill-stack.ts', expected, `no alarm named '${expected}'. ${why}`);
      }
    }

    const orphanAlarm = alarms.find(
      (alarm) => alarm.name === `${envName}${DRILL_ORPHAN_ALARM_SUFFIX}`,
    );
    if (orphanAlarm !== undefined && orphanAlarm.treatMissingData !== 'breaching') {
      add(
        'freshness-alarm-not-breaching',
        orphanAlarm.file,
        orphanAlarm.name,
        `TreatMissingData is '${orphanAlarm.treatMissingData ?? 'unset'}'. The sweeper publishes ` +
          'zero when there is no copy, precisely so that missing data means the sweeper has ' +
          'stopped — and a sweeper that has stopped is the state in which an orphaned copy of ' +
          'production runs indefinitely with nothing watching it.',
      );
    }

    const sweeper = `${envName}${SWEEPER_FUNCTION_SUFFIX}`;
    if (!functions.some((fn) => fn.name === sweeper)) {
      add(
        'drill-sweeper-missing',
        'lib/backup-restore-drill-stack.ts',
        sweeper,
        `no function named '${sweeper}'. The alarm above reports an abandoned copy and nothing ` +
          'removes it, so the copy runs until a human reads the alert — which is the one failure ' +
          'in this item that costs money for as long as it goes unnoticed.',
      );
    }
  }

  // ── The drill's grants ─────────────────────────────────────────────────────
  // The safety argument for running an exercise unattended is that it cannot
  // touch anything live, and that argument is an IAM policy rather than an
  // intention. Scoped to the drill stack's own templates: every other role in
  // this repository is covered by `audit-iam-least-privilege.ts`.
  const drillStatements = statements.filter((statement) =>
    statement.file.includes('BackupRestoreDrill'),
  );

  // One pass over the grants rather than one per environment: a statement in
  // the staging template scoped to staging's copy is correct, and an
  // environment loop around this reported every grant as wrong for every other
  // environment.
  const deleteGrants = drillStatements.filter((statement) =>
    statement.actions.includes(`rds:${DELETE_API}`),
  );
  const COPY_ARN = /:db:[a-z0-9-]+-dr-drill$/;
  for (const statement of deleteGrants) {
    const unscoped = statement.resources
      .map((resource) => arnText(resource))
      .filter((resource) => !COPY_ARN.test(resource));
    if (unscoped.length === 0) continue;
    add(
      'drill-delete-not-scoped-to-the-copy',
      statement.file,
      `${statement.logicalId}/rds:${DELETE_API}`,
      `is granted on ${unscoped.map((resource) => JSON.stringify(resource)).join(', ')}, which ` +
        "is not the drill's own copy. A delete on '*' is a grant to destroy every database in " +
        'the account, held here by a function an hourly schedule invokes, and it reads in a diff ' +
        'exactly like the scoped one.',
    );
  }

  for (const envName of environments) {
    if (!drillScenarios.some((scenario) => scenario.allowedEnvironments.includes(envName))) {
      continue;
    }
    const copyArn = `:db:${drillInstanceIdentifier(envName)}`;
    const canDelete = deleteGrants.some((statement) =>
      statement.resources.some((resource) => arnText(resource).endsWith(copyArn)),
    );
    if (!canDelete) {
      add(
        'drill-delete-not-scoped-to-the-copy',
        'lib/backup-restore-drill-stack.ts',
        `${envName}${copyArn}`,
        `nothing holds rds:${DELETE_API} on '${copyArn}'. The drill restores, verifies, ` +
          'measures and reports exactly as well without it, and leaves a full-size copy of ' +
          'production running every time it runs.',
      );
    }
  }

  for (const statement of drillStatements) {
    const writes = statement.actions.filter((action) => {
      const verb = action.split(':')[1] ?? '';
      return !READ_ONLY_PREFIXES.some((prefix) => verb.startsWith(prefix));
    });
    if (writes.length === 0) continue;

    // A write naming the source instance. Only the restore may, and the restore
    // has to, because the API authorises against the instance it reads as well
    // as the one it creates.
    for (const raw of statement.resources) {
      const resource = arnText(raw);
      if (!/:db:/.test(resource)) continue;
      if (COPY_ARN.test(resource)) continue;
      const offending = writes.filter((action) => action !== `rds:${RESTORE_API}`);
      if (offending.length === 0) continue;
      add(
        'drill-role-can-write-the-source',
        statement.file,
        `${statement.logicalId}/${offending.join(',')}`,
        `is granted on '${resource}', which is not the drill's copy. The reason this exercise ` +
          'is allowed to run without an approval is that it cannot change anything live, and ' +
          `the only write it needs against another instance is rds:${RESTORE_API} — which reads ` +
          'the source and creates the copy.',
      );
    }

    // And the automation role itself, which is the identity an EventBridge
    // schedule hands to SSM with nobody watching.
    if (!(statement.roleName ?? '').includes('RestoreDrillAutomationRole')) continue;
    for (const action of writes) {
      if ((PERMITTED_DRILL_AUTOMATION_WRITES as readonly string[]).includes(action)) continue;
      add(
        'drill-role-can-write-the-source',
        statement.file,
        `${statement.logicalId}/${action}`,
        `is a write the drill's automation role does not need. It is the identity a schedule ` +
          'hands to SSM unattended, and the three things it is for are ' +
          `${PERMITTED_DRILL_AUTOMATION_WRITES.join(', ')} — deliberately without a delete, ` +
          'which belongs to the conductor and the sweeper and is scoped to the one copy.',
      );
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
  scenario: GameDayScenario,
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
  const approvalStep = steps.find((step) => step.action === APPROVAL_ACTION);

  // The two triggers fail in opposite directions, so the rule is about the
  // trigger rather than about the action. An approved exercise without an
  // approval step is an outage a schedule can start; a scheduled drill *with*
  // one is an execution that starts on a timer and then waits for somebody
  // nobody told, until it times out an hour later — every month, green-ish, in
  // a console nobody opens.
  if (scenario.trigger === 'schedule') {
    if (approvalStep !== undefined) {
      add(
        'drill-document-with-approval',
        document.file,
        `${document.name}/${approvalStep.name ?? '(unnamed)'}`,
        `has an '${APPROVAL_ACTION}' step and its scenario's trigger is 'schedule'. Nothing ` +
          'tells a human that a scheduled execution is waiting for them, so this is a drill ' +
          'that starts on time, asks a question into an empty room, and times out — which is ' +
          'indistinguishable from a drill nobody runs, and it is the state this exercise exists ' +
          'to get out of.',
      );
    }
  } else if (first === undefined || first.action !== APPROVAL_ACTION) {
    add(
      'document-without-approval',
      document.file,
      document.name,
      `its first step is '${first?.action ?? '(none)'}' rather than '${APPROVAL_ACTION}', and ` +
        `its scenario's trigger is '${scenario.trigger}'. A destructive exercise is safe ` +
        'because a human starts it — a document that begins with the fault can be started by a ' +
        'schedule, an EventBridge rule or a rollback that meant well.',
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

  if (scenario.fault === 'rds-point-in-time-restore') {
    auditRestoreDrillDocument(document, steps, add);
  }
};

/** Does any step invoke a function whose name ends with this suffix? */
const invokesFunction = (steps: readonly Record<string, any>[], suffix: string): number =>
  steps.findIndex(
    (step) =>
      step.action === 'aws:invokeLambdaFunction' &&
      typeof step.inputs?.FunctionName === 'string' &&
      step.inputs.FunctionName.endsWith(suffix),
  );

/**
 * The restore drill's own steps.
 *
 * Every rule in here is about a property of the restore call or the shape of the
 * procedure, and every one of them leaves a drill that works: it restores, it
 * waits, it reports, and the thing that is wrong is a copy of production on a
 * public endpoint, or a copy nothing deletes, or a verdict reached after it was
 * already published.
 */
export const auditRestoreDrillDocument = (
  document: DocumentRecord,
  steps: readonly Record<string, any>[],
  add: (rule: GameDayAuditRule, file: string, location: string, message: string) => void,
): void => {
  const restoreIndex = steps.findIndex(
    (step) => step.action === 'aws:executeAwsApi' && step.inputs?.Api === RESTORE_API,
  );
  if (restoreIndex === -1) {
    add(
      'drill-restore-not-point-in-time',
      document.file,
      document.name,
      `no step calls ${RESTORE_API}. Whatever this document restores from, it is not the ` +
        'automated backups at a point in time — a snapshot restore answers a different question ' +
        'and answers it about a moment somebody chose by hand.',
    );
  } else {
    const inputs = steps[restoreIndex].inputs ?? {};
    const location = `${document.name}/${steps[restoreIndex].name ?? '(unnamed)'}`;

    if (inputs.UseLatestRestorableTime !== true && inputs.RestoreTime === undefined) {
      add(
        'drill-restore-not-point-in-time',
        document.file,
        location,
        `calls ${RESTORE_API} with neither UseLatestRestorableTime nor RestoreTime. The API ` +
          'needs one of them, so this fails at run time — which is loud, and is also a drill ' +
          'that has never once run in an account where nobody watched the first execution.',
      );
    }
    if (inputs.PubliclyAccessible !== false) {
      add(
        'drill-restore-publicly-accessible',
        document.file,
        location,
        `PubliclyAccessible is ${JSON.stringify(inputs.PubliclyAccessible ?? null)}, not false. ` +
          `${RESTORE_API} does not copy this from the source — it takes it from the request and ` +
          'defaults it from the subnet group — so an absent flag is not a smaller version of ' +
          'the same thing. It is a full copy of the database on a public endpoint, once a ' +
          'month, deleted again before anybody notices.',
      );
    }
    if (inputs.DeletionProtection !== false) {
      add(
        'drill-restore-deletion-protected',
        document.file,
        location,
        `DeletionProtection is ${JSON.stringify(inputs.DeletionProtection ?? null)}, not false. ` +
          'The teardown then fails on every drill, the copy survives, and the only way to clear ' +
          'it is a console visit — on an instance that is a full-size copy of production and ' +
          'that nothing else in this repository is watching.',
      );
    }
    if (inputs.MultiAZ !== false) {
      // Not its own rule: a Multi-AZ copy is correct, merely twice the price,
      // and a cost decision is not a silent failure. Reported under the
      // publicly-accessible rule's neighbour so that it is visible rather than
      // enforced.
      add(
        'drill-restore-deletion-protected',
        document.file,
        location,
        `MultiAZ is ${JSON.stringify(inputs.MultiAZ ?? null)}, not false. A standby adds ` +
          'nothing to a copy that is deleted within the hour and doubles what the drill costs; ' +
          'a real recovery would enable Multi-AZ after the cutover rather than waiting for it ' +
          'during the outage.',
      );
    }
  }

  const verifyIndex = invokesFunction(steps, VERIFIER_FUNCTION_SUFFIX);
  if (verifyIndex === -1) {
    add(
      'drill-verification-missing',
      document.file,
      document.name,
      `no step invokes a '*${VERIFIER_FUNCTION_SUFFIX}' function. The drill then reports that ` +
        'the restore completed, which is what `DBInstanceStatus: available` already said — and ' +
        'an instance restored from a backup of an empty volume reports exactly that.',
    );
  } else if (restoreIndex !== -1 && verifyIndex < restoreIndex) {
    add(
      'drill-verification-missing',
      document.file,
      document.name,
      'the verification runs before the restore, so it is checking last month\'s copy or ' +
        'nothing at all. Both pass more often than the real check does.',
    );
  }

  const measureIndex = steps.findIndex(
    (step) =>
      step.action === 'aws:invokeLambdaFunction' &&
      step.inputs?.InputPayload?.operation === 'measure',
  );
  if (verifyIndex !== -1 && measureIndex !== -1 && measureIndex < verifyIndex) {
    add(
      'drill-verification-missing',
      document.file,
      document.name,
      'the measurement runs before the verification, so the restore time is recorded and the ' +
        'rehearsal clock reset before anybody has established that the copy is the data. A ' +
        'drill that cannot refuse to reset its own clock is a drill that always looks rehearsed.',
    );
  }

  const teardownIndex = steps.findIndex(
    (step) =>
      step.action === 'aws:invokeLambdaFunction' &&
      step.inputs?.InputPayload?.operation === 'teardown',
  );
  if (teardownIndex === -1) {
    add(
      'drill-teardown-missing',
      document.file,
      document.name,
      "no step invokes the conductor with operation 'teardown'. The drill works perfectly " +
        'without it — restores, verifies, measures, reports — and leaves a full-size copy of ' +
        'production running after every run.',
    );
  } else if (measureIndex !== -1 && teardownIndex < measureIndex) {
    add(
      'drill-teardown-missing',
      document.file,
      document.name,
      'the teardown runs before the measurement, which reads the copy\'s InstanceCreateTime. ' +
        'The measurement then fails on an instance that is being deleted, and the drill reports ' +
        'an abort for a restore that worked.',
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
      'every RPO of zero is on a synchronous path, every destructive exercise starts from an ' +
      'approval and asserts Multi-AZ before forcing a failover while every restore drill starts ' +
      `from a schedule on its objective's own cadence (${result.documentsRead} document(s)), no ` +
      'step can end an exercise without a record, every drill restores a private copy it can ' +
      'delete and verifies it before it measures it, the probe samples inside its invocation at ' +
      'one-second resolution, and every freshness alarm breaches on missing data ' +
      `(${result.alarmsRead} alarm(s) read).`,
  );
}
