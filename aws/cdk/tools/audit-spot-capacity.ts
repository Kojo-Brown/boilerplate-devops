#!/usr/bin/env node
/**
 * Audit this repository's Fargate Spot posture against the synthesised
 * CloudFormation.
 *
 * `lib/spot-capacity.ts` holds everything a unit test can decide: whether a
 * posture follows from a criticality, whether a drain budget fits inside the
 * two-minute warning, whether a `spot-with-base` entry actually has a base.
 * This gate is for the questions it cannot answer about itself, and they all
 * have the same shape — the wrong thing deploys cleanly, and what fails is
 * later, elsewhere, or never.
 *
 *   • **Is the catalogue still describing what deploys?** `posture` is a claim
 *     about a `CapacityProviderStrategy` block, and nothing in TypeScript
 *     connects the two. A strategy dropped in a refactor leaves the catalogue
 *     saying `spot-with-base` about a service that now says `LaunchType:
 *     FARGATE` — which is more expensive and perfectly healthy, so nobody finds
 *     out. The reverse is the one that matters: a strategy added to a service
 *     the catalogue calls `on-demand-only` puts the production application, a
 *     release mechanism or the trace sampler on reclaimable capacity, and the
 *     first symptom is an error budget, a rolled-back release, or a trace
 *     missing its database span.
 *
 *   • **Can the inventory still see everything?** A service no entry matches is
 *     the failure that makes every other rule vacuous, and it is the normal
 *     state of an inventory: somebody adds a stack. So an unclassified service
 *     fails, and so does an entry whose matched count has drifted.
 *
 *   • **Does the budget in the template still fit?** The declared budget is
 *     checked offline; the *deployed* one is three properties in two resources —
 *     a container's `StopTimeout` and a target group's
 *     `deregistration_delay.timeout_seconds` — and either can be edited without
 *     touching the catalogue. Both are spent inside the same two minutes,
 *     because ECS deregisters the target before it signals the container, so
 *     the sum is what has to fit. The ELB default is 300 seconds: a target
 *     group that simply says nothing exceeds the window on its own.
 *
 *   • **Will the strategy deploy at all?** A Fargate capacity provider is
 *     account-wide but does nothing until it is associated with the cluster, and
 *     a service naming `FARGATE_SPOT` on a cluster that has not associated it is
 *     rejected at `CreateService` — after the template has passed every other
 *     gate here. The cluster is in a different stack from the service for the
 *     previews, so this is resolved through the CloudFormation export rather
 *     than assumed.
 *
 *   • **Is the quiet failure still loud?** A Spot shortage produces no tasks,
 *     therefore no utilisation metrics, therefore nothing for an ordinary alarm
 *     to breach on. The alarm that catches it has to compare running tasks to
 *     desired, `FILL()` both terms, and treat missing data as breaching — and
 *     each of those three is a property somebody can soften in a console while
 *     the alarm goes on existing.
 *
 * The rules, and the failure each one prevents:
 *
 *   catalogue                       any finding from `validateSpotCatalogue`
 *   service-unclassified            an ECS service no entry claims
 *   service-ambiguous               two entries claim one service, so its
 *                                   verdict depends on iteration order
 *   service-count-drift             a matched count that is not what the entry
 *                                   declares — a stack added or gone
 *   posture-mismatch                a deployed strategy that is not the
 *                                   catalogue's, in either direction
 *   capacity-provider-unassociated  a Spot strategy on a cluster that has not
 *                                   associated FARGATE_SPOT: rejected at deploy
 *   cluster-unresolvable            a service whose cluster cannot be found, so
 *                                   the rule above could not be evaluated
 *   stop-timeout-unset              a Spot container leaving ECS's 30-second
 *                                   default, where "unexamined" and "chosen"
 *                                   produce the same template
 *   stop-timeout-mismatch           a grace period that is not the declared one
 *   deregistration-delay-unset      a Spot service's target group leaving the
 *                                   ELB default of 300s — 2.5x the whole window
 *   deregistration-delay-mismatch   a delay that is not the declared one
 *   drain-budget-exceeds-warning    the deployed sum does not fit in 120s
 *   interruption-rule-missing       a Spot cluster no rule watches, so every
 *                                   metric below is structurally zero
 *   interruption-rule-stop-code     a task-state rule with no stopCode filter,
 *                                   which counts deployments as interruptions
 *   interruption-rule-no-dlq        a rule whose undeliverable events are
 *                                   dropped rather than queued
 *   starvation-alarm-missing        a spot-with-base service with nothing
 *                                   comparing running tasks to desired
 *   starvation-alarm-not-breaching  that alarm not treating missing data as
 *                                   breaching, when absence is the symptom
 *   starvation-alarm-terms-unfilled its metric math not FILL()ed, so one silent
 *                                   input removes the whole datapoint
 *   doc-table-drift                 a published table that is not what the data
 *                                   renders
 *   audit-not-run-in-ci             this gate is not wired into a job
 *
 * Usage:
 *   npm run audit:spot                                      # repository root
 *   npx ts-node tools/audit-spot-capacity.ts <dir>
 *
 * Requires `cdk synth` to have run. Exits non-zero when anything is found.
 * See docs/spot.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  type SpotWorkload,
  FARGATE_SPOT_WARNING_SECONDS,
  SPOT_CAPACITY_PROVIDER,
  SPOT_INTERRUPTION_STOP_CODE,
  SPOT_WORKLOADS,
  postureTotals,
  renderSpotTable,
  spotWorkloadsFor,
  usesSpot,
  validateSpotCatalogue,
} from '../lib/spot-capacity';

export const SPOT_DOC_PATH = path.join('docs', 'spot.md');
export const CI_WORKFLOW_PATH = path.join('.github', 'workflows', 'ci.yml');

/** The npm script the CI job must run. */
export const AUDIT_SCRIPT = 'audit:spot';

