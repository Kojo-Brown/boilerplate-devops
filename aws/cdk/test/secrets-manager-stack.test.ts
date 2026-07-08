import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  SecretsManagerStack,
  SecretsManagerStackProps,
} from '../lib/secrets-manager-stack';

const makeStack = (props: SecretsManagerStackProps = {}) => {
  const app = new cdk.App();
  const stack = new SecretsManagerStack(app, 'TestSecretsStack', {
    envName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { stack, template: Template.fromStack(stack) };
};

describe('SecretsManagerStack', () => {
  describe('KMS encryption', () => {
    it('creates a KMS CMK by default', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::KMS::Key', 1);
    });

    it('names the KMS key alias with the env prefix', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: 'alias/staging/app-secrets',
      });
    });

    it('enables annual key rotation', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
      });
    });

    it('omits the KMS key when encryption is disabled', () => {
      const { template } = makeStack({ enableKmsEncryption: false });
      template.resourceCountIs('AWS::KMS::Key', 0);
    });

    it('exports the KMS key ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('KmsKeyArn', {
        Export: { Name: 'staging-app-secrets-kms-key-arn' },
      });
    });

    it('exports the KMS key alias', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('KmsKeyAlias', {
        Export: { Name: 'staging-app-secrets-kms-key-alias' },
      });
    });
  });

  describe('when no secrets are declared', () => {
    it('creates no Secrets Manager resources', () => {
      const { template } = makeStack({ enableKmsEncryption: false });
      template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    });

    it('the appSecrets map is empty', () => {
      const { stack } = makeStack();
      expect(stack.appSecrets.size).toBe(0);
    });
  });

  describe('placeholder secrets', () => {
    const secretDefs = [
      { key: 'stripe-api-key', description: 'Stripe secret key' },
      { key: 'sendgrid-api-key', description: 'SendGrid API key' },
    ];

    it('creates one secret per definition', () => {
      const { template } = makeStack({ secrets: secretDefs, enableKmsEncryption: false });
      template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    });

    it('names secrets with the /app/{env}/{key} path', () => {
      const { template } = makeStack({
        envName: 'staging',
        secrets: [{ key: 'stripe-api-key', description: 'Stripe key' }],
        enableKmsEncryption: false,
      });
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/app/staging/stripe-api-key',
      });
    });

    it('writes the description to the secret', () => {
      const { template } = makeStack({
        secrets: [{ key: 'stripe-api-key', description: 'Stripe secret key' }],
        enableKmsEncryption: false,
      });
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Description: 'Stripe secret key',
      });
    });

    it('defaults the initial value to REPLACE_ME', () => {
      const { template } = makeStack({
        secrets: [{ key: 'my-key', description: 'test' }],
        enableKmsEncryption: false,
      });
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        SecretString: 'REPLACE_ME',
      });
    });

    it('uses a custom initial value when provided', () => {
      const { template } = makeStack({
        secrets: [{ key: 'my-key', description: 'test', initialValue: 'custom-placeholder' }],
        enableKmsEncryption: false,
      });
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        SecretString: 'custom-placeholder',
      });
    });

    it('registers all secrets in the appSecrets map', () => {
      const { stack } = makeStack({ secrets: secretDefs, enableKmsEncryption: false });
      expect(stack.appSecrets.size).toBe(2);
      expect(stack.appSecrets.has('stripe-api-key')).toBe(true);
      expect(stack.appSecrets.has('sendgrid-api-key')).toBe(true);
    });

    it('exports the secret ARN for each key', () => {
      const { template } = makeStack({
        envName: 'staging',
        secrets: [{ key: 'stripe-api-key', description: 'Stripe key' }],
        enableKmsEncryption: false,
      });
      template.hasOutput('SecretArn-stripe-api-key', {
        Export: { Name: 'staging-secret-stripe-api-key-arn' },
      });
    });

    it('exports the secret name for each key', () => {
      const { template } = makeStack({
        envName: 'staging',
        secrets: [{ key: 'stripe-api-key', description: 'Stripe key' }],
        enableKmsEncryption: false,
      });
      template.hasOutput('SecretName-stripe-api-key', {
        Export: { Name: 'staging-secret-stripe-api-key-name' },
      });
    });
  });

  describe('generated password secrets', () => {
    it('uses GenerateSecretString when generateRandomPassword is true', () => {
      const { template } = makeStack({
        secrets: [
          {
            key: 'jwt-signing-key',
            description: 'JWT signing key',
            generateRandomPassword: true,
          },
        ],
        enableKmsEncryption: false,
      });
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        GenerateSecretString: Match.objectLike({
          PasswordLength: 32,
          ExcludePunctuation: true,
        }),
      });
    });

    it('respects custom password length', () => {
      const { template } = makeStack({
        secrets: [
          {
            key: 'signing-key',
            description: 'Signing key',
            generateRandomPassword: true,
            passwordLength: 64,
          },
        ],
        enableKmsEncryption: false,
      });
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        GenerateSecretString: Match.objectLike({ PasswordLength: 64 }),
      });
    });

    it('respects excludePunctuation: false', () => {
      const { template } = makeStack({
        secrets: [
          {
            key: 'signing-key',
            description: 'Signing key',
            generateRandomPassword: true,
            excludePunctuation: false,
          },
        ],
        enableKmsEncryption: false,
      });
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        GenerateSecretString: Match.objectLike({ ExcludePunctuation: false }),
      });
    });
  });

  describe('KMS-encrypted secrets', () => {
    it('associates secrets with the CMK when encryption is enabled', () => {
      const { template } = makeStack({
        secrets: [{ key: 'api-key', description: 'API key' }],
        enableKmsEncryption: true,
      });
      const keys = template.findResources('AWS::KMS::Key');
      const keyLogicalId = Object.keys(keys)[0];
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        KmsKeyId: { Ref: keyLogicalId },
      });
    });
  });

  describe('removal policy', () => {
    it('retains secrets in production by default', () => {
      const { template } = makeStack({
        envName: 'production',
        secrets: [{ key: 'api-key', description: 'key' }],
        enableKmsEncryption: false,
      });
      const secrets = template.findResources('AWS::SecretsManager::Secret');
      const secret = Object.values(secrets)[0] as Record<string, unknown>;
      expect((secret.DeletionPolicy as string) ?? '').not.toBe('Delete');
    });

    it('destroys secrets in non-production by default', () => {
      const { template } = makeStack({
        envName: 'staging',
        secrets: [{ key: 'api-key', description: 'key' }],
        enableKmsEncryption: false,
      });
      const secrets = template.findResources('AWS::SecretsManager::Secret');
      const secret = Object.values(secrets)[0] as Record<string, unknown>;
      expect(secret.DeletionPolicy).toBe('Delete');
    });

    it('respects an explicit removalPolicy override', () => {
      const { template } = makeStack({
        envName: 'production',
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        secrets: [{ key: 'api-key', description: 'key' }],
        enableKmsEncryption: false,
      });
      const secrets = template.findResources('AWS::SecretsManager::Secret');
      const secret = Object.values(secrets)[0] as Record<string, unknown>;
      expect(secret.DeletionPolicy).toBe('Delete');
    });
  });

  describe('grantRead', () => {
    it('attaches an IAM policy granting secretsmanager:GetSecretValue', () => {
      const app = new cdk.App();
      const stack = new SecretsManagerStack(app, 'S', {
        envName: 'test',
        secrets: [{ key: 'api-key', description: 'key' }],
        enableKmsEncryption: false,
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
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
            }),
          ]),
        },
      });
    });
  });

  describe('grantReadSecret', () => {
    it('throws for an unregistered key', () => {
      const { stack } = makeStack({
        secrets: [{ key: 'stripe-api-key', description: 'Stripe' }],
        enableKmsEncryption: false,
      });
      const role = new iam.Role(stack, 'Role', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      expect(() => stack.grantReadSecret('nonexistent-key', role)).toThrow(
        /nonexistent-key/,
      );
    });

    it('does not throw for a registered key', () => {
      const { stack } = makeStack({
        secrets: [{ key: 'stripe-api-key', description: 'Stripe' }],
        enableKmsEncryption: false,
      });
      const role = new iam.Role(stack, 'Role', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      expect(() => stack.grantReadSecret('stripe-api-key', role)).not.toThrow();
    });
  });

  describe('toEcsSecrets', () => {
    it('converts hyphenated keys to uppercase env var names', () => {
      const { stack } = makeStack({
        secrets: [
          { key: 'stripe-api-key', description: 'Stripe' },
          { key: 'sendgrid-api-key', description: 'SendGrid' },
        ],
        enableKmsEncryption: false,
      });
      const ecsSecrets = stack.toEcsSecrets(['stripe-api-key', 'sendgrid-api-key']);
      expect(Object.keys(ecsSecrets)).toEqual(
        expect.arrayContaining(['STRIPE_API_KEY', 'SENDGRID_API_KEY']),
      );
    });

    it('throws for a key that is not registered', () => {
      const { stack } = makeStack({
        secrets: [{ key: 'my-key', description: 'key' }],
        enableKmsEncryption: false,
      });
      expect(() => stack.toEcsSecrets(['unknown-key'])).toThrow(/unknown-key/);
    });
  });

  describe('importSecret', () => {
    it('adds the imported secret to the appSecrets map', () => {
      const { stack } = makeStack({ enableKmsEncryption: false });
      const fakeArn =
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:/app/staging/external-key-ABCDEF';
      stack.importSecret('external-key', fakeArn);
      expect(stack.appSecrets.has('external-key')).toBe(true);
    });
  });

  describe('tags', () => {
    it('tags all resources with the environment name', () => {
      const { template } = makeStack({
        envName: 'staging',
        secrets: [{ key: 'api-key', description: 'key' }],
        enableKmsEncryption: true,
      });
      template.hasResourceProperties('AWS::KMS::Key', {
        Tags: Match.arrayWith([Match.objectLike({ Key: 'Environment', Value: 'staging' })]),
      });
    });

    it('tags all resources as ManagedBy CDK', () => {
      const { template } = makeStack({
        secrets: [{ key: 'api-key', description: 'key' }],
        enableKmsEncryption: true,
      });
      template.hasResourceProperties('AWS::KMS::Key', {
        Tags: Match.arrayWith([Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' })]),
      });
    });
  });
});
