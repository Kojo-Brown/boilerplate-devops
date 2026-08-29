import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import {
  ARGOCD_NAMESPACE,
  ARGO_API_VERSION,
  ArgoTree,
  LoadedArgocd,
  ManifestDocument,
  RESOURCES_FINALIZER,
  SYNC_WAVE_ANNOTATION,
  UnsupportedGlobError,
  Violation,
  ViolationRule,
  auditArgocd,
  auditManifestShape,
  auditTree,
  documentKind,
  documentName,
  formatViolations,
  globMatches,
  isDestinationPermitted,
  isSourcePermitted,
  normalizeRepoUrl,
  readArgocd,
  syncWave,
} from '../tools/audit-argocd';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'k8s', 'argocd', 'fixtures');

const repository = readArgocd(REPO_ROOT);

const rules = (violations: readonly Violation[]): ViolationRule[] => violations.map((v) => v.rule);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const tree = (environment: string): ArgoTree => {
  const found = repository.trees.find((candidate) => candidate.environment === environment);
  if (found === undefined) throw new Error(`no ${environment} tree under k8s/argocd`);
  return found;
};

const manifest = (
  document: unknown,
  file = 'k8s/argocd/staging/applications/app.yaml',
): ManifestDocument => ({ file, index: 0, documentsInFile: 1, document });

const applications = (candidate: ArgoTree): ManifestDocument[] =>
  [...candidate.root, ...candidate.managed].filter(
    (entry) => documentKind(entry.document) === 'Application',
  );

const emptyRepository: LoadedArgocd = {
  trees: [],
  missingEnvironments: [],
  orphanDirectories: [],
  strayFiles: [],
};

const bareTree = (environment: string, manifestFiles: string[]): ArgoTree => ({
  environment,
  directory: `k8s/argocd/${environment}`,
  root: [],
  managed: [],
  manifestFiles,
  unreadable: [],
});

describe('the Argo CD manifests in this repository', () => {
  it('audits clean', () => {
    expect(auditArgocd(repository)).toEqual([]);
  });

  it('carries one tree per environment, with a root Application in each', () => {
    expect(repository.trees.map((candidate) => candidate.environment)).toEqual([
      'production',
      'staging',
    ]);
    expect(repository.missingEnvironments).toEqual([]);

    for (const candidate of repository.trees) {
      const roots = candidate.root.filter((entry) => documentKind(entry.document) === 'Application');
      expect(roots).toHaveLength(1);
    }
  });

  it('keeps the two environment trees file-for-file parallel', () => {
    const [production, staging] = repository.trees;
    expect(production.manifestFiles).toEqual(staging.manifestFiles);
  });

  // Asserted here as well as through the audit so that turning one off is a test
  // named after what it turns off, rather than a violation in a list.
  it('self-heals and prunes every Application, root included', () => {
    for (const candidate of repository.trees) {
      for (const entry of applications(candidate)) {
        const automated = (entry.document as Record<string, any>).spec.syncPolicy.automated;

        expect({ name: documentName(entry.document), ...automated }).toEqual({
          name: documentName(entry.document),
          prune: true,
          selfHeal: true,
          allowEmpty: false,
        });
      }
    }
  });

  it('gives every Application the cascade-delete finalizer', () => {
    for (const candidate of repository.trees) {
      for (const entry of applications(candidate)) {
        expect((entry.document as Record<string, any>).metadata.finalizers).toContain(
          RESOURCES_FINALIZER,
        );
      }
    }
  });

  it('orders the waves projects → platform → workload', () => {
    for (const candidate of repository.trees) {
      const waves = Object.fromEntries(
        candidate.managed.map((entry) => [
          `${documentKind(entry.document)}/${documentName(entry.document)}`,
          syncWave(entry.document).value,
        ]),
      );

      expect(waves).toEqual({
        'AppProject/app': -10,
        'AppProject/platform': -10,
        'Application/metrics-server': 0,
        [`Application/app-${candidate.environment}`]: 10,
      });
    }
  });

  it('leaves the fixtures outside every tree, where no root Application reaches them', () => {
    for (const candidate of repository.trees) {
      for (const file of candidate.manifestFiles) {
        expect(file.startsWith('fixtures')).toBe(false);
      }
    }

    expect(repository.strayFiles).toEqual([]);
    expect(fs.existsSync(FIXTURES)).toBe(true);
  });
});

