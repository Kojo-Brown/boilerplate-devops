import * as path from 'path';
import { load } from 'js-yaml';
import { Step, WorkflowFile, actionName, parseJobs, readWorkflows } from '../tools/audit-image-signing';
import {
  SLSA_PREDICATE_TYPE,
  Violation,
  ViolationRule,
  auditProvenance,
  auditWorkflow,
  flagValue,
  formatViolations,
  grantsWrite,
  hasFlag,
  isAttestActionStep,
  isAttestStep,
  isAttestationVerifyStep,
  verifiedSubject,
  visibleEnv,
} from '../tools/audit-provenance';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The commit the shipped workflow pins the attesting action to. */
const PINNED_ATTEST = 'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6';

/** An identity a consumer may legitimately trust. */
const IDENTITY = '^https://github\\.com/acme/app/\\.github/workflows/build\\.yml@refs/heads/main$';

const rules = (violations: readonly Violation[]): ViolationRule[] => violations.map((v) => v.rule);

/** A workflow written the way a workflow is written, then parsed the way the tool parses one. */
const workflow = (filePath: string, yaml: string): WorkflowFile => ({
  path: filePath,
  document: load(yaml),
});

const step = (overrides: Partial<Step> = {}): Step => ({
  index: 0,
  name: 'step',
  with: {},
  env: {},
  ...overrides,
});

interface PublishOverrides {
  /** Drop the attestation step entirely. */
  readonly omitAttest?: boolean;
  /** Drop the attest-then-verify step. */
  readonly omitVerification?: boolean;
  /** Attest before the push rather than after it. */
  readonly attestBeforePush?: boolean;
  /** `uses:` for the attesting action. */
  readonly attestAction?: string;
  /** `with:` inputs on the attest step, replacing the conforming ones. */
  readonly attestInputs?: string;
  /** Workflow-level `permissions:` block, already indented. */
  readonly permissions?: string;
  /** The identity the verification pins to. */
  readonly identity?: string;
  /** Extra flags on the verify command; replaces `--repo` when given. */
  readonly verifyScope?: string;
  /** What the verification is pointed at. Defaults to the pushed digest. */
  readonly verifiedSubject?: string;
  /** Move the attestation into a second job that `needs` this one. */
  readonly attestDownstream?: boolean;
}

const CONFORMING_INPUTS = `          subject-name: \${{ steps.build.outputs.image-repository }}
          subject-digest: \${{ steps.push.outputs.image-digest }}
          push-to-registry: true`;

/**
 * A conforming publish pipeline: pushed, then attested over the digest the push
 * returned, then verified back out of the registry against a pinned identity
 * and predicate type, with `attestations: write` granted and the action pinned
 * to a commit. Individual tests dislodge one thing at a time so a failure names
 * its cause.
 */
const publishWorkflow = (overrides: PublishOverrides = {}): WorkflowFile => {
  const attest = overrides.omitAttest
    ? ''
    : `      - name: Attest build provenance
        id: provenance
        uses: ${overrides.attestAction ?? PINNED_ATTEST}
        with:
${overrides.attestInputs ?? CONFORMING_INPUTS}
`;

  const push = `      - name: Push image
        id: push
        run: |
          docker push "$IMAGE_URI"
`;

  const verify = overrides.omitVerification
    ? ''
    : `      - name: Verify the provenance this run just made
        env:
          IMAGE_REF: \${{ steps.push.outputs.image-ref }}
        run: |
          gh attestation verify "oci://${overrides.verifiedSubject ?? '$IMAGE_REF'}" \\
            --bundle-from-oci \\
            ${overrides.verifyScope ?? '--repo "$GITHUB_REPOSITORY"'} \\
            --cert-identity-regex "${overrides.identity ?? IDENTITY}" \\
            --predicate-type "$SLSA_PREDICATE_TYPE"
`;

  const downstream = overrides.attestDownstream
    ? `  attest:
    needs: build-push
    runs-on: ubuntu-latest
    steps:
${attest}`
    : '';

  return workflow(
    'workflow-templates/docker-build-push.yml',
    `
name: Docker Build & Push
on:
  workflow_call:
${overrides.permissions ?? 'permissions:\n  id-token: write\n  contents: read\n  attestations: write'}
env:
  SLSA_PREDICATE_TYPE: ${SLSA_PREDICATE_TYPE}
jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - name: Build image
        id: build
        run: docker build -t "$IMAGE_URI" .
${overrides.attestBeforePush ? attest + push : push + (overrides.attestDownstream ? '' : attest)}${overrides.attestDownstream ? '' : verify}
${downstream}`,
  );
};

