#!/usr/bin/env node
/**
 * Audit this repository's right-sizing posture against the synthesised
 * CloudFormation.
 *
 * `lib/right-sizing.ts` holds everything a unit test can decide: whether a
 * posture carries the reason it owes, whether a floor is a size Fargate would
 * register, whether two resources that must stay the same size declare the same
 * floor. This gate is for the questions it cannot answer about itself, and all
 * of them have the same shape — the wrong thing deploys cleanly, and what fails
 * is a number that reads healthy.
 *
 *   • **Is the `uncovered` claim still true?** The catalogue says Compute
 *     Optimizer produces no finding for the two application services because
 *     `EcsStack` attaches target tracking to CPU *and* memory, which AWS
 *     documents as disqualifying. That is a claim about two
 *     `AWS::ApplicationAutoScaling::ScalingPolicy` resources and nothing in
 *     TypeScript connects it to them. Delete one of those policies in a
 *     refactor and the service becomes eligible, the catalogue's reason becomes
 *     an excuse, and the first finding about a task size nobody chose
 *     deliberately arrives with `posture-uncovered` stamped on it.
 *
 *   • **Has a covered service quietly become uncovered?** The reverse, and the
 *     one that costs more. Add a memory scaling policy to the blue/green
 *     service and AWS stops recommending for it: every proposal for that entry
 *     becomes structurally impossible, `CoverageGap` goes red forever, and the
 *     cause is three lines in a stack that was about autoscaling.
 *
 *   • **Can the sweeper find the service at all?** The two halves of the
 *     catalogue match on different things, and they have to: the audit has a
 *     construct path and a Compute Optimizer recommendation has only a service
 *     ARN. So every entry carries a `servicePathSuffix` *and* a
 *     `serviceNamePattern`, and nothing in TypeScript connects either to a
 *     deployed `ServiceName`. A pattern that matches nothing is invisible from
 *     both ends: the sweeper never sees the service, so it never counts a
 *     coverage gap for it either, and the posture simply stops applying.
 *
 *   • **Can the sweeper write?** The entire design rests on it being unable to.
 *     Every resource in this account is tagged `ManagedBy: CDK`; a resize
 *     applied by an automation outside CloudFormation is reverted by the next
 *     deploy, and the revert is as silent as the change — so the saving
 *     disappears and no metric moves. One added `ecs:UpdateService` deploys
 *     cleanly and passes every other gate here.
 *
 *   • **Is the silence still alarmed?** A sweep that does not run publishes
 *     nothing, and an alarm on a metric with no datapoints does not fire. The
 *     staleness alarm's `treatMissingData: breaching` is the single property
 *     that makes "the integration stopped" visible, and it is a property
 *     somebody can soften in a console while the alarm goes on existing.
 *
 *   • **Are the task sizes real?** A floor is only a bound if the sizes around
 *     it are ones `RegisterTaskDefinition` accepts. A synthesised task carrying
 *     512 CPU and 512 MiB of memory is rejected at registration — a failed
 *     deploy at the end of a pipeline rather than a red check on the pull
 *     request that introduced it.
 *
 * The rules, and the failure each one prevents:
 *
 *   catalogue                      any finding from `validateRightSizingCatalogue`
 *   service-unclassified           an ECS service no entry claims, which makes
 *                                  every rule below vacuous for it
 *   service-ambiguous              two entries claim one service, so its posture
 *                                  depends on iteration order
 *   service-count-drift            a matched count that is not what the entry
 *                                  declares — an environment added or gone
 *   service-name-pattern-mismatch  an entry whose serviceNamePattern does not
 *                                  claim the ServiceName of the service it
 *                                  claims by construct path, so the sweeper
 *                                  never sees it and reports no gap for it
 *   service-name-pattern-ambiguous two patterns claiming one ServiceName, so
 *                                  the posture depends on a sort being stable
 *   uncovered-claim-unsupported    an `uncovered` entry whose template does not
 *                                  carry the exclusion it names
 *   covered-service-excluded       a `propose` or `hold` entry whose template
 *                                  does carry one, so AWS will never answer for
 *                                  it and the gap alarm is red by construction
 *   task-size-invalid              a synthesised task CPU/memory pair Fargate
 *                                  does not register
 *   task-size-below-floor          a proposable service already smaller than its
 *                                  own floor, so the floor bounds nothing
 *   sweeper-missing                no sweeper in cdk.out, which leaves every
 *                                  rule below unevaluated and the gate green
 *   sweeper-can-write              the sweeper's role carries a write action
 *   sweep-rule-missing             nothing schedules the sweep, so every metric
 *                                  is absent rather than zero
 *   sweep-rule-no-dlq              a schedule whose undeliverable invocations
 *                                  are dropped rather than queued
 *   stale-alarm-missing            nothing alarms on SweepSuccess
 *   stale-alarm-not-breaching      that alarm not treating missing data as
 *                                  breaching, when absence is the symptom
 *   enrolment-alarm-missing        nothing alarms on Enrolled, so an account
 *                                  that was never opted in reads as optimised
 *   coverage-alarm-missing         nothing alarms on CoverageGap
 *   doc-table-drift                a published table that is not what the data
 *                                  renders
 *   audit-not-run-in-ci            this gate is not wired into a job
 *
 * Usage:
 *   npm run audit:right-sizing                                 # repository root
 *   npx ts-node tools/audit-right-sizing.ts <dir>
 *
 * Requires `cdk synth` to have run. Exits non-zero when anything is found.
 * See docs/right-sizing.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  type RightSizingWorkload,
  RIGHT_SIZING_WORKLOADS,
  isValidFargateSize,
  postureTotals,
  serviceNameMatches,
  renderRightSizingTable,
  rightSizingWorkloadsFor,
  validateRightSizingCatalogue,
} from '../lib/right-sizing';

export const RIGHT_SIZING_DOC_PATH = path.join('docs', 'right-sizing.md');
export const CI_WORKFLOW_PATH = path.join('.github', 'workflows', 'ci.yml');

/** The npm script the CI job must run. */
export const AUDIT_SCRIPT = 'audit:right-sizing';