/*
 * Restated rather than imported, for the reason `audit-runbooks.ts` gives: a
 * gate that imports the constants it checks cannot catch a change to them.
 * `test/audit-spot-capacity.test.ts` holds these against the library's exports,
 * so a deliberate rename is one failing assertion rather than a silently
 * weakened rule. The catalogue itself *is* imported, because it is the input
 * under review rather than a constant.
 */

/** ELB's default when a target group sets no deregistration delay. */
export const ELB_DEFAULT_DEREGISTRATION_DELAY = 300;

/** The target group attribute carrying it. */
export const DEREGISTRATION_DELAY_ATTRIBUTE = 'deregistration_delay.timeout_seconds';

/** Namespace and metric names the starvation alarm must be built from. */
export const CONTAINER_INSIGHTS_NAMESPACE = 'ECS/ContainerInsights';
export const RUNNING_TASK_COUNT_METRIC = 'RunningTaskCount';
export const DESIRED_TASK_COUNT_METRIC = 'DesiredTaskCount';

/** What `treatMissingData` must be on an alarm whose symptom is absence. */
export const BREACHING = 'breaching';

export type SpotRule =
  | 'catalogue'
  | 'service-unclassified'
  | 'service-ambiguous'
  | 'service-count-drift'
  | 'posture-mismatch'
  | 'capacity-provider-unassociated'
  | 'cluster-unresolvable'
  | 'stop-timeout-unset'
  | 'stop-timeout-mismatch'
  | 'deregistration-delay-unset'
  | 'deregistration-delay-mismatch'
  | 'drain-budget-exceeds-warning'
  | 'interruption-rule-missing'
  | 'interruption-rule-stop-code'
  | 'interruption-rule-no-dlq'
  | 'starvation-alarm-missing'
  | 'starvation-alarm-not-breaching'
  | 'starvation-alarm-terms-unfilled'
  | 'doc-table-drift'
  | 'audit-not-run-in-ci';

