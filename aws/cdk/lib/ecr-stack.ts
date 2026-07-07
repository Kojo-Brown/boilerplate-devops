import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface EcrStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** Repository name (default: `{envName}-app`) */
  readonly repositoryName?: string;
  /**
   * Maximum number of tagged images to retain per repository.
   * Older images beyond this count are expired. (default: 30)
   */
  readonly maxTaggedImageCount?: number;
  /**
   * Days after which untagged images are expired. (default: 7)
   */
  readonly untaggedImageExpiryDays?: number;
  /**
   * Tag prefixes that are subject to the tagged-image count limit.
   * An empty array applies the rule to ALL tagged images. (default: [])
   */
  readonly managedTagPrefixes?: string[];
  /**
   * AWS account IDs that may pull from this repository cross-account.
   * Useful for allowing a separate tooling account to pull images. (default: [])
   */
  readonly crossAccountPullAccountIds?: string[];
  /**
   * Whether to enable vulnerability scanning on every image push. (default: true)
   */
  readonly scanOnPush?: boolean;
  /**
   * Removal policy for the repository. RETAIN is recommended for production to
   * avoid accidental data loss. (default: RETAIN for production, DESTROY otherwise)
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * ECR repository with lifecycle policies to control storage costs.
 *
 * Lifecycle rules (applied in priority order):
 *   1. Expire ALL untagged images older than N days (default 7)
 *   2. Expire tagged images when the total count exceeds M (default 30)
 *
 * Security:
 *   - Image scanning on push enabled by default
 *   - Optional cross-account pull policy for trusted accounts
 *
 * Cost:
 *   Lifecycle rules keep the repository lean; untagged layers from failed
 *   builds are purged within a week, and tagged releases are capped at 30.
 */
export class EcrStack extends cdk.Stack {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps = {}) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const repositoryName = props.repositoryName ?? `${envName}-app`;
    const maxTaggedImageCount = props.maxTaggedImageCount ?? 30;
    const untaggedImageExpiryDays = props.untaggedImageExpiryDays ?? 7;
    const scanOnPush = props.scanOnPush ?? true;
    const crossAccountPullAccountIds = props.crossAccountPullAccountIds ?? [];
    const managedTagPrefixes = props.managedTagPrefixes ?? [];
    const removalPolicy =
      props.removalPolicy ??
      (envName === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY);

    // ── ECR Repository ────────────────────────────────────────────────────────
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName,
      imageScanOnPush: scanOnPush,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy,
      emptyOnDelete: removalPolicy === cdk.RemovalPolicy.DESTROY,
      encryption: ecr.RepositoryEncryption.AES_256,
    });

    // ── Lifecycle Policy ──────────────────────────────────────────────────────
    // Rule 1 (priority 1): expire untagged images first, before any count rule
    // applies. Untagged images accumulate rapidly from CI layer caching.
    this.repository.addLifecycleRule({
      rulePriority: 1,
      description: `Expire untagged images after ${untaggedImageExpiryDays} days`,
      tagStatus: ecr.TagStatus.UNTAGGED,
      maxImageAge: cdk.Duration.days(untaggedImageExpiryDays),
    });

    // Rule 2 (priority 2): cap the total number of tagged images retained.
    // If specific tag prefixes are provided, scope the rule to those prefixes;
    // otherwise apply to ALL tagged images.
    if (managedTagPrefixes.length > 0) {
      this.repository.addLifecycleRule({
        rulePriority: 2,
        description: `Keep the last ${maxTaggedImageCount} images matching prefixes [${managedTagPrefixes.join(', ')}]`,
        tagStatus: ecr.TagStatus.TAGGED,
        tagPrefixList: managedTagPrefixes,
        maxImageCount: maxTaggedImageCount,
      });
    } else {
      this.repository.addLifecycleRule({
        rulePriority: 2,
        description: `Keep the last ${maxTaggedImageCount} tagged images`,
        tagStatus: ecr.TagStatus.ANY,
        maxImageCount: maxTaggedImageCount,
      });
    }

    // ── Cross-Account Pull Policy ─────────────────────────────────────────────
    if (crossAccountPullAccountIds.length > 0) {
      this.repository.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'CrossAccountPull',
          principals: crossAccountPullAccountIds.map(
            (accountId) => new iam.AccountPrincipal(accountId),
          ),
          actions: [
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
            'ecr:BatchCheckLayerAvailability',
          ],
          effect: iam.Effect.ALLOW,
        }),
      );
    }

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR repository URI — use as base for docker build/push/pull',
      exportName: `${envName}-ecr-repository-uri`,
    });

    new cdk.CfnOutput(this, 'RepositoryArn', {
      value: this.repository.repositoryArn,
      description: 'ECR repository ARN — grant pull/push IAM actions against this ARN',
      exportName: `${envName}-ecr-repository-arn`,
    });

    new cdk.CfnOutput(this, 'RepositoryName', {
      value: this.repository.repositoryName,
      description: 'ECR repository name',
      exportName: `${envName}-ecr-repository-name`,
    });
  }
}
