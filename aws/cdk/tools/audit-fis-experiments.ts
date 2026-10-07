#!/usr/bin/env node
/**
 * Audit the chaos experiment templates against the synthesised CloudFormation,
 * and the stacks they depend on without owning.
 *
 * `lib/fis-experiments.ts` validates everything that is arithmetic over the
 * catalogue, and `ChaosFisStack` fails `cdk synth` on any of it. This gate is
 * for the half neither can reach: the properties that live in *other stacks*,
 * where every combination deploys cleanly and the only thing that fails is the
 * experiment, when somebody starts it.
 *
 * That seam is the reason this file exists rather than more rules in the
 * catalogue:
 *
 *   • **The latency action's three prerequisites.** `aws:ecs:task-network-latency`
 *     needs `useEcsFaultInjectionEndpoints` on the action, and `PidMode: task`
 *     plus `EnableFaultInjection: true` on the task definition of the tasks it
 *     targets. One of those is in `ChaosFisStack`; the other two are in
 *     `EcsStack`, which belongs to a different item and has its own tests, none
 *     of which know this experiment exists. Removing either one is a one-line
 *     diff to a task definition that looks like tidying up — the service stays
 *     healthy, the experiment template still synthesises, FIS still resolves the
 *     tasks, and the failure arrives mid-exercise.
 *
 *   • **The AZ experiment's dependence on the VPC's NAT layout.** `VpcStack`
 *     takes `natGateways`, defaulting to one per AZ but documented as "1
 *     (cost-optimised)". With a single NAT gateway, every private subnet in the
 *     VPC egresses through whichever AZ holds it — so partitioning *that* AZ is
 *     not an AZ fault, it is a total loss of outbound connectivity for the whole
 *     application, including from the AZ that was supposed to survive and serve.
 *     The experiment then "fails", the write-up records that the application does
 *     not tolerate losing an AZ, and the finding is about the NAT layout rather
 *     than about anything the experiment was asking.
 *
 *   • **The stop conditions' real periods.** The catalogue declares what it
 *     believes each guardrail's detection window is and refuses an experiment
 *     shorter than twice it. Those numbers are a copy of properties
 *     `CloudWatchAlarmsStack` and `FailoverGameDayStack` own: `periodMinutes`
 *     and `evaluationPeriods` are props with defaults, and raising either one
 *     widens the window with no diff here at all. The arithmetic stays correct
 *     and starts being about an alarm that no longer exists.
 *
 *   • **A template with no guardrail at all.** FIS accepts
 *     `StopConditions: [{ Source: 'none' }]`, which is what AWS's own
 *     CloudFormation sample ships. The catalogue cannot see a template somebody
 *     adds outside it; the synthesised output can.
 *
 * The rules, and the failure each one prevents:
 *
 *   catalogue                    any finding from `validateChaosCatalogue`
 *   experiment-template-missing   an experiment in the catalogue that no stack
 *                                 synthesised for an environment that allows it
 *   stop-condition-none           a template whose guardrail is FIS's "none"
 *   stop-condition-not-an-alarm   a stop condition that is neither
 *   experiment-without-logs       no `LogConfiguration`, so no record of which
 *                                 targets resolved
 *   log-schema-version-wrong      a logging block FIS will not accept
 *   action-target-key-wrong       an action pointing at its target under a key
 *                                 that action does not define
 *   target-selection-widened      a template whose `SelectionMode` is not the
 *                                 one the catalogue's blast-radius rules passed
 *   az-target-spans-azs           an AZ experiment whose subnets are not all in
 *                                 one AZ, which is a partition of the VPC
 *   az-target-partial-az          an AZ experiment that leaves a subnet group in
 *                                 the target AZ connected
 *   latency-endpoints-unset       the action parameter the latency fault needs
 *   task-definition-pid-mode      `PidMode` missing from the targeted task
 *                                 definition
 *   task-definition-fault-injection  `EnableFaultInjection` missing from it
 *   single-nat-gateway            an AZ experiment over a VPC with one NAT
 *                                 gateway, which makes it a region-wide egress
 *                                 outage wearing an AZ experiment's name
 *   stop-condition-alarm-missing  a declared guardrail no stack creates
 *   stop-condition-window-drift   the alarm's real detection window is not what
 *                                 the catalogue did its arithmetic against
 *   experiment-anchor-missing     a template pointing at a doc section that is
 *                                 not there
 *   audit-not-run-in-ci           this gate is not wired into a job
 *
 * See docs/chaos-engineering.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  type ChaosExperiment,
  CHAOS_EXPERIMENTS,
  FIS_ACTIONS,
  LOG_SCHEMA_VERSION,
  STOP_CONDITION_SOURCE_ALARM,
  STOP_CONDITION_SOURCE_NONE,
  detectionWindowSeconds,
  experimentTemplateName,
  validateChaosCatalogue,
} from '../lib/fis-experiments';

export const CHAOS_DOC_PATH = path.join('docs', 'chaos-engineering.md');
export const CI_WORKFLOW_PATH = path.join('.github', 'workflows', 'ci.yml');
/** The npm script the CI job must run. */
export const AUDIT_SCRIPT = 'audit:chaos';

