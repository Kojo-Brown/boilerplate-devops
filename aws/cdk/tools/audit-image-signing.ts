#!/usr/bin/env node
/**
 * Audit that every workflow which publishes a container image signs it, and
 * that every workflow which deploys one refuses to deploy an image whose
 * signature does not check out.
 *
 * A signature is worth nothing on its own. It is worth something only when
 * something downstream *refuses* on its absence, and it is worth what you think
 * it is worth only when that refusal names who the signer must be. Every way
 * this goes wrong leaves a green pipeline behind it:
 *
 *   • An image is published and never signed. Nothing breaks. The deploy that
 *     was supposed to be gated on provenance is gated on nothing, and it stays
 *     that way until someone asks who built the thing in production.
 *
 *   • The image is signed by tag. `cosign sign app:v1` resolves the tag and
 *     signs whatever it points at *now*, which is not necessarily what this run
 *     built — and the resulting signature, being over a digest, looks identical
 *     to a correct one.
 *
 *   • The signature is made but never verified, so a signature that no deploy
 *     can verify — wrong issuer, an identity the deploy does not expect, a
 *     transparency-log entry that never landed — ships looking healthy and
 *     fails in a different repository, hours later.
 *
 *   • A deploy verifies with `--certificate-identity-regexp '.*'`. cosign
 *     *requires* an identity and an issuer, so this is what defeating the check
 *     actually looks like in practice: it asserts that somebody signed the
 *     image, which anyone with a GitHub account can arrange for an image of
 *     their own. The build goes green and the gate is decorative.
 *
 *   • A deploy verifies a tag and then deploys that tag. Those are two registry
 *     reads with a window between them; only the second one runs. Verification
 *     has to resolve a digest and the deploy has to use *that* digest.
 *
 *   • Signing with a long-lived key. It proves that whoever holds the key
 *     signed, which is a strictly weaker claim than keyless OIDC's "this
 *     workflow, in this repository, at this ref" — and it survives the key
 *     being stolen, which is the case the signature exists for.
 *
 *   • cosign itself floating on a mutable tag. The binary decides what
 *     "verified" means; an unpinned verifier is a supply-chain dependency of
 *     every deploy that trusts it.
 *
 * The rules, and the failure each one prevents:
 *
 *   image-published-without-signature  an image ships with no provenance at all
 *   signature-before-push              nothing to sign yet; the manifest is local
 *   signs-mutable-tag                  signs whatever the tag points at right now
 *   signature-not-verified-at-build    an unverifiable signature ships as a good one
 *   keyless-signing-without-id-token   cosign cannot get a certificate at run time
 *   long-lived-signing-key             key custody in place of workflow identity
 *   image-deployed-without-verification  the gate does not exist on this path
 *   verification-identity-unpinned     "signed by anyone" verified as "signed"
 *   deploys-unverified-reference       verified a digest, deployed a tag
 *   cosign-unpinned                    the verifier itself is mutable
 *
 * **What this does not do.** It reads workflow *shape* — which steps exist,
 * what they are pointed at, and in what order — exactly as `audit-sbom.ts`
 * does, and the two disagree about ordering on purpose: an SBOM must be
 * generated *before* the push so a bad inventory can stop the release, while a
 * signature can only be made *after* it, because until the push there is no
 * manifest in the registry to sign. Neither tool can prove the signature a run
 * makes covers the image that run built; the sign-then-verify step this gate
 * requires is what checks that, at run time.
 *
 * Deploy steps are recognised by command and action name (see the tables
 * below), and a job only counts as deploying an image if it also *names* one —
 * which is what keeps a rollback to an already-deployed task definition, where
 * no new image reference enters the system, out of scope.
 *
 * Usage:
 *   npm run audit:signing                        # repository root
 *   npx ts-node tools/audit-image-signing.ts <dir>
 *
 * Exits non-zero when anything is found.
 */
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';

export type ViolationRule =
  | 'image-published-without-signature'
  | 'signature-before-push'
  | 'signs-mutable-tag'
  | 'signature-not-verified-at-build'
  | 'keyless-signing-without-id-token'
  | 'long-lived-signing-key'
  | 'image-deployed-without-verification'
  | 'verification-identity-unpinned'
  | 'deploys-unverified-reference'
  | 'cosign-unpinned';

