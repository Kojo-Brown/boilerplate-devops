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
  auditSchemaHygiene,
  coalesceValues,
  compileSchema,
  formatViolations,
  nullifiedPaths,
  readCharts,
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
