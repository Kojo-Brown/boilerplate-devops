#!/usr/bin/env node
/**
 * Audit the multi-region synthetic canary fleet: is anything actually probing
 * from outside, and would the quorum notice if it stopped?
 *
 * Reads `cdk.out/*.template.json`, so it sees what synth wrote. The canaries
 * and the alarms that compare them are in different stacks in different
 * regions, edited independently, and joined only by a metric namespace and
 * three dimension values — which is exactly the kind of seam that reads correct
 * in both halves and reports nothing in the middle.
 *
 * ## Why the tag
 *
 * A canary belonging to this fleet and one somebody created by hand are the
 * same CloudFormation resource, so `SyntheticCanaryStack` tags the ones it owns
 * with `SyntheticCanaryFleet` and this tool reasons about those. The alarm-side
 * rules need no tag: an alarm reading `Boilerplate/SyntheticCanary` has already
 * declared itself.
 *
 * ## The rules, and the failure each one prevents
 *
 *   canary-in-vpc               a canary inside the application's VPC reaches
 *                               the load balancer through the network the
 *                               application already trusts — it sees neither
 *                               the public DNS record, nor the certificate, nor
 *                               the WAF, which are the failures only a canary
 *                               can see at all
 *   canary-missing-probe-config a probe without its assertions: an absent body
 *                               marker is a status-code-only probe, and a 200
 *                               is what a maintenance page returns
 *   canary-without-metric-grant the generated canary role allows PutMetricData
 *                               only in the CloudWatchSynthetics namespace, so
 *                               a fleet that forgot the extra statement
 *                               republishes nothing and the quorum alarm
 *                               evaluates an empty series
 *   canary-artifacts-unencrypted  run artifacts — headers, screenshots, the run
 *                               log for a production endpoint — at rest in the
 *                               clear
 *   canary-schedule-outside-range  Synthetics accepts rate(1 minute) through
 *                               rate(1 hour); outside it the canary fails to
 *                               create
 *   canary-timeout-exceeds-schedule  overlapping runs, rejected at deploy time
 *   local-alarm-missing         nothing evaluates this region's own
 *                               CloudWatchSynthetics metrics, so the fleet has
 *                               no signal that survives the aggregation region
 *   local-alarm-ignores-missing-data  a canary that has stopped running
 *                               publishes nothing, and an alarm that ignores
 *                               gaps reads that as health
 *   quorum-alarm-missing        per-region alarms with nothing comparing them:
 *                               one outage pages once per region, and a flaky
 *                               region pages the same way
 *   quorum-expression-without-fill  metric math produces no data point where
 *                               any input is missing, so one silent region
 *                               blinds the quorum alarm for all the others
 *   quorum-threshold-below-two  a quorum of one is the N-independent-alarms
 *                               behaviour the fleet exists to replace
 *   quorum-terms-below-threshold  a threshold the sum cannot reach: green
 *                               through a total outage
 *   quorum-alarm-ignores-missing-data  a fleet that is entirely silent produces
 *                               no series to fill, and that has to page
 *   heartbeat-alarm-missing     nothing watches for the absence of a verdict,
 *                               which is the failure a monitoring system is
 *                               most likely to have and least likely to report
 *   alarm-without-action        an alarm that is evaluated and tells nobody
 */
import * as fs from 'fs';
import * as path from 'path';

export type CanaryAuditRule =
  | 'canary-in-vpc'
  | 'canary-missing-probe-config'
  | 'canary-without-metric-grant'
  | 'canary-artifacts-unencrypted'
  | 'canary-schedule-outside-range'
  | 'canary-timeout-exceeds-schedule'
  | 'local-alarm-missing'
  | 'local-alarm-ignores-missing-data'
  | 'quorum-alarm-missing'
  | 'quorum-expression-without-fill'
  | 'quorum-threshold-below-two'
  | 'quorum-terms-below-threshold'
  | 'quorum-alarm-ignores-missing-data'
  | 'heartbeat-alarm-missing'
  | 'alarm-without-action';

export interface Violation {
  readonly rule: CanaryAuditRule;
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
}

export interface AuditResult {
  readonly violations: readonly Violation[];
  readonly canariesRead: number;
  readonly quorumAlarmsRead: number;
  readonly probesRead: number;
}

