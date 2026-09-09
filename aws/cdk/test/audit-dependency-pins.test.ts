import * as path from 'path';
import {
  PINNED_IMAGES,
  POSTGRES_CLIENT_IMAGE,
  XRAY_DAEMON_IMAGE,
  NGINX_PLACEHOLDER_IMAGE,
} from '../lib/base-images';
import {
  PIN_MODULE,
  SourceFile,
  Violation,
  ViolationRule,
  actionRepository,
  auditDependencyPins,
  auditImages,
  auditPinConsistency,
  auditUses,
  formatViolations,
  parseImages,
  parseUses,
  readImageSources,
  readWorkflowSources,
  stripHashComments,
  stripTypeScriptComments,
} from '../tools/audit-dependency-pins';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const SHA = '11d5960a326750d5838078e36cf38b85af677262';
const OTHER_SHA = '49933ea5288caeca8642d1e84afbd3f7d6820020';
const DIGEST = 'sha256:8d32e1ab9a199e9d83b66ada9823585379878433a9b22fa20110418a3e8a0baf';

const rules = (violations: readonly Violation[]): ViolationRule[] => violations.map((v) => v.rule);

const workflow = (text: string, filePath = '.github/workflows/ci.yml'): SourceFile => ({
  path: filePath,
  text,
});

/** The audit as CI runs it, over hand-written files rather than the repository. */
const audit = (
  workflows: readonly SourceFile[],
  imageSources: readonly SourceFile[] = [],
): Violation[] => auditDependencyPins(workflows, imageSources);

const usesRules = (text: string): ViolationRule[] => rules(auditUses(parseUses(workflow(text))));

describe('parseUses', () => {
  it('reads the action, the ref and the version comment off one line', () => {
    expect(parseUses(workflow(`jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v4.4.0\n`)))
      .toEqual([
        {
          file: '.github/workflows/ci.yml',
          line: 4,
          reference: `actions/checkout@${SHA}`,
          action: 'actions/checkout',
          ref: SHA,
          label: 'v4.4.0',
        },
      ]);
  });

  it.each([
    ['dash form', `      - uses: actions/checkout@${SHA} # v4.4.0`],
    ['key form', `        uses: actions/checkout@${SHA} # v4.4.0`],
    ['quoted', `        uses: "actions/checkout@${SHA}" # v4.4.0`],
  ])('reads %s', (_name, line) => {
    const [reference] = parseUses(workflow(line));
    expect(reference.action).toBe('actions/checkout');
    expect(reference.ref).toBe(SHA);
    expect(reference.label).toBe('v4.4.0');
  });

  it('reports no label when the line carries no comment', () => {
    expect(parseUses(workflow(`        uses: actions/checkout@${SHA}`))[0].label).toBeUndefined();
  });

  // A composite action in this repository is this repository's code at this
  // repository's commit; there is no third party and nothing to pin.
  it('ignores local composite actions', () => {
    expect(parseUses(workflow('        uses: ./.github/actions/setup'))).toEqual([]);
  });

  it('keeps the subpath of an action that lives in a subdirectory', () => {
    expect(parseUses(workflow(`        uses: github/codeql-action/upload-sarif@${SHA} # v3.37.9`))[0]
      .action).toBe('github/codeql-action/upload-sarif');
  });
});

describe('actionRepository', () => {
  it('collapses a subpath to the repository that actually holds the commit', () => {
    expect(actionRepository('github/codeql-action/upload-sarif')).toBe('github/codeql-action');
    expect(actionRepository('actions/checkout')).toBe('actions/checkout');
  });
});