describe('recognising the steps', () => {
  it('recognises both attesting actions and cosign attest', () => {
    expect(isAttestActionStep(step({ uses: PINNED_ATTEST }))).toBe(true);
    expect(isAttestActionStep(step({ uses: 'actions/attest-build-provenance@v4' }))).toBe(true);
    expect(isAttestActionStep(step({ run: 'cosign attest --yes app@sha256:abc' }))).toBe(false);

    expect(isAttestStep(step({ run: 'cosign attest --yes app@sha256:abc' }))).toBe(true);
    expect(isAttestStep(step({ uses: PINNED_ATTEST }))).toBe(true);
    expect(isAttestStep(step({ run: 'cosign sign --yes app@sha256:abc' }))).toBe(false);
  });

  // `cosign attest-blob` signs a file, not an image, and is a different claim.
  it('does not read attest-blob as attesting an image', () => {
    expect(isAttestStep(step({ run: 'cosign attest-blob --yes bundle.tgz' }))).toBe(false);
  });

  it('recognises both verifiers', () => {
    expect(isAttestationVerifyStep(step({ run: 'gh attestation verify oci://app@sha256:abc' }))).toBe(
      true,
    );
    expect(
      isAttestationVerifyStep(step({ run: 'cosign verify-attestation --type slsaprovenance app' })),
    ).toBe(true);
    expect(isAttestationVerifyStep(step({ run: 'cosign verify app' }))).toBe(false);
  });
});

describe('reading flags and subjects', () => {
  it('resolves a flag through the environment the step can see', () => {
    const document = load(`
env:
  SLSA_PREDICATE_TYPE: ${SLSA_PREDICATE_TYPE}
jobs:
  build:
    env:
      IDENTITY: from-the-job
    steps: []
`);
    const verify = step({
      run: 'gh attestation verify oci://app --predicate-type "$SLSA_PREDICATE_TYPE" --cert-identity-regex "$IDENTITY"',
      env: {},
    });
    const env = visibleEnv(document, 'build', verify);

    expect(flagValue(verify, ['--predicate-type'], env)).toBe(SLSA_PREDICATE_TYPE);
    expect(flagValue(verify, ['--cert-identity-regex'], env)).toBe('from-the-job');
  });

  it('lets a step-level value win over the job and workflow ones', () => {
    const document = load(`
env:
  IDENTITY: from-the-workflow
jobs:
  build:
    env:
      IDENTITY: from-the-job
    steps: []
`);
    const verify = step({ env: { IDENTITY: 'from-the-step' } });

    expect(visibleEnv(document, 'build', verify).IDENTITY).toBe('from-the-step');
  });

  it('reads a flag across the line continuations these commands are written with', () => {
    const verify = step({
      run: 'gh attestation verify oci://app \\\n  --repo acme/app \\\n  --cert-identity-regex ".*"',
    });

    expect(flagValue(verify, ['--cert-identity-regex'])).toBe('.*');
    expect(hasFlag(verify, ['--repo', '--owner'])).toBe(true);
    expect(hasFlag(verify, ['--owner'])).toBe(false);
  });

  // The two verifiers put the subject in opposite places: `gh` takes it first
  // and its flags after, cosign takes it last, after the flags.
  it('reads the subject a verification names, not the flags around it', () => {
    expect(
      verifiedSubject(step({ run: 'gh attestation verify "oci://$IMAGE_REF" --repo acme/app' })),
    ).toBe('oci://$IMAGE_REF');
    expect(
      verifiedSubject(step({ run: 'cosign verify-attestation --type slsaprovenance app@sha256:abc' })),
    ).toBe('app@sha256:abc');
  });

  it('does not read a redirect as the subject', () => {
    expect(
      verifiedSubject(
        step({
          run: 'cosign verify-attestation \\\n  --type slsaprovenance1 \\\n  "$IMAGE_REF" > out.json',
        }),
      ),
    ).toBe('$IMAGE_REF');
  });

  it('has nothing to say about a step that verifies nothing', () => {
    expect(verifiedSubject(step({ run: 'echo hello' }))).toBeUndefined();
  });
});

