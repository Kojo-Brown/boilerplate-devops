#!/usr/bin/env node
/**
 * Audit the Argo CD manifests under `k8s/argocd/`.
 *
 * These files are a cluster's desired state, and almost nothing checks them. The
 * Kubernetes API server validates an `Application` against the Argo CD CRD,
 * whose `spec.source` is typed as an object — it has no opinion about a project
 * that does not exist, a values file belonging to the other environment, or a
 * `selfHeal` that was never turned on. Argo CD reports those at reconciliation
 * time, on the cluster, after the merge, and some of them it does not report at
 * all because the result is a working application that is quietly not doing what
 * the file says.
 *
 * Each rule and the failure it prevents:
 *
 *   manifest-unreadable      a file in the GitOps tree that is not parseable
 *                            YAML, which fails the sync of everything beside it
 *   unexpected-manifest      a document that is not an Argo CD Application or
 *                            AppProject in the argocd namespace
 *   manifest-misplaced       an AppProject under `applications/` or the reverse,
 *                            so the directory layout stops describing the tree
 *   annotation-not-a-string  a non-string annotation value, which the API server
 *                            rejects for the whole document
 *   missing-environment-tree an environment with no Argo CD tree
 *   orphan-environment-tree  a tree for an environment nothing deploys
 *   trees-not-parallel       one environment gaining or losing a file the other
 *                            does not, which is how production stops running
 *                            what staging exercised
 *   missing-root-application `root.yaml` without exactly one Application
 *   stray-manifest           a manifest under `k8s/argocd/` that belongs to no
 *                            environment tree, so nothing applies it
 *   unmanaged-manifest       a manifest inside a tree that the root
 *                            Application's `include`/`exclude` does not match:
 *                            committed, reviewed, and applied by nothing
 *   root-manages-itself      a root Application whose globs cover `root.yaml`,
 *                            making the trust root something a bad refactor can
 *                            prune
 *   include-pattern-unsupported
 *                            an `include`/`exclude` glob this audit cannot model
 *                            the way Argo CD does, which would leave the two
 *                            rules above silently checking the wrong thing
 *   unknown-project          an Application naming a project that does not exist
 *                            in its own tree — admitted, then stuck reporting a
 *                            comparison error
 *   ambiguous-destination    a destination setting both `name` and `server`,
 *                            which Argo CD rejects
 *   destination-not-permitted
 *                            a destination its project does not allow
 *   source-not-permitted     a `repoURL` its project does not allow
 *   argocd-namespace-target  a child Application deploying into the namespace
 *                            Argo CD itself runs in, which is admin access
 *   missing-finalizer        an Application whose deletion would orphan every
 *                            resource it created
 *   drift-uncorrected        no automated sync, or automated sync without
 *                            `selfHeal`: drift is then reported and kept
 *   prune-disabled           removing a file from git stops removing anything
 *                            from the cluster
 *   allow-empty-enabled      the last guard against an empty render pruning an
 *                            entire release
 *   missing-sync-wave        no wave annotation, so the resource lands in wave 0
 *                            beside the things meant to precede it
 *   sync-wave-not-an-integer a wave Argo CD parses with `strconv.Atoi` and
 *                            silently treats as 0 when parsing fails
 *   sync-wave-ordering       projects, platform add-ons and workloads out of
 *                            order or sharing a wave
 *   mutable-target-revision  `HEAD`, an empty revision, or a chart version range
 *                            — a cluster that changes with no commit behind it
 *   release-name-not-pinned  a Helm release name left to default to the
 *                            Application name, which makes a rename a
 *                            delete-and-recreate of every object in the release
 *   values-file-mismatch     an environment's Application rendering another
 *                            environment's values file
 *   destination-namespace-mismatch
 *                            a release deployed outside its environment's
 *                            namespace, where its IRSA role does not apply
 *   namespace-not-created    a destination namespace that nothing creates
 *   open-project-scope       `*` in a project's sources or destinations, which
 *                            is the `default` project wearing a name
 *   cluster-scope-escalation a project permitting cluster-scoped resources
 *                            beyond what its role needs
 *   duplicate-application-name
 *                            two Applications with one name, where the second
 *                            silently replaces the first
 *
 * Usage:
 *   npm run audit:argocd                      # audits the repository root
 *   npx ts-node tools/audit-argocd.ts <dir>
 *
 * Exits non-zero when anything is found.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadAll } from 'js-yaml';
import { ENVIRONMENTS } from './audit-helm-values';

/** Directory holding the Argo CD manifests, relative to the repository root. */
export const ARGOCD_DIRECTORY = path.posix.join('k8s', 'argocd');

/**
 * Manifests that must be *rejected*, kept outside every environment tree so that
 * no root Application can reach them. `k8s/argocd/fixtures/README.md` explains
 * the pair; `stray-manifest` is what stops a fixture from being moved into a
 * tree, where a cluster would apply it.
 */
export const FIXTURES_DIRECTORY = path.posix.join(ARGOCD_DIRECTORY, 'fixtures');

/** The namespace Argo CD runs in, and the only one these manifests live in. */
export const ARGOCD_NAMESPACE = 'argocd';

export const ARGO_API_VERSION = 'argoproj.io/v1alpha1';

/**
 * Without this finalizer, deleting an Application deletes the Application and
 * leaves everything it created running — owned by nothing, reconciled by
 * nothing, and absent from the next listing anybody looks at.
 */
export const RESOURCES_FINALIZER = 'resources-finalizer.argocd.argoproj.io';

export const SYNC_WAVE_ANNOTATION = 'argocd.argoproj.io/sync-wave';

/** The project the root Application belongs to; declared alongside it. */
export const BOOTSTRAP_PROJECT = 'bootstrap';
/** Cluster add-ons. Privileged: it may create cluster-scoped resources. */
export const PLATFORM_PROJECT = 'platform';
/** Application releases. Confined to one namespace. */
export const WORKLOAD_PROJECT = 'app';

/** Path of the chart the workload Applications deploy. */
export const APP_CHART_PATH = path.posix.join('k8s', 'charts', 'app');

