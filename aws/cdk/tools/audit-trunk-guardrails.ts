#!/usr/bin/env node
/**
 * Audit the trunk-based-development guardrails for internal consistency.
 *
 * Trunk-based development on GitHub rests on three settings that live in three
 * different places and are edited by different people at different times:
 *
 *   • the **required status checks** and **merge queue** configuration, which
 *     live in a repository ruleset (`.github/rulesets/*.json` here, applied with
 *     `gh api` — see `docs/trunk-based-development.md`);
 *   • the **workflows** that actually produce those checks
 *     (`.github/workflows/*.yml`);
 *   • the **branch hygiene** gate that keeps branches short-lived.
 *
 * Nothing in GitHub reconciles the three. A ruleset can require a check that no
 * workflow produces, and a workflow can stop producing a check the ruleset still
 * requires. Both failure modes are silent at edit time and total at merge time:
 * the pull request sits at "Expected — waiting for status to be reported"
 * forever, and with a merge queue enabled it takes the whole queue down with it,
 * because an entry that never reports is an entry that never dequeues.
 *
 * That is the class of bug this script exists to catch. It is a *consistency*
 * check, not a linter — `actionlint` already decides whether a workflow is valid
 * YAML with valid expressions. This decides whether the guardrails agree with
 * each other.
 *
 * The rules, and the failure each one prevents:
 *
 *   unknown-required-check          ruleset requires a check nothing produces
 *   ambiguous-required-check        two jobs answer to the same check name
 *   required-check-missing-*        provider does not run on the events that matter
 *   required-check-path-filtered    provider is skipped by a path filter
 *   required-check-conditional-job  provider can skip itself via a job-level `if`
 *   required-check-matrix-job       matrix legs report `name (leg)`, never `name`
 *   queue-cancelling-concurrency    one queue entry cancels another
 *   strict-policy-with-merge-queue  branch-up-to-date policy fights the queue
 *   merge-method-mismatch           queue merges a way the PR rule forbids
 *   linear-history-allows-merge     linear history vs. an allowed merge commit
 *   unpinned-required-check         check name not bound to the app that reports it
 *   always-bypass-actor             an actor for whom none of the above applies
 *   missing-rule / ruleset-*        the ruleset is not the thing it claims to be
 *
 * Usage:
 *   npm run audit:trunk                                  # repository root
 *   npx ts-node tools/audit-trunk-guardrails.ts <dir>
 *
 * Exits non-zero when anything is found.
 */
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';

export type ViolationRule =
  | 'unknown-required-check'
  | 'ambiguous-required-check'
  | 'required-check-missing-pull-request'
  | 'required-check-missing-merge-group'
  | 'required-check-path-filtered'
  | 'required-check-conditional-job'
  | 'required-check-matrix-job'
  | 'queue-cancelling-concurrency'
  | 'strict-policy-with-merge-queue'
  | 'merge-method-mismatch'
  | 'linear-history-allows-merge-commits'
  | 'unpinned-required-check'
  | 'always-bypass-actor'
  | 'missing-rule'
  | 'ruleset-not-active'
  | 'ruleset-not-default-branch';

export interface Violation {
  readonly rule: ViolationRule;
  /** Where a reader should go to fix it — a ruleset path or a workflow path. */
  readonly file: string;
  readonly message: string;
}

/** A parsed workflow, keyed by the path it was read from. */
export interface WorkflowFile {
  /** Repository-relative, e.g. `.github/workflows/ci.yml`. */
  readonly path: string;
  /** Whatever `js-yaml` produced. Narrowed defensively — this is user input. */
  readonly document: unknown;
}

/**
 * The GitHub Actions GitHub App. A required status check is matched by name
 * alone unless it is pinned to an app id, so pinning is what stops an unrelated
 * integration — or a PR author with a token — from reporting a green check
 * called `Checkov` and satisfying the rule without running anything.
 */
export const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

/** Rule types a ruleset must carry to implement the guardrails in the docs. */
export const REQUIRED_RULE_TYPES: readonly string[] = [
  'pull_request',
  'required_status_checks',
  'merge_queue',
  'required_linear_history',
  'non_fast_forward',
  'deletion',
];

/**
 * Contexts that make a concurrency group vary per merge-queue entry. A group
 * that contains none of them is shared by every entry, and `cancel-in-progress`
 * then makes each new entry cancel the one ahead of it.
 */
const PER_ENTRY_CONCURRENCY_CONTEXTS: readonly string[] = [
  'github.ref',
  'github.head_ref',
  'github.run_id',
  'github.event.merge_group',
  'github.event.number',
  'github.event.pull_request.number',
];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * The `on:` block, normalised to a map of event name → configuration.
 *
 * GitHub accepts three shapes — `on: push`, `on: [push, pull_request]`, and the
 * mapping form — and all three mean the same thing. Only the mapping form can
 * carry filters, so the scalar and list forms normalise to an undefined config.
 */