export interface SpotViolation {
  readonly rule: SpotRule;
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

export interface SpotAuditInput {
  readonly templates: readonly TemplateFile[];
  readonly spotDoc: string;
  /** Omitted skips the CI wiring rule, which is what the unit tests want. */
  readonly ciWorkflow?: string;
  /** Override the catalogue. Tests only. */
  readonly workloads?: readonly SpotWorkload[];
}

export interface SpotAuditResult {
  readonly violations: readonly SpotViolation[];
  readonly servicesRead: number;
  readonly rulesRead: number;
  readonly alarmsRead: number;
}

/* ── Template reading ─────────────────────────────────────────────────────── */

interface Resource {
  readonly Type?: string;
  readonly Properties?: Record<string, any>;
  readonly Metadata?: Record<string, any>;
}

/** A logical id in a named template: how a resolved reference is identified. */
interface ResourceRef {
  readonly file: string;
  readonly logicalId: string;
}

const resourcesOf = (document: unknown): Record<string, Resource> => {
  const resources = (document as { Resources?: unknown } | null)?.Resources;
  return resources && typeof resources === 'object' ? (resources as Record<string, Resource>) : {};
};

const outputsOf = (document: unknown): Record<string, any> => {
  const outputs = (document as { Outputs?: unknown } | null)?.Outputs;
  return outputs && typeof outputs === 'object' ? (outputs as Record<string, any>) : {};
};

/** `Stack/Construct/Resource`, minus the stack name CDK puts first. */
const constructPathOf = (resource: Resource, logicalId: string): string => {
  const metadataPath = resource.Metadata?.['aws:cdk:path'];
  if (typeof metadataPath !== 'string') return logicalId;
  return metadataPath.split('/').slice(1).join('/');
};

const stackNameOf = (file: string): string => file.replace(/\.template\.json$/, '');

/**
 * Index of every CloudFormation export in the app: export name → the resource
 * the output points at.
 *
 * Built because the preview cluster lives in `PreviewEnvironmentStack` and the
 * preview service in `PreviewPrStack-<n>`, so "does this service's cluster
 * associate FARGATE_SPOT" is a question across two templates joined by an
 * `Fn::ImportValue`. Resolving it is the difference between a rule and a rule
 * that quietly skips the one case it was written for.
 */
export const buildExportIndex = (
  templates: readonly TemplateFile[],
): Map<string, ResourceRef> => {
  const index = new Map<string, ResourceRef>();
  for (const template of templates) {
    for (const output of Object.values(outputsOf(template.document))) {
      const exportName = output?.Export?.Name;
      if (typeof exportName !== 'string') continue;
      const logicalId = referencedLogicalId(output?.Value);
      if (!logicalId) continue;
      index.set(exportName, { file: template.path, logicalId });
    }
  }
  return index;
};

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
 * Follow a template value to the resource it names, across stacks.
 *
 * Returns `undefined` for a literal — an ARN typed into context, an imported
 * cluster name — which is reported rather than skipped by the caller.
 */
export const resolveReference = (
  value: unknown,
  file: string,
  exportIndex: Map<string, ResourceRef>,
): ResourceRef | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  const importValue = object['Fn::ImportValue'];
  if (typeof importValue === 'string') return exportIndex.get(importValue);
  const logicalId = referencedLogicalId(object);
  return logicalId ? { file, logicalId } : undefined;
};

const sameRef = (left: ResourceRef | undefined, right: ResourceRef | undefined): boolean =>
  !!left && !!right && left.file === right.file && left.logicalId === right.logicalId;

/* ── The services under review ────────────────────────────────────────────── */

export interface ServiceResource {
  readonly file: string;
  readonly stackName: string;
  readonly logicalId: string;
  readonly constructPath: string;
  /** Literal `ServiceName`, where the template carries one. */
  readonly serviceName?: string;
  /** Capacity providers named in the strategy, if any. */
  readonly capacityProviders: readonly string[];
  readonly launchType?: string;
  readonly cluster?: ResourceRef;
  readonly clusterUnresolved: boolean;
  readonly taskDefinition?: ResourceRef;
  readonly targetGroups: readonly ResourceRef[];
}

export const readServices = (
  templates: readonly TemplateFile[],
  exportIndex: Map<string, ResourceRef>,
): ServiceResource[] => {
  const services: ServiceResource[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::ECS::Service') continue;
      const properties = resource.Properties ?? {};
      const strategy = Array.isArray(properties.CapacityProviderStrategy)
        ? properties.CapacityProviderStrategy
        : [];
      const cluster = resolveReference(properties.Cluster, template.path, exportIndex);
      services.push({
        file: template.path,
        stackName: stackNameOf(template.path),
        logicalId,
        constructPath: constructPathOf(resource, logicalId),
        serviceName: typeof properties.ServiceName === 'string' ? properties.ServiceName : undefined,
        capacityProviders: strategy
          .map((entry: any) => entry?.CapacityProvider)
          .filter((name: unknown): name is string => typeof name === 'string'),
        launchType: typeof properties.LaunchType === 'string' ? properties.LaunchType : undefined,
        cluster,
        clusterUnresolved: properties.Cluster !== undefined && cluster === undefined,
        taskDefinition: resolveReference(properties.TaskDefinition, template.path, exportIndex),
        targetGroups: (Array.isArray(properties.LoadBalancers) ? properties.LoadBalancers : [])
          .map((entry: any) => resolveReference(entry?.TargetGroupArn, template.path, exportIndex))
          .filter((ref: ResourceRef | undefined): ref is ResourceRef => ref !== undefined),
      });
    }
  }
  return services;
};