describe('auditUses', () => {
  it('accepts a commit pin carrying a version label', () => {
    expect(usesRules(`        uses: actions/checkout@${SHA} # v4.4.0`)).toEqual([]);
  });

  it.each(['v4', 'main', 'master', 'refs/tags/v4', 'v4.4.0'])(
    'rejects the mutable ref %s',
    (ref) => {
      expect(usesRules(`        uses: actions/checkout@${ref}`)).toEqual(['action-not-pinned']);
    },
  );

  // Even a fully-qualified release tag is a ref in someone else's repository:
  // `v4.4.0` can be deleted and re-pushed at a different commit.
  it('rejects an exact release tag, not just a floating major', () => {
    expect(usesRules('        uses: actions/checkout@v4.4.0')).toEqual(['action-not-pinned']);
  });

  it('rejects a short SHA, which is a prefix and not an identity', () => {
    expect(usesRules(`        uses: actions/checkout@${SHA.slice(0, 7)}`)).toEqual([
      'action-not-pinned',
    ]);
  });

  it('rejects an uppercase SHA rather than quietly accepting it', () => {
    expect(usesRules(`        uses: actions/checkout@${SHA.toUpperCase()}`)).toEqual([
      'action-not-pinned',
    ]);
  });

  it('rejects a pin with no version comment', () => {
    expect(usesRules(`        uses: actions/checkout@${SHA}`)).toEqual(['action-pin-unlabelled']);
  });

  it.each(['main', 'latest', 'pinned', 'HEAD'])(
    'rejects the non-version label %s',
    (label) => {
      expect(usesRules(`        uses: actions/checkout@${SHA} # ${label}`)).toEqual([
        'action-pin-label-not-version',
      ]);
    },
  );

  it.each(['v4', 'v4.4.0', '4.4.0', 'v1.2.3-rc.1'])('accepts the version label %s', (label) => {
    expect(usesRules(`        uses: actions/checkout@${SHA} # ${label}`)).toEqual([]);
  });

  it('reads only the first word of a label, so a trailing note is allowed', () => {
    expect(usesRules(`        uses: actions/checkout@${SHA} # v4.4.0 (see #123)`)).toEqual([]);
  });

  it('requires a container action to name a digest', () => {
    expect(usesRules('        uses: docker://ghcr.io/owner/tool:1.2.3')).toEqual([
      'docker-action-not-pinned',
    ]);
    expect(usesRules(`        uses: docker://ghcr.io/owner/tool@${DIGEST}`)).toEqual([]);
  });
});

describe('auditPinConsistency', () => {
  const twoFiles = (first: string, second: string): Violation[] =>
    auditPinConsistency([
      ...parseUses(workflow(first, '.github/workflows/ci.yml')),
      ...parseUses(workflow(second, 'workflow-templates/deploy-ecs.yml')),
    ]);

  it('passes when both sites name the same commit', () => {
    expect(
      twoFiles(
        `        uses: actions/checkout@${SHA} # v4.4.0`,
        `        uses: actions/checkout@${SHA} # v4.4.0`,
      ),
    ).toEqual([]);
  });

  it('reports both sites when one file was left behind by an upgrade', () => {
    const violations = twoFiles(
      `        uses: actions/checkout@${SHA} # v4.4.0`,
      `        uses: actions/checkout@${OTHER_SHA} # v4.3.0`,
    );

    expect(rules(violations)).toEqual(['action-pin-inconsistent', 'action-pin-inconsistent']);
    expect(violations.map((v) => v.file)).toEqual([
      '.github/workflows/ci.yml',
      'workflow-templates/deploy-ecs.yml',
    ]);
  });

  // codeql-action ships several actions out of one repository at one commit;
  // treating the subpaths as separate would miss exactly the drift that matters.
  it('compares subpaths of one repository against each other', () => {
    expect(
      rules(
        twoFiles(
          `        uses: github/codeql-action/upload-sarif@${SHA} # v3.37.9`,
          `        uses: github/codeql-action/analyze@${OTHER_SHA} # v3.36.0`,
        ),
      ),
    ).toEqual(['action-pin-inconsistent', 'action-pin-inconsistent']);
  });

  it('says nothing about refs that are not pins — that is another rule', () => {
    expect(
      twoFiles('        uses: actions/checkout@v4', `        uses: actions/checkout@${SHA} # v4.4.0`),
    ).toEqual([]);
  });
});

