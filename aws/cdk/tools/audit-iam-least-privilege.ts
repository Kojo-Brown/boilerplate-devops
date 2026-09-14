#!/usr/bin/env node
/**
 * Audit IAM least privilege across the synthesised CloudFormation, and the CI
 * wiring that runs the IAM Access Analyzer report beside it.
 *
 * `CLAUDE.md` has said "least privilege by default; document any wildcard in an
 * IAM policy" since this repository started, and nothing has ever checked it.
 * Every other gate here reasons about an artifact — what is in the image, who
 * signed it, what it was built from. This one reasons about what the account
 * lets the pipeline *do*, which is the blast radius of all of them: an attacker
 * who gets a step to run arbitrary code inherits the job's role, and what
 * happens next is decided entirely by that role's policy.
 *
 * **Two gates, deliberately, because one of them cannot run on a pull request.**
 *
 *   • This tool is offline. It reads `cdk.out/*.template.json` and needs no AWS
 *     account, so it runs on every PR including from a fork, and it blocks.
 *     It is curated rather than exhaustive: every rule here is one whose
 *     finding is a defect in this repository's own source and is fixable in
 *     this repository's own source.
 *
 *   • `.github/workflows/iam-access-analyzer.yml` runs AWS's own
 *     `cfn-policy-validator`, which sends each parsed policy to IAM Access
 *     Analyzer. That knows the full authorization model — which actions accept
 *     a resource ARN, which condition keys narrow what — and this tool never
 *     will. It needs credentials (`cfn-policy-validator` calls
 *     `sts:GetCallerIdentity` before it does anything else and exits 1 without
 *     them), so it is credential-gated and is not a required check.
 *
 * Neither subsumes the other. The offline gate is what holds on the pull
 * request in front of you; the analyzer is the authority, on the schedule an
 * account is available.
 *
 * The failure modes this exists for:
 *
 *   • **`iam:PassRole` on `"*"` with an `iam:PassedToService` condition.** This
 *     reads, in review, as the scoped version of PassRole — it has a condition,
 *     it names one service, and the sid usually says so (ours said
 *     `PassRoleToECS`). The condition narrows *where the role goes*, not
 *     *which role goes there*: with `ecs:RegisterTaskDefinition` next to it,
 *     the holder can register a task definition naming any role in the account
 *     that ECS tasks can assume, and run it. That is a privilege escalation to
 *     the most privileged task role in the account, and it was two statements
 *     apart in our own GitHub deploy role.
 *
 *   • **`ReadOnlyAccess` where `ViewOnlyAccess` was meant.** The names differ
 *     by a word and the policies differ by the data plane: `ReadOnlyAccess`
 *     grants `s3:GetObject`, `dynamodb:GetItem`, `sqs:ReceiveMessage`,
 *     `ssm:GetParameter` and `lambda:GetFunction` (whose response carries the
 *     function's environment variables) account-wide. Attached to a role a
 *     GitHub workflow assumes, it makes every object in the account readable by
 *     anyone who can get a job to run. `ViewOnlyAccess` is the metadata-only
 *     one, and is what "read-only for dashboards" nearly always means.
 *
 *   • **A gate that is not one.** `cfn-policy-validator` has
 *     `--ignore-finding`, and `check-access-not-granted` has
 *     `--treat-findings-as-non-blocking`; either turns a red report green
 *     without touching a policy, and `--treat-finding-type-as-blocking` set to
 *     something narrower than the default quietly does the same. The report
 *     still prints findings either way, which is what makes it survive review.
 *
 * The rules, and the failure each one prevents:
 *
 *   action-wildcard             `Action: "*"` in an Allow — administrator
 *   service-action-wildcard     `Action: "s3:*"` — every action of a service,
 *                               including the ones added after this was written
 *   not-action-allow            an Allow written by exclusion, which grants
 *                               every future action nobody has excluded yet
 *   not-resource-allow          the same mistake on the resource half
 *   passrole-unscoped           `iam:PassRole` on `"*"`, condition or not
 *   admin-managed-policy        an AWS managed policy that is administrator
 *                               access under another name
 *   account-wide-read-policy    `ReadOnlyAccess`, the data-plane one
 *   privileged-action-unscoped  `Resource: "*"`, no condition, on an action
 *                               that reads data, changes what runs, or grants
 *                               access (see PRIVILEGED_ACTIONS)
 *   principal-wildcard          `Principal: "*"` with nothing narrowing it
 *   github-oidc-trust-unscoped  a GitHub OIDC trust missing its `aud` check, or
 *                               whose `sub` is not pinned to one repository
 *   analyzer-report-missing     no workflow runs the Access Analyzer report
 *   analyzer-findings-ignored   it runs, and cannot fail
 *   analyzer-unpinned           its version floats, so the verdict is whatever
 *                               PyPI served this morning
 *   audit-not-run-in-ci         this gate is not wired into a job
 *
 * **Out of scope, deliberately.** Whether an action *can* be scoped to an ARN
 * is a property of AWS's authorization model, not of this template, and a
 * hand-maintained table of it goes stale silently and in the direction that
 * reports work nobody can do — `cloudwatch:GetMetricData`, `ec2:Describe*` and
 * `ecr:GetAuthorizationToken` take no resource at all. So `Resource: "*"` is a
 * finding here only for the curated privileged set, and the exhaustive answer
 * comes from Access Analyzer, which has the model. A gate that reported all 45
 * of this repository's `Resource: "*"` statements would be asking for a
 * baseline file within a week, and the six real ones would be inside it.
 *
 * Policies the CDK framework generates for its own custom resources are not
 * this repository's to fix and are skipped by construct path; the count is
 * printed on success so the exemption cannot grow unnoticed. The one other
 * carve-out is the `kms:*`-to-account-root statement every KMS key policy
 * carries, which is how a key says "IAM governs me" rather than a grant — see
 * `isAccountRootDelegation`.
 *
 * Usage:
 *   npm run audit:iam                                      # repository root
 *   npx ts-node tools/audit-iam-least-privilege.ts <dir>
 *
 * Requires `cdk synth` to have run. Exits non-zero when anything is found.
 * See docs/iam-least-privilege.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';

export type ViolationRule =
  | 'action-wildcard'
  | 'service-action-wildcard'
  | 'not-action-allow'
  | 'not-resource-allow'
  | 'passrole-unscoped'
  | 'admin-managed-policy'
  | 'account-wide-read-policy'
  | 'privileged-action-unscoped'
  | 'principal-wildcard'
  | 'github-oidc-trust-unscoped'
  | 'analyzer-report-missing'
  | 'analyzer-findings-ignored'
  | 'analyzer-unpinned'
  | 'audit-not-run-in-ci';

export interface Violation {
  readonly rule: ViolationRule;
  /** Template file name, or repository-relative path for a workflow finding. */
  readonly file: string;
  /** The CDK construct path, or `statement <sid>`, or a description. */
  readonly location: string;
  readonly message: string;
}