export const workflowTriggers = (document: unknown): Map<string, unknown> => {
  const on = asRecord(document)?.on;
  const triggers = new Map<string, unknown>();

  if (typeof on === 'string') {
    triggers.set(on, undefined);
    return triggers;
  }

  if (Array.isArray(on)) {
    for (const event of on) {
      const name = asString(event);
      if (name !== undefined) triggers.set(name, undefined);
    }
    return triggers;
  }

  for (const [name, config] of Object.entries(asRecord(on) ?? {})) {
    triggers.set(name, config);
  }

  return triggers;
};

export interface JobProvider {
  readonly workflow: WorkflowFile;
  /** The key under `jobs:`. */
  readonly id: string;
  readonly job: Record<string, unknown>;
}

/**
 * The check-run name GitHub reports for a job: its `name` if it has one, and
 * otherwise the job id. This is the string a required status check must match.
 */
export const checkNameForJob = (id: string, job: Record<string, unknown>): string =>
  asString(job.name) ?? id;

/** Every job across every workflow, indexed by the check name it reports under. */
export const indexJobsByCheckName = (
  workflows: readonly WorkflowFile[],
): Map<string, JobProvider[]> => {
  const index = new Map<string, JobProvider[]>();

  for (const workflow of workflows) {
    const jobs = asRecord(asRecord(workflow.document)?.jobs) ?? {};

    for (const [id, value] of Object.entries(jobs)) {
      const job = asRecord(value);
      if (job === undefined) continue;

      const name = checkNameForJob(id, job);
      const providers = index.get(name) ?? [];
      providers.push({ workflow, id, job });
      index.set(name, providers);
    }
  }

  return index;
};

interface RulesetRule {
  readonly type: string;
  readonly parameters: Record<string, unknown>;
}

const rulesetRules = (ruleset: unknown): RulesetRule[] =>
  asArray(asRecord(ruleset)?.rules).flatMap((value) => {
    const rule = asRecord(value);
    const type = asString(rule?.type);
    return type === undefined ? [] : [{ type, parameters: asRecord(rule?.parameters) ?? {} }];
  });

const ruleOfType = (rules: readonly RulesetRule[], type: string): RulesetRule | undefined =>
  rules.find((rule) => rule.type === type);

/** Check the ruleset against itself: is it active, on trunk, and complete? */
const auditRulesetShape = (
  ruleset: unknown,
  rules: readonly RulesetRule[],
  rulesetPath: string,
): Violation[] => {
  const violations: Violation[] = [];
  const record = asRecord(ruleset) ?? {};

  if (asString(record.enforcement) !== 'active') {
    violations.push({
      rule: 'ruleset-not-active',
      file: rulesetPath,
      message:
        `enforcement is "${String(record.enforcement)}" — only "active" enforces anything. ` +
        '"evaluate" reports what would have happened and merges anyway.',
    });
  }

  const included = asArray(asRecord(asRecord(record.conditions)?.ref_name)?.include).map(asString);

  if (!included.includes('~DEFAULT_BRANCH') && !included.includes('~ALL')) {
    violations.push({
      rule: 'ruleset-not-default-branch',
      file: rulesetPath,
      message:
        'conditions.ref_name.include does not cover the default branch. Trunk is the ' +
        'branch these guardrails exist to protect; naming it literally also means the ' +
        'ruleset stops applying the day the default branch is renamed.',
    });
  }

  for (const type of REQUIRED_RULE_TYPES) {
    if (ruleOfType(rules, type) === undefined) {
      violations.push({
        rule: 'missing-rule',
        file: rulesetPath,
        message: `no "${type}" rule — see docs/trunk-based-development.md for why each is required`,
      });
    }
  }

  for (const value of asArray(record.bypass_actors)) {
    const actor = asRecord(value);
    if (asString(actor?.bypass_mode) !== 'always') continue;

    violations.push({
      rule: 'always-bypass-actor',
      file: rulesetPath,
      message:
        `actor ${String(actor?.actor_id)} (${String(actor?.actor_type)}) bypasses the ruleset ` +
        'unconditionally, which makes every rule above advisory for it. Use "pull_request" ' +
        'bypass mode so the bypass at least goes through review.',
    });
  }

  return violations;
};

