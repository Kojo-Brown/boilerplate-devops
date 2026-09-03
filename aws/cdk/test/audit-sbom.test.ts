import * as path from 'path';
import { load } from 'js-yaml';
import {
  CYCLONEDX_MEDIA_TYPE,
  Step,
  VERIFICATION_MARKER,
  Violation,
  ViolationRule,
  WorkflowFile,
  actionName,
  auditSbom,
  auditWorkflow,
  downstreamJobs,
  formatViolations,
  isRegistryAttachStep,
  isSbomAttachStep,
  isSbomStep,
  isVerificationStep,
  parseJobs,
  publishSteps,
  readWorkflows,
  sbomFormat,
  scansImage,
} from '../tools/audit-sbom';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The commit the shipped templates pin the generator to. */
const PINNED_GENERATOR = 'anchore/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26';

const rules = (violations: readonly Violation[]): ViolationRule[] => violations.map((v) => v.rule);

/** A workflow written the way a workflow is written, then parsed the way the tool parses one. */
const workflow = (filePath: string, yaml: string): WorkflowFile => ({
  path: filePath,
  document: load(yaml),
});

interface ImageWorkflowOverrides {
  /** `uses:` for the generator step. Defaults to the pinned action. */
  readonly generator?: string;
  /** `with:` block for the generator, as YAML lines already indented to 10. */
  readonly generatorWith?: string;
  /** Drop the step that asserts the SBOM is a non-empty CycloneDX document. */
  readonly omitVerification?: boolean;
  /** Drop the `oras attach` that puts the SBOM in the registry. */
  readonly omitRegistryAttach?: boolean;
  /** Scan after pushing rather than before. */
  readonly scanAfterPush?: boolean;
}

/**
 * A conforming image pipeline: pinned generator, CycloneDX, scanned from the
 * image, before the push, verified, and attached to the registry. Individual
 * tests dislodge one thing at a time so a failure names its cause.
 */
const imageWorkflow = (overrides: ImageWorkflowOverrides = {}): WorkflowFile => {
  const scan = `      - name: Generate CycloneDX SBOM
        uses: ${overrides.generator ?? PINNED_GENERATOR}
        with:
${overrides.generatorWith ?? '          image: ${{ steps.build.outputs.image-uri }}\n          format: cyclonedx-json'}`;

  const verify = overrides.omitVerification
    ? ''
    : `      - name: Verify SBOM
        run: |
          test "$(jq -r '.${VERIFICATION_MARKER}' sbom.cdx.json)" = "CycloneDX"
`;

  const push = `      - name: Push image
        run: docker push "$IMAGE_URI"
`;

  const attach = overrides.omitRegistryAttach
    ? ''
    : `      - name: Attach SBOM
        run: oras attach --artifact-type ${CYCLONEDX_MEDIA_TYPE} "$IMAGE_URI" sbom.cdx.json
`;

  return workflow(
    'workflow-templates/docker-build-push.yml',
    `
name: Docker Build & Push
on:
  workflow_call:
jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - name: Build image
        id: build
        run: docker build -t "$IMAGE_URI" .
${overrides.scanAfterPush ? `${push}${scan}\n${verify}${attach}` : `${scan}\n${verify}${push}${attach}`}`,
  );
};

interface DirectoryWorkflowOverrides {
  readonly generatorWith?: string;
  readonly omitVerification?: boolean;
  readonly omitScan?: boolean;
}

/** A conforming directory pipeline: scan the source tree, verify, then sync. */
const directoryWorkflow = (overrides: DirectoryWorkflowOverrides = {}): WorkflowFile => {
  const scan = overrides.omitScan
    ? ''
    : `      - name: Generate CycloneDX SBOM
        uses: ${PINNED_GENERATOR}
        with:
${overrides.generatorWith ?? '          path: .\n          format: cyclonedx-json'}
`;

  const verify = overrides.omitVerification
    ? ''
    : `      - name: Verify SBOM
        run: |
          test "$(jq -r '.${VERIFICATION_MARKER}' sbom.cdx.json)" = "CycloneDX"
`;

  return workflow(
    'workflow-templates/deploy-static-site.yml',
    `
name: Deploy Static Site
on:
  workflow_call:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: pnpm build
${scan}${verify}      - name: Sync to S3
        run: aws s3 sync dist "s3://$BUCKET" --delete
`,
  );
};