/*
 * Restated rather than imported, for the reason `audit-runbooks.ts` gives: a
 * gate that imports the constants it checks cannot catch a change to them.
 * `test/audit-right-sizing.test.ts` holds these against the library's and the
 * stack's exports, so a deliberate rename is one failing assertion rather than
 * a silently weakened rule. The catalogue itself *is* imported, because it is
 * the input under review rather than a constant.
 */

/** The namespace that identifies the sweeper among the fifty-nine functions. */
export const RIGHT_SIZING_METRIC_NAMESPACE = 'Boilerplate/RightSizing';

/** Metric names the three required alarms must be built from. */
export const SWEEP_SUCCESS_METRIC = 'SweepSuccess';
export const ENROLLED_METRIC = 'Enrolled';
export const COVERAGE_GAP_METRIC = 'CoverageGap';

/** What `treatMissingData` must be on the alarm whose symptom is absence. */
export const BREACHING = 'breaching';

/** The two predefined target-tracking metrics whose combination disqualifies. */
export const CPU_TARGET_METRIC = 'ECSServiceAverageCPUUtilization';
export const MEMORY_TARGET_METRIC = 'ECSServiceAverageMemoryUtilization';

/** The scaling policy type AWS documents as disqualifying on its own. */
export const STEP_SCALING_POLICY_TYPE = 'StepScaling';

/**
 * Actions that would let the sweeper change something.
 *
 * A deny-list of verbs rather than an allow-list of actions, because the
 * failure being prevented is an action nobody here has thought of yet:
 * `ecs:RegisterTaskDefinition` and `lambda:UpdateFunctionConfiguration` are the
 * two obvious ones; `compute-optimizer:UpdateEnrollmentStatus`, which creates a
 * service-linked role, and `compute-optimizer:ExportECSServiceRecommendations`,
 * which writes objects into an S3 bucket, are the two that do not look like
 * writes. `Export` is deliberately absent from the read verbs for that second
 * reason. Read verbs are the exception list, so a new action is a finding until
 * somebody says otherwise.
 */
export const READ_VERB = /^(Get|List|Describe|Batch(Get|Describe))/;

/** Services whose non-read actions the sweeper must not hold. */
export const GOVERNED_SERVICES = [
  'compute-optimizer',
  'ecs',
  'lambda',
  'application-autoscaling',
];

export type RightSizingRule =
  | 'catalogue'
  | 'service-unclassified'
  | 'service-ambiguous'
  | 'service-count-drift'
  | 'service-name-pattern-mismatch'
  | 'service-name-pattern-ambiguous'
  | 'uncovered-claim-unsupported'
  | 'covered-service-excluded'
  | 'task-size-invalid'
  | 'task-size-below-floor'
  | 'sweeper-missing'
  | 'sweeper-can-write'
  | 'sweep-rule-missing'
  | 'sweep-rule-no-dlq'
  | 'stale-alarm-missing'
  | 'stale-alarm-not-breaching'
  | 'enrolment-alarm-missing'
  | 'coverage-alarm-missing'
  | 'doc-table-drift'
  | 'audit-not-run-in-ci';

export interface RightSizingViolation {
  readonly rule: RightSizingRule;
  /** Template file name, or a repository-relative path for a document finding. */
  readonly file: string;
  /** The CDK construct path, the workload id, or a description. */
  readonly location: string;
  readonly message: string;
}

export interface TemplateFile {
  /** File name as it appears in `cdk.out`, e.g. `EcsStack-Staging.template.json`. */
  readonly path: string;
  readonly document: unknown;
}