/** Check the rules against each other: do the queue, the PR rule, and history agree? */
const auditRuleCoherence = (rules: readonly RulesetRule[], rulesetPath: string): Violation[] => {
  const violations: Violation[] = [];
  const statusChecks = ruleOfType(rules, 'required_status_checks');
  const mergeQueue = ruleOfType(rules, 'merge_queue');
  const pullRequest = ruleOfType(rules, 'pull_request');

  if (mergeQueue !== undefined && statusChecks?.parameters.strict_required_status_checks_policy) {
    violations.push({
      rule: 'strict-policy-with-merge-queue',
      file: rulesetPath,
      message:
        'strict_required_status_checks_policy requires every PR to be up to date with the ' +
        'base branch before merging, which is the exact job the merge queue was added to do. ' +
        'Together they reintroduce the rebase-and-wait serialisation the queue removes.',
    });
  }

  const allowedMergeMethods = asArray(pullRequest?.parameters.allowed_merge_methods)
    .map(asString)
    .filter((method): method is string => method !== undefined);

  const queueMergeMethod = asString(mergeQueue?.parameters.merge_method);

  if (
    queueMergeMethod !== undefined &&
    allowedMergeMethods.length > 0 &&
    !allowedMergeMethods.includes(queueMergeMethod.toLowerCase())
  ) {
    violations.push({
      rule: 'merge-method-mismatch',
      file: rulesetPath,
      message:
        `the merge queue merges with "${queueMergeMethod}" but the pull_request rule allows ` +
        `only [${allowedMergeMethods.join(', ')}]. The queue wins, so the pull_request rule ` +
        'is describing something that never happens.',
    });
  }

  if (ruleOfType(rules, 'required_linear_history') !== undefined) {
    if (allowedMergeMethods.includes('merge')) {
      violations.push({
        rule: 'linear-history-allows-merge-commits',
        file: rulesetPath,
        message:
          'required_linear_history rejects merge commits, but allowed_merge_methods offers ' +
          '"merge". The button is present and every press of it fails.',
      });
    }
  }

  return violations;
};

/** A workflow-level or job-level concurrency block that can cancel a queue entry. */
const auditConcurrency = (
  concurrency: unknown,
  file: string,
  scope: string,
): Violation | undefined => {
  // The scalar form (`concurrency: my-group`) cannot set cancel-in-progress.
  const block = asRecord(concurrency);
  if (block === undefined) return undefined;
  if (block['cancel-in-progress'] !== true) return undefined;

  const group = asString(block.group) ?? '';
  if (PER_ENTRY_CONCURRENCY_CONTEXTS.some((context) => group.includes(context))) return undefined;

  return {
    rule: 'queue-cancelling-concurrency',
    file,
    message:
      `${scope} concurrency group "${group}" is the same for every merge-queue entry and ` +
      'cancels in progress, so entry N+1 cancels entry N. The cancelled run reports as ' +
      'failed, the queue evicts a pull request that was never actually tested, and the ' +
      'symptom looks like flaky CI. Include github.ref in the group.',
  };
};

/** Everything that has to hold for one required status check to be satisfiable. */
const auditRequiredCheck = (
  context: string,
  integrationId: unknown,
  providersByName: Map<string, JobProvider[]>,
  rulesetPath: string,
): Violation[] => {
  const violations: Violation[] = [];

  if (integrationId !== GITHUB_ACTIONS_INTEGRATION_ID) {
    violations.push({
      rule: 'unpinned-required-check',
      file: rulesetPath,
      message:
        `required check "${context}" is not pinned to integration_id ` +
        `${GITHUB_ACTIONS_INTEGRATION_ID} (GitHub Actions). Unpinned, the rule is satisfied ` +
        'by any app — or any token with checks:write — reporting a green check of that name.',
    });
  }

  const providers = providersByName.get(context) ?? [];

  if (providers.length === 0) {
    violations.push({
      rule: 'unknown-required-check',
      file: rulesetPath,
      message:
        `required check "${context}" is not produced by any job in .github/workflows. ` +
        'Nothing will ever report it, so every pull request waits on it forever.',
    });
    return violations;
  }

  if (providers.length > 1) {
    violations.push({
      rule: 'ambiguous-required-check',
      file: rulesetPath,
      message:
        `required check "${context}" is produced by ${providers.length} jobs ` +
        `(${providers.map((p) => `${p.workflow.path}#${p.id}`).join(', ')}). ` +
        'Whichever reports last wins, so the rule enforces an unpredictable one of them.',
    });
  }

  for (const provider of providers) {
    const { workflow, id, job } = provider;
    const triggers = workflowTriggers(workflow.document);
    const where = `${workflow.path}#${id}`;

    for (const event of ['pull_request', 'merge_group'] as const) {
      if (triggers.has(event)) continue;

      violations.push({
        rule:
          event === 'pull_request'
            ? 'required-check-missing-pull-request'
            : 'required-check-missing-merge-group',
        file: workflow.path,
        message:
          event === 'pull_request'
            ? `${where} produces required check "${context}" but the workflow has no ` +
              'pull_request trigger, so the check never reports on a pull request.'
            : `${where} produces required check "${context}" but the workflow has no ` +
              'merge_group trigger. Queue entries are built on a temporary ' +
              'gh-readonly-queue/ branch, which fires merge_group and nothing else — the ' +
              'entry would wait out check_response_timeout_minutes and then be evicted, ' +
              'taking the rest of the queue with it.',
      });
    }

    for (const event of ['pull_request', 'merge_group'] as const) {
      const config = asRecord(triggers.get(event));
      const filters = ['paths', 'paths-ignore'].filter((key) => config?.[key] !== undefined);
      if (filters.length === 0) continue;

      violations.push({
        rule: 'required-check-path-filtered',
        file: workflow.path,
        message:
          `the ${event} trigger filters on ${filters.join(' and ')}, but ${where} produces ` +
          `required check "${context}". A pull request that touches no matching path skips ` +
          'the workflow entirely, and a required check that never reports blocks the merge ' +
          'rather than passing it. Filter inside the job instead, so it always reports.',
      });
    }

    if (job.if !== undefined) {
      violations.push({
        rule: 'required-check-conditional-job',
        file: workflow.path,
        message:
          `${where} produces required check "${context}" behind a job-level \`if\`. A job ` +
          'that evaluates to false is reported as skipped, not successful, and a skipped ' +
          'required check blocks the merge. Put the condition on the steps instead, so the ' +
          'job still reports.',
      });
    }

    if (asRecord(job.strategy)?.matrix !== undefined) {
      violations.push({
        rule: 'required-check-matrix-job',
        file: workflow.path,
        message:
          `${where} is a matrix job, so it reports one check per leg named ` +
          `"${context} (…)" and never "${context}" itself. Require the leg names, or add a ` +
          'non-matrix job that `needs` every leg and require that.',
      });
    }

    const jobConcurrency = auditConcurrency(job.concurrency, workflow.path, `${where} job-level`);
    if (jobConcurrency !== undefined) violations.push(jobConcurrency);
  }

  return violations;
};

