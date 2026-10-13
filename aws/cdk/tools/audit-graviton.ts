#!/usr/bin/env node
/**
 * Audit this repository's processor architectures against the synthesised
 * CloudFormation, the images its workloads pull, and the pipeline that builds
 * them.
 *
 * `lib/graviton-migration.ts` holds everything that is arithmetic over the
 * catalogue and a unit test can decide. This gate is for the four questions it
 * cannot answer about itself, each of which has the same shape: the thing that
 * is wrong deploys cleanly, and what fails is later, elsewhere, or never.
 *
 *   • **Is the catalogue still describing what deploys?** `architecture` in the
 *     catalogue is a claim about a template. Nothing in TypeScript connects the
 *     two: a `runtimePlatform` block deleted in a tidy-up leaves the catalogue
 *     saying `arm64` about a task definition that now says nothing, and ECS
 *     reads "nothing" as X86_64. So the architectures here are read out of
 *     `cdk.out` and compared, resource by resource.
 *
 *   • **Can the inventory still see everything?** A compute resource no
 *     catalogue entry matches is the failure that makes every other rule
 *     vacuous, and it is the normal state of an inventory: somebody adds a
 *     stack. Twenty-six of the fifty-eight Lambda functions in this repository
 *     are created by the CDK framework and named nowhere in `lib/` or `bin/`,
 *     which is exactly how a fleet ends up half-migrated with no diff to show
 *     for it — so unmatched resources fail, and so does a workload whose
 *     matched count has drifted from what it declares.
 *
 *   • **Can the image be pulled by an arm64 task?** This is the one that bites.
 *     `cpuArchitecture: ARM64` over an image reference whose digest resolves to
 *     a `linux/amd64` manifest synthesises, passes every other gate here,
 *     deploys, and fails at *task placement* with `CannotPullContainerError`.
 *     Every container image of every ARM64 task definition is therefore checked
 *     against the platform measurements in `IMAGE_PLATFORMS`.
 *
 *   • **Does the pipeline build the platform the catalogue is waiting for?**
 *     `workflow-templates/docker-build-push.yml` runs `docker build` with no
 *     `--platform`, so it produces one amd64 manifest, and that single line is
 *     what blocks the largest Graviton saving in the repository. The rule works
 *     in both directions: while the pipeline is single-platform, every
 *     consumer-image workload must carry the blocker that says so, and the day
 *     the pipeline starts building `linux/arm64`, that blocker becomes a lie and
 *     this gate says so rather than leaving four task definitions on x86 for a
 *     reason that stopped being true.
 *
 * The rules, and the failure each one prevents:
 *
 *   catalogue                     any finding from `validateGravitonCatalogue`
 *   workload-unclassified         a compute resource no catalogue entry matches
 *   workload-ambiguous            a resource two entries both claim, so its
 *                                 verdict depends on iteration order
 *   workload-count-drift          a matched count that is not what the entry
 *                                 declares — an environment added or a stack gone
 *   architecture-undeclared       one of ours that leaves the architecture to a
 *                                 service default, where "unexamined" and
 *                                 "chosen" produce the same template
 *   architecture-mismatch         a deployed architecture that is not the
 *                                 catalogue's
 *   nodegroup-architecture-split  an AMI type and an instance type that disagree,
 *                                 which deploys and never joins a node
 *   image-platform-unrecorded     a pin in `base-images.ts` nobody has measured
 *   image-platform-missing-arm    an arm64 task pulling an image that has no
 *                                 arm64 manifest, or none that was measured
 *   layer-architecture-drift      a `layer-binaries-x86` blocker whose layer no
 *                                 longer contains x86 binaries, or cannot be read
 *   pipeline-blocker-missing      a consumer-image workload not blocked on a
 *                                 single-platform pipeline while it is one
 *   pipeline-blocker-stale        the blocker still recorded after the pipeline
 *                                 learned to build arm64
 *   doc-table-drift               a published table that is not what the data
 *                                 renders
 *   blocker-section-missing       a blocker with nowhere in the guide to read
 *                                 about it
 *   price-stale                   an offer file older than the limit (only with
 *                                 `--now`, like `audit:flags` and `audit:vulns`)
 *   audit-not-run-in-ci           this gate is not wired into a job
 *
 * See docs/graviton.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { PINNED_IMAGES } from '../lib/base-images';
import {
  ARCHITECTURE_PRICES,
  type Architecture,
  type Blocker,
  BENCHMARK_CLAIMS,
  COMPUTE_WORKLOADS,
  type ComputeKind,
  IMAGE_PLATFORMS,
  type PriceObservation,
  type Workload,
  imagePlatformRecord,
  instanceClassArchitecture,
  renderPriceTable,
  renderWorkloadTable,
  supportsArm64,
  validateGravitonCatalogue,
  verdictTotals,
} from '../lib/graviton-migration';

export const GRAVITON_DOC_PATH = path.join('docs', 'graviton.md');
export const CI_WORKFLOW_PATH = path.join('.github', 'workflows', 'ci.yml');
export const BUILD_WORKFLOW_PATH = path.join('workflow-templates', 'docker-build-push.yml');
/** The npm script the CI job must run. */
export const AUDIT_SCRIPT = 'audit:graviton';
/**
 * How old an offer file may be before `--now` calls the prices stale.
 *
 * Ninety days because AWS republishes these files on its own schedule — the five
 * offers read for this catalogue were published across five different weeks —
 * so a tighter limit would fail on AWS's publishing cadence rather than on
 * anything in this repository.
 */
