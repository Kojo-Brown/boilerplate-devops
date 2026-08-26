import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import {
  CHARTS_DIRECTORY,
  ENVIRONMENTS,
  EnvironmentValues,
  LoadedChart,
  Violation,
  ViolationRule,
  auditChart,
  auditChartMetadata,
  auditEnvironment,
  auditPodSecurity,
  auditSchemaHygiene,
  coalesceValues,
  compileSchema,
  formatViolations,
  nullifiedPaths,
  readCharts,
  replicaFloor,
} from '../tools/audit-helm-values';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_CHART = path.join(REPO_ROOT, 'k8s', 'charts', 'app');

const rules = (violations: readonly Violation[]): ViolationRule[] => violations.map((v) => v.rule);

const yaml = (file: string): Record<string, unknown> =>
  load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

const json = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;

/** A chart whose every part is valid. Individual tests break one thing at a time. */
const CONFORMING_CHART: LoadedChart = {
  name: 'app',
  directory: 'k8s/charts/app',
  chart: {
    apiVersion: 'v2',
    name: 'app',
    version: '0.1.0',
    appVersion: '0.1.0',
    kubeVersion: '>=1.28.0-0',
  },
  values: { environment: 'staging', replicaCount: 2 },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      environment: { type: 'string', enum: ['staging', 'production'] },
      replicaCount: { type: 'integer', minimum: 1 },
    },
  },
  environments: ENVIRONMENTS.map((environment) => ({
    environment,
    path: `k8s/charts/app/values-${environment}.yaml`,
    document: { environment, replicaCount: 2 },
  })),
  orphanEnvironmentFiles: [],
};

const chartWith = (overrides: Partial<LoadedChart>): LoadedChart => ({
  ...CONFORMING_CHART,
  ...overrides,
});

const environmentWith = (
  environment: string,
  document: unknown,
): EnvironmentValues => ({
  environment,
  path: `k8s/charts/app/values-${environment}.yaml`,
  document,
});

describe('coalesceValues', () => {
  it('merges maps key by key at every depth', () => {
    const merged = coalesceValues(
      { resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '256Mi' } } },
      { resources: { requests: { cpu: '500m' } } },
    );

    expect(merged).toEqual({
      resources: { requests: { cpu: '500m', memory: '256Mi' }, limits: { memory: '256Mi' } },
    });
  });

  it('replaces arrays wholesale rather than merging them', () => {
    const merged = coalesceValues({ tolerations: [{ key: 'a' }, { key: 'b' }] }, { tolerations: [{ key: 'c' }] });

    expect(merged).toEqual({ tolerations: [{ key: 'c' }] });
  });

  it('deletes a key set to null instead of overriding it', () => {
    const merged = coalesceValues({ resources: { limits: { memory: '256Mi' } } }, { resources: null });

    expect(merged).toEqual({});
  });

  it('leaves the base untouched', () => {
    const base = { config: { LOG_LEVEL: 'info' } };
    coalesceValues(base, { config: { LOG_LEVEL: 'debug' } });

    expect(base).toEqual({ config: { LOG_LEVEL: 'info' } });
  });
});

describe('nullifiedPaths', () => {
  it('reports nested nulls by dotted path', () => {
    expect(nullifiedPaths({ a: null, b: { c: null, d: 1 }, e: [null] })).toEqual(['a', 'b.c']);
  });

  it('reports nothing for a document with no nulls', () => {
    expect(nullifiedPaths({ a: 1, b: { c: 'x' } })).toEqual([]);
  });
});