describe('parseImages', () => {
  const found = (text: string, filePath = '.github/workflows/ci.yml'): string[] =>
    parseImages({ path: filePath, text }).map((image) => image.text);

  it('finds a tagged third-party image', () => {
    expect(found('        image: public.ecr.aws/nginx/nginx:stable-alpine')).toEqual([
      'public.ecr.aws/nginx/nginx:stable-alpine',
    ]);
  });

  it('finds a digest-pinned image and records the digest', () => {
    const [image] = parseImages(workflow(`        image: public.ecr.aws/nginx/nginx@${DIGEST}`));
    expect(image.digest).toBe(DIGEST.replace('sha256:', ''));
    expect(image.tag).toBeUndefined();
  });

  // A tag chosen by a variable is unpinned, not untagged: reading it as "no tag
  // at all" is how `image:${SCANNER_VERSION}` gets through a pin gate.
  it.each([
    ['shell variable', 'ghcr.io/owner/tool:${TOOL_VERSION}'],
    ['workflow expression', 'ghcr.io/owner/tool:${{ inputs.version }}'],
  ])('finds an image whose tag comes from a %s', (_name, reference) => {
    expect(found(`          docker pull "${reference}"`)).toEqual([reference]);
  });

  it.each([
    ['a subnet tag key', 'kubernetes.io/role/elb'],
    ['an autoscaler tag key', 'k8s.io/cluster-autoscaler/enabled'],
    ['a namespaced annotation', 'cluster-autoscaler.kubernetes.io/safe-to-evict'],
  ])('does not mistake %s for a registry reference', (_name, key) => {
    expect(found(`      '${key}': 'owned',`, 'aws/cdk/lib/vpc-stack.ts')).toEqual([]);
  });

  it('does not read a URL path as a registry reference', () => {
    expect(found('        run: curl -fsSL https://github.com/rhysd/actionlint/releases/latest'))
      .toEqual([]);
  });

  // The consumer's own image is built per release; its digest cannot be a
  // literal here. That it is *deployed* by digest is audit-image-signing's rule.
  it('leaves the consumer\'s own ECR alone', () => {
    expect(found('        image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/app:sha-abc123'))
      .toEqual([]);
  });

  it('audits an unknown registry rather than skipping it', () => {
    expect(found('        image: registry.example.net/team/tool:1.0.0')).toEqual([
      'registry.example.net/team/tool:1.0.0',
    ]);
  });
});

describe('auditImages', () => {
  const imageRules = (text: string, filePath: string): ViolationRule[] =>
    rules(auditImages(parseImages({ path: filePath, text })));

  it('accepts a digest-pinned image in the pin module', () => {
    expect(imageRules(`  reference: 'public.ecr.aws/nginx/nginx@${DIGEST}',`, PIN_MODULE)).toEqual(
      [],
    );
  });

  it('rejects a tagged image', () => {
    expect(imageRules('        image: public.ecr.aws/nginx/nginx:stable-alpine', PIN_MODULE))
      .toEqual(['image-not-pinned']);
  });

  it.each([
    ['truncated', 'sha256:8d32e1ab'],
    ['uppercase', `sha256:${'A'.repeat(64)}`],
  ])('rejects a %s digest', (_name, digest) => {
    expect(imageRules(`  reference: 'public.ecr.aws/nginx/nginx@${digest}',`, PIN_MODULE)).toEqual([
      'image-digest-malformed',
    ]);
  });

  it('rejects a pin that lives outside the pin module', () => {
    expect(
      imageRules(
        `      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx@${DIGEST}'),`,
        'aws/cdk/lib/ecs-stack.ts',
      ),
    ).toEqual(['image-outside-pin-module']);
  });

  it('reports both faults when a stack names an image by tag', () => {
    expect(
      imageRules(
        "      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:stable-alpine'),",
        'aws/cdk/lib/ecs-stack.ts',
      ),
    ).toEqual(['image-not-pinned', 'image-outside-pin-module']);
  });

  // The pin-module rule is about where a *constant* lives, not about workflows.
  it('does not ask a workflow to import from the pin module', () => {
    expect(
      imageRules(
        `          docker pull "ghcr.io/trufflesecurity/trufflehog@${DIGEST}"`,
        'workflow-templates/secret-scanning.yml',
      ),
    ).toEqual([]);
  });
});

describe('stripHashComments', () => {
  it('removes a trailing comment but keeps the code', () => {
    expect(stripHashComments('image: nginx  # public.ecr.aws/nginx/nginx:latest')).toBe(
      'image: nginx  ',
    );
  });

  it('keeps a hash inside quotes', () => {
    expect(stripHashComments('run: echo "a # b"')).toBe('run: echo "a # b"');
  });

  it('keeps a hash that is part of a word', () => {
    expect(stripHashComments('run: echo pr#123')).toBe('run: echo pr#123');
  });

  it('preserves line count so reported line numbers still match the file', () => {
    expect(stripHashComments('a\n# b\nc').split('\n')).toHaveLength(3);
  });
});

