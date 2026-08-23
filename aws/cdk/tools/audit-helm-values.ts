#!/usr/bin/env node
/**
 * Audit the Helm charts under `k8s/charts/` and their per-environment values.
 *
 * `values.schema.json` is the chart's own contract and Helm enforces it on
 * `lint`, `template`, `install` and `upgrade`. This script exists for the three
 * things that contract cannot cover on its own:
 *
 *   1. **Whether the schema is still a gate.** A schema whose objects have
 *      drifted open — `additionalProperties` dropped in a refactor — validates
 *      every file it is given and catches nothing. That failure is invisible,
 *      because the symptom is a gate passing.
 *
 *   2. **Whether every environment is covered.** Helm validates the values file
 *      it was handed. It has no opinion about a `values-production.yaml` that
 *      nobody remembered to add, or one that exists for an environment that
 *      does not.
 *
 *   3. **Rules that relate two values, or a value to its filename.** JSON
 *      Schema cannot compare two properties, so `minAvailable` below
 *      `replicaCount` is not expressible in it; nor is "the file called
 *      `values-production.yaml` declares `environment: production`".
 *
 * Each rule and the failure it prevents:
 *
 *   schema-unreadable         chart has no readable values.schema.json, so
 *                             nothing validates the values at all
 *   schema-invalid            a schema that does not compile — Helm reports
 *                             this at install time, on the cluster
 *   schema-open-object        an object that accepts unknown keys, which makes
 *                             a typo'd value a setting that silently does
 *                             nothing rather than a failed release
 *   chart-metadata            Chart.yaml disagreeing with its own directory, or
 *                             missing the metadata consumers pin against
 *   missing-environment-file  an environment with no values file
 *   orphan-environment-file   a values file for an environment nothing deploys
 *   values-unreadable         a values file that is not parseable YAML
 *   values-not-a-map          a values file that parses to something other than
 *                             a mapping — an empty file, or a stray list
 *   environment-not-declared  a file that leaves `environment` to the default,
 *                             so production pods label themselves staging
 *   environment-mismatch      `environment` disagreeing with the filename
 *   nullified-key             `key: null`, which in Helm *deletes* the chart
 *                             default rather than overriding it
 *   schema-violation          merged values the schema rejects
 *   budget-blocks-drain       a PodDisruptionBudget that permits no disruption
 *                             at all, which stalls every node drain and so
 *                             every cluster upgrade
 *   single-replica            one replica in production, where any voluntary
 *                             disruption is then an outage
 *
 * Usage:
 *   npm run audit:helm                       # audits the repository root
 *   npx ts-node tools/audit-helm-values.ts <dir>
 *
 * Exits non-zero when anything is found.
 */
import * as fs from 'fs';
import * as path from 'path';
import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import { load } from 'js-yaml';

/**
 * The environments a chart must carry a values file for. These mirror the
 * `EksStack-Staging` / `EksStack-Production` instances in `aws/cdk/bin/app.ts`
 * and the `enum` on `environment` in `values.schema.json`; a third environment
 * means adding it in all three places, which is the point of listing it here
 * rather than trusting whatever files happen to be on disk.
 */
export const ENVIRONMENTS: readonly string[] = ['staging', 'production'];

/** Directory holding the charts, relative to the repository root. */
export const CHARTS_DIRECTORY = path.posix.join('k8s', 'charts');

export type ViolationRule =
  | 'schema-unreadable'
  | 'schema-invalid'
  | 'schema-open-object'
  | 'chart-metadata'
  | 'missing-environment-file'
  | 'orphan-environment-file'
  | 'values-unreadable'
  | 'values-not-a-map'
  | 'environment-not-declared'
  | 'environment-mismatch'
  | 'nullified-key'
  | 'schema-violation'
  | 'budget-blocks-drain'
  | 'single-replica';

export interface Violation {
  readonly rule: ViolationRule;
  /** Repository-relative path a reader should open to fix it. */
  readonly file: string;
  readonly message: string;
}