export const CHAOS_AUDIT_RULES = [
  'catalogue',
  'experiment-template-missing',
  'stop-condition-none',
  'stop-condition-not-an-alarm',
  'experiment-without-logs',
  'log-schema-version-wrong',
  'action-target-key-wrong',
  'target-selection-widened',
  'az-target-spans-azs',
  'az-target-partial-az',
  'latency-endpoints-unset',
  'task-definition-pid-mode',
  'task-definition-fault-injection',
  'single-nat-gateway',
  'stop-condition-alarm-missing',
  'stop-condition-window-drift',
  'experiment-anchor-missing',
  'audit-not-run-in-ci',
] as const;

export type ChaosAuditRule = (typeof CHAOS_AUDIT_RULES)[number];

export interface Violation {
  readonly rule: ChaosAuditRule;
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
  /** Contents of {@link CHAOS_DOC_PATH}. */
  readonly chaosDoc: string;
  /** Contents of {@link CI_WORKFLOW_PATH}. Omitted in unit tests that do not need it. */
  readonly ciWorkflow?: string;
  readonly experiments?: readonly ChaosExperiment[];
}

export interface AuditResult {
  readonly violations: readonly Violation[];
  readonly templatesRead: number;
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

/** An FIS experiment template as synth wrote it, plus what the tags say it is. */
interface ExperimentRecord {
  readonly file: string;
  readonly logicalId: string;
  readonly name: string;
  readonly envName: string;
  readonly experimentId: string;
  readonly properties: Record<string, any>;
}

const tagValue = (properties: Record<string, any>, key: string): string | undefined => {
  const tags = properties.Tags;
  // FIS carries tags as a map rather than the list-of-pairs most types use.
  if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
    const value = (tags as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
};

const readExperiments = (templates: readonly TemplateFile[]): ExperimentRecord[] => {
  const records: ExperimentRecord[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::FIS::ExperimentTemplate') continue;
      const properties = resource.Properties ?? {};
      records.push({
        file: template.path,
        logicalId,
        name: tagValue(properties, 'Name') ?? logicalId,
        envName: tagValue(properties, 'Environment') ?? '',
        experimentId: tagValue(properties, 'Experiment') ?? '',
        properties,
      });
    }
  }
  return records;
};

/** Alarms by `AlarmName`, with the two properties the arithmetic depends on. */
interface AlarmRecord {
  readonly file: string;
  readonly alarmName: string;
  readonly periodSeconds?: number;
  readonly evaluationPeriods?: number;
}

const readAlarms = (templates: readonly TemplateFile[]): AlarmRecord[] => {
  const alarms: AlarmRecord[] = [];
  for (const template of templates) {
    for (const resource of Object.values(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::CloudWatch::Alarm') continue;
      const properties = resource.Properties ?? {};
      if (typeof properties.AlarmName !== 'string') continue;
      alarms.push({
        file: template.path,
        alarmName: properties.AlarmName,
        // A metric-math alarm carries its period inside `Metrics` instead. None
        // of the alarms this gate reads is one, and an alarm whose period it
        // cannot find is reported rather than skipped — see
        // `stop-condition-window-drift`.
        periodSeconds: typeof properties.Period === 'number' ? properties.Period : undefined,
        evaluationPeriods:
          typeof properties.EvaluationPeriods === 'number'
            ? properties.EvaluationPeriods
            : undefined,
      });
    }
  }
  return alarms;
};

/** Task definitions by family, with the two properties the latency fault needs. */
interface TaskDefinitionRecord {
  readonly file: string;
  readonly logicalId: string;
  readonly family?: string;
  readonly pidMode?: string;
  readonly enableFaultInjection?: boolean;
}

const readTaskDefinitions = (templates: readonly TemplateFile[]): TaskDefinitionRecord[] => {
  const definitions: TaskDefinitionRecord[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::ECS::TaskDefinition') continue;
      const properties = resource.Properties ?? {};
      definitions.push({
        file: template.path,
        logicalId,
        family: typeof properties.Family === 'string' ? properties.Family : undefined,
        pidMode: typeof properties.PidMode === 'string' ? properties.PidMode : undefined,
        enableFaultInjection:
          typeof properties.EnableFaultInjection === 'boolean'
            ? properties.EnableFaultInjection
            : undefined,
      });
    }
  }
  return definitions;
};

/**
 * NAT gateways per environment, read from the VPC templates.
 *
 * Keyed on the environment the template name carries — `VpcStack-Staging` — and
 * counted rather than inspected, because the only question is whether there are
 * as many as there are AZs.
 */
interface VpcRecord {
  readonly file: string;
  readonly envName: string;
  readonly natGateways: number;
  readonly subnets: number;
  /** Subnet logical ids grouped by the AZ expression they carry, stringified. */
  readonly subnetsByAz: Map<string, string[]>;
}

const environmentFromStackFile = (file: string): string => {
  const match = /-(Staging|Production)\.template\.json$/.exec(file);
  return match ? match[1].toLowerCase() : '';
};

const readVpcs = (templates: readonly TemplateFile[]): VpcRecord[] => {
  const vpcs: VpcRecord[] = [];
  for (const template of templates) {
    if (!/^VpcStack-/.test(template.path)) continue;
    const resources = resourcesOf(template.document);
    let natGateways = 0;
    let subnets = 0;
    const subnetsByAz = new Map<string, string[]>();
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type === 'AWS::EC2::NatGateway') natGateways += 1;
      if (resource.Type === 'AWS::EC2::Subnet') {
        subnets += 1;
        const az = JSON.stringify(resource.Properties?.AvailabilityZone ?? null);
        subnetsByAz.set(az, [...(subnetsByAz.get(az) ?? []), logicalId]);
      }
    }
    vpcs.push({
      file: template.path,
      envName: environmentFromStackFile(template.path),
      natGateways,
      subnets,
      subnetsByAz,
    });
  }
  return vpcs;
};