const step = (overrides: Partial<Step> = {}): Step => ({
  index: 0,
  name: 'a step',
  with: {},
  ...overrides,
});

describe('conforming workflows', () => {
  it('accepts an image pipeline that scans the image, verifies, and attaches to the registry', () => {
    expect(auditWorkflow(imageWorkflow())).toEqual([]);
  });

  it('accepts a directory pipeline that scans the tree and verifies before syncing', () => {
    expect(auditWorkflow(directoryWorkflow())).toEqual([]);
  });

  it('ignores a workflow that publishes nothing', () => {
    const ci = workflow(
      '.github/workflows/ci.yml',
      `
name: CI
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: docker build -t local .
`,
    );

    expect(auditWorkflow(ci)).toEqual([]);
  });
});

describe('release-artifact-without-sbom', () => {
  it('fires when a publishing job has no SBOM anywhere', () => {
    expect(rules(auditWorkflow(directoryWorkflow({ omitScan: true })))).toEqual([
      'release-artifact-without-sbom',
    ]);
  });

  it('reports once per job rather than once per publish step', () => {
    const many = workflow(
      'workflow-templates/deploy-static-site.yml',
      `
name: Deploy
on: workflow_call
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: aws s3 sync dist "s3://$BUCKET" --include "*.html"
      - run: aws s3 sync dist "s3://$BUCKET" --exclude "*.html"
      - run: aws s3 sync dist "s3://$BUCKET"
`,
    );

    expect(rules(auditWorkflow(many))).toEqual(['release-artifact-without-sbom']);
  });

  it('accepts an SBOM generated by a downstream job that pulls the pushed image', () => {
    const split = workflow(
      'workflow-templates/docker-build-push.yml',
      `
name: Build
on: workflow_call
jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - run: docker push "$IMAGE_URI"
  sbom:
    needs: build-push
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED_GENERATOR}
        with:
          image: \${{ needs.build-push.outputs.image-uri }}
          format: cyclonedx-json
      - run: oras attach --artifact-type ${CYCLONEDX_MEDIA_TYPE} "$IMAGE_URI" sbom.cdx.json
`,
    );

    expect(auditWorkflow(split)).toEqual([]);
  });

  it('accepts an SBOM job reached transitively through an intermediate job', () => {
    const chained = workflow(
      'workflow-templates/docker-build-push.yml',
      `
name: Build
on: workflow_call
jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - run: docker push "$IMAGE_URI"
  scan:
    needs: [build-push]
    runs-on: ubuntu-latest
    steps:
      - run: echo scanning
  sbom:
    needs: [scan]
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED_GENERATOR}
        with:
          image: \${{ inputs.image }}
          format: cyclonedx-json
      - run: oras attach --artifact-type ${CYCLONEDX_MEDIA_TYPE} "$IMAGE_URI" sbom.cdx.json
`,
    );

    expect(auditWorkflow(chained)).toEqual([]);
  });

  it('still fires when the SBOM job does not depend on the publishing job', () => {
    const unrelated = workflow(
      'workflow-templates/docker-build-push.yml',
      `
name: Build
on: workflow_call
jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - run: docker push "$IMAGE_URI"
  sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED_GENERATOR}
        with:
          image: \${{ inputs.image }}
          format: cyclonedx-json
`,
    );

    expect(rules(auditWorkflow(unrelated))).toContain('release-artifact-without-sbom');
  });
});

describe('sbom-format-not-cyclonedx', () => {
  it('fires when the format is left to the default, which is SPDX', () => {
    const violations = auditWorkflow(
      imageWorkflow({ generatorWith: '          image: ${{ steps.build.outputs.image-uri }}' }),
    );

    expect(rules(violations)).toEqual(['sbom-format-not-cyclonedx']);
    expect(violations[0].message).toContain('spdx-json');
  });

  it('fires when SPDX is asked for explicitly', () => {
    const violations = auditWorkflow(
      imageWorkflow({
        generatorWith:
          '          image: ${{ steps.build.outputs.image-uri }}\n          format: spdx-json',
      }),
    );

    expect(rules(violations)).toEqual(['sbom-format-not-cyclonedx']);
  });

  it('accepts cyclonedx-xml as well as cyclonedx-json', () => {
    const violations = auditWorkflow(
      imageWorkflow({
        generatorWith:
          '          image: ${{ steps.build.outputs.image-uri }}\n          format: cyclonedx-xml',
      }),
    );

    expect(violations).toEqual([]);
  });

  it('reads the format off a syft command line', () => {
    expect(sbomFormat(step({ run: 'syft registry:$IMAGE -o cyclonedx-json=sbom.cdx.json' }))).toBe(
      'cyclonedx-json',
    );
    expect(sbomFormat(step({ run: 'syft . --output spdx-json' }))).toBe('spdx-json');
    expect(sbomFormat(step({ run: 'syft .' }))).toBeUndefined();
  });

  it('prefers an explicit `with.format` over anything in a run block', () => {
    expect(sbomFormat(step({ with: { format: 'cyclonedx-json' }, run: '-o spdx-json' }))).toBe(
      'cyclonedx-json',
    );
  });
});