/**
 * Namespaces that exist without anyone creating them, so an Application
 * targeting one needs no `CreateNamespace=true` — and is better without it,
 * since a namespace Argo CD manages is a namespace Argo CD can prune.
 */
export const PREEXISTING_NAMESPACES: readonly string[] = [
  'default',
  'kube-system',
  'kube-public',
  'kube-node-lease',
  ARGOCD_NAMESPACE,
];

/**
 * Cluster-scoped kinds the platform project may create.
 *
 * Adding an entry widens what a compromised upstream chart can do to the whole
 * cluster, so the list lives in code with a reason attached rather than in the
 * manifests it checks — the same shape as `lib/checkov-suppressions.ts`.
 *
 *   APIService                     metrics-server's aggregation-layer
 *                                  registration for `v1beta1.metrics.k8s.io`
 *   ClusterRole/ClusterRoleBinding every add-on creates them; for metrics-server
 *                                  also the `system:auth-delegator` binding that
 *                                  lets the API server delegate authn to it
 *   CustomResourceDefinition       cert-manager's. The widest entry here: a CRD
 *                                  is a new API, and a chart that may define one
 *                                  may define any of them
 *   Validating/MutatingWebhookConfiguration
 *                                  cert-manager's admission webhooks and
 *                                  ingress-nginx's. A mutating webhook can
 *                                  rewrite every object it matches
 *   IngressClass                   ingress-nginx's `nginx` class
 *   ClusterIssuer                  the ACME issuer in `k8s/cert-manager/`
 *   Namespace                      the namespaces `CreateNamespace=true`
 *                                  creates, and the one kind here that must
 *                                  additionally be restricted by `name` — see
 *                                  {@link NAME_RESTRICTED_PLATFORM_KINDS}
 */
export const PLATFORM_CLUSTER_KINDS: readonly string[] = [
  'apiregistration.k8s.io/APIService',
  'rbac.authorization.k8s.io/ClusterRole',
  'rbac.authorization.k8s.io/ClusterRoleBinding',
  'apiextensions.k8s.io/CustomResourceDefinition',
  'admissionregistration.k8s.io/ValidatingWebhookConfiguration',
  'admissionregistration.k8s.io/MutatingWebhookConfiguration',
  'networking.k8s.io/IngressClass',
  'cert-manager.io/ClusterIssuer',
  '/Namespace',
];

/**
 * Kinds the platform project may permit only when the entry names the specific
 * resource, rather than the kind as a whole.
 *
 * `Namespace` is the only one, and the distinction is not decorative: these
 * Applications prune, so a project permitting `Namespace` unrestricted may
 * delete any namespace in the cluster — `kube-system` included — the moment a
 * refactor moves a file. The workload project has always been held to naming
 * its namespace; this holds the privileged project to the same rule.
 */
export const NAME_RESTRICTED_PLATFORM_KINDS: readonly string[] = ['/Namespace'];

/**
 * Semantic version with no range operator. Chart revisions are exact.
 *
 * The optional `v` is not laxity. A chart may publish its versions with the
 * prefix its releases carry — cert-manager's are `v1.21.1` — and writing
 * `1.21.1` for one of those is a *constraint* Helm re-resolves rather than the
 * exact version the repository index lists. What this still refuses is
 * everything that can move: `^1.21`, `~1.21.1`, `>=1.21`, `*`, and a bare
 * `1.21`.
 */
const EXACT_CHART_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** What Argo CD considers a possible manifest in a directory-type Application. */
const MANIFEST_FILE = /\.(ya?ml|json)$/;

export type ViolationRule =
  | 'manifest-unreadable'
  | 'unexpected-manifest'
  | 'manifest-misplaced'
  | 'annotation-not-a-string'
  | 'missing-environment-tree'
  | 'orphan-environment-tree'
  | 'trees-not-parallel'
  | 'missing-root-application'
  | 'stray-manifest'
  | 'unmanaged-manifest'
  | 'root-manages-itself'
  | 'include-pattern-unsupported'
  | 'unknown-project'
  | 'ambiguous-destination'
  | 'destination-not-permitted'
  | 'source-not-permitted'
  | 'argocd-namespace-target'
  | 'missing-finalizer'
  | 'drift-uncorrected'
  | 'prune-disabled'
  | 'allow-empty-enabled'
  | 'missing-sync-wave'
  | 'sync-wave-not-an-integer'
  | 'sync-wave-ordering'
  | 'mutable-target-revision'
  | 'release-name-not-pinned'
  | 'values-file-mismatch'
  | 'destination-namespace-mismatch'
  | 'namespace-not-created'
  | 'open-project-scope'
  | 'cluster-scope-escalation'
  | 'duplicate-application-name';

export interface Violation {
  readonly rule: ViolationRule;
  /** Repository-relative path a reader should open to fix it. */
  readonly file: string;
  readonly message: string;
}

/** One YAML document, with enough provenance to name it in a message. */
export interface ManifestDocument {
  /** Repository-relative, e.g. `k8s/argocd/staging/applications/app.yaml`. */
  readonly file: string;
  /** Index of the document within its file; `root.yaml` holds two. */
  readonly index: number;
  /** Total documents in that file, so a message can omit a useless `[0]`. */
  readonly documentsInFile: number;
  /** Whatever `js-yaml` produced. Narrowed defensively — this is user input. */
  readonly document: unknown;
}

/** One environment's Argo CD tree, loaded far enough to audit without a cluster. */
export interface ArgoTree {
  readonly environment: string;
  /** Repository-relative directory, e.g. `k8s/argocd/staging`. */
  readonly directory: string;
  /** Documents in `root.yaml`: applied by hand, managed by nothing. */
  readonly root: readonly ManifestDocument[];
  /** Documents under `projects/` and `applications/`: applied by the root. */
  readonly managed: readonly ManifestDocument[];
  /** Every manifest-shaped file in the tree, relative to {@link directory}. */
  readonly manifestFiles: readonly string[];
  /** Files that did not parse. An absence of documents is not the same thing. */
  readonly unreadable: readonly { readonly file: string; readonly message: string }[];
}

