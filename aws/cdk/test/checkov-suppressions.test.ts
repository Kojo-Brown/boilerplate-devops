import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EksStack } from '../lib/eks-stack';
import { VpcStack } from '../lib/vpc-stack';
import {
  CheckovSkip,
  EKS_PROVIDER_SUPPRESSIONS,
  EksProviderCheckovSuppressions,
  suppressCheckovChecks,
} from '../lib/checkov-suppressions';

const ENV = { account: '123456789012', region: 'us-east-1' };

/**
 * Construct paths whose resources CDK generates, and which the suppressions are
 * allowed to touch. A resource this repository declares has a path with none of
 * these in it — which is the property the scope test below enforces.
 */
const CDK_GENERATED_PATHS = [
  '/@aws-cdk--aws-eks.ClusterResourceProvider/',
  '/@aws-cdk--aws-eks.KubectlProvider/',
  '/AWSCDKCfnUtilsProviderCustomResourceProvider',
  '/Cluster/Resource/CreationRole/DefaultPolicy',
];

interface SuppressedResource {
  readonly path: string;
  readonly type: string;
  readonly skips: CheckovSkip[];
}

/** Every resource in the stack (nested stacks included) carrying a suppression. */
const suppressedResources = (stack: cdk.Stack): SuppressedResource[] => {
  // Aspects run during synthesis, so the metadata does not exist before this.
  Template.fromStack(stack);

  return stack.node
    .findAll()
    .filter((node): node is cdk.CfnResource => cdk.CfnResource.isCfnResource(node))
    .map((resource) => ({
      resource,
      metadata: resource.getMetadata('checkov') as { skip?: CheckovSkip[] } | undefined,
    }))
    .filter((entry) => entry.metadata !== undefined)
    .map((entry) => ({
      path: entry.resource.node.path,
      type: entry.resource.cfnResourceType,
      skips: entry.metadata?.skip ?? [],
    }));
};

const makeEksStack = (id = 'SuppressionEksStack') => {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, `${id}Vpc`, { env: ENV });
  return new EksStack(app, id, { env: ENV, envName: 'staging', vpc: vpcStack.vpc });
};