export interface RightSizingAuditInput {
  readonly templates: readonly TemplateFile[];
  readonly doc: string;
  /** Omitted skips the CI wiring rule, which is what the unit tests want. */
  readonly ciWorkflow?: string;
  /** Override the catalogue. Tests only. */
  readonly workloads?: readonly RightSizingWorkload[];
}

export interface RightSizingAuditResult {
  readonly violations: readonly RightSizingViolation[];
  readonly servicesRead: number;
  readonly scalingPoliciesRead: number;
  readonly alarmsRead: number;
  readonly sweepersRead: number;
}

/* ── Template reading ─────────────────────────────────────────────────────── */

interface Resource {
  readonly Type?: string;
  readonly Properties?: Record<string, any>;
  readonly Metadata?: Record<string, any>;
}

const resourcesOf = (document: unknown): Record<string, Resource> => {
  const resources = (document as { Resources?: unknown } | null)?.Resources;
  return resources && typeof resources === 'object' ? (resources as Record<string, Resource>) : {};
};

/** `Stack/Construct/Resource`, minus the stack name CDK puts first. */
const constructPathOf = (resource: Resource, logicalId: string): string => {
  const metadataPath = resource.Metadata?.['aws:cdk:path'];
  if (typeof metadataPath !== 'string') return logicalId;
  return metadataPath.split('/').slice(1).join('/');
};

const stackNameOf = (file: string): string => file.replace(/\.template\.json$/, '');

/** The logical id a `Ref` or a `Fn::GetAtt` names, if it names one. */
const referencedLogicalId = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.Ref === 'string') return object.Ref;
  const getAtt = object['Fn::GetAtt'];
  if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') return getAtt[0];
  return undefined;
};

/**
 * Every logical id reachable from a template value, however deeply nested.
 *
 * A `ScalableTarget`'s `ResourceId` is an `Fn::Join` of a literal, a `Ref` to
 * the cluster and a `Fn::GetAtt` to the service's `Name`, so "which service does
 * this scaling target scale" is a question about the *inside* of a join.
 * Collecting every id and asking whether the service's is among them is both
 * simpler than parsing the join and harder to break: the shape of the join is
 * CDK's and has changed before.
 */
export const referencedLogicalIds = (value: unknown): readonly string[] => {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const id = referencedLogicalId(node);
    if (id) found.push(id);
    for (const child of Object.values(node as Record<string, unknown>)) walk(child);
  };
  walk(value);
  return found;
};

/* ── The services under review ────────────────────────────────────────────── */

export interface ServiceResource {
  readonly file: string;
  readonly stackName: string;
  readonly logicalId: string;
  readonly constructPath: string;
  /** Literal `ServiceName`, where the template carries one. */
  readonly serviceName?: string;
  /** Task CPU, as the referenced task definition declares it. */
  readonly taskCpu?: number;
  /** Task memory in MiB, as the referenced task definition declares it. */
  readonly taskMemoryMiB?: number;
  /** Predefined target-tracking metrics scaling this service. */
  readonly targetTrackedMetrics: readonly string[];
  /** True when any step scaling policy scales this service. */
  readonly hasStepScaling: boolean;
}

/** A number CloudFormation may carry as a string, or `undefined`. */
const numberOf = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
};

interface ScalingFacts {
  readonly targetTracked: readonly string[];
  readonly step: boolean;
  readonly policies: number;
}

/**
 * Scaling policies by the logical id of the service they ultimately scale.
 *
 * Two hops: a policy names a `ScalingTargetId`, and the target's `ResourceId`
 * names the service. Both are resolved within one template because an
 * Application Auto Scaling target and the service it scales are always in the
 * same stack — a scalable target referencing a service across a stack boundary
 * would have to carry the service's name as a literal, which no construct here
 * does.
 */
export const scalingFactsByService = (
  template: TemplateFile,
): Map<string, ScalingFacts> => {
  const resources = resourcesOf(template.document);

  // Scalable target logical id → service logical ids its ResourceId reaches.
  const targetsToServices = new Map<string, readonly string[]>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::ApplicationAutoScaling::ScalableTarget') continue;
    targetsToServices.set(logicalId, referencedLogicalIds(resource.Properties?.ResourceId));
  }

  const facts = new Map<string, { targetTracked: string[]; step: boolean; policies: number }>();
  const ensure = (serviceId: string) => {
    const existing = facts.get(serviceId);
    if (existing) return existing;
    const created = { targetTracked: [] as string[], step: false, policies: 0 };
    facts.set(serviceId, created);
    return created;
  };

  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::ApplicationAutoScaling::ScalingPolicy') continue;
    const properties = resource.Properties ?? {};
    const targetId = referencedLogicalId(properties.ScalingTargetId);
    const serviceIds = targetId ? targetsToServices.get(targetId) ?? [] : [];

    const predefined =
      properties.TargetTrackingScalingPolicyConfiguration?.PredefinedMetricSpecification
        ?.PredefinedMetricType;
    const isStep =
      properties.PolicyType === STEP_SCALING_POLICY_TYPE ||
      properties.StepScalingPolicyConfiguration !== undefined;

    for (const serviceId of serviceIds) {
      const entry = ensure(serviceId);
      entry.policies += 1;
      if (typeof predefined === 'string' && !entry.targetTracked.includes(predefined)) {
        entry.targetTracked.push(predefined);
      }
      if (isStep) entry.step = true;
    }
  }

  const result = new Map<string, ScalingFacts>();
  for (const [serviceId, entry] of facts.entries()) {
    result.set(serviceId, {
      targetTracked: entry.targetTracked,
      step: entry.step,
      policies: entry.policies,
    });
  }
  return result;
};