describe('grantsWrite', () => {
  const job = (permissions?: Record<string, unknown> | string) => ({
    id: 'build',
    needs: [],
    permissions,
    steps: [],
  });

  it('reads a workflow-level grant', () => {
    const document = load('permissions:\n  attestations: write\njobs: {}');

    expect(grantsWrite(document, job(), 'attestations')).toBe(true);
    expect(grantsWrite(document, job(), 'id-token')).toBe(false);
  });

  // A job's own block replaces the workflow's rather than adding to it, so an
  // explicit block that omits the scope is a refusal.
  it('lets a job-level block take the grant away', () => {
    const document = load('permissions:\n  attestations: write\njobs: {}');

    expect(grantsWrite(document, job({ 'contents': 'read' }), 'attestations')).toBe(false);
    expect(grantsWrite(document, job({ 'attestations': 'write' }), 'attestations')).toBe(true);
  });

  it('accepts write-all', () => {
    expect(grantsWrite(load('jobs: {}'), job('write-all'), 'attestations')).toBe(true);
    expect(grantsWrite(load('jobs: {}'), job('read-all'), 'attestations')).toBe(false);
  });
});

describe('a publishing job', () => {
  it('passes when it attests the pushed digest and verifies what it made', () => {
    expect(auditWorkflow(publishWorkflow())).toEqual([]);
  });

  it('reports an image published with no attestation at all', () => {
    expect(rules(auditWorkflow(publishWorkflow({ omitAttest: true })))).toEqual([
      'image-published-without-provenance',
    ]);
  });

  // The build and the attestation are often split across jobs so the second can
  // run with narrower permissions.
  it('accepts an attestation made by a job downstream of the publish', () => {
    const violations = auditWorkflow(publishWorkflow({ attestDownstream: true }));

    expect(rules(violations)).not.toContain('image-published-without-provenance');
  });

  it('reports an attestation attached before the push', () => {
    expect(rules(auditWorkflow(publishWorkflow({ attestBeforePush: true })))).toContain(
      'provenance-before-push',
    );
  });

  it('reports an attestation that never reaches the registry', () => {
    const violations = auditWorkflow(
      publishWorkflow({
        attestInputs: `          subject-name: \${{ steps.build.outputs.image-repository }}
          subject-digest: \${{ steps.push.outputs.image-digest }}`,
      }),
    );

    expect(rules(violations)).toEqual(['provenance-not-pushed-to-registry']);
  });

  it('does not read push-to-registry: false as pushing', () => {
    const violations = auditWorkflow(
      publishWorkflow({
        attestInputs: `${CONFORMING_INPUTS.replace('push-to-registry: true', 'push-to-registry: false')}`,
      }),
    );

    expect(rules(violations)).toEqual(['provenance-not-pushed-to-registry']);
  });

  it('reports a subject that is a path on the runner rather than the pushed digest', () => {
    const violations = auditWorkflow(
      publishWorkflow({
        attestInputs: `          subject-path: dist/app.tar
          push-to-registry: true`,
      }),
    );

    expect(rules(violations)).toEqual(['provenance-subject-not-digest']);
    expect(violations[0].message).toContain('subject-path');
  });

  it('reports a subject-digest that is not a digest', () => {
    const violations = auditWorkflow(
      publishWorkflow({
        attestInputs: `          subject-name: app
          subject-digest: latest
          push-to-registry: true`,
      }),
    );

    expect(rules(violations)).toEqual(['provenance-subject-not-digest']);
  });

  it('reports a digest with no repository to look it up in', () => {
    const violations = auditWorkflow(
      publishWorkflow({
        attestInputs: `          subject-digest: \${{ steps.push.outputs.image-digest }}
          push-to-registry: true`,
      }),
    );

    expect(rules(violations)).toEqual(['provenance-subject-not-digest']);
    expect(violations[0].message).toContain('subject-name');
  });

  it('reports a tag on the subject name', () => {
    const violations = auditWorkflow(
      publishWorkflow({
        attestInputs: `          subject-name: 1234.dkr.ecr.us-east-1.amazonaws.com/app:latest
          subject-digest: \${{ steps.push.outputs.image-digest }}
          push-to-registry: true`,
      }),
    );

    expect(rules(violations)).toEqual(['provenance-subject-not-digest']);
  });

  it('accepts a registry host with a port in the subject name', () => {
    const violations = auditWorkflow(
      publishWorkflow({
        attestInputs: `          subject-name: registry.internal:5000/app
          subject-digest: \${{ steps.push.outputs.image-digest }}
          push-to-registry: true`,
      }),
    );

    expect(violations).toEqual([]);
  });

  // Every one of these signs, uploads and attaches exactly like provenance.
  it.each(['sbom-path: sbom.cdx.json', 'predicate-type: https://example.com/x/v1'])(
    'reports an attestation that is not provenance (%s)',
    (input) => {
      const violations = auditWorkflow(
        publishWorkflow({ attestInputs: `${CONFORMING_INPUTS}\n          ${input}` }),
      );

      expect(rules(violations)).toEqual(['attestation-not-provenance']);
    },
  );

  it('reports a cosign attest of some other predicate type', () => {
    const violations = auditWorkflow(
      workflow(
        'workflow-templates/build.yml',
        `
name: Build
on: push
permissions:
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Push image
        run: docker push "$IMAGE_URI"
      - name: Attest
        run: cosign attest --yes --type vuln --predicate scan.json "$IMAGE_REF"
      - name: Verify
        run: cosign verify-attestation --type vuln --certificate-identity-regexp "${IDENTITY}" --certificate-oidc-issuer https://token.actions.githubusercontent.com "$IMAGE_REF"
`,
      ),
    );

    expect(rules(violations)).toEqual([
      'attestation-not-provenance',
      'provenance-verification-unpinned',
    ]);
  });

  it('accepts a cosign attest of SLSA provenance', () => {
    const violations = auditWorkflow(
      workflow(
        'workflow-templates/build.yml',
        `
name: Build
on: push
permissions:
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Push image
        run: docker push "$IMAGE_URI"
      - name: Attest
        run: cosign attest --yes --type slsaprovenance1 --predicate p.json "$IMAGE_REF"
      - name: Verify
        run: cosign verify-attestation --type slsaprovenance1 --certificate-identity-regexp "${IDENTITY}" --certificate-oidc-issuer https://token.actions.githubusercontent.com "$IMAGE_REF"
`,
      ),
    );

    expect(violations).toEqual([]);
  });

  it('reports an attesting job that cannot persist what it attests', () => {
    const violations = auditWorkflow(
      publishWorkflow({ permissions: 'permissions:\n  id-token: write\n  contents: read' }),
    );

    expect(rules(violations)).toEqual(['provenance-without-attestations-permission']);
  });

  it('reports an attestation the run never verifies', () => {
    expect(rules(auditWorkflow(publishWorkflow({ omitVerification: true })))).toEqual([
      'provenance-not-verified-at-build',
    ]);
  });

  it('reports an attesting action floating on a tag', () => {
    const violations = auditWorkflow(
      publishWorkflow({ attestAction: 'actions/attest-build-provenance@v4' }),
    );

    expect(rules(violations)).toEqual(['attest-action-unpinned']);
  });

  it('reports an attesting action with no ref at all', () => {
    expect(rules(auditWorkflow(publishWorkflow({ attestAction: 'actions/attest' })))).toEqual([
      'attest-action-unpinned',
    ]);
  });
});

