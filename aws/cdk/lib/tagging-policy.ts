/**
 * The tag catalogue, the SCP that enforces it, and the Organizations tag policy
 * that standardises it.
 *
 * `policy/cloudformation/tags.rego` already holds every resource this
 * repository synthesises to `ManagedBy` and `Stack`. That gate runs on a pull
 * request, reads `cdk.out/`, and therefore governs exactly one population: the
 * resources CDK creates from this tree. It is silent about the console, about
 * another team's pipeline, about a Terraform workspace in the same account, and
 * about every resource that already existed — which is the population a cost
 * report is actually made of.
 *
 * An SCP is the half that covers the rest, and it is not a stronger version of
 * the rego pack. It is a different mechanism with a different, smaller reach,
 * and four properties of it decide what can and cannot be enforced:
 *
 *   • **`aws:RequestTag` only exists on an API that accepts tags at create
 *     time.** `lambda:CreateFunction` takes `Tags`; `s3:CreateBucket` does not —
 *     an S3 bucket is tagged by a second `PutBucketTagging` call. A `Deny` on
 *     `s3:CreateBucket` conditioned on a missing `aws:RequestTag/ManagedBy`
 *     therefore denies *every* bucket creation, including the compliant one, so
 *     the action cannot be in the policy at all. {@link SCP_ACTION_CATALOGUE}
 *     records both halves: what is enforced, and what is structurally
 *     unenforceable with the reason, because an action quietly left off a list
 *     is indistinguishable from one nobody thought of.
 *
 *   • **One `Null` block with two keys is an AND.** `{"Null": {
 *     "aws:RequestTag/ManagedBy": "true", "aws:RequestTag/Stack": "true" }}`
 *     denies a request that is missing *both* tags, so supplying either one
 *     passes. That reads as "require both" and enforces "require at least one".
 *     Each required key therefore gets a statement of its own, and
 *     {@link validateTaggingPolicy} refuses a document that conjoins them.
 *
 *   • **An SCP is capped at 5,120 bytes.** The cap is what makes "just list
 *     every create action" fail, and it fails at `AttachPolicy` time in the
 *     management account — a long way from the pull request that grew the list.
 *     {@link SCP_MAX_BYTES} is checked here instead, against the document as it
 *     is written to disk. That is the conservative end of the measurement:
 *     Organizations does not count every whitespace character, so this gate
 *     fires before AWS would rather than after.
 *
 *   • **An SCP never applies to the organization's management account**, however
 *     it is attached, and never to a service-linked role. Resources created
 *     there are untagged whatever this document says, which is not a hole to be
 *     closed — it is a documented share of the untagged bucket that the
 *     dashboard has to be read with. See `docs/cost-allocation.md`.
 *
 * The cost-allocation half is a separate activation that nothing in
 * CloudFormation performs. A tag key is only usable as a Cost Explorer grouping
 * once it is activated in Billing, the activation applies from that day forward
 * and **is not retroactive**, and an un-activated key is not an error: Cost
 * Explorer returns an empty group list, which renders as a flat zero line and
 * reads as "nothing spent on that". `costAllocation` on each entry records the
 * intent, `CostAllocationStack` publishes whether AWS agrees, and
 * `npm run audit:tagging` holds the two together.
 */

/**
 * Cap AWS Organizations puts on a single SCP document, in bytes.
 *
 * Measured here against the pretty-printed document that is checked in, which
 * is never smaller than what Organizations counts.
 */
export const SCP_MAX_BYTES = 5120;

/** Cap AWS Organizations puts on a single tag policy document, in bytes. */
export const TAG_POLICY_MAX_BYTES = 10000;

/** Tag key AWS reserves; nothing in a customer policy may govern this prefix. */
export const RESERVED_TAG_PREFIX = 'aws:';

/**
 * What the SCP does about a tag.
 *
 * `deny-on-create` — a request that omits the tag is denied outright.
 * `deny-bad-value` — the tag may be omitted, but a value outside `allowedValues`
 *                    is denied. Used where a tag is genuinely inapplicable to
 *                    some resources, which `Environment` is: four stacks here
 *                    are account-scoped and carry no true environment.
 * `advisory`       — the tag policy standardises its spelling and nothing denies
 *                    anything. Used where enforcement would deny more than it
 *                    protects.
 */