export interface Violation {
  readonly rule: ViolationRule;
  /** Repository-relative workflow path, e.g. `workflow-templates/deploy-ecs.yml`. */
  readonly file: string;
  /** `<job id>` or `<job id>#<step name>`, so a message names one place. */
  readonly location: string;
  readonly message: string;
}

export interface WorkflowFile {
  readonly path: string;
  /** Whatever `js-yaml` produced. Narrowed defensively — this is user input. */
  readonly document: unknown;
}

/** The GitHub Actions OIDC issuer, which is what keyless signing here presents. */
export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/** Commands that put an image somewhere a deploy can later pull it from. */
const IMAGE_PUBLISH_PATTERNS: readonly RegExp[] = [
  /\bdocker\s+push\b/,
  /\bdocker\s+buildx\s+build\b[\s\S]*?--push\b/,
  /\boras\s+push\b/,
];

/** Actions that publish an image, and the `with:` key whose truth makes them. */
const IMAGE_PUBLISH_ACTIONS: readonly { readonly action: string; readonly gate?: string }[] = [
  { action: 'docker/build-push-action', gate: 'push' },
];

/** Actions that put a named image into a runtime. */
const DEPLOY_ACTIONS: readonly string[] = [
  'aws-actions/amazon-ecs-render-task-definition',
  'aws-actions/amazon-ecs-deploy-task-definition',
];

/** Commands that put a named image into a runtime. */
const DEPLOY_COMMANDS: readonly RegExp[] = [
  /\baws\s+ecs\s+register-task-definition\b/,
  /\baws\s+ecs\s+update-service\b/,
  /\bkubectl\s+set\s+image\b/,
  /\bhelm\s+(?:upgrade|install)\b/,
  /\bcdk\s+deploy\b/,
];

/**
 * How an image reference is named. Deliberately narrow: it is the thing that
 * decides whether a job is deploying an image at all, and a loose pattern here
 * turns every `aws ecs update-service` — a rollback included — into a finding
 * nobody can act on.
 */
const IMAGE_REFERENCE = /\bimage[-_]?uri\b|\bimage-ref\b|\bIMAGE_(?:URI|REF)\b/i;

const COSIGN_SIGN = /\bcosign\s+sign\b(?!-blob)/;
const COSIGN_VERIFY = /\bcosign\s+verify\b(?!-blob)/;
const COSIGN_INSTALLER = 'sigstore/cosign-installer';

/** A reference pinned by digest, or a variable holding one. */
const DIGEST_PINNED = /@sha256:|\$\{?\w*(?:DIGEST|IMAGE_REF)\b|steps\.[\w-]+\.outputs\.image-ref/i;

/** Signing with key material rather than a workflow identity. */
const SIGNING_KEY_FLAG = /--key[\s=]|\bCOSIGN_PRIVATE_KEY\b/;

/**
 * Identity patterns that match every signer. `cosign verify` will not run
 * without an identity, so this — not omission — is what a defeated gate looks
 * like.
 */
export const CATCH_ALL_IDENTITY = /^\^?(?:\.\*|\.\+)\$?$/;

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
  readonly env: Record<string, unknown>;
}

export interface Job {
  readonly id: string;
  readonly needs: readonly string[];
  /** Job-level `permissions:`, or undefined when the job inherits them. */
  readonly permissions?: Record<string, unknown> | string;
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
        : asArray(job.needs).flatMap((entry) => {
            const name = asString(entry);
            return name === undefined ? [] : [name];
          });

    const steps = asArray(job.steps).flatMap((entry, index) => {
      const step = asRecord(entry);
      if (step === undefined) return [];

      return [
        {
          index,
          name: stepName(index, step),
          uses: asString(step.uses),
          run: asString(step.run),
          with: asRecord(step.with) ?? {},
          env: asRecord(step.env) ?? {},
        },
      ];
    });