const violation = (
  rule: ViolationRule,
  file: string,
  location: string,
  message: string,
): Violation => ({ rule, file, location, message });

/* ── The CloudFormation this reads ────────────────────────────────────────── */

/** A synthesised template: `cdk.out`-relative file name plus parsed JSON. */
export interface TemplateFile {
  readonly path: string;
  readonly document: unknown;
}

/** A workflow: repository-relative path plus parsed YAML. */
export interface WorkflowFile {
  readonly path: string;
  readonly document: unknown;
}

/** A file read as text: repository-relative path plus raw contents. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface AuditInput {
  readonly templates: readonly TemplateFile[];
  readonly workflows: readonly WorkflowFile[];
  /** `.github/scripts/run-iam-access-analyzer.sh`, when it exists. */
  readonly analyzerScript?: SourceFile;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** CloudFormation accepts a scalar wherever it accepts a list of them. */
const asList = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const asStrings = (value: unknown): string[] =>
  asList(value).filter((entry): entry is string => typeof entry === 'string');

/**
 * Intrinsics whose argument is a *name*, not text that appears in the result.
 *
 * `{"Ref": "AWS::AccountId"}` contributes the account id to the rendered ARN,
 * never the string `AWS::AccountId`. Flattening it naively is how
 * `arn:aws:iam::${AWS::AccountId}:root` reads back as
 * `arn:aws:iam::AWS::AccountId:root` and matches nothing.
 */
const OPAQUE_INTRINSICS = ['Ref', 'Fn::GetAtt', 'Fn::ImportValue'];

/**
 * Every *literal* string leaf of a value, concatenated, with intrinsics left
 * as the placeholders they are.
 *
 * A synthesised ARN is rarely a string — `ReadOnlyAccess` arrives as
 * `{"Fn::Join": ["", ["arn:", {"Ref": "AWS::Partition"}, ":iam::aws:policy/ReadOnlyAccess"]]}`
 * and flattens to `arn::iam::aws:policy/ReadOnlyAccess`. Matching a policy
 * *name*, or an ARN's fixed tail, only needs the literal fragments, which is
 * what makes this work without resolving a template.
 */
export const flattenToText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flattenToText).join('');
  if (!isRecord(value)) return '';

  const keys = Object.keys(value);
  if (keys.length === 1 && OPAQUE_INTRINSICS.includes(keys[0])) return '';
  return Object.values(value).map(flattenToText).join('');
};

/**
 * Construct paths the CDK framework owns.
 *
 * These are the roles CDK creates for its own custom-resource handlers and for
 * the EKS cluster it provisions. Their policies are written by the framework,
 * are regenerated on every upgrade, and cannot be narrowed from this
 * repository's source, so reporting them is asking for work that cannot be
 * done. Everything else in `cdk.out` came from `lib/`.
 */
const FRAMEWORK_OWNED: readonly RegExp[] = [
  // `Custom::AWSCDKOpenIdConnectProviderCustomResourceProvider` and friends.
  /\/Custom::[A-Za-z0-9]+CustomResourceProvider(\/|$)/,
  // `LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a` — the hash is the handler's.
  /\/LogRetention[0-9a-f]{32}(\/|$)/,
  // The role CDK assumes to create an EKS cluster and then to call its API.
  /\/Cluster\/Resource\/(CreationRole|KubectlProvider)(\/|$)/,
  // Singleton Lambda handlers, named for the hash of the framework asset.
  /\/AWS[0-9a-f]{32}(\/|$)/,
];

export const isFrameworkOwned = (constructPath: string): boolean =>
  FRAMEWORK_OWNED.some((pattern) => pattern.test(constructPath));

/** One policy document, with enough context to name where it came from. */
export interface PolicyRecord {
  readonly template: string;
  readonly constructPath: string;
  /** `identity` and `resource` policies grant; `trust` says who may assume. */
  readonly kind: 'identity' | 'trust' | 'resource';
  readonly document: Record<string, unknown>;
}

