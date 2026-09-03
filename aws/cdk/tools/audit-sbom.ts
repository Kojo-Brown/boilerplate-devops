#!/usr/bin/env node
/**
 * Audit that every workflow which publishes a release artifact also produces a
 * CycloneDX SBOM for it, verifies it, and attaches it somewhere durable.
 *
 * An SBOM is only worth having if it is *complete* and *reachable*. Both
 * properties fail silently, which is why this is a gate and not a convention:
 *
 *   • A new publishing workflow arrives with no SBOM at all. Nothing breaks.
 *     Nobody notices until an advisory lands and the question "is this image
 *     affected?" has no answer.
 *
 *   • The SBOM is generated in SPDX rather than CycloneDX because
 *     `anchore/sbom-action`'s `format` input **defaults to `spdx-json`**.
 *     Omitting one line produces a perfectly good SBOM in the wrong format, and
 *     every tool in the pipeline downstream of it reads CycloneDX.
 *
 *   • The SBOM describes the source tree rather than the image. A scan of `.`
 *     reports what the repository declares; it cannot see the base image's OS
 *     packages or anything a `RUN apt-get install` added. Those are the layers
 *     CVEs are usually found in, so this SBOM is wrong precisely where it
 *     matters, while looking entirely healthy.
 *
 *   • The SBOM is generated *after* the push. The artifact is already released
 *     by the time anything inventories it, so a failed scan is a red build over
 *     an image that is already in the registry and already deployable.
 *
 *   • The SBOM exists but nothing durable receives it — or, for an image, it is
 *     kept only as a workflow artifact, which expires after 90 days while the
 *     image it describes does not.
 *
 *   • Nothing checks the SBOM before it is attached. Syft exits 0 and writes a
 *     schema-valid CycloneDX document when it finds nothing at all, so
 *     `"components": []` reaches the registry looking like a successful scan.
 *
 * The rules, and the failure each one prevents:
 *
 *   release-artifact-without-sbom   a job publishes and nothing inventories it
 *   sbom-format-not-cyclonedx       SPDX (the default) rather than CycloneDX
 *   sbom-describes-source-not-image an image publish inventoried from a path
 *   sbom-after-publish              the artifact shipped before the scan ran
 *   sbom-not-attached               generated, then dropped on the floor
 *   image-sbom-not-in-registry      kept only in a place that expires
 *   sbom-generator-unpinned         the scanner itself on a mutable tag
 *   sbom-unverified                 an empty SBOM would pass unnoticed
 *
 * **What this does not do.** It reads workflow *shape*: which steps exist, what
 * they are pointed at, and what order they run in. It cannot prove the SBOM a
 * run produces actually describes the artifact that run published — only the
 * `bomFormat` / `metadata.component` assertions in the workflows themselves can
 * do that, at run time, which is why `sbom-unverified` requires them to be
 * there. Step classification is by command and action name (see the pattern
 * tables below); a publisher invoked by some means none of them match is
 * invisible here, so adding a new publishing mechanism means adding it there.
 *
 * Usage:
 *   npm run audit:sbom                          # repository root
 *   npx ts-node tools/audit-sbom.ts <dir>
 *
 * Exits non-zero when anything is found.
 */
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';

export type ViolationRule =
  | 'release-artifact-without-sbom'
  | 'sbom-format-not-cyclonedx'
  | 'sbom-describes-source-not-image'
  | 'sbom-after-publish'
  | 'sbom-not-attached'
  | 'image-sbom-not-in-registry'
  | 'sbom-generator-unpinned'
  | 'sbom-unverified';

export interface Violation {
  readonly rule: ViolationRule;
  /** Repository-relative workflow path, e.g. `workflow-templates/sbom.yml`. */
  readonly file: string;
  /** `<job id>` or `<job id>#<step name>`, so a message names one place. */
  readonly location: string;
  readonly message: string;
}

/** A parsed workflow, keyed by the path it was read from. */
export interface WorkflowFile {
  readonly path: string;
  /** Whatever `js-yaml` produced. Narrowed defensively — this is user input. */
  readonly document: unknown;
}