/** Everything under `k8s/argocd`, read from disk. */
export interface LoadedArgocd {
  readonly trees: readonly ArgoTree[];
  /** Environments in {@link ENVIRONMENTS} with no directory of their own. */
  readonly missingEnvironments: readonly string[];
  /** Directories that are neither an environment nor `fixtures`. */
  readonly orphanDirectories: readonly string[];
  /** Manifest files under `k8s/argocd` that belong to no tree. */
  readonly strayFiles: readonly string[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const metadataOf = (document: unknown): Record<string, unknown> =>
  asRecord(asRecord(document)?.metadata) ?? {};

const specOf = (document: unknown): Record<string, unknown> =>
  asRecord(asRecord(document)?.spec) ?? {};

export const documentKind = (document: unknown): string | undefined =>
  asString(asRecord(document)?.kind);

export const documentName = (document: unknown): string =>
  asString(metadataOf(document).name) ?? '<unnamed>';

/** `<file>` or `<file>[1]` — the index only when the file holds more than one. */
export const describeManifest = (manifest: ManifestDocument): string =>
  manifest.documentsInFile > 1 ? `${manifest.file}[${manifest.index}]` : manifest.file;

/**
 * A glob pattern this audit cannot model the way Argo CD does.
 *
 * Argo CD matches `directory.include` and `directory.exclude` with gobwas/glob
 * compiled with no separator runes. This reimplements the subset those patterns
 * need — `*`, `?`, `{a,b}` and backslash escapes — and refuses the rest rather
 * than approximating it: a pattern that matched differently here would leave
 * `unmanaged-manifest` and `root-manages-itself` reporting on a file set the
 * cluster does not use, which is worse than not checking at all.
 */
export class UnsupportedGlobError extends Error {}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Match `text` against a gobwas/glob pattern compiled without separators.
 *
 * The absent separators are the part worth remembering: `*` matches `/` as well,
 * so `*.yaml` matches `projects/app.yaml`, and an `include` meant to select one
 * directory's files also selects everything nested below it.
 *
 * @throws {UnsupportedGlobError} for character classes and other syntax outside
 * the supported subset.
 */
export const globMatches = (pattern: string, text: string): boolean => {
  let expression = '';
  let braceDepth = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined) throw new UnsupportedGlobError('pattern ends in a backslash');
      expression += escapeRegExp(escaped);
      index += 1;
    } else if (character === '*') {
      // `**` is the same as `*` when no separator is set: both match everything.
      while (pattern[index + 1] === '*') index += 1;
      expression += '[\\s\\S]*';
    } else if (character === '?') {
      expression += '[\\s\\S]';
    } else if (character === '{') {
      braceDepth += 1;
      expression += '(?:';
    } else if (character === '}') {
      if (braceDepth === 0) throw new UnsupportedGlobError('unbalanced `}`');
      braceDepth -= 1;
      expression += ')';
    } else if (character === ',') {
      expression += braceDepth > 0 ? '|' : ',';
    } else if (character === '[' || character === ']') {
      throw new UnsupportedGlobError(`character classes are not supported (\`${character}\`)`);
    } else {
      expression += escapeRegExp(character);
    }
  }

  if (braceDepth > 0) throw new UnsupportedGlobError('unbalanced `{`');

  return new RegExp(`^${expression}$`).test(text);
};

/**
 * Normalise a repository URL the way Argo CD does before comparing it with a
 * project's `sourceRepos`: lower-cased, trimmed, and without a `.git` suffix.
 *
 * A trailing *slash* is deliberately not normalised, here or in Argo CD, which
 * is the form this bites: Helm chart repositories are conventionally written
 * with one, so `https://example.com/charts` in a project and
 * `https://example.com/charts/` in an Application are two different strings and
 * the sync fails on a permission error naming neither of them.
 */
export const normalizeRepoUrl = (url: string): string =>
  url.trim().toLowerCase().replace(/\.git$/, '');

/**
 * Argo CD's allow-list semantics, including the `!` deny prefix: a value is
 * permitted when at least one plain pattern matches it and no negated pattern
 * does.
 */
export const patternsPermit = (patterns: readonly unknown[], value: string): boolean => {
  let allowed = false;

  for (const entry of patterns) {
    const pattern = asString(entry);
    if (pattern === undefined) continue;

    if (pattern.startsWith('!')) {
      if (globMatches(pattern.slice(1), value)) return false;
    } else if (globMatches(pattern, value)) {
      allowed = true;
    }
  }

  return allowed;
};

/** `spec.sourceRepos` of a project, matched against an Application's repoURL. */
export const isSourcePermitted = (project: unknown, repoUrl: string): boolean =>
  patternsPermit(
    asArray(specOf(project).sourceRepos).map((entry) => {
      const pattern = asString(entry);
      if (pattern === undefined) return entry;
      return pattern.startsWith('!')
        ? `!${normalizeRepoUrl(pattern.slice(1))}`
        : normalizeRepoUrl(pattern);
    }),
    normalizeRepoUrl(repoUrl),
  );

/**
 * `spec.destinations` of a project, matched against an Application's
 * destination. A destination entry matches when both halves do — the cluster
 * (by `server` or by `name`) and the namespace.
 */
export const isDestinationPermitted = (
  project: unknown,
  destination: { readonly server?: string; readonly name?: string; readonly namespace?: string },
): boolean => {
  const namespace = destination.namespace ?? '';

  return asArray(specOf(project).destinations).some((entry) => {
    const permitted = asRecord(entry);
    if (permitted === undefined) return false;

    const clusterMatches =
      destination.server !== undefined
        ? patternsPermit([permitted.server], destination.server)
        : destination.name !== undefined && patternsPermit([permitted.name], destination.name);

    return clusterMatches && patternsPermit([permitted.namespace], namespace);
  });
};

/** Sync-wave annotation, as written and as Argo CD reads it. */
export interface SyncWave {
  /** The raw annotation value, `undefined` when the annotation is absent. */
  readonly raw: unknown;
  /** The integer Argo CD would use, `undefined` when it cannot parse one. */
  readonly value?: number;
}