describe('auditSchemaHygiene', () => {
  const hygiene = (schema: unknown): ViolationRule[] =>
    rules(auditSchemaHygiene(schema, 'values.schema.json'));

  it('accepts an object that closes with additionalProperties: false', () => {
    expect(hygiene({ type: 'object', additionalProperties: false, properties: {} })).toEqual([]);
  });

  it('accepts a free-form map that types its additional properties', () => {
    expect(hygiene({ type: 'object', additionalProperties: { type: 'string' } })).toEqual([]);
  });

  it('flags an object that says nothing about unknown keys', () => {
    expect(hygiene({ type: 'object', properties: { a: { type: 'string' } } })).toEqual([
      'schema-open-object',
    ]);
  });

  it('flags additionalProperties: true, which is the same permission written out', () => {
    expect(hygiene({ type: 'object', additionalProperties: true })).toEqual(['schema-open-object']);
  });

  it('reaches objects nested under properties, items, definitions and combinators', () => {
    const open = { type: 'object' };

    expect(hygiene({ type: 'object', additionalProperties: false, properties: { a: open } })).toEqual([
      'schema-open-object',
    ]);
    expect(hygiene({ type: 'array', items: open })).toEqual(['schema-open-object']);
    expect(hygiene({ definitions: { thing: open } })).toEqual(['schema-open-object']);
    expect(hygiene({ oneOf: [{ type: 'string' }, open] })).toEqual(['schema-open-object']);
    expect(hygiene({ type: 'object', additionalProperties: open })).toEqual(['schema-open-object']);
  });

  it('names the JSON pointer of the offending node', () => {
    const [violation] = auditSchemaHygiene(
      { type: 'object', additionalProperties: false, properties: { image: { type: 'object' } } },
      'values.schema.json',
    );

    expect(violation.message).toContain('#/properties/image');
  });
});

describe('auditChartMetadata', () => {
  const metadata = (overrides: Record<string, unknown>): ViolationRule[] =>
    rules(
      auditChartMetadata(
        { apiVersion: 'v2', name: 'app', version: '0.1.0', appVersion: '0.1.0', kubeVersion: '>=1.28.0-0', ...overrides },
        'app',
        'Chart.yaml',
      ),
    );

  it('accepts a complete v2 chart whose name matches its directory', () => {
    expect(metadata({})).toEqual([]);
  });

  it.each([
    ['apiVersion', { apiVersion: 'v1' }],
    ['name', { name: 'application' }],
    ['version', { version: '^0.1.0' }],
    ['appVersion', { appVersion: undefined }],
    ['kubeVersion', { kubeVersion: undefined }],
  ])('flags %s', (_field, overrides) => {
    expect(metadata(overrides)).toEqual(['chart-metadata']);
  });

  it('flags a Chart.yaml that is not a mapping', () => {
    expect(rules(auditChartMetadata('app', 'app', 'Chart.yaml'))).toEqual(['chart-metadata']);
  });
});

describe('auditEnvironment', () => {
  const defaults = {
    environment: 'staging',
    replicaCount: 2,
    podDisruptionBudget: { enabled: true, minAvailable: 1 },
  };

  const validate = compileSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      environment: { type: 'string', enum: ['staging', 'production'] },
      replicaCount: { type: 'integer', minimum: 1 },
      podDisruptionBudget: {
        type: 'object',
        additionalProperties: false,
        properties: { enabled: { type: 'boolean' }, minAvailable: { type: 'integer' } },
      },
    },
    required: ['environment', 'replicaCount'],
  });

  const audit = (environment: string, document: unknown): ViolationRule[] =>
    rules(auditEnvironment(environmentWith(environment, document), defaults, validate));

  it('accepts a file that declares its own environment and overrides nothing else', () => {
    expect(audit('production', { environment: 'production', replicaCount: 3 })).toEqual([]);
  });

  it('flags a file that leaves the environment to the chart default', () => {
    expect(audit('production', { replicaCount: 3 })).toEqual(['environment-not-declared']);
  });

  it('flags a file whose environment disagrees with its filename', () => {
    expect(audit('production', { environment: 'staging', replicaCount: 3 })).toEqual([
      'environment-mismatch',
    ]);
  });

  it('flags a values file that is not a mapping', () => {
    expect(audit('staging', null)).toEqual(['values-not-a-map']);
  });

  it('flags a nullified key, and reports the required-key failure it causes', () => {
    expect(audit('staging', { environment: 'staging', replicaCount: null })).toEqual([
      'nullified-key',
      'schema-violation',
    ]);
  });

  it('validates the merged result, not the environment file alone', () => {
    // A file that sets only `environment` is a fragment no schema would accept
    // on its own — `replicaCount` is required and absent — and is valid once
    // merged, which is the only form Helm ever installs.
    expect(audit('staging', { environment: 'staging' })).toEqual([]);
    expect(audit('staging', { environment: 'staging', podDisruptionBudget: { enabled: 'yes' } })).toEqual([
      'schema-violation',
    ]);
  });

  it('flags a disruption budget that permits no disruption', () => {
    expect(
      audit('staging', {
        environment: 'staging',
        replicaCount: 2,
        podDisruptionBudget: { enabled: true, minAvailable: 2 },
      }),
    ).toEqual(['budget-blocks-drain']);
  });

  it('does not flag a disabled budget', () => {
    expect(
      audit('staging', {
        environment: 'staging',
        replicaCount: 1,
        podDisruptionBudget: { enabled: false, minAvailable: 5 },
      }),
    ).toEqual([]);
  });

  it('treats an unset minAvailable as the chart default of one', () => {
    expect(
      audit('staging', {
        environment: 'staging',
        replicaCount: 1,
        podDisruptionBudget: { enabled: true },
      }),
    ).toEqual(['budget-blocks-drain']);
  });

  it('flags a single production replica', () => {
    expect(
      audit('production', {
        environment: 'production',
        replicaCount: 1,
        podDisruptionBudget: { enabled: false },
      }),
    ).toEqual(['single-replica']);
  });

  it('allows a single staging replica', () => {
    expect(
      audit('staging', {
        environment: 'staging',
        replicaCount: 1,
        podDisruptionBudget: { enabled: false },
      }),
    ).toEqual([]);
  });
});