describe('stripTypeScriptComments', () => {
  it('removes a line comment', () => {
    expect(stripTypeScriptComments("const a = 1; // public.ecr.aws/x/y:latest\n").trim()).toBe(
      'const a = 1;',
    );
  });

  it('removes a block comment while keeping its newlines', () => {
    expect(stripTypeScriptComments('a\n/* public.ecr.aws/x/y:latest\n   more */\nb').split('\n'))
      .toHaveLength(4);
  });

  it('keeps a URL inside a string literal', () => {
    expect(stripTypeScriptComments("const a = 'https://example.com/x';")).toBe(
      "const a = 'https://example.com/x';",
    );
  });

  it('keeps a template literal intact', () => {
    expect(stripTypeScriptComments('const a = `x // y`;')).toBe('const a = `x // y`;');
  });
});

describe('auditDependencyPins', () => {
  // The version label is a comment, so the action rules have to read the raw
  // line. Only the image rules see a comment-stripped file.
  it('still checks the version label after comments are stripped for images', () => {
    expect(rules(audit([workflow(`        uses: actions/checkout@${SHA}`)]))).toEqual([
      'action-pin-unlabelled',
    ]);
  });

  it('does not flag an image that only appears in a usage comment', () => {
    expect(
      audit([
        workflow(
          '# Example:\n#   image-uri: public.ecr.aws/nginx/nginx:stable-alpine\n' +
            `        uses: actions/checkout@${SHA} # v4.4.0\n`,
        ),
      ]),
    ).toEqual([]);
  });

  it('formats one violation per block, naming the file, line and rule', () => {
    const text = formatViolations(audit([workflow('        uses: actions/checkout@v4')]));
    expect(text).toContain('.github/workflows/ci.yml  line 1  [action-not-pinned]');
  });

  it('formats nothing when there is nothing to say', () => {
    expect(formatViolations([])).toBe('');
  });
});

describe('lib/base-images.ts', () => {
  it.each(PINNED_IMAGES.map((image) => [image.version, image] as const))(
    'pins %s by digest and records the version it came from',
    (_version, image) => {
      expect(image.reference).toMatch(/^[^:@\s]+@sha256:[0-9a-f]{64}$/);
      expect(image.version.length).toBeGreaterThan(0);
    },
  );

  it('names the registry each image is pulled from', () => {
    expect(NGINX_PLACEHOLDER_IMAGE.reference.startsWith('public.ecr.aws/nginx/nginx@')).toBe(true);
    expect(XRAY_DAEMON_IMAGE.reference.startsWith('public.ecr.aws/xray/aws-xray-daemon@')).toBe(
      true,
    );
    expect(
      POSTGRES_CLIENT_IMAGE.reference.startsWith('public.ecr.aws/docker/library/postgres@'),
    ).toBe(true);
  });

  // A `version` bumped without its digest reads as a pin and is not one.
  it('gives every pin a distinct digest', () => {
    expect(new Set(PINNED_IMAGES.map((image) => image.reference)).size).toBe(PINNED_IMAGES.length);
  });
});

describe('this repository', () => {
  const workflows = readWorkflowSources(REPO_ROOT);
  const imageSources = readImageSources(REPO_ROOT);

  it('pins every action and every third-party image', () => {
    expect(formatViolations(auditDependencyPins(workflows, imageSources))).toBe('');
  });

  // Without this the suite above could pass on a repository where the tool
  // parses nothing at all — a gate that sees nothing reports nothing.
  it('still finds the references the gate exists for', () => {
    const uses = workflows.flatMap(parseUses);
    expect(uses.length).toBeGreaterThan(40);
    expect(new Set(uses.map((u) => actionRepository(u.action))).size).toBeGreaterThan(5);

    const images = imageSources
      .filter((file) => file.path === PIN_MODULE)
      .flatMap((file) => parseImages({ path: file.path, text: file.text }));
    expect(images.length).toBeGreaterThanOrEqual(PINNED_IMAGES.length);
  });

  it('reads the shipped templates, not only the workflows it runs itself', () => {
    expect(workflows.some((w) => w.path.startsWith('workflow-templates/'))).toBe(true);
    expect(workflows.some((w) => w.path.startsWith('.github/workflows/'))).toBe(true);
  });

  it('keeps every action on one commit across workflows and templates', () => {
    expect(auditPinConsistency(workflows.flatMap(parseUses))).toEqual([]);
  });
});
