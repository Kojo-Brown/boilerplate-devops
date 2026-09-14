import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GitHubOidcStack, GitHubOidcStackProps } from '../lib/github-oidc-stack';
import { flattenIntrinsic } from './support/cfn';

const makeStack = (props: GitHubOidcStackProps = {}) => {
  const app = new cdk.App();
  const stack = new GitHubOidcStack(app, 'TestGitHubOidcStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { template: Template.fromStack(stack), stack };
};

interface TrustStatement {
  readonly Effect: string;
  readonly Action: string;
  readonly Condition: Record<string, Record<string, string | string[]>>;
}

interface GitHubActionsRole {
  readonly RoleName: string;
  readonly MaxSessionDuration?: number;
  readonly ManagedPolicyArns?: unknown[];
  readonly AssumeRolePolicyDocument: { Statement: TrustStatement[] };
}

/**
 * Only the roles this stack creates for GitHub Actions.
 *
 * `iam.OpenIdConnectProvider` is backed by a custom resource, so the synthesized
 * template also contains a Lambda execution role for its provider. That role is
 * unnamed and trusts lambda.amazonaws.com, so filtering on the role-name prefix
 * keeps these assertions about the roles the stack actually exposes.
 */
const githubActionsRoles = (template: Template): GitHubActionsRole[] =>
  Object.values(template.findResources('AWS::IAM::Role'))
    .map((r) => r.Properties as unknown as GitHubActionsRole)
    .filter((p) => typeof p.RoleName === 'string' && p.RoleName.startsWith('github-actions-'));

describe('GitHubOidcStack', () => {
  describe('OIDC Provider', () => {
    it('creates an OIDC provider by default', () => {
      const { template } = makeStack();
      template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
    });

    it('uses the GitHub Actions token URL', () => {
      const { template } = makeStack();
      template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
        Url: 'https://token.actions.githubusercontent.com',
      });
    });

    it('sets the STS audience', () => {
      const { template } = makeStack();
      template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
        ClientIDList: ['sts.amazonaws.com'],
      });
    });

    it('includes the default GitHub thumbprint', () => {
      const { template } = makeStack();
      template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
        ThumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
      });
    });

    it('uses a custom thumbprint when provided', () => {
      const { template } = makeStack({ thumbprints: ['abcdef1234567890'] });
      template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
        ThumbprintList: ['abcdef1234567890'],
      });
    });

    it('skips provider creation when createOidcProvider is false', () => {
      const { template } = makeStack({
        createOidcProvider: false,
        existingOidcProviderArn:
          'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
      });
      template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    });

    it('exports the OIDC provider ARN', () => {
      const { template } = makeStack();
      const outputs = template.findOutputs('OidcProviderArn');
      expect(Object.keys(outputs).length).toBe(1);
    });
  });

  describe('Default roles', () => {
    it('creates three default GitHub Actions roles', () => {
      const { template } = makeStack();
      expect(githubActionsRoles(template)).toHaveLength(3);
    });

    it('creates roles with names scoped to the envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      const roleNames = githubActionsRoles(template).map((r) => r.RoleName);
      expect(roleNames.some((n) => n.includes('staging'))).toBe(true);
    });

    it('exports a CfnOutput for each role ARN', () => {
      const { template } = makeStack();
      const outputs = template.findOutputs('*');
      const roleOutputs = Object.keys(outputs).filter((k) => k.endsWith('RoleArn'));
      expect(roleOutputs.length).toBe(3);
    });

    it('uses OIDC federated principal for all roles', () => {
      const { template } = makeStack();
      for (const role of githubActionsRoles(template)) {
        const stmt = role.AssumeRolePolicyDocument.Statement[0];
        expect(stmt.Action).toBe('sts:AssumeRoleWithWebIdentity');
        expect(stmt.Effect).toBe('Allow');
      }
    });

    it('enforces audience claim on all roles', () => {
      const { template } = makeStack();
      for (const role of githubActionsRoles(template)) {
        const cond = role.AssumeRolePolicyDocument.Statement[0].Condition;
        expect(
          cond['StringEquals']['https://token.actions.githubusercontent.com:aud'],
        ).toBe('sts.amazonaws.com');
      }
    });

    it('sets sub condition with StringLike (not Equals) for wildcard support', () => {
      const { template } = makeStack();
      for (const role of githubActionsRoles(template)) {
        const cond = role.AssumeRolePolicyDocument.Statement[0].Condition;
        expect(cond).toHaveProperty('StringLike');
        const subKey = 'https://token.actions.githubusercontent.com:sub';
        const subValue = cond['StringLike'][subKey] as string | string[];
        const values = Array.isArray(subValue) ? subValue : [subValue];
        expect(values.length).toBeGreaterThan(0);
        expect(values[0]).toMatch(/^repo:/);
      }
    });

    it('default CI role max session duration is 1 hour', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: Match.stringLikeRegexp('-ci$'),
        MaxSessionDuration: 3600,
      });
    });

    it('default Deploy role max session duration is 2 hours', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: Match.stringLikeRegexp('-deploy$'),
        MaxSessionDuration: 7200,
      });
    });

    // `ViewOnlyAccess`, not `ReadOnlyAccess`. The two names differ by a word
    // and the policies differ by the entire data plane: `ReadOnlyAccess` grants
    // `s3:GetObject`, `dynamodb:GetItem`, `ssm:GetParameter` and
    // `lambda:GetFunction` — whose response carries the function's environment
    // variables — across the whole account, on a role any workflow on `main`
    // can assume. Both halves are asserted, because attaching the right policy
    // and also leaving the wrong one on would pass a check for either alone.
    // See docs/iam-least-privilege.md §2.
    it('ReadOnly role has ViewOnlyAccess and not ReadOnlyAccess', () => {
      const { template } = makeStack();
      const readOnly = githubActionsRoles(template).find((r) =>
        r.RoleName.endsWith('-readonly'),
      );
      expect(readOnly).toBeDefined();
      const managedPolicies = (readOnly!.ManagedPolicyArns ?? []).map(flattenIntrinsic);
      expect(managedPolicies).toContainEqual(
        expect.stringContaining(':iam::aws:policy/job-function/ViewOnlyAccess'),
      );
      expect(managedPolicies).not.toContainEqual(
        expect.stringContaining(':iam::aws:policy/ReadOnlyAccess'),
      );
    });
  });

  /**
   * The default roles are scoped out of the box, not scoped once somebody gets
   * around to it. See docs/iam-least-privilege.md §2 for what each of these
   * looked like before, and why the PassRole one is the dangerous member.
   */
  describe('Default role scoping', () => {
    const deployStatements = (
      template: Template,
    ): { Sid?: string; Action: unknown; Resource: unknown }[] => {
      const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
        JSON.stringify(p).includes('PassRoleToECS'),
      );
      expect(policies).toHaveLength(1);
      return (policies[0].Properties as { PolicyDocument: { Statement: never[] } }).PolicyDocument
        .Statement;
    };

    const statement = (template: Template, sid: string) => {
      const found = deployStatements(template).find((s) => s.Sid === sid);
      expect(found).toBeDefined();
      return found!;
    };

    /**
     * The `Resource` of a statement, always as a list.
     *
     * CDK renders a one-element resource list as a bare string and a longer one
     * as an array — the same shape difference `policyActions` normalizes for
     * actions elsewhere in these tests.
     */
    const resourcesOf = (template: Template, sid: string): unknown[] => {
      const { Resource } = statement(template, sid);
      return Array.isArray(Resource) ? Resource : [Resource];
    };

    // `iam:PassedToService` constrains which service receives the role, not
    // which role is handed over. With `ecs:RegisterTaskDefinition` in the same
    // policy, `Resource: "*"` here was a privilege escalation to the most
    // privileged role in the account that ECS tasks can assume.
    it('passes only the two ECS task roles, never "*"', () => {
      const { template } = makeStack({ envName: 'staging' });
      expect(resourcesOf(template, 'PassRoleToECS')).toEqual([
        'arn:aws:iam::*:role/staging-ecs-execution-role',
        'arn:aws:iam::*:role/staging-ecs-task-role',
      ]);
    });

    it('scopes ECR pushes to the repository EcrStack creates', () => {
      const { template } = makeStack({ envName: 'staging' });
      expect(resourcesOf(template, 'ECRPush')).toEqual([
        'arn:aws:ecr:*:*:repository/staging-app',
      ]);
    });

    it('scopes service updates to the service EcsStack creates', () => {
      const { template } = makeStack({ envName: 'staging' });
      expect(resourcesOf(template, 'ECSUpdate')).toEqual([
        'arn:aws:ecs:*:*:service/staging-cluster/staging-service',
      ]);
    });

    // These two accept no resource at all — a task definition that does not
    // exist yet has no ARN to authorize against — so IAM takes nothing but
    // `*`. They are split into their own statements so the wildcard is the
    // documented exception rather than the shape of the whole grant.
    it.each(['ECRAuthToken', 'ECSRegisterTaskDefinition'])(
      'keeps %s on "*" alone, since the actions take no resource',
      (sid) => {
        const { template } = makeStack();
        const found = statement(template, sid);
        expect(found.Resource).toBe('*');
        expect(Array.isArray(found.Action) ? found.Action : [found.Action]).not.toContain(
          'ecs:UpdateService',
        );
      },
    );

    it('honours an overridden deployment scope', () => {
      const { template } = makeStack({
        envName: 'staging',
        deploymentScope: {
          ecrRepositoryNames: ['custom-repo'],
          ecsClusterName: 'custom-cluster',
          ecsServiceNames: ['custom-service'],
          passableRoleArns: ['arn:aws:iam::*:role/custom-task-role'],
        },
      });
      expect(resourcesOf(template, 'ECRPush')).toEqual([
        'arn:aws:ecr:*:*:repository/custom-repo',
      ]);
      expect(resourcesOf(template, 'ECSUpdate')).toEqual([
        'arn:aws:ecs:*:*:service/custom-cluster/custom-service',
      ]);
      expect(resourcesOf(template, 'PassRoleToECS')).toEqual([
        'arn:aws:iam::*:role/custom-task-role',
      ]);
    });
  });

  describe('Custom roles', () => {
    const customRoles = [
      {
        name: 'Runner',
        description: 'Self-hosted runner role',
        conditions: [{ owner: 'my-org', repo: 'my-repo', filter: 'ref:refs/heads/main' }],
        inlineStatements: [
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: ['arn:aws:s3:::my-bucket/*'],
          }),
        ],
      },
    ];

    it('creates exactly one role when one custom role is supplied', () => {
      const { template } = makeStack({ roles: customRoles });
      expect(githubActionsRoles(template)).toHaveLength(1);
    });

    it('scopes sub to the supplied owner/repo', () => {
      const { template } = makeStack({ roles: customRoles });
      const cond = githubActionsRoles(template)[0].AssumeRolePolicyDocument.Statement[0]
        .Condition;
      const subKey = 'https://token.actions.githubusercontent.com:sub';
      const subValue = cond['StringLike'][subKey] as string | string[];
      const values = Array.isArray(subValue) ? subValue : [subValue];
      expect(values[0]).toContain('repo:my-org/my-repo:');
    });

    it('attaches the inline policy statement', () => {
      const { template } = makeStack({ roles: customRoles });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 's3:GetObject',
              Resource: 'arn:aws:s3:::my-bucket/*',
            }),
          ]),
        }),
      });
    });

    it('exports a role ARN output for each custom role', () => {
      const { template } = makeStack({ roles: customRoles });
      const outputs = template.findOutputs('*');
      const roleOutputs = Object.keys(outputs).filter((k) => k.endsWith('RoleArn'));
      expect(roleOutputs.length).toBe(1);
    });
  });

  describe('Tagging', () => {
    it('tags all resources with the environment name', () => {
      const { template } = makeStack({ envName: 'production' });
      template.hasResourceProperties('AWS::IAM::Role', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
        ]),
      });
    });

    it('tags all resources with ManagedBy', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::IAM::Role', {
        Tags: Match.arrayWith([
          { Key: 'ManagedBy', Value: 'GitHubOidcStack' },
        ]),
      });
    });
  });

  describe('Stack roles map', () => {
    it('exposes created roles via the roles Map', () => {
      const { stack } = makeStack();
      expect(stack.roles.size).toBe(3);
      expect(stack.roles.has('CI')).toBe(true);
      expect(stack.roles.has('Deploy')).toBe(true);
      expect(stack.roles.has('ReadOnly')).toBe(true);
    });

    it('exposes the provider via the provider property', () => {
      const { stack } = makeStack();
      expect(stack.provider).toBeDefined();
      expect(stack.provider.openIdConnectProviderArn).toBeTruthy();
    });
  });
});