    const permissions = asRecord(job.permissions) ?? asString(job.permissions);

    return [{ id, needs, permissions, steps }];
  });
};

/** `owner/repo` from a `uses:` value, dropping the ref and any subdirectory. */
export const actionName = (uses: string): string => uses.split('@')[0];

/** The ref a `uses:` value pins to, if it carries one. */
export const actionRef = (uses: string): string | undefined => uses.split('@')[1];

const usesAction = (step: Step, names: readonly string[]): boolean =>
  step.uses !== undefined && names.includes(actionName(step.uses));

/** Everything a step says, for the checks that do not care where it was said. */
const stepText = (step: Step): string =>
  [step.run ?? '', JSON.stringify(step.with), JSON.stringify(step.env)].join('\n');

export const isPublishStep = (step: Step): boolean => {
  for (const { action, gate } of IMAGE_PUBLISH_ACTIONS) {
    if (step.uses === undefined || actionName(step.uses) !== action) continue;
    if (gate !== undefined && !isTruthyInput(step.with[gate])) continue;
    return true;
  }

  return step.run !== undefined && IMAGE_PUBLISH_PATTERNS.some((p) => p.test(step.run as string));
};

export const isSignStep = (step: Step): boolean =>
  step.run !== undefined && COSIGN_SIGN.test(step.run);

export const isVerifyStep = (step: Step): boolean =>
  step.run !== undefined && COSIGN_VERIFY.test(step.run);

/**
 * Whether a step hands a named image to a runtime.
 *
 * `cdk deploy` and `aws ecs update-service` are here because they do, but only
 * when an image reference is what they are carrying — see `deployStepsInJob`,
 * which is what keeps a rollback out.
 */
const isDeployMechanism = (step: Step): boolean =>
  usesAction(step, DEPLOY_ACTIONS) ||
  (step.run !== undefined && DEPLOY_COMMANDS.some((p) => p.test(step.run as string)));

/** Whether a step names an image reference at all. */
export const namesImage = (step: Step): boolean =>
  IMAGE_REFERENCE.test(stepText(step)) || isTruthyInput(step.with.image);

/**
 * The steps in a job that deploy a named image. A deploy mechanism that names
 * no image — `aws ecs update-service --force-new-deployment` re-running the
 * task definition already registered, say — introduces no new artifact and has
 * nothing to verify.
 */
export const deployStepsInJob = (job: Job): Step[] => {
  const deployMechanisms = job.steps.filter(isDeployMechanism);
  if (deployMechanisms.length === 0) return [];

  // The image can be named by a step other than the one that deploys — a
  // rendered task definition, a `--context` built earlier — so the question is
  // whether an image reference is in play anywhere in this job.
  const jobNamesImage = job.steps.some(namesImage);
  if (!jobNamesImage) return [];

  return deployMechanisms.filter(namesImage);
};

/**
 * The reference a signing step signs, as written. Line continuations are
 * collapsed first: a signing command is nearly always spread over several
 * lines, and the reference is the last argument of the joined command rather
 * than of any one line.
 */