/* ── Contract constants, restated ─────────────────────────────────────────── */

/*
 * Restated rather than imported from `lib/`, for the reason
 * `audit-queue-tracing.ts` gives: a gate that imports the constants it checks
 * cannot catch a change to them. `test/audit-synthetic-canaries.test.ts` holds
 * these against the library's exports, so a deliberate rename is one failing
 * assertion rather than a silently weakened rule.
 */
export const CANARY_FLEET_TAG = 'SyntheticCanaryFleet';
export const CANARY_METRIC_NAMESPACE = 'Boilerplate/SyntheticCanary';
export const SYNTHETICS_NAMESPACE = 'CloudWatchSynthetics';
export const PROBE_FAILURE_METRIC = 'ProbeFailure';
export const SUCCESS_PERCENT_METRIC = 'SuccessPercent';
export const ENVIRONMENT_DIMENSION = 'Environment';
export const PROBE_DIMENSION = 'Probe';
export const REGION_DIMENSION = 'Region';
export const REQUIRED_PROBE_ENV_VARS: readonly string[] = [
  'PROBE_NAME',
  'PROBE_ENVIRONMENT',
  'PROBE_REGION',
  'PROBE_AGGREGATION_REGION',
  'PROBE_METRIC_NAMESPACE',
  'PROBE_URL',
  'PROBE_METHOD',
  'PROBE_EXPECTED_STATUS',
  'PROBE_BODY_MARKER',
  'PROBE_LATENCY_BUDGET_MS',
];
export const MIN_SCHEDULE_MINUTES = 1;
export const MAX_SCHEDULE_MINUTES = 60;
/** CloudWatch's spelling of "a gap is a breach". */
const BREACHING = 'breaching';

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

/** Render a template value as a string, with intrinsics flattened. */
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

const tagsOf = (properties: Record<string, unknown>): Map<string, string> => {
  const tags = new Map<string, string>();
  for (const entry of asList(properties.Tags)) {
    if (isRecord(entry) && typeof entry.Key === 'string') {
      tags.set(entry.Key, flatten(entry.Value));
    }
  }
  return tags;
};

const dimensionsOf = (value: unknown): Map<string, string> => {
  const dimensions = new Map<string, string>();
  for (const entry of asList(value)) {
    if (isRecord(entry) && typeof entry.Name === 'string') {
      dimensions.set(entry.Name, flatten(entry.Value));
    }
  }
  return dimensions;
};

/** Minutes in a `rate(n minute[s])` expression, or undefined for anything else. */
export const scheduleMinutesOf = (expression: string): number | undefined => {
  const rate = /^rate\((\d+)\s+minutes?\)$/.exec(expression.trim());
  if (rate) return Number(rate[1]);
  const hours = /^rate\((\d+)\s+hours?\)$/.exec(expression.trim());
  if (hours) return Number(hours[1]) * 60;
  return undefined;
};

/* ── Model ────────────────────────────────────────────────────────────────── */

interface CanaryRecord {
  readonly file: string;
  readonly id: string;
  readonly name: string;
  readonly properties: Record<string, unknown>;
  readonly env: Map<string, string>;
}

interface AlarmRecord {
  readonly file: string;
  readonly id: string;
  readonly properties: Record<string, unknown>;
}

const alarmHasAction = (properties: Record<string, unknown>): boolean =>
  asList(properties.AlarmActions).length > 0;

const alarmName = (properties: Record<string, unknown>, fallback: string): string =>
  typeof properties.AlarmName === 'string' ? properties.AlarmName : fallback;

interface MetricView {
  readonly namespace: string;
  readonly metricName: string;
  readonly dimensions: Map<string, string>;
  readonly statistic: string;
}

/**
 * The single metric an alarm evaluates, or `undefined` when it evaluates an
 * expression.
 *
 * Two template shapes mean the same thing, and which one CloudFormation gets is
 * decided by details that have nothing to do with the alarm's meaning: CDK
 * renders the flat `Namespace`/`MetricName`/`Dimensions` properties normally,
 * and the `Metrics` array as soon as the metric carries a label, an account or
 * a region. A gate that understood only the flat shape would go quiet the day
 * somebody added a legend label — quiet in the direction of reporting nothing.
 */