describe('sbom-describes-source-not-image', () => {
  it('fires when an image pipeline inventories a path instead of the image', () => {
    const violations = auditWorkflow(
      imageWorkflow({ generatorWith: '          path: .\n          format: cyclonedx-json' }),
    );

    expect(rules(violations)).toEqual(['sbom-describes-source-not-image']);
    expect(violations[0].message).toContain('base image');
  });

  it('does not fire for a directory pipeline, where scanning the tree is correct', () => {
    // A bundler erases package identity, so a scan of `dist/` finds nothing;
    // the lockfile beside it is the only place the components are named.
    expect(auditWorkflow(directoryWorkflow())).toEqual([]);
  });

  it('recognises an image scanned by a syft command', () => {
    expect(scansImage(step({ run: 'syft registry:$IMAGE_URI -o cyclonedx-json' }))).toBe(true);
    expect(scansImage(step({ run: 'syft docker:app:latest -o cyclonedx-json' }))).toBe(true);
    expect(scansImage(step({ run: 'syft scan "$IMAGE_URI" -o cyclonedx-json' }))).toBe(true);
    expect(scansImage(step({ run: 'syft dir:. -o cyclonedx-json' }))).toBe(false);
    expect(scansImage(step({ run: 'syft . -o cyclonedx-json' }))).toBe(false);
  });

  it('recognises an image passed to the action', () => {
    expect(scansImage(step({ with: { image: 'app:latest' } }))).toBe(true);
    expect(scansImage(step({ with: { image: '' } }))).toBe(false);
    expect(scansImage(step({ with: { path: '.' } }))).toBe(false);
  });
});

describe('sbom-after-publish', () => {
  it('fires when the scan runs after the push', () => {
    const violations = auditWorkflow(imageWorkflow({ scanAfterPush: true }));

    expect(rules(violations)).toContain('sbom-after-publish');
    expect(violations.find((v) => v.rule === 'sbom-after-publish')?.message).toContain(
      'already in the registry',
    );
  });

  it('measures against the first publish step, not the last', () => {
    const late = workflow(
      'workflow-templates/deploy-static-site.yml',
      `
name: Deploy
on: workflow_call
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: aws s3 sync dist "s3://$BUCKET" --include "*.html"
      - uses: ${PINNED_GENERATOR}
        with:
          path: .
          format: cyclonedx-json
      - run: test "$(jq -r '.${VERIFICATION_MARKER}' sbom.cdx.json)" = "CycloneDX"
      - run: aws s3 sync dist "s3://$BUCKET"
`,
    );

    expect(rules(auditWorkflow(late))).toEqual(['sbom-after-publish']);
  });

  it('does not fire when the SBOM is produced by a downstream job', () => {
    // A separate job cannot be "before" the push, and scanning the registry
    // copy is a legitimate pattern; the ordering rule is same-job only.
    const split = workflow(
      'workflow-templates/docker-build-push.yml',
      `
name: Build
on: workflow_call
jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - run: docker push "$IMAGE_URI"
  sbom:
    needs: build-push
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED_GENERATOR}
        with:
          image: \${{ inputs.image }}
          format: cyclonedx-json
      - run: oras attach --artifact-type ${CYCLONEDX_MEDIA_TYPE} "$IMAGE_URI" sbom.cdx.json
`,
    );

    expect(rules(auditWorkflow(split))).not.toContain('sbom-after-publish');
  });
});