export const signedReference = (step: Step): string | undefined => {
  const run = step.run?.replace(/\\\n\s*/g, ' ');
  const match = run?.match(/cosign\s+sign\b[^\n]*?\s("?[^"\s]+"?)\s*$/m);
  return match?.[1]?.replace(/"/g, '');
};

export interface VerificationFlags {
  readonly identity?: string;
  readonly issuer?: string;
}

/**
 * The identity and issuer a `cosign verify` invocation pins to. Values are
 * resolved through the step's `env:` when the flag is a variable reference,
 * because that is how a workflow passes an input into a shell.
 */
export const verificationFlags = (step: Step): VerificationFlags => {
  const run = step.run ?? '';

  const flag = (names: readonly string[]): string | undefined => {
    for (const name of names) {
      const match = run.match(new RegExp(`${name}[\\s=]+("[^"]*"|'[^']*'|\\S+)`));
      if (match === undefined || match === null) continue;

      const raw = match[1].replace(/^["']|["']$/g, '');
      const variable = raw.match(/^\$\{?(\w+)\}?$/);
      if (variable === null) return raw;

      // `--certificate-identity-regexp "$IDENTITY_REGEXP"` is the normal shape;
      // what it is worth depends on what the workflow put in that variable.
      const bound = asString(step.env[variable[1]]);
      return bound ?? raw;
    }
    return undefined;
  };

  return {
    identity: flag(['--certificate-identity-regexp', '--certificate-identity']),
    issuer: flag(['--certificate-oidc-issuer-regexp', '--certificate-oidc-issuer']),
  };
};

/**
 * Whether a value pins anything. A GitHub expression is left to the caller of
 * the workflow, which is a deliberate choice and not a hole: the alternative is
 * an audit that can only pass when every identity is hardcoded.
 */
const isExpression = (value: string): boolean => value.includes('${{');

const violation = (
  rule: ViolationRule,
  file: string,
  location: string,
  message: string,
): Violation => ({ rule, file, location, message });

/** Whether a workflow or job grants `id-token: write`. */
export const grantsIdToken = (
  document: unknown,
  job: Job,
): boolean => {
  const check = (permissions: Record<string, unknown> | string | undefined): boolean | undefined => {
    if (permissions === undefined) return undefined;
    if (typeof permissions === 'string') return permissions === 'write-all';
    return permissions['id-token'] === 'write';
  };

  const workflowPermissions = asRecord(document)?.permissions;

  // A job's own `permissions:` replaces the workflow's rather than adding to
  // it, so an explicit job block that omits id-token is a refusal.
  return (
    check(job.permissions) ??
    check(asRecord(workflowPermissions) ?? asString(workflowPermissions)) ??
    false
  );
};

const auditCosignPins = (workflow: WorkflowFile, job: Job): Violation[] =>
  job.steps.flatMap((step) => {
    if (step.uses === undefined || actionName(step.uses) !== COSIGN_INSTALLER) return [];

    const violations: Violation[] = [];
    const where = `${job.id}#${step.name}`;
    const ref = actionRef(step.uses);

    if (ref === undefined || !/^[0-9a-f]{40}$/.test(ref)) {
      violations.push(
        violation(
          'cosign-unpinned',
          workflow.path,
          where,
          `the cosign installer is pinned to "${ref ?? '(no ref)'}", a tag that can be ` +
            'repointed. cosign is what decides whether a signature verifies, so an unpinned ' +
            'installer is a supply-chain dependency of every deploy gated on it. Pin it to a ' +
            'full commit SHA.',
        ),
      );
    }

    const release = asString(step.with['cosign-release']);
    if (release === undefined) {
      violations.push(
        violation(
          'cosign-unpinned',
          workflow.path,
          where,
          'no `cosign-release` is set, so the cosign *binary* is whatever the installer ' +
            'currently defaults to. Bumping the action — an ordinary dependency update — then ' +
            'changes the verifier underneath every deploy. Pin the release explicitly.',
        ),
      );
    } else if (!isExpression(release) && !/^v\d+\.\d+\.\d+$/.test(release)) {
      violations.push(
        violation(
          'cosign-unpinned',
          workflow.path,
          where,
          `\`cosign-release: ${release}\` is not an exact version. Pin it as \`vX.Y.Z\`.`,
        ),
      );
    }

    return violations;
  });

/** Audit one job that publishes a container image. */
const auditPublishingJob = (
  workflow: WorkflowFile,
  document: unknown,
  job: Job,
  published: readonly Step[],
  downstream: readonly Job[],
): Violation[] => {
  const violations: Violation[] = [];
  const file = workflow.path;

  const localSignSteps = job.steps.filter(isSignStep);
  const downstreamSignSteps = downstream.flatMap((other) =>
    other.steps.filter(isSignStep).map((step) => ({ job: other, step })),
  );

  if (localSignSteps.length === 0 && downstreamSignSteps.length === 0) {
    return [
      violation(
        'image-published-without-signature',
        file,
        job.id,
        `publishes a container image at "${published[0].name}" but neither this job nor any ` +
          'job downstream of it signs it. Every deploy that pulls this image is then trusting ' +
          'the registry and whoever can write to it, with nothing tying the image to the ' +
          'build that produced it. Sign it with `cosign sign` over the pushed digest. See ' +
          'docs/image-signing.md.',
      ),
    ];
  }

  const lastPublishIndex = Math.max(...published.map((step) => step.index));

  for (const step of localSignSteps) {
    const where = `${job.id}#${step.name}`;

    if (step.index < lastPublishIndex) {
      violations.push(
        violation(
          'signature-before-push',
          file,
          where,
          `the image is signed at step ${step.index + 1} and pushed at step ` +
            `${lastPublishIndex + 1}. There is no manifest in the registry to sign until the ` +
            'push completes; a signature made before it either fails or covers something ' +
            'else. (This is the opposite of the SBOM ordering, which must precede the push ' +
            'so a bad inventory can stop the release.)',
        ),
      );
    }

    const reference = signedReference(step);
    if (reference !== undefined && !DIGEST_PINNED.test(reference)) {
      violations.push(
        violation(
          'signs-mutable-tag',
          file,
          where,
          `signs "${reference}", which is not pinned by digest. cosign resolves the tag and ` +
            'signs whatever it points at at that moment — which is not necessarily what this ' +
            'run built, and the resulting signature is indistinguishable from a correct one. ' +
            'Sign the digest the push returned.',
        ),
      );
    }

    if (SIGNING_KEY_FLAG.test(step.run ?? '')) {
      violations.push(
        violation(
          'long-lived-signing-key',
          file,
          where,
          'signs with key material. A key proves only that whoever holds it signed, which is ' +
            'the claim that stops being true the moment it is stolen — and it has to be ' +
            'stored, rotated, and kept out of logs. Keyless OIDC signing instead records ' +
            'which workflow, in which repository, at which ref made the signature, and there ' +
            'is nothing to steal.',
        ),
      );
    } else if (!grantsIdToken(document, job)) {
      violations.push(
        violation(
          'keyless-signing-without-id-token',
          file,
          where,
          'signs keylessly, but neither the workflow nor the job grants `id-token: write`. ' +
            'cosign cannot request the OIDC token it exchanges for a Fulcio certificate, so ' +
            'this fails at run time, after the image has already been published.',
        ),
      );
    }
  }

  if (localSignSteps.length > 0 && !job.steps.some(isVerifyStep)) {
    violations.push(
      violation(
        'signature-not-verified-at-build',
        file,
        `${job.id}#${localSignSteps[0].name}`,
        'nothing in this job verifies the signature it just made. A signature with the wrong ' +
          'issuer, an identity no deploy expects, or a transparency-log entry that never ' +
          'landed is indistinguishable from a good one here, and becomes a failed deploy in ' +
          'another repository hours later. Verify it with the same ' +
          '`--certificate-identity-regexp` and `--certificate-oidc-issuer` a deploy will use.',
      ),
    );
  }

  return violations;
};

/** Audit one job that deploys a named container image. */
const auditDeployingJob = (
  workflow: WorkflowFile,
  job: Job,
  deploys: readonly Step[],
): Violation[] => {
  const violations: Violation[] = [];
  const file = workflow.path;
  const verifySteps = job.steps.filter(isVerifyStep);

  if (verifySteps.length === 0) {
    return [
      violation(
        'image-deployed-without-verification',
        file,
        `${job.id}#${deploys[0].name}`,
        'deploys a container image without verifying its signature. Signing a build is only ' +
          'a control if something refuses to run what is unsigned; without this step the ' +
          'signature is documentation. Add a `cosign verify` gated on the identity of the ' +
          'workflow that builds this image, before the image reaches a runtime. See ' +
          'docs/image-signing.md.',
      ),
    ];
  }

  for (const step of verifySteps) {
    const where = `${job.id}#${step.name}`;
    const { identity, issuer } = verificationFlags(step);

    if (identity === undefined) {
      violations.push(
        violation(
          'verification-identity-unpinned',
          file,
          where,
          'verifies without `--certificate-identity` or `--certificate-identity-regexp`. ' +
            'Without an identity there is no statement about *who* signed, only that the ' +
            'image carries some signature.',
        ),
      );
    } else if (!isExpression(identity) && CATCH_ALL_IDENTITY.test(identity)) {
      violations.push(
        violation(
          'verification-identity-unpinned',
          file,
          where,
          `the certificate identity is "${identity}", which matches every signer. Anyone who ` +
            'can run a GitHub Actions workflow can produce a signature that satisfies it — ' +
            'over their own image. Pin the identity to the workflow that builds this image, ' +
            'e.g. `^https://github\\.com/OWNER/REPO/\\.github/workflows/build\\.yml@refs/heads/main$`.',
        ),
      );
    }

    if (issuer === undefined) {
      violations.push(
        violation(
          'verification-identity-unpinned',
          file,
          where,
          'verifies without `--certificate-oidc-issuer`. An identity string is only evidence ' +
            'of who signed if the issuer that asserted it is pinned too — otherwise any ' +
            `issuer willing to mint that identity satisfies the check. Pin ${GITHUB_OIDC_ISSUER}.`,
        ),
      );
    } else if (!isExpression(issuer) && CATCH_ALL_IDENTITY.test(issuer)) {
      violations.push(
        violation(
          'verification-identity-unpinned',
          file,
          where,
          `the OIDC issuer is "${issuer}", which matches every issuer. Pin it to the one that ` +
            `mints the identity above, e.g. ${GITHUB_OIDC_ISSUER}.`,
        ),
      );
    }
  }

  // The point of resolving a digest during verification is that the deploy uses
  // it. A deploy step still reading the caller's reference has verified one
  // registry read and acted on another.
  for (const step of deploys) {
    const text = stepText(step);
    if (!/inputs\.image[-_]?uri/i.test(text)) continue;
    if (DIGEST_PINNED.test(text)) continue;

    violations.push(
      violation(
        'deploys-unverified-reference',
        file,
        `${job.id}#${step.name}`,
        'deploys `inputs.image-uri` rather than the digest the verification resolved. ' +
          'Verifying a tag and then deploying that tag are two registry reads with a window ' +
          'between them, and only the second one runs: a tag repointed inside that window ' +
          'puts an unverified image into production behind a green signature check. Deploy ' +
          '`steps.<verify>.outputs.image-ref`.',
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

/** Audit one workflow. Pure — the unit tests drive this directly. */
export const auditWorkflow = (workflow: WorkflowFile): Violation[] => {
  const jobs = parseJobs(workflow.document);

  return jobs.flatMap((job) => {
    const violations: Violation[] = [];

    const published = job.steps.filter(isPublishStep);
    if (published.length > 0) {
      violations.push(
        ...auditPublishingJob(
          workflow,
          workflow.document,
          job,
          published,
          downstreamJobs(jobs, job.id),
        ),
      );
    }

    // A job can do both — build and deploy in one — and each half is judged on
    // its own terms.
    const deploys = deployStepsInJob(job);
    if (deploys.length > 0) {
      violations.push(...auditDeployingJob(workflow, job, deploys));
    }

    if (published.length > 0 || deploys.length > 0) {
      violations.push(...auditCosignPins(workflow, job));
    }

    return violations;
  });
};

export const auditImageSigning = (workflows: readonly WorkflowFile[]): Violation[] =>
  workflows.flatMap(auditWorkflow);

export const formatViolations = (violations: readonly Violation[]): string =>
  violations
    .map((v) => `${v.file}  ${v.location}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');

/**
 * Read every workflow this repository runs *and* every template it ships. The
 * templates matter more, not less: a deploy template with no verification is
 * the product being broken, and it is broken identically in every repository
 * that copied it.
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

  const violations = auditImageSigning(workflows);

  if (violations.length > 0) {
    console.error(`\n${violations.length} image signing violation(s):\n`);
    console.error(formatViolations(violations));
    console.error('\nSee docs/image-signing.md.\n');
    process.exit(1);
  }

  console.log(
    `${workflows.length} workflow(s) in ${root}: every image published is signed, and every ` +
      'image deployed is verified against a pinned signer.',
  );
}