describe('auditEnvironment with an HPA', () => {
  const defaults = {
    environment: 'staging',
    replicaCount: 2,
    autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 6 },
    podDisruptionBudget: { enabled: true, minAvailable: 1 },
  };

  const validate = compileSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      environment: { type: 'string', enum: ['staging', 'production'] },
      replicaCount: { type: 'integer', minimum: 1 },
      autoscaling: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          minReplicas: { type: 'integer', minimum: 1 },
          maxReplicas: { type: 'integer', minimum: 1 },
        },
      },
      podDisruptionBudget: {
        type: 'object',
        additionalProperties: false,
        properties: { enabled: { type: 'boolean' }, minAvailable: { type: 'integer' } },
      },
    },
    required: ['environment', 'replicaCount'],
  });

  const audit = (environment: string, document: unknown): ViolationRule[] =>
    rules(auditEnvironment(environmentWith(environment, document), defaults, validate));

  it('accepts a coherent autoscaled environment', () => {
    expect(
      audit('production', {
        environment: 'production',
        replicaCount: 4,
        autoscaling: { minReplicas: 4, maxReplicas: 20 },
        podDisruptionBudget: { enabled: true, minAvailable: 3 },
      }),
    ).toEqual([]);
  });

  it('checks the disruption budget against minReplicas, not replicaCount', () => {
    // Eight nominal replicas make `minAvailable: 4` look generous. The HPA can
    // take the fleet to 4, and at that size the budget permits no disruption at
    // all — which is when the 4am drain arrives.
    expect(
      audit('production', {
        environment: 'production',
        replicaCount: 8,
        autoscaling: { minReplicas: 4, maxReplicas: 20 },
        podDisruptionBudget: { enabled: true, minAvailable: 4 },
      }),
    ).toEqual(['budget-blocks-drain']);
  });

  it('names the floor it used, so the message points at the value to change', () => {
    const [violation] = auditEnvironment(
      environmentWith('production', {
        environment: 'production',
        replicaCount: 8,
        autoscaling: { minReplicas: 4, maxReplicas: 20 },
        podDisruptionBudget: { enabled: true, minAvailable: 4 },
      }),
      defaults,
      validate,
    );

    expect(violation.message).toContain('autoscaling.minReplicas 4');
  });

  it('falls back to replicaCount when the HPA is disabled', () => {
    expect(
      audit('production', {
        environment: 'production',
        replicaCount: 2,
        autoscaling: { enabled: false, minReplicas: 8, maxReplicas: 20 },
        podDisruptionBudget: { enabled: true, minAvailable: 2 },
      }),
    ).toEqual(['budget-blocks-drain']);
  });

  it('flags a production floor of one even when replicaCount is higher', () => {
    expect(
      audit('production', {
        environment: 'production',
        replicaCount: 6,
        autoscaling: { minReplicas: 1, maxReplicas: 20 },
        podDisruptionBudget: { enabled: false },
      }),
    ).toEqual(['single-replica']);
  });

  it('flags an HPA whose ceiling is not above its floor', () => {
    expect(
      audit('staging', {
        environment: 'staging',
        replicaCount: 3,
        autoscaling: { minReplicas: 3, maxReplicas: 3 },
        podDisruptionBudget: { enabled: false },
      }),
    ).toEqual(['autoscaling-bounds']);
  });

  it('flags a replicaCount outside the range the HPA would enforce', () => {
    // Inert while the HPA is on, and the fleet size the moment it is turned
    // off — so it is only ever wrong in the middle of a change.
    expect(
      audit('staging', {
        environment: 'staging',
        replicaCount: 12,
        autoscaling: { minReplicas: 2, maxReplicas: 6 },
        podDisruptionBudget: { enabled: false },
      }),
    ).toEqual(['replica-count-outside-range']);
  });

  it('leaves replicaCount alone when the HPA is disabled', () => {
    expect(
      audit('staging', {
        environment: 'staging',
        replicaCount: 12,
        autoscaling: { enabled: false, minReplicas: 2, maxReplicas: 6 },
        podDisruptionBudget: { enabled: false },
      }),
    ).toEqual([]);
  });
});

