import * as path from 'path';
import { load } from 'js-yaml';
import {
  AuditInput,
  SourceFile,
  Violation,
  ViolationRule,
  WorkflowFile,
  auditInstallStep,
  auditPolicyFile,
  auditPolicyGate,
  collectedKind,
  collectedRules,
  declaredPackage,
  formatViolations,
  isNearMissRuleName,
  isTestFile,
  mentionedIdsIn,
  parseExpectations,
  readAuditInput,
  readPolicyFiles,
  ruleIdsIn,
  scannedNamespaces,
  scansEveryPackage,
  workflowSteps,
} from '../tools/audit-policy-gate';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const rules = (violations: readonly Violation[]): ViolationRule[] => violations.map((v) => v.rule);

const ruleSet = (violations: readonly Violation[]): ViolationRule[] =>
  [...new Set(rules(violations))].sort();

const file = (filePath: string, text: string): SourceFile => ({ path: filePath, text });

const workflow = (filePath: string, yaml: string): WorkflowFile => ({
  path: filePath,
  document: load(yaml),
});

/* ── A conforming gate, which individual tests break one piece at a time ───── */

const POLICY = file(
  'policy/cloudformation/example.rego',
  `package cloudformation

deny contains msg if {
	some resource in resources
	resource.type == "AWS::S3::Bucket"
	msg := sprintf("[bucket-forbidden] %s", [resource.id])
}
`,
);

const POLICY_TEST = file(
  'policy/cloudformation/example_test.rego',
  `package cloudformation

test_bucket_is_denied if {
	rule_ids(deny) == {"bucket-forbidden"} with input as {"Resources": {"B": {"Type": "AWS::S3::Bucket"}}}
}
`,
);

const EXPECTATIONS = file('policy/canary-expectations.txt', '# header\n\nbucket-forbidden\n');

const GATE_SCRIPT = file(
  '.github/scripts/run-policy-gate.sh',
  `#!/usr/bin/env bash
set -euo pipefail
# Named explicitly rather than --all-namespaces.
namespace="cloudformation"
conftest verify --policy "$policy_directory"
conftest test --namespace "$namespace" --policy "$policy_directory" "\${templates[@]}"
`,
);

const CI = workflow(
  '.github/workflows/ci.yml',
  `name: CI
jobs:
  policy:
    name: Policy gate
    runs-on: ubuntu-latest
    steps:
      - name: Install Conftest
        env:
          CONFTEST_VERSION: "0.69.0"
          CONFTEST_SHA256: "96fc2fbf11f0afde51256647127e6f00a64ce839a4d9a0a1aef2426c0e6f4b3f"
        run: |
          curl -fsSL "https://github.com/open-policy-agent/conftest/releases/download/v\${CONFTEST_VERSION}/conftest_\${CONFTEST_VERSION}_Linux_x86_64.tar.gz" -o conftest.tar.gz
          echo "\${CONFTEST_SHA256}  conftest.tar.gz" | sha256sum -c -
          tar -xzf conftest.tar.gz conftest
      - name: Run the policy gate
        run: .github/scripts/run-policy-gate.sh cdk.out
`,
);

const conformingInput = (overrides: Partial<AuditInput> = {}): AuditInput => ({
  policyFiles: [POLICY, POLICY_TEST],
  gateScript: GATE_SCRIPT,
  expectations: EXPECTATIONS,
  workflows: [CI],
  ...overrides,
});