/** Every `AWS::ECS::Service` in a template, with its size and its scaling. */
export const servicesIn = (template: TemplateFile): readonly ServiceResource[] => {
  const resources = resourcesOf(template.document);
  const scaling = scalingFactsByService(template);
  const services: ServiceResource[] = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::ECS::Service') continue;
    const properties = resource.Properties ?? {};

    const taskDefinitionId = referencedLogicalId(properties.TaskDefinition);
    const taskDefinition = taskDefinitionId ? resources[taskDefinitionId] : undefined;
    const facts = scaling.get(logicalId);

    services.push({
      file: template.path,
      stackName: stackNameOf(template.path),
      logicalId,
      constructPath: constructPathOf(resource, logicalId),
      ...(typeof properties.ServiceName === 'string'
        ? { serviceName: properties.ServiceName }
        : {}),
      ...(taskDefinition?.Type === 'AWS::ECS::TaskDefinition'
        ? {
            taskCpu: numberOf(taskDefinition.Properties?.Cpu),
            taskMemoryMiB: numberOf(taskDefinition.Properties?.Memory),
          }
        : {}),
      targetTrackedMetrics: facts?.targetTracked ?? [],
      hasStepScaling: facts?.step ?? false,
    });
  }

  return services;
};

/**
 * Does this service's template carry an exclusion AWS documents?
 *
 * Target tracking on *both* CPU and memory, or any step scaling policy. Either
 * one means `GetECSServiceRecommendations` will not answer for the service — and
 * will not say so: the service is simply absent from the response.
 */
export const isExcludedFromRecommendations = (service: ServiceResource): boolean =>
  service.hasStepScaling ||
  (service.targetTrackedMetrics.includes(CPU_TARGET_METRIC) &&
    service.targetTrackedMetrics.includes(MEMORY_TARGET_METRIC));

/* ── The sweeper under review ─────────────────────────────────────────────── */

export interface SweeperResource {
  readonly file: string;
  readonly logicalId: string;
  readonly constructPath: string;
  /** Logical id of the role the function assumes, where it is in this template. */
  readonly roleLogicalId?: string;
  /** Non-read actions on {@link GOVERNED_SERVICES} the role's policies carry. */
  readonly writeActions: readonly string[];
  /** True when an EventBridge rule in this template targets the function. */
  readonly scheduled: boolean;
  /** True when every rule targeting it carries a dead-letter queue. */
  readonly scheduleDeadLettered: boolean;
}

const actionsOf = (statement: Record<string, any>): readonly string[] => {
  const action = statement.Action;
  if (typeof action === 'string') return [action];
  if (Array.isArray(action)) return action.filter((item): item is string => typeof item === 'string');
  return [];
};

/** Is this action a write on a service this gate governs? */
export const isGovernedWrite = (action: string): boolean => {
  if (action === '*') return true;
  const [service, verb] = action.split(':');
  if (!verb || !GOVERNED_SERVICES.includes(service.toLowerCase())) return false;
  if (verb === '*') return true;
  return !READ_VERB.test(verb);
};