export const syncWave = (document: unknown): SyncWave => {
  const raw = asRecord(metadataOf(document).annotations)?.[SYNC_WAVE_ANNOTATION];
  const text = asString(raw);

  return text !== undefined && /^-?\d+$/.test(text.trim())
    ? { raw, value: Number.parseInt(text.trim(), 10) }
    : { raw };
};

/**
 * Shape rules that apply to every document in the tree.
 *
 * `managed` is false for `root.yaml`, which is applied by hand: sync waves order
 * resources within an Application's own resource set, and nothing owns the two
 * documents in `root.yaml`, so requiring a wave on them would be requiring a
 * number nothing reads.
 */
export const auditManifestShape = (
  manifest: ManifestDocument,
  options: { readonly managed: boolean },
): Violation[] => {
  const violations: Violation[] = [];
  const file = describeManifest(manifest);
  const document = asRecord(manifest.document);

  if (document === undefined) {
    return [
      {
        rule: 'unexpected-manifest',
        file,
        message: 'document is not a mapping, so it is not a Kubernetes manifest at all.',
      },
    ];
  }

  const apiVersion = asString(document.apiVersion);
  const kind = documentKind(document);

  if (apiVersion !== ARGO_API_VERSION || (kind !== 'Application' && kind !== 'AppProject')) {
    violations.push({
      rule: 'unexpected-manifest',
      file,
      message:
        `\`${apiVersion ?? '<none>'}/${kind ?? '<none>'}\` is not an Argo CD Application or ` +
        `AppProject. Only \`${ARGO_API_VERSION}\` Applications and AppProjects belong under ` +
        `${ARGOCD_DIRECTORY}; anything else here is applied to a cluster by a file nobody ` +
        'expects to deploy workloads.',
    });
  }

  const namespace = asString(metadataOf(document).namespace);
  if (namespace !== ARGOCD_NAMESPACE) {
    violations.push({
      rule: 'unexpected-manifest',
      file,
      message:
        `\`metadata.namespace\` is \`${namespace ?? '<unset>'}\`, not \`${ARGOCD_NAMESPACE}\`. ` +
        'Argo CD only reconciles Applications and AppProjects in its own namespace unless ' +
        '`sourceNamespaces` is configured, so one written elsewhere is stored and ignored.',
    });
  }

  for (const [key, value] of Object.entries(asRecord(metadataOf(document).annotations) ?? {})) {
    if (typeof value !== 'string') {
      violations.push({
        rule: 'annotation-not-a-string',
        file,
        message:
          `annotation \`${key}\` is a ${typeof value}, not a string. Annotation values are ` +
          'strings in the API, so the API server rejects the whole document — quote the value.',
      });
    }
  }

  if (options.managed) {
    const directory = path.posix.basename(path.posix.dirname(manifest.file));
    const expected = kind === 'AppProject' ? 'projects' : 'applications';

    if ((kind === 'AppProject' || kind === 'Application') && directory !== expected) {
      violations.push({
        rule: 'manifest-misplaced',
        file,
        message:
          `a ${kind} is under \`${directory}/\` rather than \`${expected}/\`. The root ` +
          "Application's `include` pattern is written per directory, so a file in the wrong " +
          'one is either applied at the wrong point in the sync or not applied at all.',
      });
    }

    const wave = syncWave(document);

    if (wave.raw === undefined) {
      violations.push({
        rule: 'missing-sync-wave',
        file,
        message:
          `no \`${SYNC_WAVE_ANNOTATION}\` annotation. Argo CD defaults a resource to wave 0, ` +
          'which puts an AppProject in the same wave as the Applications that name it and a ' +
          'workload in the same wave as the add-on it depends on; within a wave the order is ' +
          'by kind and then by name, which is not an ordering anyone chose.',
      });
    } else if (wave.value === undefined && typeof wave.raw === 'string') {
      violations.push({
        rule: 'sync-wave-not-an-integer',
        file,
        message:
          `\`${SYNC_WAVE_ANNOTATION}: ${JSON.stringify(wave.raw)}\` is not an integer. Argo CD ` +
          'parses it with `strconv.Atoi` and falls back to wave 0 when that fails, so a typo ' +
          'here does not fail the sync — it silently reorders it.',
      });
    }
  }

  return violations;
};