/** Resource types whose policy document is the thing being audited. */
const RESOURCE_POLICY_PROPERTIES: Readonly<Record<string, string>> = {
  'AWS::S3::BucketPolicy': 'PolicyDocument',
  'AWS::SNS::TopicPolicy': 'PolicyDocument',
  'AWS::SQS::QueuePolicy': 'PolicyDocument',
  'AWS::KMS::Key': 'KeyPolicy',
  'AWS::ECR::Repository': 'RepositoryPolicyText',
  'AWS::Logs::ResourcePolicy': 'PolicyDocument',
  'AWS::SecretsManager::ResourcePolicy': 'ResourcePolicy',
  'AWS::Lambda::LayerVersionPermission': 'PolicyDocument',
};

/** An AWS managed policy attached to a role, as text plus where it hangs. */
export interface ManagedPolicyRecord {
  readonly template: string;
  readonly constructPath: string;
  readonly arnText: string;
}

export interface ExtractedPolicies {
  readonly policies: readonly PolicyRecord[];
  readonly managedPolicies: readonly ManagedPolicyRecord[];
  /** How many framework-owned resources were skipped, for the summary line. */
  readonly skippedFrameworkOwned: number;
}

export const extractPolicies = (templates: readonly TemplateFile[]): ExtractedPolicies => {
  const policies: PolicyRecord[] = [];
  const managedPolicies: ManagedPolicyRecord[] = [];
  let skippedFrameworkOwned = 0;

  for (const template of templates) {
    const document = template.document;
    if (!isRecord(document)) continue;
    const resources = document.Resources;
    if (!isRecord(resources)) continue;

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (!isRecord(resource)) continue;
      const type = typeof resource.Type === 'string' ? resource.Type : '';
      const metadata = isRecord(resource.Metadata) ? resource.Metadata : {};
      const constructPath =
        typeof metadata['aws:cdk:path'] === 'string' ? metadata['aws:cdk:path'] : logicalId;

      if (isFrameworkOwned(constructPath)) {
        skippedFrameworkOwned += 1;
        continue;
      }

      const properties = isRecord(resource.Properties) ? resource.Properties : {};
      const add = (kind: PolicyRecord['kind'], candidate: unknown): void => {
        if (!isRecord(candidate)) return;
        policies.push({ template: template.path, constructPath, kind, document: candidate });
      };

      if (type === 'AWS::IAM::Role') {
        add('trust', properties.AssumeRolePolicyDocument);
        for (const inline of asList(properties.Policies)) {
          if (isRecord(inline)) add('identity', inline.PolicyDocument);
        }
        for (const arn of asList(properties.ManagedPolicyArns)) {
          managedPolicies.push({
            template: template.path,
            constructPath,
            arnText: flattenToText(arn),
          });
        }
        continue;
      }

      if (type === 'AWS::IAM::Policy' || type === 'AWS::IAM::ManagedPolicy') {
        add('identity', properties.PolicyDocument);
        continue;
      }

      const resourcePolicyProperty = RESOURCE_POLICY_PROPERTIES[type];
      if (resourcePolicyProperty !== undefined) {
        add('resource', properties[resourcePolicyProperty]);
      }
    }
  }

  return { policies, managedPolicies, skippedFrameworkOwned };
};

/* ── Statements ───────────────────────────────────────────────────────────── */

export interface StatementRef {
  readonly policy: PolicyRecord;
  readonly statement: Record<string, unknown>;
  /** `statement <sid>` when there is one, otherwise the ordinal. */
  readonly location: string;
}

export const statementsOf = (policy: PolicyRecord): StatementRef[] =>
  asList(policy.document.Statement)
    .filter(isRecord)
    .map((statement, index) => ({
      policy,
      statement,
      location:
        typeof statement.Sid === 'string' && statement.Sid.length > 0
          ? `${policy.constructPath}  statement \`${statement.Sid}\``
          : `${policy.constructPath}  statement #${index + 1}`,
    }));

const isAllow = (statement: Record<string, unknown>): boolean => statement.Effect !== 'Deny';

/** `"*"` appearing literally in the Resource list. An intrinsic is not one. */
const hasWildcardResource = (statement: Record<string, unknown>): boolean =>
  asStrings(statement.Resource).includes('*');

const hasCondition = (statement: Record<string, unknown>): boolean =>
  isRecord(statement.Condition) && Object.keys(statement.Condition).length > 0;

/**
 * `arn:aws:iam::${AWS::AccountId}:root` — this account's own root, written as
 * an intrinsic, so the account segment is empty once flattened.
 *
 * A literal twelve-digit account id there is a *different* account and stays a
 * finding; `npm run scan:identifiers` would reject it first anyway.
 */
const SAME_ACCOUNT_ROOT = /^arn:aws[a-z0-9-]*:iam:::root$/;

/**
 * The statement every KMS key policy must carry.
 *
 * `{"Action": "kms:*", "Principal": {"AWS": "…:root"}, "Resource": "*"}` in a
 * key policy is not a grant of standing access — it is the documented way to
 * say "IAM policies in this account govern this key". AWS refuses to let you
 * remove it without acknowledging that the key can become unmanageable, and
 * CDK writes it into every key it creates. Reporting it is the noise this tool
 * exists to avoid: a dozen findings, in every stack that encrypts anything,
 * that nobody can act on and everybody learns to skim past.
 *
 * Narrow deliberately — resource-based policies only, and only for this
 * account's root. The same wildcard in an identity policy is an administrator
 * and is still reported.
 */