export type TagEnforcement = 'deny-on-create' | 'deny-bad-value' | 'advisory';

/**
 * Whether the key is activated as a cost allocation tag in the Billing console.
 *
 * `activated`     — `ce:ListCostAllocationTags` reports it Active, Cost Explorer
 *                   can group on it, and the dashboard draws it.
 * `not-activated` — deliberately not a grouping. Requires a `note`.
 */
export type CostAllocationStatus = 'activated' | 'not-activated';

export interface GovernedTag {
  /** Exact key, case included. IAM condition keys and Cost Explorer are both case-sensitive. */
  readonly key: string;
  /** What the tag is for, in one line. Appears in the generated tag policy's documentation. */
  readonly purpose: string;
  readonly enforcement: TagEnforcement;
  readonly costAllocation: CostAllocationStatus;
  /**
   * The closed set of values, where there is one.
   *
   * Required for `deny-bad-value` (there is nothing to compare against
   * otherwise) and for every `activated` key, because the dashboard draws one
   * series per declared value — a value nobody declared cannot appear on a
   * graph, which is why the reporter publishes `UnexpectedTagValue` separately.
   */
  readonly allowedValues?: readonly string[];
  /** Why this entry is advisory, un-activated, or otherwise less than it looks. */
  readonly note?: string;
}

export interface TaggingFinding {
  /** Tag key, action, or `<catalogue>` for a finding about the set as a whole. */
  readonly subject: string;
  readonly rule: string;
  readonly message: string;
}

/**
 * The tags this organization governs.
 *
 * `ManagedBy` and `Stack` are the two `policy/cloudformation/tags.rego`
 * requires, and they are required here for the same reason: together they are
 * what makes an orphaned resource identifiable two years later. They are also
 * the two that can be required unconditionally, because every resource has a
 * creator and a defining stack.
 *
 * `Environment` is `deny-bad-value` rather than `deny-on-create`, matching the
 * rego pack exactly: `AppConfigStack`, `DoraMetricsStack`,
 * `FeatureFlagLifecycleStack` and `RightSizingStack` are account-scoped and have
 * no true environment to name, and inventing `shared` would read in Cost
 * Explorer as a fourth environment rather than as "spans all of them". So an
 * absent `Environment` is allowed and a misspelt one is not.
 *
 * `Project` and `CostCenter` are what `bin/app.ts` applies through the stack
 * `tags` prop. They are the two groupings a finance review actually asks for,
 * and they are advisory on purpose: they are applied at stack level by every
 * stack in this tree, so a create-time deny would buy nothing here while
 * breaking every console action taken in the account by someone diagnosing an
 * incident.
 */
export const GOVERNED_TAGS: readonly GovernedTag[] = [
  {
    key: 'ManagedBy',
    purpose: 'Says the resource belongs to a deployment tool and must not be edited in the console',
    enforcement: 'deny-on-create',
    costAllocation: 'not-activated',
    allowedValues: ['CDK', 'Terraform', 'Console-BreakGlass'],
    note:
      'Not a cost grouping: it separates tools, not spend. Activating it would add a fourth ' +
      'dimension to every Cost Explorer query that answers a question nobody asks of a bill.',
  },
  {
    key: 'Stack',
    purpose: 'Names the stack that would recreate the resource if it were deleted',
    enforcement: 'deny-on-create',
    costAllocation: 'not-activated',
    note:
      'Free-form by necessity — the value is a stack name — and not activated: Cost Explorer ' +
      'caps cost allocation tags at 500 per account and a per-stack breakdown is the one ' +
      'grouping already available through CloudFormation itself.',
  },
  {
    key: 'Environment',
    purpose: 'Separates staging, production, and ephemeral preview spend',
    enforcement: 'deny-bad-value',
    costAllocation: 'activated',
    allowedValues: ['staging', 'production', 'preview'],
    note:
      'Deliberately not required on create: four account-scoped stacks carry no Environment tag ' +
      'because there is no true value to give them, and their spend is a known, documented ' +
      'share of the untagged bucket.',
  },
  {
    key: 'Project',
    purpose: 'Attributes spend to a product line when one account carries several',
    enforcement: 'advisory',
    costAllocation: 'activated',
    allowedValues: ['boilerplate'],
    note:
      'Advisory: every stack in bin/app.ts applies it through the stack tags prop, so a ' +
      'create-time deny would protect nothing here and would block the console actions taken ' +
      'while diagnosing an incident.',
  },
  {
    key: 'CostCenter',
    purpose: 'The ledger code a finance review reconciles the bill against',
    enforcement: 'advisory',
    costAllocation: 'activated',
    allowedValues: ['engineering', 'platform'],
    note:
      'Advisory for the same reason as Project. The spelling is the thing worth governing: ' +
      'CostCentre and costcenter are different keys to both IAM and Cost Explorer, and the tag ' +
      'policy is what rejects the second spelling.',
  },
];