/** Rules for an `AppProject`. */
export const auditProject = (manifest: ManifestDocument): Violation[] => {
  const violations: Violation[] = [];
  const file = describeManifest(manifest);
  const name = documentName(manifest.document);
  const projectSpec = specOf(manifest.document);

  for (const entry of asArray(projectSpec.sourceRepos)) {
    if (asString(entry)?.includes('*')) {
      violations.push({
        rule: 'open-project-scope',
        file,
        message:
          `project \`${name}\` permits source repository \`${String(entry)}\`. A wildcard here ` +
          'lets any Application in this project deploy manifests from a repository nobody in ' +
          'this one reviews, which is the `default` project with a different name on it.',
      });
    }
  }

  for (const entry of asArray(projectSpec.destinations)) {
    const destination = asRecord(entry) ?? {};

    for (const field of ['server', 'name', 'namespace'] as const) {
      if (asString(destination[field])?.includes('*')) {
        violations.push({
          rule: 'open-project-scope',
          file,
          message:
            `project \`${name}\` permits destination \`${field}: ${String(destination[field])}\`. ` +
            'The destination list is the blast radius of every Application in the project; a ' +
            'wildcard namespace makes a workload release able to write into kube-system, and a ' +
            'wildcard server makes it able to write into another cluster.',
        });
      }
    }
  }

  const clusterResources = asArray(projectSpec.clusterResourceWhitelist);

  if (name === WORKLOAD_PROJECT || name === BOOTSTRAP_PROJECT) {
    for (const entry of clusterResources) {
      const resource = asRecord(entry) ?? {};
      const group = asString(resource.group) ?? '';
      const kind = asString(resource.kind) ?? '';
      const restrictedName = asString(resource.name);
      const namespaceByName = group === '' && kind === 'Namespace' && restrictedName !== undefined;

      if (name === BOOTSTRAP_PROJECT || !namespaceByName) {
        violations.push({
          rule: 'cluster-scope-escalation',
          file,
          message:
            `project \`${name}\` permits the cluster-scoped resource \`${group || '<core>'}/` +
            `${kind || '<any>'}\`. Applications in this project deploy into one namespace; a ` +
            'cluster-scoped permission is by definition a way out of it — a ClusterRoleBinding ' +
            'most directly, but a CustomResourceDefinition or a MutatingWebhookConfiguration ' +
            `just as effectively. The one exception is the release's own \`Namespace\`, ` +
            'restricted by `name`, which `CreateNamespace=true` needs.',
        });
      }
    }
  }

  if (name === PLATFORM_PROJECT) {
    for (const entry of clusterResources) {
      const resource = asRecord(entry) ?? {};
      const group = asString(resource.group) ?? '';
      const kind = asString(resource.kind) ?? '';
      const identifier = `${group}/${kind}`;

      if (!PLATFORM_CLUSTER_KINDS.includes(identifier)) {
        violations.push({
          rule: 'cluster-scope-escalation',
          file,
          message:
            `project \`${name}\` permits the cluster-scoped resource \`${identifier}\`, which is ` +
            'not in PLATFORM_CLUSTER_KINDS in tools/audit-argocd.ts. That list is the ceiling on ' +
            'what an upstream add-on chart can do to this cluster, so widening it belongs in a ' +
            'diff with a reason attached rather than in a chart bump.',
        });
        continue;
      }

      if (
        NAME_RESTRICTED_PLATFORM_KINDS.includes(identifier) &&
        asString(resource.name) === undefined
      ) {
        violations.push({
          rule: 'cluster-scope-escalation',
          file,
          message:
            `project \`${name}\` permits \`${identifier}\` without restricting it by \`name\`. ` +
            'Every Application in this project prunes, so an unrestricted kind here is not only ' +
            'what an add-on may create — it is what a moved file may delete, and for `Namespace` ' +
            'that includes `kube-system`. Name the namespaces the Applications actually create.',
        });
      }
    }
  }

  return violations;
};

/** Everything an Application is checked against; assembled by {@link auditTree}. */
export interface ApplicationContext {
  readonly environment: string;
  /** AppProjects declared in the same tree, by name. */
  readonly projects: ReadonlyMap<string, unknown>;
  /** True for the Application in `root.yaml`, which manages the others. */
  readonly isRoot: boolean;
}