describe('sbom-not-attached', () => {
  it('fires when the generator is told not to upload and nothing else takes it', () => {
    const violations = auditWorkflow(
      imageWorkflow({
        generatorWith:
          '          image: ${{ steps.build.outputs.image-uri }}\n' +
          '          format: cyclonedx-json\n' +
          '          upload-artifact: false',
        omitRegistryAttach: true,
      }),
    );

    expect(rules(violations)).toContain('sbom-not-attached');
  });

  it('treats the generator\u2019s own upload as an attachment, since that is its default', () => {
    expect(
      isSbomAttachStep(step({ uses: PINNED_GENERATOR, with: { format: 'cyclonedx-json' } })),
    ).toBe(true);
    expect(
      isSbomAttachStep(step({ uses: PINNED_GENERATOR, with: { 'upload-artifact': false } })),
    ).toBe(false);
    expect(
      isSbomAttachStep(step({ uses: PINNED_GENERATOR, with: { 'upload-artifact': 'false' } })),
    ).toBe(false);
  });

  it('counts an opted-out generator that still uploads a release asset', () => {
    expect(
      isSbomAttachStep(
        step({
          uses: PINNED_GENERATOR,
          with: { 'upload-artifact': false, 'upload-release-assets': true },
        }),
      ),
    ).toBe(true);
  });

  it('counts an upload-artifact step only when it carries the SBOM', () => {
    expect(
      isSbomAttachStep(
        step({ uses: 'actions/upload-artifact@v4', with: { path: 'sbom.cdx.json' } }),
      ),
    ).toBe(true);
    expect(
      isSbomAttachStep(step({ uses: 'actions/upload-artifact@v4', with: { path: 'cdk.out' } })),
    ).toBe(false);
  });
});

describe('image-sbom-not-in-registry', () => {
  it('fires when a published image\u2019s SBOM lives only in an expiring workflow artifact', () => {
    const violations = auditWorkflow(imageWorkflow({ omitRegistryAttach: true }));

    expect(rules(violations)).toEqual(['image-sbom-not-in-registry']);
    expect(violations[0].message).toContain('oras attach');
  });

  it('does not fire for a directory artifact, which has no registry to live in', () => {
    expect(rules(auditWorkflow(directoryWorkflow()))).not.toContain('image-sbom-not-in-registry');
  });

  it('accepts cosign as the registry attachment', () => {
    expect(isRegistryAttachStep(step({ run: 'cosign attach sbom --sbom sbom.cdx.json $IMAGE' }))).toBe(
      true,
    );
    expect(isRegistryAttachStep(step({ run: 'oras attach --artifact-type x $IMAGE f' }))).toBe(true);
    expect(isRegistryAttachStep(step({ run: 'oras push $IMAGE f' }))).toBe(false);
  });
});

describe('sbom-generator-unpinned', () => {
  it.each(['anchore/sbom-action@v0', 'anchore/sbom-action@main', 'anchore/sbom-action@v0.24.2'])(
    'fires for %s',
    (generator) => {
      expect(rules(auditWorkflow(imageWorkflow({ generator })))).toEqual([
        'sbom-generator-unpinned',
      ]);
    },
  );

  it('accepts a full 40-character commit SHA', () => {
    expect(auditWorkflow(imageWorkflow({ generator: PINNED_GENERATOR }))).toEqual([]);
  });

  it('rejects a short SHA, which GitHub resolves but which is not collision-safe', () => {
    expect(rules(auditWorkflow(imageWorkflow({ generator: 'anchore/sbom-action@3ad7283' })))).toEqual(
      ['sbom-generator-unpinned'],
    );
  });

  it('does not apply to a generator invoked as a shell command', () => {
    const shell = workflow(
      'workflow-templates/docker-build-push.yml',
      `
name: Build
on: workflow_call
jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - run: syft registry:$IMAGE_URI -o cyclonedx-json=sbom.cdx.json
      - run: test "$(jq -r '.${VERIFICATION_MARKER}' sbom.cdx.json)" = "CycloneDX"
      - run: docker push "$IMAGE_URI"
      - run: oras attach --artifact-type ${CYCLONEDX_MEDIA_TYPE} "$IMAGE_URI" sbom.cdx.json
`,
    );

    expect(auditWorkflow(shell)).toEqual([]);
  });
});

describe('sbom-unverified', () => {
  it('fires when nothing asserts the document is a non-empty CycloneDX SBOM', () => {
    const violations = auditWorkflow(imageWorkflow({ omitVerification: true }));

    expect(rules(violations)).toEqual(['sbom-unverified']);
    expect(violations[0].message).toContain('components');
  });

  it('recognises the assertion by the CycloneDX field it has to read', () => {
    expect(isVerificationStep(step({ run: `jq -e '.${VERIFICATION_MARKER}' sbom.cdx.json` }))).toBe(
      true,
    );
    expect(isVerificationStep(step({ run: 'jq empty sbom.cdx.json' }))).toBe(false);
    expect(isVerificationStep(step({ uses: 'actions/checkout@v4' }))).toBe(false);
  });
});