/** How an action relates to tag-on-create enforcement. */
export type ScpCoverage = 'enforced' | 'no-tag-on-create';

export interface ScpAction {
  /** IAM action, e.g. `lambda:CreateFunction`. */
  readonly action: string;
  readonly coverage: ScpCoverage;
  /** CloudFormation types this action brings into existence, as `tags.rego` names them. */
  readonly resourceTypes: readonly string[];
  /** Required when `coverage` is `no-tag-on-create`: why the action cannot be denied. */
  readonly reason?: string;
  /**
   * The service's own tag-*removal* actions, which are not uniformly named.
   *
   * Every service invented its own: `UntagResource`, `UntagQueue`, `RemoveTags`,
   * `RemoveTagsFromResource`, `DeleteTags`. There is no wildcard that covers
   * them — IAM's action grammar is `service:Action`, so `*:Untag*` is not a
   * valid action and a policy containing one is rejected rather than
   * interpreted generously.
   *
   * On every action named here, `aws:TagKeys` holds the keys being *removed*,
   * which is what makes a deny on the governed keys mean what it reads as. That
   * is not true of a replace-the-whole-set call such as
   * `s3:PutBucketTagging`, where `aws:TagKeys` holds the keys being *set* — a
   * deny there would forbid applying the governed tags at all. Those entries
   * therefore list nothing, by the same logic that keeps their create action
   * out of the policy.
   */
  readonly tagRemovalActions?: readonly string[];
}

/**
 * Every create action that stands between this organization and an untagged,
 * billable resource — and, for each, whether an SCP can do anything about it.
 *
 * The list is short on purpose. It is not "every taggable AWS API": it is the
 * creators of the resource types `policy/cloudformation/tags.rego` governs,
 * which is the list of things in this account that cost money, hold data, or
 * grant access. `npm run audit:tagging` reconciles the two, so a type added to
 * the rego pack and not to this list is a finding rather than a quiet gap.
 *
 * The `no-tag-on-create` entries are the point of the catalogue. Each one is a
 * resource whose creation genuinely cannot be denied for want of a tag, because
 * the create API has no tag parameter for `aws:RequestTag` to read. Omitting
 * them would leave a list that looks complete; including them with a reason is
 * what makes the coverage hole legible — and the hole is directly visible on the
 * dashboard, as the untagged slice those services contribute.
 */
