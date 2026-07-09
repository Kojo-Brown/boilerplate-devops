import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GitHubOidcStack, GitHubOidcStackProps } from '../lib/github-oidc-stack';

const makeStack = (props: GitHubOidcStackProps = {}) => {
  const app = new cdk.App();
  const stack = new GitHubOidcStack(app, 'TestGitHubOidcStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { template: Template.fromStack(stack), stack };
};

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
    it('creates three default IAM roles', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::IAM::Role', 3);
    });

    it('creates roles with names scoped to the envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      const roles = template.findResources('AWS::IAM::Role');
      const roleNames = Object.values(roles).map(
        (r) => (r as { Properties: { RoleName: string } }).Properties.RoleName,
      );
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
      const roles = template.findResources('AWS::IAM::Role');
      for (const role of Object.values(roles)) {
        const trustDoc = (role as {
          Properties: {
            AssumeRolePolicyDocument: {
              Statement: Array<{ Effect: string; Action: string }>;
            };
          };
        }).Properties.AssumeRolePolicyDocument;
        const stmt = trustDoc.Statement[0];
        expect(stmt.Action).toBe('sts:AssumeRoleWithWebIdentity');
        expect(stmt.Effect).toBe('Allow');
      }
    });

    it('enforces audience claim on all roles', () => {
      const { template } = makeStack();
      const roles = template.findResources('AWS::IAM::Role');
      for (const role of Object.values(roles)) {
        const trustDoc = (role as {
          Properties: {
            AssumeRolePolicyDocument: {
              Statement: Array<{
                Condition: Record<string, Record<string, string>>;
              }>;
            };
          };
        }).Properties.AssumeRolePolicyDocument;
        const cond = trustDoc.Statement[0].Condition;
        expect(
          cond['StringEquals']['https://token.actions.githubusercontent.com:aud'],
        ).toBe('sts.amazonaws.com');
      }
    });

    it('sets sub condition with StringLike (not Equals) for wildcard support', () => {
      const { template } = makeStack();
      const roles = template.findResources('AWS::IAM::Role');
      for (const role of Object.values(roles)) {
        const trustDoc = (role as {
          Properties: {
            AssumeRolePolicyDocument: {
              Statement: Array<{
                Condition: Record<string, Record<string, string>>;
              }>;
            };
          };
        }).Properties.AssumeRolePolicyDocument;
        const cond = trustDoc.Statement[0].Condition;
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

    it('ReadOnly role has the ReadOnlyAccess managed policy', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: Match.stringLikeRegexp('-readonly$'),
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.anyValue(),
              Match.arrayWith(['arn:', Match.anyValue(), ':iam::aws:policy/ReadOnlyAccess']),
            ]),
          }),
        ]),
      });
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
      template.resourceCountIs('AWS::IAM::Role', 1);
    });

    it('scopes sub to the supplied owner/repo', () => {
      const { template } = makeStack({ roles: customRoles });
      const roles = template.findResources('AWS::IAM::Role');
      const role = Object.values(roles)[0] as {
        Properties: {
          AssumeRolePolicyDocument: {
            Statement: Array<{
              Condition: Record<string, Record<string, string>>;
            }>;
          };
        };
      };
      const cond = role.Properties.AssumeRolePolicyDocument.Statement[0].Condition;
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
