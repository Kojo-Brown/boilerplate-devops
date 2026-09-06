#!/usr/bin/env node
/**
 * Audit that every workflow which publishes a container image attests SLSA
 * build provenance for it, that the attestation is the kind it is assumed to
 * be, and that the run which made it also proves it verifies.
 *
 * Provenance answers a question neither of this repository's other supply-chain
 * gates answers. The SBOM says what is *inside* the image. The cosign signature
 * says *this workflow published it*. Provenance says *what went in and what
 * built it* — which source repository, which commit, which workflow at which
 * ref, on which runner. "Did the thing in production come from `main`?" is
 * answerable from a signature only by inference, and from provenance by
 * reading it.
 *
 * Every way this goes wrong leaves a green pipeline behind it, and most of them
 * leave an attestation behind too:
 *
 *   • Nothing attests anything. The image is signed, so the pipeline looks
 *     complete, and the first person to ask how a given digest was built finds
 *     that the answer was never recorded.
 *
 *   • The attestation is made but never pushed to the registry. It then lives
 *     only in GitHub's attestations API, keyed to the repository that built the
 *     image — and anything holding the image but not the repository (a registry
 *     replica, another account's ECR, an air-gapped pull) has no way to reach
 *     it from the digest, which is the only identifier it is guaranteed to
 *     have.
 *
 *   • The subject is a file path rather than the pushed digest. `actions/attest`
 *     accepts `subject-path` happily and attests a tarball on the runner. The
 *     attestation is real, signed, and about something nobody pulls.
 *
 *   • The attestation is not provenance. `actions/attest` picks its mode from
 *     its inputs: `sbom-path` makes an SBOM attestation, `predicate-type` makes
 *     a custom one, and only the absence of both makes build provenance. All
 *     three sign, upload and attach identically, and any gate that asks "is
 *     there an attestation?" is satisfied by all three.
 *
 *   • The job never grants `attestations: write`. The step fails at run time —
 *     after the image has already been published, which is the expensive half.
 *
 *   • The attestation is never verified by the run that made it, so a bundle
 *     that no consumer's policy can satisfy ships looking healthy.
 *
 *   • The verification is scoped to nothing. `gh attestation verify` takes
 *     `--cert-identity-regex`, and a value of `.*` *replaces* the identity the
 *     `--repo` scope would otherwise have derived — asserting that somebody,
 *     anybody, attested this image. That is the same shape as the catch-all
 *     that defeats `cosign verify`, and it is what a defeated gate looks like
 *     in practice, since neither tool lets you simply omit the check.
 *
 *   • The verified subject is a tag. Two registry reads with a window between
 *     them, and only the second one is what runs.
 *
 *   • The attesting action floats on a mutable tag. That action mints and signs
 *     the statement; repointing it rewrites what this repository's provenance
 *     means, for every image built after the tag moves.
 *
 * The rules, and the failure each one prevents:
 *
 *   image-published-without-provenance   how the image was built was never recorded
 *   provenance-before-push               nothing in the registry to attach to yet
 *   provenance-not-pushed-to-registry    the attestation cannot travel with the image
 *   provenance-subject-not-digest        attests something other than what was pushed
 *   attestation-not-provenance           an attestation, but not this kind
 *   provenance-without-attestations-permission  fails after the image ships
 *   provenance-not-verified-at-build     an unverifiable attestation ships as a good one
 *   provenance-verification-unpinned     "attested by anyone" verified as "attested"
 *   verifies-mutable-subject             verified a tag, which is not a thing
 *   attest-action-unpinned               the attestor itself is mutable
 *
 * **What this does not do.** Like `audit-sbom.ts` and `audit-image-signing.ts`
 * it reads workflow *shape*, and it deliberately shares the last one's notion
 * of what publishing an image is: if the two disagreed about that, an image
 * could satisfy the signing gate and never be seen by this one. It cannot tell
 * you that the provenance a run emits describes that run truthfully — nothing
 * static can, because the predicate is assembled at run time. It also does not
 * require provenance to be *verified at deploy*: enforcement there is a policy
 * decision belonging to whoever consumes the image, and the deploy templates in
 * this repository gate on the signature today. See docs/provenance.md §6.
 *
 * Usage:
 *   npm run audit:provenance                   # repository root
 *   npx ts-node tools/audit-provenance.ts <dir>
 *
 * Exits non-zero when anything is found.
 */