export const PRICE_MAX_AGE_DAYS = 90;

export const GRAVITON_AUDIT_RULES = [
  'catalogue',
  'workload-unclassified',
  'workload-ambiguous',
  'workload-count-drift',
  'architecture-undeclared',
  'architecture-mismatch',
  'nodegroup-architecture-split',
  'image-platform-unrecorded',
  'image-platform-missing-arm',
  'layer-architecture-drift',
  'pipeline-blocker-missing',
  'pipeline-blocker-stale',
  'doc-table-drift',
  'blocker-section-missing',
  'price-stale',
  'audit-not-run-in-ci',
] as const;

export type GravitonAuditRule = (typeof GRAVITON_AUDIT_RULES)[number];

export interface Violation {
  readonly rule: GravitonAuditRule;
  readonly file: string;
  readonly location: string;
  readonly message: string;
}

export interface TemplateFile {
  readonly path: string;
  readonly document: unknown;
}

/**
 * The heading in `docs/graviton.md` that explains each blocker.
 *
 * A reader meeting `layer-binaries-x86` in the workload table has to be able to
 * find out what it means; a blocker whose section was renamed leaves them at the
 * top of a 400-line page. Keyed by the blocker so a new blocker cannot be added
 * without writing the section.
 */
export const BLOCKER_SECTIONS: Record<Blocker, string> = {
  'consumer-image-single-platform': '4. The one line that blocks the big savings',
  'layer-binaries-x86': '7. The half of the Lambda fleet nobody names',
  'no-arm64-runtime': '8. Where there is no arm64 to move to',
  'framework-chooses': '7. The half of the Lambda fleet nobody names',
};

/** Lambda layers whose contents decide an architecture nobody here declares. */
export interface LayerPackage {
  /** npm package that ships the layer. */
  readonly packageName: string;
  /** Path to the zip inside that package. */
  readonly zipPath: string;
  /**
   * Entries to read the ELF header of. A suffix match, because the awscli layer
   * carries its native extension under a CPython-version-specific name.
   */
  readonly binarySuffixes: readonly string[];
}

export const LAYER_PACKAGES: readonly LayerPackage[] = [
  {
    packageName: '@aws-cdk/lambda-layer-kubectl-v33',
    zipPath: 'lib/layer.zip',
    binarySuffixes: ['kubectl/kubectl', 'helm/helm'],
  },
  {
    packageName: '@aws-cdk/asset-awscli-v1',
    zipPath: 'lib/layer.zip',
    binarySuffixes: ['.so'],
  },
];