describe('auditPodSecurity', () => {
  /**
   * A container context the schema is happy with. Each test breaks one thing,
   * so what a case asserts is the rule named in its title and not the shape of
   * the fixture around it.
   */
  const HARDENED = {
    containerPort: 8080,
    securityContext: {
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'], add: [] as string[] },
    },
    writableVolumes: [{ name: 'tmp', mountPath: '/tmp', sizeLimit: '64Mi' }],
  };

  const security = (overrides: Record<string, unknown>): ViolationRule[] =>
    rules(auditPodSecurity({ ...HARDENED, ...overrides }, 'k8s/charts/app/values-staging.yaml'));

  const withCapabilities = (add: string[]): Record<string, unknown> => ({
    securityContext: { ...HARDENED.securityContext, capabilities: { drop: ['ALL'], add } },
  });

  it('accepts a hardened container on an unprivileged port', () => {
    expect(security({})).toEqual([]);
  });

  it('flags a capability granted back after dropping ALL', () => {
    expect(security(withCapabilities(['SYS_ADMIN']))).toEqual(['capability-added-back']);
  });

  it('reports every added capability, not just the first', () => {
    expect(security(withCapabilities(['SYS_ADMIN', 'SYS_PTRACE']))).toEqual([
      'capability-added-back',
      'capability-added-back',
    ]);
  });

  it('points at the escape hatch rather than only refusing', () => {
    const [violation] = auditPodSecurity(
      { ...HARDENED, ...withCapabilities(['SYS_TIME']) },
      'k8s/charts/app/values-staging.yaml',
    );

    expect(violation.message).toContain('ALLOWED_ADDED_CAPABILITIES');
  });

  it('allows NET_BIND_SERVICE for a container that actually binds a privileged port', () => {
    expect(security({ containerPort: 80, ...withCapabilities(['NET_BIND_SERVICE']) })).toEqual([]);
  });

  it('flags a privileged port the container cannot bind', () => {
    // Admitted, rolled out, and then EACCES on bind(). Nothing between the
    // values file and the CrashLoopBackOff says so.
    expect(security({ containerPort: 80 })).toEqual(['privileged-port-unbindable']);
  });

  it('treats 1024 itself as unprivileged, which is where the kernel puts it', () => {
    expect(security({ containerPort: 1024 })).toEqual([]);
    expect(security({ containerPort: 1023 })).toEqual(['privileged-port-unbindable']);
  });

  it('flags NET_BIND_SERVICE granted to a container that does not need it', () => {
    expect(security(withCapabilities(['NET_BIND_SERVICE']))).toEqual(['unnecessary-capability']);
  });

  it('flags two scratch volumes mounted on one path', () => {
    expect(
      security({
        writableVolumes: [
          { name: 'tmp', mountPath: '/tmp', sizeLimit: '64Mi' },
          { name: 'cache', mountPath: '/tmp', sizeLimit: '128Mi' },
        ],
      }),
    ).toEqual(['duplicate-writable-mount']);
  });

  it('flags two scratch volumes sharing a name', () => {
    expect(
      security({
        writableVolumes: [
          { name: 'tmp', mountPath: '/tmp', sizeLimit: '64Mi' },
          { name: 'tmp', mountPath: '/var/run', sizeLimit: '8Mi' },
        ],
      }),
    ).toEqual(['duplicate-writable-mount']);
  });

  it('accepts distinct scratch volumes', () => {
    expect(
      security({
        writableVolumes: [
          { name: 'tmp', mountPath: '/tmp', sizeLimit: '64Mi' },
          { name: 'run', mountPath: '/var/run', sizeLimit: '8Mi' },
        ],
      }),
    ).toEqual([]);
  });

  it('reports nothing rather than throwing on values the schema would have rejected', () => {
    // This runs on merged values before anything guarantees the schema passed,
    // so every read has to survive the wrong type.
    expect(
      rules(
        auditPodSecurity(
          { containerPort: 'eighty', securityContext: 'hardened', writableVolumes: 'tmp' },
          'k8s/charts/app/values-staging.yaml',
        ),
      ),
    ).toEqual([]);
  });
});