/** Rules for an `Application`. */
export const auditApplication = (
  manifest: ManifestDocument,
  context: ApplicationContext,
): Violation[] => {
  const violations: Violation[] = [];
  const file = describeManifest(manifest);
  const name = documentName(manifest.document);
  const applicationSpec = specOf(manifest.document);

  const finalizers = asArray(metadataOf(manifest.document).finalizers).map(asString);
  if (!finalizers.includes(RESOURCES_FINALIZER)) {
    violations.push({
      rule: 'missing-finalizer',
      file,
      message:
        `\`${name}\` has no \`${RESOURCES_FINALIZER}\` finalizer. Deleting it — by hand, or by ` +
        'the parent Application pruning the file out of git — then deletes the Application and ' +
        'leaves every resource it created running in the cluster, owned and reconciled by ' +
        'nothing.',
    });
  }

  const projectName = asString(applicationSpec.project);
  const project = projectName !== undefined ? context.projects.get(projectName) : undefined;

  if (projectName === undefined || project === undefined) {
    violations.push({
      rule: 'unknown-project',
      file,
      message:
        `\`${name}\` names project \`${projectName ?? '<unset>'}\`, which no AppProject in this ` +
        'tree declares. The API server admits the Application and Argo CD then reports a ' +
        'comparison error against a project that does not exist, which reads like a broken ' +
        'application rather than a missing file.',
    });
  }

  const destination = asRecord(applicationSpec.destination) ?? {};
  const server = asString(destination.server);
  const clusterName = asString(destination.name);
  const namespace = asString(destination.namespace);

  if (server !== undefined && clusterName !== undefined) {
    violations.push({
      rule: 'ambiguous-destination',
      file,
      message:
        `\`${name}\` sets both \`destination.server\` and \`destination.name\`. Argo CD rejects ` +
        'that combination outright rather than preferring one.',
    });
  }

  if (!context.isRoot && namespace === ARGOCD_NAMESPACE) {
    violations.push({
      rule: 'argocd-namespace-target',
      file,
      message:
        `\`${name}\` deploys into the \`${ARGOCD_NAMESPACE}\` namespace. Anything that can write ` +
        "there can rewrite the AppProjects that bound every other Application, and sits beside " +
        "Argo CD's own service account — an app-of-apps child with that reach is an admin, and " +
        'the root Application is the only manifest here that needs it.',
    });
  }

  if (project !== undefined) {
    if (!isDestinationPermitted(project, { server, name: clusterName, namespace })) {
      violations.push({
        rule: 'destination-not-permitted',
        file,
        message:
          `\`${name}\` targets namespace \`${namespace ?? '<unset>'}\` on ` +
          `\`${server ?? clusterName ?? '<unset>'}\`, which project \`${projectName}\` does not ` +
          'permit. This fails at sync time with a message about the project, long after review.',
      });
    }
  }

  const source = asRecord(applicationSpec.source) ?? {};
  const repoUrl = asString(source.repoURL);
  const chart = asString(source.chart);
  const sourcePath = asString(source.path);
  const targetRevision = asString(source.targetRevision);
  const helm = asRecord(source.helm);

  if (project !== undefined && repoUrl !== undefined && !isSourcePermitted(project, repoUrl)) {
    violations.push({
      rule: 'source-not-permitted',
      file,
      message:
        `\`${name}\` reads from \`${repoUrl}\`, which project \`${projectName}\` does not list in ` +
        '`sourceRepos`. Argo CD compares the two as globs after normalising a `.git` suffix and ' +
        'the case, but not a trailing slash — the usual cause is one side written with one and ' +
        'the other without.',
    });
  }

  if (chart !== undefined) {
    if (targetRevision === undefined || !EXACT_CHART_VERSION.test(targetRevision)) {
      violations.push({
        rule: 'mutable-target-revision',
        file,
        message:
          `\`${name}\` pins chart \`${chart}\` at \`${targetRevision ?? '<unset>'}\`, which is ` +
          'not an exact version. Argo CD re-resolves a range on every reconciliation, so a new ' +
          'upstream release reaches the cluster through self-heal with no commit, no pull ' +
          'request and no diff to review.',
      });
    }
  } else if (targetRevision === undefined || targetRevision === '' || targetRevision === 'HEAD') {
    violations.push({
      rule: 'mutable-target-revision',
      file,
      message:
        `\`${name}\` tracks \`${targetRevision ?? '<unset>'}\`. \`HEAD\` resolves to whatever ` +
        "the repository's default branch is at the time, so renaming that branch repoints the " +
        'cluster silently, and the manifest never says which branch this cluster follows.',
    });
  }

  if (helm !== undefined && asString(helm.releaseName) === undefined) {
    violations.push({
      rule: 'release-name-not-pinned',
      file,
      message:
        `\`${name}\` renders a Helm chart without \`helm.releaseName\`. The release name then ` +
        'defaults to the Application name, and every object in the chart is named from it — so ' +
        'renaming the Application deletes and recreates the whole release, including the ' +
        'ServiceAccount an IRSA trust policy names.',
    });
  }

  if (sourcePath === APP_CHART_PATH) {
    const expectedValues = `values-${context.environment}.yaml`;
    const valueFiles = asArray(helm?.valueFiles).map(asString);

    if (valueFiles.length !== 1 || valueFiles[0] !== expectedValues) {
      violations.push({
        rule: 'values-file-mismatch',
        file,
        message:
          `\`${name}\` renders ${JSON.stringify(valueFiles)} rather than exactly ` +
          `[${JSON.stringify(expectedValues)}]. Every environment-specific fact this chart has ` +
          'lives in that file — the image repository, the IRSA role ARN, the replica floor — so ' +
          'the wrong one deploys a working release of the wrong environment.',
      });
    }

    if (namespace !== context.environment) {
      violations.push({
        rule: 'destination-namespace-mismatch',
        file,
        message:
          `\`${name}\` deploys into namespace \`${namespace ?? '<unset>'}\` rather than ` +
          `\`${context.environment}\`. The IRSA trust policy names the subject ` +
          `\`${context.environment}/<service account>\`, and \`AssumeRoleWithWebIdentity\` ` +
          'rejects a token whose namespace does not match — so the release starts and then ' +
          'fails at its first AWS call.',
      });
    }
  }

  const syncPolicy = asRecord(applicationSpec.syncPolicy) ?? {};
  const automated = asRecord(syncPolicy.automated);
  const syncOptions = asArray(syncPolicy.syncOptions).map(asString);

  if (automated === undefined || automated.enabled === false) {
    violations.push({
      rule: 'drift-uncorrected',
      file,
      message:
        `\`${name}\` has no automated sync. Self-heal lives inside \`syncPolicy.automated\`, so ` +
        'without it the cluster reports drift and keeps it: an Application edited with `kubectl` ' +
        'stays edited until somebody presses Sync.',
    });
  } else {
    if (automated.selfHeal !== true) {
      violations.push({
        rule: 'drift-uncorrected',
        file,
        message:
          `\`${name}\` syncs automatically but does not self-heal. Automated sync only fires on a ` +
          'change in git, so a change made on the cluster is detected, displayed, and left in ' +
          'place — which is the drift that matters, because nobody reviewed it.',
      });
    }

    if (automated.prune !== true) {
      violations.push({
        rule: 'prune-disabled',
        file,
        message:
          `\`${name}\` does not prune. Deleting a manifest from git then removes nothing from ` +
          'the cluster, so the tree stops being a description of what is running and every ' +
          'subsequent reader has to guess which of the two is right.',
      });
    }

    if (automated.allowEmpty === true) {
      violations.push({
        rule: 'allow-empty-enabled',
        file,
        message:
          `\`${name}\` sets \`allowEmpty: true\`. That removes the last guard against a render ` +
          'that produces nothing — a bad values file, a moved path — which with pruning on ' +
          'deletes the entire release rather than failing.',
      });
    }
  }

  if (
    namespace !== undefined &&
    !PREEXISTING_NAMESPACES.includes(namespace) &&
    !syncOptions.includes('CreateNamespace=true')
  ) {
    violations.push({
      rule: 'namespace-not-created',
      file,
      message:
        `\`${name}\` deploys into \`${namespace}\`, which Kubernetes does not create on its own, ` +
        'without `CreateNamespace=true`. Nothing else in this repository creates it either, so ' +
        'the first sync on a fresh cluster fails on every object at once.',
    });
  }

  return violations;
};

/**
 * Waves must order the tree the way the tree depends on itself: AppProjects
 * before the Applications that name them, platform add-ons before the workloads
 * that read them.
 *
 * Sharing a wave is a violation rather than a nuance. Within a wave Argo CD
 * orders by kind and then by name, so `app` sorting before `metrics-server` is
 * the ordering, and it holds until somebody renames something.
 */
export const auditSyncWaveOrdering = (tree: ArgoTree): Violation[] => {
  const violations: Violation[] = [];

  const waved = tree.managed
    .map((manifest) => ({ manifest, wave: syncWave(manifest.document).value }))
    .filter((entry): entry is { manifest: ManifestDocument; wave: number } => entry.wave !== undefined);

  const projects = waved.filter(({ manifest }) => documentKind(manifest.document) === 'AppProject');
  const applications = waved.filter(
    ({ manifest }) => documentKind(manifest.document) === 'Application',
  );
  const platform = applications.filter(
    ({ manifest }) => asString(specOf(manifest.document).project) === PLATFORM_PROJECT,
  );
  const workloads = applications.filter(
    ({ manifest }) => asString(specOf(manifest.document).project) === WORKLOAD_PROJECT,
  );

  const requireBefore = (
    earlier: readonly { manifest: ManifestDocument; wave: number }[],
    later: readonly { manifest: ManifestDocument; wave: number }[],
    explanation: string,
  ): void => {
    for (const first of earlier) {
      for (const second of later) {
        if (first.wave < second.wave) continue;

        violations.push({
          rule: 'sync-wave-ordering',
          file: describeManifest(second.manifest),
          message:
            `\`${documentName(second.manifest.document)}\` is in wave ${second.wave} and ` +
            `\`${documentName(first.manifest.document)}\` (${describeManifest(first.manifest)}) ` +
            `is in wave ${first.wave}. ${explanation}`,
        });
      }
    }
  };

  requireBefore(
    projects,
    applications,
    'An AppProject has to exist before an Application names it, and equal waves are not an ' +
      'ordering: within a wave Argo CD sorts by kind and then by name.',
  );

  requireBefore(
    platform,
    workloads,
    'The workload releases read what the platform add-ons provide — the HPA in `k8s/charts/app` ' +
      'reads metrics-server — so the add-on belongs in an earlier wave.',
  );

  return violations;
};

