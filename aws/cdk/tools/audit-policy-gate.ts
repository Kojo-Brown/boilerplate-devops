#!/usr/bin/env node
/**
 * Audit the Conftest/OPA policy gate — the policies, the canary, and the CI
 * wiring that runs them.
 *
 * `.github/scripts/run-policy-gate.sh` checks at run time that the gate
 * evaluated something. This checks, in review, the things that are still true
 * when it does: a policy pack can be complete, evaluated and green while
 * enforcing nothing, and every one of those states reads in a diff exactly like
 * working policy.
 *
 * The failure modes this exists for, all of them observed against conftest
 * 0.69.0 / OPA 1.19.0 rather than read about:
 *
 *   • **A namespace nobody scans.** conftest evaluates the `main` package and
 *     nothing else unless told otherwise. Point it at a pack that declares
 *     `package cloudformation` and it prints `0 tests, 0 passed, 0 failures`
 *     and exits 0 — and so does `--namespace cloudfromation`, because a
 *     namespace that matches no package is not an error. The output of a gate
 *     that evaluated nothing and one that found nothing differ by a number
 *     nobody reads.
 *
 *   • **`warn` where `deny` was meant.** A `warn` rule prints a yellow line and
 *     exits 0. Two characters, no other difference in the source, and the gate
 *     stops being one.
 *
 *   • **A rule name conftest does not collect.** conftest gathers `deny`,
 *     `violation`, `warn` and their `deny_*` suffixed forms. `denied`,
 *     `denies`, `deny-image` or `Deny` are ordinary rules that nothing ever
 *     queries: no parse error, no warning, no finding, ever.
 *
 *   • **A rule nobody has seen fire.** `policy/fixtures/deny-canary.json` trips
 *     every rule in the pack and the gate refuses to pass if it does not — but
 *     only for rules listed in `policy/canary-expectations.txt`. A rule added
 *     without an entry there is a rule outside the canary's reach, which is how
 *     a rule that has silently stopped working gets weeks of green checks.
 *
 *   • **An unpinned scanner.** The gate's verdict is whatever this binary says.
 *     Fetching "the latest release" of it over the network on every run makes
 *     the merge decision depend on a third party's publishing schedule, and a
 *     release asset can be replaced in place under an unchanged tag.
 *
 * The rules, and the failure each one prevents:
 *
 *   policy-tree-empty          the pack has no policy files at all
 *   rule-not-collectable       a rule head conftest never queries
 *   rule-id-missing            a rule whose message carries no `[rule-id]`, so
 *                              neither the canary nor a reader can name it
 *   package-not-scanned        a package no `--namespace` in the gate names
 *   warn-without-fail-on-warn  a `warn` rule with nothing making warnings fatal
 *   rule-without-test          a rule id no `_test.rego` exercises
 *   canary-expectation-missing a rule id the canary is not required to trip
 *   canary-expectation-orphan  an expectation for a rule that no longer exists
 *   conftest-unpinned          an install step with no exact version, or one
 *                              that does not verify what it downloaded
 *   gate-not-run-in-ci         no job runs the gate script at all
 *
 * **Out of scope, deliberately.** Whether the rules are *right* is the
 * policies' own unit tests (`conftest verify`) and the canary; this tool never
 * evaluates Rego, and could not without shipping an OPA runtime into the CDK
 * job. It reads the sources as text, which is why `rule-not-collectable`
 * matches on rule heads at column zero rather than pretending to parse a
 * language it does not implement.
 *
 * Usage:
 *   npm run audit:policy                            # repository root
 *   npx ts-node tools/audit-policy-gate.ts <dir>
 *
 * Exits non-zero when anything is found. See docs/policy-as-code.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';

export type ViolationRule =
  | 'policy-tree-empty'
  | 'rule-not-collectable'
  | 'rule-id-missing'
  | 'package-not-scanned'
  | 'warn-without-fail-on-warn'
  | 'rule-without-test'
  | 'canary-expectation-missing'
  | 'canary-expectation-orphan'
  | 'conftest-unpinned'
  | 'gate-not-run-in-ci';

export interface Violation {
  readonly rule: ViolationRule;
  /** Repository-relative path, e.g. `policy/cloudformation/tags.rego`. */
  readonly file: string;
  /** `line <n>` where there is one line to blame, otherwise a description. */
  readonly location: string;
  readonly message: string;
}

