import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EcrStack, EcrStackProps } from '../lib/ecr-stack';

const makeStack = (props: EcrStackProps = {}) => {
  const app = new cdk.App();
  const stack = new EcrStack(app, 'TestEcrStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { template: Template.fromStack(stack), stack };
};

describe('EcrStack', () => {
  describe('ECR Repository', () => {
    it('creates exactly one ECR repository', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::ECR::Repository', 1);
    });

    it('names the repository with the env prefix by default', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryName: 'staging-app',
      });
    });

    it('uses a custom repository name when provided', () => {
      const { template } = makeStack({ repositoryName: 'my-service' });
      template.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryName: 'my-service',
      });
    });

    it('enables image scanning on push by default', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::ECR::Repository', {
        ImageScanningConfiguration: { ScanOnPush: true },
      });
    });

    it('disables image scanning when scanOnPush is false', () => {
      const { template } = makeStack({ scanOnPush: false });
      template.hasResourceProperties('AWS::ECR::Repository', {
        ImageScanningConfiguration: { ScanOnPush: false },
      });
    });

    it('uses AES-256 encryption by default', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::ECR::Repository', {
        EncryptionConfiguration: { EncryptionType: 'AES256' },
      });
    });

    it('enforces immutable image tags', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::ECR::Repository', {
        ImageTagMutability: 'IMMUTABLE',
      });
    });

    it('retains the repository on stack deletion in production', () => {
      const { template } = makeStack({ envName: 'production' });
      template.hasResource('AWS::ECR::Repository', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });

    it('destroys the repository on stack deletion in non-production', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResource('AWS::ECR::Repository', {
        DeletionPolicy: 'Delete',
      });
    });
  });

  describe('Lifecycle Policy', () => {
    it('creates a lifecycle policy on the repository', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::ECR::Repository', {
        LifecyclePolicy: Match.objectLike({
          LifecyclePolicyText: Match.anyValue(),
        }),
      });
    });

    it('includes a rule to expire untagged images', () => {
      const { template } = makeStack({ untaggedImageExpiryDays: 14 });
      const repos = template.findResources('AWS::ECR::Repository');
      const repoLogicalId = Object.keys(repos)[0];
      const policyText = repos[repoLogicalId].Properties.LifecyclePolicy.LifecyclePolicyText;
      const policy = JSON.parse(policyText) as {
        rules: Array<{ selection: { tagStatus: string }; action: { type: string } }>;
      };
      const untaggedRule = policy.rules.find(
        (r) => r.selection.tagStatus === 'untagged',
      );
      expect(untaggedRule).toBeDefined();
    });

    it('includes a rule to cap the number of retained tagged images', () => {
      const { template } = makeStack({ maxTaggedImageCount: 10 });
      const repos = template.findResources('AWS::ECR::Repository');
      const repoLogicalId = Object.keys(repos)[0];
      const policyText = repos[repoLogicalId].Properties.LifecyclePolicy.LifecyclePolicyText;
      const policy = JSON.parse(policyText) as {
        rules: Array<{
          selection: { tagStatus: string; countNumber?: number };
          action: { type: string };
        }>;
      };
      const countRule = policy.rules.find(
        (r) => r.selection.tagStatus !== 'untagged' && r.selection.countNumber === 10,
      );
      expect(countRule).toBeDefined();
    });

    it('applies the untagged rule at a lower priority number than the count rule', () => {
      const { template } = makeStack();
      const repos = template.findResources('AWS::ECR::Repository');
      const repoLogicalId = Object.keys(repos)[0];
      const policyText = repos[repoLogicalId].Properties.LifecyclePolicy.LifecyclePolicyText;
      const policy = JSON.parse(policyText) as {
        rules: Array<{ rulePriority: number; selection: { tagStatus: string } }>;
      };
      const untaggedRule = policy.rules.find((r) => r.selection.tagStatus === 'untagged');
      const countRule = policy.rules.find((r) => r.selection.tagStatus !== 'untagged');
      expect(untaggedRule).toBeDefined();
      expect(countRule).toBeDefined();
      expect(untaggedRule!.rulePriority).toBeLessThan(countRule!.rulePriority);
    });

    it('uses tag prefixes in the count rule when managedTagPrefixes are provided', () => {
      const { template } = makeStack({ managedTagPrefixes: ['v', 'release-'] });
      const repos = template.findResources('AWS::ECR::Repository');
      const repoLogicalId = Object.keys(repos)[0];
      const policyText = repos[repoLogicalId].Properties.LifecyclePolicy.LifecyclePolicyText;
      const policy = JSON.parse(policyText) as {
        rules: Array<{
          selection: { tagStatus: string; tagPrefixList?: string[] };
        }>;
      };
      const prefixRule = policy.rules.find(
        (r) => Array.isArray(r.selection.tagPrefixList),
      );
      expect(prefixRule).toBeDefined();
      expect(prefixRule!.selection.tagPrefixList).toEqual(expect.arrayContaining(['v', 'release-']));
    });
  });

  describe('Cross-Account Pull Policy', () => {
    it('does not create a resource policy when no cross-account IDs are provided', () => {
      const { template } = makeStack();
      const repos = template.findResources('AWS::ECR::Repository');
      const repoLogicalId = Object.keys(repos)[0];
      expect(repos[repoLogicalId].Properties.RepositoryPolicyText).toBeUndefined();
    });

    it('creates a resource policy allowing pull from trusted accounts', () => {
      const { template } = makeStack({
        crossAccountPullAccountIds: ['111122223333', '444455556666'],
      });
      const repos = template.findResources('AWS::ECR::Repository');
      const repoLogicalId = Object.keys(repos)[0];
      const policyText = JSON.parse(
        repos[repoLogicalId].Properties.RepositoryPolicyText,
      ) as { Statement: Array<{ Sid: string; Principal: { AWS: string | string[] } }> };
      const crossAccountStatement = policyText.Statement.find(
        (s) => s.Sid === 'CrossAccountPull',
      );
      expect(crossAccountStatement).toBeDefined();
    });

    it('grants only pull-related actions in the cross-account policy', () => {
      const { template } = makeStack({
        crossAccountPullAccountIds: ['111122223333'],
      });
      const repos = template.findResources('AWS::ECR::Repository');
      const repoLogicalId = Object.keys(repos)[0];
      const policyText = JSON.parse(
        repos[repoLogicalId].Properties.RepositoryPolicyText,
      ) as {
        Statement: Array<{ Sid: string; Action: string | string[] }>;
      };
      const crossAccountStatement = policyText.Statement.find(
        (s) => s.Sid === 'CrossAccountPull',
      );
      expect(crossAccountStatement).toBeDefined();
      const actions = Array.isArray(crossAccountStatement!.Action)
        ? crossAccountStatement!.Action
        : [crossAccountStatement!.Action];
      expect(actions).toContain('ecr:BatchGetImage');
      expect(actions).not.toContain('ecr:PutImage');
      expect(actions).not.toContain('ecr:DeleteRepository');
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the repository URI', () => {
      const { template } = makeStack({ envName: 'test' });
      template.hasOutput('RepositoryUri', {
        Export: { Name: 'test-ecr-repository-uri' },
      });
    });

    it('exports the repository ARN', () => {
      const { template } = makeStack({ envName: 'test' });
      template.hasOutput('RepositoryArn', {
        Export: { Name: 'test-ecr-repository-arn' },
      });
    });

    it('exports the repository name', () => {
      const { template } = makeStack({ envName: 'test' });
      template.hasOutput('RepositoryName', {
        Export: { Name: 'test-ecr-repository-name' },
      });
    });
  });

  describe('Tags', () => {
    it('tags all resources with the environment name', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::ECR::Repository', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'staging' }),
        ]),
      });
    });

    it('tags all resources as ManagedBy CDK', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::ECR::Repository', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' }),
        ]),
      });
    });

    it('tags all resources with the stack ID', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::ECR::Repository', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Stack', Value: 'TestEcrStack' }),
        ]),
      });
    });
  });

  describe('Stack outputs (public property)', () => {
    it('exposes the repository construct', () => {
      const { stack } = makeStack();
      expect(stack.repository).toBeDefined();
    });
  });
});
