import * as path from 'path';
import { load } from 'js-yaml';
import {
  GITHUB_ACTIONS_INTEGRATION_ID,
  REQUIRED_RULE_TYPES,
  Violation,
  ViolationRule,
  WorkflowFile,
  auditTrunkGuardrails,
  checkNameForJob,
  formatViolations,
  indexJobsByCheckName,
  readRulesets,
  readWorkflows,
  workflowTriggers,
} from '../tools/audit-trunk-guardrails';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const rules = (violations: readonly Violation[]): ViolationRule[] => violations.map((v) => v.rule);

/** A workflow written the way a workflow is written, then parsed the way the tool parses one. */
const workflow = (filePath: string, yaml: string): WorkflowFile => ({
  path: filePath,
  document: load(yaml),
});

/**
 * A conforming CI workflow: two required checks, both triggers, no filters.
 * Individual tests override one thing at a time so a failure names its cause.
 */
const CONFORMING_CI = workflow(
  '.github/workflows/ci.yml',
  `
name: CI
on:
  pull_request:
  merge_group:
  push:
    branches: [main]
concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  cdk:
    name: CDK typecheck, test, synth
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  actionlint:
    runs-on: ubuntu-latest
    steps:
      - run: actionlint
`,
);

const requiredCheck = (context: string): Record<string, unknown> => ({
  context,
  integration_id: GITHUB_ACTIONS_INTEGRATION_ID,
});

interface RulesetOverrides {
  readonly enforcement?: string;
  readonly include?: readonly string[];
  readonly contexts?: readonly Record<string, unknown>[];
  readonly strict?: boolean;
  readonly allowedMergeMethods?: readonly string[];
  readonly queueMergeMethod?: string;
  readonly omitRuleTypes?: readonly string[];
  readonly bypassActors?: readonly Record<string, unknown>[];
}

