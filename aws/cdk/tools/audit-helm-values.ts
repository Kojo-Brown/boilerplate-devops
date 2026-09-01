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
 *   autoscaling-bounds        an HPA whose ceiling is not above its floor, so
 *                             it is a fixed replica count wearing an autoscaler
 *   replica-count-outside-range
 *                             `replicaCount` outside the HPA's range. It is not
 *                             rendered while the HPA is on, so nothing catches
 *                             it until autoscaling is turned off — at which
 *                             point the fleet silently resizes
 *   capability-added-back     a Linux capability granted back after dropping
 *                             ALL, which is the drop undone one line later
 *   unnecessary-capability    NET_BIND_SERVICE granted to a container that
 *                             binds an unprivileged port and does not need it
 *   privileged-port-unbindable
 *                             a containerPort below 1024 on a non-root
 *                             container with no NET_BIND_SERVICE, which is a
 *                             pod that starts and then cannot bind
 *   duplicate-writable-mount  two scratch volumes sharing a name or a mount
 *                             path, which the API server rejects at apply time
 *   network-policy-disabled   a release with no policy boundary at all
 *   dns-egress-blocked        a default-deny egress policy with no route to
 *                             cluster DNS, so every name lookup times out
 *   metadata-service-reachable
 *                             an egress allowlist that leaves the instance
 *                             metadata address inside an ipBlock
 *   ingress-from-anywhere     an ingress allowlist entry admitting 0.0.0.0/0,
 *                             which is the default-deny undone
 *   ingress-port-mismatch     an ingress rule naming a port the pod does not
 *                             listen on — usually `service.port`, which policy
 *                             never sees
 *   duplicate-network-policy-rule
 *                             two allowlist entries sharing a name, so a
 *                             failure message cannot say which one it means
 *   cluster-issuer-mismatch   an Ingress naming a ClusterIssuer its own cluster
 *                             does not install — or the other environment's,
 *                             which resolves and spends production's ACME rate
 *                             limit from staging
 *   managed-ingress-annotation
 *                             an `ingress.annotations` key the template writes
 *                             itself, so the value in the file is discarded
 *                             rather than overridden
 *   ingress-peer-not-allowed  an Ingress enabled with an empty NetworkPolicy
 *                             allowlist: every layer reports healthy and the
 *                             controller returns 503
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

/**
 * Capabilities a chart may grant back after `drop: [ALL]`.
 *
 * The list is here, in code, rather than in the schema, because adding to it is
 * meant to be a change somebody reviews with a reason attached — the same shape
 * as `lib/checkov-suppressions.ts`. `NET_BIND_SERVICE` is on it because binding
 * a port below 1024 as a non-root user is impossible without it and is
 * occasionally unavoidable; it is still reported when the container's port does
 * not need it, since a granted capability nobody uses is one nobody will
 * remember was granted.
 */
export const ALLOWED_ADDED_CAPABILITIES: readonly string[] = ['NET_BIND_SERVICE'];

/**
 * Ports below this are privileged: binding one requires `CAP_NET_BIND_SERVICE`
 * or UID 0. `net.ipv4.ip_unprivileged_port_start` can lower it per node, but it
 * is an unsafe sysctl that EKS does not set, so 1024 is the number that holds
 * on the clusters this chart deploys to.
 */
export const PRIVILEGED_PORT_CEILING = 1024;

/**
 * The EC2 instance metadata service.
 *
 * A pod that reaches it gets the *node's* IAM role, which is the union of every
 * permission any pod on that node needs — the exact thing IRSA exists to avoid.
 * The node launch template already requires IMDSv2 at a hop limit of 1, which is
 * what actually puts this address out of a container's reach; the egress
 * `except` is the second control, and the one that survives someone lowering the
 * hop limit for an afternoon.
 */
export const METADATA_SERVICE_ADDRESS = '169.254.169.254';

/** The port cluster DNS listens on. Both UDP and TCP; see auditNetworkPolicy. */
export const DNS_PORT = 53;

