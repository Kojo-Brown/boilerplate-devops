import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PreviewEnvironmentStack } from '../lib/preview-environment-stack';
import {
  PreviewPrStack,
  PreviewPrStackProps,
  DEFAULT_RULE_PRIORITY_BASE,
  DEFAULT_RULE_PRIORITY_RANGE,
  previewRulePriority,
  previewStackName,
  truncateTargetGroupName,
} from '../lib/preview-pr-stack';
import { flattenIntrinsic, resourceProps } from './support/cfn';

const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

const IMAGE_URI = '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:sha-abc123';

const env = { account: '123456789012', region: 'us-east-1' };

const makeStack = (overrides: Partial<PreviewPrStackProps> = {}) => {
  const app = new cdk.App();
  const networkStack = new cdk.Stack(app, 'NetworkStack', { env });
  const vpc = new ec2.Vpc(networkStack, 'Vpc', { maxAzs: 2 });

  const shared = new PreviewEnvironmentStack(app, 'SharedStack', {
    vpc,
    certificateArn: CERTIFICATE_ARN,
    previewDomain: 'preview.example.com',
    repository: 'example-org/example-repo',
    envName: 'test',
    env,
  });

  const stack = new PreviewPrStack(app, 'TestPreviewPrStack', {
    prNumber: 123,
    repository: 'example-org/example-repo',
    imageUri: IMAGE_URI,
    vpc,
    cluster: shared.cluster,
    httpsListener: shared.httpsListener,
    taskSecurityGroup: shared.taskSecurityGroup,
    logGroup: shared.logGroup,
    databaseHost: 'preview.example.internal',
    databasePort: '5432',
    databaseSecret: shared.databaseSecret,
    previewDomain: 'preview.example.com',
    envName: 'test',
    env,
    ...overrides,
  });

  return { template: Template.fromStack(stack), stack };
};

const appContainer = (template: Template): Record<string, unknown> => {
  const [taskDefinition] = resourceProps(template, 'AWS::ECS::TaskDefinition');
  const containers = taskDefinition.ContainerDefinitions as Record<string, unknown>[];
  return containers[0];
};

const containerEnvironment = (template: Template): Record<string, string> =>
  Object.fromEntries(
    (appContainer(template).Environment as { Name: string; Value: unknown }[]).map((entry) => [
      entry.Name,
      flattenIntrinsic(entry.Value),
    ]),
  );