export interface AuditInput {
  readonly templates: readonly TemplateFile[];
  /** Contents of {@link GRAVITON_DOC_PATH}. */
  readonly gravitonDoc: string;
  /** Contents of {@link BUILD_WORKFLOW_PATH}. */
  readonly buildWorkflow: string;
  /** Contents of {@link CI_WORKFLOW_PATH}. Omitted in unit tests that do not need it. */
  readonly ciWorkflow?: string;
  /** Measured ELF machine names per layer package. Omitted skips the layer rule. */
  readonly layerMachines?: ReadonlyMap<string, readonly string[]>;
  /** `--now`: evaluate price staleness as of this instant. */
  readonly now?: Date;
  readonly workloads?: readonly Workload[];
  readonly prices?: readonly PriceObservation[];
}

export interface AuditResult {
  readonly violations: readonly Violation[];
  readonly resourcesRead: number;
  readonly architectures: Readonly<Record<string, number>>;
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

const KIND_BY_RESOURCE_TYPE: Record<string, ComputeKind> = {
  'AWS::Lambda::Function': 'lambda',
  'AWS::ECS::TaskDefinition': 'fargate-task-definition',
  'AWS::EKS::Nodegroup': 'eks-nodegroup',
  'AWS::RDS::DBInstance': 'rds-instance',
  'AWS::ElastiCache::ReplicationGroup': 'elasticache-node',
  'AWS::ElastiCache::CacheCluster': 'elasticache-node',
  'AWS::Synthetics::Canary': 'synthetics-canary',
};

/** One compute resource as synth wrote it, reduced to what this gate reasons about. */
export interface ComputeResource {
  readonly file: string;
  readonly logicalId: string;
  readonly kind: ComputeKind;
  /** `aws:cdk:path`, which is `<stack>/<construct path>`. */
  readonly constructPath: string;
  /** The stack the path starts with. */
  readonly stack: string;
  /**
   * The architecture the template declares, or `undefined` where it declares
   * none — which is not the same thing as x86, and is the distinction
   * `architecture-undeclared` exists for.
   */
  readonly declared?: Architecture;
  /** For a node group: what the instance types imply, which can disagree with the AMI. */
  readonly instanceArchitecture?: Architecture;
  /** Container images, for a task definition. */
  readonly images: readonly string[];
  /** What the architecture was read from, for the violation message. */
  readonly source: string;
}

const architectureOfLambda = (properties: Record<string, any>): Architecture | undefined => {
  const architectures = properties.Architectures;
  if (!Array.isArray(architectures) || architectures.length === 0) return undefined;
  return architectures[0] === 'arm64' ? 'arm64' : 'x86_64';
};

const architectureOfTaskDefinition = (properties: Record<string, any>): Architecture | undefined => {
  const declared = properties.RuntimePlatform?.CpuArchitecture;
  if (typeof declared !== 'string') return undefined;
  return declared.toUpperCase() === 'ARM64' ? 'arm64' : 'x86_64';
};

const imagesOfTaskDefinition = (properties: Record<string, any>): string[] => {
  const containers = properties.ContainerDefinitions;
  if (!Array.isArray(containers)) return [];
  return containers
    .map((container) => container?.Image)
    .filter((image): image is string => typeof image === 'string');
};

export const readComputeResources = (
  templates: readonly TemplateFile[],
): readonly ComputeResource[] => {
  const resources: ComputeResource[] = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(resourcesOf(template.document))) {
      const kind = KIND_BY_RESOURCE_TYPE[resource.Type ?? ''];
      if (!kind) continue;
      const properties = resource.Properties ?? {};
      const constructPath =
        typeof resource.Metadata?.['aws:cdk:path'] === 'string'
          ? (resource.Metadata['aws:cdk:path'] as string)
          : `${template.path.replace(/\.template\.json$/, '')}/${logicalId}`;

      let declared: Architecture | undefined;
      let instanceArchitecture: Architecture | undefined;
      let source = '';
      switch (kind) {
        case 'lambda':
          declared = architectureOfLambda(properties);
          source = 'Architectures';
          break;
        case 'fargate-task-definition':
          declared = architectureOfTaskDefinition(properties);
          source = 'RuntimePlatform.CpuArchitecture';
          break;
        case 'eks-nodegroup': {
          const amiType = typeof properties.AmiType === 'string' ? properties.AmiType : '';
          declared = /arm_64/i.test(amiType) ? 'arm64' : amiType === '' ? undefined : 'x86_64';
          const instanceTypes = Array.isArray(properties.InstanceTypes)
            ? properties.InstanceTypes.filter((type: unknown): type is string => typeof type === 'string')
            : [];
          const implied = new Set(instanceTypes.map(instanceClassArchitecture));
          instanceArchitecture = implied.size === 1 ? [...implied][0] : undefined;
          source = `AmiType ${amiType || '(unset)'} / InstanceTypes ${instanceTypes.join(', ') || '(unset)'}`;
          break;
        }
        case 'rds-instance': {
          const instanceClass = properties.DBInstanceClass;
          declared =
            typeof instanceClass === 'string' ? instanceClassArchitecture(instanceClass) : undefined;
          source = `DBInstanceClass ${typeof instanceClass === 'string' ? instanceClass : '(unset)'}`;
          break;
        }
        case 'elasticache-node': {
          const nodeType = properties.CacheNodeType;
          declared = typeof nodeType === 'string' ? instanceClassArchitecture(nodeType) : undefined;
          source = `CacheNodeType ${typeof nodeType === 'string' ? nodeType : '(unset)'}`;
          break;
        }
        case 'synthetics-canary':
          // Synthetics exposes no architecture at all. Recording x86_64 rather
          // than `undefined` keeps it out of `architecture-undeclared`, which is
          // about a choice somebody could have made and did not.
          declared = 'x86_64';
          source = `RuntimeVersion ${
            typeof properties.RuntimeVersion === 'string' ? properties.RuntimeVersion : '(unset)'
          }`;
          break;
      }

      resources.push({
        file: template.path,
        logicalId,
        kind,
        constructPath,
        stack: constructPath.split('/')[0] ?? '',
        declared,
        instanceArchitecture,
        images: kind === 'fargate-task-definition' ? imagesOfTaskDefinition(properties) : [],
        source,
      });
    }
  }
  return resources;
};

