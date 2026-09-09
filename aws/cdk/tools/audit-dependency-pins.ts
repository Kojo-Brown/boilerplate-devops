#!/usr/bin/env node
/**
 * Audit that every third-party dependency this repository *executes* is named
 * by content, not by a pointer somebody else can move.
 *
 * Two kinds of reference are in scope, and they fail the same way:
 *
 *   • **Actions.** `uses: actions/checkout@v4` runs whatever commit the `v4`
 *     tag points at when the job starts. A tag is a mutable ref in the action
 *     author's repository — they can move it, and anyone who takes over that
 *     account can move it too. The workflow file does not change, the diff
 *     nobody wrote does not appear in review, and the code that ran had the
 *     job's `GITHUB_TOKEN`, its OIDC identity and its secrets.
 *   • **Container images.** `public.ecr.aws/xray/aws-xray-daemon:latest` in a
 *     task definition resolves at every task placement. Two tasks in one
 *     service can be running different images, CloudFormation reports no drift
 *     because the string did not change, and a rollback to the previous task
 *     definition rolls back to the same moving tag.
 *
 * A commit SHA and an image digest are both content addresses: they resolve to
 * the same bytes forever, or they fail to resolve.
 *
 * Pinning alone is not the whole property, which is why this is more than one
 * rule. A bare SHA with no `# v4.4.0` beside it is unreadable in review and
 * invisible to Dependabot, which needs the comment to know what version it is
 * proposing to move you off — so a repository that pins everything and labels
 * nothing has traded a supply-chain risk for a permanently stale toolchain.
 * And the same action pinned to two different SHAs in two files is the state a
 * half-finished upgrade leaves behind: the next one updates one of them.
 *
 * The rules, and the failure each one prevents:
 *
 *   action-not-pinned            `uses:` names a tag or branch, not a commit
 *   docker-action-not-pinned     `uses: docker://…` names a tag, not a digest
 *   action-pin-unlabelled        pinned, but nothing says which version it is
 *   action-pin-label-not-version comment is `# main`/`# latest`, not a version
 *   action-pin-inconsistent      one action, two SHAs, in one repository
 *   image-not-pinned             third-party image named by tag, not digest
 *   image-digest-malformed       `@sha256:` that is not 64 hex characters
 *   image-outside-pin-module     an image literal in CDK source, not in
 *                                `lib/base-images.ts`
 *
 * **Out of scope, deliberately.** Images in the consumer's own registry
 * (`*.dkr.ecr.*.amazonaws.com`) are the artifact this pipeline builds, not a
 * dependency it consumes: their digest is decided per release and cannot be a
 * literal in the tree. That they are deployed by digest rather than by tag is
 * `audit-image-signing.ts`'s rule, and it is a stronger one — the digest has to
 * be the one a `cosign verify` just resolved. The Helm chart's `image.tag` is
 * likewise the consumer's own application, and `values.schema.json` already
 * refuses `latest`, `main`, `master`, `stable` and `edge` there.
 *
 * Usage:
 *   npm run audit:pins                                  # repository root
 *   npx ts-node tools/audit-dependency-pins.ts <dir>
 *
 * Exits non-zero when anything is found. See docs/dependency-pinning.md.
 */
import * as fs from 'fs';
import * as path from 'path';

export type ViolationRule =
  | 'action-not-pinned'
  | 'docker-action-not-pinned'
  | 'action-pin-unlabelled'
  | 'action-pin-label-not-version'
  | 'action-pin-inconsistent'
  | 'image-not-pinned'
  | 'image-digest-malformed'
  | 'image-outside-pin-module';

export interface Violation {
  readonly rule: ViolationRule;
  /** Repository-relative path, e.g. `workflow-templates/deploy-ecs.yml`. */
  readonly file: string;
  /** `line <n>`, so a message names one place a reader can open. */
  readonly location: string;
  readonly message: string;
}