/** A conforming ruleset, with one property dislodged per test. */
const ruleset = (overrides: RulesetOverrides = {}): unknown => {
  const all = [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'required_linear_history' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 1,
        allowed_merge_methods: overrides.allowedMergeMethods ?? ['squash'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: overrides.strict ?? false,
        required_status_checks: overrides.contexts ?? [requiredCheck('CDK typecheck, test, synth')],
      },
    },
    {
      type: 'merge_queue',
      parameters: { merge_method: overrides.queueMergeMethod ?? 'SQUASH' },
    },
  ];

  return {
    name: 'trunk-based-main',
    target: 'branch',
    enforcement: overrides.enforcement ?? 'active',
    conditions: { ref_name: { include: overrides.include ?? ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: all.filter((rule) => !(overrides.omitRuleTypes ?? []).includes(rule.type)),
    bypass_actors: overrides.bypassActors ?? [],
  };
};

describe('workflowTriggers', () => {
  it('reads the mapping form, keeping each event configuration', () => {
    const triggers = workflowTriggers(load('on:\n  pull_request:\n    paths: ["src/**"]\n'));

    expect([...triggers.keys()]).toEqual(['pull_request']);
    expect(triggers.get('pull_request')).toEqual({ paths: ['src/**'] });
  });

  it('reads the list form', () => {
    expect([...workflowTriggers(load('on: [push, merge_group]\n')).keys()]).toEqual([
      'push',
      'merge_group',
    ]);
  });

  it('reads the scalar form', () => {
    expect([...workflowTriggers(load('on: pull_request\n')).keys()]).toEqual(['pull_request']);
  });

  // YAML 1.1 resolves a bare `on` key to the boolean true, which would make
  // every workflow in the repository look like it had no triggers at all and
  // every required check look unreachable. js-yaml 5 defaults to the YAML 1.2
  // core schema, where it stays a string; this pins that assumption.
  it('does not lose the `on` key to YAML boolean resolution', () => {
    expect(workflowTriggers(load('on:\n  pull_request:\n')).has('pull_request')).toBe(true);
  });

  it('returns nothing for a document that is not a mapping', () => {
    expect(workflowTriggers(load('- a\n- b\n')).size).toBe(0);
    expect(workflowTriggers(undefined).size).toBe(0);
  });
});

describe('checkNameForJob', () => {
  it('prefers the display name', () => {
    expect(checkNameForJob('cdk', { name: 'CDK typecheck, test, synth' })).toBe(
      'CDK typecheck, test, synth',
    );
  });

  it('falls back to the job id', () => {
    expect(checkNameForJob('actionlint', { 'runs-on': 'ubuntu-latest' })).toBe('actionlint');
  });
});

describe('indexJobsByCheckName', () => {
  it('indexes every job across every workflow', () => {
    const index = indexJobsByCheckName([CONFORMING_CI]);

    expect([...index.keys()].sort()).toEqual(['CDK typecheck, test, synth', 'actionlint']);
    expect(index.get('actionlint')).toHaveLength(1);
  });

  it('collects both providers when two jobs share a check name', () => {
    const other = workflow(
      '.github/workflows/other.yml',
      'on:\n  pull_request:\njobs:\n  lint:\n    name: actionlint\n    steps: []\n',
    );

    expect(indexJobsByCheckName([CONFORMING_CI, other]).get('actionlint')).toHaveLength(2);
  });

  it('ignores a jobs block that is not a mapping', () => {
    expect(indexJobsByCheckName([workflow('.github/workflows/x.yml', 'jobs: []\n')]).size).toBe(0);
  });
});

describe('auditTrunkGuardrails', () => {
  it('passes a ruleset whose required checks are all produced correctly', () => {
    expect(auditTrunkGuardrails(ruleset(), [CONFORMING_CI])).toEqual([]);
  });

  describe('required checks resolve to a producing job', () => {
    it('flags a required check no job produces', () => {
      const violations = auditTrunkGuardrails(
        ruleset({ contexts: [requiredCheck('Integration tests')] }),
        [CONFORMING_CI],
      );

      expect(rules(violations)).toEqual(['unknown-required-check']);
      expect(violations[0].message).toContain('Integration tests');
    });

    it('flags a required check two jobs answer to', () => {
      const duplicate = workflow(
        '.github/workflows/nightly.yml',
        `
on:
  pull_request:
  merge_group:
jobs:
  lint:
    name: actionlint
    steps: []
`,
      );

      const violations = auditTrunkGuardrails(ruleset({ contexts: [requiredCheck('actionlint')] }), [
        CONFORMING_CI,
        duplicate,
      ]);

      expect(rules(violations)).toEqual(['ambiguous-required-check']);
    });

    it('flags a required check that is not pinned to the GitHub Actions app', () => {
      const violations = auditTrunkGuardrails(
        ruleset({ contexts: [{ context: 'CDK typecheck, test, synth' }] }),
        [CONFORMING_CI],
      );

      expect(rules(violations)).toEqual(['unpinned-required-check']);
    });

    it('ignores an entry with no context at all', () => {
      expect(auditTrunkGuardrails(ruleset({ contexts: [{ integration_id: 1 }] }), [])).toEqual([]);
    });
  });

  describe('producers run on the events that matter', () => {
    it('flags a producer with no merge_group trigger', () => {
      const noQueue = workflow(
        '.github/workflows/ci.yml',
        'on:\n  pull_request:\njobs:\n  cdk:\n    name: CDK typecheck, test, synth\n    steps: []\n',
      );

      const violations = auditTrunkGuardrails(ruleset(), [noQueue]);

      expect(rules(violations)).toEqual(['required-check-missing-merge-group']);
      expect(violations[0].file).toBe('.github/workflows/ci.yml');
    });

    it('flags a producer with no pull_request trigger', () => {
      const pushOnly = workflow(
        '.github/workflows/ci.yml',
        'on:\n  merge_group:\n  push:\njobs:\n  cdk:\n    name: CDK typecheck, test, synth\n    steps: []\n',
      );

      expect(rules(auditTrunkGuardrails(ruleset(), [pushOnly]))).toEqual([
        'required-check-missing-pull-request',
      ]);
    });

    it.each(['paths', 'paths-ignore'])('flags a %s filter on a producing workflow', (filter) => {
      const filtered = workflow(
        '.github/workflows/ci.yml',
        `
on:
  pull_request:
    ${filter}: ["aws/**"]
  merge_group:
jobs:
  cdk:
    name: CDK typecheck, test, synth
    steps: []
`,
      );

      const violations = auditTrunkGuardrails(ruleset(), [filtered]);

      expect(rules(violations)).toEqual(['required-check-path-filtered']);
      expect(violations[0].message).toContain(filter);
    });

    it('flags a job-level `if` on a producing job', () => {
      const conditional = workflow(
        '.github/workflows/ci.yml',
        `
on:
  pull_request:
  merge_group:
jobs:
  cdk:
    name: CDK typecheck, test, synth
    if: github.event_name == 'pull_request'
    steps: []
`,
      );

      expect(rules(auditTrunkGuardrails(ruleset(), [conditional]))).toEqual([
        'required-check-conditional-job',
      ]);
    });

    it('flags a matrix producer, whose legs never report the bare check name', () => {
      const matrix = workflow(
        '.github/workflows/ci.yml',
        `
on:
  pull_request:
  merge_group:
jobs:
  cdk:
    name: CDK typecheck, test, synth
    strategy:
      matrix:
        node: [22, 24]
    steps: []
`,
      );

      expect(rules(auditTrunkGuardrails(ruleset(), [matrix]))).toEqual([
        'required-check-matrix-job',
      ]);
    });

    it('leaves a step-level `if` alone — the job still reports', () => {
      const stepConditional = workflow(
        '.github/workflows/ci.yml',
        `
on:
  pull_request:
  merge_group:
jobs:
  cdk:
    name: CDK typecheck, test, synth
    steps:
      - if: github.event_name == 'pull_request'
        run: npm test
`,
      );

      expect(auditTrunkGuardrails(ruleset(), [stepConditional])).toEqual([]);
    });
  });

  describe('concurrency cannot cancel a sibling queue entry', () => {
    const withConcurrency = (group: string, cancel: boolean): WorkflowFile =>
      workflow(
        '.github/workflows/ci.yml',
        `
on:
  pull_request:
  merge_group:
concurrency:
  group: ${group}
  cancel-in-progress: ${cancel}
jobs:
  cdk:
    name: CDK typecheck, test, synth
    steps: []
`,
      );

    it('flags a ref-independent group that cancels in progress', () => {
      const violations = auditTrunkGuardrails(ruleset(), [
        withConcurrency('ci-${{ github.workflow }}', true),
      ]);

      expect(rules(violations)).toEqual(['queue-cancelling-concurrency']);
    });

    it('allows a ref-independent group that does not cancel', () => {
      expect(auditTrunkGuardrails(ruleset(), [withConcurrency('ci', false)])).toEqual([]);
    });

    it('allows a group keyed on github.ref, which is unique per queue entry', () => {
      expect(
        auditTrunkGuardrails(ruleset(), [withConcurrency('ci-${{ github.ref }}', true)]),
      ).toEqual([]);
    });

    it('reports a workflow with two required checks only once', () => {
      const violations = auditTrunkGuardrails(
        ruleset({
          contexts: [requiredCheck('CDK typecheck, test, synth'), requiredCheck('actionlint')],
        }),
        [
          workflow(
            '.github/workflows/ci.yml',
            `
on:
  pull_request:
  merge_group:
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  cdk:
    name: CDK typecheck, test, synth
    steps: []
  actionlint:
    steps: []
`,
          ),
        ],
      );

      expect(rules(violations)).toEqual(['queue-cancelling-concurrency']);
    });

    it('flags a job-level concurrency block too', () => {
      const jobLevel = workflow(
        '.github/workflows/ci.yml',
        `
on:
  pull_request:
  merge_group:
jobs:
  cdk:
    name: CDK typecheck, test, synth
    concurrency:
      group: deploy
      cancel-in-progress: true
    steps: []
`,
      );

      expect(rules(auditTrunkGuardrails(ruleset(), [jobLevel]))).toEqual([
        'queue-cancelling-concurrency',
      ]);
    });
  });

  describe('the rules agree with each other', () => {
    it('flags the branch-up-to-date policy alongside a merge queue', () => {
      expect(rules(auditTrunkGuardrails(ruleset({ strict: true }), [CONFORMING_CI]))).toEqual([
        'strict-policy-with-merge-queue',
      ]);
    });

    it('allows the branch-up-to-date policy when there is no queue', () => {
      const violations = auditTrunkGuardrails(
        ruleset({ strict: true, omitRuleTypes: ['merge_queue'] }),
        [CONFORMING_CI],
      );

      expect(rules(violations)).toEqual(['missing-rule']);
    });

    it('flags a queue merge method the pull_request rule forbids', () => {
      const violations = auditTrunkGuardrails(
        ruleset({ queueMergeMethod: 'MERGE', allowedMergeMethods: ['squash'] }),
        [CONFORMING_CI],
      );

      expect(rules(violations)).toEqual(['merge-method-mismatch']);
    });

    it('matches the merge method case-insensitively, as the two APIs spell it differently', () => {
      expect(
        auditTrunkGuardrails(
          ruleset({ queueMergeMethod: 'SQUASH', allowedMergeMethods: ['squash'] }),
          [CONFORMING_CI],
        ),
      ).toEqual([]);
    });

    it('flags linear history offered alongside merge commits', () => {
      const violations = auditTrunkGuardrails(
        ruleset({ allowedMergeMethods: ['squash', 'merge'], queueMergeMethod: 'SQUASH' }),
        [CONFORMING_CI],
      );

      expect(rules(violations)).toEqual(['linear-history-allows-merge-commits']);
    });
  });

  describe('the ruleset is the thing it claims to be', () => {
    it('flags an evaluate-mode ruleset', () => {
      expect(rules(auditTrunkGuardrails(ruleset({ enforcement: 'evaluate' }), [CONFORMING_CI]))) //
        .toEqual(['ruleset-not-active']);
    });

    it('flags a ruleset that does not target the default branch', () => {
      const violations = auditTrunkGuardrails(ruleset({ include: ['refs/heads/release/*'] }), [
        CONFORMING_CI,
      ]);

      expect(rules(violations)).toEqual(['ruleset-not-default-branch']);
    });

    it('accepts ~ALL as covering the default branch', () => {
      expect(auditTrunkGuardrails(ruleset({ include: ['~ALL'] }), [CONFORMING_CI])).toEqual([]);
    });

    it.each(REQUIRED_RULE_TYPES.filter((type) => type !== 'required_status_checks'))(
      'flags a ruleset with no %s rule',
      (type) => {
        const violations = auditTrunkGuardrails(ruleset({ omitRuleTypes: [type] }), [
          CONFORMING_CI,
        ]);

        expect(violations).toContainEqual(
          expect.objectContaining({ rule: 'missing-rule', message: expect.stringContaining(type) }),
        );
      },
    );

    it('flags an actor that bypasses the ruleset unconditionally', () => {
      const violations = auditTrunkGuardrails(
        ruleset({ bypassActors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }] }),
        [CONFORMING_CI],
      );

      expect(rules(violations)).toEqual(['always-bypass-actor']);
    });

    it('allows a bypass that still goes through a pull request', () => {
      const violations = auditTrunkGuardrails(
        ruleset({
          bypassActors: [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }],
        }),
        [CONFORMING_CI],
      );

      expect(violations).toEqual([]);
    });

    it('reports everything wrong with a ruleset that is not a ruleset', () => {
      const violations = auditTrunkGuardrails({}, []);

      expect(rules(violations)).toEqual([
        'ruleset-not-active',
        'ruleset-not-default-branch',
        ...REQUIRED_RULE_TYPES.map(() => 'missing-rule' as const),
      ]);
    });
  });
});

