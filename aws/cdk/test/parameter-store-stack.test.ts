import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  ParameterStoreStack,
  ParameterStoreStackProps,
} from '../lib/parameter-store-stack';

const makeStack = (props: ParameterStoreStackProps = {}) => {
  const app = new cdk.App();
  const stack = new ParameterStoreStack(app, 'TestParameterStoreStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { template: Template.fromStack(stack), stack };
};

describe('ParameterStoreStack', () => {
  describe('KMS Encryption', () => {
    it('creates a KMS CMK by default', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::KMS::Key', 1);
    });

    it('enables key rotation on the CMK', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
      });
    });

    it('creates a KMS alias with the env prefix', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: 'alias/staging/app-parameters',
      });
    });

    it('does not create a KMS key when enableKmsEncryption is false', () => {
      const { template } = makeStack({ enableKmsEncryption: false });
      template.resourceCountIs('AWS::KMS::Key', 0);
    });

    it('exports the KMS key ARN', () => {
      const { template } = makeStack({ envName: 'test' });
      template.hasOutput('KmsKeyArn', {
        Export: { Name: 'test-app-parameters-kms-key-arn' },
      });
    });

    it('exports the KMS key alias', () => {
      const { template } = makeStack({ envName: 'test' });
      template.hasOutput('KmsKeyAlias', {
        Export: { Name: 'test-app-parameters-kms-key-alias' },
      });
    });
  });

  describe('String Parameters', () => {
    it('creates a String parameter at the /app/{env}/{key} path', () => {
      const { template } = makeStack({
        envName: 'staging',
        parameters: [
          { key: 'log-level', description: 'Application log level', value: 'info' },
        ],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/app/staging/log-level',
        Type: 'String',
        Value: 'info',
        Description: 'Application log level',
      });
    });

    it('defaults missing value to REPLACE_ME', () => {
      const { template } = makeStack({
        parameters: [{ key: 'api-endpoint', description: 'API base URL' }],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Value: 'REPLACE_ME',
      });
    });

    it('defaults parameter type to String when omitted', () => {
      const { template } = makeStack({
        parameters: [{ key: 'region', description: 'AWS region', value: 'us-east-1' }],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Type: 'String',
      });
    });

    it('creates multiple String parameters when multiple definitions are provided', () => {
      const { template } = makeStack({
        parameters: [
          { key: 'log-level', description: 'Log level', value: 'info' },
          { key: 'timeout', description: 'Request timeout', value: '30' },
          { key: 'region', description: 'Region', value: 'us-east-1' },
        ],
      });
      template.resourceCountIs('AWS::SSM::Parameter', 3);
    });

    it('creates no SSM parameters when none are defined', () => {
      const { template } = makeStack({ parameters: [] });
      template.resourceCountIs('AWS::SSM::Parameter', 0);
    });

    it('supports sub-paths via forward slashes in the key', () => {
      const { template } = makeStack({
        envName: 'production',
        parameters: [
          { key: 'feature/dark-mode', description: 'Dark mode flag', value: 'true' },
        ],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/app/production/feature/dark-mode',
      });
    });

    it('uses Standard tier by default', () => {
      const { template } = makeStack({
        parameters: [{ key: 'log-level', description: 'Log level', value: 'debug' }],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Tier: 'Standard',
      });
    });

    it('uses Advanced tier when specified', () => {
      const { template } = makeStack({
        parameters: [
          {
            key: 'large-config',
            description: 'Large JSON config',
            value: '{"x":1}',
            tier: 'Advanced',
          },
        ],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Tier: 'Advanced',
      });
    });
  });

  describe('StringList Parameters', () => {
    it('creates a StringList parameter with the correct type', () => {
      const { template } = makeStack({
        envName: 'staging',
        parameters: [
          {
            key: 'allowed-origins',
            description: 'CORS allowed origins',
            type: 'StringList',
            value: 'https://app.example.com,https://admin.example.com',
          },
        ],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/app/staging/allowed-origins',
        Type: 'StringList',
      });
    });

    it('splits comma-separated values for StringList', () => {
      const { template } = makeStack({
        parameters: [
          {
            key: 'ip-allowlist',
            description: 'Allowed IPs',
            type: 'StringList',
            value: '10.0.0.1,10.0.0.2,10.0.0.3',
          },
        ],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Value: '10.0.0.1,10.0.0.2,10.0.0.3',
        Type: 'StringList',
      });
    });
  });

  describe('SecureString Parameters', () => {
    it('creates a SecureString parameter', () => {
      const { template } = makeStack({
        envName: 'production',
        parameters: [
          {
            key: 'db-password',
            description: 'Database password',
            type: 'SecureString',
            value: 'REPLACE_ME',
          },
        ],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/app/production/db-password',
        Type: 'SecureString',
      });
    });

    it('associates the CMK with SecureString parameters', () => {
      const { template } = makeStack({
        enableKmsEncryption: true,
        parameters: [
          {
            key: 'signing-key',
            description: 'HMAC signing key',
            type: 'SecureString',
          },
        ],
      });
      const keys = template.findResources('AWS::KMS::Key');
      const keyLogicalId = Object.keys(keys)[0];
      template.hasResourceProperties('AWS::SSM::Parameter', {
        KeyId: Match.objectLike({ 'Fn::GetAtt': [keyLogicalId, 'Arn'] }),
      });
    });

    it('does not associate a KMS key when encryption is disabled', () => {
      const { template } = makeStack({
        enableKmsEncryption: false,
        parameters: [
          {
            key: 'signing-key',
            description: 'HMAC signing key',
            type: 'SecureString',
          },
        ],
      });
      const params = template.findResources('AWS::SSM::Parameter');
      const paramLogicalId = Object.keys(params)[0];
      expect(params[paramLogicalId].Properties.KeyId).toBeUndefined();
    });
  });

  describe('Removal Policy', () => {
    it('retains parameters on stack deletion in production', () => {
      const { template } = makeStack({
        envName: 'production',
        parameters: [{ key: 'log-level', description: 'Log level', value: 'warn' }],
      });
      template.hasResource('AWS::SSM::Parameter', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });

    it('destroys parameters on stack deletion in non-production', () => {
      const { template } = makeStack({
        envName: 'staging',
        parameters: [{ key: 'log-level', description: 'Log level', value: 'debug' }],
      });
      template.hasResource('AWS::SSM::Parameter', {
        DeletionPolicy: 'Delete',
      });
    });

    it('respects an explicit removalPolicy override', () => {
      const { template } = makeStack({
        envName: 'staging',
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        parameters: [{ key: 'log-level', description: 'Log level', value: 'debug' }],
      });
      template.hasResource('AWS::SSM::Parameter', {
        DeletionPolicy: 'Retain',
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the parameter path prefix', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('ParameterPathPrefix', {
        Export: { Name: 'staging-app-parameters-path-prefix' },
      });
    });

    it('exports each parameter name', () => {
      const { template } = makeStack({
        envName: 'test',
        parameters: [
          { key: 'log-level', description: 'Log level', value: 'info' },
        ],
      });
      template.hasOutput('ParamName-log-level', {
        Value: '/app/test/log-level',
        Export: { Name: 'test-param-log-level-name' },
      });
    });

    it('exports parameter names for all defined parameters', () => {
      const { template } = makeStack({
        envName: 'test',
        parameters: [
          { key: 'log-level', description: 'Log level' },
          { key: 'timeout', description: 'Timeout' },
        ],
      });
      template.hasOutput('ParamName-log-level', {});
      template.hasOutput('ParamName-timeout', {});
    });
  });

  describe('Tags', () => {
    it('tags all resources with the environment name', () => {
      const { template } = makeStack({
        envName: 'staging',
        parameters: [{ key: 'log-level', description: 'Log level', value: 'info' }],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Tags: Match.objectLike({ Environment: 'staging' }),
      });
    });

    it('tags all resources as ManagedBy CDK', () => {
      const { template } = makeStack({
        parameters: [{ key: 'log-level', description: 'Log level', value: 'info' }],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Tags: Match.objectLike({ ManagedBy: 'CDK' }),
      });
    });

    it('tags all resources with the stack ID', () => {
      const { template } = makeStack({
        parameters: [{ key: 'log-level', description: 'Log level', value: 'info' }],
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Tags: Match.objectLike({ Stack: 'TestParameterStoreStack' }),
      });
    });
  });

  describe('Stack properties', () => {
    it('exposes the parameter path prefix', () => {
      const { stack } = makeStack({ envName: 'staging' });
      expect(stack.parameterPathPrefix).toBe('/app/staging/');
    });

    it('exposes the appParameters map with the correct keys', () => {
      const { stack } = makeStack({
        parameters: [
          { key: 'log-level', description: 'Log level' },
          { key: 'timeout', description: 'Timeout' },
        ],
      });
      expect(stack.appParameters.has('log-level')).toBe(true);
      expect(stack.appParameters.has('timeout')).toBe(true);
    });

    it('does not expose the encryption key when KMS is disabled', () => {
      const { stack } = makeStack({ enableKmsEncryption: false });
      expect(stack.encryptionKey).toBeUndefined();
    });

    it('exposes the encryption key when KMS is enabled', () => {
      const { stack } = makeStack({ enableKmsEncryption: true });
      expect(stack.encryptionKey).toBeDefined();
    });
  });

  describe('grantRead()', () => {
    it('adds ssm:GetParameter to the grantee policy', () => {
      const app = new cdk.App();
      const stack = new ParameterStoreStack(app, 'Stack', {
        envName: 'staging',
        parameters: [{ key: 'log-level', description: 'Log level', value: 'info' }],
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const role = new iam.Role(stack, 'TestRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      stack.grantRead(role);
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter', 'ssm:GetParametersByPath']),
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    it('adds kms:Decrypt to the grantee policy when KMS is enabled', () => {
      const app = new cdk.App();
      const stack = new ParameterStoreStack(app, 'Stack', {
        envName: 'staging',
        enableKmsEncryption: true,
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const role = new iam.Role(stack, 'TestRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      stack.grantRead(role);
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'kms:Decrypt',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });
  });

  describe('grantReadParameter()', () => {
    it('throws when the key is not in the managed set', () => {
      const { stack } = makeStack({
        parameters: [{ key: 'log-level', description: 'Log level' }],
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const role = new iam.Role(stack, 'TestRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      expect(() => stack.grantReadParameter('nonexistent-key', role)).toThrow(
        'Parameter "nonexistent-key" is not managed by this stack',
      );
    });

    it('does not throw when the key exists', () => {
      const { stack } = makeStack({
        parameters: [{ key: 'log-level', description: 'Log level', value: 'info' }],
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const role = new iam.Role(stack, 'TestRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      expect(() => stack.grantReadParameter('log-level', role)).not.toThrow();
    });
  });

  describe('importParameter()', () => {
    it('adds the imported parameter to the appParameters map', () => {
      const { stack } = makeStack();
      stack.importParameter('external-param', '/app/staging/external-param');
      expect(stack.appParameters.has('external-param')).toBe(true);
    });

    it('returns the imported IStringParameter', () => {
      const { stack } = makeStack();
      const imported = stack.importParameter('external-param', '/app/staging/external-param');
      expect(imported).toBeDefined();
    });
  });

  describe('toEnvVarMap()', () => {
    it('throws when a key is not in the managed set', () => {
      const { stack } = makeStack({
        parameters: [{ key: 'log-level', description: 'Log level' }],
      });
      expect(() => stack.toEnvVarMap(['nonexistent'])).toThrow(
        'Parameter "nonexistent" is not managed by this stack',
      );
    });

    it('converts kebab-case keys to SCREAMING_SNAKE_CASE env var names', () => {
      const { stack } = makeStack({
        parameters: [{ key: 'log-level', description: 'Log level' }],
      });
      const mapping = stack.toEnvVarMap(['log-level']);
      expect(Object.keys(mapping)).toContain('LOG_LEVEL');
    });

    it('converts slash-delimited keys to SCREAMING_SNAKE_CASE env var names', () => {
      const { stack } = makeStack({
        parameters: [{ key: 'feature/dark-mode', description: 'Dark mode flag' }],
      });
      const mapping = stack.toEnvVarMap(['feature/dark-mode']);
      expect(Object.keys(mapping)).toContain('FEATURE_DARK_MODE');
    });
  });
});