describe('globMatches', () => {
  // gobwas/glob compiled without separators, which is how Argo CD compiles
  // `directory.include`. The `/`-crossing behaviour is the surprising half.
  it('matches `*` across path separators', () => {
    expect(globMatches('*.yaml', 'projects/app.yaml')).toBe(true);
    expect(globMatches('projects/*.yaml', 'projects/app.yaml')).toBe(true);
    expect(globMatches('projects/*.yaml', 'applications/app.yaml')).toBe(false);
  });

  it('expands brace alternation', () => {
    expect(globMatches('{projects/*.yaml,applications/*.yaml}', 'applications/app.yaml')).toBe(true);
    expect(globMatches('{projects/*.yaml,applications/*.yaml}', 'root.yaml')).toBe(false);
  });

  it('treats a comma outside braces as a literal', () => {
    expect(globMatches('a,b.yaml', 'a,b.yaml')).toBe(true);
    expect(globMatches('a,b.yaml', 'a.yaml')).toBe(false);
  });

  it('anchors the whole string rather than matching a substring', () => {
    expect(globMatches('app.yaml', 'applications/app.yaml')).toBe(false);
  });

  it('refuses syntax it cannot model the way Argo CD does', () => {
    expect(() => globMatches('[a-z]*.yaml', 'app.yaml')).toThrow(UnsupportedGlobError);
    expect(() => globMatches('{a,b', 'a')).toThrow(UnsupportedGlobError);
  });
});

describe('project permission matching', () => {
  it('normalises the case and a `.git` suffix, but not a trailing slash', () => {
    expect(normalizeRepoUrl('https://GitHub.com/Kojo-Brown/boilerplate-devops.git')).toBe(
      'https://github.com/kojo-brown/boilerplate-devops',
    );
    expect(normalizeRepoUrl('https://example.com/charts/')).toBe('https://example.com/charts/');
  });

  const project = (sourceRepos: string[], destinations: unknown[]): unknown => ({
    spec: { sourceRepos, destinations },
  });

  it('permits a repository listed with a different `.git` suffix', () => {
    const permitted = project(['https://github.com/Kojo-Brown/boilerplate-devops'], []);
    expect(isSourcePermitted(permitted, 'https://github.com/Kojo-Brown/boilerplate-devops.git')).toBe(
      true,
    );
  });

  it('refuses a repository that differs only by a trailing slash', () => {
    const permitted = project(['https://example.com/charts'], []);
    expect(isSourcePermitted(permitted, 'https://example.com/charts/')).toBe(false);
  });

  it('honours the `!` deny prefix, which overrides a matching allow', () => {
    const permitted = project(['https://github.com/Kojo-Brown/*', '!https://github.com/Kojo-Brown/secrets'], []);
    expect(isSourcePermitted(permitted, 'https://github.com/Kojo-Brown/boilerplate-devops')).toBe(true);
    expect(isSourcePermitted(permitted, 'https://github.com/Kojo-Brown/secrets')).toBe(false);
  });

  it('requires both halves of a destination to match', () => {
    const permitted = project([], [{ server: 'https://kubernetes.default.svc', namespace: 'staging' }]);

    expect(
      isDestinationPermitted(permitted, {
        server: 'https://kubernetes.default.svc',
        namespace: 'staging',
      }),
    ).toBe(true);
    expect(
      isDestinationPermitted(permitted, {
        server: 'https://kubernetes.default.svc',
        namespace: 'production',
      }),
    ).toBe(false);
    expect(
      isDestinationPermitted(permitted, { server: 'https://other.example', namespace: 'staging' }),
    ).toBe(false);
  });
});

describe('syncWave', () => {
  const withAnnotation = (value: unknown): unknown => ({
    metadata: { annotations: { [SYNC_WAVE_ANNOTATION]: value } },
  });

  it('reads a quoted integer, including a negative one', () => {
    expect(syncWave(withAnnotation('-10'))).toEqual({ raw: '-10', value: -10 });
  });

  it('reports the raw value with no wave when Argo CD could not parse one', () => {
    // Argo CD parses this with strconv.Atoi and falls back to 0, so the audit
    // has to distinguish "no wave" from "a wave that silently became 0".
    expect(syncWave(withAnnotation('ten'))).toEqual({ raw: 'ten' });
    expect(syncWave(withAnnotation(10))).toEqual({ raw: 10 });
  });

  it('reports nothing at all when the annotation is absent', () => {
    expect(syncWave({ metadata: {} })).toEqual({ raw: undefined });
  });
});

/**
 * Every file in `k8s/argocd/fixtures/`, and the rule that must catch it.
 *
 * Substituted into the staging tree in place of the manifest it shadows, so each
 * one is audited in the same context the real manifest is. Several trip more
 * than one rule — the mistakes are not independent — which is why the assertion
 * names a rule rather than counting violations.
 */
