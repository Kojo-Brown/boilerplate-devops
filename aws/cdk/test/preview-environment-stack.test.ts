import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  PreviewEnvironmentStack,
  PreviewEnvironmentStackProps,
  PREVIEW_TAG_KEY,
  DATABASE_ADMIN_SCRIPT,
  previewDatabaseName,
  previewStackNamePrefix,
} from '../lib/preview-environment-stack';
import { flattenIntrinsic, outputByExportName, resourceProps } from './support/cfn';

const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

const makeStack = (overrides: Partial<PreviewEnvironmentStackProps> = {}) => {
  const app = new cdk.App();
  const networkStack = new cdk.Stack(app, 'NetworkStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(networkStack, 'Vpc', { maxAzs: 2 });

  const stack = new PreviewEnvironmentStack(app, 'TestPreviewStack', {
    vpc,
    certificateArn: CERTIFICATE_ARN,
    previewDomain: 'preview.example.com',
    repository: 'example-org/example-repo',
    envName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  });

  return { template: Template.fromStack(stack), stack };
};

/** Every statement across the stack's inline IAM policies. */
const policyStatements = (
  template: Template,
): { Sid?: string; Action: string | string[]; Resource: unknown; Condition?: unknown }[] =>
  resourceProps(template, 'AWS::IAM::Policy').flatMap((policy) => {
    const { Statement } = policy.PolicyDocument as {
      Statement: { Sid?: string; Action: string | string[]; Resource: unknown }[];
    };
    return Statement;
  });

const statementBySid = (template: Template, sid: string) =>
  policyStatements(template).find((statement) => statement.Sid === sid);

const reaperEnvironment = (template: Template): Record<string, string> => {
  const [fn] = resourceProps(template, 'AWS::Lambda::Function').filter(
    (props) => flattenIntrinsic(props.FunctionName).endsWith('-reaper'),
  );
  return (fn.Environment as { Variables: Record<string, string> }).Variables;
};

describe('PreviewEnvironmentStack', () => {
  describe('prop validation', () => {
    it('rejects an unknown-state TTL longer than the absolute lifetime', () => {
      // The unknown-state fallback is the tighter of the two bounds. Inverted,
      // it can never fire, and the stack would silently lose the protection it
      // was configured with rather than fail.
      expect(() => makeStack({ unknownStateTtlHours: 200, maxLifetimeHours: 168 })).toThrow(
        /must not exceed maxLifetimeHours/,
      );
    });

    it('accepts an unknown-state TTL equal to the lifetime', () => {
      expect(() => makeStack({ unknownStateTtlHours: 168, maxLifetimeHours: 168 })).not.toThrow();
    });
  });

  describe('routing', () => {
    it('answers an unrouted preview hostname with 404, not another pull request', () => {
      // The wildcard DNS record resolves for torn-down previews too. Whatever
      // the listener's default action is, that is what a stale link reaches.
      const { template } = makeStack();

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        DefaultActions: Match.arrayWith([
          Match.objectLike({
            Type: 'fixed-response',
            FixedResponseConfig: Match.objectLike({ StatusCode: '404' }),
          }),
        ]),
      });
    });

    it('redirects port 80 to HTTPS permanently', () => {
      const { template } = makeStack();

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        DefaultActions: Match.arrayWith([
          Match.objectLike({
            Type: 'redirect',
            RedirectConfig: Match.objectLike({ Protocol: 'HTTPS', StatusCode: 'HTTP_301' }),
          }),
        ]),
      });
    });

    it('negotiates no TLS below 1.2', () => {
      // `SslPolicy.RECOMMENDED` is still the 2016 policy, which allows TLS 1.0.
      const { template } = makeStack();

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      });
    });

    it('drops invalid header fields at the load balancer', () => {
      const { template } = makeStack();

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: Match.arrayWith([
          { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        ]),
      });
    });
  });

  describe('shared task security group', () => {
    it('is the only thing granted access to the preview database', () => {
      // Per-PR stacks attach to this group rather than adding their own rule.
      // A preview that fails to delete would otherwise strand an ingress rule
      // on a security group it does not own, against a limit of 60.
      const { template } = makeStack();

      const ingress = resourceProps(template, 'AWS::EC2::SecurityGroupIngress').filter(
        (rule) => rule.FromPort === 5432,
      );

      expect(ingress).toHaveLength(1);
      expect(ingress[0].Description).toBe('PostgreSQL from preview tasks');
    });

    it('accepts traffic from the shared ALB only', () => {
      const { template, stack } = makeStack({ containerPort: 4000 });

      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        FromPort: 4000,
        ToPort: 4000,
        GroupId: { 'Fn::GetAtt': [Match.anyValue(), 'GroupId'] },
        Description: 'From the shared preview ALB',
      });
      expect(stack.containerPort).toBe(4000);
    });
  });

  describe('database admin task', () => {
    it('refuses to act on a database outside the preview prefix', () => {
      // The guard is what makes interpolating the name into SQL safe, and what
      // stops a wrong override dropping the application's own database.
      expect(DATABASE_ADMIN_SCRIPT).toContain('"$PREVIEW_DATABASE_PREFIX"[0-9]*)');
      expect(DATABASE_ADMIN_SCRIPT).toMatch(/refusing to .*not a preview database/);
    });

    it('creates the database only when it does not already exist', () => {
      // Every push to the pull request runs this again.
      expect(DATABASE_ADMIN_SCRIPT).toContain('SELECT 1 FROM pg_database WHERE datname');
      expect(DATABASE_ADMIN_SCRIPT).toContain('CREATE DATABASE');
    });

    it('forces connections closed when dropping', () => {
      // Teardown runs while the service is still draining; without FORCE the
      // drop fails exactly when teardown is quick.
      expect(DATABASE_ADMIN_SCRIPT).toContain('DROP DATABASE IF EXISTS');
      expect(DATABASE_ADMIN_SCRIPT).toContain('WITH (FORCE)');
    });

    it('exits non-zero on an unrecognised action', () => {
      expect(DATABASE_ADMIN_SCRIPT).toMatch(/unknown PREVIEW_DB_ACTION/);
    });

    it('reads the database password from Secrets Manager, never the environment', () => {
      const { template } = makeStack();

      const [taskDef] = resourceProps(template, 'AWS::ECS::TaskDefinition').filter(
        (props) => flattenIntrinsic(props.Family) === 'test-db-admin',
      );
      const [container] = taskDef.ContainerDefinitions as Record<string, unknown>[];

      const plainNames = (container.Environment as { Name: string }[]).map((e) => e.Name);
      const secretNames = (container.Secrets as { Name: string }[]).map((s) => s.Name);

      expect(secretNames).toEqual(expect.arrayContaining(['PGUSER', 'PGPASSWORD']));
      expect(plainNames).not.toContain('PGPASSWORD');
    });
  });

  describe('reaper', () => {
    it('runs on a schedule rather than waiting to be told', () => {
      const { template } = makeStack();

      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: 'rate(1 hour)',
        State: 'ENABLED',
      });
    });

    it('is given the repository and thresholds it decides with', () => {
      const { template } = makeStack({
        maxLifetimeHours: 100,
        unknownStateTtlHours: 20,
        maxDeletionsPerRun: 3,
      });

      expect(reaperEnvironment(template)).toEqual(
        expect.objectContaining({
          REPOSITORY: 'example-org/example-repo',
          MAX_LIFETIME_HOURS: '100',
          UNKNOWN_STATE_TTL_HOURS: '20',
          MAX_DELETIONS_PER_RUN: '3',
          STACK_NAME_PREFIX: 'test-pr-',
          PREVIEW_TAG_KEY,
        }),
      );
    });

    it('knows the name of the stack it must never delete', () => {
      const { template, stack } = makeStack();

      expect(reaperEnvironment(template).SHARED_STACK_NAME).toBe(stack.stackName);
    });

    it('can delete preview stacks and nothing else', () => {
      // DescribeStacks has no resource-level permissions, so the filtering
      // happens in the handler. DeleteStack is the call that destroys
      // something, and it is scoped by name.
      const { template } = makeStack();

      const deleteStatement = statementBySid(template, 'DeletePreviewStacks');
      expect(deleteStatement?.Action).toBe('cloudformation:DeleteStack');
      expect(flattenIntrinsic(deleteStatement?.Resource)).toContain(':stack/test-pr-*/*');

      const readStatement = statementBySid(template, 'ReadStacks');
      expect(readStatement?.Action).toBe('cloudformation:DescribeStacks');
      expect(readStatement?.Resource).toBe('*');
    });

    it('can run the admin task only in the preview cluster', () => {
      const { template } = makeStack();

      const statement = statementBySid(template, 'DropPreviewDatabases');
      expect(statement?.Action).toBe('ecs:RunTask');
      expect(statement?.Condition).toEqual(
        expect.objectContaining({ ArnEquals: expect.objectContaining({ 'ecs:cluster': expect.anything() }) }),
      );
    });

    it('can run every revision of the admin task, not just the current one', () => {
      // RunTask authorises against the revision ARN, and each re-register of
      // the task definition mints a new one.
      const { template } = makeStack();

      const resource = flattenIntrinsic(statementBySid(template, 'DropPreviewDatabases')?.Resource);
      expect(resource).toContain(':task-definition/test-db-admin:*');
    });

    it('can pass the admin roles to ECS and nowhere else', () => {
      const { template } = makeStack();

      const statement = statementBySid(template, 'PassAdminTaskRoles');
      expect(statement?.Action).toBe('iam:PassRole');
      expect(statement?.Condition).toEqual({
        StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
      });
    });

    it('is granted the GitHub token secret only when one is configured', () => {
      const withoutToken = makeStack().template;
      expect(statementBySid(withoutToken, 'ReadGitHubToken')).toBeUndefined();
      expect(reaperEnvironment(withoutToken).GITHUB_TOKEN_SECRET_ARN).toBe('');

      const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-github-token';
      const withToken = makeStack({ githubTokenSecretArn: secretArn }).template;

      expect(statementBySid(withToken, 'ReadGitHubToken')?.Resource).toBe(secretArn);
      expect(reaperEnvironment(withToken).GITHUB_TOKEN_SECRET_ARN).toBe(secretArn);
    });

    it('runs one invocation at a time', () => {
      // Two overlapping sweeps would each see the other's stacks still
      // present and issue a second DeleteStack for them.
      const { template } = makeStack();

      const [fn] = resourceProps(template, 'AWS::Lambda::Function').filter(
        (props) => flattenIntrinsic(props.FunctionName).endsWith('-reaper'),
      );
      expect(fn.ReservedConcurrentExecutions).toBe(1);
    });
  });

  describe('the shared stack itself', () => {
    it('does not carry the tag that marks a stack disposable', () => {
      // The reaper deletes what is tagged. This stack is the one thing in the
      // system that must survive, so it is never tagged.
      const { template } = makeStack();

      for (const resourceType of ['AWS::ECS::Cluster', 'AWS::RDS::DBInstance']) {
        for (const props of resourceProps(template, resourceType)) {
          const tags = (props.Tags as { Key: string }[] | undefined) ?? [];
          expect(tags.map((tag) => tag.Key)).not.toContain(PREVIEW_TAG_KEY);
        }
      }
    });

    it('publishes what a per-PR deploy needs to find it', () => {
      const { template } = makeStack();

      for (const exportName of [
        'test-cluster-name',
        'test-db-admin-task-family',
        'test-task-subnets',
        'test-task-security-group',
        'test-alb-dns',
      ]) {
        expect(outputByExportName(template, exportName)).toBeDefined();
      }
    });

    it('keeps the preview database out of production shape on purpose', () => {
      const { template } = makeStack();

      template.hasResourceProperties('AWS::RDS::DBInstance', {
        MultiAZ: false,
        StorageEncrypted: true,
        PubliclyAccessible: false,
        BackupRetentionPeriod: 0,
        DeletionProtection: false,
      });
    });
  });

  describe('naming helpers', () => {
    it('derives the stack prefix the delete policy is scoped to', () => {
      expect(previewStackNamePrefix('preview')).toBe('preview-pr-');
    });

    it('derives a database name inside the guarded prefix', () => {
      expect(previewDatabaseName(123)).toBe('preview_pr_123');
    });
  });
});