export const SCP_ACTION_CATALOGUE: readonly ScpAction[] = [
  {
    action: 'ec2:CreateVolume',
    coverage: 'enforced',
    tagRemovalActions: ['ec2:DeleteTags'],
    resourceTypes: [],
  },
  {
    action: 'ec2:CreateVpc',
    coverage: 'enforced',
    tagRemovalActions: ['ec2:DeleteTags'],
    resourceTypes: ['AWS::EC2::VPC'],
  },
  {
    action: 'ec2:CreateSecurityGroup',
    coverage: 'enforced',
    tagRemovalActions: ['ec2:DeleteTags'],
    resourceTypes: ['AWS::EC2::SecurityGroup'],
  },
  {
    action: 'rds:CreateDBInstance',
    coverage: 'enforced',
    tagRemovalActions: ['rds:RemoveTagsFromResource'],
    resourceTypes: ['AWS::RDS::DBInstance'],
  },
  {
    action: 'rds:CreateDBCluster',
    coverage: 'enforced',
    tagRemovalActions: ['rds:RemoveTagsFromResource'],
    resourceTypes: ['AWS::RDS::DBCluster'],
  },
  {
    action: 'elasticache:CreateReplicationGroup',
    coverage: 'enforced',
    tagRemovalActions: ['elasticache:RemoveTagsFromResource'],
    resourceTypes: ['AWS::ElastiCache::ReplicationGroup'],
  },
  {
    action: 'ecs:CreateCluster',
    coverage: 'enforced',
    tagRemovalActions: ['ecs:UntagResource'],
    resourceTypes: ['AWS::ECS::Cluster'],
  },
  {
    action: 'ecs:CreateService',
    coverage: 'enforced',
    tagRemovalActions: ['ecs:UntagResource'],
    resourceTypes: ['AWS::ECS::Service'],
  },
  {
    action: 'ecs:RegisterTaskDefinition',
    coverage: 'enforced',
    tagRemovalActions: ['ecs:UntagResource'],
    resourceTypes: ['AWS::ECS::TaskDefinition'],
  },
  {
    action: 'eks:CreateCluster',
    coverage: 'enforced',
    tagRemovalActions: ['eks:UntagResource'],
    resourceTypes: ['AWS::EKS::Cluster'],
  },
  {
    action: 'lambda:CreateFunction',
    coverage: 'enforced',
    tagRemovalActions: ['lambda:UntagResource'],
    resourceTypes: ['AWS::Lambda::Function'],
  },
  {
    action: 'dynamodb:CreateTable',
    coverage: 'enforced',
    tagRemovalActions: ['dynamodb:UntagResource'],
    resourceTypes: ['AWS::DynamoDB::Table'],
  },
  {
    action: 'sqs:CreateQueue',
    coverage: 'enforced',
    tagRemovalActions: ['sqs:UntagQueue'],
    resourceTypes: ['AWS::SQS::Queue'],
  },
  {
    action: 'sns:CreateTopic',
    coverage: 'enforced',
    tagRemovalActions: ['sns:UntagResource'],
    resourceTypes: ['AWS::SNS::Topic'],
  },
  {
    action: 'kms:CreateKey',
    coverage: 'enforced',
    tagRemovalActions: ['kms:UntagResource'],
    resourceTypes: ['AWS::KMS::Key'],
  },
  {
    action: 'elasticloadbalancing:CreateLoadBalancer',
    coverage: 'enforced',
    tagRemovalActions: ['elasticloadbalancing:RemoveTags'],
    resourceTypes: ['AWS::ElasticLoadBalancingV2::LoadBalancer'],
  },
  {
    action: 'autoscaling:CreateAutoScalingGroup',
    coverage: 'enforced',
    tagRemovalActions: ['autoscaling:DeleteTags'],
    resourceTypes: ['AWS::AutoScaling::AutoScalingGroup'],
  },
  {
    action: 's3:CreateBucket',
    coverage: 'no-tag-on-create',
    resourceTypes: ['AWS::S3::Bucket'],
    reason:
      'CreateBucket has no tag parameter — a bucket is tagged by a separate PutBucketTagging ' +
      'call, so aws:RequestTag is absent from every CreateBucket request including a compliant ' +
      "one. A Null condition on it denies all bucket creation, which is not this policy's job.",
  },
  {
    action: 'cloudfront:CreateDistribution',
    coverage: 'no-tag-on-create',
    resourceTypes: ['AWS::CloudFront::Distribution'],
    reason:
      'Tags go through the separate CreateDistributionWithTags action. Denying ' +
      'CreateDistribution for a missing aws:RequestTag denies the untagged and the tagged path ' +
      'alike, since the tagged path is a different action.',
  },
  {
    action: 'logs:CreateLogGroup',
    coverage: 'no-tag-on-create',
    resourceTypes: ['AWS::Logs::LogGroup'],
    reason:
      'A log group is most often created implicitly by the service that writes to it — Lambda ' +
      'creates one on first invocation, under the principal of the invoked function and with no ' +
      'tags. Denying it turns a missing tag into a function whose logs silently go nowhere.',
  },
  {
    action: 'events:PutRule',
    coverage: 'no-tag-on-create',
    resourceTypes: ['AWS::Events::Rule'],
    reason:
      'PutRule is an upsert, not a create: the same action edits an existing rule, so a ' +
      'create-time tag condition on it also governs every later schedule change. Rules carry ' +
      'no cost of their own, so the trade is not worth making.',
  },
  {
    action: 'iam:CreateRole',
    coverage: 'no-tag-on-create',
    resourceTypes: ['AWS::IAM::Role'],
    reason:
      'IAM CreateRole does accept tags, but roles are free and a deny here reaches the ' +
      'service-linked and bootstrap roles that CloudFormation itself creates mid-deploy. ' +
      'Ownership of a role is covered by the rego pack, which reads what CDK declares.',
  },
];

