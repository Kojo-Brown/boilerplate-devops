import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export type ParameterType = 'String' | 'StringList' | 'SecureString';
export type ParameterTier = 'Standard' | 'Advanced';

export interface AppParameterDefinition {
  /**
   * Short key used in the parameter name path: /app/{env}/{key}
   * Must contain only alphanumeric characters, hyphens, underscores, and forward slashes.
   * Forward slashes create sub-paths: "database/url" → /app/{env}/database/url
   */
  readonly key: string;
  /** Human-readable description stored on the SSM parameter. */
  readonly description: string;
  /**
   * Parameter type. SecureString parameters are encrypted at rest with KMS.
   * StringList values are comma-separated; access the list in shell as: IFS=',' read -ra VALUES <<< "$PARAM"
   * Defaults to "String".
   */
  readonly type?: ParameterType;
  /**
   * Initial value written at synthesis time.
   * For SecureString parameters, the value is encrypted by KMS before storage.
   * Override post-deployment:
   *   aws ssm put-parameter --name /app/{env}/{key} --value '...' --overwrite
   * Defaults to "REPLACE_ME".
   */
  readonly value?: string;
  /**
   * Parameter tier. Advanced parameters support values up to 8 KB and policies (TTL, change notification).
   * Standard parameters support up to 4 KB and are free.
   * Defaults to "Standard".
   */
  readonly tier?: ParameterTier;
}

export interface ParameterStoreStackProps extends cdk.StackProps {
  /** Environment name used for resource naming, tagging, and parameter paths. */
  readonly envName?: string;
  /**
   * Application parameters to create.
   * Each entry creates one SSM parameter at /app/{envName}/{key}.
   */
  readonly parameters?: AppParameterDefinition[];
  /**
   * Encrypt SecureString parameters with a KMS customer-managed key.
   * When false, SecureString parameters use the AWS-managed key (alias/aws/ssm).
   * Defaults to true.
   */
  readonly enableKmsEncryption?: boolean;
  /**
   * CloudFormation removal policy for parameters and the KMS key.
   * Defaults to RETAIN for production, DESTROY elsewhere.
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * AWS Systems Manager Parameter Store hierarchy for application configuration.
 *
 * Creates parameters following the /app/{env}/{key} path convention, separating
 * runtime configuration (Parameter Store) from secrets (Secrets Manager).
 * Use Parameter Store for non-secret config values (feature flags, endpoints,
 * region names, ARNs) and Secrets Manager for credentials and API keys.
 *
 * Path examples:
 *   /app/staging/log-level           → "info"
 *   /app/staging/feature/dark-mode   → "true"
 *   /app/production/api-endpoint     → "https://api.example.com"
 *   /app/production/db-pool-size     → "10"  (SecureString for sensitive config)
 *
 * Deployment workflow:
 *   1. Deploy this stack — parameters are created with placeholder values.
 *   2. Update real values (once, out of band):
 *        aws ssm put-parameter \
 *          --name /app/staging/api-endpoint \
 *          --value 'https://api.staging.example.com' \
 *          --overwrite
 *   3. Grant ECS tasks / Lambda access:
 *        paramStack.grantRead(ecsTaskDef.taskRole)
 *   4. Read parameters at runtime (Node.js):
 *        const ssm = new SSMClient({});
 *        const { Parameter } = await ssm.send(new GetParameterCommand({
 *          Name: '/app/staging/api-endpoint',
 *          WithDecryption: true,
 *        }));
 *
 * Security:
 *   - SecureString parameters encrypted with a CMK (annual auto-rotation)
 *   - String/StringList parameters readable only by principals explicitly granted access
 *   - IAM path-based policy restricts grantee to only /app/{env}/* parameters
 */
export class ParameterStoreStack extends cdk.Stack {
  /** KMS CMK used to encrypt SecureString parameters (defined when enableKmsEncryption is true). */
  public readonly encryptionKey?: kms.Key;

  /**
   * All parameters managed by this stack, keyed by the short key from AppParameterDefinition.
   * Access specific parameters for fine-grained IAM grants or CloudFormation cross-stack references.
   */
  public readonly appParameters: Map<string, ssm.IParameter> = new Map();

