import * as path from 'path';
import { load } from 'js-yaml';
import {
  CATCH_ALL_IDENTITY,
  GITHUB_OIDC_ISSUER,
  Step,
  Violation,
  ViolationRule,
  WorkflowFile,
  actionName,
  actionRef,
  auditImageSigning,
  auditWorkflow,
  deployStepsInJob,
  downstreamJobs,
  formatViolations,
  grantsIdToken,
  isPublishStep,
  isSignStep,
  isVerifyStep,
  namesImage,
  parseJobs,
  readWorkflows,
  signedReference,
  verificationFlags,
} from '../tools/audit-image-signing';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The commit the shipped workflows pin the cosign installer to. */
const PINNED_INSTALLER = 'sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6';

/** An identity a deploy may legitimately trust. */
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

/** `release: null` omits the `with:` block entirely, leaving the binary floating. */
const cosignInstall = (uses: string = PINNED_INSTALLER, release: string | null = 'v3.0.6'): string =>
  `      - name: Install cosign
        uses: ${uses}${release === null ? '' : `\n        with:\n          cosign-release: ${release}`}`;

interface PublishOverrides {
  /** Drop the `cosign sign` step entirely. */
  readonly omitSigning?: boolean;
  /** Drop the sign-then-verify step. */
  readonly omitVerification?: boolean;
  /** Sign before the push rather than after it. */
  readonly signBeforePush?: boolean;
  /** What `cosign sign` is pointed at. Defaults to the pushed digest. */
  readonly signedReference?: string;
  /** Extra flags on the signing command, e.g. `--key`. */
  readonly signFlags?: string;
  /** Workflow-level `permissions:` block, already indented. */
  readonly permissions?: string;
  /** `uses:` for the cosign installer. */
  readonly installer?: string;
  /** `cosign-release:` input; `null` omits the whole `with:` block. */
  readonly cosignRelease?: string | null;
}

/**
 * A conforming publish pipeline: pushed, then signed over the digest the push
 * returned, then verified against a pinned identity, with cosign pinned and
 * `id-token: write` granted. Individual tests dislodge one thing at a time so a
 * failure names its cause.
 */
const publishWorkflow = (overrides: PublishOverrides = {}): WorkflowFile => {
  const sign = overrides.omitSigning
    ? ''
    : `      - name: Sign the image
        env:
          IMAGE_REF: \${{ steps.push.outputs.image-ref }}
        run: |
          cosign sign --yes ${overrides.signFlags ?? ''}"${overrides.signedReference ?? '$IMAGE_REF'}"
`;

  const push = `      - name: Push image
        id: push
        run: |
          docker push "$IMAGE_URI"
`;

  const verify = overrides.omitVerification
    ? ''
    : `      - name: Verify the signature this run just made
        env:
          IMAGE_REF: \${{ steps.push.outputs.image-ref }}
        run: |
          cosign verify \\
            --certificate-identity-regexp "${IDENTITY}" \\
            --certificate-oidc-issuer ${GITHUB_OIDC_ISSUER} \\
            "$IMAGE_REF"
`;

  return workflow(
    'workflow-templates/docker-build-push.yml',
    `
name: Docker Build & Push
on:
  workflow_call:
${overrides.permissions ?? 'permissions:\n  id-token: write\n  contents: read'}
jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - name: Build image
        run: docker build -t "$IMAGE_URI" .
${overrides.signBeforePush ? sign + push : push + sign}${cosignInstall(overrides.installer, overrides.cosignRelease === undefined ? 'v3.0.6' : overrides.cosignRelease)}
${verify}`,
  );
};

interface DeployOverrides {
  /** Drop the verification step. */
  readonly omitVerification?: boolean;
  /** Identity the verification pins to. */
  readonly identity?: string;
  /** Flag used to pass the identity. */
  readonly identityFlag?: string;
  /** Issuer the verification pins to; `null` omits the flag. */
  readonly issuer?: string | null;
  /** What the deploy step is pointed at. Defaults to the verified digest. */
  readonly deployedReference?: string;
  /** `uses:` for the cosign installer. */
  readonly installer?: string;
}

/**
 * A conforming deploy: verify against a pinned identity and issuer, then deploy
 * the digest the verification resolved.
 */
