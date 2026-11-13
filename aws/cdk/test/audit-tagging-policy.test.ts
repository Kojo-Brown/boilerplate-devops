import * as fs from 'fs';
import * as path from 'path';
import {
  GOVERNED_TAGS,
  SCP_ACTION_CATALOGUE,
  buildOrganizationsTagPolicy,
  buildTagEnforcementScp,
  serialisePolicy,
} from '../lib/tagging-policy';
import {
  type AuditInputs,
  REGO_TAGS_PATH,
  SCP_PATH,
  TAG_POLICY_PATH,
  auditTaggingPolicy,
  constructorCount,
  formatFindings,
  regoSetMembers,
  stripComments,
} from '../tools/audit-tagging-policy';

/**
 * Tests for the tagging-policy gate.
 *
 * Every rule here is about two files that are edited independently and that
 * nothing in AWS reconciles: the catalogue and the checked-in SCP, the
 * catalogue and the rego pack, the catalogue and the stack that measures it.
 * Each pair keeps working when it disagrees, which is why the gate exists and
 * why the tests below are mostly "make the two disagree and check it is seen".
 */

const cdkRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(cdkRoot, '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const rules = (findings: readonly { rule: string }[]) => findings.map((finding) => finding.rule);

const conforming = (): AuditInputs => ({
  tags: GOVERNED_TAGS,
  actions: SCP_ACTION_CATALOGUE,
  scpFile: serialisePolicy(buildTagEnforcementScp()),
  tagPolicyFile: serialisePolicy(buildOrganizationsTagPolicy()),
  regoSource: [
    'package cloudformation',
    'governed_tag_types := {',
    ...SCP_ACTION_CATALOGUE.flatMap((entry) => entry.resourceTypes).map((type) => `\t"${type}",`),
    '}',
    'required_tag_keys := {"ManagedBy", "Stack"}',
    '',
    'allowed_environments := {"staging", "production", "preview"}',
  ].join('\n'),
  appSource: "new CostAllocationStack(app, 'CostAllocationStack', { alarmTopic });",
  docsSource: [
    ...GOVERNED_TAGS.map((tag) => `## ${tag.key}`),
    'Activation is not retroactive.',
  ].join('\n'),
});

describe('regoSetMembers', () => {
  it('reads a set that spans many lines with comments between them', () => {
    const source = [
      'governed_tag_types := {',
      '\t# what costs money',
      '\t"AWS::S3::Bucket",',
      '\t"AWS::SQS::Queue",',
      '}',
    ].join('\n');
    expect(regoSetMembers(source, 'governed_tag_types')).toEqual([
      'AWS::S3::Bucket',
      'AWS::SQS::Queue',
    ]);
  });

  // A renamed rule and a rule governing nothing are different problems, and
  // only one of them is a drift — so the absent assignment is undefined rather
  // than an empty set.
  it('returns undefined for an assignment that is not there', () => {
    expect(regoSetMembers('package cloudformation', 'required_tag_keys')).toBeUndefined();
  });

  it('returns undefined for a set that is never closed', () => {
    expect(regoSetMembers('required_tag_keys := {"A",', 'required_tag_keys')).toBeUndefined();
  });

  it('does not match a longer name that merely ends the same', () => {
    const source = 'extra_required_tag_keys := {"A"}';
    expect(regoSetMembers(source, 'required_tag_keys')).toBeUndefined();
  });
});

describe('stripComments and constructorCount', () => {
  it('does not count a commented-out stack as wired', () => {
    expect(constructorCount('// new CostAllocationStack(app)', 'CostAllocationStack')).toBe(0);
    expect(constructorCount('/* new CostAllocationStack(app) */', 'CostAllocationStack')).toBe(0);
  });

  it('keeps a // inside a string, which every console link in bin/app.ts has', () => {
    const source = "const url = 'https://example.invalid/x'; new CostAllocationStack(app);";
    expect(constructorCount(source, 'CostAllocationStack')).toBe(1);
    expect(stripComments(source)).toContain('https://example.invalid/x');
  });

  it('preserves newlines through a block comment so line numbers still line up', () => {
    expect(stripComments('a\n/* x\ny */\nb').split('\n')).toHaveLength(4);
  });

  it('survives an escaped quote inside a string', () => {
    const source = "const s = 'it\\'s fine'; new CostAllocationStack(app);";
    expect(constructorCount(source, 'CostAllocationStack')).toBe(1);
  });
});

describe('auditTaggingPolicy', () => {
  it('reports nothing on a conforming setup', () => {
    expect(formatFindings(auditTaggingPolicy(conforming()))).toBe('');
  });

  describe('the generated documents', () => {
    it('reports a document that is not checked in', () => {
      const found = auditTaggingPolicy({ ...conforming(), scpFile: undefined });
      expect(rules(found)).toContain('policy-file-missing');
      expect(found.some((finding) => finding.subject === SCP_PATH)).toBe(true);
    });

    // The quiet failure: the file still attaches and the catalogue still
    // validates, and the two simply stop describing the same organization.
    it('reports a hand-edited SCP', () => {
      const edited = serialisePolicy(buildTagEnforcementScp()).replace(
        'DenyCreateWithoutManagedBy',
        'DenyCreateWithoutSomethingElse',
      );
      const found = auditTaggingPolicy({ ...conforming(), scpFile: edited });
      expect(rules(found)).toContain('policy-file-drift');
    });

    it('reports a hand-edited tag policy', () => {
      const edited = serialisePolicy(buildOrganizationsTagPolicy()).replace(
        'CostCenter',
        'CostCentre',
      );
      const found = auditTaggingPolicy({ ...conforming(), tagPolicyFile: edited });
      expect(rules(found)).toContain('policy-file-drift');
      expect(found.some((finding) => finding.subject === TAG_POLICY_PATH)).toBe(true);
    });

    // Whitespace is still bytes in the file, and the gate compares bytes so the
    // committed artefact is reviewable as a diff.
    it('reports a document reformatted but otherwise identical', () => {
      const minified = `${JSON.stringify(buildTagEnforcementScp())}\n`;
      const found = auditTaggingPolicy({ ...conforming(), scpFile: minified });
      expect(rules(found)).toContain('policy-file-drift');
    });
  });

  describe('the rego pack, which governs a different population', () => {
    it('reports a key the rego pack requires and the SCP does not', () => {
      const base = conforming();
      const found = auditTaggingPolicy({
        ...base,
        regoSource: base.regoSource.replace(
          'required_tag_keys := {"ManagedBy", "Stack"}',
          'required_tag_keys := {"ManagedBy", "Stack", "Owner"}',
        ),
      });
      expect(rules(found)).toContain('rego-required-tag-missing');
    });

    // A stack here would pass review and be denied at deploy time, which is the
    // slowest possible place to find out.
    it('reports a key the SCP requires and the rego pack does not', () => {
      const base = conforming();
      const found = auditTaggingPolicy({
        ...base,
        regoSource: base.regoSource.replace(
          'required_tag_keys := {"ManagedBy", "Stack"}',
          'required_tag_keys := {"ManagedBy"}',
        ),
      });
      expect(rules(found)).toContain('scp-required-tag-missing');
    });

    it('reports a rego pack with no readable required-tag set', () => {
      const base = conforming();
      const found = auditTaggingPolicy({
        ...base,
        regoSource: base.regoSource.replace('required_tag_keys :=', 'renamed_tag_keys :='),
      });
      expect(rules(found)).toContain('rego-required-tag-missing');
      expect(found.some((finding) => finding.subject === REGO_TAGS_PATH)).toBe(true);
    });

    it('reports two copies of the environment set that disagree', () => {
      const base = conforming();
      const found = auditTaggingPolicy({
        ...base,
        regoSource: base.regoSource.replace(
          'allowed_environments := {"staging", "production", "preview"}',
          'allowed_environments := {"staging", "production"}',
        ),
      });
      expect(rules(found)).toContain('environment-values-drift');
    });

    it('accepts the same environment set written in another order', () => {
      const base = conforming();
      const found = auditTaggingPolicy({
        ...base,
        regoSource: base.regoSource.replace(
          'allowed_environments := {"staging", "production", "preview"}',
          'allowed_environments := {"preview", "staging", "production"}',
        ),
      });
      expect(rules(found)).not.toContain('environment-values-drift');
    });

    // A type nobody listed and a type deliberately left unenforceable look
    // identical in a catalogue, so the gate asks for the entry either way.
    it('reports a governed type no catalogued action creates', () => {
      const base = conforming();
      const found = auditTaggingPolicy({
        ...base,
        regoSource: base.regoSource.replace(
          'governed_tag_types := {',
          'governed_tag_types := {\n\t"AWS::Redshift::Cluster",',
        ),
      });
      expect(rules(found)).toContain('resource-type-uncovered');
    });

    it('accepts a type covered by an action that cannot be enforced', () => {
      const found = auditTaggingPolicy(conforming());
      expect(rules(found)).not.toContain('resource-type-uncovered');
      // S3 is in the rego pack and its create action is deliberately excluded.
      expect(SCP_ACTION_CATALOGUE.find((entry) => entry.action === 's3:CreateBucket')?.coverage).toBe(
        'no-tag-on-create',
      );
    });
  });

  describe('the measurement', () => {
    it('reports a policy nothing measures', () => {
      const found = auditTaggingPolicy({ ...conforming(), appSource: '' });
      expect(rules(found)).toContain('dashboard-not-wired');
    });
  });

  describe('the document a reader reaches for', () => {
    it('reports a governed key the page never names', () => {
      const found = auditTaggingPolicy({
        ...conforming(),
        docsSource: 'Activation is not retroactive.',
      });
      expect(rules(found)).toContain('tag-key-undocumented');
    });

    // The single fact that makes a correct, empty widget look like a broken one.
    it('reports a page that does not say activation is not retroactive', () => {
      const found = auditTaggingPolicy({
        ...conforming(),
        docsSource: GOVERNED_TAGS.map((tag) => tag.key).join('\n'),
      });
      expect(rules(found)).toContain('activation-undocumented');
    });

    it('reports that fact once rather than once per key', () => {
      const found = auditTaggingPolicy({
        ...conforming(),
        docsSource: GOVERNED_TAGS.map((tag) => tag.key).join('\n'),
      });
      expect(rules(found).filter((rule) => rule === 'activation-undocumented')).toHaveLength(1);
    });
  });

  it('carries every rule from the catalogue validator through', () => {
    const found = auditTaggingPolicy({
      ...conforming(),
      tags: [
        ...GOVERNED_TAGS,
        { key: 'Stack', purpose: 'dup', enforcement: 'advisory', costAllocation: 'not-activated' },
      ],
    });
    expect(rules(found)).toContain('duplicate-tag-key');
    expect(rules(found)).toContain('unexplained-exception');
  });

  it('names the subject and the rule on every formatted line', () => {
    const text = formatFindings(auditTaggingPolicy({ ...conforming(), appSource: '' }));
    expect(text).toContain('[dashboard-not-wired]');
  });
});

describe('this repository', () => {
  const inputs: AuditInputs = {
    tags: GOVERNED_TAGS,
    actions: SCP_ACTION_CATALOGUE,
    scpFile: read(SCP_PATH),
    tagPolicyFile: read(TAG_POLICY_PATH),
    regoSource: read(REGO_TAGS_PATH),
    appSource: fs.readFileSync(path.join(cdkRoot, 'bin', 'app.ts'), 'utf8'),
    docsSource: read('docs/cost-allocation.md'),
  };

  // A gate whose inputs are empty reports nothing, and reporting nothing is the
  // same output as passing.
  it('reads the checked-in documents, the rego pack, the app and the page', () => {
    expect(inputs.scpFile?.length).toBeGreaterThan(0);
    expect(inputs.tagPolicyFile?.length).toBeGreaterThan(0);
    expect(regoSetMembers(inputs.regoSource, 'governed_tag_types')?.length).toBeGreaterThan(0);
    expect(constructorCount(inputs.appSource, 'CostAllocationStack')).toBe(1);
  });

  it('has no tagging policy violations', () => {
    expect(formatFindings(auditTaggingPolicy(inputs))).toBe('');
  });

  // The rules found a real gap while being written: the rego pack governs
  // AWS::S3::Bucket and AWS::CloudFront::Distribution, and neither create API
  // takes a tag — so the first draft of the action list silently covered
  // neither, and nothing said so.
  it('still reports the gap if an unenforceable action is dropped from the catalogue', () => {
    const withoutS3 = SCP_ACTION_CATALOGUE.filter((entry) => entry.action !== 's3:CreateBucket');
    const found = auditTaggingPolicy({ ...inputs, actions: withoutS3 });
    expect(rules(found)).toContain('resource-type-uncovered');
  });
});