import * as path from 'path';
import {
  CATCH_ALL_IDENTITY,
  Job,
  Step,
  WorkflowFile,
  actionName,
  actionRef,
  downstreamJobs,
  isPublishStep,
  parseJobs,
  readWorkflows,
} from './audit-image-signing';

export type ViolationRule =
  | 'image-published-without-provenance'
  | 'provenance-before-push'
  | 'provenance-not-pushed-to-registry'
  | 'provenance-subject-not-digest'
  | 'attestation-not-provenance'
  | 'provenance-without-attestations-permission'
  | 'provenance-not-verified-at-build'
  | 'provenance-verification-unpinned'
  | 'verifies-mutable-subject'
  | 'attest-action-unpinned';

export interface Violation {
  readonly rule: ViolationRule;
  /** Repository-relative workflow path, e.g. `workflow-templates/docker-build-push.yml`. */
  readonly file: string;
  /** `<job id>` or `<job id>#<step name>`, so a message names one place. */
  readonly location: string;
  readonly message: string;
}

/** The predicate type SLSA build provenance carries. */
export const SLSA_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';

/** Actions that mint a signed attestation over a subject. */
const ATTEST_ACTIONS: readonly string[] = ['actions/attest', 'actions/attest-build-provenance'];

/**
 * `cosign attest` is the other way to put a predicate next to an image. It is
 * recognised so that a workflow using it is not reported as attesting nothing;
 * the input-shaped rules below apply only to the actions, which is where those
 * failures live.
 */
const COSIGN_ATTEST = /\bcosign\s+attest\b(?!-blob)/;

const GH_ATTESTATION_VERIFY = /\bgh\s+attestation\s+verify\b/;
const COSIGN_VERIFY_ATTESTATION = /\bcosign\s+verify-attestation\b/;

/**
 * Inputs that switch `actions/attest` out of provenance mode. Each one produces
 * an attestation that signs, uploads and attaches exactly like provenance does.
 */
const NON_PROVENANCE_INPUTS: readonly string[] = ['predicate-type', 'predicate', 'predicate-path', 'sbom-path'];