/** Whether a workload entry claims this resource. */
export const workloadMatches = (workload: Workload, resource: ComputeResource): boolean => {
  if (workload.kind !== resource.kind) return false;
  if (!resource.constructPath.endsWith(workload.constructPathSuffix)) return false;
  if (workload.stackPrefixes === undefined) return true;
  return workload.stackPrefixes.some((prefix) => resource.stack.startsWith(prefix));
};

/* ── The build pipeline ───────────────────────────────────────────────────── */

/**
 * The platforms `docker-build-push.yml` builds for.
 *
 * Three ways a workflow can say it, and the absence of all three is the
 * repository's current answer: a bare `docker build` targets the runner's own
 * architecture, which on `ubuntu-latest` is amd64. `docker/build-push-action`'s
 * `platforms:` input and `buildx --platform` are the two ways to say otherwise.
 */
export const platformsBuiltBy = (workflow: string): readonly string[] => {
  const platforms = new Set<string>();
  for (const match of workflow.matchAll(/--platform[= ]+["']?([a-z0-9/,\-_ ]+)/gi)) {
    for (const value of match[1].split(',')) {
      const trimmed = value.trim();
      if (/^[a-z0-9]+\/[a-z0-9]/.test(trimmed)) platforms.add(trimmed);
    }
  }
  for (const match of workflow.matchAll(/^\s*platforms:\s*(.+)$/gim)) {
    for (const value of match[1].split(',')) {
      const trimmed = value.trim().replace(/^["']|["']$/g, '');
      if (/^[a-z0-9]+\/[a-z0-9]/.test(trimmed)) platforms.add(trimmed);
    }
  }
  return [...platforms].sort();
};

/* ── Lambda layers ────────────────────────────────────────────────────────── */

const ELF_MACHINES: Record<number, string> = {
  0x03: 'x86',
  0x3e: 'x86-64',
  0xb7: 'aarch64',
  0x28: 'arm',
};

/**
 * The architecture an ELF header names, from the first twenty bytes of a file.
 *
 * `e_machine` is a little-endian half-word at offset 18 in both the 32-bit and
 * the 64-bit header, so the class byte does not have to be read to find it.
 */
export const elfMachine = (head: Buffer): string | undefined => {
  if (head.length < 20) return undefined;
  if (head.readUInt32BE(0) !== 0x7f454c46) return undefined;
  return ELF_MACHINES[head.readUInt16LE(18)] ?? `unknown(0x${head.readUInt16LE(18).toString(16)})`;
};

/**
 * The first bytes of the first zip entry whose name ends with one of `suffixes`.
 *
 * A hand-rolled reader because there is nothing to read zips with here: `unzip`
 * is not installed on the runner by contract, the `yauzl` in the store is
 * somebody else's transitive dependency, and adding one for twenty bytes is not
 * a trade worth making. Only the central directory is parsed, and only enough of
 * the entry is inflated to carry an ELF header — `Z_SYNC_FLUSH` is what lets a
 * truncated deflate stream decompress without an error, which matters because
 * `kubectl` is a 50 MB statically linked binary and this gate needs its first
 * twenty bytes.
 */
export const readZipEntryHead = (
  zip: Buffer,
  suffixes: readonly string[],
  bytes = 64,
): { readonly name: string; readonly head: Buffer } | undefined => {
  // End of central directory: scan back for the signature, which sits at most
  // 22 + 65535 bytes from the end.
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= 0 && offset > zip.length - 22 - 65535; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return undefined;

  const entries = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);

  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50) return undefined;
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if (!suffixes.some((suffix) => name.endsWith(suffix))) continue;

    // The local header repeats the name and extra fields, and its extra field
    // length is not required to match the central directory's.
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const slice = zip.subarray(dataStart, dataStart + Math.min(compressedSize, 65536));

    if (method === 0) return { name, head: slice.subarray(0, bytes) };
    if (method === 8) {
      const inflated = zlib.inflateRawSync(slice, {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
      });
      return { name, head: inflated.subarray(0, bytes) };
    }
    return undefined;
  }
  return undefined;
};

/**
 * ELF machine names for every binary this gate can find in each layer package.
 *
 * Returns an empty array for a package whose zip or binaries cannot be read,
 * which `layer-architecture-drift` reports rather than skipping: a measurement
 * that stopped happening passes identically to one that came back as expected.
 */
export const measureLayerArchitectures = (
  cdkRoot: string,
  packages: readonly LayerPackage[] = LAYER_PACKAGES,
): ReadonlyMap<string, readonly string[]> => {
  const machines = new Map<string, readonly string[]>();
  for (const layer of packages) {
    const zipPath = path.join(cdkRoot, 'node_modules', layer.packageName, layer.zipPath);
    if (!fs.existsSync(zipPath)) {
      machines.set(layer.packageName, []);
      continue;
    }
    try {
      const zip = fs.readFileSync(zipPath);
      const found: string[] = [];
      for (const suffix of layer.binarySuffixes) {
        const entry = readZipEntryHead(zip, [suffix]);
        const machine = entry ? elfMachine(entry.head) : undefined;
        if (machine) found.push(machine);
      }
      machines.set(layer.packageName, found);
    } catch {
      machines.set(layer.packageName, []);
    }
  }
  return machines;
};

/* ── The audit ────────────────────────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;

export const auditGraviton = (input: AuditInput): AuditResult => {
  const violations: Violation[] = [];
  const workloads = input.workloads ?? COMPUTE_WORKLOADS;
  const prices = input.prices ?? ARCHITECTURE_PRICES;
  const add = (rule: GravitonAuditRule, file: string, location: string, message: string) =>
    violations.push({ rule, file, location, message });

  for (const finding of validateGravitonCatalogue(workloads, prices, BENCHMARK_CLAIMS)) {
    add('catalogue', 'lib/graviton-migration.ts', `${finding.rule} ${finding.subject}`, finding.message);
  }

  const resources = readComputeResources(input.templates);
  const matches = new Map<string, ComputeResource[]>(workloads.map((w) => [w.id, []]));
  const architectures: Record<string, number> = {};

  for (const resource of resources) {
    const key = `${resource.kind}:${resource.declared ?? 'undeclared'}`;
    architectures[key] = (architectures[key] ?? 0) + 1;

    const claimed = workloads.filter((workload) => workloadMatches(workload, resource));
    if (claimed.length === 0) {
      add(
        'workload-unclassified',
        resource.file,
        resource.constructPath,
        `An unclassified ${resource.kind} resource: no entry in COMPUTE_WORKLOADS matches it. Every ` +
          'rule below is about resources the catalogue knows, so an unclassified one is not a gap in ' +
          'the report \u2014 it is a gap in the question. Classify it, including when the answer is ' +
          '"the framework made it and we cannot choose".',
      );
      continue;
    }
    if (claimed.length > 1) {
      add(
        'workload-ambiguous',
        resource.file,
        resource.constructPath,
        `Matched by ${claimed.length} entries (${claimed
          .map((workload) => workload.id)
          .join(', ')}), so which verdict applies depends on the order of the catalogue. Narrow ` +
          'one of them with stackPrefixes.',
      );
      continue;
    }

    const workload = claimed[0];
    matches.get(workload.id)!.push(resource);

    const declarable = workload.kind === 'lambda' || workload.kind === 'fargate-task-definition';
    if (resource.declared === undefined) {
      if (declarable && workload.owner === 'repository') {
        add(
          'architecture-undeclared',
          resource.file,
          resource.constructPath,
          `${resource.source} is absent, so the service default decides. That default is x86 and ` +
            'it is the same template an unexamined workload produces, which is why this is a ' +
            'violation rather than a note: nothing in review distinguishes a deliberate x86 from ' +
            'a question nobody asked.',
        );
      }
    } else if (resource.declared !== workload.architecture) {
      add(
        'architecture-mismatch',
        resource.file,
        resource.constructPath,
        `Deploys as ${resource.declared} (${resource.source}); the catalogue says ` +
          `${workload.architecture} for ${workload.id}. One of the two is wrong, and the template ` +
          'is the one that runs.',
      );
    }

    if (
      workload.kind === 'eks-nodegroup' &&
      resource.declared !== undefined &&
      resource.instanceArchitecture !== undefined &&
      resource.declared !== resource.instanceArchitecture
    ) {
      add(
        'nodegroup-architecture-split',
        resource.file,
        resource.constructPath,
        `The AMI type says ${resource.declared} and the instance types say ` +
          `${resource.instanceArchitecture} (${resource.source}). CloudFormation accepts this; the ` +
          'nodes boot an AMI their processor cannot execute and never join the cluster, so the ' +
          'stack sits in CREATE_IN_PROGRESS until the node group times out.',
      );
    }

    if (
      workload.kind === 'fargate-task-definition' &&
      resource.declared === 'arm64' &&
      workload.owner === 'repository'
    ) {
      for (const image of resource.images) {
        const record = imagePlatformRecord(image);
        if (!record) {
          add(
            'image-platform-missing-arm',
            resource.file,
            resource.constructPath,
            `Runs ARM64 and pulls ${image}, which has no measurement in IMAGE_PLATFORMS. An ` +
              'unmeasured image is the one failure mode a template cannot show: a digest that ' +
              'resolves to a linux/amd64 manifest deploys and then fails at task placement with ' +
              'CannotPullContainerError.',
          );
        } else if (!supportsArm64(record)) {
          add(
            'image-platform-missing-arm',
            resource.file,
            resource.constructPath,
            `Runs ARM64 and pulls ${image}, whose index carries ${record.platforms.join(', ')} ` +
              `as measured on ${record.measuredOn}. There is no linux/arm64 manifest to pull.`,
          );
        }
      }
    }
  }

  for (const workload of workloads) {
    const matched = matches.get(workload.id) ?? [];
    if (matched.length !== workload.expectedResources) {
      add(
        'workload-count-drift',
        'lib/graviton-migration.ts',
        workload.id,
        `Declares expectedResources: ${workload.expectedResources} and matched ${matched.length} ` +
          `resource(s) (${matched.map((resource) => resource.stack).join(', ') || 'none'}). Either ` +
          'an environment was added, in which case classify the new copy, or a stack stopped ' +
          'synthesising and took its resources out of this gate’s reach.',
      );
    }
  }

  // ── Pinned images ────────────────────────────────────────────────────────
  for (const pin of PINNED_IMAGES) {
    if (!imagePlatformRecord(pin.reference)) {
      add(
        'image-platform-unrecorded',
        'lib/graviton-migration.ts',
        pin.reference,
        `${pin.version} is pinned in lib/base-images.ts with no entry in IMAGE_PLATFORMS. The ` +
          'table has to be a floor rather than a sample: an image nobody classified is an image ' +
          'whose arm64 support is unknown, and the question only comes up once a task definition ' +
          'has already been moved.',
      );
    }
  }

  // ── The build pipeline, in both directions ───────────────────────────────
  const platforms = platformsBuiltBy(input.buildWorkflow);
  const buildsArm = platforms.includes('linux/arm64');
  const consumerWorkloads = workloads.filter((workload) => workload.image === 'consumer-supplied');
  for (const workload of consumerWorkloads) {
    const blocked = workload.blocker === 'consumer-image-single-platform';
    if (!buildsArm && !blocked) {
      add(
        'pipeline-blocker-missing',
        BUILD_WORKFLOW_PATH,
        workload.id,
        `Runs an image ${BUILD_WORKFLOW_PATH} builds, and that workflow builds ` +
          `${platforms.length === 0 ? 'one platform (a bare docker build, so the runner’s own amd64)' : platforms.join(', ')}` +
          `, but the workload is recorded as ${workload.verdict}${
            workload.blocker ? ` / ${workload.blocker}` : ''
          } rather than blocked on the pipeline.`,
      );
    }
    if (buildsArm && blocked) {
      add(
        'pipeline-blocker-stale',
        BUILD_WORKFLOW_PATH,
        workload.id,
        `${BUILD_WORKFLOW_PATH} now builds ${platforms.join(', ')}, so ` +
          '"consumer-image-single-platform" is no longer true. This is the whole reason the rule ' +
          'runs in both directions: the blocker outliving the constraint is how four task ' +
          'definitions stay on x86 for a reason nobody re-reads.',
      );
    }
  }

  // ── Layer binaries ──────────────────────────────────────────────────────
  if (input.layerMachines) {
    const layerBlocked = workloads.some((workload) => workload.blocker === 'layer-binaries-x86');
    for (const layer of LAYER_PACKAGES) {
      const machines = input.layerMachines.get(layer.packageName) ?? [];
      if (machines.length === 0) {
        add(
          'layer-architecture-drift',
          `aws/cdk/node_modules/${layer.packageName}/${layer.zipPath}`,
          layer.packageName,
          'No ELF header could be read from this layer, so the blocker that rests on its contents ' +
            'is unverified. A measurement that stops happening reports success exactly like one ' +
            'that came back as expected.',
        );
        continue;
      }
      const nonX86 = machines.filter((machine) => machine !== 'x86-64');
      if (layerBlocked && nonX86.length > 0) {
        add(
          'layer-architecture-drift',
          `aws/cdk/node_modules/${layer.packageName}/${layer.zipPath}`,
          layer.packageName,
          `Binaries report ${machines.join(', ')}. The catalogue blocks the functions carrying ` +
            'this layer on "layer-binaries-x86", which has stopped being true — reclassify them ' +
            'rather than leaving a blocker in place because it used to hold.',
        );
      }
    }
  }

  // ── The guide ───────────────────────────────────────────────────────────
  // Rendered from the shipped catalogue rather than from `input.workloads`: the
  // published document is a statement about this repository, so a caller passing
  // a subset — every unit test below — is not making a claim about the document.
  const priceTable = renderPriceTable(ARCHITECTURE_PRICES);
  if (!input.gravitonDoc.includes(priceTable)) {
    add(
      'doc-table-drift',
      GRAVITON_DOC_PATH,
      'price table',
      'The published cost table is not what ARCHITECTURE_PRICES renders. It is generated rather ' +
        'than checked, so this means the document was edited by hand or the data moved under it — ' +
        'and the first column to go stale is the percentage everybody quotes.',
    );
  }
  const workloadTable = renderWorkloadTable(COMPUTE_WORKLOADS);
  if (!input.gravitonDoc.includes(workloadTable)) {
    add(
      'doc-table-drift',
      GRAVITON_DOC_PATH,
      'workload table',
      'The published workload table is not what COMPUTE_WORKLOADS renders.',
    );
  }

  const blockersInUse = new Set(
    COMPUTE_WORKLOADS.map((workload) => workload.blocker).filter(
      (blocker): blocker is Blocker => !!blocker,
    ),
  );
  for (const blocker of blockersInUse) {
    const heading = BLOCKER_SECTIONS[blocker];
    if (!heading || !input.gravitonDoc.includes(`## ${heading}`)) {
      add(
        'blocker-section-missing',
        GRAVITON_DOC_PATH,
        blocker,
        `No "## ${heading ?? '(no section declared)'}" in the guide. Every blocker in the workload ` +
          'table is a word a reader has to be able to look up; a renamed heading leaves them at ' +
          'the top of the page.',
      );
    }
  }

  // ── Price age, only when asked ──────────────────────────────────────────
  if (input.now) {
    for (const price of prices) {
      const published = Date.parse(price.offerPublicationDate);
      if (Number.isNaN(published)) continue;
      const ageDays = (input.now.getTime() - published) / DAY_MS;
      if (ageDays > PRICE_MAX_AGE_DAYS) {
        add(
          'price-stale',
          'lib/graviton-migration.ts',
          price.id,
          `Read from an offer file published ${Math.floor(ageDays)} days ago, over the ` +
            `${PRICE_MAX_AGE_DAYS}-day limit. Re-read it from the price list — docs/graviton.md §5.`,
        );
      }
    }
  }

  if (input.ciWorkflow !== undefined && !input.ciWorkflow.includes(`npm run ${AUDIT_SCRIPT}`)) {
    add(
      'audit-not-run-in-ci',
      CI_WORKFLOW_PATH,
      AUDIT_SCRIPT,
      `No job runs \`npm run ${AUDIT_SCRIPT}\`, so none of the rules above blocks anything.`,
    );
  }

  return { violations, resourcesRead: resources.length, architectures };
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations
    .map((violation) => `  [${violation.rule}] ${violation.file} ${violation.location}\n    ${violation.message}`)
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
  const now = args.includes('--now') ? new Date() : undefined;
  const root = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? path.join(__dirname, '..', '..', '..'));
  const templates = readTemplates(root);

  if (templates.length === 0) {
    console.error(
      `\nNo synthesised templates under ${root}/aws/cdk/cdk.out. Run \`npx cdk synth\` first — ` +
        'this gate reads what synth wrote, because that is where an architecture is decided.\n',
    );
    process.exit(1);
  }

  const docPath = path.join(root, GRAVITON_DOC_PATH);
  const buildPath = path.join(root, BUILD_WORKFLOW_PATH);
  for (const [label, file] of [
    [GRAVITON_DOC_PATH, docPath],
    [BUILD_WORKFLOW_PATH, buildPath],
  ] as const) {
    if (!fs.existsSync(file)) {
      console.error(`\n${label} does not exist, and this gate reads it.\n`);
      process.exit(1);
    }
  }

  const workflowPath = path.join(root, CI_WORKFLOW_PATH);
  const result = auditGraviton({
    templates,
    gravitonDoc: fs.readFileSync(docPath, 'utf8'),
    buildWorkflow: fs.readFileSync(buildPath, 'utf8'),
    ciWorkflow: fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : undefined,
    layerMachines: measureLayerArchitectures(path.join(root, 'aws', 'cdk')),
    now,
  });

  if (result.resourcesRead === 0) {
    console.error(
      `\nNo compute resources in ${templates.length} template(s). Either every stack stopped ` +
        'synthesising or the resource types this gate reads were renamed, and the second case ' +
        'leaves every rule unevaluated while the gate stays green.\n',
    );
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} architecture violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error(`\nSee ${GRAVITON_DOC_PATH}.\n`);
    process.exit(1);
  }

  const totals = verdictTotals();
  console.log(
    `${result.resourcesRead} compute resource(s) across ${templates.length} template(s), all ` +
      `classified: ${totals.migrated} on Graviton, ${totals.blocked} blocked, ` +
      `${totals.unavailable} with no arm64 to move to. Every architecture in cdk.out is the one ` +
      'the catalogue claims and every one of ours is declared rather than defaulted; every image ' +
      `an ARM64 task pulls was measured multi-platform; ${IMAGE_PLATFORMS.length} pinned image(s) ` +
      'classified; the blocker on a single-platform build pipeline matches what ' +
      `${BUILD_WORKFLOW_PATH} actually builds; and both published tables are what ` +
      'lib/graviton-migration.ts renders.',
  );
}
