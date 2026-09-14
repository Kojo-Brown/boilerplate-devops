import * as path from 'path';
import { load } from 'js-yaml';
import {
  AuditInput,
  SourceFile,
  TemplateFile,
  Violation,
  ViolationRule,
  WorkflowFile,
  auditAnalyzerWiring,
  auditGitHubOidcTrust,
  auditIamLeastPrivilege,
  auditManagedPolicies,
  auditStatements,
  extractPolicies,
  flattenToText,
  formatViolations,
  isFrameworkOwned,
  readAuditInput,
  resolveEnv,
  statementsOf,
  stripShellComments,
} from '../tools/audit-iam-least-privilege';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const rules = (violations: readonly Violation[]): ViolationRule[] => violations.map((v) => v.rule);

const ruleSet = (violations: readonly Violation[]): ViolationRule[] =>
  [...new Set(rules(violations))].sort();

const workflow = (filePath: string, yaml: string): WorkflowFile => ({
  path: filePath,
  document: load(yaml),
});

const script = (text: string): SourceFile => ({
  path: '.github/scripts/run-iam-access-analyzer.sh',
  text,
});

/** A template carrying one role with one inline policy document. */
const roleTemplate = (
  statements: unknown[],
  options: {
    readonly constructPath?: string;
    readonly trust?: unknown;
    readonly managedPolicyArns?: unknown[];
  } = {},
): TemplateFile => ({
  path: 'ExampleStack.template.json',
  document: {
    Resources: {
      Role: {
        Type: 'AWS::IAM::Role',
        Metadata: { 'aws:cdk:path': options.constructPath ?? 'ExampleStack/Role/Resource' },
        Properties: {
          AssumeRolePolicyDocument: options.trust ?? {
            Statement: [
              {
                Effect: 'Allow',
                Action: 'sts:AssumeRole',
                Principal: { Service: 'lambda.amazonaws.com' },
              },
            ],
          },
          ManagedPolicyArns: options.managedPolicyArns ?? [],
          Policies: [
            {
              PolicyName: 'Inline',
              PolicyDocument: { Version: '2012-10-17', Statement: statements },
            },
          ],
        },
      },
    },
  },
});

const statementsIn = (template: TemplateFile) =>
  auditStatements(extractPolicies([template]).policies);