/** A file as this tool reads it: repository-relative path plus raw contents. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const violation = (
  rule: ViolationRule,
  file: string,
  line: number,
  message: string,
): Violation => ({ rule, file, location: `line ${line}`, message });

/* ── Actions ──────────────────────────────────────────────────────────────── */

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * `# v4.4.0`, `# v2`, `# v1.2.3-rc.1`. Anything that reads as a release, so a
 * reviewer can see what moved and Dependabot has a version to compare against.
 * `# main`, `# latest` and `# pinned` do not qualify: they name a pointer
 * again, which is the thing the SHA was supposed to replace.
 */
const VERSION_LABEL = /^v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * One `uses:` line, read as text rather than as YAML — the trailing comment is
 * where the version lives, and a YAML parser throws it away.
 *
 * The reference is captured whole and split afterwards, because
 * `docker://ghcr.io/owner/tool:1.2.3` has no `@` at all: a pattern that
 * requires one silently skips exactly the unpinned container action this is
 * meant to catch.
 */
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s]+)\1\s*(?:#\s*(.*?))?\s*$/;

/** The repository an action lives in: `github/codeql-action/upload-sarif` → `github/codeql-action`. */
export const actionRepository = (reference: string): string =>
  reference.split('/').slice(0, 2).join('/');

export interface UsesReference {
  readonly file: string;
  readonly line: number;
  /** The reference exactly as written, for messages that quote it back. */
  readonly reference: string;
  /** `actions/checkout`, or `docker://ghcr.io/owner/image`. */
  readonly action: string;
  /** Whatever follows the last `@`; empty when the reference carries none. */
  readonly ref: string;
  /** The trailing `# …` comment, trimmed, or undefined when there is none. */
  readonly label?: string;
}

/** Every `uses:` in a workflow, read as text rather than as YAML. */
export const parseUses = (file: SourceFile): UsesReference[] =>
  file.text.split('\n').flatMap((text, index) => {
    const match = USES_LINE.exec(text);
    if (!match) return [];

    const [, , reference, label] = match;
    // A local composite action (`./.github/actions/foo`) is this repository's
    // own code at this repository's own commit. There is nothing to pin.
    if (reference.startsWith('./') || reference.startsWith('../')) return [];

    const separator = reference.lastIndexOf('@');
    const action = separator === -1 ? reference : reference.slice(0, separator);
    const ref = separator === -1 ? '' : reference.slice(separator + 1);

    return [
      {
        file: file.path,
        line: index + 1,
        reference,
        action,
        ref,
        ...(label !== undefined && label.length > 0 ? { label: label.trim() } : {}),
      },
    ];
  });

export const auditUses = (references: readonly UsesReference[]): Violation[] => {
  const violations: Violation[] = [];

  for (const used of references) {
    const { file, line, reference, action, ref, label } = used;

    if (action.startsWith('docker://')) {
      if (!/^sha256:[0-9a-f]{64}$/.test(ref)) {
        violations.push(
          violation(
            'docker-action-not-pinned',
            file,
            line,
            `\`${reference}\` runs a container image named by tag. The registry decides ` +
              'what that tag means at the moment the step starts, and the step runs with this ' +
              "job's token and secrets. Pin it as `docker://<image>@sha256:<digest>`.",
          ),
        );
      }
      continue;
    }

    if (!COMMIT_SHA.test(ref)) {
      violations.push(
        violation(
          'action-not-pinned',
          file,
          line,
          `\`${reference}\` resolves through a tag or branch in someone else's repository. ` +
            'Whatever that ref points at when this job starts runs with the job\'s ' +
            '`GITHUB_TOKEN`, OIDC identity and secrets, and moving it leaves no diff here. ' +
            `Pin the commit and label it: \`${action}@<40-char sha> # ${ref || '<version>'}\`.`,
        ),
      );
      continue;
    }

    if (label === undefined) {
      violations.push(
        violation(
          'action-pin-unlabelled',
          file,
          line,
          `\`${action}\` is pinned to a commit with nothing saying which release that is. ` +
            'Nobody can review the upgrade, and Dependabot reads the trailing comment to know ' +
            'what it is proposing to move you off — without one the pin silently goes stale. ' +
            'Add `# vX.Y.Z`.',
        ),
      );
    } else if (!VERSION_LABEL.test(label.split(/\s+/)[0])) {
      violations.push(
        violation(
          'action-pin-label-not-version',
          file,
          line,
          `\`${action}\` is pinned to a commit labelled \`# ${label}\`, which names a pointer ` +
            'rather than a release — the same problem the SHA was there to solve, moved into ' +
            'the comment. Label it with the version that commit was tagged as.',
        ),
      );
    }
  }

  return violations;
};

/**
 * One action, one SHA, repository-wide. Two SHAs for the same action is what a
 * half-finished upgrade looks like: the next one updates whichever file the
 * author had open, and the other keeps running last year's code.
 */
export const auditPinConsistency = (references: readonly UsesReference[]): Violation[] => {
  const byRepository = new Map<string, UsesReference[]>();

  for (const reference of references) {
    if (reference.action.startsWith('docker://') || !COMMIT_SHA.test(reference.ref)) continue;
    const key = actionRepository(reference.action);
    byRepository.set(key, [...(byRepository.get(key) ?? []), reference]);
  }

  return [...byRepository.entries()].flatMap(([repository, uses]) => {
    const shas = [...new Set(uses.map((u) => u.ref))].sort();
    if (shas.length < 2) return [];

    // Report every site, so a reader does not have to guess which is the odd
    // one out — with two SHAs there is no majority to defer to.
    return uses.map((u) =>
      violation(
        'action-pin-inconsistent',
        u.file,
        u.line,
        `\`${repository}\` is pinned to ${shas.length} different commits across this ` +
          `repository (${shas.map((s) => s.slice(0, 12)).join(', ')}); this one is ` +
          `${u.ref.slice(0, 12)} (${u.label ?? 'unlabelled'}). One of them is a stale copy of ` +
          'an upgrade that only got applied where the author happened to be looking.',
      ),
    );
  });
};

/* ── Container images ─────────────────────────────────────────────────────── */

/**
 * A registry reference: a dotted host, then a path, then an optional tag and an
 * optional digest. Deliberately not anchored on a known-registry allowlist — a
 * registry this repository has not used before should be caught, not skipped.
 *
 * The tag alternation accepts `${VAR}` and `${{ expr }}` as well as a literal,
 * because `ghcr.io/owner/image:${SCANNER_VERSION}` is not a pinned reference —
 * it is an unpinned one whose tag is chosen somewhere else in the file. Reading
 * it as "no tag at all" would have let exactly that shape through.
 */
const IMAGE_REFERENCE =
  /(?<![\w./@:${-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?)\/([a-z0-9][a-z0-9._/-]*?)(?::(\$\{\{[^}]*\}\}|\$\{[^}]*\}|[\w][\w.-]*))?(?:@sha256:([0-9a-zA-Z]*))?(?![\w./@:-])/g;

/**
 * Hosts that look like registries and are not. Kubernetes and AWS annotation
 * keys are `domain/path` by construction — `kubernetes.io/role/elb` parses as a
 * registry reference and is a label on a subnet.
 *
 * The list only silences references that carry no digest, which is the only
 * shape an annotation key ever has. `kubernetes.io/x@sha256:…` is not something
 * anyone writes by accident, so a digested reference is reported from any host
 * — including as `image-outside-pin-module`, which is the rule that would
 * otherwise be the easiest to slip past.
 */
const NON_REGISTRY_HOSTS: readonly string[] = [
  'kubernetes.io',
  'k8s.io',
  'amazonaws.com',
  'sigstore.dev',
  'slsa.dev',
  'in-toto.io',
  'spdx.org',
  'cyclonedx.org',
  'opencontainers.org',
  'schemastore.org',
  'json-schema.org',
  'github.com',
  'goharbor.io',
];

const isNonRegistryHost = (host: string): boolean =>
  NON_REGISTRY_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));