const deployWorkflow = (overrides: DeployOverrides = {}): WorkflowFile => {
  const issuer =
    overrides.issuer === null
      ? ''
      : `\n            --certificate-oidc-issuer "${overrides.issuer ?? GITHUB_OIDC_ISSUER}" \\`;

  const verify = overrides.omitVerification
    ? ''
    : `      - name: Verify the image signature
        id: verify
        env:
          IMAGE_URI: \${{ inputs.image-uri }}
        run: |
          cosign verify \\
            ${overrides.identityFlag ?? '--certificate-identity-regexp'} "${overrides.identity ?? IDENTITY}" \\${issuer}
            "$IMAGE_REF"
          echo "image-ref=$IMAGE_REF" >> "$GITHUB_OUTPUT"
`;

  return workflow(
    'workflow-templates/deploy-ecs.yml',
    `
name: Deploy to ECS
on:
  workflow_call:
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
${cosignInstall(overrides.installer)}
${verify}      - name: Update image in task definition
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-definition.json
          container-name: app
          image: \${{ ${overrides.deployedReference ?? 'steps.verify.outputs.image-ref'} }}

      - name: Deploy to ECS
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: \${{ steps.task-def.outputs.task-definition }}
          service: app
          cluster: app
`,
  );
};

describe('parseJobs', () => {
  it('reads steps, needs, and job-level permissions', () => {
    const jobs = parseJobs(
      load(`
jobs:
  build:
    steps:
      - name: One
        run: echo one
  deploy:
    needs: build
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
`),
    );

    expect(jobs.map((job) => job.id)).toEqual(['build', 'deploy']);
    expect(jobs[0].steps[0]).toMatchObject({ index: 0, name: 'One', run: 'echo one' });
    expect(jobs[1].needs).toEqual(['build']);
    expect(jobs[1].permissions).toEqual({ 'id-token': 'write' });
  });

  it('accepts a list of needs and a scalar permissions value', () => {
    const jobs = parseJobs(
      load(`
jobs:
  deploy:
    needs: [build, test]
    permissions: write-all
    steps: []
`),
    );

    expect(jobs[0].needs).toEqual(['build', 'test']);
    expect(jobs[0].permissions).toBe('write-all');
  });

  it('names an unnamed step by its action, its id, or its position', () => {
    const jobs = parseJobs(
      load(`
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - id: push
        run: docker push image
      - run: echo anonymous
`),
    );

    expect(jobs[0].steps.map((s) => s.name)).toEqual([
      'actions/checkout@v4',
      'push',
      'step 3',
    ]);
  });

  it('survives documents that are not workflows', () => {
    expect(parseJobs(undefined)).toEqual([]);
    expect(parseJobs('a string')).toEqual([]);
    expect(parseJobs(load('jobs:\n  build: null\n'))).toEqual([]);
    expect(parseJobs(load('jobs:\n  build:\n    steps: not-a-list\n'))[0].steps).toEqual([]);
  });
});

describe('step classification', () => {
  it('recognises the ways an image is published', () => {
    expect(isPublishStep(step({ run: 'docker push "$IMAGE_URI"' }))).toBe(true);
    expect(isPublishStep(step({ run: 'docker buildx build -t x --push .' }))).toBe(true);
    expect(isPublishStep(step({ run: 'oras push registry/repo:tag file' }))).toBe(true);
    expect(
      isPublishStep(step({ uses: 'docker/build-push-action@v6', with: { push: true } })),
    ).toBe(true);
  });

  it('does not treat a local build as a release', () => {
    expect(isPublishStep(step({ run: 'docker build -t app .' }))).toBe(false);
    expect(
      isPublishStep(step({ uses: 'docker/build-push-action@v6', with: { push: false } })),
    ).toBe(false);
    expect(isPublishStep(step({ uses: 'actions/checkout@v4' }))).toBe(false);
  });

  it('recognises signing and verification, and ignores their blob variants', () => {
    expect(isSignStep(step({ run: 'cosign sign --yes "$IMAGE_REF"' }))).toBe(true);
    expect(isSignStep(step({ run: 'cosign sign-blob --yes bundle.tar' }))).toBe(false);
    expect(isVerifyStep(step({ run: 'cosign verify --certificate-identity x ref' }))).toBe(true);
    expect(isVerifyStep(step({ run: 'cosign verify-blob --bundle b sig' }))).toBe(false);
    expect(isVerifyStep(step({ run: 'echo cosign' }))).toBe(false);
  });

  it('treats a step as naming an image only when it says so', () => {
    expect(namesImage(step({ env: { IMAGE_URI: 'x' } }))).toBe(true);
    expect(namesImage(step({ with: { image: '${{ inputs.image-uri }}' } }))).toBe(true);
    expect(namesImage(step({ run: 'cdk deploy --context previewImageUri=$IMAGE_URI' }))).toBe(true);
    expect(namesImage(step({ run: 'aws ecs update-service --force-new-deployment' }))).toBe(false);
  });
});

