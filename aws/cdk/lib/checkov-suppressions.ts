import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * Checkov inline suppressions for the resources CDK generates on our behalf.
 *
 * CI scans the synthesised CloudFormation and fails on any finding that is not
 * in `.checkov.baseline`, which is the right default: infrastructure this
 * repository writes has to come in clean. The CDK EKS module, though, ships its
 * own deployment-time machinery — the cluster resource handler, the kubectl
 * handler, the `Provider` framework functions behind both, and the tiny
 * `CfnJson` evaluator — and those Lambdas are emitted with properties we do not
 * choose and cannot reach through construct props.
 *
 * Two ways to make CI green were rejected before this one:
 *
 *   • Adding the findings to `.checkov.baseline`. The baseline records what
 *     existed when the gate was introduced; new infrastructure entering it is
 *     exactly the regression the gate is there to catch, and the entries carry
 *     no explanation of themselves.
 *
 *   • Setting the properties anyway through `addPropertyOverride` on CDK
 *     internals — a DLQ per handler that nothing consumes, a CMK for
 *     environment variables CDK writes itself. That is configuration added to
 *     satisfy a scanner rather than a threat, on resources whose shape is not
 *     ours to own.
 *
 * So the suppressions are declared here instead: per resource, with a written
 * justification, scoped by construct path, and pinned by
 * `test/checkov-suppressions.test.ts` so the escape hatch cannot quietly spread
 * to resources this repository does write.
 */

/** One Checkov check suppressed on one resource, with the reason. */
export interface CheckovSkip {
  /** Checkov check ID, e.g. `CKV_AWS_115` */
  readonly id: string;
  /** Why the check does not apply here — Checkov requires a non-empty comment */
  readonly comment: string;
}

/** A rule mapping CDK-generated resources to the checks suppressed on them. */
export interface CheckovSuppressionRule {
  /** Substring matched against the construct path (`node.path`) */
  readonly pathIncludes: string;
  /** CloudFormation resource types the rule applies to */
  readonly resourceTypes: readonly string[];
  readonly skips: readonly CheckovSkip[];
}

/**
 * Checks that do not apply to a CloudFormation custom-resource handler.
 *
 * These functions run during stack operations, are invoked only by
 * CloudFormation, and hold no application data. Reserved concurrency would
 * carve a slice out of the account's pool for a function that runs a handful of
 * times per deployment; a dead-letter queue would collect events the `Provider`
 * framework already retries and reports back to CloudFormation, where a failure
 * surfaces as a failed stack update rather than a silently dropped message; and
 * the environment variables are the handler's own configuration — cluster name,
 * handler paths — written by CDK, not secrets, and still encrypted at rest with
 * the AWS-managed Lambda key.
 */
const CUSTOM_RESOURCE_HANDLER_SKIPS: readonly CheckovSkip[] = [
  {
    id: 'CKV_AWS_115',
    comment:
      'CDK-generated custom resource handler: invoked by CloudFormation during stack ' +
      'operations only. Reserving account concurrency for it would not bound anything ' +
      'an attacker controls.',
  },
  {
    id: 'CKV_AWS_116',
    comment:
      'CDK-generated custom resource handler: failures are returned to CloudFormation ' +
      'by the Provider framework and fail the stack operation. A DLQ would collect ' +
      'events nothing consumes.',
  },
  {
    id: 'CKV_AWS_173',
    comment:
      'CDK-generated custom resource handler: the environment variables are handler ' +
      'configuration written by CDK, not secrets, and are encrypted at rest with the ' +
      'AWS-managed Lambda key.',
  },
];

/**
 * Suppressions applied inside {@link EksStack}.
 *
 * Deliberately keyed on the CDK-internal construct paths: nothing this
 * repository declares sits under `@aws-cdk--aws-eks.*`,
 * `AWSCDKCfnUtilsProviderCustomResourceProvider`, or the cluster's own
 * `CreationRole`.
 */
export const EKS_PROVIDER_SUPPRESSIONS: readonly CheckovSuppressionRule[] = [
  {
    // Creates, updates and deletes the control plane itself.
    pathIncludes: '/@aws-cdk--aws-eks.ClusterResourceProvider/',
    resourceTypes: ['AWS::Lambda::Function'],
    skips: CUSTOM_RESOURCE_HANDLER_SKIPS,
  },
  {
    // Applies manifests and Helm charts; already VPC-attached because the API
    // server endpoint is private, so CKV_AWS_117 passes on its own.
    pathIncludes: '/@aws-cdk--aws-eks.KubectlProvider/',
    resourceTypes: ['AWS::Lambda::Function'],
    skips: CUSTOM_RESOURCE_HANDLER_SKIPS,
  },
  {
    // Evaluates the CfnJson used to build IRSA trust conditions, whose keys are
    // only known after the cluster exists. It is a `CustomResourceProvider`,
    // the minimal flavour that predates the Provider framework and exposes no
    // VPC, DLQ or concurrency configuration at all.
    pathIncludes: '/AWSCDKCfnUtilsProviderCustomResourceProvider',
    resourceTypes: ['AWS::Lambda::Function'],
    skips: [
      CUSTOM_RESOURCE_HANDLER_SKIPS[0],
      CUSTOM_RESOURCE_HANDLER_SKIPS[1],
      {
        id: 'CKV_AWS_117',
        comment:
          'CDK CustomResourceProvider: the construct accepts no VPC configuration. It ' +
          'transforms values passed to it and reaches no network service.',
      },
    ],
  },
  {
    // The role CDK's cluster handler assumes to call eks:CreateCluster.
    pathIncludes: '/Cluster/Resource/CreationRole/DefaultPolicy',
    resourceTypes: ['AWS::IAM::Policy'],
    skips: [
      {
        id: 'CKV_AWS_109',
        comment:
          'CDK-generated cluster creation policy. The unconstrained statement is ' +
          'iam:CreateServiceLinkedRole, which EKS requires to create ' +
          'AWSServiceRoleForAmazonEKS and which cannot name the role in advance; every ' +
          'other statement is scoped to this cluster, its role, or its KMS key.',
      },
    ],
  },
];

/**
 * Merge Checkov skips into a resource's `Metadata`.
 *
 * Checkov reads `Metadata.checkov.skip` on a CloudFormation resource and reports
 * the listed checks as skipped rather than failed. Existing metadata and
 * already-present skips are preserved.
 */
export const suppressCheckovChecks = (
  resource: cdk.CfnResource,
  skips: readonly CheckovSkip[],
): void => {
  const existing = (resource.getMetadata('checkov') ?? {}) as { skip?: CheckovSkip[] };
  const merged = [...(existing.skip ?? [])];

  for (const skip of skips) {
    if (!merged.some((entry) => entry.id === skip.id)) {
      merged.push(skip);
    }
  }

  resource.addMetadata('checkov', { skip: merged });
};

/**
 * Aspect that applies {@link EKS_PROVIDER_SUPPRESSIONS} to the CDK-generated
 * resources it names, wherever they end up — including the nested stacks the
 * EKS module creates for its two providers.
 */
export class EksProviderCheckovSuppressions implements cdk.IAspect {
  constructor(
    private readonly rules: readonly CheckovSuppressionRule[] = EKS_PROVIDER_SUPPRESSIONS,
  ) {}

  public visit(node: IConstruct): void {
    if (!cdk.CfnResource.isCfnResource(node)) return;

    for (const rule of this.rules) {
      if (!node.node.path.includes(rule.pathIncludes)) continue;
      if (!rule.resourceTypes.includes(node.cfnResourceType)) continue;
      suppressCheckovChecks(node, rule.skips);
    }
  }
}