/**
 * The `ClusterIssuer` each environment's cluster actually installs, from
 * `k8s/cert-manager/<environment>/cluster-issuer.yaml`.
 *
 * They differ because the ACME endpoints differ: staging issues from Let's
 * Encrypt's staging directory, whose certificates chain to an untrusted root and
 * whose rate limits are effectively unbounded. The production directory counts
 * its 50-certificates-per-week limit on the *registered* domain rather than the
 * subdomain, so a staging cluster pointed at the production issuer does not
 * merely get a trusted certificate: it consumes the quota production needs.
 *
 * cert-manager resolves an issuer by name and reports a missing one on the
 * CertificateRequest, not on the Ingress, which is why this is checked here.
 */
export const ENVIRONMENT_CLUSTER_ISSUERS: Readonly<Record<string, string>> = {
  staging: 'letsencrypt-staging',
  production: 'letsencrypt-production',
};

/**
 * Annotations `templates/ingress.yaml` writes itself, and applies over anything
 * `ingress.annotations` carries.
 *
 * The override is what makes this worth a rule: a values file that sets one of
 * these is not overridden loudly, it is discarded, and the rendered Ingress
 * carries the chart's value while the diff reads as though the file's took.
 */
export const CHART_MANAGED_INGRESS_ANNOTATIONS: readonly string[] = [
  'cert-manager.io/cluster-issuer',
  'cert-manager.io/renew-before',
];

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
  | 'single-replica'
  | 'autoscaling-bounds'
  | 'replica-count-outside-range'
  | 'capability-added-back'
  | 'unnecessary-capability'
  | 'privileged-port-unbindable'
  | 'duplicate-writable-mount'
  | 'network-policy-disabled'
  | 'dns-egress-blocked'
  | 'metadata-service-reachable'
  | 'ingress-from-anywhere'
  | 'ingress-port-mismatch'
  | 'duplicate-network-policy-rule'
  | 'cluster-issuer-mismatch'
  | 'managed-ingress-annotation'
  | 'ingress-peer-not-allowed';

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
  violations.push(...auditPodSecurity(merged, file));
  violations.push(...auditNetworkPolicy(merged, file));
  violations.push(...auditIngress(merged, environment, file));

  return violations;
};

/**
 * The ingress rules the schema cannot express.
 *
 * All three compare one value to another, or a value to the filename, and all
 * three describe an Ingress Kubernetes admits and serves. That is what they have
 * in common with everything else in this file: nothing here is invalid, and
 * every one of them fails somewhere other than where it is written.
 */