/** A single statement in a generated policy document. */
export interface PolicyStatement {
  readonly Sid: string;
  readonly Effect: 'Deny';
  readonly Action: readonly string[];
  readonly Resource: '*';
  readonly Condition: Record<string, Record<string, string | readonly string[]>>;
}

export interface PolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: readonly PolicyStatement[];
}

/** Keys the SCP denies a create request for. */
export const requiredTagKeys = (tags: readonly GovernedTag[] = GOVERNED_TAGS): string[] =>
  tags.filter((tag) => tag.enforcement === 'deny-on-create').map((tag) => tag.key);

/** Keys whose value the SCP constrains, whether or not the key itself is required. */
export const valueConstrainedTagKeys = (tags: readonly GovernedTag[] = GOVERNED_TAGS): string[] =>
  tags
    .filter(
      (tag) =>
        (tag.enforcement === 'deny-on-create' || tag.enforcement === 'deny-bad-value') &&
        tag.allowedValues !== undefined,
    )
    .map((tag) => tag.key);

/** Keys the dashboard groups cost by. */
export const costAllocationTagKeys = (tags: readonly GovernedTag[] = GOVERNED_TAGS): string[] =>
  tags.filter((tag) => tag.costAllocation === 'activated').map((tag) => tag.key);

/** Actions the SCP conditions, in the order they appear in the document. */
export const enforcedScpActions = (
  actions: readonly ScpAction[] = SCP_ACTION_CATALOGUE,
): string[] =>
  actions
    .filter((entry) => entry.coverage === 'enforced')
    .map((entry) => entry.action)
    .sort();

/**
 * Every tag-removal action the enforced entries name, deduplicated and sorted.
 *
 * Only from `enforced` entries: an action whose create cannot be denied is one
 * whose resources the policy does not govern in the first place, and denying
 * the removal of a tag that was never required is a rule that only ever fires
 * on somebody tidying up.
 */
export const tagRemovalActions = (actions: readonly ScpAction[] = SCP_ACTION_CATALOGUE): string[] =>
  [
    ...new Set(
      actions
        .filter((entry) => entry.coverage === 'enforced')
        .flatMap((entry) => entry.tagRemovalActions ?? []),
    ),
  ].sort();

/** Look a tag up by key, throwing rather than returning undefined. */
export const requireGovernedTag = (
  key: string,
  tags: readonly GovernedTag[] = GOVERNED_TAGS,
): GovernedTag => {
  const found = tags.find((tag) => tag.key === key);
  if (found === undefined) {
    throw new Error(
      `No governed tag '${key}'. Declared keys: ${tags.map((tag) => tag.key).join(', ')}.`,
    );
  }
  return found;
};

/**
 * The service control policy.
 *
 * One statement per required key, never one statement listing them all: the
 * conditions inside a single `Null` block are ANDed, so a combined statement
 * denies only the request that omits every key at once. A value constraint pairs
 * `StringNotEqualsIfExists` with `Null: "false"` — the first alone evaluates to
 * false for an absent key under some condition-key semantics, and the pair says
 * plainly "if the tag is present, it must be one of these".
 *
 * The last statement protects the tags after creation. Without it, every deny
 * above is a one-time check that an `UntagResource` call undoes, and an
 * untagged-after-the-fact resource is exactly as invisible to Cost Explorer as
 * one that was never tagged.
 */