const violation = (
  rule: ViolationRule,
  file: string,
  location: string,
  message: string,
): Violation => ({ rule, file, location, message });

const atLine = (
  rule: ViolationRule,
  file: string,
  line: number,
  message: string,
): Violation => violation(rule, file, `line ${line}`, message);

/** A file as this tool reads it: repository-relative path plus raw contents. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/* ── Reading the policy tree ──────────────────────────────────────────────── */

/**
 * The rule names conftest queries. Anything else in a policy file is a helper,
 * and a helper is never a finding.
 *
 * conftest also accepts a suffixed form — `deny_image_pinning` — which is why
 * this is a prefix test and not set membership.
 */
const COLLECTED_RULE_NAMES = ['deny', 'violation', 'warn'] as const;

export type CollectedKind = (typeof COLLECTED_RULE_NAMES)[number];

/**
 * A rule head at column zero: `deny contains msg if {`, `warn[msg] {`,
 * `deny_image := …`. Indented text is a rule *body*, where the same words are
 * ordinary references.
 */
const RULE_HEAD = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:contains\b|\[|:=|=|if\b|\{)/;

/**
 * Names close enough to a collected one to have been meant as it.
 *
 * An explicit list rather than "anything starting with `den`": a helper called
 * `denied_ports` is a reasonable thing to write, and a gate that reports it is
 * a gate people learn to override. What is here is what actually gets typed —
 * `denied` and `denies` for the rule itself, the plural of `violation`, and the
 * capitalised spellings a reader coming from another policy language reaches
 * for. None of them is an error in Rego and none of them is ever queried.
 */
const NEAR_MISS_RULE_NAMES = new Set([
  'denied',
  'denies',
  'denial',
  'denys',
  'violate',
  'violates',
  'violated',
  'violations',
  'warns',
  'warned',
  'warning',
  'warnings',
]);

/**
 * `denied`, `Deny`, `WARN`, and the same with a `_suffix` conftest would have
 * collected had the stem been spelled correctly.
 */
export const isNearMissRuleName = (name: string): boolean => {
  const stem = name.split('_')[0].toLowerCase();
  if (NEAR_MISS_RULE_NAMES.has(stem)) return true;
  // `Deny` and `DENY` are collected by neither conftest nor this check's
  // case-sensitive `collectedKind`, and are the one case where the *right* word
  // is present.
  return (
    COLLECTED_RULE_NAMES.some((kind) => stem === kind) &&
    collectedKind(name) === undefined
  );
};

export const collectedKind = (name: string): CollectedKind | undefined =>
  COLLECTED_RULE_NAMES.find((kind) => name === kind || name.startsWith(`${kind}_`));

/** `[rule-id]` at the start of a message string, as the whole pack writes them. */
const RULE_ID_IN_MESSAGE = /"\[([a-z][a-z0-9-]*)\]/g;

const PACKAGE_DECLARATION = /^package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*$/m;

export const declaredPackage = (file: SourceFile): string | undefined =>
  PACKAGE_DECLARATION.exec(file.text)?.[1];

export const isTestFile = (file: SourceFile): boolean => file.path.endsWith('_test.rego');

/** Every `[rule-id]` a file's message strings can produce. */
export const ruleIdsIn = (text: string): Set<string> => {
  const ids = new Set<string>();
  for (const match of text.matchAll(RULE_ID_IN_MESSAGE)) ids.add(match[1]);
  return ids;
};

/**
 * Which of `known` a file names as a bare quoted string.
 *
 * This is how a test file refers to a rule: the pack's tests assert on the *set
 * of rule ids* a template produces — `rule_ids(deny) == {"required-tags"}` —
 * rather than on message text, so the bracketed form never appears there.
 * Intersecting with the ids the policies actually declare keeps this from
 * matching every other string literal in the file.
 */
export const mentionedIdsIn = (text: string, known: ReadonlySet<string>): Set<string> => {
  const ids = new Set<string>();
  for (const match of text.matchAll(/"([a-z][a-z0-9-]*)"/g)) {
    if (known.has(match[1])) ids.add(match[1]);
  }
  return ids;
};

export interface RuleHead {
  readonly name: string;
  readonly kind: CollectedKind;
  /** 1-based line of the head. */
  readonly line: number;
  /** The rule's source, head to the line before the next head or EOF. */
  readonly body: string;
}

/**
 * Split a policy file into its collected rules.
 *
 * Rego has no statement terminator and a rule body can contain braces, so this
 * splits on the next head at column zero rather than counting them. That is
 * exact for the layout `opa fmt` produces, which is what everything here is
 * formatted with.
 */
export const collectedRules = (file: SourceFile): RuleHead[] => {
  const lines = file.text.split('\n');
  const heads: { name: string; kind: CollectedKind; index: number }[] = [];
  const boundaries: number[] = [];

  lines.forEach((line, index) => {
    const match = RULE_HEAD.exec(line);
    if (match === null) return;

    boundaries.push(index);
    const kind = collectedKind(match[1]);
    if (kind !== undefined) heads.push({ name: match[1], kind, index });
  });

  return heads.map((head) => {
    const next = boundaries.find((boundary) => boundary > head.index) ?? lines.length;
    return {
      name: head.name,
      kind: head.kind,
      line: head.index + 1,
      body: lines.slice(head.index, next).join('\n'),
    };
  });
};

/* ── The policies themselves ──────────────────────────────────────────────── */

export const auditPolicyFile = (file: SourceFile): Violation[] => {
  const violations: Violation[] = [];

  file.text.split('\n').forEach((line, index) => {
    const match = RULE_HEAD.exec(line);
    if (match === null) return;

    const name = match[1];
    if (collectedKind(name) !== undefined) return;
    if (!isNearMissRuleName(name)) return;

    violations.push(
      atLine(
        'rule-not-collectable',
        file.path,
        index + 1,
        `\`${name}\` is not a rule conftest queries. It collects \`deny\`, \`violation\`, ` +
          '`warn` and their `deny_*` suffixed forms and nothing else, so this rule is ' +
          'valid Rego that is never evaluated: no parse error, no warning, and no ' +
          'finding it could ever report.',
      ),
    );
  });

  if (isTestFile(file)) return violations;

  for (const rule of collectedRules(file)) {
    if (ruleIdsIn(rule.body).size === 0) {
      violations.push(
        atLine(
          'rule-id-missing',
          file.path,
          rule.line,
          `\`${rule.name}\` produces a message with no \`[rule-id]\` prefix. The canary ` +
            'in `.github/scripts/run-policy-gate.sh` identifies rules by that prefix, so ' +
            'a rule without one cannot be required to fire and is outside the check that ' +
            'notices rules which have stopped working.',
        ),
      );
    }
  }

  return violations;
};

/* ── The gate script ──────────────────────────────────────────────────────── */

export interface GateScript extends SourceFile {}

/**
 * Which namespaces the gate script actually evaluates.
 *
 * Read as text on purpose: the failure being looked for is a package name and a
 * `--namespace` value that no longer agree, and the only place both appear is
 * the shell. A typo'd namespace is not a shell error, not a conftest error, and
 * not visible in conftest's output except as a count of zero.
 */
/**
 * The namespaces the gate passes to `conftest test`, with shell variables
 * resolved against their assignment in the same script.
 *
 * Resolving the variable is the point. `--namespace "$namespace"` and
 * `namespace="cloudformation"` are written far apart, and the failure is that
 * one of them changed; a check that only looked for the package name *somewhere*
 * in the file would be satisfied by the `policy/cloudformation` path in an
 * unrelated line, which is exactly the case a typo'd namespace produces.
 */
export const scannedNamespaces = (script: GateScript): Set<string> => {
  const code = executableLines(script.text);
  const assignments = new Map<string, string>();

  for (const match of code.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/gm)) {
    assignments.set(match[1], match[2] ?? match[3] ?? match[4]);
  }

  const namespaces = new Set<string>();

  for (const match of code.matchAll(/--namespace[\s=]+(\S+)/g)) {
    const token = match[1].replace(/^["']|["']$/g, '');
    const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(token);
    const resolved = variable === null ? token : assignments.get(variable[1]);
    if (resolved !== undefined && resolved.length > 0) namespaces.add(resolved);
  }

  return namespaces;
};

export const scansEveryPackage = (
  script: GateScript,
  packages: ReadonlySet<string>,
): string[] => {
  if (/--all-namespaces\b/.test(executableLines(script.text))) return [];

  const scanned = scannedNamespaces(script);
  return [...packages].filter((name) => !scanned.has(name)).sort();
};

export const makesWarningsFatal = (script: GateScript): boolean =>
  /--fail-on-warn\b/.test(executableLines(script.text));

/**
 * The script with its shell comments removed.
 *
 * Every check here asks whether the gate *does* something, and a comment saying
 * why it deliberately does not — this script has one explaining the choice of
 * `--namespace` over `--all-namespaces` — would otherwise satisfy the check by
 * mentioning the flag. Cutting at the first unquoted-looking `#` is an
 * approximation, but the only thing that can go wrong is reading less of the
 * script than there is, which costs a false finding rather than a missed one.
 */
const executableLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');

/* ── The CI wiring ────────────────────────────────────────────────────────── */

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export interface WorkflowFile {
  readonly path: string;
  readonly document: unknown;
}

export interface WorkflowStep {
  readonly name: string;
  readonly run: string;
  readonly env: Record<string, string>;
}

export const workflowSteps = (workflow: WorkflowFile): WorkflowStep[] => {
  const jobs = asRecord(asRecord(workflow.document)?.jobs) ?? {};

  return Object.values(jobs).flatMap((job) =>
    asArray(asRecord(job)?.steps).map((step) => {
      const record = asRecord(step) ?? {};
      const env = asRecord(record.env) ?? {};

      return {
        name: typeof record.name === 'string' ? record.name : '<unnamed>',
        run: typeof record.run === 'string' ? record.run : '',
        env: Object.fromEntries(
          Object.entries(env).map(([key, value]) => [key, String(value)]),
        ),
      };
    }),
  );
};

/** An exact release: `0.69.0`. `latest`, `v0.69` and `${{ inputs.x }}` are not. */
const EXACT_VERSION = /^v?\d+\.\d+\.\d+$/;

const SHA256_DIGEST = /^[0-9a-f]{64}$/;

/**
 * A step that installs conftest. Matched on the download rather than on the
 * step's name, which is prose and can say anything.
 */
export const installsConftest = (step: WorkflowStep): boolean =>
  step.run.includes('open-policy-agent/conftest');

export const auditInstallStep = (file: string, step: WorkflowStep): Violation[] => {
  const values = Object.values(step.env);
  const version = values.find((value) => EXACT_VERSION.test(value));
  const digest = values.find((value) => SHA256_DIGEST.test(value));
  const violations: Violation[] = [];

  if (version === undefined) {
    violations.push(
      violation(
        'conftest-unpinned',
        file,
        `step "${step.name}"`,
        'installs conftest without an exact version in the step environment. The gate\'s ' +
          "verdict is whatever this binary says, so fetching whatever is newest makes " +
          "the merge decision depend on a third party's publishing schedule — and a " +
          'release that changes what a rule matches turns every pull request red at ' +
          'once, on a day nobody changed a policy.',
      ),
    );
  }

  if (digest === undefined || !step.run.includes('sha256sum')) {
    violations.push(
      violation(
        'conftest-unpinned',
        file,
        `step "${step.name}"`,
        'downloads conftest without verifying the bytes against a SHA-256 recorded here. ' +
          'A version tag names a release, not its contents: release assets can be ' +
          'replaced in place, and this binary decides whether the build may merge. Add ' +
          'the digest to the step environment and `sha256sum -c` it before unpacking.',
      ),
    );
  }

  return violations;
};

export interface AuditInput {
  /** Every `.rego` under `policy/`, test files included. */
  readonly policyFiles: readonly SourceFile[];
  readonly gateScript: GateScript | undefined;
  /** `policy/canary-expectations.txt`, or undefined when absent. */
  readonly expectations: SourceFile | undefined;
  readonly workflows: readonly WorkflowFile[];
}

export const parseExpectations = (file: SourceFile): Set<string> =>
  new Set(
    file.text
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter((line) => line.length > 0),
  );

export const auditPolicyGate = (input: AuditInput): Violation[] => {
  const violations: Violation[] = [];
  const policies = input.policyFiles.filter((file) => !isTestFile(file));

  if (policies.length === 0) {
    violations.push(
      violation(
        'policy-tree-empty',
        'policy/',
        'the policy tree',
        'there are no policy files here. conftest exits 0 with "0 tests" when it is ' +
          'handed no rules, so an empty pack is a green check, not an error.',
      ),
    );
    return violations;
  }

  for (const file of input.policyFiles) violations.push(...auditPolicyFile(file));

  const packages = new Set(
    input.policyFiles.map(declaredPackage).filter((name): name is string => name !== undefined),
  );

  const declaredIds = new Set<string>();
  for (const file of policies) for (const id of ruleIdsIn(file.text)) declaredIds.add(id);

  const testedIds = new Set<string>();
  for (const file of input.policyFiles.filter(isTestFile)) {
    for (const id of mentionedIdsIn(file.text, declaredIds)) testedIds.add(id);
  }

  const warnRules = policies.flatMap((file) =>
    collectedRules(file)
      .filter((rule) => rule.kind === 'warn')
      .map((rule) => ({ file, rule })),
  );

  if (input.gateScript === undefined) {
    violations.push(
      violation(
        'gate-not-run-in-ci',
        '.github/scripts/run-policy-gate.sh',
        'the gate script',
        'the policy tree exists but the script that runs it does not, so nothing ' +
          'evaluates these policies against anything.',
      ),
    );
  } else {
    for (const name of scansEveryPackage(input.gateScript, packages)) {
      violations.push(
        violation(
          'package-not-scanned',
          input.gateScript.path,
          `package ${name}`,
          `nothing in the gate names the \`${name}\` package, so conftest never ` +
            'evaluates it. This does not fail: conftest reports "0 tests, 0 passed, 0 ' +
            'failures" and exits 0 for a namespace that matches no package, which is ' +
            'indistinguishable from a clean scan in every output it produces.',
        ),
      );
    }

    if (warnRules.length > 0 && !makesWarningsFatal(input.gateScript)) {
      for (const { file, rule } of warnRules) {
        violations.push(
          atLine(
            'warn-without-fail-on-warn',
            file.path,
            rule.line,
            `\`${rule.name}\` is a warn rule and the gate does not pass ` +
              '`--fail-on-warn`, so it prints a yellow line and exits 0. Make it a ' +
              '`deny`, or make warnings fatal — a finding nothing fails on is a finding ' +
              'nobody reads twice.',
          ),
        );
      }
    }

    const gateJobRuns = input.workflows.some((workflow) =>
      workflowSteps(workflow).some((step) => step.run.includes('run-policy-gate.sh')),
    );

    if (!gateJobRuns) {
      violations.push(
        violation(
          'gate-not-run-in-ci',
          input.gateScript.path,
          'the gate script',
          'no job in .github/workflows runs this script. A policy pack nothing invokes ' +
            'is documentation of an intention.',
        ),
      );
    }
  }

  const installSteps = input.workflows.flatMap((workflow) =>
    workflowSteps(workflow)
      .filter(installsConftest)
      .map((step) => ({ file: workflow.path, step })),
  );

  for (const { file, step } of installSteps) violations.push(...auditInstallStep(file, step));

  if (input.expectations === undefined) {
    violations.push(
      violation(
        'canary-expectation-missing',
        'policy/canary-expectations.txt',
        'the canary expectations',
        'there is no expectations file, so nothing requires any rule to fire on the ' +
          'canary. A rule that silently stopped matching would show as a clean scan.',
      ),
    );
  } else {
    const expected = parseExpectations(input.expectations);

    for (const id of [...declaredIds].sort()) {
      if (expected.has(id)) continue;
      violations.push(
        violation(
          'canary-expectation-missing',
          input.expectations.path,
          `rule ${id}`,
          `\`${id}\` is not listed, so the canary does not require it to fire. Add a ` +
            'resource to `policy/fixtures/deny-canary.json` that trips it and list it ' +
            'here; otherwise nothing notices the day it stops working.',
        ),
      );
    }

    for (const id of [...expected].sort()) {
      if (declaredIds.has(id)) continue;
      violations.push(
        violation(
          'canary-expectation-orphan',
          input.expectations.path,
          `rule ${id}`,
          `\`${id}\` is expected on the canary but no policy reports it. The gate fails ` +
            'on every run until this is removed or the rule is restored — which is ' +
            'correct, and this says which of the two it is.',
        ),
      );
    }
  }

  for (const id of [...declaredIds].sort()) {
    if (testedIds.has(id)) continue;
    violations.push(
      violation(
        'rule-without-test',
        'policy/',
        `rule ${id}`,
        `no \`_test.rego\` mentions \`${id}\`. The canary proves it fires on one ` +
          'handcrafted resource; only a unit test says what it does *not* fire on, and ' +
          'a rule with no negative case is how a gate starts failing correct templates.',
      ),
    );
  }

  return violations;
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations
    .map((v) => `${v.file}  ${v.location}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');

/* ── Reading the repository ───────────────────────────────────────────────── */

const readIfPresent = (root: string, relative: string): SourceFile | undefined => {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return undefined;
  return { path: relative, text: fs.readFileSync(absolute, 'utf8') };
};

export const readPolicyFiles = (root: string, relative = 'policy'): SourceFile[] => {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const child = path.posix.join(...relative.split(path.sep), entry.name);
      if (entry.isDirectory()) return readPolicyFiles(root, path.join(relative, entry.name));
      if (!entry.name.endsWith('.rego')) return [];
      return [{ path: child, text: fs.readFileSync(path.join(root, child), 'utf8') }];
    });
};

export const readWorkflows = (root: string): WorkflowFile[] => {
  const directory = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => ({
      path: path.posix.join('.github', 'workflows', name),
      document: load(fs.readFileSync(path.join(directory, name), 'utf8')),
    }));
};

export const readAuditInput = (root: string): AuditInput => ({
  policyFiles: readPolicyFiles(root),
  gateScript: readIfPresent(root, path.join('.github', 'scripts', 'run-policy-gate.sh')),
  expectations: readIfPresent(root, path.join('policy', 'canary-expectations.txt')),
  workflows: readWorkflows(root),
});

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const input = readAuditInput(root);
  const violations = auditPolicyGate(input);

  if (violations.length > 0) {
    console.error(`\n${violations.length} policy-gate violation(s):\n`);
    console.error(formatViolations(violations));
    console.error('\nSee docs/policy-as-code.md.\n');
    process.exit(1);
  }

  const policies = input.policyFiles.filter((file) => !isTestFile(file));
  const ids = new Set(policies.flatMap((file) => [...ruleIdsIn(file.text)]));
  console.log(
    `${ids.size} policy rule(s) across ${policies.length} file(s) in ${root}: ` +
      'every one is collectable, scanned, tested, and required to fire on the canary.',
  );
}
