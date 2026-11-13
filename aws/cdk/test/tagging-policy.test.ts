import {
  GOVERNED_TAGS,
  type GovernedTag,
  RESERVED_TAG_PREFIX,
  SCP_ACTION_CATALOGUE,
  SCP_MAX_BYTES,
  type ScpAction,
  assertValidTaggingPolicy,
  buildOrganizationsTagPolicy,
  buildTagEnforcementScp,
  costAllocationTagKeys,
  enforcedScpActions,
  requireGovernedTag,
  requiredTagKeys,
  serialisePolicy,
  tagRemovalActions,
  validateTaggingPolicy,
  valueConstrainedTagKeys,
} from '../lib/tagging-policy';

/**
 * Tests for the tag catalogue and the two documents it generates.
 *
 * The properties asserted here are the ones whose absence produces a policy
 * that attaches cleanly and enforces something other than what it reads as: two
 * required keys merged into one `Null` block (which is an AND), a value
 * constraint that also denies the absent tag, an action list that grew past the
 * byte cap, and a cost grouping whose values the dashboard has no way to draw.
 */

const rules = (findings: readonly { rule: string }[]) => findings.map((finding) => finding.rule);

const tag = (overrides: Partial<GovernedTag> = {}): GovernedTag => ({
  key: 'Example',
  purpose: 'test',
  enforcement: 'deny-on-create',
  costAllocation: 'not-activated',
  note: 'test',
  ...overrides,
});

const action = (overrides: Partial<ScpAction> = {}): ScpAction => ({
  action: 'lambda:CreateFunction',
  coverage: 'enforced',
  resourceTypes: ['AWS::Lambda::Function'],
  tagRemovalActions: ['lambda:UntagResource'],
  ...overrides,
});

describe('GOVERNED_TAGS', () => {
  it('validates', () => {
    expect(validateTaggingPolicy()).toEqual([]);
    expect(() => assertValidTaggingPolicy()).not.toThrow();
  });

  it('requires exactly the two keys the rego pack requires', () => {
    expect(requiredTagKeys().sort()).toEqual(['ManagedBy', 'Stack']);
  });

  it('constrains Environment by value without requiring it', () => {
    const environment = requireGovernedTag('Environment');
    expect(environment.enforcement).toBe('deny-bad-value');
    expect(requiredTagKeys()).not.toContain('Environment');
    expect(valueConstrainedTagKeys()).toContain('Environment');
  });

  it('draws three keys on the dashboard, each with declared values', () => {
    const keys = costAllocationTagKeys();
    expect(keys).toEqual(['Environment', 'Project', 'CostCenter']);
    for (const key of keys) {
      expect(requireGovernedTag(key).allowedValues?.length).toBeGreaterThan(0);
    }
  });

  it('records a reason on every advisory or un-activated key', () => {
    for (const governed of GOVERNED_TAGS) {
      if (governed.enforcement === 'advisory' || governed.costAllocation === 'not-activated') {
        expect(governed.note).toBeTruthy();
      }
    }
  });

  it('throws rather than returning undefined for an unknown key', () => {
    expect(() => requireGovernedTag('NoSuchTag')).toThrow(/No governed tag 'NoSuchTag'/);
  });
});

describe('SCP_ACTION_CATALOGUE', () => {
  it('records a reason for every action that cannot be enforced at create time', () => {
    for (const entry of SCP_ACTION_CATALOGUE) {
      if (entry.coverage === 'no-tag-on-create') expect(entry.reason).toBeTruthy();
    }
  });

  // The two that make the coverage hole real rather than theoretical: both
  // create a billable resource and neither create API takes a tag, so no SCP
  // can require one.
  it('excludes s3:CreateBucket and cloudfront:CreateDistribution', () => {
    const excluded = SCP_ACTION_CATALOGUE.filter(
      (entry) => entry.coverage === 'no-tag-on-create',
    ).map((entry) => entry.action);
    expect(excluded).toContain('s3:CreateBucket');
    expect(excluded).toContain('cloudfront:CreateDistribution');
    expect(enforcedScpActions()).not.toContain('s3:CreateBucket');
  });

  it('sorts the enforced actions, so the generated document is stable', () => {
    const actions = enforcedScpActions();
    expect([...actions].sort()).toEqual(actions);
  });
});