export const buildTagEnforcementScp = (
  tags: readonly GovernedTag[] = GOVERNED_TAGS,
  actions: readonly ScpAction[] = SCP_ACTION_CATALOGUE,
): PolicyDocument => {
  const enforced = enforcedScpActions(actions);
  const statements: PolicyStatement[] = [];

  for (const tag of tags) {
    if (tag.enforcement !== 'deny-on-create') continue;
    statements.push({
      Sid: `DenyCreateWithout${tag.key}`,
      Effect: 'Deny',
      Action: enforced,
      Resource: '*',
      Condition: { Null: { [`aws:RequestTag/${tag.key}`]: 'true' } },
    });
  }

  for (const tag of tags) {
    if (tag.enforcement === 'advisory' || tag.allowedValues === undefined) continue;
    statements.push({
      Sid: `Deny${tag.key}OutsideAllowedValues`,
      Effect: 'Deny',
      Action: enforced,
      Resource: '*',
      Condition: {
        StringNotEqualsIfExists: { [`aws:RequestTag/${tag.key}`]: [...tag.allowedValues] },
        Null: { [`aws:RequestTag/${tag.key}`]: 'false' },
      },
    });
  }

  const protectedKeys = tags
    .filter((tag) => tag.enforcement !== 'advisory')
    .map((tag) => tag.key)
    .sort();
  const removalActions = tagRemovalActions(actions);

  if (protectedKeys.length > 0 && removalActions.length > 0) {
    statements.push({
      Sid: 'DenyRemovalOfGovernedTags',
      Effect: 'Deny',
      Action: removalActions,
      Resource: '*',
      Condition: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': protectedKeys } },
    });
  }

  return { Version: '2012-10-17', Statement: statements };
};

/** One key's entry in an Organizations tag policy. */
interface TagPolicyEntry {
  readonly tag_key: { '@@assign': string };
  readonly tag_value?: { '@@assign': readonly string[] };
}

export interface TagPolicyDocument {
  readonly tags: Record<string, TagPolicyEntry>;
}

/**
 * The Organizations tag policy.
 *
 * This is the half that governs *spelling*. `aws:RequestTag/CostCenter` and
 * `aws:RequestTag/costcenter` are different condition keys and
 * `Environment=Production` and `Environment=production` are different Cost
 * Explorer groups, and no SCP written against one spelling says anything about
 * the other. A tag policy declares the canonical key and, where there is one,
 * the closed value set.
 *
 * What it does *not* do is enforce anything by itself. Without an
 * `@@operators_allowed_for_child_policies` restriction and a per-resource-type
 * enforcement block it reports non-compliance and allows the request, and even
 * with enforcement it governs `TagResource`, not resource creation. That is why
 * this document is generated alongside the SCP rather than instead of it, and
 * why `tag_value` is only emitted for a key that has a closed set — an
 * `@@assign` of every value a free-form key might take is a list that is wrong
 * the first time someone adds a stack.
 */
export const buildOrganizationsTagPolicy = (
  tags: readonly GovernedTag[] = GOVERNED_TAGS,
): TagPolicyDocument => {
  const entries: Record<string, TagPolicyEntry> = {};
  for (const tag of tags) {
    entries[tag.key] =
      tag.allowedValues === undefined
        ? { tag_key: { '@@assign': tag.key } }
        : { tag_key: { '@@assign': tag.key }, tag_value: { '@@assign': [...tag.allowedValues] } };
  }
  return { tags: entries };
};

/** Serialised exactly as the checked-in file is written, so sizes and diffs agree. */
export const serialisePolicy = (document: unknown): string =>
  `${JSON.stringify(document, null, 2)}\n`;

/**
 * IAM's action grammar: a concrete service prefix, then a name that may wildcard.
 *
 * The service prefix may not be a wildcard. `*:Untag*` looks like it covers
 * every service's tag-removal call and is simply not a valid action — IAM
 * rejects the policy rather than interpreting it generously, and the rejection
 * happens at `CreatePolicy` time in the management account.
 */
const IAM_ACTION = /^[a-z0-9-]+:[A-Za-z0-9*?]+$/;