/**
 * The root Application's `include`/`exclude` against what is actually on disk.
 *
 * Two failures, and both are silent. A manifest the patterns do not match is
 * committed, reviewed and applied by nothing — it reads as deployed to everyone
 * looking at the repository. And a pattern that matches `root.yaml` puts the
 * trust root inside the resource set it manages, where a rename in the tree
 * prunes it.
 */
export const auditRootCoverage = (tree: ArgoTree): Violation[] => {
  const violations: Violation[] = [];

  const rootApplication = tree.root.find(
    (manifest) => documentKind(manifest.document) === 'Application',
  );
  if (rootApplication === undefined) return violations;

  const file = describeManifest(rootApplication);
  const directory = asRecord(asRecord(specOf(rootApplication.document).source)?.directory) ?? {};
  const include = asString(directory.include);
  const exclude = asString(directory.exclude);

  const matches = (relativePath: string): boolean => {
    if (exclude !== undefined && globMatches(exclude, relativePath)) return false;
    return include === undefined || globMatches(include, relativePath);
  };

  try {
    for (const relativePath of tree.manifestFiles) {
      const isRootFile = relativePath === 'root.yaml';

      if (isRootFile && matches(relativePath)) {
        violations.push({
          rule: 'root-manages-itself',
          file,
          message:
            'the `include`/`exclude` patterns match `root.yaml`, so the root Application manages ' +
            'the manifest that declares it and the AppProject that bounds it. Recovering from a ' +
            'mistake there stops being one `kubectl apply` and starts being a prune that removed ' +
            'the thing that would have restored it.',
        });
      }

      if (!isRootFile && !matches(relativePath)) {
        violations.push({
          rule: 'unmanaged-manifest',
          file: path.posix.join(tree.directory, relativePath),
          message:
            `no cluster applies this file: the root Application's \`include\` ` +
            `(${JSON.stringify(include ?? '<unset>')}) does not match it. A manifest in a GitOps ` +
            'tree that nothing applies is worse than a missing one, because it reads as deployed.',
        });
      }
    }
  } catch (error) {
    if (!(error instanceof UnsupportedGlobError)) throw error;

    violations.push({
      rule: 'include-pattern-unsupported',
      file,
      message:
        `\`include\`/\`exclude\` uses glob syntax this audit does not model: ${error.message}. ` +
        'Argo CD matches these with gobwas/glob and no separator runes; rather than approximate ' +
        'that and report on a file set the cluster does not use, this fails. Keep the patterns ' +
        'to `*`, `?` and `{a,b}`.',
    });
  }

  return violations;
};

/** Every rule that can be decided from one environment's tree. */
export const auditTree = (tree: ArgoTree): Violation[] => {
  const violations: Violation[] = [];

  for (const { file, message } of tree.unreadable) {
    violations.push({
      rule: 'manifest-unreadable',
      file,
      message:
        `${message}. Argo CD parses every file the include pattern matches, and one that fails ` +
        'takes the whole sync down with it rather than being skipped.',
    });
  }

  const rootApplications = tree.root.filter(
    (manifest) => documentKind(manifest.document) === 'Application',
  );

  if (rootApplications.length !== 1) {
    violations.push({
      rule: 'missing-root-application',
      file: path.posix.join(tree.directory, 'root.yaml'),
      message:
        `expected exactly one Application in \`root.yaml\`, found ${rootApplications.length}. It ` +
        'is the one manifest a human applies, and it is what makes everything beside it reach a ' +
        'cluster.',
    });
  }

  const projects = new Map<string, unknown>();
  for (const manifest of [...tree.root, ...tree.managed]) {
    if (documentKind(manifest.document) === 'AppProject') {
      projects.set(documentName(manifest.document), manifest.document);
    }
  }

  const seenApplications = new Map<string, ManifestDocument>();

  for (const [manifests, managed] of [
    [tree.root, false],
    [tree.managed, true],
  ] as const) {
    for (const manifest of manifests) {
      violations.push(...auditManifestShape(manifest, { managed }));

      const kind = documentKind(manifest.document);

      if (kind === 'AppProject') {
        violations.push(...auditProject(manifest));
      }

      if (kind === 'Application') {
        violations.push(
          ...auditApplication(manifest, {
            environment: tree.environment,
            projects,
            isRoot: !managed,
          }),
        );

        const name = documentName(manifest.document);
        const previous = seenApplications.get(name);

        if (previous !== undefined) {
          violations.push({
            rule: 'duplicate-application-name',
            file: describeManifest(manifest),
            message:
              `a second Application named \`${name}\` (the first is in ` +
              `${describeManifest(previous)}). Both apply to the same object, so the cluster ends ` +
              'up running whichever Argo CD wrote last and the other file has no effect at all.',
          });
        } else {
          seenApplications.set(name, manifest);
        }
      }
    }
  }

  violations.push(...auditSyncWaveOrdering(tree));
  violations.push(...auditRootCoverage(tree));

  return violations;
};