/** A reference pinned by digest, or a variable holding one. */
const DIGEST_PINNED = /@sha256:|\$\{?\w*(?:DIGEST|IMAGE_REF)\b|steps\.[\w-]+\.outputs\.image-(?:ref|digest)/i;

/** A `--type` that `cosign attest` understands as SLSA provenance. */
const COSIGN_SLSA_TYPE = /^slsaprovenance\d*$|^https:\/\/slsa\.dev\/provenance\//;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** GitHub accepts `true`, `"true"` and `${{ ... }}` here; only a literal false is false. */
const isTruthyInput = (value: unknown): boolean =>
  value !== undefined && value !== false && value !== 'false' && value !== '';

/**
 * Whether a value pins anything. A GitHub expression is left to the caller of
 * the workflow, which is a deliberate choice and not a hole: the alternative is
 * an audit that can only pass when every identity is hardcoded.
 */
const isExpression = (value: string): boolean => value.includes('${{');

/** Everything a step says, for the checks that do not care where it was said. */
const stepText = (step: Step): string =>
  [step.run ?? '', JSON.stringify(step.with), JSON.stringify(step.env)].join('\n');

const violation = (
  rule: ViolationRule,
  file: string,
  location: string,
  message: string,
): Violation => ({ rule, file, location, message });

export const isAttestActionStep = (step: Step): boolean =>
  step.uses !== undefined && ATTEST_ACTIONS.includes(actionName(step.uses));

export const isAttestStep = (step: Step): boolean =>
  isAttestActionStep(step) || (step.run !== undefined && COSIGN_ATTEST.test(step.run));

export const isAttestationVerifyStep = (step: Step): boolean =>
  step.run !== undefined &&
  (GH_ATTESTATION_VERIFY.test(step.run) || COSIGN_VERIFY_ATTESTATION.test(step.run));

/**
 * Whether a workflow or job grants a write permission.
 *
 * A job's own `permissions:` replaces the workflow's rather than adding to it,
 * so an explicit job block that omits the scope is a refusal, not a fallthrough.
 */
export const grantsWrite = (document: unknown, job: Job, scope: string): boolean => {
  const check = (
    permissions: Record<string, unknown> | string | undefined,
  ): boolean | undefined => {
    if (permissions === undefined) return undefined;
    if (typeof permissions === 'string') return permissions === 'write-all';
    return permissions[scope] === 'write';
  };

  const workflowPermissions = asRecord(document)?.permissions;

  return (
    check(job.permissions) ??
    check(asRecord(workflowPermissions) ?? asString(workflowPermissions)) ??
    false
  );
};

/**
 * The variables a step can see. GitHub layers the workflow's `env:` under the
 * job's and the job's under the step's, and this has to do the same: resolving
 * through `step.env` alone reads `--predicate-type "$SLSA_PREDICATE_TYPE"` as
 * the literal string `$SLSA_PREDICATE_TYPE` and reports a workflow that pins
 * the type correctly as one that pins it to nonsense. Found by this tool
 * against the template in this repository.
 */
export const visibleEnv = (
  document: unknown,
  jobId: string,
  step: Step,
): Record<string, unknown> => {
  const jobs = asRecord(asRecord(document)?.jobs) ?? {};

  return {
    ...(asRecord(asRecord(document)?.env) ?? {}),
    ...(asRecord(asRecord(jobs[jobId])?.env) ?? {}),
    ...step.env,
  };
};

/**
 * The value a command-line flag was given, resolved through the environment
 * visible to the step when it is a variable reference — which is how a workflow
 * passes an input into a shell. Line continuations are collapsed first: these
 * commands are nearly always spread over several lines.
 */
export const flagValue = (
  step: Step,
  names: readonly string[],
  env: Record<string, unknown> = step.env,
): string | undefined => {
  const run = (step.run ?? '').replace(/\\\n\s*/g, ' ');

  for (const name of names) {
    const match = run.match(new RegExp(`${name}[\\s=]+("[^"]*"|'[^']*'|\\S+)`));
    if (match === null) continue;

    const raw = match[1].replace(/^["']|["']$/g, '');
    const variable = raw.match(/^\$\{?(\w+)\}?$/);
    if (variable === null) return raw;

    const bound = asString(env[variable[1]]);
    return bound ?? raw;
  }

  return undefined;
};

/** Whether a flag appears at all, regardless of what it was given. */
export const hasFlag = (step: Step, names: readonly string[]): boolean =>
  names.some((name) => new RegExp(`${name}[\\s=]`).test(step.run ?? ''));

/**
 * The subject a verification command names, as written. Line continuations are
 * collapsed first: these commands are nearly always spread over several lines,
 * and the subject is an argument of the joined command rather than of any one
 * line.
 *
 * The two verifiers put the subject in opposite places — `gh attestation
 * verify` takes it first and its flags after, `cosign verify-attestation` takes
 * it last, after the flags — so reading either as if it were the other finds a
 * flag value and calls it an image.
 */
export const verifiedSubject = (step: Step): string | undefined => {
  const run = (step.run ?? '').replace(/\\\n\s*/g, ' ');
  const unquote = (value: string): string => value.replace(/^["']|["']$/g, '');

  const gh = run.match(/gh\s+attestation\s+verify\s+("[^"]*"|'[^']*'|[^\s-]\S*)/);
  if (gh !== null) return unquote(gh[1]);

  // A trailing redirect is not the subject. Both of these commands are normally
  // written with their output captured or discarded.
  const cosign = run.match(
    /cosign\s+verify-attestation\b[^\n]*?\s("?[^"\s]+"?)(?:\s*\d?>>?\s*\S+)*\s*$/m,
  );
  return cosign === null ? undefined : unquote(cosign[1]);
};

/** Audit one `actions/attest*` step. */
const auditAttestAction = (
  workflow: WorkflowFile,
  document: unknown,
  job: Job,
  step: Step,
  lastPublishIndex: number,
): Violation[] => {
  const violations: Violation[] = [];
  const file = workflow.path;
  const where = `${job.id}#${step.name}`;

  const ref = step.uses === undefined ? undefined : actionRef(step.uses);
  if (ref === undefined || !/^[0-9a-f]{40}$/.test(ref)) {
    violations.push(
      violation(
        'attest-action-unpinned',
        file,
        where,
        `the attesting action is pinned to "${ref ?? '(no ref)'}", a tag that can be ` +
          'repointed. This action mints and signs the statement, so repointing it rewrites ' +
          'what provenance from this repository means for every image built afterwards. Pin ' +
          'it to a full commit SHA.',
      ),
    );
  }

  const pushesToRegistry = isTruthyInput(step.with['push-to-registry']);
  if (!pushesToRegistry) {
    violations.push(
      violation(
        'provenance-not-pushed-to-registry',
        file,
        where,
        'does not set `push-to-registry: true`, so the attestation exists only in GitHub\'s ' +
          'attestations API, keyed to the repository that built the image. Anything holding ' +
          'the image but not the repository — a registry replica, another account, an ' +
          'air-gapped pull — has only the digest to go on and no way to reach it. Push it to ' +
          'the registry, where it is an OCI referrer discoverable from that digest.',
      ),
    );
  } else if (step.index < lastPublishIndex) {
    violations.push(
      violation(
        'provenance-before-push',
        file,
        where,
        `the provenance is attached at step ${step.index + 1} and the image is pushed at step ` +
          `${lastPublishIndex + 1}. There is no manifest in the registry to attach a referrer ` +
          'to until the push completes. (Same ordering as the signature, and the opposite of ' +
          'the SBOM, which must precede the push so a bad inventory can stop the release.)',
      ),
    );
  }

  const subjectDigest = asString(step.with['subject-digest']);
  const subjectName = asString(step.with['subject-name']);

  if (subjectDigest === undefined) {
    violations.push(
      violation(
        'provenance-subject-not-digest',
        file,
        where,
        'names its subject with ' +
          `\`${isTruthyInput(step.with['subject-path']) ? 'subject-path' : 'no subject input'}\`` +
          ' rather than `subject-digest`. For a container image the subject has to be the ' +
          'digest the push returned: a path attests a file on the runner, which is signed, ' +
          'real, and about something nobody pulls.',
      ),
    );
  } else if (!isExpression(subjectDigest) && !/^sha256:[0-9a-f]{64}$/.test(subjectDigest)) {
    violations.push(
      violation(
        'provenance-subject-not-digest',
        file,
        where,
        `\`subject-digest: ${subjectDigest}\` is not a digest. It must be \`sha256:\` followed ` +
          'by 64 hex characters, or the expression carrying one.',
      ),
    );
  }

  if (subjectDigest !== undefined && subjectName === undefined) {
    violations.push(
      violation(
        'provenance-subject-not-digest',
        file,
        where,
        'gives a `subject-digest` with no `subject-name`. A digest alone does not say which ' +
          'repository it lives in, and pushing to the registry needs the fully qualified ' +
          'image name.',
      ),
    );
  } else if (
    subjectName !== undefined &&
    !isExpression(subjectName) &&
    /:[^/:]+$/.test(subjectName)
  ) {
    violations.push(
      violation(
        'provenance-subject-not-digest',
        file,
        where,
        `\`subject-name: ${subjectName}\` carries a tag. The subject name is the repository ` +
          'the digest lives in; a tag on it makes the push target a reference that is not the ' +
          'image.',
      ),
    );
  }

  const nonProvenance = NON_PROVENANCE_INPUTS.filter((input) => isTruthyInput(step.with[input]));
  if (nonProvenance.length > 0) {
    violations.push(
      violation(
        'attestation-not-provenance',
        file,
        where,
        `sets \`${nonProvenance.join('`, `')}\`, which switches the action out of provenance ` +
          'mode: it will attest an SBOM or a custom predicate instead. That signs, uploads ' +
          'and attaches identically, so every gate asking only whether an attestation exists ' +
          `is satisfied by it. Build provenance is \`${SLSA_PREDICATE_TYPE}\` and is what the ` +
          'action produces when none of these inputs is given.',
      ),
    );
  }

  if (!grantsWrite(document, job, 'attestations')) {
    violations.push(
      violation(
        'provenance-without-attestations-permission',
        file,
        where,
        'attests, but neither the workflow nor the job grants `attestations: write`. The ' +
          'action cannot persist the attestation, so this fails at run time — after the image ' +
          'has already been published, which is the half that cannot be taken back. A caller ' +
          'of a reusable workflow has to grant it too: the token is the intersection of both.',
      ),
    );
  }

  return violations;
};

/** Audit one `cosign attest` step. */
const auditCosignAttest = (
  workflow: WorkflowFile,
  document: unknown,
  job: Job,
  step: Step,
): Violation[] => {
  const type = flagValue(step, ['--type'], visibleEnv(document, job.id, step));
  if (type !== undefined && !isExpression(type) && !COSIGN_SLSA_TYPE.test(type)) {
    return [
      violation(
        'attestation-not-provenance',
        workflow.path,
        `${job.id}#${step.name}`,
        `attests predicate type "${type}", which is not build provenance. An attestation of ` +
          'any type satisfies a gate that only asks whether one exists; build provenance is ' +
          `\`${SLSA_PREDICATE_TYPE}\`.`,
      ),
    ];
  }

  return [];
};

/** Audit one step that verifies an attestation. */
const auditVerifyStep = (
  workflow: WorkflowFile,
  document: unknown,
  job: Job,
  step: Step,
): Violation[] => {
  const violations: Violation[] = [];
  const file = workflow.path;
  const where = `${job.id}#${step.name}`;
  const isGh = GH_ATTESTATION_VERIFY.test(step.run ?? '');
  const env = visibleEnv(document, job.id, step);

  const identity = flagValue(
    step,
    [
      '--cert-identity-regex',
      '--cert-identity',
      '--certificate-identity-regexp',
      '--certificate-identity',
    ],
    env,
  );

  if (identity !== undefined && !isExpression(identity) && CATCH_ALL_IDENTITY.test(identity)) {
    violations.push(
      violation(
        'provenance-verification-unpinned',
        file,
        where,
        `the certificate identity is "${identity}", which matches every signer — and passing ` +
          'it *replaces* the identity the repository scope would otherwise have derived, so ' +
          'this is weaker than omitting the flag. Anyone who can run a GitHub Actions ' +
          'workflow can produce an attestation that satisfies it, over an image of their own.',
      ),
    );
  }

  if (isGh && !hasFlag(step, ['--repo', '--owner'])) {
    violations.push(
      violation(
        'provenance-verification-unpinned',
        file,
        where,
        'verifies without `--repo` or `--owner`, so nothing scopes the attestation to a ' +
          'source. Those flags are what set the certificate policy `gh` enforces; without ' +
          'either, the policy it builds is about no repository in particular.',
      ),
    );
  }

  if (!isGh && !hasFlag(step, ['--certificate-oidc-issuer'])) {
    violations.push(
      violation(
        'provenance-verification-unpinned',
        file,
        where,
        'verifies without `--certificate-oidc-issuer`. An identity string is only evidence of ' +
          'who attested if the issuer that asserted it is pinned too — otherwise any issuer ' +
          'willing to mint that identity satisfies the check. (`gh attestation verify` ' +
          'defaults this to GitHub\'s issuer; `cosign verify-attestation` does not.)',
      ),
    );
  }

  const type = flagValue(step, ['--predicate-type', '--type'], env);
  if (
    type !== undefined &&
    !isExpression(type) &&
    type !== SLSA_PREDICATE_TYPE &&
    !COSIGN_SLSA_TYPE.test(type)
  ) {
    violations.push(
      violation(
        'provenance-verification-unpinned',
        file,
        where,
        `pins the predicate type to "${type}", which is not build provenance. The check then ` +
          'passes on an attestation of that other type and reports nothing about how the ' +
          'image was built.',
      ),
    );
  }

  const subject = verifiedSubject(step);
  if (subject !== undefined && !DIGEST_PINNED.test(subject)) {
    violations.push(
      violation(
        'verifies-mutable-subject',
        file,
        where,
        `verifies "${subject}", which is not pinned by digest. Resolving a tag to verify it ` +
          'and resolving it again to use it are two registry reads with a window between ' +
          'them, and only the second one runs.',
      ),
    );
  }

  return violations;
};

/** Audit one job that publishes a container image. */
const auditPublishingJob = (
  workflow: WorkflowFile,
  document: unknown,
  job: Job,
  published: readonly Step[],
  downstream: readonly Job[],
): Violation[] => {
  const file = workflow.path;
  const localAttestSteps = job.steps.filter(isAttestStep);
  const downstreamAttests = downstream.some((other) => other.steps.some(isAttestStep));

  if (localAttestSteps.length === 0 && !downstreamAttests) {
    return [
      violation(
        'image-published-without-provenance',
        file,
        job.id,
        `publishes a container image at "${published[0].name}" but neither this job nor any ` +
          'job downstream of it attests how it was built. The registry then holds an artifact ' +
          'whose source commit, build workflow and runner were never recorded anywhere, and ' +
          'the first time anyone needs them is the incident. Attest it with `actions/attest` ' +
          'over the pushed digest. See docs/provenance.md.',
      ),
    ];
  }

  const violations: Violation[] = [];
  const lastPublishIndex = Math.max(...published.map((step) => step.index));

  for (const step of localAttestSteps) {
    violations.push(
      ...(isAttestActionStep(step)
        ? auditAttestAction(workflow, document, job, step, lastPublishIndex)
        : auditCosignAttest(workflow, document, job, step)),
    );
  }

  if (localAttestSteps.length > 0 && !job.steps.some(isAttestationVerifyStep)) {
    violations.push(
      violation(
        'provenance-not-verified-at-build',
        file,
        `${job.id}#${localAttestSteps[0].name}`,
        'nothing in this job verifies the attestation it just made. A bundle that no ' +
          'consumer\'s policy can satisfy — the wrong signer identity, a push to the registry ' +
          'that did not land, an attestation that turned out not to be provenance — is ' +
          'indistinguishable from a good one here. Verify it with `gh attestation verify ' +
          '--bundle-from-oci`, which reads it back out of the registry rather than off the ' +
          'runner.',
      ),
    );
  }

  return violations;
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

    // Verification steps are judged wherever they are: a deploy that checks
    // provenance with a catch-all identity is worth auditing even though this
    // tool does not require it to check at all.
    for (const step of job.steps.filter(isAttestationVerifyStep)) {
      violations.push(...auditVerifyStep(workflow, workflow.document, job, step));
    }

    return violations;
  });
};

export const auditProvenance = (workflows: readonly WorkflowFile[]): Violation[] =>
  workflows.flatMap(auditWorkflow);

export const formatViolations = (violations: readonly Violation[]): string =>
  violations
    .map((v) => `${v.file}  ${v.location}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const workflows = readWorkflows(root);

  if (workflows.length === 0) {
    console.error(`No workflows found under ${root}.`);
    process.exit(1);
  }

  const violations = auditProvenance(workflows);

  if (violations.length > 0) {
    console.error(`\n${violations.length} provenance violation(s):\n`);
    console.error(formatViolations(violations));
    console.error('\nSee docs/provenance.md.\n');
    process.exit(1);
  }

  console.log(
    `${workflows.length} workflow(s) in ${root}: every image published carries SLSA build ` +
      'provenance over its pushed digest, and the run that attests it proves it verifies.',
  );
}