const isAccountRootDelegation = (
  policy: PolicyRecord,
  statement: Record<string, unknown>,
): boolean => {
  if (policy.kind !== 'resource') return false;
  const principal = statement.Principal;
  if (!isRecord(principal)) return false;
  const accounts = asList(principal.AWS).map(flattenToText);
  return accounts.length > 0 && accounts.every((account) => SAME_ACCOUNT_ROOT.test(account));
};

/**
 * Actions that read data, decide what code runs, or hand out access.
 *
 * Curated rather than exhaustive, and every entry is here because `Resource:
 * "*"` on it is a finding somebody can act on. The list is about blast radius,
 * not about whether AWS happens to accept an ARN: `ecs:UpdateService` on `"*"`
 * is every service in the account, whoever owns it.
 */
export const PRIVILEGED_ACTIONS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^iam:(?!Get|List|Simulate)/i, why: 'changes who can do what in the account' },
  { pattern: /^sts:AssumeRole/i, why: 'becomes another principal' },
  { pattern: /^organizations:(?!Describe|List)/i, why: 'changes the organisation' },
  { pattern: /^kms:(Decrypt|Encrypt|ReEncrypt|GenerateDataKey|PutKeyPolicy|ScheduleKeyDeletion)/i, why: 'reads or re-keys anything encrypted under any key' },
  { pattern: /^secretsmanager:(Get|Put|Update|Delete|Restore)/i, why: 'reads or overwrites every secret' },
  { pattern: /^ssm:(GetParameter|PutParameter|DeleteParameter)/i, why: 'reads or overwrites every parameter, SecureString included' },
  { pattern: /^s3:(Get|Put|Delete)Object/i, why: 'reads or overwrites every object in every bucket' },
  { pattern: /^dynamodb:(GetItem|BatchGetItem|Query|Scan|PutItem|UpdateItem|DeleteItem)/i, why: 'reads or overwrites every table' },
  { pattern: /^rds:(Create|Delete|Modify|Restore|Reboot)DB/i, why: 'changes or destroys any database' },
  { pattern: /^lambda:(UpdateFunctionCode|UpdateFunctionConfiguration|AddPermission|CreateFunction|InvokeFunction)/i, why: 'replaces or runs the code behind any function' },
  { pattern: /^ecs:(UpdateService|CreateService|RunTask|StartTask|StopTask)/i, why: 'changes what runs in any cluster' },
  { pattern: /^ecr:(PutImage|InitiateLayerUpload|UploadLayerPart|CompleteLayerUpload|BatchDeleteImage|DeleteRepository)/i, why: 'publishes or deletes images in any repository, including ones other pipelines deploy' },
  { pattern: /^(cloudformation):(Create|Update|Delete)Stack/i, why: 'deploys arbitrary infrastructure' },
  { pattern: /^codedeploy:(CreateDeployment|StopDeployment)/i, why: 'starts or halts any deployment in the account' },
  { pattern: /^(codebuild|codepipeline):(Start|Update|Create)/i, why: 'runs or rewrites a build that holds its own credentials' },
  { pattern: /^appconfig:(Start|Stop)Deployment/i, why: 'changes configuration every running process polls' },
  { pattern: /^states:(StartExecution|UpdateStateMachine)/i, why: 'runs or rewrites a state machine with its own role' },
  { pattern: /^ec2:(RunInstances|TerminateInstances|CreateTags|AuthorizeSecurityGroup)/i, why: 'launches compute or opens the network' },
];

const privilegedReason = (action: string): string | undefined =>
  PRIVILEGED_ACTIONS.find((entry) => entry.pattern.test(action))?.why;

/**
 * AWS managed policies that are administrator access under another name.
 *
 * `PowerUserAccess` is every action on every service except IAM, which is not
 * a meaningfully smaller grant than `AdministratorAccess` for anything holding
 * data. `IAMFullAccess` is the other half and can grant itself the first.
 */
const ADMIN_MANAGED_POLICIES: readonly string[] = [
  'AdministratorAccess',
  'PowerUserAccess',
  'IAMFullAccess',
];

/** Matches `:iam::aws:policy/<Name>` and `.../job-function/<Name>`. */
const awsManagedPolicyName = (arnText: string): string | undefined => {
  const match = /:iam::aws:policy\/(?:[A-Za-z0-9-]+\/)*([A-Za-z0-9+=,.@_-]+)$/.exec(arnText);
  return match?.[1];
};

/* ── Rules over policy documents ──────────────────────────────────────────── */