/**
 * The consumer's own ECR. Their application image's digest is decided per
 * release, so it cannot be a literal here; that it is *deployed* by digest is
 * `audit-image-signing.ts`'s rule.
 */
const isOwnEcrHost = (host: string): boolean => /\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/.test(host);

export interface ImageReference {
  readonly file: string;
  readonly line: number;
  /** The full matched reference, as written. */
  readonly text: string;
  readonly host: string;
  readonly tag?: string;
  /** The characters after `@sha256:`, if the reference carried a digest. */
  readonly digest?: string;
}

/** Third-party registry references in one file, comments already removed. */
export const parseImages = (file: SourceFile): ImageReference[] =>
  file.text.split('\n').flatMap((text, index) =>
    [...text.matchAll(IMAGE_REFERENCE)].flatMap((match) => {
      const [full, host, , tag, digest] = match;
      if (isOwnEcrHost(host)) return [];
      if (isNonRegistryHost(host) && digest === undefined) return [];

      return [
        {
          file: file.path,
          line: index + 1,
          text: full,
          host,
          ...(tag !== undefined ? { tag } : {}),
          ...(digest !== undefined ? { digest } : {}),
        },
      ];
    }),
  );

/** Where the pinned image table lives. Every other CDK source file defers to it. */
export const PIN_MODULE = 'aws/cdk/lib/base-images.ts';