describe('PreviewPrStack', () => {
  describe('prop validation', () => {
    it.each([0, -1, 1.5, Number.NaN])('rejects a pull request number of %p', (prNumber) => {
      // Everything about a preview is derived from this number — the stack
      // name the reaper's delete policy is scoped to, the hostname, the
      // database, the listener-rule priority. A bad one is not recoverable
      // later, so it fails at synth.
      expect(() => makeStack({ prNumber })).toThrow(/must be a positive integer/);
    });
  });

  describe('naming', () => {
    it('names the stack inside the prefix the reaper is allowed to delete', () => {
      const { stack } = makeStack();
      expect(stack.stackName).toBe('test-pr-123');
      expect(previewStackName('preview', 7)).toBe('preview-pr-7');
    });

    it('serves the preview on its own hostname under the wildcard', () => {
      const { stack } = makeStack();
      expect(stack.hostname).toBe('pr-123.preview.example.com');
    });

    it('gives the pull request a database inside the guarded prefix', () => {
      const { stack } = makeStack();
      expect(stack.databaseName).toBe('preview_pr_123');
    });
  });

  describe('listener rule priority', () => {
    it('derives the priority so two concurrent deploys cannot race for one', () => {
      expect(previewRulePriority(123)).toBe(DEFAULT_RULE_PRIORITY_BASE + 123);
      expect(previewRulePriority(123)).toBe(previewRulePriority(123));
    });

    it('wraps rather than synthesising a priority the ALB rejects', () => {
      // A repository that reaches pull request 50000 would otherwise produce
      // priorities outside the 1–50000 range the API accepts.
      expect(previewRulePriority(DEFAULT_RULE_PRIORITY_RANGE + 5)).toBe(
        DEFAULT_RULE_PRIORITY_BASE + 5,
      );
      expect(previewRulePriority(1_000_000)).toBeLessThanOrEqual(50000);
    });

    it('refuses a base and range that cannot fit, for every pull request', () => {
      // The check is on the configuration, not on the priority a particular
      // call produces. 40000 + 20000 overflows the ALB's ceiling for pull
      // requests numbered above 10000 and is fine below it, so validating the
      // result would let the mistake ship and fail years later.
      expect(() => previewRulePriority(1, 40_000, 20_000)).toThrow(/outside the ALB's/);
      expect(() => previewRulePriority(19_999, 40_000, 20_000)).toThrow(/outside the ALB's/);
      expect(() => previewRulePriority(1, 0, 100)).toThrow(/outside the ALB's/);
    });

    it('puts the derived priority on the rule and matches on the host header', () => {
      const { template } = makeStack();

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
        Priority: DEFAULT_RULE_PRIORITY_BASE + 123,
        Conditions: Match.arrayWith([
          Match.objectLike({
            Field: 'host-header',
            HostHeaderConfig: { Values: ['pr-123.preview.example.com'] },
          }),
        ]),
      });
    });
  });

  describe('target group naming', () => {
    it('leaves a name that already fits alone', () => {
      expect(truncateTargetGroupName('preview-pr-123')).toBe('preview-pr-123');
    });

    it('keeps the pull request number when trimming, not the prefix', () => {
      // The number is the only part that makes the name unique.
      const trimmed = truncateTargetGroupName('a-very-long-environment-name-pr-4242');

      expect(trimmed).toHaveLength(32);
      expect(trimmed.endsWith('-pr-4242')).toBe(true);
    });

    it('never exceeds the ALB limit for a plausible pull request number', () => {
      const { template } = makeStack({ prNumber: 999999 });

      const [targetGroup] = resourceProps(template, 'AWS::ElasticLoadBalancingV2::TargetGroup');
      expect((targetGroup.Name as string).length).toBeLessThanOrEqual(32);
    });
  });

  describe('seed ordering', () => {
    it('declares the service with no tasks so the seed can run first', () => {
      // The task definition and the service are created by one CloudFormation
      // operation. A service declared with a task would start the application
      // against a database with no schema, inside that same operation.
      const { template } = makeStack();

      template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
    });

    it('seeds from the image under review, not a separately pinned one', () => {
      // The workflow overrides the command on this task definition, so the
      // migrations and the fixtures come from the commit being previewed.
      const { template } = makeStack();

      expect(appContainer(template).Image).toBe(IMAGE_URI);
    });

    it('publishes the seed command it expects to be overridden with', () => {
      const { template } = makeStack({ seedCommand: ['pnpm', 'seed'] });

      const outputs = template.findOutputs('*');
      const seedOutput = Object.values(outputs).find(
        (output) => output.Description === undefined
          ? false
          : String(output.Description).includes('seed fixtures'),
      );

      expect(seedOutput?.Value).toBe('["pnpm","seed"]');
    });
  });

  describe('database credentials', () => {
    it('passes connection details as libpq variables, with the password from the secret', () => {
      // Composing a DATABASE_URL here would put the password in the task
      // definition, where describe-task-definition hands it to anyone with
      // read access to the cluster.
      const { template } = makeStack();

      expect(containerEnvironment(template)).toEqual(
        expect.objectContaining({
          PGHOST: 'preview.example.internal',
          PGPORT: '5432',
          PGDATABASE: 'preview_pr_123',
          PREVIEW_PR_NUMBER: '123',
          PREVIEW_URL: 'https://pr-123.preview.example.com',
        }),
      );

      const secrets = (appContainer(template).Secrets as { Name: string }[]).map((s) => s.Name);
      expect(secrets).toEqual(expect.arrayContaining(['PGUSER', 'PGPASSWORD']));
      expect(Object.keys(containerEnvironment(template))).not.toContain('PGPASSWORD');
    });

    it('lets a caller add environment variables without losing the database ones', () => {
      const { template } = makeStack({ environment: { FEATURE_FLAGS: 'all' } });

      expect(containerEnvironment(template)).toEqual(
        expect.objectContaining({ FEATURE_FLAGS: 'all', PGDATABASE: 'preview_pr_123' }),
      );
    });
  });

  describe('deletability', () => {
    it('creates no security group rules of its own', () => {
      // A rule created here would live in a stack designed to be deleted while
      // pointing at a group that outlives it.
      const { template } = makeStack();

      template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
      template.resourceCountIs('AWS::EC2::SecurityGroupEgress', 0);
      template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
    });

    it('names no IAM role', () => {
      // A named role is an account-wide uniqueness constraint. A preview stack
      // that fails to delete would hold the name, and the pull request could
      // never be previewed again without manual cleanup.
      for (const role of resourceProps(makeStack().template, 'AWS::IAM::Role')) {
        expect(role.RoleName).toBeUndefined();
      }
    });

    it('exports nothing', () => {
      // A CloudFormation export is a lock held by whoever imports it.
      for (const output of Object.values(makeStack().template.findOutputs('*'))) {
        expect(output.Export).toBeUndefined();
      }
    });
  });

  describe('reaper contract', () => {
    it('tags every resource with the marker and the pull request number', () => {
      const { template } = makeStack();

      template.hasResourceProperties('AWS::ECS::Service', {
        Tags: Match.arrayWith([
          { Key: 'PreviewEnvironment', Value: 'true' },
          { Key: 'PreviewPrNumber', Value: '123' },
          { Key: 'PreviewRepository', Value: 'example-org/example-repo' },
        ]),
      });
    });
  });
});