export const auditStatements = (policies: readonly PolicyRecord[]): Violation[] => {
  const violations: Violation[] = [];

  for (const policy of policies) {
    for (const { statement, location } of statementsOf(policy)) {
      if (!isAllow(statement)) continue;
      const file = policy.template;
      const actions = asStrings(statement.Action);
      const rootDelegation = isAccountRootDelegation(policy, statement);

      if (actions.includes('*') && !rootDelegation) {
        violations.push(
          violation(
            'action-wildcard',
            file,
            location,
            '`Action: "*"` in an Allow is administrator access, whatever the resource half ' +
              'says. Name the actions the principal actually calls; if that list is genuinely ' +
              'every action, the finding is the role, not the wording.',
          ),
        );
      }

      for (const action of rootDelegation ? [] : actions) {
        if (action === '*' || !/^[a-z0-9-]+:\*$/i.test(action)) continue;
        violations.push(
          violation(
            'service-action-wildcard',
            file,
            location,
            `\`${action}\` grants every action the service has, including the ones AWS adds ` +
              'after this line is written — the grant widens without a diff. Enumerate them.',
          ),
        );
      }

      if (statement.NotAction !== undefined) {
        violations.push(
          violation(
            'not-action-allow',
            file,
            location,
            '`NotAction` in an Allow grants everything that is not excluded, so every action ' +
              'AWS ships from now on is included by default and nobody reviews it. Invert it ' +
              'into an Allow that names what is needed, or move the exclusion into a Deny.',
          ),
        );
      }

      if (statement.NotResource !== undefined) {
        violations.push(
          violation(
            'not-resource-allow',
            file,
            location,
            '`NotResource` in an Allow covers every resource created from now on, including ' +
              "ones this account does not have yet. List the ARNs, or make it a Deny.",
          ),
        );
      }

      if (hasWildcardResource(statement)) {
        const passRole = actions.some((action) => /^iam:PassRole$/i.test(action));
        if (passRole) {
          violations.push(
            violation(
              'passrole-unscoped',
              file,
              location,
              '`iam:PassRole` on `"*"` hands this principal every role in the account that the ' +
                'destination service trusts. An `iam:PassedToService` condition does not fix ' +
                'it: it narrows which service the role is handed to, not which role is handed ' +
                'over — so paired with a `RegisterTaskDefinition` or `CreateFunction` grant it ' +
                'is a privilege escalation to the most privileged role that service can assume. ' +
                'List the role ARNs that may be passed.',
            ),
          );
        }

        if (!hasCondition(statement)) {
          const flagged = actions
            .filter((action) => !/^iam:PassRole$/i.test(action))
            .map((action) => ({ action, why: privilegedReason(action) }))
            .filter((entry): entry is { action: string; why: string } => entry.why !== undefined);

          if (flagged.length > 0) {
            const listed = flagged.map((entry) => `\`${entry.action}\``).join(', ');
            violations.push(
              violation(
                'privileged-action-unscoped',
                file,
                location,
                `${listed} on \`Resource: "*"\` with no condition — ${flagged[0].why}, account-wide. ` +
                  'Scope it to the ARNs this principal is meant to touch, or add a condition that ' +
                  'does. If the action genuinely takes no resource, split it into its own ' +
                  'statement so the wildcard is the documented exception rather than the default.',
              ),
            );
          }
        }
      }

      if (policy.kind !== 'identity' && !hasCondition(statement)) {
        const principal = statement.Principal;
        const wildcard =
          principal === '*' ||
          (isRecord(principal) && asStrings(principal.AWS).includes('*')) ||
          (isRecord(principal) && asStrings(principal.Federated).includes('*'));
        if (wildcard) {
          violations.push(
            violation(
              'principal-wildcard',
              file,
              location,
              'a wildcard `Principal` with no condition is every AWS account in the world. If ' +
                'this is meant to be reachable from outside, say which accounts, or narrow it ' +
                'with `aws:PrincipalOrgID` / `aws:SourceArn`.',
            ),
          );
        }
      }
    }
  }

  return violations;
};

export const auditManagedPolicies = (
  managedPolicies: readonly ManagedPolicyRecord[],
): Violation[] => {
  const violations: Violation[] = [];

  for (const record of managedPolicies) {
    const name = awsManagedPolicyName(record.arnText);
    if (name === undefined) continue;

    if (ADMIN_MANAGED_POLICIES.includes(name)) {
      violations.push(
        violation(
          'admin-managed-policy',
          record.template,
          record.constructPath,
          `\`${name}\` is administrator access under another name — \`PowerUserAccess\` is ` +
            'every action on every service but IAM, and `IAMFullAccess` can grant itself the ' +
            'rest. Attach a policy that names what this role does.',
        ),
      );
      continue;
    }

    if (name === 'ReadOnlyAccess') {
      violations.push(
        violation(
          'account-wide-read-policy',
          record.template,
          record.constructPath,
          '`ReadOnlyAccess` is a data-plane policy: it grants `s3:GetObject`, ' +
            '`dynamodb:GetItem`, `sqs:ReceiveMessage`, `ssm:GetParameter` and ' +
            '`lambda:GetFunction` — whose response carries the function\'s environment ' +
            'variables — across the whole account. "Read-only for dashboards and cost ' +
            'analysis" is `ViewOnlyAccess`, which is metadata only. If the data plane is ' +
            'genuinely needed, grant the specific actions on the specific resources.',
        ),
      );
    }
  }

  return violations;
};

/* ── The GitHub OIDC trust policy ─────────────────────────────────────────── */

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/**
 * `repo:<owner>/<repo>:<filter>`, with owner and repo carrying no wildcard.
 *
 * The filter half is allowed to be `*` — "any ref in this repository" is a
 * real choice. The owner and repo halves are not: `repo:*` , `repo:acme/*` and
 * a missing `sub` condition all mean a workflow in a repository nobody here
 * controls can assume the role, which is the single documented way this trust
 * pattern is exploited.
 */
const SCOPED_SUB = /^repo:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:/;