const FIXTURE_RULES: Record<string, ViolationRule> = {
  'application-allow-empty.yaml': 'allow-empty-enabled',
  'application-floating-chart-version.yaml': 'mutable-target-revision',
  'application-foreign-values-file.yaml': 'values-file-mismatch',
  'application-from-foreign-repo.yaml': 'source-not-permitted',
  'application-into-argocd-namespace.yaml': 'argocd-namespace-target',
  'application-outside-project-destination.yaml': 'destination-not-permitted',
  'application-sharing-platform-wave.yaml': 'sync-wave-ordering',
  'application-tracking-head.yaml': 'mutable-target-revision',
  'application-unknown-project.yaml': 'unknown-project',
  'application-unquoted-sync-wave.yaml': 'annotation-not-a-string',
  'application-with-ambiguous-destination.yaml': 'ambiguous-destination',
  'application-without-automated-sync.yaml': 'drift-uncorrected',
  'application-without-finalizer.yaml': 'missing-finalizer',
  'application-without-namespace-creation.yaml': 'namespace-not-created',
  'application-without-prune.yaml': 'prune-disabled',
  'application-without-release-name.yaml': 'release-name-not-pinned',
  'application-without-self-heal.yaml': 'drift-uncorrected',
  'application-without-sync-wave.yaml': 'missing-sync-wave',
  'project-granting-cluster-rbac.yaml': 'cluster-scope-escalation',
  'project-with-wildcard-destination.yaml': 'open-project-scope',
};