/** The sweeper in a template, identified by the namespace it publishes to. */
export const sweepersIn = (template: TemplateFile): readonly SweeperResource[] => {
  const resources = resourcesOf(template.document);
  const sweepers: SweeperResource[] = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const variables = resource.Properties?.Environment?.Variables ?? {};
    if (variables.METRIC_NAMESPACE !== RIGHT_SIZING_METRIC_NAMESPACE) continue;

    const roleLogicalId = referencedLogicalId(resource.Properties?.Role);

    const writeActions: string[] = [];
    if (roleLogicalId) {
      for (const candidate of Object.values(resources)) {
        const attachesToRole =
          candidate.Type === 'AWS::IAM::Policy' &&
          referencedLogicalIds(candidate.Properties?.Roles).includes(roleLogicalId);
        const isInlineOnRole =
          candidate.Type === 'AWS::IAM::Role' && resources[roleLogicalId] === candidate;
        if (!attachesToRole && !isInlineOnRole) continue;

        const documents = [
          candidate.Properties?.PolicyDocument,
          ...((candidate.Properties?.Policies ?? []) as Record<string, any>[]).map(
            (policy) => policy?.PolicyDocument,
          ),
        ];
        for (const document of documents) {
          for (const statement of (document?.Statement ?? []) as Record<string, any>[]) {
            if (statement?.Effect === 'Deny') continue;
            for (const action of actionsOf(statement)) {
              if (isGovernedWrite(action) && !writeActions.includes(action)) {
                writeActions.push(action);
              }
            }
          }
        }
      }
    }

    // Rules whose targets reach this function. `Targets[].Arn` is a GetAtt on
    // the function, and `DeadLetterConfig` sits beside it on the same target.
    let scheduled = false;
    let scheduleDeadLettered = true;
    for (const candidate of Object.values(resources)) {
      if (candidate.Type !== 'AWS::Events::Rule') continue;
      if (typeof candidate.Properties?.ScheduleExpression !== 'string') continue;
      for (const target of (candidate.Properties?.Targets ?? []) as Record<string, any>[]) {
        if (!referencedLogicalIds(target?.Arn).includes(logicalId)) continue;
        scheduled = true;
        if (!target?.DeadLetterConfig?.Arn) scheduleDeadLettered = false;
      }
    }

    sweepers.push({
      file: template.path,
      logicalId,
      constructPath: constructPathOf(resource, logicalId),
      ...(roleLogicalId ? { roleLogicalId } : {}),
      writeActions,
      scheduled,
      scheduleDeadLettered,
    });
  }

  return sweepers;
};

/* ── The alarms under review ──────────────────────────────────────────────── */

export interface AlarmResource {
  readonly file: string;
  readonly logicalId: string;
  readonly alarmName?: string;
  readonly metricName?: string;
  readonly namespace?: string;
  readonly treatMissingData?: string;
}

/** Every alarm in a template reading the right-sizing namespace. */
export const rightSizingAlarmsIn = (template: TemplateFile): readonly AlarmResource[] => {
  const alarms: AlarmResource[] = [];
  for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
    if (resource.Type !== 'AWS::CloudWatch::Alarm') continue;
    const properties = resource.Properties ?? {};
    if (properties.Namespace !== RIGHT_SIZING_METRIC_NAMESPACE) continue;
    alarms.push({
      file: template.path,
      logicalId,
      ...(typeof properties.AlarmName === 'string' ? { alarmName: properties.AlarmName } : {}),
      ...(typeof properties.MetricName === 'string' ? { metricName: properties.MetricName } : {}),
      namespace: properties.Namespace,
      ...(typeof properties.TreatMissingData === 'string'
        ? { treatMissingData: properties.TreatMissingData }
        : {}),
    });
  }
  return alarms;
};

/* ── The audit ────────────────────────────────────────────────────────────── */