/**
 * Audit one ruleset against the workflows in the repository. Pure — the unit
 * tests drive this directly, with no filesystem involved.
 */
export const auditTrunkGuardrails = (
  ruleset: unknown,
  workflows: readonly WorkflowFile[],
  rulesetPath = '.github/rulesets/trunk-based-main.json',
): Violation[] => {
  const rules = rulesetRules(ruleset);
  const providersByName = indexJobsByCheckName(workflows);

  const violations: Violation[] = [
    ...auditRulesetShape(ruleset, rules, rulesetPath),
    ...auditRuleCoherence(rules, rulesetPath),
  ];

  const requiredChecks = asArray(
    ruleOfType(rules, 'required_status_checks')?.parameters.required_status_checks,
  );

  const contexts = new Set<string>();

  for (const value of requiredChecks) {
    const check = asRecord(value);
    const context = asString(check?.context);
    if (context === undefined) continue;

    contexts.add(context);
    violations.push(
      ...auditRequiredCheck(context, check?.integration_id, providersByName, rulesetPath),
    );
  }

  // Workflow-level concurrency is audited once per workflow rather than once per
  // required check, so a workflow carrying two required checks reports it once.
  const auditedWorkflows = new Set<string>();

  for (const context of contexts) {
    for (const provider of providersByName.get(context) ?? []) {
      if (auditedWorkflows.has(provider.workflow.path)) continue;
      auditedWorkflows.add(provider.workflow.path);

      const violation = auditConcurrency(
        asRecord(provider.workflow.document)?.concurrency,
        provider.workflow.path,
        'workflow-level',
      );
      if (violation !== undefined) violations.push(violation);
    }
  }

  return violations;
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations.map((v) => `${v.file}  [${v.rule}]\n    ${v.message}`).join('\n\n');

/** Read every `.yml`/`.yaml` workflow under `<root>/.github/workflows`. */
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

/** Read every ruleset under `<root>/.github/rulesets`. */
export const readRulesets = (root: string): { path: string; ruleset: unknown }[] => {
  const directory = path.join(root, '.github', 'rulesets');
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      path: path.posix.join('.github', 'rulesets', name),
      ruleset: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as unknown,
    }));
};

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const workflows = readWorkflows(root);
  const rulesets = readRulesets(root);

  if (rulesets.length === 0) {
    console.error(`No rulesets found under ${path.join(root, '.github', 'rulesets')}.`);
    process.exit(1);
  }

  const violations = rulesets.flatMap(({ path: rulesetPath, ruleset }) =>
    auditTrunkGuardrails(ruleset, workflows, rulesetPath),
  );

  if (violations.length > 0) {
    console.error(`\n${violations.length} trunk guardrail violation(s):\n`);
    console.error(formatViolations(violations));
    console.error('\nSee docs/trunk-based-development.md.\n');
    process.exit(1);
  }

  console.log(
    `${rulesets.length} ruleset(s) agree with ${workflows.length} workflow(s) in ${root}.`,
  );
}