describe('deployStepsInJob', () => {
  const job = (yaml: string) => parseJobs(load(`jobs:\n  deploy:\n${yaml}`))[0];

  it('finds the step that puts a named image into a runtime', () => {
    const found = deployStepsInJob(
      job(`    steps:
      - uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          image: \${{ inputs.image-uri }}`),
    );

    expect(found.map((s) => s.name)).toEqual([
      'aws-actions/amazon-ecs-render-task-definition@v1',
    ]);
  });

  it('finds kubectl, helm, and cdk deploys', () => {
    const shapes = [
      'kubectl set image deployment/app app=$IMAGE_URI',
      'helm upgrade app ./chart --set image=$IMAGE_URI',
      'cdk deploy --context previewImageUri="$IMAGE_URI"',
    ];

    for (const run of shapes) {
      expect(
        deployStepsInJob(job(`    steps:\n      - name: Deploy\n        run: ${run}`)),
      ).toHaveLength(1);
    }
  });

  it('exempts a rollback, which redeploys a task definition and names no image', () => {
    const rollback = job(`    steps:
      - name: Roll back
        run: |
          aws ecs update-service --cluster app --service app --task-definition "$PREVIOUS"`);

    expect(deployStepsInJob(rollback)).toEqual([]);
  });

  it('exempts a job that names an image but deploys nothing', () => {
    const scan = job(`    steps:
      - name: Scan
        env:
          IMAGE_URI: \${{ inputs.image-uri }}
        run: trivy image "$IMAGE_URI"`);

    expect(deployStepsInJob(scan)).toEqual([]);
  });
});

describe('signedReference', () => {
  it('reads the reference off the signing command', () => {
    expect(signedReference(step({ run: 'cosign sign --yes "$IMAGE_REF"' }))).toBe('$IMAGE_REF');
    expect(signedReference(step({ run: 'cosign sign --yes registry/app:v1' }))).toBe(
      'registry/app:v1',
    );
    expect(
      signedReference(step({ run: 'cosign sign --yes registry/app@sha256:abc' })),
    ).toBe('registry/app@sha256:abc');
  });

  it('follows a line continuation to the reference at the end', () => {
    expect(
      signedReference(
        step({ run: 'cosign sign \\\n  --yes \\\n  "$IMAGE_REF"' }),
      ),
    ).toBe('$IMAGE_REF');
  });
});

describe('verificationFlags', () => {
  it('reads a literal identity and issuer', () => {
    expect(
      verificationFlags(
        step({
          run: `cosign verify --certificate-identity-regexp "${IDENTITY}" --certificate-oidc-issuer ${GITHUB_OIDC_ISSUER} ref`,
        }),
      ),
    ).toEqual({ identity: IDENTITY, issuer: GITHUB_OIDC_ISSUER });
  });

  it('resolves a flag passed through the step environment', () => {
    const flags = verificationFlags(
      step({
        run: 'cosign verify --certificate-identity-regexp "$IDENTITY_REGEXP" --certificate-oidc-issuer "$OIDC_ISSUER" ref',
        env: { IDENTITY_REGEXP: '.*', OIDC_ISSUER: GITHUB_OIDC_ISSUER },
      }),
    );

    expect(flags).toEqual({ identity: '.*', issuer: GITHUB_OIDC_ISSUER });
  });

  it('keeps the variable when nothing in the step binds it', () => {
    expect(
      verificationFlags(step({ run: 'cosign verify --certificate-identity "$WHO" ref' })).identity,
    ).toBe('$WHO');
  });

  it('accepts the exact-match and regexp spellings of both flags', () => {
    expect(
      verificationFlags(
        step({
          run: "cosign verify --certificate-identity 'me@example.test' --certificate-oidc-issuer-regexp '^https://token\\.actions\\.githubusercontent\\.com$' ref",
        }),
      ),
    ).toEqual({
      identity: 'me@example.test',
      issuer: '^https://token\\.actions\\.githubusercontent\\.com$',
    });
  });

  it('reports a missing flag as undefined rather than guessing', () => {
    expect(verificationFlags(step({ run: 'cosign verify ref' }))).toEqual({
      identity: undefined,
      issuer: undefined,
    });
  });
});