const singleMetricOf = (properties: Record<string, unknown>): MetricView | undefined => {
  const members = asList(properties.Metrics).filter(isRecord);

  if (members.length === 0) {
    return {
      namespace: flatten(properties.Namespace),
      metricName: flatten(properties.MetricName),
      dimensions: dimensionsOf(properties.Dimensions),
      statistic: flatten(properties.Statistic) || flatten(properties.ExtendedStatistic),
    };
  }

  if (members.some((member) => typeof member.Expression === 'string')) return undefined;

  const returned =
    members.find((member) => member.ReturnData !== false) ?? members[0];
  const metricStat = isRecord(returned.MetricStat) ? returned.MetricStat : {};
  const metric = isRecord(metricStat.Metric) ? metricStat.Metric : {};
  return {
    namespace: flatten(metric.Namespace),
    metricName: flatten(metric.MetricName),
    dimensions: dimensionsOf(metric.Dimensions),
    statistic: flatten(metricStat.Stat),
  };
};

/** Expression members of a math alarm, empty for a single-metric alarm. */
const expressionsOf = (properties: Record<string, unknown>): Record<string, unknown>[] =>
  asList(properties.Metrics)
    .filter(isRecord)
    .filter((member) => typeof member.Expression === 'string');

/** The metrics a math alarm's expression is built from. */
const statMembersOf = (properties: Record<string, unknown>): Record<string, unknown>[] =>
  asList(properties.Metrics)
    .filter(isRecord)
    .filter((member) => isRecord(member.MetricStat));

/**
 * Statements granting `cloudwatch:PutMetricData` in a namespace, by the role
 * logical id they are attached to.
 *
 * Both shapes matter: the generated canary role carries inline `Policies`, and
 * `addToPrincipalPolicy` attaches a separate `AWS::IAM::Policy`. A fleet that
 * has one and not the other still republishes nothing.
 */
const metricGrantsByRole = (templates: readonly TemplateFile[]): Map<string, Set<string>> => {
  const grants = new Map<string, Set<string>>();

  const record = (roleId: string, statements: unknown): void => {
    for (const statement of asList(statements)) {
      if (!isRecord(statement)) continue;
      const actions = asList(statement.Action).map(flatten);
      if (!actions.includes('cloudwatch:PutMetricData')) continue;
      const condition = isRecord(statement.Condition) ? statement.Condition : {};
      const stringEquals = isRecord(condition.StringEquals) ? condition.StringEquals : {};
      const namespaces = asList(stringEquals['cloudwatch:namespace']).map(flatten);
      const known = grants.get(roleId) ?? new Set<string>();
      // No condition at all is a grant in every namespace, ours included.
      if (namespaces.length === 0) known.add('*');
      for (const namespace of namespaces) known.add(namespace);
      grants.set(roleId, known);
    }
  };

  for (const template of templates) {
    for (const resource of resourcesOf(template)) {
      if (resource.type === 'AWS::IAM::Role') {
        for (const policy of asList(resource.properties.Policies)) {
          if (!isRecord(policy) || !isRecord(policy.PolicyDocument)) continue;
          record(resource.id, policy.PolicyDocument.Statement);
        }
      }
      if (resource.type === 'AWS::IAM::Policy') {
        const document = isRecord(resource.properties.PolicyDocument)
          ? resource.properties.PolicyDocument
          : undefined;
        if (document === undefined) continue;
        for (const role of asList(resource.properties.Roles)) {
          record(flatten(role), document.Statement);
        }
      }
    }
  }

  return grants;
};

/* ── The audit ────────────────────────────────────────────────────────────── */