/** Rules that only exist across environments, plus every per-tree rule. */
export const auditArgocd = (loaded: LoadedArgocd): Violation[] => {
  const violations: Violation[] = [];

  for (const environment of loaded.missingEnvironments) {
    violations.push({
      rule: 'missing-environment-tree',
      file: path.posix.join(ARGOCD_DIRECTORY, environment),
      message:
        `no Argo CD tree for the \`${environment}\` environment. It has a values file in ` +
        `${APP_CHART_PATH} and a stack in bin/app.ts, so this is an environment that is ` +
        'deployed by hand or not at all.',
    });
  }

  for (const directory of loaded.orphanDirectories) {
    violations.push({
      rule: 'orphan-environment-tree',
      file: directory,
      message:
        'a tree for an environment that is not in ENVIRONMENTS. Either it is an environment ' +
        'nothing else in this repository knows about, or it is a leftover that a cluster ' +
        'somewhere is still reconciling against.',
    });
  }

  for (const file of loaded.strayFiles) {
    violations.push({
      rule: 'stray-manifest',
      file,
      message:
        `a manifest under ${ARGOCD_DIRECTORY} that is in no environment tree, so no root ` +
        'Application applies it. Manifests that must never be applied belong in ' +
        `${FIXTURES_DIRECTORY}, which is outside every tree for exactly this reason.`,
    });
  }

  const fileSets = loaded.trees.map((tree) => ({
    tree,
    files: new Set(tree.manifestFiles),
  }));

  for (const { tree, files } of fileSets) {
    for (const other of fileSets) {
      if (other.tree.environment === tree.environment) continue;

      for (const file of files) {
        if (other.files.has(file)) continue;

        violations.push({
          rule: 'trees-not-parallel',
          file: path.posix.join(tree.directory, file),
          message:
            `\`${other.tree.environment}\` has no \`${file}\`. The environments run the same ` +
            'control plane so that a GitOps change is exercised in one before it reaches the ' +
            'other; a file in one tree and not the other is a difference nobody chose in the ' +
            'file that describes what production runs.',
        });
      }
    }
  }

  for (const tree of loaded.trees) {
    violations.push(...auditTree(tree));
  }

  return violations;
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations.map(({ rule, file, message }) => `  [${rule}] ${file}\n      ${message}`).join('\n');

/** Parse every document in a YAML file, or report why it could not be read. */
const readManifests = (
  absolutePath: string,
  relativePath: string,
): { documents: ManifestDocument[]; error?: string } => {
  let contents: string;

  try {
    contents = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    return { documents: [], error: `cannot be read (${(error as Error).message})` };
  }

  // `loadAll` rather than splitting on `---`: a `---` line inside a block scalar
  // is content, not a document separator, and every `helm.values` block in this
  // tree is a block scalar.
  let parsed: unknown[];

  try {
    parsed = loadAll(contents);
  } catch (error) {
    return { documents: [], error: `is not valid YAML (${(error as Error).message})` };
  }

  const documents = parsed.filter((document) => document !== undefined && document !== null);

  return {
    documents: documents.map((document, index) => ({
      file: relativePath,
      index,
      documentsInFile: documents.length,
      document,
    })),
  };
};

/** Manifest-shaped files under `directory`, as posix paths relative to it. */
const manifestFilesUnder = (directory: string, prefix = ''): string[] => {
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relative = path.posix.join(prefix, entry.name);

      if (entry.isDirectory()) {
        return manifestFilesUnder(path.join(directory, entry.name), relative);
      }

      return MANIFEST_FILE.test(entry.name) ? [relative] : [];
    });
};

/** Read `<root>/k8s/argocd`. */
export const readArgocd = (root: string): LoadedArgocd => {
  const argocdDirectory = path.join(root, ARGOCD_DIRECTORY);

  if (!fs.existsSync(argocdDirectory)) {
    return {
      trees: [],
      missingEnvironments: [...ENVIRONMENTS],
      orphanDirectories: [],
      strayFiles: [],
    };
  }

  const entries = fs
    .readdirSync(argocdDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  const trees: ArgoTree[] = [];
  const orphanDirectories: string[] = [];
  const strayFiles: string[] = [];

  for (const entry of entries) {
    const relative = path.posix.join(ARGOCD_DIRECTORY, entry.name);

    if (!entry.isDirectory()) {
      if (MANIFEST_FILE.test(entry.name)) strayFiles.push(relative);
      continue;
    }

    if (relative === FIXTURES_DIRECTORY) continue;

    if (!ENVIRONMENTS.includes(entry.name)) {
      orphanDirectories.push(relative);
      continue;
    }

    const treeDirectory = path.join(argocdDirectory, entry.name);
    const manifestFiles = manifestFilesUnder(treeDirectory);

    const root_: ManifestDocument[] = [];
    const managed: ManifestDocument[] = [];
    const unreadable: { file: string; message: string }[] = [];

    for (const relativeFile of manifestFiles) {
      const { documents, error } = readManifests(
        path.join(treeDirectory, relativeFile),
        path.posix.join(relative, relativeFile),
      );

      if (error !== undefined) {
        unreadable.push({ file: path.posix.join(relative, relativeFile), message: error });
        continue;
      }

      (relativeFile === 'root.yaml' ? root_ : managed).push(...documents);
    }

    trees.push({
      environment: entry.name,
      directory: relative,
      root: root_,
      managed,
      manifestFiles,
      unreadable,
    });
  }

  return {
    trees,
    missingEnvironments: ENVIRONMENTS.filter(
      (environment) => !trees.some((tree) => tree.environment === environment),
    ),
    orphanDirectories,
    strayFiles,
  };
};

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const loaded = readArgocd(root);
  const violations = auditArgocd(loaded);

  if (violations.length > 0) {
    console.error(`\n${violations.length} Argo CD manifest violation(s):\n`);
    console.error(formatViolations(violations));
    console.error('\nSee docs/gitops-argocd.md.\n');
    process.exit(1);
  }

  const applications = loaded.trees.reduce(
    (total, tree) =>
      total +
      [...tree.root, ...tree.managed].filter(
        (manifest) => documentKind(manifest.document) === 'Application',
      ).length,
    0,
  );

  console.log(
    `${loaded.trees.length} Argo CD tree(s) and ${applications} Application(s) in ${root} ` +
      'agree with their projects.',
  );
}