/* ── The audit ────────────────────────────────────────────────────────────── */

export const auditFisExperiments = (input: AuditInput): AuditResult => {
  const violations: Violation[] = [];
  const report = (
    rule: ChaosAuditRule,
    file: string,
    location: string,
    message: string,
  ): void => {
    violations.push({ rule, file, location, message });
  };

  const catalogue = input.experiments ?? CHAOS_EXPERIMENTS;

  // Everything the catalogue can decide on its own, surfaced through this gate
  // too. `ChaosFisStack` already throws on it, so a finding here means somebody
  // read the templates from a tree where synth had not been re-run — which is
  // worth saying out loud rather than passing.
  for (const finding of validateChaosCatalogue(catalogue)) {
    report('catalogue', 'lib/fis-experiments.ts', finding.subject, `[${finding.rule}] ${finding.message}`);
  }

  const experiments = readExperiments(input.templates);
  const alarms = new Map(readAlarms(input.templates).map((alarm) => [alarm.alarmName, alarm]));
  const taskDefinitions = readTaskDefinitions(input.templates);
  const vpcs = new Map(readVpcs(input.templates).map((vpc) => [vpc.envName, vpc]));
  const environmentsRead = [...new Set(experiments.map((e) => e.envName).filter((e) => e !== ''))];

  // ── Coverage: every catalogue entry exists where it says it does ───────────

  for (const experiment of catalogue) {
    for (const envName of experiment.allowedEnvironments) {
      // Only hold an environment to it if that environment's templates are in
      // front of us. A filtered read — `npm run audit:chaos . ChaosFisStack` —
      // must not report production missing.
      if (environmentsRead.length > 0 && !environmentsRead.includes(envName)) continue;
      const expected = experimentTemplateName(envName, experiment.id);
      if (!experiments.some((record) => record.name === expected)) {
        report(
          'experiment-template-missing',
          CHAOS_DOC_PATH,
          expected,
          `the catalogue allows '${experiment.id}' in ${envName} and no template of that name ` +
            'was synthesised. An experiment that exists only in the catalogue reads on a ' +
            'dashboard, and in docs/chaos-engineering.md, exactly like one that can be started.',
        );
      }
    }
  }

  // ── Per-template rules ────────────────────────────────────────────────────

  for (const record of experiments) {
    const declared = catalogue.find((experiment) => experiment.id === record.experimentId);
    const properties = record.properties;

    /* ── Guardrails ─────────────────────────────────────────────────────── */

    const stopConditions: any[] = Array.isArray(properties.StopConditions)
      ? properties.StopConditions
      : [];

    if (stopConditions.some((condition) => condition?.Source === STOP_CONDITION_SOURCE_NONE)) {
      report(
        'stop-condition-none',
        record.file,
        record.name,
        "a stop condition is FIS's 'none', so the fault runs its full declared duration whatever " +
          "happens to the application. It is what every tutorial ships — AWS's own " +
          'CloudFormation sample for aws:network:disrupt-connectivity included — and it reads in ' +
          'review as "not configured yet".',
      );
    }

    for (const condition of stopConditions) {
      if (
        condition?.Source !== STOP_CONDITION_SOURCE_NONE &&
        condition?.Source !== STOP_CONDITION_SOURCE_ALARM
      ) {
        report(
          'stop-condition-not-an-alarm',
          record.file,
          record.name,
          `a stop condition's source is '${String(condition?.Source)}'. FIS accepts only ` +
            `'${STOP_CONDITION_SOURCE_ALARM}' and '${STOP_CONDITION_SOURCE_NONE}'.`,
        );
      }
    }

    if (stopConditions.length === 0) {
      report(
        'stop-condition-none',
        record.file,
        record.name,
        'no stop conditions at all. The fault runs to completion whatever happens.',
      );
    }

    /* ── The record ─────────────────────────────────────────────────────── */

    const logConfiguration = properties.LogConfiguration;
    if (logConfiguration === undefined || logConfiguration === null) {
      report(
        'experiment-without-logs',
        record.file,
        record.name,
        'no LogConfiguration. FIS does not require one and an experiment without it runs ' +
          'identically — what is lost is which targets resolved, which is the difference between ' +
          '"a task was stopped" and "the task in the first AZ was stopped and its replacement ' +
          'landed in the second", and only one of those is a conclusion about the AZ layout.',
      );
    } else if (logConfiguration.LogSchemaVersion !== LOG_SCHEMA_VERSION) {
      report(
        'log-schema-version-wrong',
        record.file,
        record.name,
        `LogSchemaVersion is ${String(logConfiguration.LogSchemaVersion)}, not ` +
          `${LOG_SCHEMA_VERSION}. FIS rejects the template, which is the loud failure; it is here ` +
          'because the field is easy to drop when the logging block is edited.',
      );
    }

    /* ── Action and target wiring ───────────────────────────────────────── */

    const actions: Record<string, any> =
      properties.Actions && typeof properties.Actions === 'object' ? properties.Actions : {};
    const targets: Record<string, any> =
      properties.Targets && typeof properties.Targets === 'object' ? properties.Targets : {};

    for (const [actionName, action] of Object.entries(actions)) {
      const known = Object.values(FIS_ACTIONS).find((entry) => entry.actionId === action?.ActionId);
      if (known === undefined) continue;

      const actionTargets: Record<string, string> =
        action?.Targets && typeof action.Targets === 'object' ? action.Targets : {};
      const keys = Object.keys(actionTargets);
      if (!keys.includes(known.targetKey)) {
        report(
          'action-target-key-wrong',
          record.file,
          `${record.name}/${actionName}`,
          `'${known.actionId}' points at its target under ${keys.map((k) => `'${k}'`).join(', ') || '(nothing)'} ` +
            `rather than '${known.targetKey}'. The key is decided by the action, not by the ` +
            'author, and the way this goes wrong is a template copied from an example for a ' +
            'different resource type and then edited until it deploys.',
        );
      }

      if (known.actionId === FIS_ACTIONS['ecs-task-network-latency'].actionId) {
        const parameters: Record<string, unknown> =
          action?.Parameters && typeof action.Parameters === 'object' ? action.Parameters : {};
        if (String(parameters.useEcsFaultInjectionEndpoints) !== 'true') {
          report(
            'latency-endpoints-unset',
            record.file,
            `${record.name}/${actionName}`,
            "useEcsFaultInjectionEndpoints is not 'true'. On Fargate the action cannot run " +
              'without it, and nothing about the template says so: it is accepted, the targets ' +
              'resolve, and the experiment fails when somebody starts it.',
          );
        }
      }
    }

    /* ── Blast radius, as the template actually states it ───────────────── */

    if (declared !== undefined) {
      for (const [targetName, target] of Object.entries(targets)) {
        const action = FIS_ACTIONS[declared.action];

        if (action.resourceType === 'aws:ecs:task') {
          if (target?.SelectionMode !== declared.selectionMode) {
            report(
              'target-selection-widened',
              record.file,
              `${record.name}/${targetName}`,
              `SelectionMode is '${String(target?.SelectionMode)}' and the catalogue's ` +
                `blast-radius rules passed '${declared.selectionMode}'. Those rules are what ` +
                'establish that the fault leaves a survivor and that it resolves at least one ' +
                'target; a template that does not carry the selection they checked has not been ' +
                'checked.',
            );
          }
          continue;
        }

        // The AZ experiment. Its selection mode is `ALL` of an explicitly listed
        // set of subnets, so what has to be verified is the *set*.
        const arns: unknown[] = Array.isArray(target?.ResourceArns) ? target.ResourceArns : [];
        const vpc = vpcs.get(record.envName);

        if (vpc !== undefined) {
          const azGroups = [...vpc.subnetsByAz.entries()];
          const sizes = azGroups.map(([, ids]) => ids.length);
          const largestAz = sizes.length > 0 ? Math.max(...sizes) : 0;

          if (arns.length > largestAz) {
            report(
              'az-target-spans-azs',
              record.file,
              `${record.name}/${targetName}`,
              `the target names ${arns.length} subnet(s) and the largest Availability Zone in ` +
                `${vpc.file} has ${largestAz}. A target that spans AZs is a partition of the VPC ` +
                'from itself rather than of one AZ from the others, and there is then no ' +
                'surviving AZ for the application to be served from — so the result is ' +
                '"everything broke", which was knowable without running it.',
            );
          } else if (arns.length < largestAz) {
            report(
              'az-target-partial-az',
              record.file,
              `${record.name}/${targetName}`,
              `the target names ${arns.length} subnet(s) and an Availability Zone in ` +
                `${vpc.file} has ${largestAz}. Leaving a subnet group in the target AZ connected ` +
                'is a different experiment from the one the title describes: with the public ' +
                'subnet still reachable, the load balancer node in that AZ stays advertised in ' +
                'DNS and keeps accepting requests it can no longer serve.',
            );
          }

          if (vpc.natGateways > 0 && vpc.natGateways < vpc.subnetsByAz.size) {
            report(
              'single-nat-gateway',
              vpc.file,
              `${record.name}/${targetName}`,
              `the VPC has ${vpc.natGateways} NAT gateway(s) across ${vpc.subnetsByAz.size} ` +
                "Availability Zone(s), so some AZ's private subnets egress through another AZ. " +
                'Partitioning the AZ that holds a shared NAT gateway is not an AZ fault — it is ' +
                'a total loss of outbound connectivity for the whole application, including from ' +
                'the AZ that was supposed to survive and serve. The experiment then "fails" and ' +
                'the finding is about VpcStack\'s `natGateways`, not about anything the ' +
                'experiment asked.',
            );
          }
        }
      }
    }

    /* ── The doc the template points at ─────────────────────────────────── */

    if (declared !== undefined && !anchorsIn(input.chaosDoc).has(declared.anchor)) {
      report(
        'experiment-anchor-missing',
        CHAOS_DOC_PATH,
        record.name,
        `the template's description points a reader at '${declared.anchor}', and no heading in ` +
          `${CHAOS_DOC_PATH} produces that anchor. GitHub answers 200 for an anchor that does ` +
          'not exist and lands them at the top of the page, which is the least useful place to ' +
          'arrive while an experiment is running.',
      );
    }
  }

  // ── The task definition the latency experiment reaches into ───────────────

  const latencyEnvironments = new Set(
    catalogue
      .filter((experiment) => experiment.faultKind === 'latency')
      .flatMap((experiment) => experiment.allowedEnvironments),
  );

  for (const envName of latencyEnvironments) {
    if (environmentsRead.length > 0 && !environmentsRead.includes(envName)) continue;

    // `EcsStack` is the one whose service the ECS experiments target. Matched on
    // the file rather than on the family, because the family is a token in the
    // synthesised template and the question is about a specific stack's task
    // definition.
    const ecsDefinitions = taskDefinitions.filter((definition) =>
      new RegExp(`^EcsStack-${envName}\\.template\\.json$`, 'i').test(definition.file),
    );

    if (ecsDefinitions.length === 0) continue;

    for (const definition of ecsDefinitions) {
      if (definition.pidMode !== 'task') {
        report(
          'task-definition-pid-mode',
          definition.file,
          definition.logicalId,
          `PidMode is ${definition.pidMode === undefined ? 'unset' : `'${definition.pidMode}'`} ` +
            "and 'aws:ecs:task-network-latency' requires 'task'. This is a property of EcsStack, " +
            'a stack this experiment does not own and whose own tests do not know it exists: ' +
            'removing it is a one-line diff that looks like tidying up, the service stays ' +
            'healthy, and the experiment fails the next time somebody starts it.',
        );
      }
      if (definition.enableFaultInjection !== true) {
        report(
          'task-definition-fault-injection',
          definition.file,
          definition.logicalId,
          'EnableFaultInjection is not true, so the task will not accept fault-injection ' +
            'requests and the latency experiment cannot reach the application. Nothing about the ' +
            'service degrades without it; the only thing that breaks is the experiment, during ' +
            'the exercise.',
        );
      }
    }
  }

  // ── The guardrails the catalogue did its arithmetic against ───────────────

  for (const experiment of catalogue) {
    for (const envName of experiment.allowedEnvironments) {
      if (environmentsRead.length > 0 && !environmentsRead.includes(envName)) continue;
      for (const declaredAlarm of experiment.stopConditions) {
        const alarmName = `${envName}-${declaredAlarm.alarmName}`;
        const actual = alarms.get(alarmName);
        if (actual === undefined) {
          report(
            'stop-condition-alarm-missing',
            CHAOS_DOC_PATH,
            alarmName,
            `'${experiment.id}' stops on '${alarmName}' and no stack synthesised an alarm of ` +
              'that name. The alarms are owned elsewhere on purpose — a guardrail created only ' +
              'to be a guardrail is one whose threshold nobody tunes — and the cost of that is ' +
              'that renaming one there leaves this experiment stopping on nothing.',
          );
          continue;
        }

        if (actual.periodSeconds === undefined || actual.evaluationPeriods === undefined) {
          report(
            'stop-condition-window-drift',
            actual.file,
            alarmName,
            'the alarm carries no Period or EvaluationPeriods this gate can read, so the ' +
              "catalogue's duration arithmetic cannot be checked against it. A metric-math alarm " +
              'keeps its period inside Metrics; either way the number this experiment was sized ' +
              'against is no longer visible.',
          );
          continue;
        }

        const declaredWindow = detectionWindowSeconds(declaredAlarm);
        const actualWindow = actual.periodSeconds * actual.evaluationPeriods;
        if (declaredWindow !== actualWindow) {
          report(
            'stop-condition-window-drift',
            actual.file,
            alarmName,
            `the catalogue sized '${experiment.id}' against a ${declaredWindow}s detection ` +
              `window and the alarm's is ${actualWindow}s (${actual.periodSeconds}s x ` +
              `${actual.evaluationPeriods}). Those are props with defaults in the stack that owns ` +
              'the alarm, so widening one is a change with no diff here at all: the duration ' +
              'arithmetic stays internally correct and starts being about an alarm that no ' +
              'longer exists.',
          );
        }
      }
    }
  }

  // ── The gate has to be wired in ──────────────────────────────────────────

  if (input.ciWorkflow !== undefined && !input.ciWorkflow.includes(AUDIT_SCRIPT)) {
    report(
      'audit-not-run-in-ci',
      CI_WORKFLOW_PATH,
      AUDIT_SCRIPT,
      `no job runs \`npm run ${AUDIT_SCRIPT}\`. Every rule above is then a test nobody runs, ` +
        'which is worse than not having written them: the rules exist, so the next reader ' +
        'assumes the thing they describe is checked.',
    );
  }

  return { violations, templatesRead: experiments.length, environmentsRead };
};