describe('audit-policy-gate', () => {
  describe('the conforming gate', () => {
    it('reports nothing', () => {
      expect(auditPolicyGate(conformingInput())).toEqual([]);
    });
  });

  describe('collectedKind', () => {
    it.each(['deny', 'violation', 'warn'])('collects %s', (name) => {
      expect(collectedKind(name)).toBe(name);
    });

    // conftest collects suffixed forms, which is why the check is a prefix test
    // and not set membership.
    it('collects the suffixed form', () => {
      expect(collectedKind('deny_image_not_pinned')).toBe('deny');
    });

    it('does not collect a name that merely starts with one', () => {
      expect(collectedKind('denylist')).toBeUndefined();
    });

    it('is case sensitive, as Rego is', () => {
      expect(collectedKind('Deny')).toBeUndefined();
    });
  });

  describe('isNearMissRuleName', () => {
    it.each(['denied', 'denies', 'violations', 'warning', 'Deny', 'WARN'])(
      'flags %s',
      (name) => {
        expect(isNearMissRuleName(name)).toBe(true);
      },
    );

    it.each(['deny', 'warn', 'violation', 'deny_untagged'])('accepts %s', (name) => {
      expect(isNearMissRuleName(name)).toBe(false);
    });

    // The check is deliberately a fixed list rather than "anything starting
    // with den": a helper set is a reasonable thing to call this, and a gate
    // that reports it is one people learn to override.
    it('does not flag an unrelated helper', () => {
      expect(isNearMissRuleName('density_threshold')).toBe(false);
      expect(isNearMissRuleName('warm_pool_size')).toBe(false);
    });
  });

  describe('rule-not-collectable', () => {
    it('reports a rule conftest never queries', () => {
      const broken = file(
        'policy/cloudformation/example.rego',
        `package cloudformation

denied contains msg if {
	msg := "[bucket-forbidden] x"
}
`,
      );

      expect(rules(auditPolicyFile(broken))).toContain('rule-not-collectable');
    });

    // Indented text is a rule *body*, where these words are ordinary
    // references. Reporting them would make the check unusable in any policy
    // that composes rules.
    it('ignores the words where they appear inside a body', () => {
      const fine = file(
        'policy/cloudformation/example.rego',
        `package cloudformation

deny contains msg if {
	some entry in warnings
	msg := sprintf("[bucket-forbidden] %s", [entry])
}
`,
      );

      expect(auditPolicyFile(fine)).toEqual([]);
    });
  });

  describe('rule-id-missing', () => {
    it('reports a rule whose message carries no bracketed id', () => {
      const broken = file(
        'policy/cloudformation/example.rego',
        `package cloudformation

deny contains msg if {
	msg := "this bucket is not allowed"
}
`,
      );

      expect(rules(auditPolicyFile(broken))).toEqual(['rule-id-missing']);
    });

    // Test files assert on ids rather than producing them, so holding them to
    // the message convention would report every one of them.
    it('does not hold a test file to the message convention', () => {
      expect(auditPolicyFile(POLICY_TEST)).toEqual([]);
    });
  });

  describe('package-not-scanned', () => {
    it('reports a package no --namespace names', () => {
      const renamed = file(
        'policy/cloudformation/example.rego',
        POLICY.text.replace('package cloudformation', 'package cfn.buckets'),
      );

      expect(ruleSet(auditPolicyGate(conformingInput({ policyFiles: [renamed] })))).toContain(
        'package-not-scanned',
      );
    });

    // The failure this exists for. conftest prints "0 tests, 0 passed" and
    // exits 0 for a namespace matching no package, so a one-character typo is a
    // permanently green gate over an evaluation that never happens.
    it('reports a typo in the namespace the script passes', () => {
      const typo = file(
        GATE_SCRIPT.path,
        GATE_SCRIPT.text.replace('cloudformation"', 'cloudfromation"'),
      );

      expect(ruleSet(auditPolicyGate(conformingInput({ gateScript: typo })))).toEqual([
        'package-not-scanned',
      ]);
    });

    // A package name that appears *somewhere* in the script is not evidence it
    // is scanned: `policy/cloudformation` is a path, and it would satisfy a
    // naive substring check even with the namespace misspelt.
    it('does not accept the package name appearing in an unrelated line', () => {
      const pathOnly = file(
        GATE_SCRIPT.path,
        `#!/usr/bin/env bash
policy_directory="$repo_root/policy/cloudformation"
namespace="cloudfromation"
conftest test --namespace "$namespace" --policy "$policy_directory" x.json
`,
      );

      expect(ruleSet(auditPolicyGate(conformingInput({ gateScript: pathOnly })))).toEqual([
        'package-not-scanned',
      ]);
    });

    it('accepts --all-namespaces', () => {
      const allNamespaces = file(
        GATE_SCRIPT.path,
        `#!/usr/bin/env bash
conftest test --all-namespaces --policy policy/cloudformation x.json
.github/scripts/run-policy-gate.sh
`,
      );

      expect(auditPolicyGate(conformingInput({ gateScript: allNamespaces }))).toEqual([]);
    });

    // A comment explaining why the flag is *not* used must not read as using
    // it. The real script carries exactly such a comment.
    it('does not count --all-namespaces inside a comment', () => {
      const commented = file(
        GATE_SCRIPT.path,
        `#!/usr/bin/env bash
# Named explicitly rather than --all-namespaces.
namespace="wrong"
conftest test --namespace "$namespace" --policy policy/cloudformation x.json
.github/scripts/run-policy-gate.sh
`,
      );

      expect(ruleSet(auditPolicyGate(conformingInput({ gateScript: commented })))).toEqual([
        'package-not-scanned',
      ]);
    });

    it('resolves the namespace through its shell variable', () => {
      expect([...scannedNamespaces(GATE_SCRIPT)]).toEqual(['cloudformation']);
    });

    it('reads a literal namespace as well as a variable', () => {
      const literal = file(GATE_SCRIPT.path, 'conftest test --namespace cloudformation x.json\n');

      expect([...scannedNamespaces(literal)]).toEqual(['cloudformation']);
    });

    it('reads the --namespace=value form', () => {
      const joined = file(GATE_SCRIPT.path, 'conftest test --namespace=cloudformation x.json\n');

      expect([...scannedNamespaces(joined)]).toEqual(['cloudformation']);
    });

    it('reports nothing when every package is named', () => {
      expect(scansEveryPackage(GATE_SCRIPT, new Set(['cloudformation']))).toEqual([]);
    });
  });

  describe('warn-without-fail-on-warn', () => {
    const warnPolicy = file(
      'policy/cloudformation/example.rego',
      POLICY.text.replace('deny contains', 'warn contains'),
    );

    it('reports a warn rule when nothing makes warnings fatal', () => {
      expect(
        ruleSet(auditPolicyGate(conformingInput({ policyFiles: [warnPolicy, POLICY_TEST] }))),
      ).toContain('warn-without-fail-on-warn');
    });

    it('accepts a warn rule when the gate passes --fail-on-warn', () => {
      const strict = file(
        GATE_SCRIPT.path,
        GATE_SCRIPT.text.replace('--namespace', '--fail-on-warn --namespace'),
      );

      expect(
        auditPolicyGate(
          conformingInput({ policyFiles: [warnPolicy, POLICY_TEST], gateScript: strict }),
        ),
      ).toEqual([]);
    });
  });

  describe('rule-without-test', () => {
    it('reports a rule id no test file mentions', () => {
      expect(ruleSet(auditPolicyGate(conformingInput({ policyFiles: [POLICY] })))).toEqual([
        'rule-without-test',
      ]);
    });

    // Tests name a rule by its bare id, not by the bracketed form the messages
    // use, so the match has to be intersected against the declared ids rather
    // than pattern-matched.
    it('matches the bare quoted id a test asserts on', () => {
      expect([...mentionedIdsIn(POLICY_TEST.text, new Set(['bucket-forbidden']))]).toEqual([
        'bucket-forbidden',
      ]);
    });

    it('does not treat every string in a test as a rule id', () => {
      expect(mentionedIdsIn(POLICY_TEST.text, new Set(['something-else'])).size).toBe(0);
    });
  });

  describe('the canary expectations', () => {
    it('reports a rule with no expectation entry', () => {
      const extra = file(
        'policy/cloudformation/extra.rego',
        `package cloudformation

deny contains msg if {
	msg := "[queue-forbidden] x"
}
`,
      );
      const extraTest = file(
        'policy/cloudformation/extra_test.rego',
        `package cloudformation

test_queue if {
	rule_ids(deny) == {"queue-forbidden"} with input as {}
}
`,
      );

      expect(
        ruleSet(
          auditPolicyGate(
            conformingInput({ policyFiles: [POLICY, POLICY_TEST, extra, extraTest] }),
          ),
        ),
      ).toEqual(['canary-expectation-missing']);
    });

    it('reports an expectation for a rule that no longer exists', () => {
      const stale = file(EXPECTATIONS.path, `${EXPECTATIONS.text}rule-that-left\n`);

      expect(ruleSet(auditPolicyGate(conformingInput({ expectations: stale })))).toEqual([
        'canary-expectation-orphan',
      ]);
    });

    it('reports the absence of the file itself', () => {
      expect(ruleSet(auditPolicyGate(conformingInput({ expectations: undefined })))).toEqual([
        'canary-expectation-missing',
      ]);
    });

    it('ignores comments and blank lines', () => {
      expect([...parseExpectations(EXPECTATIONS)]).toEqual(['bucket-forbidden']);
    });
  });

  describe('conftest-unpinned', () => {
    it('reports an install with no exact version', () => {
      const floating: WorkflowFile = {
        path: CI.path,
        document: JSON.parse(JSON.stringify(CI.document).replace('0.69.0', 'latest')),
      };

      expect(ruleSet(auditPolicyGate(conformingInput({ workflows: [floating] })))).toEqual([
        'conftest-unpinned',
      ]);
    });

    // A version that is not an exact release is the same finding: `v0.69`
    // resolves to whatever the newest patch is on the day the job runs.
    it('reports a partial version as unpinned', () => {
      const partial: WorkflowFile = {
        path: CI.path,
        document: JSON.parse(JSON.stringify(CI.document).replace('0.69.0', '0.69')),
      };

      expect(ruleSet(auditPolicyGate(conformingInput({ workflows: [partial] })))).toEqual([
        'conftest-unpinned',
      ]);
    });

    it('reports an install that does not verify what it downloaded', () => {
      const unverified: WorkflowFile = {
        path: CI.path,
        document: JSON.parse(JSON.stringify(CI.document).replace('sha256sum -c -', 'true')),
      };

      expect(ruleSet(auditPolicyGate(conformingInput({ workflows: [unverified] })))).toEqual([
        'conftest-unpinned',
      ]);
    });

    it('accepts a version and a digest together', () => {
      const step = workflowSteps(CI).find((candidate) => candidate.name === 'Install Conftest');

      expect(step).toBeDefined();
      expect(auditInstallStep(CI.path, step!)).toEqual([]);
    });
  });

  describe('gate-not-run-in-ci', () => {
    it('reports a gate script no workflow runs', () => {
      const unused: WorkflowFile = {
        path: CI.path,
        document: JSON.parse(
          JSON.stringify(CI.document).replace('run-policy-gate.sh cdk.out', 'true'),
        ),
      };

      expect(ruleSet(auditPolicyGate(conformingInput({ workflows: [unused] })))).toEqual([
        'gate-not-run-in-ci',
      ]);
    });

    it('reports the absence of the script itself', () => {
      expect(ruleSet(auditPolicyGate(conformingInput({ gateScript: undefined })))).toEqual([
        'gate-not-run-in-ci',
      ]);
    });
  });

  describe('policy-tree-empty', () => {
    // conftest exits 0 with "0 tests" when handed no rules, so an empty pack is
    // a green check rather than an error. Everything else is suppressed: with
    // no policies, every other rule here would fire at once and bury the cause.
    it('is the only finding when there are no policies', () => {
      expect(rules(auditPolicyGate(conformingInput({ policyFiles: [] })))).toEqual([
        'policy-tree-empty',
      ]);
    });

    it('is not triggered by a tree of tests alone being removed', () => {
      expect(rules(auditPolicyGate(conformingInput({ policyFiles: [POLICY] })))).not.toContain(
        'policy-tree-empty',
      );
    });
  });

  describe('parsing helpers', () => {
    it('reads the package declaration', () => {
      expect(declaredPackage(POLICY)).toBe('cloudformation');
    });

    it('returns undefined for a file with no package', () => {
      expect(declaredPackage(file('policy/x.rego', '# nothing\n'))).toBeUndefined();
    });

    it('identifies test files by suffix', () => {
      expect(isTestFile(POLICY_TEST)).toBe(true);
      expect(isTestFile(POLICY)).toBe(false);
    });

    it('extracts the bracketed ids a policy can report', () => {
      expect([...ruleIdsIn(POLICY.text)]).toEqual(['bucket-forbidden']);
    });

    it('splits a file into its collected rules', () => {
      const two = file(
        'policy/cloudformation/two.rego',
        `package cloudformation

helper(x) if {
	x == 1
}

deny contains msg if {
	msg := "[one] a"
}

deny contains msg if {
	msg := "[two] b"
}
`,
      );

      const collected = collectedRules(two);

      expect(collected).toHaveLength(2);
      expect(collected.map((rule) => rule.line)).toEqual([7, 11]);
      expect([...ruleIdsIn(collected[0].body)]).toEqual(['one']);
      expect([...ruleIdsIn(collected[1].body)]).toEqual(['two']);
    });

    it('formats a violation with its file, location and rule', () => {
      const formatted = formatViolations(auditPolicyGate(conformingInput({ policyFiles: [POLICY] })));

      expect(formatted).toContain('[rule-without-test]');
      expect(formatted).toContain('bucket-forbidden');
    });
  });

  // The gate this repository actually ships, read off disk. Everything above
  // proves the rules fire; this proves they are satisfied here.
  describe('this repository', () => {
    const input = readAuditInput(REPO_ROOT);

    it('has a policy tree', () => {
      expect(readPolicyFiles(REPO_ROOT).length).toBeGreaterThan(0);
    });

    it('passes its own audit', () => {
      expect(formatViolations(auditPolicyGate(input))).toBe('');
    });

    it('declares one package, and the gate scans it', () => {
      const packages = new Set(
        input.policyFiles
          .map(declaredPackage)
          .filter((name): name is string => name !== undefined),
      );

      expect([...packages]).toEqual(['cloudformation']);
      expect(input.gateScript).toBeDefined();
      expect(scansEveryPackage(input.gateScript!, packages)).toEqual([]);
    });

    it('has an expectation for every rule it can report', () => {
      const declared = new Set(
        input.policyFiles
          .filter((candidate) => !isTestFile(candidate))
          .flatMap((candidate) => [...ruleIdsIn(candidate.text)]),
      );

      expect(input.expectations).toBeDefined();
      expect([...declared].sort()).toEqual([...parseExpectations(input.expectations!)].sort());
    });
  });
});