describe('buildTagEnforcementScp', () => {
  const document = buildTagEnforcementScp();

  it('gives each required key a statement of its own', () => {
    // One Null block with two keys is an AND: it would deny only the request
    // missing both tags, so supplying either one would pass. That reads as
    // "require both" and enforces "require at least one".
    const creates = document.Statement.filter((statement) =>
      statement.Sid.startsWith('DenyCreateWithout'),
    );
    expect(creates).toHaveLength(requiredTagKeys().length);
    for (const statement of creates) {
      expect(Object.keys(statement.Condition.Null)).toHaveLength(1);
    }
  });

  it('pairs a value constraint with Null false, so an absent tag is still allowed', () => {
    const environment = document.Statement.find(
      (statement) => statement.Sid === 'DenyEnvironmentOutsideAllowedValues',
    );
    expect(environment?.Condition.StringNotEqualsIfExists['aws:RequestTag/Environment']).toEqual([
      'staging',
      'production',
      'preview',
    ]);
    expect(environment?.Condition.Null['aws:RequestTag/Environment']).toBe('false');
  });

  it('emits no create-time statement for an advisory key', () => {
    const sids = document.Statement.map((statement) => statement.Sid);
    expect(sids).not.toContain('DenyCreateWithoutProject');
    expect(sids).not.toContain('DenyProjectOutsideAllowedValues');
  });

  // Without this every deny above is a one-time check an UntagResource call
  // undoes, and a resource untagged after the fact is exactly as invisible to
  // Cost Explorer as one that was never tagged.
  it('protects the governed keys from removal', () => {
    const removal = document.Statement.find(
      (statement) => statement.Sid === 'DenyRemovalOfGovernedTags',
    );
    expect(removal?.Action).toEqual(tagRemovalActions());
    expect(removal?.Condition['ForAnyValue:StringEquals']['aws:TagKeys']).toEqual([
      'Environment',
      'ManagedBy',
      'Stack',
    ]);
  });

  // Every service named its own: UntagResource, UntagQueue, RemoveTags,
  // RemoveTagsFromResource, DeleteTags. There is no wildcard that covers them,
  // because IAM's action grammar does not allow a wildcard service prefix.
  it('names each service’s own removal action rather than a wildcard', () => {
    const removals = tagRemovalActions();
    expect(removals).toContain('sqs:UntagQueue');
    expect(removals).toContain('elasticloadbalancing:RemoveTags');
    expect(removals).toContain('rds:RemoveTagsFromResource');
    expect(removals).toContain('ec2:DeleteTags');
    for (const removal of removals) expect(removal).not.toContain('*');
  });

  // `aws:TagKeys` on a replace-the-whole-set call holds the keys being *set*,
  // so denying the governed keys there would forbid applying them at all.
  it('lists no removal action for a create it cannot enforce', () => {
    for (const entry of SCP_ACTION_CATALOGUE) {
      if (entry.coverage === 'no-tag-on-create') {
        expect(entry.tagRemovalActions ?? []).toEqual([]);
      }
    }
  });

  it('every action in the document is one IAM would accept', () => {
    for (const statement of document.Statement) {
      for (const candidate of statement.Action) {
        expect(candidate).toMatch(/^[a-z0-9-]+:[A-Za-z0-9*?]+$/);
      }
    }
  });

  it('fits inside the Organizations byte cap, with the headroom stated', () => {
    const bytes = Buffer.byteLength(serialisePolicy(document), 'utf8');
    expect(bytes).toBeLessThanOrEqual(SCP_MAX_BYTES);
  });

  it('is every Deny, never an Allow', () => {
    for (const statement of document.Statement) expect(statement.Effect).toBe('Deny');
  });
});

describe('buildOrganizationsTagPolicy', () => {
  const policy = buildOrganizationsTagPolicy();

  it('declares the canonical spelling of every governed key', () => {
    for (const governed of GOVERNED_TAGS) {
      expect(policy.tags[governed.key].tag_key['@@assign']).toBe(governed.key);
    }
  });

  // A free-form key's values cannot be enumerated, and an @@assign listing the
  // values that happen to exist today is wrong the first time somebody adds a
  // stack.
  it('emits no value set for a free-form key', () => {
    expect(policy.tags.Stack.tag_value).toBeUndefined();
    expect(policy.tags.Environment.tag_value?.['@@assign']).toEqual([
      'staging',
      'production',
      'preview',
    ]);
  });
});