describe('CATCH_ALL_IDENTITY', () => {
  it('matches the patterns that accept every signer', () => {
    for (const pattern of ['.*', '.+', '^.*', '^.+', '.*$', '^.*$', '^.+$']) {
      expect(CATCH_ALL_IDENTITY.test(pattern)).toBe(true);
    }
  });

  it('does not match a pattern that names a repository', () => {
    for (const pattern of [IDENTITY, '^https://github\\.com/acme/', 'me@example.test']) {
      expect(CATCH_ALL_IDENTITY.test(pattern)).toBe(false);
    }
  });
});

describe('grantsIdToken', () => {
  const jobOf = (yaml: string) => {
    const document = load(yaml);
    return { document, job: parseJobs(document)[0] };
  };

  it('accepts a workflow-level grant', () => {
    const { document, job } = jobOf(`
permissions:
  id-token: write
jobs:
  build:
    steps: []
`);
    expect(grantsIdToken(document, job)).toBe(true);
  });

  it('accepts write-all', () => {
    const { document, job } = jobOf(`
permissions: write-all
jobs:
  build:
    steps: []
`);
    expect(grantsIdToken(document, job)).toBe(true);
  });

  it('treats a job block that omits id-token as a refusal, not an addition', () => {
    // GitHub replaces the workflow's permissions with the job's rather than
    // merging them, so this job cannot request an OIDC token.
    const { document, job } = jobOf(`
permissions:
  id-token: write
jobs:
  build:
    permissions:
      contents: read
    steps: []
`);
    expect(grantsIdToken(document, job)).toBe(false);
  });

  it('reports no grant when nothing declares one', () => {
    const { document, job } = jobOf('jobs:\n  build:\n    steps: []\n');
    expect(grantsIdToken(document, job)).toBe(false);
  });
});

describe('publishing rules', () => {
  it('passes a pipeline that pushes, signs the digest, and verifies', () => {
    expect(auditWorkflow(publishWorkflow())).toEqual([]);
  });

  it('reports an image published with no signature at all', () => {
    const violations = auditWorkflow(publishWorkflow({ omitSigning: true }));

    expect(rules(violations)).toEqual(['image-published-without-signature']);
    expect(violations[0].location).toBe('build-push');
    expect(violations[0].message).toContain('Push image');
  });

  it('accepts a signature made by a downstream job', () => {
    const split = workflow(
      'workflow-templates/split.yml',
      `
name: Split
permissions:
  id-token: write
on:
  workflow_call:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Push
        run: docker push "$IMAGE_URI"
  sign:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Sign
        run: cosign sign --yes "$IMAGE_REF"
      - name: Verify
        run: cosign verify --certificate-identity-regexp "${IDENTITY}" --certificate-oidc-issuer ${GITHUB_OIDC_ISSUER} "$IMAGE_REF"
`,
    );

    expect(auditWorkflow(split)).toEqual([]);
  });

  it('reports signing that runs before the push', () => {
    const violations = auditWorkflow(publishWorkflow({ signBeforePush: true }));

    expect(rules(violations)).toContain('signature-before-push');
    expect(violations[0].message).toContain('no manifest in the registry');
  });

  it('reports a signature made over a tag', () => {
    const violations = auditWorkflow(
      publishWorkflow({ signedReference: 'registry/app:latest' }),
    );

    expect(rules(violations)).toEqual(['signs-mutable-tag']);
    expect(violations[0].message).toContain('registry/app:latest');
  });

  it('accepts a digest, or a variable that holds one', () => {
    for (const reference of ['registry/app@sha256:abc', '$IMAGE_REF', '${DIGEST}']) {
      expect(auditWorkflow(publishWorkflow({ signedReference: reference }))).toEqual([]);
    }
  });

  it('reports a signature nothing verifies before the image ships', () => {
    const violations = auditWorkflow(publishWorkflow({ omitVerification: true }));

    expect(rules(violations)).toEqual(['signature-not-verified-at-build']);
  });

  it('reports keyless signing in a workflow that cannot get an OIDC token', () => {
    const violations = auditWorkflow(
      publishWorkflow({ permissions: 'permissions:\n  contents: read' }),
    );

    expect(rules(violations)).toEqual(['keyless-signing-without-id-token']);
  });

  it('reports a long-lived signing key, and does not also ask for id-token', () => {
    const violations = auditWorkflow(
      publishWorkflow({
        signFlags: '--key env://COSIGN_PRIVATE_KEY ',
        permissions: 'permissions:\n  contents: read',
      }),
    );

    expect(rules(violations)).toEqual(['long-lived-signing-key']);
  });
});