const CDK_SOURCE = /^aws\/cdk\/(lib|bin)\//;

export const auditImages = (images: readonly ImageReference[]): Violation[] =>
  images.flatMap((image) => {
    const violations: Violation[] = [];

    if (image.digest === undefined) {
      violations.push(
        violation(
          'image-not-pinned',
          image.file,
          image.line,
          `\`${image.text}\` names a container image by tag. The registry decides what that ` +
            'tag means at every pull, so two replicas of one service can be running different ' +
            'code with nothing in the console or in CloudFormation drift saying so, and a ' +
            'rollback rolls back to the same moving tag. Pin it by digest — ' +
            '`repository@sha256:<64 hex>` — and record the version it came from beside it.',
        ),
      );
    } else if (!/^[0-9a-f]{64}$/.test(image.digest)) {
      violations.push(
        violation(
          'image-digest-malformed',
          image.file,
          image.line,
          `\`${image.text}\` carries an \`@sha256:\` that is not 64 lowercase hex characters ` +
            `(got ${image.digest.length}). A truncated or mistyped digest does not resolve to ` +
            'something older, it fails the pull at task placement — which is a deploy-time ' +
            'outage rather than a review comment.',
        ),
      );
    }

    if (CDK_SOURCE.test(image.file) && image.file !== PIN_MODULE) {
      violations.push(
        violation(
          'image-outside-pin-module',
          image.file,
          image.line,
          `\`${image.text}\` names a third-party image outside \`${PIN_MODULE}\`. Pins spread ` +
            'across stacks are pins that get updated one at a time; keep the table in one ' +
            'place and import the constant.',
        ),
      );
    }

    return violations;
  });

/* ── Comment stripping ────────────────────────────────────────────────────── */

/**
 * Blank out `#` comments outside quotes, preserving line count and column
 * positions so a reported line number still matches the file on disk.
 *
 * The image rules read what runs; a usage example in a header comment is prose,
 * and the deploy templates document a caller passing their own `:sha-abc123`
 * tag on purpose. The action rules read the raw text instead — the version
 * label they check *is* a comment.
 */