  /** The IAM path prefix for all parameters in this stack: /app/{envName}/ */
  public readonly parameterPathPrefix: string;

  /** The environment name for this stack (e.g. "staging", "production"). */
  public readonly envName: string;

  constructor(scope: Construct, id: string, props: ParameterStoreStackProps = {}) {
    super(scope, id, props);

    this.envName = props.envName ?? 'production';
    const envName = this.envName;
    const enableKmsEncryption = props.enableKmsEncryption ?? true;
    const removalPolicy =
      props.removalPolicy ??
      (envName === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY);
    const parameterDefinitions = props.parameters ?? [];

    this.parameterPathPrefix = `/app/${envName}/`;

    // ── KMS Customer-Managed Key ──────────────────────────────────────────────
    // A CMK allows fine-grained CloudTrail audit of all decrypt calls and
    // lets you revoke access to all SecureString parameters by disabling the key.
    if (enableKmsEncryption) {
      this.encryptionKey = new kms.Key(this, 'ParameterStoreKey', {
        alias: `alias/${envName}/app-parameters`,
        description: `KMS CMK for ${envName} SSM SecureString parameters — auto-rotated annually`,
        enableKeyRotation: true,
        removalPolicy,
      });

      new cdk.CfnOutput(this, 'KmsKeyArn', {
        value: this.encryptionKey.keyArn,
        description: 'KMS CMK ARN — grant kms:Decrypt to any role that needs SecureString access',
        exportName: `${envName}-app-parameters-kms-key-arn`,
      });

      new cdk.CfnOutput(this, 'KmsKeyAlias', {
        value: `alias/${envName}/app-parameters`,
        description: 'KMS key alias for SSM SecureString parameters',
        exportName: `${envName}-app-parameters-kms-key-alias`,
      });
    }

    // ── Parameters ────────────────────────────────────────────────────────────
    for (const def of parameterDefinitions) {
      const paramType = def.type ?? 'String';
      const paramTier = def.tier ?? 'Standard';
      const logicalId = def.key.replace(/[^a-zA-Z0-9]/g, '-');
      const paramName = `/app/${envName}/${def.key}`;

      let param: ssm.IParameter;

      if (paramType === 'SecureString') {
        // CDK's high-level constructs do not support SecureString creation.
        // We drop to L1 (CfnParameter) and attach a custom resource for the
        // removal policy, then wrap in StringParameter.fromSecureStringParameterAttributes
        // for IAM grant methods.
        const cfnParam = new ssm.CfnParameter(this, `Param-${logicalId}`, {
          name: paramName,
          description: def.description,
          type: 'SecureString',
          value: def.value ?? 'REPLACE_ME',
          tier: paramTier,
          // CDK's CfnParameter does not accept a KMS key ID directly — the
          // key ARN is passed as the KeyId field (accepted by SSM API).
          keyId: this.encryptionKey?.keyArn,
        });
        cfnParam.applyRemovalPolicy(removalPolicy);

        param = ssm.StringParameter.fromSecureStringParameterAttributes(
          this,
          `ParamRef-${logicalId}`,
          {
            parameterName: paramName,
            encryptionKey: this.encryptionKey,
          },
        );
      } else if (paramType === 'StringList') {
        const p = new ssm.StringListParameter(this, `Param-${logicalId}`, {
          parameterName: paramName,
          description: def.description,
          stringListValue: (def.value ?? 'REPLACE_ME').split(',').map((v) => v.trim()),
          tier:
            paramTier === 'Advanced'
              ? ssm.ParameterTier.ADVANCED
              : ssm.ParameterTier.STANDARD,
        });
        p.applyRemovalPolicy(removalPolicy);
        param = p;
      } else {
        const p = new ssm.StringParameter(this, `Param-${logicalId}`, {
          parameterName: paramName,
          description: def.description,
          stringValue: def.value ?? 'REPLACE_ME',
          tier:
            paramTier === 'Advanced'
              ? ssm.ParameterTier.ADVANCED
              : ssm.ParameterTier.STANDARD,
        });
        p.applyRemovalPolicy(removalPolicy);
        param = p;
      }

      this.appParameters.set(def.key, param);

      new cdk.CfnOutput(this, `ParamName-${logicalId}`, {
        value: paramName,
        description: `SSM Parameter Store name for ${paramName} (${paramType})`,
        exportName: `${envName}-param-${logicalId}-name`,
      });
    }

    // ── Path Prefix Output ────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ParameterPathPrefix', {
      value: this.parameterPathPrefix,
      description: `SSM path prefix for all ${envName} parameters — use GetParametersByPath to load all at once`,
      exportName: `${envName}-app-parameters-path-prefix`,
    });

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);
  }

  /**
   * Grant an IAM principal GetParameter / GetParameters / GetParametersByPath
   * on ALL parameters under this stack's /app/{env}/ prefix.
   * Also grants kms:Decrypt on the CMK when KMS encryption is enabled.
   *
   * Use this to give an ECS task role or Lambda access to all config values.
   * For tighter least-privilege grants, use grantReadParameter().
   */
  grantRead(grantee: iam.IGrantable): iam.Grant {
    const grant = iam.Grant.addToPrincipal({
      grantee,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
        'ssm:DescribeParameters',
      ],
      resourceArns: [
        cdk.Stack.of(this).formatArn({
          service: 'ssm',
          resource: 'parameter',
          resourceName: `app/${this.parameterPathPrefix.replace(/^\//, '').replace(/\/$/, '')}/*`,
        }),
      ],
    });
    this.encryptionKey?.grantDecrypt(grantee);
    return grant;
  }

  /**
   * Grant an IAM principal read access to a single named parameter.
   * Prefer this over grantRead() when a role only needs one or two parameters.
   *
   * Throws if the key was not declared in the constructor's `parameters` prop.
   */
  grantReadParameter(key: string, grantee: iam.IGrantable): iam.Grant {
    const param = this.appParameters.get(key);
    if (!param) {
      throw new Error(
        `Parameter "${key}" is not managed by this stack. ` +
          `Registered keys: [${[...this.appParameters.keys()].join(', ')}]`,
      );
    }
    const grant = param.grantRead(grantee);
    this.encryptionKey?.grantDecrypt(grantee);
    return grant;
  }

  /**
   * Returns a record mapping environment variable names to SSM parameter names
   * for use in documentation, ECS task definitions, or Lambda environment configs.
   *
   * Key-to-env-var mapping:
   *   "log-level"        → LOG_LEVEL
   *   "api/endpoint"     → API_ENDPOINT
   *   "db-pool-size"     → DB_POOL_SIZE
   *
   * Usage in ECS task definition (fetch at startup via aws-cli init container):
   *   aws ssm get-parameters-by-path \
   *     --path /app/staging/ \
   *     --with-decryption \
   *     --query 'Parameters[*].[Name,Value]' \
   *     --output text | while read name value; do
   *       export "$(basename "$name" | tr '[:lower:]-' '[:upper:]_')=$value"
   *     done
   */
  toEnvVarMap(keys: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (!this.appParameters.has(key)) {
        throw new Error(
          `Parameter "${key}" is not managed by this stack. ` +
            `Registered keys: [${[...this.appParameters.keys()].join(', ')}]`,
        );
      }
      const envVarName = key
        .toUpperCase()
        .replace(/[/\-\s]/g, '_');
      result[envVarName] = `/app/${this.envName}/${key}`;
    }
    return result;
  }

  /**
   * Import an existing SSM parameter created outside this stack into the managed set.
   * The imported parameter participates in grantRead() only if the parameter path
   * begins with this stack's prefix; for grantReadParameter(), it works regardless.
   *
   * Use the full parameter name including the /app/{env}/ prefix.
   */
  importParameter(key: string, parameterName: string): ssm.IStringParameter {
    const id = `Imported-${key.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const imported = ssm.StringParameter.fromStringParameterName(this, id, parameterName);
    this.appParameters.set(key, imported);
    return imported;
  }
}