describe('replicaFloor', () => {
  it('reads the HPA floor when autoscaling is on', () => {
    expect(replicaFloor({ replicaCount: 8, autoscaling: { enabled: true, minReplicas: 3 } })).toEqual(
      { count: 3, source: 'autoscaling.minReplicas' },
    );
  });

  it('reads replicaCount when it is off', () => {
    expect(
      replicaFloor({ replicaCount: 8, autoscaling: { enabled: false, minReplicas: 3 } }),
    ).toEqual({ count: 8, source: 'replicaCount' });
  });

  it('reads replicaCount when there is no autoscaling block at all', () => {
    expect(replicaFloor({ replicaCount: 8 })).toEqual({ count: 8, source: 'replicaCount' });
  });

  it('reports no floor rather than guessing when the value is not a number', () => {
    expect(replicaFloor({ replicaCount: 'four' })).toEqual({
      count: undefined,
      source: 'replicaCount',
    });
  });
});

describe('auditChart', () => {
  it('accepts a conforming chart', () => {
    expect(auditChart(CONFORMING_CHART)).toEqual([]);
  });

  it('flags a missing environment file', () => {
    const chart = chartWith({ environments: [CONFORMING_CHART.environments[0]] });

    expect(rules(auditChart(chart))).toEqual(['missing-environment-file']);
  });

  it('flags a values file for an environment nothing deploys', () => {
    const chart = chartWith({ orphanEnvironmentFiles: ['k8s/charts/app/values-qa.yaml'] });

    expect(rules(auditChart(chart))).toEqual(['orphan-environment-file']);
  });

  it('flags a chart with no schema, and stops validating values against nothing', () => {
    const chart = chartWith({ schema: undefined });

    expect(rules(auditChart(chart))).toEqual(['schema-unreadable']);
  });

  it('flags a schema that does not compile', () => {
    const chart = chartWith({ schema: { type: 'object', additionalProperties: false, properties: { a: { type: 'nonsense' } } } });

    expect(rules(auditChart(chart))).toEqual(['schema-invalid']);
  });

  it('validates the chart defaults on their own, which is what `helm lint` reads', () => {
    const chart = chartWith({ values: { environment: 'qa', replicaCount: 2 } });

    // Once for values.yaml and once per environment file, because each
    // environment inherits the broken default.
    expect(rules(auditChart(chart))).toEqual(['schema-violation']);
  });

  it('stops at values.yaml when it is not a mapping', () => {
    const chart = chartWith({ values: 'not a map' });

    expect(rules(auditChart(chart))).toEqual(['values-not-a-map']);
  });
});

describe('formatViolations', () => {
  it('names the file and the rule on the first line', () => {
    const formatted = formatViolations([
      { rule: 'single-replica', file: 'k8s/charts/app/values-production.yaml', message: 'one replica' },
    ]);

    expect(formatted).toBe('k8s/charts/app/values-production.yaml  [single-replica]\n    one replica');
  });
});