export const stripHashComments = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      let quote: string | undefined;
      for (let i = 0; i < line.length; i += 1) {
        const character = line[i];
        if (quote !== undefined) {
          if (character === '\\') i += 1;
          else if (character === quote) quote = undefined;
        } else if (character === '"' || character === "'") {
          quote = character;
        } else if (character === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');

/**
 * The same, for `//` and `/* *\/` comments in TypeScript.
 *
 * Quote- and template-literal-aware, but not a JavaScript lexer: a regular
 * expression literal containing an escaped slash pair (`/x\/\//`) would read as
 * the start of a line comment and take the rest of the line with it. There is
 * no such literal in `lib/` or `bin/`, and the failure mode is a missed
 * finding rather than a false one — write the pattern with a character class
 * (`[/]`) if one is ever needed on a line that also names an image.
 */
export const stripTypeScriptComments = (text: string): string => {
  const output: string[] = [];
  let quote: string | undefined;
  let block = false;

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    const next = text[i + 1];

    if (block) {
      if (character === '*' && next === '/') {
        block = false;
        i += 1;
      } else if (character === '\n') {
        output.push('\n');
      }
      continue;
    }

    if (quote !== undefined) {
      output.push(character);
      if (character === '\\') {
        output.push(next ?? '');
        i += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output.push(character);
      continue;
    }

    if (character === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      output.push('\n');
      continue;
    }

    if (character === '/' && next === '*') {
      block = true;
      i += 1;
      continue;
    }

    output.push(character);
  }

  return output.join('');
};

/* ── Reading the repository ───────────────────────────────────────────────── */

const readDirectory = (root: string, relative: string, extensions: readonly string[]): SourceFile[] => {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory)
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .sort()
    .map((name) => ({
      path: path.posix.join(...relative.split(path.sep), name),
      text: fs.readFileSync(path.join(directory, name), 'utf8'),
    }));
};

/**
 * Every workflow this repository runs *and* every template it ships. The
 * templates matter more, not less: an unpinned action in a template is an
 * unpinned action in every repository that copied it.
 */
export const readWorkflowSources = (root: string): SourceFile[] => [
  ...readDirectory(root, path.join('.github', 'workflows'), ['.yml', '.yaml']),
  ...readDirectory(root, 'workflow-templates', ['.yml', '.yaml']),
];

/** Shell a workflow shells out to, plus the CDK source that names images. */
export const readImageSources = (root: string): SourceFile[] => [
  ...readDirectory(root, path.join('.github', 'scripts'), ['.sh']),
  ...readDirectory(root, path.join('aws', 'cdk', 'lib'), ['.ts']),
  ...readDirectory(root, path.join('aws', 'cdk', 'bin'), ['.ts']),
];

const uncomment = (file: SourceFile): SourceFile => ({
  path: file.path,
  text: file.path.endsWith('.ts')
    ? stripTypeScriptComments(file.text)
    : stripHashComments(file.text),
});

export const auditDependencyPins = (
  workflows: readonly SourceFile[],
  imageSources: readonly SourceFile[],
): Violation[] => {
  const uses = workflows.flatMap(parseUses);
  const images = [...workflows, ...imageSources].map(uncomment).flatMap(parseImages);

  return [...auditUses(uses), ...auditPinConsistency(uses), ...auditImages(images)];
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations
    .map((v) => `${v.file}  ${v.location}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const workflows = readWorkflowSources(root);
  const imageSources = readImageSources(root);

  if (workflows.length === 0) {
    console.error(`No workflows found under ${root}.`);
    process.exit(1);
  }

  const violations = auditDependencyPins(workflows, imageSources);

  if (violations.length > 0) {
    console.error(`\n${violations.length} dependency pinning violation(s):\n`);
    console.error(formatViolations(violations));
    console.error('\nSee docs/dependency-pinning.md.\n');
    process.exit(1);
  }

  const uses = workflows.flatMap(parseUses);
  console.log(
    `${uses.length} action reference(s) across ${workflows.length} workflow(s) and every ` +
      `third-party image in ${imageSources.length} source file(s): pinned by commit or digest, ` +
      'and labelled with the version it came from.',
  );
}