export const auditSyntheticCanaries = (input: AuditInput): AuditResult => {
  const violations: Violation[] = [];
  const add = (
    rule: CanaryAuditRule,
    file: string,
    location: string,
    message: string,
  ): void => {
    violations.push({ rule, file, location, message });
  };

  const canaries: CanaryRecord[] = [];
  const alarms: AlarmRecord[] = [];

  for (const template of input.templates) {
    for (const resource of resourcesOf(template)) {
      if (resource.type === 'AWS::Synthetics::Canary') {
        if (!tagsOf(resource.properties).has(CANARY_FLEET_TAG)) continue;
        const runConfig = isRecord(resource.properties.RunConfig)
          ? resource.properties.RunConfig
          : {};
        const env = new Map<string, string>();
        if (isRecord(runConfig.EnvironmentVariables)) {
          for (const [key, value] of Object.entries(runConfig.EnvironmentVariables)) {
            env.set(key, flatten(value));
          }
        }
        canaries.push({
          file: template.path,
          id: resource.id,
          name: flatten(resource.properties.Name),
          properties: resource.properties,
          env,
        });
      }
      if (resource.type === 'AWS::CloudWatch::Alarm') {
        alarms.push({ file: template.path, id: resource.id, properties: resource.properties });
      }
    }
  }

  const grants = metricGrantsByRole(input.templates);

  /* ── Canary-side rules ──────────────────────────────────────────────────── */

  for (const canary of canaries) {
    const where = canary.name === '' ? canary.id : canary.name;

    if (canary.properties.VPCConfig !== undefined) {
      add(
        'canary-in-vpc',
        canary.file,
        where,
        'runs inside a VPC. It then reaches the application over the network the application ' +
          'already trusts, so it cannot observe the public DNS record, the certificate a ' +
          'browser is served, or anything in front of the load balancer — which is most of ' +
          'what a synthetic canary is for.',
      );
    }

    const missing = REQUIRED_PROBE_ENV_VARS.filter((name) => (canary.env.get(name) ?? '') === '');
    if (missing.length > 0) {
      add(
        'canary-missing-probe-config',
        canary.file,
        where,
        `no value for ${missing.join(', ')}. A probe missing PROBE_BODY_MARKER is a ` +
          'status-code-only probe, and a maintenance page, a cached CDN error page and an ' +
          'application shell whose data fetch failed all return 200.',
      );
    }

    const roleId = flatten(canary.properties.ExecutionRoleArn);
    const namespaces = grants.get(roleId) ?? new Set<string>();
    if (!namespaces.has(CANARY_METRIC_NAMESPACE) && !namespaces.has('*')) {
      add(
        'canary-without-metric-grant',
        canary.file,
        where,
        `its role (${roleId}) may not PutMetricData in ${CANARY_METRIC_NAMESPACE}. The generated ` +
          `canary role is conditioned on the ${SYNTHETICS_NAMESPACE} namespace, so without an ` +
          'added statement every run is denied at the republish and the quorum alarm in the ' +
          'aggregation region evaluates a series that is never written.',
      );
    }

    const artifactConfig = isRecord(canary.properties.ArtifactConfig)
      ? canary.properties.ArtifactConfig
      : undefined;
    const s3Encryption =
      artifactConfig !== undefined && isRecord(artifactConfig.S3Encryption)
        ? artifactConfig.S3Encryption
        : undefined;
    if (s3Encryption === undefined || flatten(s3Encryption.EncryptionMode) === '') {
      add(
        'canary-artifacts-unencrypted',
        canary.file,
        where,
        'no artifact encryption mode. Run artifacts hold the response headers, screenshots and ' +
          'the full run log for a production endpoint, kept for as long as the retention ' +
          'policy says.',
      );
    }

    const schedule = isRecord(canary.properties.Schedule) ? canary.properties.Schedule : {};
    const minutes = scheduleMinutesOf(flatten(schedule.Expression));
    if (minutes === undefined || minutes < MIN_SCHEDULE_MINUTES || minutes > MAX_SCHEDULE_MINUTES) {
      add(
        'canary-schedule-outside-range',
        canary.file,
        where,
        `schedule ${JSON.stringify(flatten(schedule.Expression))} is not a rate() between ` +
          `${MIN_SCHEDULE_MINUTES} and ${MAX_SCHEDULE_MINUTES} minutes, which is the range ` +
          'Synthetics accepts.',
      );
    }

    const runConfig = isRecord(canary.properties.RunConfig) ? canary.properties.RunConfig : {};
    const timeout = Number(flatten(runConfig.TimeoutInSeconds));
    if (minutes !== undefined && Number.isFinite(timeout) && timeout > minutes * 60) {
      add(
        'canary-timeout-exceeds-schedule',
        canary.file,
        where,
        `a ${timeout}s timeout on a ${minutes}-minute schedule: runs would overlap, and ` +
          'Synthetics rejects it at deploy time.',
      );
    }

    const local = alarms.filter((alarm) => {
      const view = singleMetricOf(alarm.properties);
      if (view === undefined) return false;
      if (view.namespace !== SYNTHETICS_NAMESPACE) return false;
      if (view.metricName !== SUCCESS_PERCENT_METRIC) return false;
      return view.dimensions.get('CanaryName') === canary.id;
    });

    if (local.length === 0) {
      add(
        'local-alarm-missing',
        canary.file,
        where,
        `nothing evaluates its ${SYNTHETICS_NAMESPACE} ${SUCCESS_PERCENT_METRIC}. That is the ` +
          'only signal for this probe that does not depend on the cross-region republish, on ' +
          'the aggregation region, or on the metric math — so without it the fleet has a single ' +
          'point of failure and no fallback.',
      );
    }

    for (const alarm of local) {
      if (flatten(alarm.properties.TreatMissingData) !== BREACHING) {
        add(
          'local-alarm-ignores-missing-data',
          alarm.file,
          alarmName(alarm.properties, alarm.id),
          'treats missing data as anything but breaching. A canary that has stopped running ' +
            'publishes nothing at all, and to this alarm that is indistinguishable from a run ' +
            'that passed.',
        );
      }
      if (!alarmHasAction(alarm.properties)) {
        add(
          'alarm-without-action',
          alarm.file,
          alarmName(alarm.properties, alarm.id),
          'has no alarm action: it is evaluated and tells nobody.',
        );
      }
    }
  }

  /* ── Alarm-side rules ───────────────────────────────────────────────────── */

  /** Probes seen on the alarm side, as `environment/probe` → regions. */
  const regionalByProbe = new Map<string, Set<string>>();
  const heartbeatByProbe = new Map<string, Set<string>>();
  const quorumByProbe = new Map<string, AlarmRecord[]>();

  const probeKey = (dimensions: Map<string, string>): string | undefined => {
    const environment = dimensions.get(ENVIRONMENT_DIMENSION);
    const probe = dimensions.get(PROBE_DIMENSION);
    return environment === undefined || probe === undefined ? undefined : `${environment}/${probe}`;
  };

  for (const alarm of alarms) {
    const view = singleMetricOf(alarm.properties);

    if (view !== undefined) {
      if (view.namespace !== CANARY_METRIC_NAMESPACE) continue;
      if (view.metricName !== PROBE_FAILURE_METRIC) continue;
      const key = probeKey(view.dimensions);
      const region = view.dimensions.get(REGION_DIMENSION);
      if (key === undefined || region === undefined) continue;

      const statistic = view.statistic;
      const bucket = statistic === 'SampleCount' ? heartbeatByProbe : regionalByProbe;
      const regions = bucket.get(key) ?? new Set<string>();
      regions.add(region);
      bucket.set(key, regions);

      if (statistic === 'SampleCount' && flatten(alarm.properties.TreatMissingData) !== BREACHING) {
        add(
          'heartbeat-alarm-missing',
          alarm.file,
          alarmName(alarm.properties, alarm.id),
          'watches the sample count but does not treat missing data as breaching, which is the ' +
            'only thing it was for: no samples at all is precisely the state it has to report.',
        );
      }

      if (!alarmHasAction(alarm.properties)) {
        add(
          'alarm-without-action',
          alarm.file,
          alarmName(alarm.properties, alarm.id),
          'has no alarm action: it is evaluated and tells nobody.',
        );
      }
      continue;
    }

    // A math alarm. It is one of ours when its member metrics are.
    const expressions = expressionsOf(alarm.properties);
    const keys = new Set<string>();
    for (const member of statMembersOf(alarm.properties)) {
      const metricStat = member.MetricStat as Record<string, unknown>;
      const metric = isRecord(metricStat.Metric) ? metricStat.Metric : {};
      if (flatten(metric.Namespace) !== CANARY_METRIC_NAMESPACE) continue;
      if (flatten(metric.MetricName) !== PROBE_FAILURE_METRIC) continue;
      const key = probeKey(dimensionsOf(metric.Dimensions));
      if (key !== undefined) keys.add(key);
    }
    if (keys.size === 0) continue;

    for (const key of keys) {
      quorumByProbe.set(key, [...(quorumByProbe.get(key) ?? []), alarm]);
    }

    const where = alarmName(alarm.properties, alarm.id);
    const threshold = Number(flatten(alarm.properties.Threshold));

    for (const member of expressions) {
      const expression = String(member.Expression);
      const terms = expression.split('+').map((term) => term.trim());
      const unfilled = terms.filter((term) => !/^FILL\(\s*\w+\s*,/.test(term));
      if (unfilled.length > 0) {
        add(
          'quorum-expression-without-fill',
          alarm.file,
          where,
          `${unfilled.join(', ')} is summed without FILL(). CloudWatch metric math yields no ` +
            'data point where any input is missing, so a single region whose canary has stopped ' +
            'reporting removes the quorum alarm for every other region at the same time.',
        );
      }
      if (Number.isFinite(threshold) && terms.length < threshold) {
        add(
          'quorum-terms-below-threshold',
          alarm.file,
          where,
          `${terms.length} region term(s) summed against a threshold of ${threshold}: the ` +
            'expression can never reach it, so the alarm stays green through a total outage.',
        );
      }
    }

    if (Number.isFinite(threshold) && threshold < 2) {
      add(
        'quorum-threshold-below-two',
        alarm.file,
        where,
        `a quorum threshold of ${threshold} pages whenever any single region fails, which is ` +
          'the behaviour the per-region ticket alarms already have and the quorum exists to ' +
          'replace.',
      );
    }

    if (flatten(alarm.properties.TreatMissingData) !== BREACHING) {
      add(
        'quorum-alarm-ignores-missing-data',
        alarm.file,
        where,
        'does not treat missing data as breaching. FILL() covers a gap inside a series that has ' +
          'data; a fleet that has gone entirely silent produces no series to fill, and that is ' +
          'the case that most needs to page.',
      );
    }

    if (!alarmHasAction(alarm.properties)) {
      add(
        'alarm-without-action',
        alarm.file,
        where,
        'has no alarm action: it is evaluated and tells nobody.',
      );
    }
  }

  for (const [key, regions] of regionalByProbe) {
    if (!quorumByProbe.has(key)) {
      add(
        'quorum-alarm-missing',
        '(fleet)',
        key,
        `has per-region alarms for ${[...regions].sort().join(', ')} and nothing comparing them. ` +
          'One outage then pages once per region and one flaky region pages the same way, which ' +
          'is the ambiguity multiple regions were supposed to resolve.',
      );
    }
    const silent = [...regions].filter((region) => !(heartbeatByProbe.get(key)?.has(region)));
    if (silent.length > 0) {
      add(
        'heartbeat-alarm-missing',
        '(fleet)',
        key,
        `nothing reports the absence of a verdict from ${silent.sort().join(', ')}. A canary ` +
          'that stopped running is the failure a monitoring system is most likely to have and ' +
          'least likely to notice, because every threshold on it reads no data as no failures.',
      );
    }
  }

  return {
    violations,
    canariesRead: canaries.length,
    quorumAlarmsRead: [...quorumByProbe.values()].reduce((total, list) => total + list.length, 0),
    probesRead: regionalByProbe.size,
  };
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

  const result = auditSyntheticCanaries({ templates });

  if (result.canariesRead === 0) {
    console.error(
      `\nNo canaries tagged ${CANARY_FLEET_TAG} in ${templates.length} template(s). Either the ` +
        'fleet was removed or the tag was, and the second case leaves every rule below ' +
        'unevaluated while this gate stays green.\n',
    );
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} synthetic canary violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error('\nSee docs/synthetic-canaries.md.\n');
    process.exit(1);
  }

  console.log(
    `${result.canariesRead} canary/canaries across ${templates.length} template(s), and ` +
      `${result.probesRead} probe(s) compared by ${result.quorumAlarmsRead} quorum alarm(s): ` +
      'every canary probes from outside a VPC with its assertions configured and a grant to ' +
      'republish them, every region has a local alarm that treats silence as a breach, and ' +
      'every probe has a quorum alarm summing FILL()ed regional terms plus a heartbeat alarm ' +
      'per region.',
  );
}