describe('deploy rules', () => {
  it('passes a deploy that verifies a pinned identity and deploys the verified digest', () => {
    expect(auditWorkflow(deployWorkflow())).toEqual([]);
  });

  it('reports a deploy with no verification', () => {
    const violations = auditWorkflow(
      deployWorkflow({ omitVerification: true, deployedReference: 'inputs.image-uri' }),
    );

    expect(rules(violations)).toEqual(['image-deployed-without-verification']);
  });

  it('reports an identity that matches every signer', () => {
    const violations = auditWorkflow(deployWorkflow({ identity: '.*' }));

    expect(rules(violations)).toEqual(['verification-identity-unpinned']);
    expect(violations[0].message).toContain('matches every signer');
  });

  it('reports a verification with no identity flag at all', () => {
    const naked = workflow(
      'workflow-templates/deploy-ecs.yml',
      `
name: Deploy
on:
  workflow_call:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
${cosignInstall()}
      - name: Verify
        run: cosign verify "$IMAGE_REF"
      - name: Render
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          image: \${{ steps.verify.outputs.image-ref }}
`,
    );

    expect(rules(auditWorkflow(naked))).toEqual([
      'verification-identity-unpinned',
      'verification-identity-unpinned',
    ]);
  });

  it('reports a missing or wildcard issuer', () => {
    expect(rules(auditWorkflow(deployWorkflow({ issuer: null })))).toEqual([
      'verification-identity-unpinned',
    ]);
    expect(rules(auditWorkflow(deployWorkflow({ issuer: '.*' })))).toEqual([
      'verification-identity-unpinned',
    ]);
  });

  it('leaves an identity supplied by the caller to the caller', () => {
    // A reusable workflow cannot know which build it is protecting; refusing
    // the expression would mean every identity had to be hardcoded.
    expect(auditWorkflow(deployWorkflow({ identity: '${{ inputs.signer-identity }}' }))).toEqual(
      [],
    );
  });

  it('reports a deploy that verifies one reference and deploys another', () => {
    const violations = auditWorkflow(deployWorkflow({ deployedReference: 'inputs.image-uri' }));

    expect(rules(violations)).toEqual(['deploys-unverified-reference']);
    expect(violations[0].message).toContain('two registry reads');
  });

  it('accepts a caller-supplied reference that is already a digest', () => {
    const digest = workflow(
      'workflow-templates/deploy-ecs.yml',
      `
name: Deploy
on:
  workflow_call:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
${cosignInstall()}
      - name: Verify
        env:
          IMAGE_URI: \${{ inputs.image-uri }}
        run: cosign verify --certificate-identity-regexp "${IDENTITY}" --certificate-oidc-issuer ${GITHUB_OIDC_ISSUER} "$IMAGE_URI"
      - name: Render
        env:
          IMAGE_URI: \${{ inputs.image-uri }}@sha256:abc
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          image: \${{ inputs.image-uri }}@sha256:abc
`,
    );

    expect(auditWorkflow(digest)).toEqual([]);
  });
});