describe('formatViolations', () => {
  it('names the file and the rule on the first line of each entry', () => {
    const output = formatViolations(
      auditTrunkGuardrails(ruleset({ contexts: [requiredCheck('nope')] }), [CONFORMING_CI]),
    );

    expect(output).toContain('.github/rulesets/trunk-based-main.json  [unknown-required-check]');
  });

  it('renders an empty list as an empty string', () => {
    expect(formatViolations([])).toBe('');
  });
});

// The unit tests above prove the rules fire. This proves they are satisfied by
// what the repository actually ships — which is the only reason the gate is in
// CI, and the assertion that fails when someone renames a job or drops a
// trigger.
describe('the guardrails this repository ships', () => {
  const rulesets = readRulesets(REPO_ROOT);
  const workflows = readWorkflows(REPO_ROOT);

  it('ships at least one ruleset and the workflows to satisfy it', () => {
    expect(rulesets.length).toBeGreaterThan(0);
    expect(workflows.length).toBeGreaterThan(0);
  });

  it.each(rulesets.map((entry) => [entry.path, entry.ruleset] as const))(
    '%s is consistent with .github/workflows',
    (rulesetPath, entry) => {
      const violations = auditTrunkGuardrails(entry, workflows, rulesetPath);

      expect(formatViolations(violations)).toBe('');
    },
  );

  it('requires the short-lived-branch check, not just the build', () => {
    const contexts = rulesets.flatMap(({ ruleset: entry }) =>
      ((entry as { rules: { type: string; parameters?: { required_status_checks?: unknown[] } }[] })
        .rules.find((rule) => rule.type === 'required_status_checks')?.parameters
        ?.required_status_checks ?? []).map((check) => (check as { context: string }).context),
    );

    expect(contexts).toContain('Short-lived branch');
  });
});