describe('publish detection', () => {
  it.each([
    ['docker push "$IMAGE"', 'image'],
    ['docker buildx build --platform linux/amd64 -t "$IMAGE" --push .', 'image'],
    ['helm push chart.tgz oci://registry', 'image'],
    ['oras push "$REF" file.txt', 'image'],
    ['aws s3 sync dist "s3://bucket" --delete', 'directory'],
    ['aws s3 cp dist "s3://bucket" --recursive', 'directory'],
    ['npm publish --access public', 'directory'],
    ['pnpm publish', 'directory'],
  ])('classifies %s as publishing a %s artifact', (run, kind) => {
    const [job] = parseJobs(load(`jobs:\n  j:\n    steps:\n      - run: ${run}`));
    expect(publishSteps(job).map((p) => p.kind)).toEqual([kind]);
  });

  it.each([
    'docker build -t local .',
    'docker buildx build -t local .',
    'aws s3 ls s3://bucket',
    'aws s3 sync s3://bucket ./restore',
  ])('does not classify %s as a publish', (run) => {
    const [job] = parseJobs(load(`jobs:\n  j:\n    steps:\n      - run: ${JSON.stringify(run)}`));

    expect(publishSteps(job)).toEqual([]);
  });

  it('still classifies a dry-run publish, erring towards auditing one job too many', () => {
    // The patterns are deliberately conservative. A false positive costs a job
    // an SBOM it did not need; a false negative ships an uninventoried
    // artifact, which is the failure this whole gate exists to prevent.
    const [job] = parseJobs(
      load('jobs:\n  j:\n    steps:\n      - run: npm publish --dry-run || true'),
    );

    expect(publishSteps(job)).toHaveLength(1);
  });

  it('honours the `push` input on docker/build-push-action', () => {
    const pushing = parseJobs(
      load(
        'jobs:\n  j:\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          push: true',
      ),
    );
    const notPushing = parseJobs(
      load(
        'jobs:\n  j:\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          push: false',
      ),
    );

    expect(publishSteps(pushing[0])).toHaveLength(1);
    expect(publishSteps(notPushing[0])).toHaveLength(0);
  });

  it('does not read an SBOM upload as a release of its own', () => {
    // Otherwise `gh release upload sbom.cdx.json` would demand an SBOM of the
    // SBOM, which is both wrong and unsatisfiable.
    const [job] = parseJobs(
      load(
        'jobs:\n  j:\n    steps:\n      - run: gh release upload "$TAG" sbom.cdx.json --clobber',
      ),
    );

    expect(publishSteps(job)).toEqual([]);
    expect(isSbomAttachStep(job.steps[0])).toBe(true);
  });

  it('reads an ordinary release upload as a release', () => {
    const [job] = parseJobs(
      load('jobs:\n  j:\n    steps:\n      - run: gh release upload "$TAG" app.tar.gz'),
    );

    expect(publishSteps(job).map((p) => p.kind)).toEqual(['directory']);
  });
});

describe('parseJobs', () => {
  it('returns nothing for documents with no jobs', () => {
    expect(parseJobs(undefined)).toEqual([]);
    expect(parseJobs(null)).toEqual([]);
    expect(parseJobs('name: CI')).toEqual([]);
    expect(parseJobs(load('name: CI\non: push'))).toEqual([]);
  });

  it('accepts `needs` in both its scalar and list forms', () => {
    const [scalar] = parseJobs(load('jobs:\n  b:\n    needs: a\n    steps: []'));
    const [list] = parseJobs(load('jobs:\n  b:\n    needs: [a, x]\n    steps: []'));

    expect(scalar.needs).toEqual(['a']);
    expect(list.needs).toEqual(['a', 'x']);
  });

  it('skips malformed steps rather than throwing on them', () => {
    const [job] = parseJobs(load('jobs:\n  j:\n    steps:\n      - run: echo hi\n      - "junk"'));

    expect(job.steps).toHaveLength(1);
  });

  it('names a step by whatever it has, falling back to its position', () => {
    const [job] = parseJobs(
      load(
        'jobs:\n  j:\n    steps:\n      - name: Named\n        run: x\n      - uses: actions/checkout@v4\n      - id: third\n        run: y\n      - run: z',
      ),
    );

    expect(job.steps.map((s) => s.name)).toEqual([
      'Named',
      'actions/checkout@v4',
      'third',
      'step 4',
    ]);
  });
});

