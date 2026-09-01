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
  auditIngress,
  auditNetworkPolicy,
  auditPodSecurity,
  auditSchemaHygiene,
  cidrContains,
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

describe('cidrContains', () => {
  it('matches an address inside the block', () => {
    expect(cidrContains('10.0.0.0/16', '10.0.5.7')).toBe(true);
  });

  it('rejects an address outside it', () => {
    expect(cidrContains('10.0.0.0/16', '10.1.0.1')).toBe(false);
  });

  // `-1 << 32` in JavaScript is `-1`, not `0`, because the shift count is taken
  // modulo 32 — so the naive mask for a /0 is every bit set and the block that
  // contains every address would report containing none. That is the one CIDR
  // in this audit that most needs to be caught, so it gets its own test.
  it('treats /0 as containing everything', () => {
    expect(cidrContains('0.0.0.0/0', '169.254.169.254')).toBe(true);
    expect(cidrContains('0.0.0.0/0', '8.8.8.8')).toBe(true);
  });

  it('treats /32 as a single address', () => {
    expect(cidrContains('169.254.169.254/32', '169.254.169.254')).toBe(true);
    expect(cidrContains('169.254.169.254/32', '169.254.169.253')).toBe(false);
  });

  it('handles a prefix that does not land on an octet boundary', () => {
    expect(cidrContains('192.168.1.0/25', '192.168.1.127')).toBe(true);
    expect(cidrContains('192.168.1.0/25', '192.168.1.128')).toBe(false);
  });

  it('reports false rather than throwing on input the schema would have rejected', () => {
    expect(cidrContains('not-a-cidr', '10.0.0.1')).toBe(false);
    expect(cidrContains('10.0.0.0/33', '10.0.0.1')).toBe(false);
    expect(cidrContains('10.0.0.0/16', '999.0.0.1')).toBe(false);
    expect(cidrContains('10.0.0/16', '10.0.0.1')).toBe(false);
  });
});