const resourceAt = (
  templates: readonly TemplateFile[],
  ref: ResourceRef,
): Resource | undefined => {
  const template = templates.find((candidate) => candidate.path === ref.file);
  return template ? resourcesOf(template.document)[ref.logicalId] : undefined;
};

/** Capacity providers associated with a cluster, from the association resource. */
export const associatedCapacityProviders = (
  templates: readonly TemplateFile[],
  cluster: ResourceRef,
  exportIndex: Map<string, ResourceRef>,
): readonly string[] => {
  const providers: string[] = [];
  for (const template of templates) {
    for (const resource of Object.values(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::ECS::ClusterCapacityProviderAssociations') continue;
      const associated = resolveReference(
        resource.Properties?.Cluster,
        template.path,
        exportIndex,
      );
      if (!sameRef(associated, cluster)) continue;
      for (const provider of resource.Properties?.CapacityProviders ?? []) {
        if (typeof provider === 'string') providers.push(provider);
      }
    }
  }
  return providers;
};

/** `StopTimeout` of every container in a task definition, by container name. */
export const stopTimeouts = (taskDefinition: Resource | undefined): Map<string, number | undefined> => {
  const timeouts = new Map<string, number | undefined>();
  for (const container of taskDefinition?.Properties?.ContainerDefinitions ?? []) {
    if (!container || typeof container !== 'object') continue;
    const name = typeof container.Name === 'string' ? container.Name : '(unnamed)';
    timeouts.set(name, typeof container.StopTimeout === 'number' ? container.StopTimeout : undefined);
  }
  return timeouts;
};

/** The deregistration delay a target group sets, or `undefined` for the default. */
export const deregistrationDelay = (targetGroup: Resource | undefined): number | undefined => {
  for (const attribute of targetGroup?.Properties?.TargetGroupAttributes ?? []) {
    if (attribute?.Key !== DEREGISTRATION_DELAY_ATTRIBUTE) continue;
    const value = Number(attribute?.Value);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
};

/* ── The rule, and the alarms ─────────────────────────────────────────────── */

export interface InterruptionRule {
  readonly file: string;
  readonly logicalId: string;
  readonly constructPath: string;
  readonly stopCodes: readonly string[];
  readonly clusters: readonly (ResourceRef | undefined)[];
  /** True when the pattern has no cluster filter at all, so it covers everything. */
  readonly allClusters: boolean;
  readonly targetsWithoutDlq: number;
}

/** Every rule in the app matching ECS task state changes. */
export const readInterruptionRules = (
  templates: readonly TemplateFile[],
  exportIndex: Map<string, ResourceRef>,
): InterruptionRule[] => {
  const rules: InterruptionRule[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::Events::Rule') continue;
      const pattern = resource.Properties?.EventPattern;
      if (!pattern || typeof pattern !== 'object') continue;
      const detailTypes: unknown[] = pattern['detail-type'] ?? [];
      if (!detailTypes.includes('ECS Task State Change')) continue;

      const detail = pattern.detail ?? {};
      const clusterArns: unknown[] = Array.isArray(detail.clusterArn) ? detail.clusterArn : [];
      rules.push({
        file: template.path,
        logicalId,
        constructPath: constructPathOf(resource, logicalId),
        stopCodes: (Array.isArray(detail.stopCode) ? detail.stopCode : []).filter(
          (code: unknown): code is string => typeof code === 'string',
        ),
        clusters: clusterArns.map((arn) => resolveReference(arn, template.path, exportIndex)),
        allClusters: clusterArns.length === 0,
        targetsWithoutDlq: (resource.Properties?.Targets ?? []).filter(
          (target: any) => !target?.DeadLetterConfig?.Arn,
        ).length,
      });
    }
  }
  return rules;
};

export interface StarvationAlarm {
  readonly file: string;
  readonly alarmName: string;
  readonly serviceNames: readonly string[];
  readonly treatMissingData?: string;
  readonly expressions: readonly string[];
  readonly metricNames: readonly string[];
}

/**
 * Alarms built over Container Insights' running and desired task counts.
 *
 * Matched on what they are made of rather than on their name: an alarm renamed
 * is still the alarm, and a gate keyed to `*-spot-capacity-starved` would be
 * satisfied by an empty alarm with the right name.
 */
export const readStarvationAlarms = (
  templates: readonly TemplateFile[],
): StarvationAlarm[] => {
  const alarms: StarvationAlarm[] = [];
  for (const template of templates) {
    for (const resource of Object.values(resourcesOf(template.document))) {
      if (resource.Type !== 'AWS::CloudWatch::Alarm') continue;
      const metrics = resource.Properties?.Metrics;
      if (!Array.isArray(metrics)) continue;

      const metricNames: string[] = [];
      const serviceNames: string[] = [];
      const expressions: string[] = [];
      for (const entry of metrics) {
        if (typeof entry?.Expression === 'string') expressions.push(entry.Expression);
        const metric = entry?.MetricStat?.Metric;
        if (!metric || metric.Namespace !== CONTAINER_INSIGHTS_NAMESPACE) continue;
        if (typeof metric.MetricName === 'string') metricNames.push(metric.MetricName);
        for (const dimension of metric.Dimensions ?? []) {
          if (dimension?.Name === 'ServiceName' && typeof dimension?.Value === 'string') {
            serviceNames.push(dimension.Value);
          }
        }
      }
      if (
        !metricNames.includes(RUNNING_TASK_COUNT_METRIC) ||
        !metricNames.includes(DESIRED_TASK_COUNT_METRIC)
      ) {
        continue;
      }
      alarms.push({
        file: template.path,
        alarmName:
          typeof resource.Properties?.AlarmName === 'string'
            ? resource.Properties.AlarmName
            : '(unnamed)',
        serviceNames,
        treatMissingData:
          typeof resource.Properties?.TreatMissingData === 'string'
            ? resource.Properties.TreatMissingData
            : undefined,
        expressions,
        metricNames,
      });
    }
  }
  return alarms;
};

/* ── The audit ────────────────────────────────────────────────────────────── */

export const auditSpotCapacity = (input: SpotAuditInput): SpotAuditResult => {
  const workloads = input.workloads ?? SPOT_WORKLOADS;
  const violations: SpotViolation[] = [];
  const add = (rule: SpotRule, file: string, location: string, message: string) =>
    violations.push({ rule, file, location, message });

  for (const finding of validateSpotCatalogue(workloads)) {
    add('catalogue', 'lib/spot-capacity.ts', `${finding.subject} (${finding.rule})`, finding.message);
  }

  const exportIndex = buildExportIndex(input.templates);
  const services = readServices(input.templates, exportIndex);
  const rules = readInterruptionRules(input.templates, exportIndex);
  const alarms = readStarvationAlarms(input.templates);

  const matches = new Map<string, ServiceResource[]>();

  for (const service of services) {
    const claiming = spotWorkloadsFor(service, workloads);

    if (claiming.length === 0) {
      add(
        'service-unclassified',
        service.file,
        service.constructPath,
        'No entry in SPOT_WORKLOADS matches this service, so nothing here has an opinion about ' +
          'whether it may run on reclaimable capacity. Every rule below is about services the ' +
          'catalogue knows — an unclassified one is not a gap in the report, it is a gap in the ' +
          'question. Classify it, including when the answer is "on-demand, because an objective ' +
          'is measured on it".',
      );
      continue;
    }
    if (claiming.length > 1) {
      add(
        'service-ambiguous',
        service.file,
        service.constructPath,
        `Claimed by ${claiming.length} entries (${claiming
          .map((workload) => workload.id)
          .join(', ')}), so its posture depends on which one is read first. Narrow a ` +
          'servicePathSuffix or a stackPrefixes.',
      );
      continue;
    }

    const workload = claiming[0];
    matches.set(workload.id, [...(matches.get(workload.id) ?? []), service]);

    const onSpotInTemplate = service.capacityProviders.includes(SPOT_CAPACITY_PROVIDER);
    const onSpotInCatalogue = usesSpot(workload);

    if (onSpotInTemplate !== onSpotInCatalogue) {
      add(
        'posture-mismatch',
        service.file,
        service.constructPath,
        onSpotInTemplate
          ? `The catalogue says ${workload.id} is ${workload.posture} and the template places ` +
            `tasks on ${SPOT_CAPACITY_PROVIDER}. Whatever the reason recorded against that ` +
            'entry is, this service is now exposed to it: ' +
            workload.reason
          : `The catalogue says ${workload.id} is ${workload.posture} and the template names ` +
            `${service.capacityProviders.join(', ') || `LaunchType: ${service.launchType ?? 'none'}`}` +
            '. A posture that has quietly reverted to on-demand is more expensive and perfectly ' +
            'healthy, which is why nothing else would report it.',
      );
    }

    if (!onSpotInTemplate) continue;

    // ── Will it deploy? ───────────────────────────────────────────────────
    if (service.clusterUnresolved) {
      add(
        'cluster-unresolvable',
        service.file,
        service.constructPath,
        'The Cluster property is a literal or an import nothing in this app exports, so whether ' +
          `the cluster has associated ${SPOT_CAPACITY_PROVIDER} could not be checked. Reported ` +
          'rather than skipped: an unevaluated rule and a passing one look identical in a log.',
      );
    } else if (service.cluster) {
      const associated = associatedCapacityProviders(input.templates, service.cluster, exportIndex);
      if (!associated.includes(SPOT_CAPACITY_PROVIDER)) {
        add(
          'capacity-provider-unassociated',
          service.file,
          service.constructPath,
          `Names ${SPOT_CAPACITY_PROVIDER} in its strategy, and its cluster ` +
            `(${service.cluster.file} ${service.cluster.logicalId}) associates ` +
            `${associated.join(', ') || 'nothing'}. A Fargate capacity provider is account-wide ` +
            'but does nothing until the cluster associates it, so CreateService is rejected — ' +
            'after this template has passed every other gate in this repository.',
        );
      }
    }

    // ── Does the budget fit? ──────────────────────────────────────────────
    const budget = workload.drainBudget;
    const taskDefinition = service.taskDefinition
      ? resourceAt(input.templates, service.taskDefinition)
      : undefined;

    let deployedStopTimeout: number | undefined;
    for (const [container, timeout] of stopTimeouts(taskDefinition)) {
      if (timeout === undefined) {
        add(
          'stop-timeout-unset',
          service.file,
          `${service.constructPath} container ${container}`,
          'Runs on Spot and sets no StopTimeout, so ECS uses 30 seconds — a quarter of the ' +
            'warning, and a number nobody chose. A task that needs longer is killed at second ' +
            '31 and the only trace is a task that went away, which is what a reclaim looks like ' +
            'anyway.',
        );
        continue;
      }
      deployedStopTimeout = Math.max(deployedStopTimeout ?? 0, timeout);
      if (budget && timeout !== budget.stopTimeoutSeconds) {
        add(
          'stop-timeout-mismatch',
          service.file,
          `${service.constructPath} container ${container}`,
          `StopTimeout is ${timeout}s and ${workload.id} declares ` +
            `${budget.stopTimeoutSeconds}s. The declared number is the one docs/spot.md ` +
            'publishes and the one the recorder measures overruns against, so a drift here ' +
            'makes the overrun metric a measurement of the wrong thing.',
        );
      }
    }

    let deployedDelay: number | undefined;
    for (const targetGroupRef of service.targetGroups) {
      const targetGroup = resourceAt(input.templates, targetGroupRef);
      const delay = deregistrationDelay(targetGroup);
      if (delay === undefined) {
        add(
          'deregistration-delay-unset',
          service.file,
          `${service.constructPath} → ${targetGroupRef.logicalId}`,
          `Runs on Spot behind a target group with no ${DEREGISTRATION_DELAY_ATTRIBUTE}, so ELB ` +
            `uses ${ELB_DEFAULT_DEREGISTRATION_DELAY}s. ECS deregisters the target before it ` +
            `signals the container, so that alone is ${ELB_DEFAULT_DEREGISTRATION_DELAY -
              FARGATE_SPOT_WARNING_SECONDS}s past the ${FARGATE_SPOT_WARNING_SECONDS}s warning: ` +
            'the process is killed before it is asked to stop.',
        );
        continue;
      }
      deployedDelay = Math.max(deployedDelay ?? 0, delay);
      if (budget && delay !== budget.deregistrationDelaySeconds) {
        add(
          'deregistration-delay-mismatch',
          service.file,
          `${service.constructPath} → ${targetGroupRef.logicalId}`,
          `${DEREGISTRATION_DELAY_ATTRIBUTE} is ${delay}s and ${workload.id} declares ` +
            `${budget.deregistrationDelaySeconds}s.`,
        );
      }
    }

    const deployedBudget =
      (deployedDelay ?? ELB_DEFAULT_DEREGISTRATION_DELAY) +
      (deployedStopTimeout ?? 30);
    if (deployedBudget > FARGATE_SPOT_WARNING_SECONDS) {
      add(
        'drain-budget-exceeds-warning',
        service.file,
        service.constructPath,
        `The deployed budget is ${deployedBudget}s — ${deployedDelay ?? ELB_DEFAULT_DEREGISTRATION_DELAY}s ` +
          `of deregistration then ${deployedStopTimeout ?? 30}s of grace — against a ` +
          `${FARGATE_SPOT_WARNING_SECONDS}s warning. The two do not overlap, so the overshoot ` +
          'is time the process does not get, and it ends in SIGKILL.',
      );
    }

    // ── Is anything watching? ─────────────────────────────────────────────
    const covering = rules.filter(
      (rule) =>
        rule.allClusters || rule.clusters.some((cluster) => sameRef(cluster, service.cluster)),
    );
    const watching = covering.filter((rule) =>
      rule.stopCodes.includes(SPOT_INTERRUPTION_STOP_CODE),
    );
    for (const rule of covering.filter((candidate) => !watching.includes(candidate))) {
      add(
        'interruption-rule-stop-code',
        rule.file,
        rule.constructPath,
        `Matches ECS task state changes for this service's cluster and filters on stopCode ` +
          `${rule.stopCodes.join(', ') || '(nothing)'}. Without ` +
          `${SPOT_INTERRUPTION_STOP_CODE} the pattern also matches a scale-in, a deployment ` +
          'replacing tasks, and every UserInitiated stop — so the interruption metric becomes a ' +
          'deployment counter with an alarming name, and the rate alarm fires on a busy ' +
          'release day.',
      );
    }
    if (watching.length === 0) {
      add(
        'interruption-rule-missing',
        service.file,
        service.constructPath,
        `Runs on Spot and no EventBridge rule matches stopCode ${SPOT_INTERRUPTION_STOP_CODE} for ` +
          'its cluster. Every reclaim of this service is then unrecorded, and the interruption ' +
          'and drain metrics read zero — which is exactly what a week with no reclaims looks ' +
          'like.',
      );
    }
    for (const rule of watching) {
      if (rule.targetsWithoutDlq > 0) {
        add(
          'interruption-rule-no-dlq',
          rule.file,
          rule.constructPath,
          `${rule.targetsWithoutDlq} target(s) with no dead-letter queue. An interruption event ` +
            'that cannot be delivered is a permanently missing datapoint: EventBridge does not ' +
            'keep it and the task is already gone.',
        );
      }
    }

    // ── Is the quiet failure loud? ────────────────────────────────────────
    if (workload.posture === 'spot-with-base' && service.serviceName) {
      const forThisService = alarms.filter((alarm) =>
        alarm.serviceNames.includes(service.serviceName as string),
      );
      if (forThisService.length === 0) {
        add(
          'starvation-alarm-missing',
          service.file,
          service.constructPath,
          `Nothing compares ${CONTAINER_INSIGHTS_NAMESPACE} ${RUNNING_TASK_COUNT_METRIC} with ` +
            `${DESIRED_TASK_COUNT_METRIC} for ${service.serviceName}. A Spot shortage places no ` +
            'tasks, so there are no utilisation metrics to breach a threshold on: the service ' +
            'does not go red, it goes quiet.',
        );
      }
      for (const alarm of forThisService) {
        if (alarm.treatMissingData !== BREACHING) {
          add(
            'starvation-alarm-not-breaching',
            alarm.file,
            alarm.alarmName,
            `treatMissingData is ${alarm.treatMissingData ?? 'unset (missing)'} rather than ` +
              `${BREACHING}. The symptom being looked for is the absence of the data, so an ` +
              'alarm that ignores absence is green through the outage it was written for.',
          );
        }
        const unfilled = alarm.expressions.filter(
          (expression) => !/FILL\s*\(/i.test(expression),
        );
        if (alarm.expressions.length === 0 || unfilled.length > 0) {
          add(
            'starvation-alarm-terms-unfilled',
            alarm.file,
            alarm.alarmName,
            'Its metric math does not FILL() its terms. Metric math yields no datapoint wherever ' +
              'any input is missing, so a service that stopped publishing one of the two counts ' +
              'produces an expression with no data rather than the gap the alarm is about.',
          );
        }
      }
    }
  }

  for (const workload of workloads) {
    const matched = matches.get(workload.id) ?? [];
    if (matched.length !== workload.expectedResources) {
      add(
        'service-count-drift',
        'lib/spot-capacity.ts',
        workload.id,
        `Declares expectedResources: ${workload.expectedResources} and matched ${matched.length} ` +
          `service(s) (${matched.map((service) => service.stackName).join(', ') || 'none'}). ` +
          'Either an environment was added, in which case say what posture its copy has, or a ' +
          'stack stopped synthesising and took its services out of this gate’s reach.',
      );
    }
  }

  // Rendered from the shipped catalogue rather than from `input.workloads`: the
  // published document is a statement about this repository, so a caller passing
  // a subset — every unit test — is not making a claim about the document.
  const table = renderSpotTable(SPOT_WORKLOADS);
  if (!input.spotDoc.includes(table)) {
    add(
      'doc-table-drift',
      SPOT_DOC_PATH,
      'posture table',
      'The published posture table is not what SPOT_WORKLOADS renders. It is generated rather ' +
        'than checked, so this means the document was edited by hand or the catalogue moved ' +
        'under it — and the column that goes stale first is the one a reader uses to decide ' +
        'whether their workload belongs on Spot.',
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
    rulesRead: rules.length,
    alarmsRead: alarms.length,
  };
};

export const formatViolations = (violations: readonly SpotViolation[]): string =>
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
        'this gate reads what synth wrote, because a capacity provider strategy is decided ' +
        'there.\n',
    );
    process.exit(1);
  }

  const docPath = path.join(root, SPOT_DOC_PATH);
  if (!fs.existsSync(docPath)) {
    console.error(`\n${SPOT_DOC_PATH} does not exist, and this gate reads it.\n`);
    process.exit(1);
  }

  const workflowPath = path.join(root, CI_WORKFLOW_PATH);
  const result = auditSpotCapacity({
    templates,
    spotDoc: fs.readFileSync(docPath, 'utf8'),
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
    console.error(`\n${result.violations.length} Spot capacity violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error(`\nSee ${SPOT_DOC_PATH}.\n`);
    process.exit(1);
  }

  const totals = postureTotals();
  console.log(
    `${result.servicesRead} ECS service(s) across ${templates.length} template(s), all ` +
      `classified: ${totals['spot-only']} on Spot alone, ${totals['spot-with-base']} on Spot ` +
      `above an on-demand base, ${totals['on-demand-only']} on on-demand capacity with a ` +
      'recorded reason. Every deployed strategy is the one the catalogue claims; every Spot ' +
      'cluster has associated the provider its services name; every Spot container declares a ' +
      'grace period and every target group behind one declares a deregistration delay, and both ' +
      `together fit the ${FARGATE_SPOT_WARNING_SECONDS}s warning; ${result.rulesRead} task-state ` +
      `rule(s) read, each reclaim-matching one dead-lettered; ${result.alarmsRead} ` +
      'running-versus-desired alarm(s) breach on missing data over FILL()ed terms; and the ' +
      'published table is what lib/spot-capacity.ts renders.',
  );
}