/**
 * What is being released. The two kinds get different treatment because
 * "attached" means different things: an image can carry its SBOM in the
 * registry, a directory has nowhere to carry anything and needs an upload.
 */
export type ArtifactKind = 'image' | 'directory';

/** The CycloneDX JSON media type, as used for the OCI referrer artifactType. */
export const CYCLONEDX_MEDIA_TYPE = 'application/vnd.cyclonedx+json';

/**
 * Commands that put an artifact somewhere a consumer later pulls it from.
 * `docker build` alone is not here: a local image nobody can reach is not a
 * release.
 */
const PUBLISH_PATTERNS: readonly { readonly kind: ArtifactKind; readonly pattern: RegExp }[] = [
  { kind: 'image', pattern: /\bdocker\s+push\b/ },
  { kind: 'image', pattern: /\bdocker\s+buildx\s+build\b[\s\S]*?--push\b/ },
  { kind: 'image', pattern: /\bhelm\s+push\b/ },
  { kind: 'image', pattern: /\boras\s+push\b/ },
  // The negative lookahead makes this an *upload*: a first positional argument
  // of `s3://` is a download, which releases nothing.
  { kind: 'directory', pattern: /\baws\s+s3\s+(?:sync|cp)\s+(?!s3:\/\/)[\s\S]*?s3:\/\// },
  { kind: 'directory', pattern: /\bgh\s+release\s+upload\b/ },
  { kind: 'directory', pattern: /\b(?:npm|pnpm|yarn)\s+publish\b/ },
];

/** Actions that publish, and the `with:` key whose truth makes them publish. */
const PUBLISH_ACTIONS: readonly {
  readonly action: string;
  readonly kind: ArtifactKind;
  readonly gate?: string;
}[] = [{ action: 'docker/build-push-action', kind: 'image', gate: 'push' }];

/** Actions whose job is to produce an SBOM. */
const SBOM_ACTIONS: readonly string[] = [
  'anchore/sbom-action',
  'cyclonedx/gh-node-module-generatebom',
];

/** Commands that produce an SBOM. */
const SBOM_COMMAND = /\b(?:syft\b|cyclonedx-(?:npm|py|gomod|cli)\b|cdxgen\b)/;

/** Commands that put an SBOM into a registry, next to the artifact it describes. */
const REGISTRY_ATTACH_COMMAND = /\boras\s+attach\b|\bcosign\s+attach\s+sbom\b|\bcosign\s+attest\b/;

/**
 * Commands that put an SBOM somewhere outside the run. A workflow artifact
 * counts; it expires, which is why images are held to
 * `image-sbom-not-in-registry` on top of this.
 */
const OTHER_ATTACH_COMMAND = /\bgh\s+release\s+upload\b|\baws\s+s3\s+(?:sync|cp)\b/;

/** Actions that put an SBOM somewhere outside the run. */
const ATTACH_ACTIONS: readonly string[] = ['actions/upload-artifact'];

/**
 * The marker that identifies a step as verifying an SBOM. `bomFormat` is the
 * CycloneDX field that distinguishes a real CycloneDX document from any other
 * JSON, so a step that reads it is a step that is checking the document rather
 * than moving it. Deliberately a literal: the alternative is guessing at shell,
 * and a gate that guesses is a gate nobody trusts.
 */
export const VERIFICATION_MARKER = 'bomFormat';

/** A CycloneDX output format, as syft and sbom-action name it. */
const CYCLONEDX_FORMAT = /^cyclonedx/i;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** GitHub accepts `true`, `"true"` and `${{ ... }}` here; only a literal false is false. */
const isTruthyInput = (value: unknown): boolean =>
  value !== undefined && value !== false && value !== 'false' && value !== '';

export interface Step {
  readonly index: number;
  readonly name: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with: Record<string, unknown>;
}

export interface Job {
  readonly id: string;
  readonly needs: readonly string[];
  readonly steps: readonly Step[];
}

const stepName = (index: number, step: Record<string, unknown>): string =>
  asString(step.name) ?? asString(step.uses) ?? asString(step.id) ?? `step ${index + 1}`;

export const parseJobs = (document: unknown): Job[] => {
  const jobs = asRecord(asRecord(document)?.jobs) ?? {};

  return Object.entries(jobs).flatMap(([id, value]) => {
    const job = asRecord(value);
    if (job === undefined) return [];

    // GitHub accepts both `needs: build` and `needs: [build, test]`.
    const needs =
      typeof job.needs === 'string'
        ? [job.needs]
        : asArray(job.needs).flatMap((value) => {
            const name = asString(value);
            return name === undefined ? [] : [name];
          });

    const steps = asArray(job.steps).flatMap((value, index) => {
      const step = asRecord(value);
      if (step === undefined) return [];

      return [
        {
          index,
          name: stepName(index, step),
          uses: asString(step.uses),
          run: asString(step.run),
          with: asRecord(step.with) ?? {},
        },
      ];
    });

    return [{ id, needs, steps }];
  });
};

/** `owner/repo` from a `uses:` value, dropping the ref and any subdirectory. */
export const actionName = (uses: string): string => uses.split('@')[0];

/** The ref a `uses:` value pins to, if it carries one. */
const actionRef = (uses: string): string | undefined => uses.split('@')[1];

const usesAction = (step: Step, names: readonly string[]): boolean =>
  step.uses !== undefined && names.includes(actionName(step.uses));

export const isSbomStep = (step: Step): boolean =>
  usesAction(step, SBOM_ACTIONS) || (step.run !== undefined && SBOM_COMMAND.test(step.run));

/**
 * Whether a step moves an SBOM rather than an application artifact.
 *
 * This is checked *before* publish classification, and it is what stops
 * `gh release upload sbom.cdx.json` from reading as a release that needs its
 * own SBOM — which would be both wrong and unsatisfiable.
 */
export const isSbomAttachStep = (step: Step): boolean => {
  // The generator can be its own attachment. `anchore/sbom-action` uploads the
  // SBOM as a workflow artifact unless told not to, so the *absence* of
  // `upload-artifact` means it uploads — only a literal false opts out.
  if (usesAction(step, SBOM_ACTIONS)) {
    const optedOut =
      step.with['upload-artifact'] === false || step.with['upload-artifact'] === 'false';
    return !optedOut || isTruthyInput(step.with['upload-release-assets']);
  }

  if (usesAction(step, ATTACH_ACTIONS)) {
    return /sbom|\.cdx\./i.test(JSON.stringify(step.with));
  }

  if (step.run === undefined) return false;
  if (REGISTRY_ATTACH_COMMAND.test(step.run)) return true;

  return OTHER_ATTACH_COMMAND.test(step.run) && /sbom|\.cdx\./i.test(step.run);
};

export const isRegistryAttachStep = (step: Step): boolean =>
  step.run !== undefined && REGISTRY_ATTACH_COMMAND.test(step.run);

export const isVerificationStep = (step: Step): boolean =>
  step.run !== undefined && step.run.includes(VERIFICATION_MARKER);

export interface PublishStep {
  readonly step: Step;
  readonly kind: ArtifactKind;
}

/** Every step in a job that releases an artifact, with what kind it releases. */
export const publishSteps = (job: Job): PublishStep[] =>
  job.steps.flatMap((step) => {
    // An SBOM upload is not a release of its own; see isSbomAttachStep.
    if (isSbomAttachStep(step)) return [];

    for (const { action, kind, gate } of PUBLISH_ACTIONS) {
      if (step.uses === undefined || actionName(step.uses) !== action) continue;
      if (gate !== undefined && !isTruthyInput(step.with[gate])) continue;
      return [{ step, kind }];
    }

    if (step.run === undefined) return [];

    for (const { kind, pattern } of PUBLISH_PATTERNS) {
      if (pattern.test(step.run)) return [{ step, kind }];
    }

    return [];
  });

/**
 * The SBOM output format a step asks for, or undefined when it does not say.
 *
 * "Does not say" is not benign: `anchore/sbom-action` defaults to `spdx-json`,
 * so an omitted `format` is an SPDX SBOM, not a missing one.
 */
export const sbomFormat = (step: Step): string | undefined => {
  const declared = asString(step.with.format);
  if (declared !== undefined) return declared;

  const flag = step.run?.match(/(?:-o|--output)[\s=]+([\w.-]+)/);
  return flag?.[1];
};

/** Whether an SBOM step inventories a container image rather than a path. */
export const scansImage = (step: Step): boolean => {
  if (isTruthyInput(step.with.image)) return true;
  if (step.run === undefined) return false;

  // `syft <ref>` where the reference is an explicit image scheme, or looks like
  // a registry reference rather than a path.
  return /\bsyft\s+(?:scan\s+)?(?:registry:|docker:|podman:|oci:|"?\$\{?\w*IMAGE)/i.test(step.run);
};

const violation = (
  rule: ViolationRule,
  file: string,
  location: string,
  message: string,
): Violation => ({ rule, file, location, message });

/**
 * Audit one job that publishes something. `downstream` is every job in the same
 * workflow that depends on this one, transitively — inventorying a pushed image
 * from a later job is a legitimate pattern and must not be reported as missing.
 */
const auditPublishingJob = (
  workflow: WorkflowFile,
  job: Job,
  published: readonly PublishStep[],
  downstream: readonly Job[],
): Violation[] => {
  const violations: Violation[] = [];
  const file = workflow.path;
  const kinds = new Set(published.map((p) => p.kind));

  const localSbomSteps = job.steps.filter(isSbomStep);
  const downstreamSbomSteps = downstream.flatMap((other) =>
    other.steps.filter(isSbomStep).map((step) => ({ job: other, step })),
  );

  if (localSbomSteps.length === 0 && downstreamSbomSteps.length === 0) {
    return [
      violation(
        'release-artifact-without-sbom',
        file,
        job.id,
        `publishes a release artifact at "${published[0].step.name}" but neither this job ` +
          'nor any job downstream of it generates an SBOM. Nothing will be able to answer ' +
          '"is this artifact affected?" for the next advisory. See docs/sbom.md.',
      ),
    ];
  }

  const firstPublishIndex = Math.min(...published.map((p) => p.step.index));

  for (const step of localSbomSteps) {
    const where = `${job.id}#${step.name}`;

    if (step.uses !== undefined) {
      const ref = actionRef(step.uses);
      if (ref === undefined || !/^[0-9a-f]{40}$/.test(ref)) {
        violations.push(
          violation(
            'sbom-generator-unpinned',
            file,
            where,
            `the SBOM generator is pinned to "${ref ?? '(no ref)'}", a tag that can be ` +
              'repointed. The scanner decides what the inventory says, so an unpinned ' +
              'scanner is a supply-chain dependency of every artifact this workflow ' +
              'releases. Pin it to a full commit SHA.',
          ),
        );
      }
    }

    const format = sbomFormat(step);
    if (format === undefined || !CYCLONEDX_FORMAT.test(format)) {
      violations.push(
        violation(
          'sbom-format-not-cyclonedx',
          file,
          where,
          format === undefined
            ? 'no SBOM format is declared. anchore/sbom-action defaults to `spdx-json`, so ' +
                'this silently produces an SPDX document. Set `format: cyclonedx-json`.'
            : `the SBOM format is "${format}", not CycloneDX. Set \`format: cyclonedx-json\`.`,
        ),
      );
    }

    if (kinds.has('image') && !scansImage(step)) {
      violations.push(
        violation(
          'sbom-describes-source-not-image',
          file,
          where,
          'this job publishes a container image, but the SBOM is taken from a path rather ' +
            "than from the image. A scan of the source tree cannot see the base image's OS " +
            'packages, anything a `RUN` step installed, or a vendored dependency — which is ' +
            'where most CVEs live. Point the scan at the image reference.',
        ),
      );
    }

    if (step.index > firstPublishIndex) {
      violations.push(
        violation(
          'sbom-after-publish',
          file,
          where,
          `the artifact is published at step ${firstPublishIndex + 1} and inventoried at ` +
            `step ${step.index + 1}. A scan that runs after the push cannot gate the ` +
            'release: when it fails, the build goes red over an artifact that is already ' +
            'in the registry and already deployable. Scan before publishing.',
        ),
      );
    }
  }

  // Job-wide, so a job with two generators and no assertion reports once.
  if (localSbomSteps.length > 0 && !job.steps.some(isVerificationStep)) {
    violations.push(
      violation(
        'sbom-unverified',
        file,
        `${job.id}#${localSbomSteps[0].name}`,
        'nothing in this job checks the SBOM before it is used. Syft exits 0 and writes a ' +
          'schema-valid CycloneDX document when it finds nothing, so `"components": []` ' +
          'passes every other gate here and reaches consumers looking like a successful ' +
          `scan. Add a step asserting \`${VERIFICATION_MARKER}\`, a non-empty ` +
          '`components`, and — for an image — that `metadata.component` names it.',
      ),
    );
  }

  const attachSteps = [...job.steps, ...downstream.flatMap((other) => [...other.steps])].filter(
    isSbomAttachStep,
  );

  if (attachSteps.length === 0) {
    violations.push(
      violation(
        'sbom-not-attached',
        file,
        job.id,
        'an SBOM is generated but never uploaded or attached anywhere, so it exists only ' +
          'inside the runner and is gone when the job ends. Upload it as a workflow ' +
          'artifact at minimum.',
      ),
    );
  } else if (kinds.has('image') && !attachSteps.some(isRegistryAttachStep)) {
    violations.push(
      violation(
        'image-sbom-not-in-registry',
        file,
        job.id,
        'the SBOM for a published image is kept only outside the registry. Workflow ' +
          'artifacts expire after 90 days and release assets live in a different system ' +
          'from the image; the image does not expire. Attach it to the image manifest as ' +
          `an OCI referrer (\`oras attach --artifact-type ${CYCLONEDX_MEDIA_TYPE}\`) so ` +
          '`oras discover` finds it from the image alone.',
      ),
    );
  }

  return violations;
};

/** Every job that transitively `needs` `jobId`, within one workflow. */
export const downstreamJobs = (jobs: readonly Job[], jobId: string): Job[] => {
  const reached = new Set<string>([jobId]);

  // Fixed-point rather than recursion: `needs` graphs are small, and this
  // terminates on the cyclic graphs GitHub itself rejects rather than blowing
  // the stack on them.
  for (let changed = true; changed; ) {
    changed = false;
    for (const job of jobs) {
      if (reached.has(job.id)) continue;
      if (!job.needs.some((need) => reached.has(need))) continue;
      reached.add(job.id);
      changed = true;
    }
  }

  return jobs.filter((job) => job.id !== jobId && reached.has(job.id));
};

/**
 * Audit one workflow. Pure — the unit tests drive this directly, with no
 * filesystem involved.
 */
export const auditWorkflow = (workflow: WorkflowFile): Violation[] => {
  const jobs = parseJobs(workflow.document);

  return jobs.flatMap((job) => {
    const published = publishSteps(job);
    if (published.length === 0) return [];

    return auditPublishingJob(workflow, job, published, downstreamJobs(jobs, job.id));
  });
};

export const auditSbom = (workflows: readonly WorkflowFile[]): Violation[] =>
  workflows.flatMap(auditWorkflow);

export const formatViolations = (violations: readonly Violation[]): string =>
  violations
    .map((v) => `${v.file}  ${v.location}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');

/**
 * Read every workflow this repository runs *and* every template it ships. The
 * templates matter more, not less: a template with no SBOM is the product
 * being broken, and it is broken identically in every repository that copied
 * it.
 */
export const readWorkflows = (root: string): WorkflowFile[] =>
  [path.join('.github', 'workflows'), 'workflow-templates'].flatMap((relative) => {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return [];

    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .sort()
      .map((name) => ({
        path: path.posix.join(...relative.split(path.sep), name),
        document: load(fs.readFileSync(path.join(directory, name), 'utf8')),
      }));
  });

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const workflows = readWorkflows(root);

  if (workflows.length === 0) {
    console.error(`No workflows found under ${root}.`);
    process.exit(1);
  }

  const violations = auditSbom(workflows);

  if (violations.length > 0) {
    console.error(`\n${violations.length} SBOM violation(s):\n`);
    console.error(formatViolations(violations));
    console.error('\nSee docs/sbom.md.\n');
    process.exit(1);
  }

  console.log(`${workflows.length} workflow(s) in ${root} publish nothing without a CycloneDX SBOM.`);
}