describe('auditNetworkPolicy', () => {
  /** A release whose policy is coherent. Each test breaks one thing. */
  const CLOSED = {
    containerPort: 8080,
    service: { type: 'ClusterIP', port: 80 },
    networkPolicy: {
      enabled: true,
      dns: {
        enabled: true,
        namespaceLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        podLabels: { 'k8s-app': 'kube-dns' },
      },
      ingress: [],
      egress: [
        {
          name: 'aws-apis',
          cidr: '0.0.0.0/0',
          except: ['169.254.169.254/32'],
          ports: [{ port: 443, protocol: 'TCP' }],
        },
      ],
    },
  };

  const policyWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...CLOSED,
    networkPolicy: { ...CLOSED.networkPolicy, ...overrides },
  });

  const audit = (merged: Record<string, unknown>): ViolationRule[] =>
    rules(auditNetworkPolicy(merged, 'k8s/charts/app/values-staging.yaml'));

  it('accepts a default-deny release with a metadata-excepting egress allowlist', () => {
    expect(audit(CLOSED)).toEqual([]);
  });

  it('reports nothing for a chart with no networkPolicy block at all', () => {
    expect(audit({ containerPort: 8080 })).toEqual([]);
  });

  it('flags a release with the policy turned off', () => {
    expect(audit(policyWith({ enabled: false }))).toEqual(['network-policy-disabled']);
  });

  it('stops at the disabled policy rather than auditing rules nothing enforces', () => {
    // Every other rule below describes a policy that is subtly wrong. With
    // enforcement off none of them is wrong in any way that matters, and
    // reporting six findings for one cause buries the cause.
    expect(
      audit(
        policyWith({
          enabled: false,
          dns: { enabled: false },
          egress: [{ name: 'open', cidr: '0.0.0.0/0', ports: [{ port: 443 }] }],
        }),
      ),
    ).toEqual(['network-policy-disabled']);
  });

  it('flags a default-deny egress policy with no route to DNS', () => {
    expect(audit(policyWith({ dns: { enabled: false } }))).toEqual(['dns-egress-blocked']);
  });

  it('accepts DNS reached through an explicit egress entry instead', () => {
    expect(
      audit(
        policyWith({
          dns: { enabled: false },
          egress: [
            {
              name: 'node-local-dns',
              podLabels: { 'k8s-app': 'node-local-dns' },
              ports: [
                { port: 53, protocol: 'UDP' },
                { port: 53, protocol: 'TCP' },
              ],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('flags an egress block that leaves the metadata service reachable', () => {
    expect(
      audit(policyWith({ egress: [{ name: 'aws-apis', cidr: '0.0.0.0/0', ports: [{ port: 443 }] }] })),
    ).toEqual(['metadata-service-reachable']);
  });

  it('accepts an except that covers the metadata address through a wider range', () => {
    expect(
      audit(
        policyWith({
          egress: [
            {
              name: 'aws-apis',
              cidr: '0.0.0.0/0',
              except: ['169.254.0.0/16'],
              ports: [{ port: 443 }],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('leaves an egress block that does not reach the metadata address alone', () => {
    expect(
      audit(policyWith({ egress: [{ name: 'vpc', cidr: '10.0.0.0/16', ports: [{ port: 443 }] }] })),
    ).toEqual([]);
  });

  it('flags an ingress entry that admits every address', () => {
    expect(
      audit(policyWith({ ingress: [{ name: 'world', cidr: '0.0.0.0/0', ports: [{ port: 8080 }] }] })),
    ).toEqual(['ingress-from-anywhere']);
  });

  it('leaves a narrow ingress ipBlock alone, public address or not', () => {
    // A `/0` is the whole internet; a named address is an allowlist entry doing
    // its job, and flagging it because it happens to be routable would make the
    // rule a rule against ipBlock rather than against openness.
    expect(
      audit(
        policyWith({
          ingress: [
            { name: 'monitoring-probe', cidr: '203.0.113.7/32', ports: [{ port: 'http' }] },
            { name: 'vpc', cidr: '10.0.0.0/16', ports: [{ port: 8080 }] },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('flags an ingress entry naming the Service port, and says why policy never sees it', () => {
    const violations = auditNetworkPolicy(
      policyWith({
        ingress: [
          {
            name: 'ingress-controller',
            namespaceLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
            ports: [{ port: 80, protocol: 'TCP' }],
          },
        ],
      }),
      'k8s/charts/app/values-staging.yaml',
    );

    expect(rules(violations)).toEqual(['ingress-port-mismatch']);
    expect(violations[0].message).toContain('service.port');
    expect(violations[0].message).toContain('kube-proxy');
  });

  it('flags an ingress port that is neither the container port nor the Service port', () => {
    const violations = auditNetworkPolicy(
      policyWith({
        ingress: [
          {
            name: 'ingress-controller',
            namespaceLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
            ports: [{ port: 9090 }],
          },
        ],
      }),
      'k8s/charts/app/values-staging.yaml',
    );

    expect(rules(violations)).toEqual(['ingress-port-mismatch']);
    expect(violations[0].message).not.toContain('service.port');
  });

  it('accepts the container port by number and by name', () => {
    expect(
      audit(
        policyWith({
          ingress: [
            {
              name: 'by-number',
              podLabels: { 'app.kubernetes.io/name': 'canary-analysis' },
              ports: [{ port: 8080 }],
            },
            {
              name: 'by-name',
              podLabels: { 'app.kubernetes.io/name': 'ingress-nginx' },
              ports: [{ port: 'http' }],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('flags a named ingress port the pod template does not declare', () => {
    expect(
      audit(
        policyWith({
          ingress: [
            {
              name: 'metrics',
              podLabels: { 'app.kubernetes.io/name': 'prometheus' },
              ports: [{ port: 'metrics' }],
            },
          ],
        }),
      ),
    ).toEqual(['ingress-port-mismatch']);
  });

  it('does not check egress ports against the container port', () => {
    // The destination of an egress rule is somebody else's pod, so its ports
    // have nothing to do with what this one listens on.
    expect(
      audit(
        policyWith({
          egress: [
            {
              name: 'postgres',
              podLabels: { 'app.kubernetes.io/name': 'postgres' },
              ports: [{ port: 5432 }],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('flags two allowlist entries sharing a name, in either direction', () => {
    expect(
      audit(
        policyWith({
          ingress: [
            { name: 'dup', podLabels: { a: 'b' }, ports: [{ port: 'http' }] },
            { name: 'dup', podLabels: { c: 'd' }, ports: [{ port: 'http' }] },
          ],
          egress: [
            { name: 'dup', cidr: '10.0.0.0/16', ports: [{ port: 443 }] },
            { name: 'dup', cidr: '10.1.0.0/16', ports: [{ port: 443 }] },
          ],
        }),
      ),
    ).toEqual(['duplicate-network-policy-rule', 'duplicate-network-policy-rule']);
  });

  it('names the same rule twice only once per direction, not per pair', () => {
    expect(
      audit(
        policyWith({
          egress: [
            { name: 'dup', cidr: '10.0.0.0/16', ports: [{ port: 443 }] },
            { name: 'dup', cidr: '10.1.0.0/16', ports: [{ port: 443 }] },
            { name: 'dup', cidr: '10.2.0.0/16', ports: [{ port: 443 }] },
          ],
        }),
      ),
    ).toEqual(['duplicate-network-policy-rule', 'duplicate-network-policy-rule']);
  });

  it('reports nothing rather than throwing on values the schema would have rejected', () => {
    expect(
      audit(
        policyWith({
          ingress: 'not a list',
          egress: [null, { name: 42, ports: 'not a list' }],
        }),
      ),
    ).toEqual([]);
  });
});

describe('auditIngress', () => {
  /** A release whose Ingress is coherent for staging. Each test breaks one thing. */
  const SERVED = {
    ingress: {
      enabled: true,
      className: 'nginx',
      hosts: ['app.staging.example.com'],
      path: '/',
      pathType: 'Prefix',
      tls: { clusterIssuer: 'letsencrypt-staging', renewBefore: '720h', secretName: '' },
      annotations: {},
    },
    networkPolicy: {
      enabled: true,
      ingress: [
        {
          name: 'ingress-controller',
          namespaceLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
          podLabels: { 'app.kubernetes.io/name': 'ingress-nginx' },
          ports: [{ port: 'http', protocol: 'TCP' }],
        },
      ],
      egress: [],
    },
  };

  const STAGING: EnvironmentValues = {
    environment: 'staging',
    path: 'k8s/charts/app/values-staging.yaml',
    document: {},
  };

  const audit = (
    merged: Record<string, unknown>,
    environment: EnvironmentValues = STAGING,
  ): ViolationRule[] => rules(auditIngress(merged, environment, environment.path));

  const ingressWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...SERVED,
    ingress: { ...SERVED.ingress, ...overrides },
  });

  it('accepts a served release whose issuer, annotations and allowlist agree', () => {
    expect(audit(SERVED)).toEqual([]);
  });

  it('accepts the production issuer in the production file', () => {
    const production: EnvironmentValues = {
      environment: 'production',
      path: 'k8s/charts/app/values-production.yaml',
      document: {},
    };

    expect(
      audit(
        ingressWith({
          hosts: ['app.example.com'],
          tls: { ...SERVED.ingress.tls, clusterIssuer: 'letsencrypt-production' },
        }),
        production,
      ),
    ).toEqual([]);
  });

  it('reports nothing at all while the Ingress is disabled', () => {
    // A disabled Ingress with a mismatched issuer and no allowlist entry is not
    // a latent bug — none of it is rendered — and reporting it would make
    // turning the feature off require also unwinding its configuration.
    expect(
      audit({
        ingress: { ...SERVED.ingress, enabled: false, tls: { clusterIssuer: 'nonesuch' } },
        networkPolicy: { enabled: true, ingress: [], egress: [] },
      }),
    ).toEqual([]);
  });

  it('reports an issuer no cluster in this environment installs', () => {
    expect(audit(ingressWith({ tls: { ...SERVED.ingress.tls, clusterIssuer: 'letsencrypt' } }))).toEqual(
      ['cluster-issuer-mismatch'],
    );
  });

  it('reports the other environment’s issuer, which resolves and spends its rate limit', () => {
    expect(
      audit(ingressWith({ tls: { ...SERVED.ingress.tls, clusterIssuer: 'letsencrypt-production' } })),
    ).toEqual(['cluster-issuer-mismatch']);
  });

  it('reports a missing issuer rather than treating the block as absent', () => {
    expect(audit(ingressWith({ tls: { renewBefore: '720h' } }))).toEqual(['cluster-issuer-mismatch']);
  });

  it('reports an annotation the template writes itself', () => {
    expect(
      audit(
        ingressWith({
          annotations: { 'cert-manager.io/cluster-issuer': 'letsencrypt-production' },
        }),
      ),
    ).toEqual(['managed-ingress-annotation']);
  });

  it('reports every managed annotation, not just the first', () => {
    expect(
      audit(
        ingressWith({
          annotations: {
            'cert-manager.io/cluster-issuer': 'letsencrypt-staging',
            'cert-manager.io/renew-before': '48h',
          },
        }),
      ),
    ).toEqual(['managed-ingress-annotation', 'managed-ingress-annotation']);
  });

  it('leaves controller annotations alone', () => {
    expect(
      audit(
        ingressWith({
          annotations: { 'nginx.ingress.kubernetes.io/proxy-body-size': '8m' },
        }),
      ),
    ).toEqual([]);
  });

  it('reports an enabled Ingress with nothing allowed through the policy', () => {
    expect(audit({ ...SERVED, networkPolicy: { enabled: true, ingress: [], egress: [] } })).toEqual([
      'ingress-peer-not-allowed',
    ]);
  });

  it('does not report the allowlist when there is no policy to allow through', () => {
    // `network-policy-disabled` already reports this release, and adding a
    // second violation about the hole in a boundary that is not there would
    // point at the wrong fix.
    expect(audit({ ...SERVED, networkPolicy: { enabled: false, ingress: [], egress: [] } })).toEqual(
      [],
    );
  });

  it('reports nothing for a chart with no ingress block at all', () => {
    expect(audit({ networkPolicy: { enabled: true, ingress: [], egress: [] } })).toEqual([]);
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
    // `minProperties`, not anything about the labels themselves: an empty
    // `matchLabels` is a perfectly valid selector that happens to match every
    // object, so the entry that reads as the narrowest in the file is the
    // widest one in it.
    ['network-policy-open-namespace-selector.yaml', 'minProperties', '/networkPolicy/ingress/0/namespaceLabels'],
    ['network-policy-rule-without-ports.yaml', 'required', '/networkPolicy/ingress/0'],
    // The egress refinement, not the shared port definition — a named port is
    // legal on ingress and meaningless on egress, so `type: integer` is added
    // in the `allOf` branch rather than tightened for both directions.
    ['network-policy-named-egress-port.yaml', 'type', '/networkPolicy/egress/0/ports/0/port'],
    ['network-policy-peerless-rule.yaml', 'anyOf', '/networkPolicy/egress/0'],
    // `minItems` reached through the `if`/`then` on `ingress`, not a bare one on
    // `hosts`: an empty list is correct while the Ingress is off and useless
    // once it is on, and only the conditional branch can tell the two apart.
    ['ingress-enabled-without-host.yaml', 'minItems', '/ingress/hosts'],
    ['ingress-host-with-scheme.yaml', 'pattern', '/ingress/hosts/0'],
    ['ingress-without-tls.yaml', 'required', '/ingress'],
    ['ingress-renew-before-in-days.yaml', 'pattern', '/ingress/tls/renewBefore'],
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

/**
 * The other half of the pair. `schema-fixtures/` keeps the schema from quietly
 * stopping to catch anything; these keep the templates from quietly stopping to
 * render anything.
 *
 * A chart's gates only execute the template paths its own values files reach.
 * Every optional block — an `{{- if }}` around a whole object, a `range` over a
 * list that is empty in both environments, the second arm of a `default` — is
 * rendered by nothing unless something turns it on.
 * `.github/scripts/lint-helm-chart.sh` renders these; the assertions here are
 * that the schema still accepts them, because a fixture that has drifted into
 * being rejected turns into a render the script silently stops performing.
 */
describe('the render fixtures', () => {
  const defaults = yaml(path.join(APP_CHART, 'values.yaml'));
  const validate = compileSchema(json(path.join(APP_CHART, 'values.schema.json')));

  /**
   * Each fixture with the thing it must still be doing that no environment file
   * does. Without these a fixture could be quietly reduced to a copy of the
   * defaults and go on passing every other assertion here while covering
   * nothing — which is the same failure the fixtures exist to prevent, one
   * level up.
   */
  const FIXTURES: ReadonlyArray<[file: string, covers: (merged: Record<string, any>) => void]> = [
    [
      'network-policy-allowlist.yaml',
      (merged) => {
        // Both environment files carry exactly one ingress entry, of one shape.
        // This is what reaches the other two peer shapes and the named-versus-
        // numeric port forms.
        expect(merged.networkPolicy.ingress.length).toBeGreaterThan(1);
        expect(merged.networkPolicy.egress[0].except.length).toBeGreaterThan(0);
      },
    ],
    [
      'ingress-overrides.yaml',
      (merged) => {
        // Several hosts, so both `range` loops in templates/ingress.yaml run
        // more than once; an adopted secret name, so `app.tlsSecretName` takes
        // its override arm; pass-through annotations, so the `merge` runs
        // against a non-empty map.
        expect(merged.ingress.hosts.length).toBeGreaterThan(1);
        expect(merged.ingress.tls.secretName).not.toBe('');
        expect(Object.keys(merged.ingress.annotations).length).toBeGreaterThan(0);
      },
    ],
  ];

  it.each(FIXTURES)('accepts %s', (file) => {
    const merged = coalesceValues(defaults, yaml(path.join(APP_CHART, 'render-fixtures', file)));

    expect(validate(merged)).toBe(true);
  });

  it('covers every fixture on disk', () => {
    const onDisk = fs
      .readdirSync(path.join(APP_CHART, 'render-fixtures'))
      .filter((file) => file.endsWith('.yaml'))
      .sort();

    expect(onDisk).toEqual(FIXTURES.map(([file]) => file).sort());
  });

  it.each(FIXTURES)('%s exercises a path the environment files leave off', (file, covers) => {
    covers(coalesceValues(defaults, yaml(path.join(APP_CHART, 'render-fixtures', file))));
  });

  it('leaves those paths unreached by the environment files themselves', () => {
    for (const environment of ENVIRONMENTS) {
      const merged = coalesceValues(defaults, yaml(path.join(APP_CHART, `values-${environment}.yaml`)));
      const policy = merged.networkPolicy as { ingress?: unknown[] };
      const ingress = merged.ingress as { hosts: unknown[]; tls: { secretName?: string } };

      // One peer, of one shape: the ingress controller. That is the whole
      // allowlist in both environments, which is what leaves the other shapes
      // to the fixture above.
      expect(policy.ingress).toHaveLength(1);
      expect(ingress.hosts).toHaveLength(1);
      expect(ingress.tls.secretName ?? '').toBe('');
    }
  });
});