const treeWithFixture = (file: string): ArgoTree => {
  const document = load(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  const kind = documentKind(document);
  const name = documentName(document);
  const staging = tree('staging');

  let substituted = 0;
  const managed = staging.managed.map((entry) => {
    if (documentKind(entry.document) !== kind || documentName(entry.document) !== name) return entry;
    substituted += 1;
    return { ...entry, document };
  });

  if (substituted !== 1) {
    throw new Error(
      `${file} shadows ${substituted} manifests in the staging tree; a fixture must shadow ` +
        'exactly one, or it is being audited in a context the real tree never has.',
    );
  }

  return { ...staging, managed };
};

describe('fixtures', () => {
  it('the staging tree they are substituted into is itself clean', () => {
    expect(auditTree(tree('staging'))).toEqual([]);
  });

  it.each(Object.entries(FIXTURE_RULES))('%s is rejected by `%s`', (file, rule) => {
    expect(rules(auditTree(treeWithFixture(file)))).toContain(rule);
  });

  it('covers every fixture on disk', () => {
    const onDisk = fs
      .readdirSync(FIXTURES)
      .filter((file) => file.endsWith('.yaml'))
      .sort();

    expect(onDisk).toEqual(Object.keys(FIXTURE_RULES).sort());
  });
});

describe('rules with no fixture of their own', () => {
  // These describe a *tree* rather than a manifest — a missing file, a file
  // nothing applies, a directory that should not exist — so there is nothing to
  // put in fixtures/ that would exercise them.

  it('reports a file that is not parseable YAML', () => {
    const broken: ArgoTree = {
      ...tree('staging'),
      unreadable: [{ file: 'k8s/argocd/staging/applications/app.yaml', message: 'is not valid YAML' }],
    };

    expect(rules(auditTree(broken))).toContain('manifest-unreadable');
  });

  it('reports a document that is not an Argo CD Application or AppProject', () => {
    const configMap = manifest({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'notes', namespace: ARGOCD_NAMESPACE },
    });

    expect(rules(auditManifestShape(configMap, { managed: true }))).toContain('unexpected-manifest');
  });

  it('reports a manifest outside the argocd namespace', () => {
    const elsewhere = manifest({
      apiVersion: ARGO_API_VERSION,
      kind: 'Application',
      metadata: {
        name: 'app-staging',
        namespace: 'staging',
        annotations: { [SYNC_WAVE_ANNOTATION]: '10' },
      },
    });

    expect(rules(auditManifestShape(elsewhere, { managed: true }))).toContain('unexpected-manifest');
  });

  it('reports an AppProject filed under applications/', () => {
    const misfiled = manifest(
      {
        apiVersion: ARGO_API_VERSION,
        kind: 'AppProject',
        metadata: {
          name: 'app',
          namespace: ARGOCD_NAMESPACE,
          annotations: { [SYNC_WAVE_ANNOTATION]: '-10' },
        },
      },
      'k8s/argocd/staging/applications/app-project.yaml',
    );

    expect(rules(auditManifestShape(misfiled, { managed: true }))).toContain('manifest-misplaced');
  });

  it('reports a sync wave Argo CD would silently read as 0', () => {
    const mistyped = manifest({
      apiVersion: ARGO_API_VERSION,
      kind: 'Application',
      metadata: {
        name: 'app-staging',
        namespace: ARGOCD_NAMESPACE,
        annotations: { [SYNC_WAVE_ANNOTATION]: 'ten' },
      },
    });

    expect(rules(auditManifestShape(mistyped, { managed: true }))).toContain(
      'sync-wave-not-an-integer',
    );
  });

  it('requires no sync wave on root.yaml, which nothing applies waves to', () => {
    const root = manifest(
      {
        apiVersion: ARGO_API_VERSION,
        kind: 'Application',
        metadata: { name: 'root-staging', namespace: ARGOCD_NAMESPACE },
      },
      'k8s/argocd/staging/root.yaml',
    );

    expect(auditManifestShape(root, { managed: false })).toEqual([]);
  });

  it('reports a second Application sharing a name with the first', () => {
    const staging = tree('staging');
    const duplicate = staging.managed.find(
      (entry) => documentName(entry.document) === 'app-staging',
    );
    if (duplicate === undefined) throw new Error('no app-staging Application in the staging tree');

    const doubled: ArgoTree = { ...staging, managed: [...staging.managed, duplicate] };

    expect(rules(auditTree(doubled))).toContain('duplicate-application-name');
  });

  it('reports a manifest the root Application would not apply', () => {
    const staging = tree('staging');
    const withNotes: ArgoTree = {
      ...staging,
      manifestFiles: [...staging.manifestFiles, 'notes.yaml'],
    };

    const violation = auditTree(withNotes).find((entry) => entry.rule === 'unmanaged-manifest');

    expect(violation?.file).toBe('k8s/argocd/staging/notes.yaml');
  });

  it('reports a root Application whose include pattern covers root.yaml', () => {
    const staging = clone(tree('staging'));
    const root = staging.root.find((entry) => documentKind(entry.document) === 'Application');
    (root?.document as Record<string, any>).spec.source.directory.include = '*.yaml';

    expect(rules(auditTree(staging))).toContain('root-manages-itself');
  });

  it('refuses to guess at an include pattern it cannot model', () => {
    const staging = clone(tree('staging'));
    const root = staging.root.find((entry) => documentKind(entry.document) === 'Application');
    (root?.document as Record<string, any>).spec.source.directory.include = '[pa]*/*.yaml';

    expect(rules(auditTree(staging))).toContain('include-pattern-unsupported');
  });

  it('reports a root.yaml with no Application in it', () => {
    const staging = tree('staging');
    const rootless: ArgoTree = { ...staging, root: [] };

    expect(rules(auditTree(rootless))).toContain('missing-root-application');
  });

  it('reports an environment with no tree', () => {
    const violations = auditArgocd({ ...emptyRepository, missingEnvironments: ['production'] });

    expect(rules(violations)).toEqual(['missing-environment-tree']);
    expect(violations[0].file).toBe('k8s/argocd/production');
  });

  it('reports a tree for an environment nothing deploys', () => {
    const violations = auditArgocd({
      ...emptyRepository,
      orphanDirectories: ['k8s/argocd/sandbox'],
    });

    expect(rules(violations)).toEqual(['orphan-environment-tree']);
  });

  it('reports a manifest that belongs to no tree', () => {
    const violations = auditArgocd({
      ...emptyRepository,
      strayFiles: ['k8s/argocd/application.yaml'],
    });

    expect(rules(violations)).toEqual(['stray-manifest']);
  });

  it('reports a file one environment has and the other does not', () => {
    const violations = auditArgocd({
      ...emptyRepository,
      trees: [
        bareTree('staging', ['root.yaml', 'applications/canary.yaml']),
        bareTree('production', ['root.yaml']),
      ],
    });

    const missing = violations.filter((entry) => entry.rule === 'trees-not-parallel');

    expect(missing.map((entry) => entry.file)).toEqual([
      'k8s/argocd/staging/applications/canary.yaml',
    ]);
  });
});

describe('formatViolations', () => {
  it('names the rule and the file to open', () => {
    const formatted = formatViolations([
      { rule: 'prune-disabled', file: 'k8s/argocd/staging/applications/app.yaml', message: 'no.' },
    ]);

    expect(formatted).toContain('[prune-disabled]');
    expect(formatted).toContain('k8s/argocd/staging/applications/app.yaml');
    expect(formatted).toContain('no.');
  });
});