export const auditGitHubOidcTrust = (policies: readonly PolicyRecord[]): Violation[] => {
  const violations: Violation[] = [];

  for (const policy of policies) {
    if (policy.kind !== 'trust') continue;

    for (const { statement, location } of statementsOf(policy)) {
      if (!isAllow(statement)) continue;
      const principal = statement.Principal;
      if (!isRecord(principal)) continue;
      if (!flattenToText(principal.Federated).includes(GITHUB_OIDC_HOST)) continue;

      const condition = isRecord(statement.Condition) ? statement.Condition : {};
      const operators = Object.entries(condition).filter(
        (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
      );

      const valuesFor = (suffix: string): { operator: string; values: string[] }[] =>
        operators.flatMap(([operator, keys]) =>
          Object.entries(keys)
            .filter(([key]) => key.toLowerCase().endsWith(`${GITHUB_OIDC_HOST}:${suffix}`))
            .map(([, value]) => ({ operator, values: asStrings(value) })),
        );

      const audience = valuesFor('aud');
      if (audience.length === 0) {
        violations.push(
          violation(
            'github-oidc-trust-unscoped',
            policy.template,
            location,
            `no condition on \`${GITHUB_OIDC_HOST}:aud\`. Without it the role accepts any ` +
              'token this provider issued for any audience, which includes tokens a workflow ' +
              'requested for a third-party service. Require `StringEquals` ' +
              '`sts.amazonaws.com`.',
          ),
        );
      } else if (audience.some((entry) => entry.operator !== 'StringEquals')) {
        violations.push(
          violation(
            'github-oidc-trust-unscoped',
            policy.template,
            location,
            `the \`${GITHUB_OIDC_HOST}:aud\` condition uses ` +
              `\`${audience.map((entry) => entry.operator).join('`, `')}\`. The audience is one ` +
              'exact string, so anything but `StringEquals` is a pattern match over a value ' +
              'that should never be matched loosely.',
          ),
        );
      }

      const subject = valuesFor('sub');
      if (subject.length === 0) {
        violations.push(
          violation(
            'github-oidc-trust-unscoped',
            policy.template,
            location,
            `no condition on \`${GITHUB_OIDC_HOST}:sub\`. The trust is then every GitHub ` +
              'Actions workflow on github.com — anyone can create a repository and assume this ' +
              'role. Pin it to `repo:<owner>/<repo>:…`.',
          ),
        );
        continue;
      }

      for (const { values } of subject) {
        for (const value of values) {
          if (SCOPED_SUB.test(value)) continue;
          violations.push(
            violation(
              'github-oidc-trust-unscoped',
              policy.template,
              location,
              `\`${value}\` does not pin the owner and repository. A \`sub\` claim whose ` +
                'repository half carries a wildcard is assumable from a repository nobody here ' +
                'controls; the ref half after the second colon may be `*`, the first two may ' +
                'not.',
            ),
          );
        }
      }
    }
  }

  return violations;
};

/* ── Rules over the CI wiring ─────────────────────────────────────────────── */

interface Step {
  readonly workflow: string;
  readonly job: string;
  readonly name: string;
  /** The `run:` block with workflow, job and step `env:` substituted in. */
  readonly run: string;
  readonly continueOnError: boolean;
}

const envOf = (container: unknown): Record<string, string> => {
  if (!isRecord(container) || !isRecord(container.env)) return {};
  const entries = Object.entries(container.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries);
};

/**
 * Substitute `$VAR` and `${VAR}` from the layered `env:` blocks.
 *
 * A workflow passes a version or a threshold into a shell through `env:`, so
 * `pip install "cfn-policy-validator==${VALIDATOR_VERSION}"` is a pinned
 * install and reads, to anything matching on the literal text, as an unpinned
 * one. This repository has been bitten by the same shape twice — `--severity
 * "$SEVERITY"` in audit-vulnerability-scanning, `--namespace` in
 * audit-policy-gate — so the layering is done here rather than rediscovered.
 *
 * GitHub resolves step over job over workflow; so does this.
 */
export const resolveEnv = (text: string, env: Record<string, string>): string => {
  let resolved = text;
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    resolved = resolved.replace(new RegExp(`\\$\\{${key}\\}|\\$${key}\\b`, 'g'), value);
  }
  return resolved;
};

const stepsOf = (workflow: WorkflowFile): Step[] => {
  const document = workflow.document;
  if (!isRecord(document) || !isRecord(document.jobs)) return [];
  const workflowEnv = envOf(document);

  return Object.entries(document.jobs).flatMap(([jobId, job]) => {
    if (!isRecord(job)) return [];
    const jobEnv = { ...workflowEnv, ...envOf(job) };

    return asList(job.steps)
      .filter(isRecord)
      .map((step) => ({
        workflow: workflow.path,
        job: jobId,
        name: typeof step.name === 'string' ? step.name : jobId,
        run:
          typeof step.run === 'string'
            ? resolveEnv(step.run, { ...jobEnv, ...envOf(step) })
            : '',
        continueOnError: step['continue-on-error'] === true || job['continue-on-error'] === true,
      }));
  });
};

const VALIDATOR = 'cfn-policy-validator';

/** The script the workflow shells out to, as the workflow names it. */
export const ANALYZER_SCRIPT_PATH = '.github/scripts/run-iam-access-analyzer.sh';

/** `pip install cfn-policy-validator==0.0.37` — the version must be exact. */
const PINNED_INSTALL = new RegExp(`${VALIDATOR}==\\d+\\.\\d+\\.\\d+`);

const invokesValidator = (text: string): boolean =>
  text.includes(`${VALIDATOR} validate`) || text.includes(`${VALIDATOR} check-`);