describe('a verification', () => {
  it('reports an identity that matches every signer', () => {
    const violations = auditWorkflow(publishWorkflow({ identity: '.*' }));

    expect(rules(violations)).toEqual(['provenance-verification-unpinned']);
    expect(violations[0].message).toContain('replaces');
  });

  it('reports a verification scoped to no repository', () => {
    const violations = auditWorkflow(publishWorkflow({ verifyScope: '--bundle bundle.json' }));

    expect(rules(violations)).toEqual(['provenance-verification-unpinned']);
  });

  it('accepts an organisation scope', () => {
    expect(auditWorkflow(publishWorkflow({ verifyScope: '--owner acme' }))).toEqual([]);
  });

  it('reports a predicate type that is not build provenance', () => {
    const violations = auditWorkflow(
      workflow(
        'workflow-templates/deploy.yml',
        `
name: Deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Verify
        run: |
          gh attestation verify "oci://$IMAGE_REF" --repo acme/app \\
            --predicate-type https://spdx.dev/Document
`,
      ),
    );

    expect(rules(violations)).toEqual(['provenance-verification-unpinned']);
  });

  it('reports a verification of a tag', () => {
    const violations = auditWorkflow(publishWorkflow({ verifiedSubject: 'app:latest' }));

    expect(rules(violations)).toEqual(['verifies-mutable-subject']);
  });

  // cosign has no default issuer, so omitting it there accepts any issuer
  // willing to mint the identity. `gh` defaults to GitHub's.
  it('reports a cosign verification with no issuer pinned', () => {
    const violations = auditWorkflow(
      workflow(
        'workflow-templates/deploy.yml',
        `
name: Deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Verify
        run: cosign verify-attestation --type slsaprovenance1 --certificate-identity-regexp "${IDENTITY}" "$IMAGE_REF"
`,
      ),
    );

    expect(rules(violations)).toEqual(['provenance-verification-unpinned']);
  });

  it('leaves an expression for the caller of the workflow to answer for', () => {
    expect(auditWorkflow(publishWorkflow({ identity: '${{ inputs.signer-identity-regexp }}' }))).toEqual(
      [],
    );
  });
});