/** One environment's values file, as read from disk. */
export interface EnvironmentValues {
  readonly environment: string;
  /** Repository-relative, e.g. `k8s/charts/app/values-production.yaml`. */
  readonly path: string;
  /** Whatever `js-yaml` produced. Narrowed defensively — this is user input. */
  readonly document: unknown;
}

/** A chart, loaded far enough to audit without Helm being installed. */
export interface LoadedChart {
  /** Directory name under `k8s/charts`, e.g. `app`. */
  readonly name: string;
  /** Repository-relative directory, e.g. `k8s/charts/app`. */
  readonly directory: string;
  readonly chart: unknown;
  readonly values: unknown;
  /** `undefined` when the file is absent or unparseable. */
  readonly schema: unknown;
  readonly environments: readonly EnvironmentValues[];
  /** Environment files present on disk that are not in {@link ENVIRONMENTS}. */
  readonly orphanEnvironmentFiles: readonly string[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Semantic version, without a range operator. Chart versions are exact. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Merge an environment's values over the chart defaults the way Helm does.
 *
 * Two behaviours matter and neither is obvious:
 *
 *   • Maps merge key by key, at every depth. An environment file that sets
 *     `resources.requests.cpu` keeps the default `resources.limits.memory`.
 *   • A key set to `null` is *removed*, not overridden. Helm's `CoalesceTables`
 *     nullifies rather than assigns, so `resources: null` leaves the container
 *     with no resources block at all rather than with the chart's. That is the
 *     single most surprising thing about Helm values, and it is why
 *     `nullified-key` is reported separately instead of being left to surface
 *     as a confusing `required` error.
 *
 * Arrays replace wholesale — Helm does not merge lists, so an environment that
 * sets one toleration replaces every default toleration.
 */
export const coalesceValues = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === null) {
      delete merged[key];
      continue;
    }

    const overrideMap = asRecord(value);
    const baseMap = asRecord(merged[key]);

    merged[key] =
      overrideMap !== undefined && baseMap !== undefined
        ? coalesceValues(baseMap, overrideMap)
        : value;
  }

  return merged;
};

/** Dotted paths in `document` whose value is `null`, deepest key last. */
export const nullifiedPaths = (document: Record<string, unknown>, prefix = ''): string[] => {
  const paths: string[] = [];

  for (const [key, value] of Object.entries(document)) {
    const dotted = prefix === '' ? key : `${prefix}.${key}`;

    if (value === null) {
      paths.push(dotted);
      continue;
    }

    const nested = asRecord(value);
    if (nested !== undefined) paths.push(...nullifiedPaths(nested, dotted));
  }

  return paths;
};

/**
 * Every object node in the schema must state what it does with unknown keys —
 * `additionalProperties: false` to reject them, or a schema to type them.
 *
 * A node that says nothing defaults to accepting anything, so a values file
 * with `replicas: 3` where the chart reads `replicaCount` validates cleanly and
 * deploys the default replica count. The whole value of a values schema is that
 * this cannot happen, and a single missing line removes it for that subtree
 * without changing any other behaviour.
 *
 * `additionalProperties: true` is treated as absent: it is the same permission,
 * written out.
 */
export const auditSchemaHygiene = (schema: unknown, file: string, pointer = '#'): Violation[] => {
  const node = asRecord(schema);
  if (node === undefined) return [];

  const violations: Violation[] = [];

  if (node.type === 'object' && (node.additionalProperties ?? true) === true) {
    violations.push({
      rule: 'schema-open-object',
      file,
      message:
        `${pointer} is \`type: object\` but does not restrict additional properties, so any ` +
        'unknown key under it validates. Set `additionalProperties: false`, or give it a ' +
        'schema if the object is a free-form map such as `annotations`.',
    });
  }

  // Walk every subschema position draft-07 defines, so a nested object cannot
  // hide from this check behind `items`, `definitions`, or a combinator.
  for (const keyword of ['properties', 'definitions', 'patternProperties'] as const) {
    for (const [key, value] of Object.entries(asRecord(node[keyword]) ?? {})) {
      violations.push(...auditSchemaHygiene(value, file, `${pointer}/${keyword}/${key}`));
    }
  }

  for (const keyword of ['items', 'additionalProperties', 'not', 'propertyNames'] as const) {
    if (asRecord(node[keyword]) !== undefined) {
      violations.push(...auditSchemaHygiene(node[keyword], file, `${pointer}/${keyword}`));
    }
  }

  for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = Array.isArray(node[keyword]) ? (node[keyword] as unknown[]) : [];
    branches.forEach((branch, index) => {
      violations.push(...auditSchemaHygiene(branch, file, `${pointer}/${keyword}/${index}`));
    });
  }

  return violations;
};