export const auditIngress = (
  merged: Record<string, unknown>,
  environment: EnvironmentValues,
  file: string,
): Violation[] => {
  const ingress = asRecord(merged.ingress);
  if (ingress === undefined || ingress.enabled !== true) return [];

  const violations: Violation[] = [];

  const expectedIssuer = ENVIRONMENT_CLUSTER_ISSUERS[environment.environment];
  const issuer = asString(asRecord(ingress.tls)?.clusterIssuer);

  if (expectedIssuer !== undefined && issuer !== expectedIssuer) {
    violations.push({
      rule: 'cluster-issuer-mismatch',
      file,
      message:
        `ingress.tls.clusterIssuer is ${JSON.stringify(issuer ?? null)}, but the ` +
        `${environment.environment} cluster installs \`${expectedIssuer}\` ` +
        `(k8s/cert-manager/${environment.environment}/cluster-issuer.yaml). cert-manager ` +
        'resolves the issuer by name and finds nothing, so the Certificate stays ' +
        '`Ready: False` with `issuer not found` on a *CertificateRequest* — not on the ' +
        'Ingress, which reports healthy throughout while serving the controller’s own ' +
        'self-signed certificate. Naming the other environment’s issuer is worse: it resolves, ' +
        'and staging then burns production’s Let’s Encrypt rate limit.',
    });
  }

  const annotations = asRecord(ingress.annotations) ?? {};

  for (const key of CHART_MANAGED_INGRESS_ANNOTATIONS) {
    if (key in annotations) {
      violations.push({
        rule: 'managed-ingress-annotation',
        file,
        message:
          `ingress.annotations sets \`${key}\`, which templates/ingress.yaml writes itself and ` +
          'applies over whatever is here. The value in this file is therefore discarded ' +
          'silently — the rendered Ingress carries the chart’s, and the diff that set it looks ' +
          `like it took effect. Set it through \`ingress.tls\` instead.`,
      });
    }
  }

  const policy = asRecord(merged.networkPolicy);

  if (policy?.enabled === true && readAllowlist(policy.ingress).length === 0) {
    violations.push({
      rule: 'ingress-peer-not-allowed',
      file,
      message:
        'the Ingress is enabled and networkPolicy.ingress is empty, so the default-deny policy ' +
        'drops the connection from the ingress controller to these pods. Every layer above it ' +
        'reports success: DNS resolves, the certificate is issued and renewed, the Ingress has ' +
        'an address, the Service has endpoints and the pods are Ready — and the controller ' +
        'returns 503 because it cannot reach any of them. Add the `ingress-controller` entry ' +
        'from the comment in values.yaml.',
    });
  }

  return violations;
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

/**
 * The smallest number of pods the release can be running, and where that number
 * comes from.
 *
 * With the HPA on it is `autoscaling.minReplicas`, not `replicaCount`: the
 * Deployment renders no `replicas` field at all in that case, so `replicaCount`
 * is a value nothing reads. Every availability rule below has to be checked
 * against the floor rather than the nominal size, because the disruption that
 * matters — a node drain at 4am — arrives when the fleet is at its smallest.
 */
export const replicaFloor = (
  merged: Record<string, unknown>,
): { readonly count: number | undefined; readonly source: string } => {
  const autoscaling = asRecord(merged.autoscaling);

  if (autoscaling?.enabled === true) {
    return { count: asNumber(autoscaling.minReplicas), source: 'autoscaling.minReplicas' };
  }

  return { count: asNumber(merged.replicaCount), source: 'replicaCount' };
};

/**
 * The availability rules JSON Schema cannot express, because every one of them
 * compares one value to another.
 */
const auditAvailability = (
  merged: Record<string, unknown>,
  environment: EnvironmentValues,
  file: string,
): Violation[] => {
  const violations: Violation[] = [];
  const floor = replicaFloor(merged);
  const budget = asRecord(merged.podDisruptionBudget);
  const minAvailable = typeof budget?.minAvailable === 'number' ? budget.minAvailable : 1;

  if (budget?.enabled === true && floor.count !== undefined && minAvailable >= floor.count) {
    violations.push({
      rule: 'budget-blocks-drain',
      file,
      message:
        `podDisruptionBudget.minAvailable is ${minAvailable} with ${floor.source} ` +
        `${floor.count}, so the budget permits no voluntary disruption at the smallest size ` +
        'this release runs at. `kubectl drain` then blocks forever and every node rotation, ' +
        'cluster upgrade and Cluster Autoscaler scale-down stalls on it — a PDB that protects ' +
        'the service from the platform by stopping the platform.',
    });
  }

  if (environment.environment === 'production' && floor.count !== undefined && floor.count < 2) {
    violations.push({
      rule: 'single-replica',
      file,
      message:
        `production can run a single replica (${floor.source} is ${floor.count}), so a node ` +
        'drain, a rolling update, or one crash is an outage. Two is the floor at which none of ' +
        'those are.',
    });
  }

  violations.push(...auditAutoscaling(merged, file));

  return violations;
};

/**
 * The HPA's own bounds, and the relationship between them and `replicaCount`.
 *
 * Both rules are about a misconfiguration that produces no error anywhere: an
 * HPA with `maxReplicas` at its floor reports itself healthy while scaling
 * nothing, and a `replicaCount` outside the range is inert right up until
 * someone sets `autoscaling.enabled: false` and the fleet resizes on the next
 * upgrade.
 */
const auditAutoscaling = (merged: Record<string, unknown>, file: string): Violation[] => {
  const autoscaling = asRecord(merged.autoscaling);
  if (autoscaling?.enabled !== true) return [];

  const minReplicas = asNumber(autoscaling.minReplicas);
  const maxReplicas = asNumber(autoscaling.maxReplicas);
  const replicas = asNumber(merged.replicaCount);
  const violations: Violation[] = [];

  if (minReplicas !== undefined && maxReplicas !== undefined && maxReplicas <= minReplicas) {
    violations.push({
      rule: 'autoscaling-bounds',
      file,
      message:
        `autoscaling.maxReplicas is ${maxReplicas} and minReplicas is ${minReplicas}, so the ` +
        'HPA has no room to scale. Kubernetes accepts it and the HPA reports itself healthy ' +
        'while pinning the fleet at one size — a fixed replica count with an extra controller ' +
        'in front of it. Raise the ceiling, or set `autoscaling.enabled: false` and mean it.',
    });
  }

  if (
    replicas !== undefined &&
    minReplicas !== undefined &&
    maxReplicas !== undefined &&
    (replicas < minReplicas || replicas > maxReplicas)
  ) {
    violations.push({
      rule: 'replica-count-outside-range',
      file,
      message:
        `replicaCount is ${replicas}, outside the HPA's range of ${minReplicas}–${maxReplicas}. ` +
        'While autoscaling is on the Deployment renders no `replicas` field, so this value ' +
        'reaches nothing and nothing contradicts it. It becomes the fleet size the moment ' +
        'someone sets `autoscaling.enabled: false` — which is meant to change the mechanism, ' +
        'not the capacity.',
    });
  }

  return violations;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * The pod-security rules `values.schema.json` cannot express.
 *
 * The schema already fixes everything that is a single value — `privileged` is
 * `false`, `readOnlyRootFilesystem` is `true`, `drop` contains `ALL`, the UIDs
 * are not 0. What is left are the rules that compare one value to another, and
 * every one of them describes a pod that Kubernetes accepts and then does
 * something unhelpful with:
 *
 *   • A capability granted back after `drop: [ALL]` is the drop undone one line
 *     later, and it reads as hardening in review because the `drop` is still
 *     right there above it.
 *   • `containerPort: 80` on a non-root container is a Deployment that rolls
 *     out cleanly, passes admission, and CrashLoopBackOffs on `bind()` —
 *     `EACCES` from a process that is doing exactly what the manifest says.
 *   • Two scratch volumes on one path is rejected by the API server, but at
 *     apply time and with an error that names neither values file.
 */
export const auditPodSecurity = (merged: Record<string, unknown>, file: string): Violation[] => {
  const violations: Violation[] = [];
  const container = asRecord(merged.securityContext);
  const capabilities = asRecord(container?.capabilities);
  const added = asStringArray(capabilities?.add);
  const port = asNumber(merged.containerPort);
  const privilegedPort = port !== undefined && port < PRIVILEGED_PORT_CEILING;

  for (const capability of added) {
    if (ALLOWED_ADDED_CAPABILITIES.includes(capability)) continue;

    violations.push({
      rule: 'capability-added-back',
      file,
      message:
        `securityContext.capabilities.add grants ${capability} back after dropping ALL. The ` +
        'drop above it then describes a posture the container does not have, which is the ' +
        'version of this mistake that survives review. If the workload genuinely needs it, add ' +
        'it to ALLOWED_ADDED_CAPABILITIES in tools/audit-helm-values.ts with the reason, so the ' +
        'grant is reviewed once rather than inherited forever.',
    });
  }

  if (privilegedPort && !added.includes('NET_BIND_SERVICE')) {
    violations.push({
      rule: 'privileged-port-unbindable',
      file,
      message:
        `containerPort is ${port}, below ${PRIVILEGED_PORT_CEILING}, and the container drops ` +
        'every capability while running as a non-root user — so it cannot bind the port it ' +
        'declares. Nothing rejects this: the Deployment rolls out, the pod is admitted, and the ' +
        'process fails with EACCES on bind() into a CrashLoopBackOff. Move the listener to a ' +
        'port above 1024 and let the Service map 80 to it, which is what `service.port` is for.',
    });
  }

  if (!privilegedPort && added.includes('NET_BIND_SERVICE')) {
    violations.push({
      rule: 'unnecessary-capability',
      file,
      message:
        `securityContext.capabilities.add grants NET_BIND_SERVICE, but containerPort is ` +
        `${String(port)} — an unprivileged port, which needs no capability to bind. A grant ` +
        'that is not exercised is one nobody notices is still there, and it stops being ' +
        'harmless the day the listener moves.',
    });
  }

  const volumes = Array.isArray(merged.writableVolumes) ? merged.writableVolumes : [];
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of volumes) {
    const volume = asRecord(entry);
    const name = asString(volume?.name);
    const mountPath = asString(volume?.mountPath);

    if (name !== undefined && seenNames.has(name)) {
      violations.push({
        rule: 'duplicate-writable-mount',
        file,
        message:
          `writableVolumes declares the name ${JSON.stringify(name)} twice. The API server ` +
          'rejects the pod at apply time, which means the release fails after CI was green and ' +
          'the error names the pod rather than the values file that produced it.',
      });
    }

    if (mountPath !== undefined && seenPaths.has(mountPath)) {
      violations.push({
        rule: 'duplicate-writable-mount',
        file,
        message:
          `writableVolumes mounts ${JSON.stringify(mountPath)} twice. Only one of the two can ` +
          'win and the pod spec does not say which, so the container gets a scratch directory ' +
          'that is not the one the second entry describes.',
      });
    }

    if (name !== undefined) seenNames.add(name);
    if (mountPath !== undefined) seenPaths.add(mountPath);
  }

  return violations;
};

/**
 * Whether an IPv4 address falls inside a CIDR block.
 *
 * Written out rather than pulled in, because the whole of it is four lines and
 * the alternative is a dependency in the CI path of a repository people copy.
 *
 * The `prefix === 0` branch is not a special case for tidiness: `-1 << 32` in
 * JavaScript is `-1`, not `0`, because the shift count is taken modulo 32. So
 * the naive mask for `0.0.0.0/0` is every bit set, and `cidrContains` would
 * report that the block containing every address contains none of them —
 * silently turning the one rule that most needs flagging into the one that
 * passes.
 */
export const cidrContains = (cidr: string, address: string): boolean => {
  const toUint32 = (dotted: string): number | undefined => {
    const octets = dotted.split('.');
    if (octets.length !== 4) return undefined;

    let value = 0;
    for (const octet of octets) {
      if (!/^\d{1,3}$/.test(octet)) return undefined;
      const parsed = Number(octet);
      if (parsed > 255) return undefined;
      value = (value << 8) | parsed;
    }
    return value >>> 0;
  };

  const [network, length] = cidr.split('/');
  const prefix = Number(length);
  const base = toUint32(network);
  const target = toUint32(address);

  if (base === undefined || target === undefined || !Number.isInteger(prefix)) return false;
  if (prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;

  const mask = (-1 << (32 - prefix)) >>> 0;
  return (base & mask) >>> 0 === (target & mask) >>> 0;
};

/** One entry of `networkPolicy.ingress` or `networkPolicy.egress`. */
interface AllowlistRule {
  readonly name: string;
  readonly cidr?: string;
  readonly except: readonly string[];
  readonly ports: ReadonlyArray<{ readonly port: unknown }>;
}

const readAllowlist = (value: unknown): AllowlistRule[] =>
  (Array.isArray(value) ? value : []).flatMap((entry, index) => {
    const rule = asRecord(entry);
    if (rule === undefined) return [];

    return [
      {
        // Falling back to the index keeps every message able to name the rule
        // it means, even for a rule the schema would have rejected for having
        // no name at all.
        name: asString(rule.name) ?? `#${index}`,
        cidr: asString(rule.cidr),
        except: asStringArray(rule.except),
        ports: (Array.isArray(rule.ports) ? rule.ports : []).flatMap((port) => {
          const record = asRecord(port);
          return record === undefined ? [] : [{ port: record.port }];
        }),
      },
    ];
  });

/**
 * The network-policy rules the schema cannot express, because each compares one
 * value to another or reasons about what a CIDR contains.
 *
 * Everything here describes a policy Kubernetes accepts and stores. That is the
 * shape of every mistake in this area: a NetworkPolicy has no status, nothing
 * reports that a rule matched nothing, and the failure arrives as traffic that
 * hangs — or, worse, as traffic that flows when the manifest reads as though it
 * should not.
 */
export const auditNetworkPolicy = (
  merged: Record<string, unknown>,
  file: string,
): Violation[] => {
  const policy = asRecord(merged.networkPolicy);
  if (policy === undefined) return [];

  const violations: Violation[] = [];

  if (policy.enabled !== true) {
    return [
      {
        rule: 'network-policy-disabled',
        file,
        message:
          'networkPolicy.enabled is false, so this release has no policy boundary: any pod in ' +
          'the cluster can open a connection to these pods, and these pods can open one to ' +
          'anything. The setting exists for a cluster whose CNI does not implement policy — the ' +
          'clusters EksStack creates do, through the VPC CNI network policy agent — so turning ' +
          'it off here is removing the boundary rather than describing a cluster that has none. ' +
          'A release that cannot reach something it needs needs an entry in networkPolicy.egress.',
      },
    ];
  }

  const dns = asRecord(policy.dns);
  const ingress = readAllowlist(policy.ingress);
  const egress = readAllowlist(policy.egress);

  // A default-deny egress policy with no route to DNS is the single most common
  // way this feature is switched on and immediately backed out again.
  const dnsAllowedByHand = egress.some((rule) =>
    rule.ports.some((port) => port.port === DNS_PORT),
  );

  if (dns?.enabled !== true && !dnsAllowedByHand) {
    violations.push({
      rule: 'dns-egress-blocked',
      file,
      message:
        'networkPolicy.dns.enabled is false and no egress entry allows port 53, so the ' +
        'default-deny egress policy drops every name lookup these pods make. Nothing reports ' +
        'it: the resolver waits out its timeout and the caller sees a five-second delay ' +
        'followed by EAI_AGAIN, which reads as a slow service rather than a blocked one. Turn ' +
        'DNS back on, or add the entry that reaches whatever resolver this cluster runs.',
    });
  }

  for (const rule of egress) {
    if (rule.cidr === undefined) continue;
    if (!cidrContains(rule.cidr, METADATA_SERVICE_ADDRESS)) continue;
    if (rule.except.some((range) => cidrContains(range, METADATA_SERVICE_ADDRESS))) continue;

    violations.push({
      rule: 'metadata-service-reachable',
      file,
      message:
        `networkPolicy.egress entry ${JSON.stringify(rule.name)} allows ${rule.cidr}, which ` +
        `contains ${METADATA_SERVICE_ADDRESS}, and excepts nothing that covers it. A pod that ` +
        'reaches the instance metadata service is signed with the node role, which holds the ' +
        'union of what every pod on that node needs — the thing IRSA exists to stop. IMDSv2 at ' +
        'a hop limit of 1 is the control that actually blocks it and it is set on the launch ' +
        'template, so this is the second one; it is worth having because the first belongs to ' +
        'the node and can be lowered for an afternoon, and this one belongs to the release and ' +
        `cannot. Add \`except: [${METADATA_SERVICE_ADDRESS}/32]\` to the entry.`,
    });
  }

  for (const rule of ingress) {
    // The `/0` itself, not "a block that happens to contain a public address":
    // an ingress entry naming one address, public or not, is an allowlist entry
    // doing its job, and only a zero-length prefix is the whole internet.
    if (rule.cidr === undefined || Number(rule.cidr.split('/')[1]) !== 0) continue;

    violations.push({
      rule: 'ingress-from-anywhere',
      file,
      message:
        `networkPolicy.ingress entry ${JSON.stringify(rule.name)} admits ${rule.cidr}, which is ` +
        'every address there is. The default-deny policy is still rendered and still reads as a ' +
        'boundary in `kubectl get netpol`, but nothing is outside this entry, so there is no ' +
        'boundary left. Name the peer instead — a namespace and a pod selector for the ' +
        'controller that fronts this service.',
    });
  }

  violations.push(...auditIngressPorts(merged, ingress, file));
  violations.push(...auditDuplicateRuleNames(ingress, 'ingress', file));
  violations.push(...auditDuplicateRuleNames(egress, 'egress', file));

  return violations;
};

/**
 * Ingress ports are matched against the destination *pod's* port.
 *
 * This is the rule that catches the mistake nearly everybody makes once:
 * writing `port: 80` — the Service's port — in an ingress rule for a pod that
 * listens on 8080. kube-proxy rewrites the destination to the container port
 * before policy is evaluated, so the rule matches nothing, every connection is
 * dropped by the default-deny, and the manifest reads exactly right.
 */
const auditIngressPorts = (
  merged: Record<string, unknown>,
  ingress: readonly AllowlistRule[],
  file: string,
): Violation[] => {
  const containerPort = asNumber(merged.containerPort);
  const servicePort = asNumber(asRecord(merged.service)?.port);
  const violations: Violation[] = [];

  for (const rule of ingress) {
    for (const { port } of rule.ports) {
      // `http` is the name the pod template gives `containerPort`, so it is the
      // one named port that resolves. Any other name matches nothing.
      if (port === 'http') continue;

      if (typeof port === 'string') {
        violations.push({
          rule: 'ingress-port-mismatch',
          file,
          message:
            `networkPolicy.ingress entry ${JSON.stringify(rule.name)} names the port ` +
            `${JSON.stringify(port)}, which is not a port these pods declare. A named port in a ` +
            "policy is resolved against the destination pod's containers, and the only name the " +
            'pod template uses is `http`. A name that resolves to nothing matches nothing, and ' +
            'the traffic is then dropped by the default-deny with no error anywhere.',
        });
        continue;
      }

      // Not a number and not a string: the schema rejects it, and this audit
      // reports what it can rather than throwing on values it was not given.
      if (typeof port !== 'number' || containerPort === undefined) continue;
      if (port === containerPort) continue;

      const serviceNote =
        port === servicePort
          ? ' That is `service.port`, and policy never sees it: kube-proxy rewrites the ' +
            'destination to the container port first, so this entry matches no packet that ' +
            'ever arrives.'
          : '';

      violations.push({
        rule: 'ingress-port-mismatch',
        file,
        message:
          `networkPolicy.ingress entry ${JSON.stringify(rule.name)} allows port ${port}, but ` +
          `the pods listen on ${containerPort}.${serviceNote} The entry is accepted, matches ` +
          'nothing, and the connections it was written to permit are dropped by the ' +
          'default-deny — which looks like an application that is not responding. Use ' +
          '`port: http`, which is the container port by name and moves with it.',
      });
    }
  }

  return violations;
};

/**
 * Two allowlist entries with one name.
 *
 * The name never reaches the cluster — a NetworkPolicy rule has no name field —
 * so this cannot break a deploy. It breaks every message about the rule,
 * including the ones above: an audit failure naming `"aws-apis"` when there are
 * two of them sends the reader to the wrong entry, and a review comment about
 * one silently applies to the other.
 */
const auditDuplicateRuleNames = (
  rules: readonly AllowlistRule[],
  direction: 'ingress' | 'egress',
  file: string,
): Violation[] => {
  const seen = new Set<string>();

  return rules.flatMap((rule) => {
    if (seen.has(rule.name)) {
      return [
        {
          rule: 'duplicate-network-policy-rule' as const,
          file,
          message:
            `networkPolicy.${direction} declares ${JSON.stringify(rule.name)} twice. The name is ` +
            'not rendered, so both entries take effect and nothing fails — but it is what every ' +
            'message about the rule has to point at, and two of them point at both.',
        },
      ];
    }

    seen.add(rule.name);
    return [];
  });
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