/**
 * Shell text with whole-line comments and the shebang removed.
 *
 * Without this the rules fire on prose. The first draft reported the gate
 * script for swallowing the exit code, because its header comment says "there
 * is deliberately no `|| true` here" — a gate whose failure mode is triggered
 * by documenting that it avoids the failure mode. Trailing comments after code
 * are deliberately left in: `cmd # || true` is close enough to the real thing
 * to be worth a second look.
 */
export const stripShellComments = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*(#|$)/.test(line))
    .join('\n');

export const auditAnalyzerWiring = (
  workflows: readonly WorkflowFile[],
  analyzerScript?: SourceFile,
): Violation[] => {
  const violations: Violation[] = [];
  const steps = workflows.flatMap(stepsOf);
  const scriptName = path.posix.basename(ANALYZER_SCRIPT_PATH);

  // The validator is invoked either inline in a `run:` block or through the
  // gate script. Both count, and a step that calls the script only counts when
  // the script is actually there and actually runs the validator: a workflow
  // referencing a script that no longer exists fails at run time, but it fails
  // as a missing-file error nobody reads as "the IAM report stopped running".
  const scriptRunsValidator =
    analyzerScript !== undefined && invokesValidator(analyzerScript.text);

  const runsValidator = steps.filter(
    (step) =>
      invokesValidator(step.run) || (scriptRunsValidator && step.run.includes(scriptName)),
  );

  if (runsValidator.length === 0) {
    violations.push(
      violation(
        'analyzer-report-missing',
        '.github/workflows/',
        'no job',
        `nothing runs \`${VALIDATOR}\`. This tool is a curated subset and says so; the ` +
          'exhaustive answer — which actions accept an ARN, which condition keys narrow ' +
          'what — comes from IAM Access Analyzer, and nothing here asks it. See ' +
          'docs/iam-least-privilege.md.',
      ),
    );
    return violations;
  }

  // The flags are read wherever the command actually lives.
  const commandSites: { readonly where: Violation['location']; readonly file: string; readonly text: string }[] = [
    ...runsValidator.map((step) => ({
      where: `job \`${step.job}\`, step \`${step.name}\``,
      file: step.workflow,
      text: stripShellComments(step.run),
    })),
    ...(analyzerScript === undefined
      ? []
      : [
          {
            where: 'the validator invocation',
            file: analyzerScript.path,
            text: stripShellComments(analyzerScript.text),
          },
        ]),
  ];

  for (const step of runsValidator) {
    if (step.continueOnError) {
      violations.push(
        violation(
          'analyzer-findings-ignored',
          step.workflow,
          `job \`${step.job}\`, step \`${step.name}\``,
          '`continue-on-error: true` on the step that runs the validator. The report is still ' +
            'printed, the findings are still listed, and the job is green — which is the ' +
            'state this looks like in review and the state it is not.',
        ),
      );
    }

  }

  for (const site of commandSites) {
    // `|| true` and `set +e` only matter where the validator actually runs. A
    // `set -e` script that pipes into `tee` needs `pipefail` for the exit code
    // to survive, which is why this reads the script rather than trusting that
    // a non-zero exit propagates.
    if (/\|\|\s*true\b/.test(site.text) || /\bset\s+\+e\b/.test(site.text)) {
      violations.push(
        violation(
          'analyzer-findings-ignored',
          site.file,
          site.where,
          "the validator's exit code is swallowed by the shell. `cfn-policy-validator` " +
            'reports blocking findings by exiting non-zero and by nothing else, so this is ' +
            'the whole difference between a gate and a printer.',
        ),
      );
    }

    // A validator piped into `tee` — the obvious way to keep the report both
    // on disk and in the log — reports the exit status of `tee`, which is 0
    // whether or not there were findings. `set -o pipefail` is what makes the
    // pipeline fail; without it this is the same green-over-nothing as
    // `|| true`, and considerably harder to see.
    if (new RegExp(`${VALIDATOR}[^\\n]*\\|[^|]`).test(site.text) && !/pipefail/.test(site.text)) {
      violations.push(
        violation(
          'analyzer-findings-ignored',
          site.file,
          site.where,
          'the validator is piped into another command without `set -o pipefail`, so the ' +
            "pipeline's status is the last command's and the validator's exit code is lost. " +
            'Findings still print, and the step still passes.',
        ),
      );
    }

    if (site.text.includes('--ignore-finding')) {
      violations.push(
        violation(
          'analyzer-findings-ignored',
          site.file,
          site.where,
          '`--ignore-finding` suppresses findings by code or by resource name and leaves them ' +
            'printed in the log, so the report reads identically before and after. If a ' +
            'finding is genuinely wrong, fix the policy or record the exception in ' +
            'docs/iam-least-privilege.md and take it out of the command line.',
        ),
      );
    }

    if (site.text.includes('--treat-findings-as-non-blocking')) {
      violations.push(
        violation(
          'analyzer-findings-ignored',
          site.file,
          site.where,
          '`--treat-findings-as-non-blocking` turns `check-access-not-granted` into a printer. ' +
            'It exists for reporting pipelines; this one gates.',
        ),
      );
    }

    const blockingFlag = /--treat-finding-type-as-blocking[= ]+(?:"|')?([A-Z_,]+)/.exec(site.text);
    if (blockingFlag !== null) {
      const types = blockingFlag[1].split(',').filter((entry) => entry.length > 0);
      if (!types.includes('ERROR') || !types.includes('SECURITY_WARNING')) {
        violations.push(
          violation(
            'analyzer-findings-ignored',
            site.file,
            site.where,
            `\`--treat-finding-type-as-blocking ${blockingFlag[1]}\` is narrower than the ` +
              'default, which is `ERROR,SECURITY_WARNING`. Passing the flag at all reads like ' +
              'tightening; dropping `SECURITY_WARNING` is where ' +
              '`PASS_ROLE_WITH_STAR_IN_RESOURCE` goes.',
          ),
        );
      }
    }
  }

  const installs = steps.filter(
    (step) => step.run.includes(VALIDATOR) && /\bpip(3|x)?\s+install\b/.test(step.run),
  );
  if (installs.length === 0) {
    violations.push(
      violation(
        'analyzer-unpinned',
        runsValidator[0].workflow,
        `job \`${runsValidator[0].job}\``,
        `the job runs \`${VALIDATOR}\` but no step installs it, so the verdict depends on ` +
          "whatever the runner image happens to ship. Install it, pinned.",
      ),
    );
  }
  for (const step of installs) {
    if (PINNED_INSTALL.test(step.run)) continue;
    violations.push(
      violation(
        'analyzer-unpinned',
        step.workflow,
        `job \`${step.job}\`, step \`${step.name}\``,
        `\`${VALIDATOR}\` is installed without an exact \`==\` version. This binary decides ` +
          'whether the build merges, and an unpinned install makes that decision depend on a ' +
          "publishing schedule nobody here watches — the same reason checkov and conftest are " +
          'pinned. See docs/dependency-pinning.md.',
      ),
    );
  }

  return violations;
};

export const auditSelfWiring = (workflows: readonly WorkflowFile[]): Violation[] => {
  const wired = workflows
    .flatMap(stepsOf)
    .some((step) => /npm run audit:iam\b/.test(step.run) || step.run.includes('audit-iam-least-privilege'));

  if (wired) return [];

  return [
    violation(
      'audit-not-run-in-ci',
      '.github/workflows/',
      'no job',
      'no job runs `npm run audit:iam`. It has to run after `cdk synth`, since it reads the ' +
        'templates synth wrote and reports nothing at all when `cdk.out` is empty.',
    ),
  ];
};

/* ── The audit ────────────────────────────────────────────────────────────── */

export interface AuditResult {
  readonly violations: readonly Violation[];
  readonly policiesRead: number;
  readonly statementsRead: number;
  readonly skippedFrameworkOwned: number;
}

export const auditIamLeastPrivilege = (input: AuditInput): AuditResult => {
  const extracted = extractPolicies(input.templates);

  const violations = [
    ...auditStatements(extracted.policies),
    ...auditManagedPolicies(extracted.managedPolicies),
    ...auditGitHubOidcTrust(extracted.policies),
    ...auditAnalyzerWiring(input.workflows, input.analyzerScript),
    ...auditSelfWiring(input.workflows),
  ];

  return {
    violations,
    policiesRead: extracted.policies.length,
    statementsRead: extracted.policies.reduce(
      (total, policy) => total + statementsOf(policy).length,
      0,
    ),
    skippedFrameworkOwned: extracted.skippedFrameworkOwned,
  };
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations
    .map((v) => `${v.file}  ${v.location}  [${v.rule}]\n    ${v.message}`)
    .join('\n\n');

/* ── Reading the repository ───────────────────────────────────────────────── */

export const readTemplates = (root: string, relative = path.join('aws', 'cdk', 'cdk.out')): TemplateFile[] => {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.template.json'))
    .sort()
    .flatMap((name) => {
      const text = fs.readFileSync(path.join(directory, name), 'utf8');
      try {
        return [{ path: name, document: JSON.parse(text) as unknown }];
      } catch {
        // A template synth did not finish writing is not this gate's finding —
        // `cdk synth` fails on its own, loudly, in the step before this one.
        return [];
      }
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

export const readIfPresent = (root: string, relative: string): SourceFile | undefined => {
  const absolute = path.join(root, ...relative.split('/'));
  if (!fs.existsSync(absolute)) return undefined;
  return { path: relative, text: fs.readFileSync(absolute, 'utf8') };
};

export const readAuditInput = (root: string, templateDirectory?: string): AuditInput => ({
  templates: readTemplates(root, templateDirectory),
  workflows: readWorkflows(root),
  analyzerScript: readIfPresent(root, ANALYZER_SCRIPT_PATH),
});

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const input = readAuditInput(root, process.argv[3]);

  // A gate that reports nothing because it read nothing passes identically to
  // one that read everything and found nothing. This is the only difference.
  if (input.templates.length === 0) {
    console.error(
      `\nNo synthesised templates under ${root}. Run \`npx cdk synth\` first — this gate ` +
        'reads what synth wrote, not the TypeScript that produced it.\n',
    );
    process.exit(1);
  }

  const result = auditIamLeastPrivilege(input);

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} IAM least-privilege violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error('\nSee docs/iam-least-privilege.md.\n');
    process.exit(1);
  }

  console.log(
    `${result.statementsRead} statement(s) across ${result.policiesRead} policy document(s) in ` +
      `${input.templates.length} template(s): no wildcard action, no unscoped PassRole, no ` +
      `account-wide grant, and every GitHub OIDC trust pinned to one repository. ` +
      `${result.skippedFrameworkOwned} CDK-framework-owned resource(s) skipped.`,
  );
}