describe('Checkov suppressions', () => {
  describe('suppressCheckovChecks', () => {
    const makeResource = () => {
      const stack = new cdk.Stack(new cdk.App(), 'Stack');
      return new cdk.CfnResource(stack, 'Resource', { type: 'AWS::SQS::Queue' });
    };

    it('writes the metadata shape Checkov reads', () => {
      const resource = makeResource();
      suppressCheckovChecks(resource, [{ id: 'CKV_AWS_1', comment: 'because' }]);

      expect(resource.getMetadata('checkov')).toEqual({
        skip: [{ id: 'CKV_AWS_1', comment: 'because' }],
      });
    });

    it('accumulates skips across calls', () => {
      const resource = makeResource();
      suppressCheckovChecks(resource, [{ id: 'CKV_AWS_1', comment: 'first' }]);
      suppressCheckovChecks(resource, [{ id: 'CKV_AWS_2', comment: 'second' }]);

      expect((resource.getMetadata('checkov') as { skip: CheckovSkip[] }).skip).toEqual([
        { id: 'CKV_AWS_1', comment: 'first' },
        { id: 'CKV_AWS_2', comment: 'second' },
      ]);
    });

    it('does not duplicate a check already suppressed', () => {
      const resource = makeResource();
      suppressCheckovChecks(resource, [{ id: 'CKV_AWS_1', comment: 'first' }]);
      suppressCheckovChecks(resource, [{ id: 'CKV_AWS_1', comment: 'again' }]);

      expect((resource.getMetadata('checkov') as { skip: CheckovSkip[] }).skip).toEqual([
        { id: 'CKV_AWS_1', comment: 'first' },
      ]);
    });
  });

  describe('rule table', () => {
    it('gives every suppression a reason — Checkov ignores a skip with no comment', () => {
      for (const rule of EKS_PROVIDER_SUPPRESSIONS) {
        for (const skip of rule.skips) {
          expect(skip.id).toMatch(/^CKV_AWS_\d+$/);
          expect(skip.comment.length).toBeGreaterThan(40);
        }
      }
    });

    it('targets only CDK-generated construct paths', () => {
      for (const rule of EKS_PROVIDER_SUPPRESSIONS) {
        expect(CDK_GENERATED_PATHS).toContain(rule.pathIncludes);
      }
    });
  });

  describe('applied to EksStack', () => {
    it('suppresses exactly the CDK provider handlers and the creation policy', () => {
      const suppressed = suppressedResources(makeEksStack());

      expect(
        suppressed
          .map((resource) => resource.path.replace(/^SuppressionEksStack\//, ''))
          .sort(),
      ).toEqual([
        '@aws-cdk--aws-eks.ClusterResourceProvider/IsCompleteHandler/Resource',
        '@aws-cdk--aws-eks.ClusterResourceProvider/OnEventHandler/Resource',
        '@aws-cdk--aws-eks.ClusterResourceProvider/Provider/framework-isComplete/Resource',
        '@aws-cdk--aws-eks.ClusterResourceProvider/Provider/framework-onEvent/Resource',
        '@aws-cdk--aws-eks.ClusterResourceProvider/Provider/framework-onTimeout/Resource',
        '@aws-cdk--aws-eks.KubectlProvider/Handler/Resource',
        '@aws-cdk--aws-eks.KubectlProvider/Provider/framework-onEvent/Resource',
        'AWSCDKCfnUtilsProviderCustomResourceProvider/Handler',
        'Cluster/Resource/CreationRole/DefaultPolicy/Resource',
      ]);
    });

    it('leaves everything the stack itself declares unsuppressed', () => {
      const suppressed = suppressedResources(makeEksStack('DeclaredEksStack'));

      for (const resource of suppressed) {
        expect(
          CDK_GENERATED_PATHS.some((generated) => resource.path.includes(generated)),
        ).toBe(true);
      }

      // Spot-check the resources whose findings must never be waived this way.
      const paths = suppressed.map((resource) => resource.path);
      for (const declared of [
        'DeclaredEksStack/NodeRole/Resource',
        'DeclaredEksStack/SecretsKey/Resource',
        'DeclaredEksStack/VpcCniAddon',
        'DeclaredEksStack/SystemNodeGroupLaunchTemplate',
      ]) {
        expect(paths).not.toContain(declared);
      }
    });

    it('waives only concurrency, DLQ and env-var encryption on the provider Lambdas', () => {
      const suppressed = suppressedResources(makeEksStack('LambdaEksStack')).filter(
        (resource) =>
          resource.type === 'AWS::Lambda::Function' &&
          !resource.path.includes('AWSCDKCfnUtilsProviderCustomResourceProvider'),
      );

      expect(suppressed).toHaveLength(7);
      for (const resource of suppressed) {
        expect(resource.skips.map((skip) => skip.id).sort()).toEqual([
          'CKV_AWS_115',
          'CKV_AWS_116',
          'CKV_AWS_173',
        ]);
      }
    });

    it('waives the VPC check on the CfnJson evaluator alone, which cannot take one', () => {
      const suppressed = suppressedResources(makeEksStack('CfnJsonEksStack'));
      const inVpcWaived = suppressed.filter((resource) =>
        resource.skips.some((skip) => skip.id === 'CKV_AWS_117'),
      );

      expect(inVpcWaived.map((resource) => resource.path)).toEqual([
        'CfnJsonEksStack/AWSCDKCfnUtilsProviderCustomResourceProvider/Handler',
      ]);
    });

    it('is inert where its rules do not match', () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'PlainStack', { env: ENV });
      const queue = new cdk.CfnResource(stack, 'Queue', { type: 'AWS::SQS::Queue' });
      cdk.Aspects.of(stack).add(new EksProviderCheckovSuppressions());

      Template.fromStack(stack);

      expect(queue.getMetadata('checkov')).toBeUndefined();
    });
  });
});