/**
 * Every way the catalogue or the documents it generates can be wrong while
 * still looking like a policy.
 *
 * Rules:
 *   duplicate-tag-key          the same key declared twice
 *   reserved-tag-key           a key under the `aws:` prefix AWS owns
 *   tag-key-case-collision     two keys differing only in case
 *   missing-allowed-values     a value constraint with nothing to compare against
 *   empty-allowed-values       an allowed set with no members
 *   duplicate-allowed-value    a value listed twice in one set
 *   activated-without-values   a cost grouping whose values the dashboard cannot draw
 *   unexplained-exception      an advisory or un-activated key with no recorded reason
 *   no-enforced-action         a deny statement that governs no action at all
 *   missing-reason             an unenforceable action with no reason recorded
 *   duplicate-action           the same action listed twice
 *   invalid-action-format      an action IAM's grammar does not accept
 *   removal-unprotected        an enforced create whose tags can be removed again
 *   removal-on-unenforced      removal actions on a create nobody enforces
 *   conjoined-null-condition   one statement requiring several keys at once
 *   scp-too-large              a document over the 5,120-byte Organizations cap
 *   tag-policy-too-large       a tag policy over the 10,000-byte cap
 */
export const validateTaggingPolicy = (
  tags: readonly GovernedTag[] = GOVERNED_TAGS,
  actions: readonly ScpAction[] = SCP_ACTION_CATALOGUE,
): TaggingFinding[] => {
  const findings: TaggingFinding[] = [];
  const report = (subject: string, rule: string, message: string) =>
    findings.push({ subject, rule, message });

  const seen = new Set<string>();
  const seenLower = new Map<string, string>();

  for (const tag of tags) {
    if (seen.has(tag.key)) {
      report(
        tag.key,
        'duplicate-tag-key',
        `'${tag.key}' is declared twice. The second declaration generates a second statement ` +
          'denying the same thing, and the two can disagree about allowed values without ' +
          'either being obviously wrong.',
      );
    }
    seen.add(tag.key);

    const lower = tag.key.toLowerCase();
    const earlier = seenLower.get(lower);
    if (earlier !== undefined && earlier !== tag.key) {
      report(
        tag.key,
        'tag-key-case-collision',
        `'${tag.key}' and '${earlier}' differ only in case. IAM condition keys and Cost Explorer ` +
          'groupings are both case-sensitive, so these are two tags — and the bill will be split ' +
          'across both without anything reporting an error.',
      );
    }
    seenLower.set(lower, tag.key);

    if (tag.key.toLowerCase().startsWith(RESERVED_TAG_PREFIX)) {
      report(
        tag.key,
        'reserved-tag-key',
        `'${tag.key}' is under the '${RESERVED_TAG_PREFIX}' prefix AWS reserves. A request ` +
          'carrying it is rejected by the service, so the deny below it can never be reached.',
      );
    }

    if (tag.enforcement === 'deny-bad-value' && tag.allowedValues === undefined) {
      report(
        tag.key,
        'missing-allowed-values',
        `'${tag.key}' constrains its value and declares no allowed values. The generated ` +
          'statement would compare against an empty list, which denies every value including ' +
          'the intended ones.',
      );
    }

    if (tag.allowedValues !== undefined) {
      if (tag.allowedValues.length === 0) {
        report(
          tag.key,
          'empty-allowed-values',
          `'${tag.key}' declares an empty allowed set. StringNotEqualsIfExists against an empty ` +
            'list matches every present value, so the tag becomes impossible to set.',
        );
      }
      const values = new Set<string>();
      for (const value of tag.allowedValues) {
        if (values.has(value)) {
          report(
            tag.key,
            'duplicate-allowed-value',
            `'${tag.key}' lists '${value}' twice. Harmless in the policy and not in the ` +
              'dashboard, which draws one series per declared value and would draw two ' +
              'identical ones.',
          );
        }
        values.add(value);
      }
    }

    if (tag.costAllocation === 'activated' && tag.allowedValues === undefined) {
      report(
        tag.key,
        'activated-without-values',
        `'${tag.key}' is a cost grouping with no declared values. The dashboard draws one series ` +
          'per declared value, so this key would be activated, queried, billed for, and ' +
          'invisible.',
      );
    }

    if ((tag.enforcement === 'advisory' || tag.costAllocation === 'not-activated') && !tag.note) {
      report(
        tag.key,
        'unexplained-exception',
        `'${tag.key}' is advisory or not activated and records no reason. An exception nobody ` +
          'wrote a reason for is indistinguishable from an omission, and gets "fixed" by the ' +
          'next reader.',
      );
    }
  }

  const seenActions = new Set<string>();
  for (const entry of actions) {
    if (seenActions.has(entry.action)) {
      report(
        entry.action,
        'duplicate-action',
        `'${entry.action}' is listed twice, which spends the byte budget twice over.`,
      );
    }
    seenActions.add(entry.action);

    if (entry.coverage === 'no-tag-on-create' && !entry.reason) {
      report(
        entry.action,
        'missing-reason',
        `'${entry.action}' is excluded from the policy with no reason recorded. An action left ` +
          'out deliberately and one nobody thought of look identical in a list.',
      );
    }

    for (const candidate of [entry.action, ...(entry.tagRemovalActions ?? [])]) {
      if (!IAM_ACTION.test(candidate)) {
        report(
          candidate,
          'invalid-action-format',
          `'${candidate}' is not an action IAM accepts: the service prefix must be concrete ` +
            "and only the name after the colon may wildcard. There is no '*:Untag*' covering " +
            'every service — the policy is rejected at CreatePolicy time in the management ' +
            'account, where nobody is looking at this change.',
        );
      }
    }

    if (entry.coverage === 'enforced' && (entry.tagRemovalActions ?? []).length === 0) {
      report(
        entry.action,
        'removal-unprotected',
        `'${entry.action}' is denied without the governed tags and names no tag-removal ` +
          'action, so the tags can be taken off the moment the resource exists. A resource ' +
          'untagged after the fact is exactly as invisible to Cost Explorer as one that was ' +
          'never tagged.',
      );
    }

    if (entry.coverage !== 'enforced' && (entry.tagRemovalActions ?? []).length > 0) {
      report(
        entry.action,
        'removal-on-unenforced',
        `'${entry.action}' cannot be enforced at create time and still lists tag-removal ` +
          'actions. They are not emitted into the policy, so the list reads as protection ' +
          'that does not exist.',
      );
    }
  }

  const document = buildTagEnforcementScp(tags, actions);

  if (enforcedScpActions(actions).length === 0 && document.Statement.length > 0) {
    report(
      '<catalogue>',
      'no-enforced-action',
      'The policy has statements and no enforceable action, so every Deny governs an empty ' +
        'action list. It attaches cleanly and denies nothing.',
    );
  }

  for (const statement of document.Statement) {
    const nullKeys = Object.keys(statement.Condition.Null ?? {});
    const other = Object.keys(statement.Condition).filter((key) => key !== 'Null');
    if (nullKeys.length > 1 && other.length === 0) {
      report(
        statement.Sid,
        'conjoined-null-condition',
        `'${statement.Sid}' puts ${nullKeys.length} keys in one Null block. Conditions inside a ` +
          'block are ANDed, so this denies only the request missing every one of them — it ' +
          'reads as "require all" and enforces "require at least one".',
      );
    }
  }

  const scpBytes = Buffer.byteLength(serialisePolicy(document), 'utf8');
  if (scpBytes > SCP_MAX_BYTES) {
    report(
      '<catalogue>',
      'scp-too-large',
      `The generated SCP is ${scpBytes} bytes as written, over the ${SCP_MAX_BYTES}-byte ` +
        'Organizations cap. AttachPolicy rejects it in the management account, a long way ' +
        'from the change that grew it. Shorten the action list rather than dropping a ' +
        'required tag — every required key repeats the whole action list once more.',
    );
  }

  const tagPolicyBytes = Buffer.byteLength(
    serialisePolicy(buildOrganizationsTagPolicy(tags)),
    'utf8',
  );
  if (tagPolicyBytes > TAG_POLICY_MAX_BYTES) {
    report(
      '<catalogue>',
      'tag-policy-too-large',
      `The generated tag policy is ${tagPolicyBytes} bytes, over the ${TAG_POLICY_MAX_BYTES}-byte cap.`,
    );
  }

  return findings;
};

/** Synth-time guard: a bad catalogue should not reach a template. */
export const assertValidTaggingPolicy = (
  tags: readonly GovernedTag[] = GOVERNED_TAGS,
  actions: readonly ScpAction[] = SCP_ACTION_CATALOGUE,
): void => {
  const findings = validateTaggingPolicy(tags, actions);
  if (findings.length > 0) {
    throw new Error(
      `Invalid tagging policy:\n${findings
        .map((finding) => `  ${finding.subject} [${finding.rule}] ${finding.message}`)
        .join('\n')}`,
    );
  }
};