export const auditRightSizing = (input: RightSizingAuditInput): RightSizingAuditResult => {
  const workloads = input.workloads ?? RIGHT_SIZING_WORKLOADS;
  const violations: RightSizingViolation[] = [];
  const add = (
    rule: RightSizingRule,
    file: string,
    location: string,
    message: string,
  ): void => {
    violations.push({ rule, file, location, message });
  };

  for (const finding of validateRightSizingCatalogue(workloads)) {
    add('catalogue', 'lib/right-sizing.ts', finding.subject, `[${finding.rule}] ${finding.message}`);
  }

  const services = input.templates.flatMap((template) => servicesIn(template));
  const sweepers = input.templates.flatMap((template) => sweepersIn(template));
  const alarms = input.templates.flatMap((template) => rightSizingAlarmsIn(template));
  const scalingPoliciesRead = services.reduce(
    (total, service) => total + service.targetTrackedMetrics.length + (service.hasStepScaling ? 1 : 0),
    0,
  );

  // ── The inventory ─────────────────────────────────────────────────────────
  const matches = new Map<string, ServiceResource[]>();

  for (const service of services) {
    const claiming = rightSizingWorkloadsFor(service, workloads);

    if (claiming.length === 0) {
      add(
        'service-unclassified',
        service.file,
        service.constructPath,
        'No entry in RIGHT_SIZING_WORKLOADS claims this service, so nothing says whether a ' +
          'Compute Optimizer finding about it may be applied — and the sweeper reports no ' +
          'coverage gap for it either, because a gap is measured against the catalogue. An ' +
          'unclassified service is the one state that is invisible from both ends.',
      );
      continue;
    }
    if (claiming.length > 1) {
      add(
        'service-ambiguous',
        service.file,
        service.constructPath,
        `Claimed by ${claiming.length} entries (${claiming.map((entry) => entry.id).join(', ')}). ` +
          'The posture that wins depends on iteration order, and the two differ in whether a ' +
          'finding becomes a proposal.',
      );
      continue;
    }

    const workload = claiming[0];
    const existing = matches.get(workload.id) ?? [];
    existing.push(service);
    matches.set(workload.id, existing);

    // ── The runtime half of the match ──────────────────────────────────────
    // The entry that claims this service by construct path has to claim it by
    // name too, or the sweeper will never see it. There is no symptom: the
    // service is absent from the catalogue's point of view, so it produces no
    // proposal and no coverage gap, and the posture on the entry quietly stops
    // applying to anything.
    if (service.serviceName !== undefined) {
      const claimedByName = workloads.filter((candidate) =>
        serviceNameMatches(candidate.serviceNamePattern, service.serviceName as string),
      );

      if (!claimedByName.some((candidate) => candidate.id === workload.id)) {
        add(
          'service-name-pattern-mismatch',
          service.file,
          service.constructPath,
          `Entry '${workload.id}' claims this service by construct path and its ` +
            `serviceNamePattern '${workload.serviceNamePattern}' does not match the deployed ` +
            `ServiceName '${service.serviceName}'. A Compute Optimizer recommendation carries a ` +
            'service ARN and nothing else, so the sweeper matches on the name: the service is ' +
            'invisible to it, which means no proposal and — the part with no symptom — ' +
            'no coverage gap either.',
        );
      }
      if (claimedByName.length > 1) {
        add(
          'service-name-pattern-ambiguous',
          service.file,
          service.constructPath,
          `ServiceName '${service.serviceName}' is matched by ${claimedByName.length} patterns ` +
            `(${claimedByName.map((candidate) => `${candidate.id}: ${candidate.serviceNamePattern}`).join(', ')}). ` +
            'The sweeper breaks the tie by specificity so its answer is at least deterministic, ' +
            'but two of these entries disagree about whether a finding becomes a proposal and ' +
            'the tie-break is not the place to decide that.',
        );
      }
    }

    // ── The eligibility claim, in both directions ──────────────────────────
    const excluded = isExcludedFromRecommendations(service);

    if (workload.uncoveredReason === 'dual-target-tracking' && !excluded) {
      add(
        'uncovered-claim-unsupported',
        service.file,
        service.constructPath,
        `Entry '${workload.id}' declares uncoveredReason 'dual-target-tracking' and this ` +
          `service is target-tracked on [${service.targetTrackedMetrics.join(', ') || 'nothing'}] ` +
          `with no step scaling policy. AWS disqualifies a service only when both ` +
          `${CPU_TARGET_METRIC} and ${MEMORY_TARGET_METRIC} are tracked, so the service is ` +
          'eligible and the catalogue is giving a reason that is no longer true. The first ' +
          'consequence is a real finding arriving with posture-uncovered stamped on it, about a ' +
          'task size nobody chose deliberately.',
      );
    }
    if (workload.uncoveredReason === 'step-scaling' && !service.hasStepScaling) {
      add(
        'uncovered-claim-unsupported',
        service.file,
        service.constructPath,
        `Entry '${workload.id}' declares uncoveredReason 'step-scaling' and this service has no ` +
          'step scaling policy. The exclusion it names does not apply, so the entry is an ' +
          'excuse rather than a classification.',
      );
    }
    if (workload.posture !== 'uncovered' && excluded) {
      add(
        'covered-service-excluded',
        service.file,
        service.constructPath,
        `Entry '${workload.id}' has posture '${workload.posture}', which assumes Compute ` +
          'Optimizer answers for this service, and the template carries an exclusion: ' +
          (service.hasStepScaling
            ? 'a step scaling policy'
            : `target tracking on both ${CPU_TARGET_METRIC} and ${MEMORY_TARGET_METRIC}`) +
          '. AWS will return no recommendation and will not say why — the service is simply ' +
          'absent from the response — so every proposal for this entry is structurally ' +
          'impossible and the coverage-gap alarm is red by construction. Either reclassify the ' +
          'entry as uncovered with this reason, or remove the policy deliberately.',
      );
    }

    // ── The sizes ──────────────────────────────────────────────────────────
    if (service.taskCpu !== undefined && service.taskMemoryMiB !== undefined) {
      if (!isValidFargateSize(service.taskCpu, service.taskMemoryMiB)) {
        add(
          'task-size-invalid',
          service.file,
          service.constructPath,
          `The task definition declares ${service.taskCpu} CPU with ${service.taskMemoryMiB} MiB ` +
            'of memory, which is not a pair this repository’s Fargate size table accepts. ' +
            'RegisterTaskDefinition rejects an invalid pair, which is a failed deploy at the end ' +
            'of a pipeline; and a floor expressed in sizes the table cannot speak for bounds ' +
            'nothing.',
        );
      }
      const floor = workload.floor;
      if (
        floor &&
        (service.taskCpu < floor.cpu || service.taskMemoryMiB < floor.memoryMiB)
      ) {
        add(
          'task-size-below-floor',
          service.file,
          service.constructPath,
          `Entry '${workload.id}' declares a floor of ${floor.cpu} CPU / ${floor.memoryMiB} MiB ` +
            `and this service already runs at ${service.taskCpu} / ${service.taskMemoryMiB}. A ` +
            'floor below the current size is a bound; a floor above it is a claim the running ' +
            'service already violates, and every proposal is then rejected as below-floor ' +
            'including the ones that would restore the declared minimum.',
        );
      }
    }
  }

  for (const workload of workloads) {
    const matched = matches.get(workload.id) ?? [];
    if (matched.length !== workload.expectedResources) {
      add(
        'service-count-drift',
        'lib/right-sizing.ts',
        workload.id,
        `Declares expectedResources: ${workload.expectedResources} and matched ${matched.length} ` +
          `service(s) (${matched.map((service) => service.stackName).join(', ') || 'none'}). The ` +
          'sweeper counts a coverage gap as expectedResources minus findings, so a stale number ' +
          'here reports a gap that is not there or hides one that is.',
      );
    }
  }

  // ── The sweeper ───────────────────────────────────────────────────────────
  if (sweepers.length === 0) {
    add(
      'sweeper-missing',
      'cdk.out',
      RIGHT_SIZING_METRIC_NAMESPACE,
      `No Lambda function in any template publishes to ${RIGHT_SIZING_METRIC_NAMESPACE}, so ` +
        'nothing reads Compute Optimizer at all. Every rule about the sweeper below is then ' +
        'unevaluated, and an unevaluated rule and a passing one look identical in a log.',
    );
  }

  for (const sweeper of sweepers) {
    if (sweeper.writeActions.length > 0) {
      add(
        'sweeper-can-write',
        sweeper.file,
        sweeper.constructPath,
        `The sweeper's role carries ${sweeper.writeActions.join(', ')}. The whole design rests ` +
          'on it being unable to change anything: every resource here is tagged ' +
          '`ManagedBy: CDK`, a resize applied outside CloudFormation is reverted by the next ' +
          'deploy, and the revert is as silent as the change — so the saving disappears and ' +
          'no metric moves. A proposal belongs in a pull request.',
      );
    }
    if (!sweeper.scheduled) {
      add(
        'sweep-rule-missing',
        sweeper.file,
        sweeper.constructPath,
        'No scheduled EventBridge rule targets the sweeper, so it never runs. Every ' +
          'right-sizing metric is then absent rather than zero, and only the staleness alarm ' +
          'treats absence as a failure — the other four read healthy forever.',
      );
    } else if (!sweeper.scheduleDeadLettered) {
      add(
        'sweep-rule-no-dlq',
        sweeper.file,
        sweeper.constructPath,
        'A schedule targets the sweeper with no dead-letter queue. A failed invocation is then ' +
          'dropped, and a schedule that has stopped delivering and a sweep that found nothing ' +
          'publish the same thing — nothing — with only a queue depth to tell them ' +
          'apart.',
      );
    }
  }

  // ── The alarms ────────────────────────────────────────────────────────────
  const alarmOn = (metricName: string) =>
    alarms.filter((alarm) => alarm.metricName === metricName);

  const staleAlarms = alarmOn(SWEEP_SUCCESS_METRIC);
  if (sweepers.length > 0 && staleAlarms.length === 0) {
    add(
      'stale-alarm-missing',
      'cdk.out',
      SWEEP_SUCCESS_METRIC,
      `No alarm reads ${SWEEP_SUCCESS_METRIC}. It is the only metric here whose absence is the ` +
        'signal: a disabled rule, a deleted schedule and a role that lost its read permission ' +
        'all publish nothing, and nothing is what every other alarm here tolerates.',
    );
  }
  for (const alarm of staleAlarms) {
    if ((alarm.treatMissingData ?? '') !== BREACHING) {
      add(
        'stale-alarm-not-breaching',
        alarm.file,
        alarm.alarmName ?? alarm.logicalId,
        `treatMissingData is '${alarm.treatMissingData ?? 'unset'}', not '${BREACHING}'. This is ` +
          'the one alarm whose symptom is the absence of a datapoint, and with missing data ' +
          'tolerated it fires only when a sweep runs and reports failure — which is the ' +
          'case the error alarm already covers.',
      );
    }
  }

  if (sweepers.length > 0 && alarmOn(ENROLLED_METRIC).length === 0) {
    add(
      'enrolment-alarm-missing',
      'cdk.out',
      ENROLLED_METRIC,
      `No alarm reads ${ENROLLED_METRIC}. Compute Optimizer is opt-in per account, and before ` +
        'the opt-in there is nothing wrong with this pipeline except that it has never measured ' +
        'anything — which publishes zero over-provisioned services, the same number an ' +
        'optimised account publishes.',
    );
  }
  if (sweepers.length > 0 && alarmOn(COVERAGE_GAP_METRIC).length === 0) {
    add(
      'coverage-alarm-missing',
      'cdk.out',
      COVERAGE_GAP_METRIC,
      `No alarm reads ${COVERAGE_GAP_METRIC}. A catalogued service with no finding is how an ` +
        'excluded service, a service below the 24-hour metric threshold and a service that no ' +
        'longer exists all present themselves, and none of the three is distinguishable from ' +
        '"optimised" in a count of findings.',
    );
  }

  // Rendered from the shipped catalogue rather than from `workloads`: the
  // published document is a statement about this repository, so a caller passing
  // a subset — every unit test — is not making a claim about the document.
  const table = renderRightSizingTable(RIGHT_SIZING_WORKLOADS);
  if (!input.doc.includes(table)) {
    add(
      'doc-table-drift',
      RIGHT_SIZING_DOC_PATH,
      'posture table',
      'The published posture table is not what RIGHT_SIZING_WORKLOADS renders. It is generated ' +
        'rather than checked, so this means the document was edited by hand or the catalogue ' +
        'moved under it — and the column that goes stale first is the one a reader uses to ' +
        'find out why their service never gets a finding.',
    );
  }

  if (input.ciWorkflow !== undefined && !input.ciWorkflow.includes(`npm run ${AUDIT_SCRIPT}`)) {
    add(
      'audit-not-run-in-ci',
      CI_WORKFLOW_PATH,
      AUDIT_SCRIPT,
      `No job runs \`npm run ${AUDIT_SCRIPT}\`, so none of the rules above blocks anything.`,
    );
  }

  return {
    violations,
    servicesRead: services.length,
    scalingPoliciesRead,
    alarmsRead: alarms.length,
    sweepersRead: sweepers.length,
  };
};