// ── The chart in this repository ──────────────────────────────────────────────

describe('the charts under k8s/charts', () => {
  const charts = readCharts(REPO_ROOT);

  it('finds the app chart', () => {
    expect(charts.map((chart) => chart.name)).toContain('app');
    expect(charts[0].directory.startsWith(CHARTS_DIRECTORY)).toBe(true);
  });

  it('has a values file for every environment', () => {
    for (const chart of charts) {
      expect(chart.environments.map((environment) => environment.environment).sort()).toEqual(
        [...ENVIRONMENTS].sort(),
      );
    }
  });

  it('audits clean', () => {
    for (const chart of charts) {
      expect(formatViolations(auditChart(chart))).toBe('');
    }
  });
});

/**
 * The schema is only a gate if a violation actually fails, and the way that
 * stops being true is quiet — a `required` entry lost in a refactor, an
 * `additionalProperties: false` dropped to let one key through. Each fixture is
 * one violation, asserted against the specific keyword that should catch it, so
 * that weakening the schema fails here rather than passing silently.
 *
 * `.github/scripts/lint-helm-chart.sh` runs the same fixtures through
 * `helm lint`, because the validator that matters at deploy time is Helm's own.
 */
describe('the schema fixtures', () => {
  const defaults = yaml(path.join(APP_CHART, 'values.yaml'));
  const validate = compileSchema(json(path.join(APP_CHART, 'values.schema.json')));

  const FIXTURES: ReadonlyArray<[file: string, keyword: string, instancePath: string]> = [
    ['unknown-key.yaml', 'additionalProperties', ''],
    ['unknown-environment.yaml', 'enum', '/environment'],
    ['mutable-image-tag.yaml', 'not', '/image/tag'],
    ['non-string-config-value.yaml', 'type', '/config/PORT'],
    ['nullified-required-key.yaml', 'required', ''],
    ['zero-min-replicas.yaml', 'minimum', '/autoscaling/minReplicas'],
    // The scale-down floor is expressed as an `allOf` branch over the shared
    // `hpaScalingRules` definition, so what has to still catch it is the
    // `minimum` in that branch — not the one on the shared definition, which is
    // 0 and is correct for scale-up.
    ['flapping-scale-down.yaml', 'minimum', '/autoscaling/behavior/scaleDown/stabilizationWindowSeconds'],
    ['privileged-container.yaml', 'const', '/securityContext/privileged'],
    ['writable-root-filesystem.yaml', 'const', '/securityContext/readOnlyRootFilesystem'],
    // `contains`, not `enum` on the items: dropping NET_RAW and SYS_CHROOT is a
    // legal list of capabilities that simply is not the one that matters. What
    // has to catch it is the requirement that ALL be among them.
    ['capabilities-retained.yaml', 'contains', '/securityContext/capabilities/drop'],
    // `minimum` rather than the `const: true` on runAsNonRoot: the two are
    // contradictory but each is individually valid, and JSON Schema cannot
    // compare them — so root is excluded at the UID instead.
    ['root-user.yaml', 'minimum', '/podSecurityContext/runAsUser'],
    ['unconfined-seccomp.yaml', 'enum', '/podSecurityContext/seccompProfile/type'],
  ];

  it.each(FIXTURES)('rejects %s with the %s keyword', (file, keyword, instancePath) => {
    const fixture = yaml(path.join(APP_CHART, 'schema-fixtures', file));
    const merged = coalesceValues(defaults, fixture);

    expect(validate(merged)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword, instancePath })]),
    );
  });

  it('covers every fixture on disk', () => {
    const onDisk = fs
      .readdirSync(path.join(APP_CHART, 'schema-fixtures'))
      .filter((file) => file.endsWith('.yaml'))
      .sort();

    expect(onDisk).toEqual(FIXTURES.map(([file]) => file).sort());
  });

  it('accepts the environment files it is given alongside them', () => {
    for (const environment of ENVIRONMENTS) {
      const merged = coalesceValues(defaults, yaml(path.join(APP_CHART, `values-${environment}.yaml`)));

      expect(validate(merged)).toBe(true);
    }
  });
});