/**
 * The anchor GitHub generates for a Markdown heading.
 *
 * Lowercase, anything that is not a word character, a space or a hyphen
 * dropped, spaces to hyphens. Computed forwards from every heading in the doc
 * rather than inverted from the anchor, because the inverse is not a function:
 * `## 2. A task disappears` and `## 2 A task disappears` produce the same
 * anchor, and a check written by string-matching the anchor text would pass on
 * a doc that happens to contain it in a paragraph.
 */
export const anchorForHeading = (heading: string): string =>
  '#' +
  heading
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');

/** Every anchor the headings in a Markdown document produce. */
export const anchorsIn = (markdown: string): Set<string> =>
  new Set(
    markdown
      .split('\n')
      .filter((line) => /^#{1,6}\s/.test(line))
      .map(anchorForHeading),
  );

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

  const docPath = path.join(root, CHAOS_DOC_PATH);
  if (!fs.existsSync(docPath)) {
    console.error(
      `\n${CHAOS_DOC_PATH} does not exist. Every experiment template's description points into ` +
        'it, and it is what the person starting an experiment reads first.\n',
    );
    process.exit(1);
  }

  const workflowPath = path.join(root, CI_WORKFLOW_PATH);

  const result = auditFisExperiments({
    templates,
    chaosDoc: fs.readFileSync(docPath, 'utf8'),
    ciWorkflow: fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : undefined,
  });

  if (result.templatesRead === 0) {
    console.error(
      `\nNo AWS::FIS::ExperimentTemplate resources in ${templates.length} template(s). Either ` +
        'ChaosFisStack was removed or its templates stopped being tagged, and the second case ' +
        'leaves every rule below unevaluated while this gate stays green.\n',
    );
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} chaos experiment violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error(`\nSee ${CHAOS_DOC_PATH}.\n`);
    process.exit(1);
  }

  console.log(
    `${CHAOS_EXPERIMENTS.length} experiment(s) across ${result.environmentsRead.join(', ')} ` +
      `(${result.templatesRead} template(s) read): every template carries a CloudWatch alarm ` +
      'stop condition rather than FIS\'s "none", at least one of them on a metric published by a ' +
      'schedule rather than by request traffic, and a duration that clears that alarm\'s real ' +
      'detection window with margin; every selection mode is the one the blast-radius rules ' +
      'passed; the availability-zone target is every subnet of exactly one AZ over a VPC with a ' +
      'NAT gateway per AZ; the latency action has useEcsFaultInjectionEndpoints set and the task ' +
      'definition it reaches into still carries PidMode and EnableFaultInjection; and every ' +
      'template records which targets it resolved.',
  );
}