describe('downstreamJobs', () => {
  const graph = parseJobs(
    load(
      'jobs:\n  a:\n    steps: []\n  b:\n    needs: a\n    steps: []\n  c:\n    needs: b\n    steps: []\n  d:\n    steps: []',
    ),
  );

  it('follows `needs` transitively', () => {
    expect(downstreamJobs(graph, 'a').map((j) => j.id)).toEqual(['b', 'c']);
  });

  it('excludes the job itself and anything unrelated', () => {
    expect(downstreamJobs(graph, 'c')).toEqual([]);
    expect(downstreamJobs(graph, 'd')).toEqual([]);
  });

  it('terminates on a cyclic graph rather than recursing forever', () => {
    // GitHub rejects these, but the auditor reads files GitHub has not seen yet.
    const cyclic = parseJobs(
      load('jobs:\n  a:\n    needs: b\n    steps: []\n  b:\n    needs: a\n    steps: []'),
    );

    expect(downstreamJobs(cyclic, 'a').map((j) => j.id)).toEqual(['b']);
  });
});

describe('helpers', () => {
  it('strips the ref from an action reference', () => {
    expect(actionName('anchore/sbom-action@v0')).toBe('anchore/sbom-action');
    expect(actionName('actions/checkout')).toBe('actions/checkout');
  });

  it('identifies SBOM generators by action and by command', () => {
    expect(isSbomStep(step({ uses: PINNED_GENERATOR }))).toBe(true);
    expect(isSbomStep(step({ run: 'cyclonedx-npm --output-file sbom.cdx.json' }))).toBe(true);
    expect(isSbomStep(step({ run: 'cdxgen -o sbom.cdx.json' }))).toBe(true);
    expect(isSbomStep(step({ uses: 'actions/checkout@v4' }))).toBe(false);
    expect(isSbomStep(step({ run: 'echo syftly' }))).toBe(false);
  });

  it('formats violations as file, location, rule, then explanation', () => {
    const formatted = formatViolations([
      {
        rule: 'sbom-unverified',
        file: 'workflow-templates/x.yml',
        location: 'build#Scan',
        message: 'because.',
      },
    ]);

    expect(formatted).toBe(
      'workflow-templates/x.yml  build#Scan  [sbom-unverified]\n    because.',
    );
  });

  it('formats an empty list as an empty string', () => {
    expect(formatViolations([])).toBe('');
  });
});

describe('this repository', () => {
  const workflows = readWorkflows(REPO_ROOT);

  it('reads both the workflows it runs and the templates it ships', () => {
    const paths = workflows.map((w) => w.path);

    expect(paths).toContain('.github/workflows/ci.yml');
    expect(paths).toContain('workflow-templates/docker-build-push.yml');
    expect(paths).toContain('workflow-templates/deploy-static-site.yml');
    expect(paths).toContain('workflow-templates/sbom.yml');
  });

  it('publishes nothing without a verified CycloneDX SBOM attached to it', () => {
    expect(formatViolations(auditSbom(workflows))).toBe('');
  });

  it('pins the generator to the same commit in every template that uses it', () => {
    const generators = workflows.flatMap((w) =>
      parseJobs(w.document)
        .flatMap((job) => job.steps)
        .filter((s) => s.uses?.startsWith('anchore/sbom-action') === true)
        .map((s) => s.uses),
    );

    expect(generators.length).toBeGreaterThanOrEqual(3);
    expect(new Set(generators)).toEqual(new Set([PINNED_GENERATOR]));
  });

  it('attaches the image SBOM under the CycloneDX media type', () => {
    const dockerTemplate = workflows.find(
      (w) => w.path === 'workflow-templates/docker-build-push.yml',
    );
    const attaches = parseJobs(dockerTemplate?.document)
      .flatMap((job) => job.steps)
      .filter(isRegistryAttachStep);

    expect(attaches).toHaveLength(1);
    expect(attaches[0].run).toContain(`--artifact-type ${CYCLONEDX_MEDIA_TYPE}`);
  });
});