describe('reporting', () => {
  it('formats a violation with its file, location, and rule', () => {
    const formatted = formatViolations(auditWorkflow(publishWorkflow({ omitAttest: true })));

    expect(formatted).toContain('workflow-templates/docker-build-push.yml');
    expect(formatted).toContain('[image-published-without-provenance]');
  });

  it('returns an empty string when there is nothing to report', () => {
    expect(formatViolations([])).toBe('');
  });

  it('ignores a workflow that publishes nothing', () => {
    expect(
      auditWorkflow(
        workflow(
          '.github/workflows/ci.yml',
          `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
        ),
      ),
    ).toEqual([]);
  });
});

describe('the workflows this repository ships', () => {
  const workflows = readWorkflows(REPO_ROOT);

  it('attests every image it publishes and verifies what it attested', () => {
    expect(formatViolations(auditProvenance(workflows))).toBe('');
  });

  // Without this the suite above could pass on a repository where nothing is
  // classified as attesting at all — a gate that sees nothing reports nothing.
  it('still recognises the attestation path the gate exists for', () => {
    const build = parseJobs(
      workflows.find((w) => w.path === 'workflow-templates/docker-build-push.yml')?.document,
    );

    expect(build.some((job) => job.steps.some(isAttestStep))).toBe(true);
    expect(build.some((job) => job.steps.some(isAttestationVerifyStep))).toBe(true);
  });

  it('pins the attesting action to one commit everywhere it is used', () => {
    const used = workflows.flatMap((w) =>
      parseJobs(w.document).flatMap((job) =>
        job.steps.flatMap((s) =>
          s.uses !== undefined && actionName(s.uses).startsWith('actions/attest') ? [s.uses] : [],
        ),
      ),
    );

    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used)).toEqual(new Set([PINNED_ATTEST]));
  });

  // The gate has to fail on the tree it was written against, or it is only
  // asserting that today's workflows are today's workflows.
  it('reports the gap it was written to close', () => {
    const before = workflow(
      'workflow-templates/docker-build-push.yml',
      `
name: Docker Build & Push
on:
  workflow_call:
permissions:
  id-token: write
  contents: read
jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - name: Build image
        run: docker build -t "$IMAGE_URI" .
      - name: Push image
        run: docker push "$IMAGE_URI"
      - name: Sign the image
        run: cosign sign --yes "$IMAGE_REF"
`,
    );

    expect(rules(auditWorkflow(before))).toEqual(['image-published-without-provenance']);
  });
});