describe('cosign pinning', () => {
  it('reports an installer on a floating tag', () => {
    const violations = auditWorkflow(
      deployWorkflow({ installer: 'sigstore/cosign-installer@v4' }),
    );

    expect(rules(violations)).toEqual(['cosign-unpinned']);
    expect(violations[0].message).toContain('full commit SHA');
  });

  it('reports an installer with no pinned cosign release', () => {
    const violations = auditWorkflow(publishWorkflow({ cosignRelease: null }));

    expect(rules(violations)).toEqual(['cosign-unpinned']);
    expect(violations[0].message).toContain('whatever the installer');
  });

  it('reports a release that is not an exact version', () => {
    const violations = auditWorkflow(publishWorkflow({ cosignRelease: 'main' }));

    expect(rules(violations)).toEqual(['cosign-unpinned']);
  });

  it('accepts a release supplied through a workflow expression', () => {
    expect(auditWorkflow(publishWorkflow({ cosignRelease: '${{ env.COSIGN_VERSION }}' }))).toEqual(
      [],
    );
  });

  it('ignores a cosign installer in a job that neither publishes nor deploys', () => {
    const unrelated = workflow(
      '.github/workflows/ci.yml',
      `
name: CI
on:
  push:
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: sigstore/cosign-installer@v4
      - run: echo lint
`,
    );

    expect(auditWorkflow(unrelated)).toEqual([]);
  });
});

describe('helpers', () => {
  it('splits an action reference into name and ref', () => {
    expect(actionName(PINNED_INSTALLER)).toBe('sigstore/cosign-installer');
    expect(actionRef(PINNED_INSTALLER)).toBe('6f9f17788090df1f26f669e9d70d6ae9567deba6');
    expect(actionRef('actions/checkout')).toBeUndefined();
  });

  it('walks the needs graph transitively without looping', () => {
    const jobs = parseJobs(
      load(`
jobs:
  a:
    steps: []
  b:
    needs: a
    steps: []
  c:
    needs: b
    steps: []
  d:
    steps: []
`),
    );

    expect(downstreamJobs(jobs, 'a').map((job) => job.id)).toEqual(['b', 'c']);
    expect(downstreamJobs(jobs, 'd')).toEqual([]);
  });

  it('formats a violation with its file, location, and rule', () => {
    const formatted = formatViolations(auditWorkflow(publishWorkflow({ omitSigning: true })));

    expect(formatted).toContain('workflow-templates/docker-build-push.yml');
    expect(formatted).toContain('[image-published-without-signature]');
  });

  it('returns an empty string when there is nothing to report', () => {
    expect(formatViolations([])).toBe('');
  });
});

describe('the workflows this repository ships', () => {
  const workflows = readWorkflows(REPO_ROOT);

  it('reads both the workflows it runs and the templates it ships', () => {
    const paths = workflows.map((w) => w.path);

    expect(paths).toContain('.github/workflows/ci.yml');
    expect(paths).toContain('workflow-templates/docker-build-push.yml');
  });

  it('returns nothing for a root with no workflows', () => {
    expect(readWorkflows(path.join(REPO_ROOT, 'docs'))).toEqual([]);
  });

  it('signs every image it publishes and verifies every image it deploys', () => {
    expect(formatViolations(auditImageSigning(workflows))).toBe('');
  });

  // Without this the suite above could pass on a repository where nothing is
  // classified as publishing or deploying at all — a gate that sees nothing
  // reports nothing.
  it('still recognises the publish and deploy paths the gate exists for', () => {
    const jobsIn = (file: string) =>
      parseJobs(workflows.find((w) => w.path === file)?.document).flatMap((job) => job);

    const build = jobsIn('workflow-templates/docker-build-push.yml');
    expect(build.some((job) => job.steps.some(isPublishStep))).toBe(true);
    expect(build.some((job) => job.steps.some(isSignStep))).toBe(true);

    for (const file of [
      'workflow-templates/deploy-ecs.yml',
      'workflow-templates/blue-green-deploy.yml',
      '.github/workflows/canary-deploy.yml',
      '.github/workflows/preview-environment.yml',
    ]) {
      const deploying = jobsIn(file).filter((job) => deployStepsInJob(job).length > 0);
      expect(deploying.length).toBeGreaterThan(0);
      expect(deploying.every((job) => job.steps.some(isVerifyStep))).toBe(true);
    }
  });

  it('pins the cosign installer to one commit everywhere it is used', () => {
    const used = workflows.flatMap((w) =>
      parseJobs(w.document).flatMap((job) =>
        job.steps.flatMap((s) =>
          s.uses !== undefined && actionName(s.uses) === 'sigstore/cosign-installer'
            ? [s.uses]
            : [],
        ),
      ),
    );

    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used)).toEqual(new Set([PINNED_INSTALLER]));
  });
});