/**
 * Compile the schema.
 *
 * `strict: false` on purpose. Ajv's strict mode enforces authoring rules of its
 * own — unknown keywords, unconstrained tuples — that Helm's validator
 * (`xeipuuv/gojsonschema`) does not have. Leaving it on would fail schemas Helm
 * accepts, which makes this gate disagree with the thing it is a proxy for.
 * `allErrors` so one run reports every violation in a file instead of the first.
 */
export const compileSchema = (schema: unknown): ValidateFunction => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema as object);
};

/** Ajv's message for one error, prefixed with the path it applies to. */
export const formatSchemaError = (error: ErrorObject): string => {
  const at = error.instancePath === '' ? '(root)' : error.instancePath.replace(/^\//, '').replace(/\//g, '.');
  const extra =
    error.keyword === 'additionalProperties'
      ? ` (${String((error.params as { additionalProperty?: string }).additionalProperty)})`
      : '';
  return `${at}: ${error.message ?? 'is invalid'}${extra}`;
};

/** Chart.yaml must agree with its directory and carry what consumers pin on. */
export const auditChartMetadata = (chart: unknown, name: string, file: string): Violation[] => {
  const metadata = asRecord(chart);

  if (metadata === undefined) {
    return [{ rule: 'chart-metadata', file, message: 'Chart.yaml is missing or is not a mapping.' }];
  }

  const violations: Violation[] = [];
  const report = (message: string): void => {
    violations.push({ rule: 'chart-metadata', file, message });
  };

  if (metadata.apiVersion !== 'v2') {
    report(
      `apiVersion is ${JSON.stringify(metadata.apiVersion)}; charts in this repository are v2. ` +
        'A v1 chart ignores `dependencies` in Chart.yaml and reads requirements.yaml instead.',
    );
  }

  if (asString(metadata.name) !== name) {
    report(
      `name is ${JSON.stringify(metadata.name)} but the directory is ${JSON.stringify(name)}. ` +
        'Helm resolves subcharts and `--show-only` paths by chart name, so the two disagreeing ' +
        'breaks tooling that reads one and looks for the other.',
    );
  }

  const version = asString(metadata.version);
  if (version === undefined || !SEMVER.test(version)) {
    report(
      `version is ${JSON.stringify(metadata.version)}, which is not an exact semantic version. ` +
        'Consumers pin the chart by this string.',
    );
  }

  if (asString(metadata.appVersion) === undefined) {
    report('appVersion is missing. It is what `app.kubernetes.io/version` falls back to.');
  }

  if (asString(metadata.kubeVersion) === undefined) {
    report(
      'kubeVersion is missing, so the chart claims to install on any cluster. It uses ' +
        'policy/v1 and apps/v1, which is a real floor.',
    );
  }

  return violations;
};

/**
 * Audit one environment's values: the file itself, then the values Helm would
 * actually render from — the file coalesced over the chart defaults.
 */
export const auditEnvironment = (
  environment: EnvironmentValues,
  defaults: Record<string, unknown>,
  validate: ValidateFunction | undefined,
): Violation[] => {
  const violations: Violation[] = [];
  const file = environment.path;
  const document = asRecord(environment.document);

  if (document === undefined) {
    return [
      {
        rule: 'values-not-a-map',
        file,
        message:
          'values file does not parse to a mapping. An empty environment file is not the same ' +
          'as one that inherits every default — Helm reads it as `null` and the merge is a ' +
          'no-op either way, but nothing then records which values the environment runs with.',
      },
    ];
  }

  const declared = asString(document.environment);

  if (declared === undefined) {
    violations.push({
      rule: 'environment-not-declared',
      file,
      message:
        `does not set \`environment\`, so it inherits the chart default. Every pod, label and ` +
        `APP_ENVIRONMENT in the ${environment.environment} release would then name a different ` +
        'environment than the file that deployed it.',
    });
  } else if (declared !== environment.environment) {
    violations.push({
      rule: 'environment-mismatch',
      file,
      message: `sets \`environment: ${declared}\` but is the values file for ${environment.environment}.`,
    });
  }

  for (const nullified of nullifiedPaths(document)) {
    violations.push({
      rule: 'nullified-key',
      file,
      message:
        `sets \`${nullified}\` to null. In Helm that deletes the chart default rather than ` +
        'overriding it, which is almost never what a values file means to do. Set the value ' +
        'this environment wants, or remove the key.',
    });
  }

  const merged = coalesceValues(defaults, document);

  if (validate !== undefined && !validate(merged)) {
    for (const error of validate.errors ?? []) {
      violations.push({
        rule: 'schema-violation',
        file,
        message: `merged with the chart defaults, ${formatSchemaError(error)}`,
      });
    }
  }

  violations.push(...auditAvailability(merged, environment, file));

  return violations;
};

/**
 * The two availability rules JSON Schema cannot express, because both compare
 * one value to another.
 */
const auditAvailability = (
  merged: Record<string, unknown>,
  environment: EnvironmentValues,
  file: string,
): Violation[] => {
  const violations: Violation[] = [];
  const replicas = typeof merged.replicaCount === 'number' ? merged.replicaCount : undefined;
  const budget = asRecord(merged.podDisruptionBudget);
  const minAvailable = typeof budget?.minAvailable === 'number' ? budget.minAvailable : 1;

  if (budget?.enabled === true && replicas !== undefined && minAvailable >= replicas) {
    violations.push({
      rule: 'budget-blocks-drain',
      file,
      message:
        `podDisruptionBudget.minAvailable is ${minAvailable} with replicaCount ${replicas}, so ` +
        'the budget permits no voluntary disruption at all. `kubectl drain` then blocks forever ' +
        'and every node rotation and cluster upgrade stalls on it — a PDB that protects the ' +
        'service from the platform by stopping the platform.',
    });
  }

  if (environment.environment === 'production' && replicas !== undefined && replicas < 2) {
    violations.push({
      rule: 'single-replica',
      file,
      message:
        'production runs a single replica, so a node drain, a rolling update, or one crash is ' +
        'an outage. Two is the floor at which none of those are.',
    });
  }

  return violations;
};

/** Audit one loaded chart. Pure — the unit tests drive this with no filesystem. */
export const auditChart = (chart: LoadedChart): Violation[] => {
  const violations: Violation[] = [
    ...auditChartMetadata(chart.chart, chart.name, path.posix.join(chart.directory, 'Chart.yaml')),
  ];

  const schemaFile = path.posix.join(chart.directory, 'values.schema.json');
  let validate: ValidateFunction | undefined;

  if (chart.schema === undefined) {
    violations.push({
      rule: 'schema-unreadable',
      file: schemaFile,
      message:
        'no readable values.schema.json, so nothing constrains the values this chart installs ' +
        'with. Every rule below it is unenforced.',
    });
  } else {
    violations.push(...auditSchemaHygiene(chart.schema, schemaFile));

    try {
      validate = compileSchema(chart.schema);
    } catch (error) {
      violations.push({
        rule: 'schema-invalid',
        file: schemaFile,
        message: `does not compile as a JSON Schema: ${(error as Error).message}`,
      });
    }
  }

  const defaultsFile = path.posix.join(chart.directory, 'values.yaml');
  const defaults = asRecord(chart.values);

  if (defaults === undefined) {
    violations.push({
      rule: 'values-not-a-map',
      file: defaultsFile,
      message: 'values.yaml is missing or does not parse to a mapping.',
    });
    return violations;
  }

  // The defaults are validated on their own as well as merged: `helm lint` and
  // `helm template` with no `-f` read exactly this, and a chart whose own
  // defaults fail its schema cannot be linted at all.
  if (validate !== undefined && !validate(defaults)) {
    for (const error of validate.errors ?? []) {
      violations.push({
        rule: 'schema-violation',
        file: defaultsFile,
        message: formatSchemaError(error),
      });
    }
  }

  const present = new Set(chart.environments.map((environment) => environment.environment));

  for (const environment of ENVIRONMENTS) {
    if (!present.has(environment)) {
      violations.push({
        rule: 'missing-environment-file',
        file: path.posix.join(chart.directory, `values-${environment}.yaml`),
        message:
          `no values file for ${environment}. Deploying it would then mean either the chart ` +
          'defaults or a pile of `--set` flags, neither of which is reviewable.',
      });
    }
  }

  for (const orphan of chart.orphanEnvironmentFiles) {
    violations.push({
      rule: 'orphan-environment-file',
      file: orphan,
      message:
        'values file for an environment that is not deployed. Either add the environment to ' +
        'ENVIRONMENTS in tools/audit-helm-values.ts and to the `environment` enum in ' +
        'values.schema.json, or delete the file — an unreferenced values file drifts silently ' +
        'and is then trusted when someone finally uses it.',
    });
  }

  for (const environment of chart.environments) {
    violations.push(...auditEnvironment(environment, defaults, validate));
  }

  return violations;
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations.map((v) => `${v.file}  [${v.rule}]\n    ${v.message}`).join('\n\n');

const parseYamlFile = (absolute: string): unknown => {
  try {
    return load(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return undefined;
  }
};

const parseJsonFile = (absolute: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

/** Read every chart under `<root>/k8s/charts`. */
export const readCharts = (root: string): LoadedChart[] => {
  const directory = path.join(root, 'k8s', 'charts');
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => fs.existsSync(path.join(directory, name, 'Chart.yaml')))
    .map((name) => {
      const chartDirectory = path.join(directory, name);
      const relative = path.posix.join(CHARTS_DIRECTORY, name);

      const environmentFiles = fs
        .readdirSync(chartDirectory)
        .filter((file) => /^values-.+\.ya?ml$/.test(file))
        .sort();

      const environments: EnvironmentValues[] = [];
      const orphanEnvironmentFiles: string[] = [];

      for (const file of environmentFiles) {
        const environment = file.replace(/^values-/, '').replace(/\.ya?ml$/, '');
        const relativeFile = path.posix.join(relative, file);

        if (ENVIRONMENTS.includes(environment)) {
          environments.push({
            environment,
            path: relativeFile,
            document: parseYamlFile(path.join(chartDirectory, file)),
          });
        } else {
          orphanEnvironmentFiles.push(relativeFile);
        }
      }

      return {
        name,
        directory: relative,
        chart: parseYamlFile(path.join(chartDirectory, 'Chart.yaml')),
        values: parseYamlFile(path.join(chartDirectory, 'values.yaml')),
        schema: parseJsonFile(path.join(chartDirectory, 'values.schema.json')),
        environments,
        orphanEnvironmentFiles,
      };
    });
};

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const charts = readCharts(root);

  if (charts.length === 0) {
    console.error(`No charts found under ${path.join(root, 'k8s', 'charts')}.`);
    process.exit(1);
  }

  const violations = charts.flatMap((chart) => auditChart(chart));

  if (violations.length > 0) {
    console.error(`\n${violations.length} Helm values violation(s):\n`);
    console.error(formatViolations(violations));
    console.error('\nSee docs/helm-chart.md.\n');
    process.exit(1);
  }

  const environments = charts.reduce((total, chart) => total + chart.environments.length, 0);
  console.log(
    `${charts.length} chart(s) and ${environments} environment values file(s) in ${root} ` +
      'validate against their schema.',
  );
}
