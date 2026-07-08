import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AppSecretDefinition {
  /**
   * Short key used in the secret name path: /app/{env}/{key}
   * Must contain only alphanumeric characters, hyphens, and underscores.
   */
  readonly key: string;
  /** Human-readable description stored on the Secrets Manager secret. */
  readonly description: string;
  /**
   * Literal initial value written at synthesis time.
   * Change it post-deployment via:
   *   aws secretsmanager put-secret-value --secret-id /app/{env}/{key} --secret-string '...'
   * Defaults to the sentinel string "REPLACE_ME".
   * Ignored when generateRandomPassword is true.
   */
  readonly initialValue?: string;
  /**
   * When true, Secrets Manager generates a random password instead of using
   * initialValue.  Useful for internal signing keys, HMAC secrets, etc.
   */
  readonly generateRandomPassword?: boolean;
  /** Length of the generated password (default: 32). */
  readonly passwordLength?: number;
  /** Exclude punctuation from generated passwords (default: true). */
  readonly excludePunctuation?: boolean;
}

export interface SecretsManagerStackProps extends cdk.StackProps {
  /** Environment name used for resource naming, tagging, and secret paths. */
  readonly envName?: string;
  /**
   * Application secrets to create.
   * Each entry creates one AWS::SecretsManager::Secret at /app/{envName}/{key}.
   */
  readonly secrets?: AppSecretDefinition[];
  /**
   * Encrypt all secrets with a KMS customer-managed key.
   * Requires the ECS execution role to have kms:Decrypt on the key.
   * Defaults to true.
   */
  readonly enableKmsEncryption?: boolean;
  /**
   * CloudFormation removal policy for secrets and the KMS key.
   * Defaults to RETAIN for production, DESTROY elsewhere.
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * AWS Secrets Manager integration pattern for application-level secrets.
 *
 * Manages named secrets following the /app/{env}/{key} hierarchy.  This stack
 * handles API keys, OAuth tokens, and third-party credentials — it is separate
 * from RdsStack's database credentials, which stay co-located with the RDS stack.
 *
 * Deployment workflow:
 *   1. Deploy this stack — secrets are created with placeholder values.
 *   2. Populate real values (once, out of band):
 *        aws secretsmanager put-secret-value \
 *          --secret-id /app/staging/stripe-api-key \
 *          --secret-string '{"secretKey":"sk_test_..."}'
 *   3. Grant ECS tasks access:
 *        secretsStack.grantRead(ecsTaskDefinition.executionRole)
 *   4. Reference secrets in ECS task definitions:
 *        taskDef.addContainer('App', {
 *          secrets: secretsStack.toEcsSecrets(['stripe-api-key']),
 *        });
 *
 * Security:
 *   - Optional KMS CMK with automatic annual rotation
 *   - Secrets are inaccessible until an IAM principal is explicitly granted access
 *   - Production secrets default to RETAIN removal policy (no accidental deletion)
 */
export class SecretsManagerStack extends cdk.Stack {
  /** KMS CMK used to encrypt secrets (defined when enableKmsEncryption is true). */
  public readonly encryptionKey?: kms.Key;

  /**
   * All secrets managed by this stack, keyed by the short key from AppSecretDefinition.
   * Access specific secrets for fine-grained IAM grants or ECS injection.
   */
  public readonly appSecrets: Map<string, secretsmanager.ISecret> = new Map();

  constructor(scope: Construct, id: string, props: SecretsManagerStackProps = {}) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const enableKmsEncryption = props.enableKmsEncryption ?? true;
    const removalPolicy =
      props.removalPolicy ??
      (envName === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY);
    const secretDefinitions = props.secrets ?? [];

    // ── KMS Customer-Managed Key ──────────────────────────────────────────────
    // A dedicated CMK gives per-secret access control via key policies and lets
    // you audit all decrypt calls in CloudTrail separately from AWS-managed keys.
    if (enableKmsEncryption) {
      this.encryptionKey = new kms.Key(this, 'SecretsKey', {
        alias: `alias/${envName}/app-secrets`,
        description: `KMS CMK for ${envName} application secrets — auto-rotated annually`,
        enableKeyRotation: true,
        removalPolicy,
      });

      new cdk.CfnOutput(this, 'KmsKeyArn', {
        value: this.encryptionKey.keyArn,
        description: 'KMS CMK ARN — grant kms:Decrypt to any role that needs secret access',
        exportName: `${envName}-app-secrets-kms-key-arn`,
      });

      new cdk.CfnOutput(this, 'KmsKeyAlias', {
        value: `alias/${envName}/app-secrets`,
        description: 'KMS key alias for application secrets',
        exportName: `${envName}-app-secrets-kms-key-alias`,
      });
    }