describe('validateTaggingPolicy', () => {
  it('reports a duplicate key', () => {
    const found = validateTaggingPolicy([tag({ key: 'Dup' }), tag({ key: 'Dup' })]);
    expect(rules(found)).toContain('duplicate-tag-key');
  });

  it('reports two keys that differ only in case', () => {
    const found = validateTaggingPolicy([tag({ key: 'CostCenter' }), tag({ key: 'costcenter' })]);
    expect(rules(found)).toContain('tag-key-case-collision');
  });

  it('reports a key under the prefix AWS reserves', () => {
    const found = validateTaggingPolicy([tag({ key: `${RESERVED_TAG_PREFIX}CreatedBy` })]);
    expect(rules(found)).toContain('reserved-tag-key');
  });

  it('reports a value constraint with no values to compare against', () => {
    const found = validateTaggingPolicy([
      tag({ key: 'Env', enforcement: 'deny-bad-value', allowedValues: undefined }),
    ]);
    expect(rules(found)).toContain('missing-allowed-values');
  });

  it('reports an empty allowed set, which makes the tag impossible to set', () => {
    const found = validateTaggingPolicy([
      tag({ key: 'Env', enforcement: 'deny-bad-value', allowedValues: [] }),
    ]);
    expect(rules(found)).toContain('empty-allowed-values');
  });

  it('reports a value listed twice', () => {
    const found = validateTaggingPolicy([tag({ allowedValues: ['a', 'a'] })]);
    expect(rules(found)).toContain('duplicate-allowed-value');
  });

  // Activated, queried, billed for, and invisible: the dashboard draws one
  // series per declared value and there are none.
  it('reports a cost grouping with no declared values', () => {
    const found = validateTaggingPolicy([
      tag({ key: 'Team', costAllocation: 'activated', allowedValues: undefined }),
    ]);
    expect(rules(found)).toContain('activated-without-values');
  });

  it('reports an advisory key with no recorded reason', () => {
    const found = validateTaggingPolicy([
      tag({
        key: 'Team',
        enforcement: 'advisory',
        costAllocation: 'activated',
        allowedValues: ['a'],
        note: undefined,
      }),
    ]);
    expect(rules(found)).toContain('unexplained-exception');
  });

  it('reports an unenforceable action with no reason', () => {
    const found = validateTaggingPolicy(GOVERNED_TAGS, [
      action({ action: 's3:CreateBucket', coverage: 'no-tag-on-create', reason: undefined }),
    ]);
    expect(rules(found)).toContain('missing-reason');
  });

  // The rule that would have caught `*:Untag*`, which looks like it covers
  // every service's removal call and is rejected by IAM outright.
  it('reports an action with a wildcard service prefix', () => {
    const found = validateTaggingPolicy(GOVERNED_TAGS, [
      action({ tagRemovalActions: ['*:Untag*'] }),
    ]);
    expect(rules(found)).toContain('invalid-action-format');
  });

  it('reports an action with no service prefix at all', () => {
    const found = validateTaggingPolicy(GOVERNED_TAGS, [action({ action: 'CreateFunction' })]);
    expect(rules(found)).toContain('invalid-action-format');
  });

  it('reports an enforced create whose tags can be removed again', () => {
    const found = validateTaggingPolicy(GOVERNED_TAGS, [
      action({ tagRemovalActions: undefined }),
    ]);
    expect(rules(found)).toContain('removal-unprotected');
  });

  it('reports removal actions on a create nobody enforces', () => {
    const found = validateTaggingPolicy(GOVERNED_TAGS, [
      action({
        action: 's3:CreateBucket',
        coverage: 'no-tag-on-create',
        reason: 'no tags on create',
        tagRemovalActions: ['s3:PutBucketTagging'],
      }),
      action({ tagRemovalActions: ['lambda:UntagResource'] }),
    ]);
    expect(rules(found)).toContain('removal-on-unenforced');
  });

  it('reports a duplicated action', () => {
    const found = validateTaggingPolicy(GOVERNED_TAGS, [action(), action()]);
    expect(rules(found)).toContain('duplicate-action');
  });

  it('reports a policy with statements and no enforceable action', () => {
    const found = validateTaggingPolicy(GOVERNED_TAGS, [
      action({ action: 's3:CreateBucket', coverage: 'no-tag-on-create', reason: 'no tags' }),
    ]);
    expect(rules(found)).toContain('no-enforced-action');
  });

  it('reports an action list that grew past the byte cap', () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      action({ action: `service${index}:CreateSomethingWithALongName` }),
    );
    const found = validateTaggingPolicy(GOVERNED_TAGS, many);
    expect(rules(found)).toContain('scp-too-large');
  });

  it('accepts a minimal but coherent catalogue', () => {
    expect(
      validateTaggingPolicy(
        [tag({ key: 'ManagedBy', allowedValues: ['CDK'] })],
        [action()],
      ),
    ).toEqual([]);
  });

  it('throws from the assert form, naming the rule', () => {
    expect(() => assertValidTaggingPolicy([tag({ key: 'Dup' }), tag({ key: 'Dup' })])).toThrow(
      /duplicate-tag-key/,
    );
  });
});