export const formatViolations = (violations: readonly RightSizingViolation[]): string =>
  violations
    .map(
      (violation) =>
        `  [${violation.rule}] ${violation.file} ${violation.location}\n    ${violation.message}`,
    )
    .join('\n\n');

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
const readTemplates = (root: string): TemplateFile[] => {
  const base = path.join(root, 'aws', 'cdk', 'cdk.out');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((name) => name.endsWith('.template.json'))
    .flatMap((name) => {
      try {
        return [
          {
            path: name,
            document: JSON.parse(fs.readFileSync(path.join(base, name), 'utf8')) as unknown,
          },
        ];
      } catch {
        // `cdk synth` fails loudly on its own in the step before this one.
        return [];
      }
    });
};

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const args = process.argv.slice(2);
  const root = path.resolve(
    args.find((arg) => !arg.startsWith('--')) ?? path.join(__dirname, '..', '..', '..'),
  );
  const templates = readTemplates(root);

  if (templates.length === 0) {
    console.error(
      `\nNo synthesised templates under ${root}/aws/cdk/cdk.out. Run \`npx cdk synth\` first — ` +
        'this gate reads what synth wrote, because a scaling policy is what decides whether AWS ' +
        'will answer for a service at all.\n',
    );
    process.exit(1);
  }

  const docPath = path.join(root, RIGHT_SIZING_DOC_PATH);
  if (!fs.existsSync(docPath)) {
    console.error(`\n${RIGHT_SIZING_DOC_PATH} does not exist, and this gate reads it.\n`);
    process.exit(1);
  }

  const workflowPath = path.join(root, CI_WORKFLOW_PATH);
  const result = auditRightSizing({
    templates,
    doc: fs.readFileSync(docPath, 'utf8'),
    ciWorkflow: fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : undefined,
  });

  if (result.servicesRead === 0) {
    console.error(
      `\nNo ECS services in ${templates.length} template(s). Either every stack stopped ` +
        'synthesising or the resource type this gate reads was renamed, and the second case ' +
        'leaves every rule unevaluated while the gate stays green.\n',
    );
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} right-sizing violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error(`\nSee ${RIGHT_SIZING_DOC_PATH}.\n`);
    process.exit(1);
  }

  const totals = postureTotals();
  console.log(
    `${result.servicesRead} ECS service(s) across ${templates.length} template(s), all ` +
      `classified: ${totals.propose} proposable, ${totals.hold} held with a recorded reason, ` +
      `${totals.uncovered} that Compute Optimizer structurally cannot answer for. ` +
      'Every entry claims its services by deployed name as well as by construct path, with no ' +
      `name claimed twice. ${result.scalingPoliciesRead} scaling policy declaration(s) read, ` +
      'and every eligibility ' +
      'claim matches them in both directions — no uncovered entry excusing a service AWS ' +
      'would answer for, and no proposable entry pointing at one it will not. Every synthesised ' +
      'task size is a pair Fargate registers and none is below its own floor; ' +
      `${result.sweepersRead} sweeper(s) read, each scheduled, dead-lettered, and holding no ` +
      `write action on compute; ${result.alarmsRead} alarm(s) over the namespace, with the ` +
      'staleness alarm breaching on missing data; and the published table is what ' +
      'lib/right-sizing.ts renders.',
  );
}