    // ── Application Secrets ───────────────────────────────────────────────────
    for (const def of secretDefinitions) {
      const secretId = def.key.replace(/[^a-zA-Z0-9]/g, '-');
      const secretName = `/app/${envName}/${def.key}`;

      const secret = def.generateRandomPassword
        ? new secretsmanager.Secret(this, `Secret-${secretId}`, {
            secretName,
            description: def.description,
            encryptionKey: this.encryptionKey,
            generateSecretString: {
              passwordLength: def.passwordLength ?? 32,
              excludePunctuation: def.excludePunctuation ?? true,
            },
            removalPolicy,
          })
        : new secretsmanager.Secret(this, `Secret-${secretId}`, {
            secretName,
            description: def.description,
            encryptionKey: this.encryptionKey,
            secretStringValue: cdk.SecretValue.unsafePlainText(
              def.initialValue ?? 'REPLACE_ME',
            ),
            removalPolicy,
          });

      this.appSecrets.set(def.key, secret);

      new cdk.CfnOutput(this, `SecretArn-${secretId}`, {
        value: secret.secretArn,
        description: `Secrets Manager ARN for ${secretName}`,
        exportName: `${envName}-secret-${secretId}-arn`,
      });

      new cdk.CfnOutput(this, `SecretName-${secretId}`, {
        value: secret.secretName,
        description: `Secrets Manager name for ${secretName}`,
        exportName: `${envName}-secret-${secretId}-name`,
      });
    }

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);
  }

  /**
   * Grant an IAM principal read access to ALL secrets in this stack.
   * Also grants kms:Decrypt on the CMK when encryption is enabled.
   *
   * Use this to give an ECS task execution role or Lambda function access to
   * the full secret set.  For tighter least-privilege grants, use grantReadSecret().
   */
  grantRead(grantee: iam.IGrantable): void {
    for (const secret of this.appSecrets.values()) {
      secret.grantRead(grantee);
    }
    this.encryptionKey?.grantDecrypt(grantee);
  }

  /**
   * Grant an IAM principal read access to a single named secret.
   * Prefer this over grantRead() when a role only needs one or two secrets.
   *
   * Throws if the key was not declared in the constructor's `secrets` prop.
   */
  grantReadSecret(key: string, grantee: iam.IGrantable): void {
    const secret = this.appSecrets.get(key);
    if (!secret) {
      throw new Error(
        `Secret "${key}" is not managed by this stack. ` +
          `Registered keys: [${[...this.appSecrets.keys()].join(', ')}]`,
      );
    }
    secret.grantRead(grantee);
    this.encryptionKey?.grantDecrypt(grantee);
  }

  /**
   * Returns a record of { ENV_VAR_NAME: ecs.Secret } for use in ECS task
   * definitions.  The ECS agent resolves secret values at container startup —
   * the plaintext is never stored in the task definition or CloudWatch Logs.
   *
   * Key-to-env-var mapping:
   *   "stripe-api-key"  →  STRIPE_API_KEY
   *   "sendgrid_key"    →  SENDGRID_KEY
   *
   * Passing the result to addContainer() automatically grants the task
   * execution role secretsmanager:GetSecretValue on the referenced secrets.
   *
   * Usage:
   *   taskDef.addContainer('App', {
   *     image: ecs.ContainerImage.fromRegistry('myapp:latest'),
   *     secrets: secretsStack.toEcsSecrets(['stripe-api-key', 'sendgrid-api-key']),
   *   });
   */
  toEcsSecrets(keys: string[]): Record<string, ecs.Secret> {
    const result: Record<string, ecs.Secret> = {};
    for (const key of keys) {
      const secret = this.appSecrets.get(key);
      if (!secret) {
        throw new Error(
          `Secret "${key}" is not managed by this stack. ` +
            `Registered keys: [${[...this.appSecrets.keys()].join(', ')}]`,
        );
      }
      const envVarName = key.toUpperCase().replace(/[-\s]/g, '_');
      result[envVarName] = ecs.Secret.fromSecretsManager(secret);
    }
    return result;
  }

  /**
   * Import an existing secret created outside this stack into the managed set.
   * The imported secret participates in grantRead() and toEcsSecrets() calls,
   * but CDK will not manage its lifecycle (no deletion on stack destroy).
   *
   * Use the complete ARN (includes the 6-character suffix appended by SM).
   */
  importSecret(key: string, secretCompleteArn: string): secretsmanager.ISecret {
    const id = `Imported-${key.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const imported = secretsmanager.Secret.fromSecretCompleteArn(this, id, secretCompleteArn);
    this.appSecrets.set(key, imported);
    return imported;
  }
}