/** The AWS managed policy ARN shape CDK synthesises. */
const managedPolicyArn = (name: string): unknown => ({
  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::aws:policy/${name}`]],
});

/* ── A conforming setup, which individual tests break one piece at a time ──── */

const CONFORMING_WORKFLOW = workflow(
  '.github/workflows/iam-access-analyzer.yml',
  `name: IAM Access Analyzer
env:
  VALIDATOR_VERSION: "0.0.37"
jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - name: Install the IAM policy validator
        run: pip install "cfn-policy-validator==\${VALIDATOR_VERSION}"
      - name: Validate every synthesised template
        run: .github/scripts/run-iam-access-analyzer.sh aws/cdk/cdk.out iam-report
`,
);

const CONFORMING_CI = workflow(
  '.github/workflows/ci.yml',
  `name: CI
jobs:
  cdk:
    runs-on: ubuntu-latest
    steps:
      - name: Audit IAM least privilege
        run: npm run audit:iam
`,
);

const CONFORMING_SCRIPT = script(`#!/usr/bin/env bash
# There is deliberately no \`|| true\` here, and no \`--ignore-finding\`.
set -euo pipefail

cfn-policy-validator validate \\
  --template-path "$template" \\
  --region "$region" \\
  --treat-finding-type-as-blocking ERROR,SECURITY_WARNING \\
  | tee "$report"
`);

const conformingInput = (overrides: Partial<AuditInput> = {}): AuditInput => ({
  templates: [roleTemplate([{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::b/*'] }])],
  workflows: [CONFORMING_WORKFLOW, CONFORMING_CI],
  analyzerScript: CONFORMING_SCRIPT,
  ...overrides,
});

describe('audit-iam-least-privilege', () => {
  describe('the conforming setup', () => {
    it('reports nothing', () => {
      expect(auditIamLeastPrivilege(conformingInput()).violations).toEqual([]);
    });

    it('counts what it read, so a gate that read nothing is distinguishable', () => {
      const result = auditIamLeastPrivilege(conformingInput());
      expect(result.policiesRead).toBe(2); // the trust policy and the inline one
      expect(result.statementsRead).toBe(2);
    });
  });

  /* ── flattenToText ──────────────────────────────────────────────────────── */

  describe('flattenToText', () => {
    it('keeps the literal fragments of an Fn::Join', () => {
      expect(flattenToText(managedPolicyArn('ReadOnlyAccess'))).toBe(
        'arn::iam::aws:policy/ReadOnlyAccess',
      );
    });

    // The first draft expanded {"Ref": "AWS::AccountId"} to the string
    // "AWS::AccountId", so arn:aws:iam::${AWS::AccountId}:root read back as
    // arn:aws:iam::AWS::AccountId:root and matched nothing — which silently
    // disabled the KMS carve-out and produced twelve findings on key policies.
    it('treats a Ref as an opaque placeholder, not as its argument name', () => {
      expect(flattenToText({ Ref: 'AWS::AccountId' })).toBe('');
      expect(
        flattenToText({
          'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':root']],
        }),
      ).toBe('arn:aws:iam:::root');
    });

    it('treats Fn::GetAtt and Fn::ImportValue the same way', () => {
      expect(flattenToText({ 'Fn::GetAtt': ['Bucket', 'Arn'] })).toBe('');
      expect(flattenToText({ 'Fn::ImportValue': 'OtherStack-Arn' })).toBe('');
    });

    it('still recurses into an intrinsic that carries literal text', () => {
      expect(flattenToText({ 'Fn::Sub': 'arn:aws:s3:::${Bucket}/*' })).toBe(
        'arn:aws:s3:::${Bucket}/*',
      );
    });
  });

  /* ── Extraction ─────────────────────────────────────────────────────────── */

  describe('extractPolicies', () => {
    it('reads a role trust policy, its inline policies, and its managed ARNs', () => {
      const extracted = extractPolicies([
        roleTemplate([{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }], {
          managedPolicyArns: [managedPolicyArn('ReadOnlyAccess')],
        }),
      ]);

      expect(extracted.policies.map((p) => p.kind).sort()).toEqual(['identity', 'trust']);
      expect(extracted.managedPolicies).toHaveLength(1);
    });

    it('reads a standalone AWS::IAM::Policy', () => {
      const extracted = extractPolicies([
        {
          path: 'S.template.json',
          document: {
            Resources: {
              P: {
                Type: 'AWS::IAM::Policy',
                Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Action: '*' }] } },
              },
            },
          },
        },
      ]);
      expect(extracted.policies).toHaveLength(1);
      expect(extracted.policies[0].kind).toBe('identity');
    });

    it('reads a resource-based policy as one', () => {
      const extracted = extractPolicies([
        {
          path: 'S.template.json',
          document: {
            Resources: {
              B: {
                Type: 'AWS::S3::BucketPolicy',
                Properties: { PolicyDocument: { Statement: [] } },
              },
            },
          },
        },
      ]);
      expect(extracted.policies[0].kind).toBe('resource');
    });

    it('falls back to the logical id when there is no construct path', () => {
      const extracted = extractPolicies([
        {
          path: 'S.template.json',
          document: {
            Resources: {
              MyPolicy: {
                Type: 'AWS::IAM::Policy',
                Properties: { PolicyDocument: { Statement: [] } },
              },
            },
          },
        },
      ]);
      expect(extracted.policies[0].constructPath).toBe('MyPolicy');
    });

    it('ignores a template that is not an object, and a resource that is not one', () => {
      expect(extractPolicies([{ path: 'a.template.json', document: null }]).policies).toEqual([]);
      expect(
        extractPolicies([{ path: 'a.template.json', document: { Resources: 'nonsense' } }]).policies,
      ).toEqual([]);
    });
  });

  describe('isFrameworkOwned', () => {
    it.each([
      'GitHubOidcStack/Custom::AWSCDKOpenIdConnectProviderCustomResourceProvider/Role',
      'RdsStack/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/ServiceRole/DefaultPolicy/Resource',
      'EksStack/Cluster/Resource/CreationRole/DefaultPolicy/Resource',
    ])('skips %s', (constructPath) => {
      expect(isFrameworkOwned(constructPath)).toBe(true);
    });

    it.each([
      'GitHubOidcStack/RoleDeploy/DefaultPolicy/Resource',
      'EcsStack/TaskRole/DefaultPolicy/Resource',
      // Named by a human after the framework's convention, but ours.
      'MyStack/CustomResourceRole/DefaultPolicy/Resource',
    ])('does not skip %s', (constructPath) => {
      expect(isFrameworkOwned(constructPath)).toBe(false);
    });

    it('counts what it skipped rather than dropping it silently', () => {
      const extracted = extractPolicies([
        roleTemplate([], { constructPath: 'S/Custom::XCustomResourceProvider/Role' }),
      ]);
      expect(extracted.policies).toEqual([]);
      expect(extracted.skippedFrameworkOwned).toBe(1);
    });
  });

  describe('statementsOf', () => {
    it('names a statement by its sid, and by its ordinal when there is none', () => {
      const [policy] = extractPolicies([
        roleTemplate([
          { Effect: 'Allow', Action: 'a:b', Resource: '*', Sid: 'Named' },
          { Effect: 'Allow', Action: 'a:b', Resource: '*' },
        ]),
      ]).policies.filter((p) => p.kind === 'identity');

      const located = statementsOf(policy).map((s) => s.location);
      expect(located[0]).toContain('statement `Named`');
      expect(located[1]).toContain('statement #2');
    });

    it('accepts a single statement where CloudFormation accepts a list', () => {
      const extracted = extractPolicies([
        {
          path: 'S.template.json',
          document: {
            Resources: {
              P: {
                Type: 'AWS::IAM::Policy',
                Properties: {
                  PolicyDocument: { Statement: { Effect: 'Allow', Action: '*', Resource: '*' } },
                },
              },
            },
          },
        },
      ]);
      expect(statementsOf(extracted.policies[0])).toHaveLength(1);
    });
  });

  /* ── Statement rules ────────────────────────────────────────────────────── */

  describe('action-wildcard', () => {
    it('reports Action: "*" in an Allow', () => {
      const found = statementsIn(roleTemplate([{ Effect: 'Allow', Action: '*', Resource: '*' }]));
      expect(rules(found)).toContain('action-wildcard');
    });

    it('says nothing about a Deny, which is where a wildcard belongs', () => {
      const found = statementsIn(roleTemplate([{ Effect: 'Deny', Action: '*', Resource: '*' }]));
      expect(found).toEqual([]);
    });
  });

  describe('service-action-wildcard', () => {
    it('reports s3:*', () => {
      const found = statementsIn(
        roleTemplate([{ Effect: 'Allow', Action: ['s3:*'], Resource: 'arn:aws:s3:::b' }]),
      );
      expect(rules(found)).toEqual(['service-action-wildcard']);
    });

    // `s3:Get*` is a prefix over today's actions; `s3:*` is every action the
    // service will ever have. Only the second one widens without a diff.
    it('accepts a prefix that is not the whole service', () => {
      const found = statementsIn(
        roleTemplate([{ Effect: 'Allow', Action: ['s3:Get*'], Resource: 'arn:aws:s3:::b' }]),
      );
      expect(found).toEqual([]);
    });
  });

  describe('not-action-allow and not-resource-allow', () => {
    it('reports an Allow written by exclusion', () => {
      const found = statementsIn(
        roleTemplate([{ Effect: 'Allow', NotAction: 'iam:*', NotResource: 'arn:aws:s3:::secret' }]),
      );
      expect(ruleSet(found)).toEqual(['not-action-allow', 'not-resource-allow']);
    });

    it('accepts the same exclusions in a Deny', () => {
      const found = statementsIn(
        roleTemplate([{ Effect: 'Deny', NotAction: 'iam:*', NotResource: 'arn:aws:s3:::s' }]),
      );
      expect(found).toEqual([]);
    });
  });

  describe('passrole-unscoped', () => {
    const passRole = (extra: Record<string, unknown> = {}) =>
      statementsIn(
        roleTemplate([
          { Effect: 'Allow', Sid: 'PassRoleToECS', Action: 'iam:PassRole', Resource: '*', ...extra },
        ]),
      );

    it('reports iam:PassRole on "*"', () => {
      expect(rules(passRole())).toContain('passrole-unscoped');
    });

    // The finding this whole item started from. iam:PassedToService narrows
    // which service receives the role, not which role is handed over, so a
    // statement carrying it is still unscoped — and reads in review like the
    // scoped version.
    it('still reports it with an iam:PassedToService condition', () => {
      const found = passRole({
        Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      });
      expect(rules(found)).toContain('passrole-unscoped');
    });

    it('accepts a list of role ARNs', () => {
      const found = statementsIn(
        roleTemplate([
          {
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: ['arn:aws:iam::*:role/staging-ecs-task-role'],
          },
        ]),
      );
      expect(found).toEqual([]);
    });

    it('does not also report it as a privileged action, which would double-count', () => {
      expect(rules(passRole())).toEqual(['passrole-unscoped']);
    });
  });

  describe('privileged-action-unscoped', () => {
    it('reports ecs:UpdateService on "*"', () => {
      const found = statementsIn(
        roleTemplate([{ Effect: 'Allow', Sid: 'ECSUpdate', Action: ['ecs:UpdateService'], Resource: '*' }]),
      );
      expect(rules(found)).toEqual(['privileged-action-unscoped']);
      expect(found[0].message).toContain('changes what runs in any cluster');
    });

    it.each([
      'secretsmanager:GetSecretValue',
      'ssm:GetParameter',
      's3:GetObject',
      'ecr:PutImage',
      'lambda:UpdateFunctionCode',
      'kms:Decrypt',
      'codedeploy:StopDeployment',
    ])('reports %s on "*"', (action) => {
      const found = statementsIn(roleTemplate([{ Effect: 'Allow', Action: [action], Resource: '*' }]));
      expect(rules(found)).toEqual(['privileged-action-unscoped']);
    });

    // The whole design rests on this: most of this repository's 45
    // `Resource: "*"` statements are actions that accept no resource at all,
    // and a gate that reported them would be baselined within a week.
    it.each([
      'cloudwatch:GetMetricData',
      'ec2:DescribeSubnets',
      'ecr:GetAuthorizationToken',
      'ecs:RegisterTaskDefinition',
      'elasticloadbalancing:DescribeTargetHealth',
      'logs:DescribeLogGroups',
    ])('says nothing about %s on "*"', (action) => {
      const found = statementsIn(roleTemplate([{ Effect: 'Allow', Action: [action], Resource: '*' }]));
      expect(found).toEqual([]);
    });

    it('accepts a scoped resource', () => {
      const found = statementsIn(
        roleTemplate([
          {
            Effect: 'Allow',
            Action: ['ecs:UpdateService'],
            Resource: ['arn:aws:ecs:*:*:service/c/s'],
          },
        ]),
      );
      expect(found).toEqual([]);
    });

    it('accepts a conditioned wildcard, which is at least deliberate', () => {
      const found = statementsIn(
        roleTemplate([
          {
            Effect: 'Allow',
            Action: ['ecs:StopTask'],
            Resource: '*',
            Condition: { ArnEquals: { 'ecs:cluster': 'arn:aws:ecs:*:*:cluster/c' } },
          },
        ]),
      );
      expect(found).toEqual([]);
    });

    it('treats an empty Condition object as no condition', () => {
      const found = statementsIn(
        roleTemplate([
          { Effect: 'Allow', Action: ['ecs:UpdateService'], Resource: '*', Condition: {} },
        ]),
      );
      expect(rules(found)).toEqual(['privileged-action-unscoped']);
    });

    it('does not treat an intrinsic resource as a wildcard', () => {
      const found = statementsIn(
        roleTemplate([
          {
            Effect: 'Allow',
            Action: ['ecs:UpdateService'],
            Resource: { 'Fn::GetAtt': ['Service', 'Arn'] },
          },
        ]),
      );
      expect(found).toEqual([]);
    });
  });

  describe('principal-wildcard', () => {
    const bucketPolicy = (statement: unknown): TemplateFile => ({
      path: 'S.template.json',
      document: {
        Resources: {
          B: {
            Type: 'AWS::S3::BucketPolicy',
            Properties: { PolicyDocument: { Statement: [statement] } },
          },
        },
      },
    });

    it('reports a wildcard principal with nothing narrowing it', () => {
      const found = statementsIn(
        bucketPolicy({ Effect: 'Allow', Principal: { AWS: '*' }, Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }),
      );
      expect(rules(found)).toContain('principal-wildcard');
    });

    it('accepts one narrowed by a condition', () => {
      const found = statementsIn(
        bucketPolicy({
          Effect: 'Allow',
          Principal: { AWS: '*' },
          Action: 's3:GetObject',
          Resource: 'arn:aws:s3:::b/*',
          Condition: { StringEquals: { 'aws:PrincipalOrgID': 'o-abc123' } },
        }),
      );
      expect(found).toEqual([]);
    });

    it('says nothing about a service principal', () => {
      const found = statementsIn(
        bucketPolicy({
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: 's3:GetObject',
          Resource: 'arn:aws:s3:::b/*',
        }),
      );
      expect(found).toEqual([]);
    });
  });

  /* ── The KMS carve-out ──────────────────────────────────────────────────── */

  describe('the account-root delegation carve-out', () => {
    const keyPolicy = (principal: unknown, action: unknown = 'kms:*'): TemplateFile => ({
      path: 'S.template.json',
      document: {
        Resources: {
          K: {
            Type: 'AWS::KMS::Key',
            Properties: {
              KeyPolicy: {
                Statement: [{ Effect: 'Allow', Action: action, Principal: { AWS: principal }, Resource: '*' }],
              },
            },
          },
        },
      },
    });

    const ownRoot = { 'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':root']] };

    // Every KMS key policy carries this, AWS warns against removing it, and CDK
    // writes it into every key. Six stacks here create keys, so without the
    // carve-out the first run was 22 findings of which 12 were this.
    it('accepts kms:* to this account\'s own root in a key policy', () => {
      expect(statementsIn(keyPolicy(ownRoot))).toEqual([]);
    });

    it('accepts Action: "*" there too', () => {
      expect(statementsIn(keyPolicy(ownRoot, '*'))).toEqual([]);
    });

    // Narrow on purpose: the same wildcard in an identity policy is an
    // administrator, and root in *another* account is a cross-account grant.
    it('still reports the same wildcard in an identity policy', () => {
      const found = statementsIn(roleTemplate([{ Effect: 'Allow', Action: 'kms:*', Resource: '*' }]));
      expect(rules(found)).toContain('service-action-wildcard');
    });

    it('still reports another account\'s root', () => {
      const found = statementsIn(keyPolicy('arn:aws:iam::444455556666:root'));
      expect(rules(found)).toContain('service-action-wildcard');
    });

    it('still reports a key policy statement granting kms:* to a role', () => {
      const found = statementsIn(keyPolicy('arn:aws:iam::111122223333:role/some-role'));
      expect(rules(found)).toContain('service-action-wildcard');
    });
  });

  /* ── Managed policies ───────────────────────────────────────────────────── */

  describe('managed policies', () => {
    const attached = (name: string): Violation[] =>
      auditManagedPolicies(
        extractPolicies([roleTemplate([], { managedPolicyArns: [managedPolicyArn(name)] })])
          .managedPolicies,
      );

    it.each(['AdministratorAccess', 'PowerUserAccess', 'IAMFullAccess'])(
      'reports %s as administrator access under another name',
      (name) => {
        expect(rules(attached(name))).toEqual(['admin-managed-policy']);
      },
    );

    it('reports ReadOnlyAccess, which is the data plane', () => {
      const found = attached('ReadOnlyAccess');
      expect(rules(found)).toEqual(['account-wide-read-policy']);
      expect(found[0].message).toContain('ViewOnlyAccess');
    });

    it('accepts ViewOnlyAccess, including under its job-function path', () => {
      expect(attached('job-function/ViewOnlyAccess')).toEqual([]);
      expect(attached('ViewOnlyAccess')).toEqual([]);
    });

    it('accepts a service-role policy', () => {
      expect(attached('service-role/AWSLambdaBasicExecutionRole')).toEqual([]);
    });

    it('says nothing about a customer-managed policy ARN', () => {
      const found = auditManagedPolicies([
        {
          template: 'S.template.json',
          constructPath: 'S/Role',
          arnText: 'arn:aws:iam::111122223333:policy/ReadOnlyAccess',
        },
      ]);
      expect(found).toEqual([]);
    });
  });

  /* ── GitHub OIDC trust ──────────────────────────────────────────────────── */

  describe('github-oidc-trust-unscoped', () => {
    const HOST = 'token.actions.githubusercontent.com';

    const trust = (condition: unknown): TemplateFile =>
      roleTemplate([], {
        trust: {
          Statement: [
            {
              Effect: 'Allow',
              Action: 'sts:AssumeRoleWithWebIdentity',
              Principal: { Federated: `arn:aws:iam::111122223333:oidc-provider/${HOST}` },
              Condition: condition,
            },
          ],
        },
      });

    const scoped = {
      StringEquals: { [`${HOST}:aud`]: 'sts.amazonaws.com' },
      StringLike: { [`${HOST}:sub`]: 'repo:my-org/my-service:ref:refs/heads/*' },
    };

    const found = (condition: unknown): Violation[] =>
      auditGitHubOidcTrust(extractPolicies([trust(condition)]).policies);

    it('accepts a trust pinned to one repository', () => {
      expect(found(scoped)).toEqual([]);
    });

    it('accepts a wildcard in the ref half, which is a real choice', () => {
      expect(found({ ...scoped, StringLike: { [`${HOST}:sub`]: 'repo:my-org/my-service:*' } })).toEqual(
        [],
      );
    });

    it('accepts several subjects when every one is pinned', () => {
      const subs = ['repo:my-org/a:ref:refs/heads/main', 'repo:my-org/b:environment:production'];
      expect(found({ ...scoped, StringLike: { [`${HOST}:sub`]: subs } })).toEqual([]);
    });

    // Without a sub condition the trust is every GitHub Actions workflow on
    // github.com: anyone can create a repository and assume the role.
    it('reports a missing sub condition', () => {
      const violations = found({ StringEquals: { [`${HOST}:aud`]: 'sts.amazonaws.com' } });
      expect(rules(violations)).toEqual(['github-oidc-trust-unscoped']);
      expect(violations[0].message).toContain('every GitHub Actions workflow');
    });

    it.each(['repo:*', 'repo:my-org/*:ref:refs/heads/main', '*'])(
      'reports a sub of %s, which does not pin the repository',
      (sub) => {
        const violations = found({ ...scoped, StringLike: { [`${HOST}:sub`]: sub } });
        expect(rules(violations)).toEqual(['github-oidc-trust-unscoped']);
      },
    );

    it('reports a missing aud condition', () => {
      const violations = found({ StringLike: { [`${HOST}:sub`]: 'repo:my-org/my-service:*' } });
      expect(rules(violations)).toEqual(['github-oidc-trust-unscoped']);
      expect(violations[0].message).toContain(':aud');
    });

    // The audience is one exact string. Matching it loosely is how a token
    // minted for a third-party service becomes usable here.
    it('reports an aud matched with StringLike rather than StringEquals', () => {
      const violations = found({
        StringLike: { [`${HOST}:aud`]: 'sts.*', [`${HOST}:sub`]: 'repo:my-org/my-service:*' },
      });
      expect(rules(violations)).toEqual(['github-oidc-trust-unscoped']);
    });

    it('says nothing about a trust policy for another federated provider', () => {
      const other = roleTemplate([], {
        trust: {
          Statement: [
            {
              Effect: 'Allow',
              Action: 'sts:AssumeRoleWithWebIdentity',
              Principal: { Federated: 'arn:aws:iam::111122223333:oidc-provider/gitlab.com' },
            },
          ],
        },
      });
      expect(auditGitHubOidcTrust(extractPolicies([other]).policies)).toEqual([]);
    });
  });

  /* ── Shell and env handling ─────────────────────────────────────────────── */

  describe('resolveEnv', () => {
    it('substitutes both $VAR and ${VAR}', () => {
      expect(resolveEnv('a==${V} and $V', { V: '1.2.3' })).toBe('a==1.2.3 and 1.2.3');
    });

    it('does not substitute a longer name that merely starts the same', () => {
      expect(resolveEnv('$VERSION_EXTRA', { VERSION: '1' })).toBe('$VERSION_EXTRA');
    });

    it('ignores a key that is not a shell identifier', () => {
      expect(resolveEnv('$A-B', { 'A-B': 'x' })).toBe('$A-B');
    });
  });

  describe('stripShellComments', () => {
    // The first draft reported the gate script for swallowing the exit code,
    // because its header says "there is deliberately no `|| true` here".
    it('drops whole-line comments so prose is not matched as code', () => {
      expect(stripShellComments('# no || true here\nrun me\n')).toBe('run me');
    });

    it('keeps a trailing comment, which is close enough to code to be worth a look', () => {
      expect(stripShellComments('run me # || true')).toBe('run me # || true');
    });
  });

  /* ── CI wiring ──────────────────────────────────────────────────────────── */

  describe('analyzer-report-missing', () => {
    it('reports a repository where nothing runs the validator', () => {
      const found = auditAnalyzerWiring([CONFORMING_CI], undefined);
      expect(rules(found)).toEqual(['analyzer-report-missing']);
    });

    it('accepts the validator run inline in a step', () => {
      const inline = workflow(
        '.github/workflows/a.yml',
        `jobs:
  j:
    steps:
      - run: pip install cfn-policy-validator==0.0.37
      - run: cfn-policy-validator validate --template-path t.json
`,
      );
      expect(auditAnalyzerWiring([inline], undefined)).toEqual([]);
    });

    // A workflow calling a script that is gone fails at run time as a
    // missing-file error, which nobody reads as "the IAM report stopped
    // running".
    it('reports a step calling the gate script when the script is absent', () => {
      const found = auditAnalyzerWiring([CONFORMING_WORKFLOW], undefined);
      expect(rules(found)).toContain('analyzer-report-missing');
    });

    it('reports a step calling a script that no longer runs the validator', () => {
      const found = auditAnalyzerWiring([CONFORMING_WORKFLOW], script('set -euo pipefail\necho hi\n'));
      expect(rules(found)).toContain('analyzer-report-missing');
    });
  });

  describe('analyzer-findings-ignored', () => {
    const withScript = (text: string): Violation[] =>
      auditAnalyzerWiring([CONFORMING_WORKFLOW], script(text));

    it('reports || true around the validator', () => {
      const found = withScript('set -euo pipefail\ncfn-policy-validator validate -t a || true\n');
      expect(rules(found)).toContain('analyzer-findings-ignored');
    });

    it('reports set +e', () => {
      const found = withScript('set +e\ncfn-policy-validator validate -t a\n');
      expect(rules(found)).toContain('analyzer-findings-ignored');
    });

    // tee reports its own exit status, so the validator's is lost — the same
    // green-over-nothing as `|| true`, and much harder to see.
    it('reports a pipe into tee without pipefail', () => {
      const found = withScript('set -eu\ncfn-policy-validator validate -t a | tee out.json\n');
      expect(rules(found)).toContain('analyzer-findings-ignored');
      expect(found[0].message).toContain('pipefail');
    });

    it('accepts the same pipe with pipefail set', () => {
      expect(withScript('set -euo pipefail\ncfn-policy-validator validate -t a | tee o.json\n')).toEqual(
        [],
      );
    });

    it.each(['--ignore-finding PASS_ROLE_WITH_STAR_IN_RESOURCE', '--treat-findings-as-non-blocking'])(
      'reports %s',
      (flag) => {
        const found = withScript(`set -euo pipefail\ncfn-policy-validator validate -t a ${flag}\n`);
        expect(rules(found)).toContain('analyzer-findings-ignored');
      },
    );

    it('reports continue-on-error on the step that runs it', () => {
      const lenient = workflow(
        '.github/workflows/a.yml',
        `jobs:
  j:
    steps:
      - run: pip install cfn-policy-validator==0.0.37
      - run: cfn-policy-validator validate --template-path t.json
        continue-on-error: true
`,
      );
      expect(rules(auditAnalyzerWiring([lenient], undefined))).toContain('analyzer-findings-ignored');
    });

    it('accepts the explicit default threshold', () => {
      const found = withScript(
        'set -euo pipefail\ncfn-policy-validator validate -t a ' +
          '--treat-finding-type-as-blocking ERROR,SECURITY_WARNING\n',
      );
      expect(found).toEqual([]);
    });

    // Passing the flag reads like tightening. Dropping SECURITY_WARNING is
    // exactly where PASS_ROLE_WITH_STAR_IN_RESOURCE stops failing the build.
    it('reports a threshold narrowed to ERROR alone', () => {
      const found = withScript(
        'set -euo pipefail\ncfn-policy-validator validate -t a --treat-finding-type-as-blocking ERROR\n',
      );
      expect(rules(found)).toContain('analyzer-findings-ignored');
      expect(found[0].message).toContain('SECURITY_WARNING');
    });
  });

  describe('analyzer-unpinned', () => {
    const withInstall = (install: string): Violation[] =>
      auditAnalyzerWiring(
        [
          workflow(
            '.github/workflows/a.yml',
            `jobs:
  j:
    steps:
      - run: ${install}
      - run: cfn-policy-validator validate --template-path t.json
`,
          ),
        ],
        undefined,
      );

    it('accepts an exact version', () => {
      expect(withInstall('pip install cfn-policy-validator==0.0.37')).toEqual([]);
    });

    it.each([
      'pip install cfn-policy-validator',
      'pip install "cfn-policy-validator>=0.0.37"',
      'pip install cfn-policy-validator~=0.0',
    ])('reports %s', (install) => {
      expect(rules(withInstall(install))).toContain('analyzer-unpinned');
    });

    // The near miss that has bitten this repository twice before, in
    // audit-vulnerability-scanning and audit-policy-gate: a version passed
    // through `env:` reads, to anything matching literal text, as no version.
    it('resolves a version supplied through env: before deciding', () => {
      expect(auditAnalyzerWiring([CONFORMING_WORKFLOW], CONFORMING_SCRIPT)).toEqual([]);
    });

    it('reports a job that runs the validator without installing it', () => {
      const found = auditAnalyzerWiring(
        [
          workflow(
            '.github/workflows/a.yml',
            `jobs:
  j:
    steps:
      - run: cfn-policy-validator validate --template-path t.json
`,
          ),
        ],
        undefined,
      );
      expect(rules(found)).toContain('analyzer-unpinned');
    });
  });

  describe('audit-not-run-in-ci', () => {
    it('reports a repository where no job runs the gate', () => {
      const found = auditIamLeastPrivilege(
        conformingInput({ workflows: [CONFORMING_WORKFLOW] }),
      ).violations;
      expect(rules(found)).toEqual(['audit-not-run-in-ci']);
    });
  });

  describe('formatViolations', () => {
    it('names the rule, the file and the location on every line', () => {
      const found = statementsIn(roleTemplate([{ Effect: 'Allow', Action: '*', Resource: '*' }]));
      const text = formatViolations(found);
      expect(text).toContain('[action-wildcard]');
      expect(text).toContain('ExampleStack.template.json');
    });
  });

  /* ── The repository as it actually is ───────────────────────────────────── */

  describe('this repository', () => {
    const input = readAuditInput(REPO_ROOT);

    // Guards the failure every gate here is written against: reading nothing
    // and reporting nothing are the same output.
    it('reads the synthesised templates and the workflows', () => {
      expect(input.templates.length).toBeGreaterThan(0);
      expect(input.workflows.length).toBeGreaterThan(0);
      expect(input.analyzerScript).toBeDefined();
    });

    it('has no IAM least-privilege violations', () => {
      const result = auditIamLeastPrivilege(input);
      expect(formatViolations(result.violations)).toBe('');
      expect(result.statementsRead).toBeGreaterThan(0);
    });

    // The rules found ten real findings on the tree before this change. If the
    // deploy role ever goes back to a wildcard, this is what notices.
    it('still reports the deploy role if PassRole goes back to "*"', () => {
      const regressed = input.templates.map((template) => ({
        path: template.path,
        document: JSON.parse(
          JSON.stringify(template.document).replace(
            /"arn:aws:iam::\*:role\/[a-z-]+-ecs-execution-role"/g,
            '"*"',
          ),
        ) as unknown,
      }));

      const found = auditStatements(extractPolicies(regressed).policies);
      expect(rules(found)).toContain('passrole-unscoped');
    });
  });
});
