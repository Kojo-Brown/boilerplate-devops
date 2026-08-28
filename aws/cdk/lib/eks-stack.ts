import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { KubectlV33Layer } from '@aws-cdk/lambda-layer-kubectl-v33';
import { Construct } from 'constructs';
import { EksProviderCheckovSuppressions } from './checkov-suppressions';

/**
 * Kubernetes minor version this stack provisions by default.
 *
 * The kubectl binary shipped to the CDK kubectl handler has to track it: the
 * supported skew is one minor version either side, so the default version and
 * {@link KubectlV33Layer} are a matched pair and are overridden as a pair. See
 * `kubernetesVersion` on {@link EksStackProps}.
 */
const DEFAULT_KUBERNETES_VERSION = eks.KubernetesVersion.V1_33;

/** Namespace the EKS-managed add-ons and their service accounts live in. */
const KUBE_SYSTEM = 'kube-system';

/**
 * Helm chart version for the Cluster Autoscaler.
 *
 * The chart's `appVersion` is the autoscaler release it installs, and that
 * release tracks the Kubernetes minor version: chart 9.51.0 ships autoscaler
 * v1.33.0, which is the last 1.33 line and matches
 * {@link DEFAULT_KUBERNETES_VERSION}. Cluster Autoscaler is explicitly not
 * version-skew tolerant — it reads scheduler internals to decide whether a
 * pending pod would fit a hypothetical node — so overriding the cluster version
 * means overriding this too, the same way `kubectlLayer` has to move with it.
 */
const DEFAULT_CLUSTER_AUTOSCALER_CHART_VERSION = '9.51.0';

/** Service account the Cluster Autoscaler chart runs under, in {@link KUBE_SYSTEM}. */
const CLUSTER_AUTOSCALER_SERVICE_ACCOUNT = 'cluster-autoscaler';

/**
 * A Go duration string, which is what every Cluster Autoscaler flag that takes a
 * time expects. Seconds are always valid and always unambiguous —
 * `Duration.toIsoString()` is not, and a bare number is read as nanoseconds.
 */
const goDuration = (duration: cdk.Duration): string => `${duration.toSeconds()}s`;

/** Root device name for the Amazon Linux 2023 EKS-optimised AMI family. */
const AL2023_ROOT_DEVICE = '/dev/xvda';

/** Options for {@link EksStack.addIrsaRole}. */
export interface IrsaRoleOptions {
  /** Kubernetes namespace of the service account that will assume the role */
  readonly namespace: string;
  /** Name of the Kubernetes service account that will assume the role */
  readonly serviceAccountName: string;
  /** Description recorded on the IAM role */
  readonly description?: string;
  /** Explicit IAM role name (default: CloudFormation-generated) */
  readonly roleName?: string;
  /** AWS-managed or customer-managed policies to attach */
  readonly managedPolicies?: iam.IManagedPolicy[];
  /** Statements added to an inline policy on the role */
  readonly inlinePolicyStatements?: iam.PolicyStatement[];
  /** Maximum STS session duration (default: 1 hour) */
  readonly maxSessionDuration?: cdk.Duration;
}

/** Options for {@link EksStack.addManagedNodeGroup}. */
export interface ManagedNodeGroupOptions {
  /** Node group name (default: `<envName>-<construct id, lowercased>`) */
  readonly nodegroupName?: string;
  /** Instance types the group may launch (default: m6i.large) */
  readonly instanceTypes?: ec2.InstanceType[];
  /** AMI family (default: AL2023 x86-64 standard) */
  readonly amiType?: eks.NodegroupAmiType;
  /** Root EBS volume size in GiB (default: 50) */
  readonly diskSizeGiB?: number;
  /** Minimum node count (default: 2) */
  readonly minSize?: number;
  /** Maximum node count (default: 6) */
  readonly maxSize?: number;
  /** Initial node count (default: minSize) */
  readonly desiredSize?: number;
  /** ON_DEMAND or SPOT (default: ON_DEMAND) */
  readonly capacityType?: eks.CapacityType;
  /** Kubernetes labels applied to every node in the group */
  readonly labels?: Record<string, string>;
  /** Kubernetes taints applied to every node in the group */
  readonly taints?: eks.TaintSpec[];
  /** Percentage of the group EKS may take down at once during an upgrade (default: 25) */
  readonly maxUnavailablePercentage?: number;
}

/**
 * Options for the Cluster Autoscaler installed by {@link EksStack}.
 *
 * The defaults are the ones derived in `docs/autoscaling.md` §4 — every one of
 * them is a trade between paying for idle nodes and making a pod wait for one,
 * and the shape of that trade is what the numbers encode.
 */
export interface ClusterAutoscalerOptions {
  /** Install it at all (default: true) */
  readonly enabled?: boolean;
  /**
   * Helm chart version, which selects the autoscaler release through the
   * chart's `appVersion` (default: {@link DEFAULT_CLUSTER_AUTOSCALER_CHART_VERSION},
   * whose autoscaler matches {@link DEFAULT_KUBERNETES_VERSION}).
   */
  readonly chartVersion?: string;
  /**
   * Which node group to grow when more than one could take the pending pod
   * (default: `least-waste`, the group that leaves the least idle CPU and
   * memory after the pod lands). Only meaningful with several node groups.
   */
  readonly expander?: 'least-waste' | 'most-pods' | 'priority' | 'random';
  /**
   * How long a node must look removable before it is removed (default: 10 min).
   *
   * This is the whole of the scale-down hysteresis. Shorter reclaims cost
   * sooner and thrashes on traffic that comes back; longer pays for nodes that
   * are genuinely idle.
   */
  readonly scaleDownUnneededTime?: cdk.Duration;
  /**
   * Quiet period after any scale-up before scale-down is considered again
   * (default: 10 min). Without it a burst that adds a node can be followed
   * straight away by a decision to remove a different one.
   */
  readonly scaleDownDelayAfterAdd?: cdk.Duration;
  /**
   * Fraction of a node's requested-to-allocatable ratio below which it counts
   * as under-used (default: 0.5).
   *
   * Requests, not usage: the autoscaler has to simulate the scheduler, and the
   * scheduler packs on requests. A fleet whose requests are far above its real
   * usage never scales down however idle it looks in a dashboard.
   */
  readonly scaleDownUtilizationThreshold?: number;
  /**
   * How long a node may take to join before the autoscaler gives up on it and
   * retries elsewhere (default: 15 min).
   */
  readonly maxNodeProvisionTime?: cdk.Duration;
}

export interface EksStackProps extends cdk.StackProps {
  /** VPC from VpcStack (required) — nodes and the kubectl handler run in its private subnets */
  readonly vpc: ec2.IVpc;
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /**
   * Kubernetes control plane version.
   *
   * Overriding this requires passing a matching `kubectlLayer`; the stack
   * refuses to synthesize otherwise rather than deploying a handler whose
   * kubectl is too far from the control plane to talk to it.
   */
  readonly kubernetesVersion?: eks.KubernetesVersion;
  /** Lambda layer carrying the `kubectl`/`helm` binaries used by the CDK handler */
  readonly kubectlLayer?: lambda.ILayerVersion;
  /**
   * CIDRs allowed to reach the public API server endpoint.
   *
   * Left unset the endpoint is private-only and reachable from inside the VPC
   * (or a peered network) alone. Supplying CIDRs opens the public endpoint to
   * exactly those ranges. `0.0.0.0/0` is rejected — an unrestricted public API
   * server is what every EKS hardening guide, and the Checkov gate in CI, calls
   * out first.
   */
  readonly publicApiAccessCidrs?: string[];
  /** IAM role ARNs granted cluster-admin through an EKS access entry */
  readonly clusterAdminRoleArns?: string[];
  /** KMS key for envelope-encrypting Kubernetes secrets (default: a new rotating key) */
  readonly secretsEncryptionKey?: kms.IKey;
  /** Control-plane log types shipped to CloudWatch (default: all five) */
  readonly clusterLogging?: eks.ClusterLoggingTypes[];
  /** Overrides for the system node group created with the cluster */
  readonly systemNodeGroup?: ManagedNodeGroupOptions;
  /** Cluster Autoscaler configuration (default: installed, with the thresholds in docs/autoscaling.md) */
  readonly clusterAutoscaler?: ClusterAutoscalerOptions;
  /**
   * Attach `AmazonSSMManagedInstanceCore` to the node role so operators can
   * open a Session Manager shell on a node (default: false — nodes are cattle,
   * and the policy is broader than most clusters need).
   */
  readonly enableSsmAccess?: boolean;
  /** CloudWatch retention for control-plane logs is managed by EKS, not CDK; see docs/eks.md */
}

/**
 * EKS cluster with managed node groups and IRSA (IAM Roles for Service Accounts).
 *
 * Architecture:
 *   Control plane  — EKS-managed, private API endpoint by default
 *   Data plane     — managed node groups in the VPC private subnets
 *   Add-ons        — vpc-cni, kube-proxy, coredns, aws-ebs-csi-driver, all
 *                    EKS-managed so their versions track the cluster version
 *   Identity       — an OIDC provider fronting the cluster's issuer, so a pod's
 *                    service account token is exchanged for scoped AWS
 *                    credentials instead of borrowing the node's role
 *   Node scaling   — the Cluster Autoscaler, IRSA-authorised and discovering
 *                    node groups by ASG tag. It is the second half of the
 *                    scaling story: the chart's HPA adds pods, and pods that do
 *                    not fit stay Pending until something adds a node. See
 *                    docs/autoscaling.md.
 *
 * Security defaults:
 *   - API server endpoint is private; `publicApiAccessCidrs` opens it to an
 *     explicit allowlist and never to 0.0.0.0/0
 *   - Kubernetes secrets envelope-encrypted with a customer-managed KMS key
 *   - All five control-plane log types enabled
 *   - Nodes require IMDSv2 with a hop limit of 1, so a compromised pod cannot
 *     reach the instance metadata service and mint node-role credentials —
 *     which is the reason IRSA exists, and is defeated by the default hop
 *     limit of 2
 *   - The node role deliberately omits `AmazonEKS_CNI_Policy`: the VPC CNI
 *     gets those permissions through IRSA instead, so ENI manipulation is not
 *     granted to every pod that reaches the node role
 *   - The VPC CNI runs with `enableNetworkPolicy`, so NetworkPolicy objects are
 *     enforced rather than merely stored. Kubernetes has no built-in policy
 *     controller: without this the `app` chart's default-deny policy is
 *     accepted by the API server, visible in `kubectl get netpol`, and inert
 *   - Root volumes are gp3 and encrypted
 *
 * Node groups are created through {@link addManagedNodeGroup}, which attaches a
 * launch template carrying those metadata and volume settings — a node group
 * without one inherits the AWS defaults, IMDSv2 optional included.
 */
export class EksStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;
  /** Shared IAM role assumed by every node in every group of this cluster */
  public readonly nodeRole: iam.Role;
  /** Node group created alongside the cluster to host system workloads */
  public readonly systemNodeGroup: eks.Nodegroup;
  /** KMS key envelope-encrypting Kubernetes secrets */
  public readonly secretsKey: kms.IKey;
  /** IRSA role the Cluster Autoscaler assumes; `undefined` when it is disabled */
  public readonly clusterAutoscalerRole?: iam.Role;

  private readonly envName: string;

  constructor(scope: Construct, id: string, props: EksStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    this.envName = envName;

    const kubernetesVersion = props.kubernetesVersion ?? DEFAULT_KUBERNETES_VERSION;

    if (props.kubernetesVersion && !props.kubectlLayer) {
      throw new Error(
        'EksStack: kubernetesVersion was overridden without a matching kubectlLayer. ' +
          'Install the @aws-cdk/lambda-layer-kubectl-vXX package for that Kubernetes ' +
          'minor version and pass its layer, so the kubectl handler stays within one ' +
          'minor version of the control plane.',
      );
    }

    const publicApiAccessCidrs = props.publicApiAccessCidrs ?? [];

    if (publicApiAccessCidrs.some((cidr) => cidr === '0.0.0.0/0' || cidr === '::/0')) {
      throw new Error(
        'EksStack: publicApiAccessCidrs may not contain an open CIDR. Leave the ' +
          'property unset for a private-only endpoint, or list the office/VPN ranges ' +
          'that need to reach the API server.',
      );
    }

    // ── Secrets encryption key ────────────────────────────────────────────────
    // EKS encrypts etcd at rest with an AWS-owned key regardless; this adds
    // envelope encryption for Secret objects specifically, which is the layer
    // that survives a control-plane read by anything other than the API server.
    this.secretsKey =
      props.secretsEncryptionKey ??
      new kms.Key(this, 'SecretsKey', {
        alias: `alias/${envName}-eks-secrets`,
        description: `Envelope encryption for Kubernetes secrets in the ${envName} EKS cluster`,
        enableKeyRotation: true,
        removalPolicy:
          envName === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });

    // ── Cluster ───────────────────────────────────────────────────────────────
    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: `${envName}-eks`,
      version: kubernetesVersion,
      kubectlLayer: props.kubectlLayer ?? new KubectlV33Layer(this, 'KubectlLayer'),
      vpc: props.vpc,
      // Both the nodes and the CDK kubectl handler stay off the public subnets.
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      // The cluster handler creates and updates the control plane itself. In the
      // VPC its calls leave through the NAT gateway, so the EKS API only ever
      // sees a known egress address.
      placeClusterHandlerInVpc: true,
      // Capacity is added below through a launch template; the built-in default
      // node group cannot carry one.
      defaultCapacity: 0,
      endpointAccess:
        publicApiAccessCidrs.length > 0
          ? eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom(...publicApiAccessCidrs)
          : eks.EndpointAccess.PRIVATE,
      secretsEncryptionKey: this.secretsKey,
      clusterLogging: props.clusterLogging ?? [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
        eks.ClusterLoggingTypes.CONTROLLER_MANAGER,
        eks.ClusterLoggingTypes.SCHEDULER,
      ],
      // Access entries are the current way to map IAM principals into the
      // cluster. CONFIG_MAP stays enabled because add-ons and older tooling
      // still read aws-auth, and the switch to API-only is one-way.
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
      tags: { Environment: envName, ManagedBy: 'CDK' },
    });

    // ── Node role ─────────────────────────────────────────────────────────────
    // Shared by every node group. `AmazonEKS_CNI_Policy` is absent on purpose —
    // see the class docstring; the VPC CNI add-on holds it through IRSA.
    this.nodeRole = new iam.Role(this, 'NodeRole', {
      roleName: `${envName}-eks-node-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: `EC2 role for ${envName} EKS managed node groups`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        ...(props.enableSsmAccess
          ? [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')]
          : []),
      ],
    });

    // ── System node group ─────────────────────────────────────────────────────
    this.systemNodeGroup = this.addManagedNodeGroup('SystemNodeGroup', {
      nodegroupName: `${envName}-system`,
      labels: { 'workload-type': 'system' },
      ...props.systemNodeGroup,
    });

    // ── Add-ons ───────────────────────────────────────────────────────────────
    // All four are declared with the L1 construct because `eks.Addon` exposes
    // neither `serviceAccountRoleArn` (IRSA, required by vpc-cni and the EBS CSI
    // driver) nor `resolveConflicts` — and EKS pre-installs vpc-cni, kube-proxy
    // and coredns as self-managed, so adopting them as managed add-ons is an
    // overwrite of resources CloudFormation did not create.
    //
    // No add-on pins `addonVersion`: EKS then installs the default version for
    // the cluster's Kubernetes version, which is the version that moves with the
    // control plane on upgrade instead of drifting behind a literal in git.

    const vpcCniRole = this.addIrsaRole('VpcCniRole', {
      namespace: KUBE_SYSTEM,
      serviceAccountName: 'aws-node',
      description: `VPC CNI (aws-node) for the ${envName} EKS cluster`,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy')],
    });

    const vpcCni = new eks.CfnAddon(this, 'VpcCniAddon', {
      addonName: 'vpc-cni',
      clusterName: this.cluster.clusterName,
      serviceAccountRoleArn: vpcCniRole.roleArn,
      resolveConflicts: 'OVERWRITE',
      // NetworkPolicy enforcement, and it is off unless this says otherwise.
      //
      // Kubernetes ships no NetworkPolicy controller. The API server validates
      // and stores the objects whatever the cluster does with them, so on a CNI
      // that does not implement policy a default-deny policy is accepted,
      // appears in `kubectl get networkpolicy`, describes correctly, and
      // enforces nothing. There is no status field, no event, and no way to
      // tell the two apart from the cluster — which makes this the one add-on
      // setting whose absence looks exactly like a working security control.
      //
      // Turning it on starts the network policy agent in the aws-node
      // DaemonSet, which compiles policies to eBPF programs on each node. It
      // needs no additional IAM: the agent watches policy objects through the
      // Kubernetes API, not through AWS. Policy decisions are logged on the
      // node at /var/log/aws-routed-eni/network-policy-agent.log; shipping them
      // to CloudWatch is a further `nodeAgent` setting and does need
      // permissions on the node role, so it is left to the operator — see
      // docs/network-policies.md §5.
      //
      // The value is the string "true", not a boolean: the add-on's
      // configuration schema types it as a string, and a JSON boolean is
      // rejected by the EKS API at deploy time.
      configurationValues: JSON.stringify({ enableNetworkPolicy: 'true' }),
    });

    const kubeProxy = new eks.CfnAddon(this, 'KubeProxyAddon', {
      addonName: 'kube-proxy',
      clusterName: this.cluster.clusterName,
      resolveConflicts: 'OVERWRITE',
    });

    const coreDns = new eks.CfnAddon(this, 'CoreDnsAddon', {
      addonName: 'coredns',
      clusterName: this.cluster.clusterName,
      resolveConflicts: 'OVERWRITE',
    });

    const ebsCsiRole = this.addIrsaRole('EbsCsiDriverRole', {
      namespace: KUBE_SYSTEM,
      serviceAccountName: 'ebs-csi-controller-sa',
      description: `EBS CSI driver for the ${envName} EKS cluster`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEBSCSIDriverPolicy'),
      ],
    });

    const ebsCsi = new eks.CfnAddon(this, 'EbsCsiDriverAddon', {
      addonName: 'aws-ebs-csi-driver',
      clusterName: this.cluster.clusterName,
      serviceAccountRoleArn: ebsCsiRole.roleArn,
      resolveConflicts: 'OVERWRITE',
    });

    // vpc-cni and kube-proxy run as DaemonSets and tolerate an empty cluster;
    // coredns and the CSI controller are Deployments, and an add-on whose pods
    // cannot schedule reports DEGRADED, which fails the CloudFormation update.
    coreDns.node.addDependency(this.systemNodeGroup);
    ebsCsi.node.addDependency(this.systemNodeGroup);

    // The CNI configuration is what every other pod's networking depends on, so
    // adopt it before nodes join rather than reconfiguring a running data plane.
    this.systemNodeGroup.node.addDependency(vpcCni, kubeProxy);

    // ── Cluster Autoscaler ────────────────────────────────────────────────────
    const clusterAutoscaler = props.clusterAutoscaler ?? {};

    if (clusterAutoscaler.enabled ?? true) {
      this.clusterAutoscalerRole = this.addClusterAutoscaler(clusterAutoscaler);
    }

    // ── Cluster access ────────────────────────────────────────────────────────
    for (const [index, roleArn] of (props.clusterAdminRoleArns ?? []).entries()) {
      this.cluster.grantAccess(`ClusterAdminAccess${index}`, roleArn, [
        eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
          accessScopeType: eks.AccessScopeType.CLUSTER,
        }),
      ]);
    }

    // ── Checkov suppressions for CDK-generated deployment machinery ───────────
    // Scoped to the CDK EKS module's own handlers; see checkov-suppressions.ts
    // for what each one waives and why.
    cdk.Aspects.of(this).add(new EksProviderCheckovSuppressions());

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'EKS cluster name',
      exportName: `${envName}-eks-cluster-name`,
    });

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.cluster.clusterArn,
      description: 'EKS cluster ARN',
      exportName: `${envName}-eks-cluster-arn`,
    });

    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: this.cluster.clusterEndpoint,
      description: 'EKS API server endpoint',
      exportName: `${envName}-eks-cluster-endpoint`,
    });

    new cdk.CfnOutput(this, 'OidcProviderArn', {
      value: this.cluster.openIdConnectProvider.openIdConnectProviderArn,
      description: 'IAM OIDC provider backing IRSA for this cluster',
      exportName: `${envName}-eks-oidc-provider-arn`,
    });

    new cdk.CfnOutput(this, 'OidcIssuerUrl', {
      value: this.cluster.clusterOpenIdConnectIssuerUrl,
      description: 'Cluster OIDC issuer URL',
      exportName: `${envName}-eks-oidc-issuer-url`,
    });

    new cdk.CfnOutput(this, 'NodeRoleArn', {
      value: this.nodeRole.roleArn,
      description: 'IAM role assumed by managed node group instances',
      exportName: `${envName}-eks-node-role-arn`,
    });

    new cdk.CfnOutput(this, 'ClusterSecurityGroupId', {
      value: this.cluster.clusterSecurityGroupId,
      description: 'EKS-managed cluster security group (control plane ↔ nodes)',
      exportName: `${envName}-eks-cluster-security-group-id`,
    });

    if (this.clusterAutoscalerRole) {
      new cdk.CfnOutput(this, 'ClusterAutoscalerRoleArn', {
        value: this.clusterAutoscalerRole.roleArn,
        description: 'IRSA role assumed by the Cluster Autoscaler',
        exportName: `${envName}-eks-cluster-autoscaler-role-arn`,
      });
    }
  }

  /**
   * Install the Cluster Autoscaler: an IRSA role, and the upstream Helm chart
   * configured to discover this cluster's node groups by ASG tag.
   *
   * **Why auto-discovery rather than named groups.** The alternative is
   * `autoscalingGroups: [{name, minSize, maxSize}]`, which needs the ASG's
   * name — and EKS, not CloudFormation, creates the ASG behind a managed node
   * group, so the name does not exist at synth time. Auto-discovery matches on
   * two tags instead, `k8s.io/cluster-autoscaler/enabled` and
   * `k8s.io/cluster-autoscaler/<cluster>`, both of which EKS applies to the ASGs
   * it creates for managed node groups. Nothing here has to tag anything; a
   * *self-managed* ASG added later does, and will be invisible to the
   * autoscaler until it is tagged.
   *
   * **Where the bounds come from.** Not from this chart. The autoscaler never
   * moves a group outside the ASG's own min and max, which are the `minSize` and
   * `maxSize` on {@link addManagedNodeGroup}. That is the ceiling an HPA's
   * `maxReplicas` has to fit inside — past it, scaling up produces Pending pods
   * and an HPA that reports success. docs/autoscaling.md §3 does that
   * arithmetic for the shipped environments.
   *
   * **What it will not remove.** By default the autoscaler leaves alone any
   * node running a kube-system pod that is not part of a DaemonSet
   * (`--skip-nodes-with-system-pods`, left at its default), and any node running
   * a pod with local storage. With a single node group hosting CoreDNS and the
   * EBS CSI controller, that pins a couple of nodes above the group's minimum.
   * Both defaults are kept: the alternative is an autoscaler that evicts CoreDNS
   * to save a node.
   */
  private addClusterAutoscaler(options: ClusterAutoscalerOptions): iam.Role {
    const clusterName = this.cluster.clusterName;

    // The cluster name is a `Ref`, so the condition *key* is only known at
    // deploy time. A plain object literal stringifies the token into the
    // template as `aws:ResourceTag/k8s.io/cluster-autoscaler/${Token[...]}`;
    // CfnJson defers the whole map to resolution, the same way the IRSA trust
    // conditions in `addIrsaRole` do.
    const ownedByThisCluster = new cdk.CfnJson(this, 'ClusterAutoscalerTagCondition', {
      value: { [`aws:ResourceTag/k8s.io/cluster-autoscaler/${clusterName}`]: 'owned' },
    });

    const role = this.addIrsaRole('ClusterAutoscalerRole', {
      namespace: KUBE_SYSTEM,
      serviceAccountName: CLUSTER_AUTOSCALER_SERVICE_ACCOUNT,
      description: `Cluster Autoscaler for the ${this.envName} EKS cluster`,
      inlinePolicyStatements: [
        new iam.PolicyStatement({
          sid: 'DiscoverScalableCapacity',
          // Documented wildcard, per CLAUDE.md. Every action here is a
          // read, and none of them supports resource-level permissions —
          // `autoscaling:DescribeAutoScalingGroups` with a resource ARN
          // returns an access denied for every group, including the ones the
          // ARN names. The autoscaler also has to see groups it does not
          // manage: its decision is "would this pending pod fit anywhere",
          // which it cannot answer from a filtered view of the account.
          actions: [
            'autoscaling:DescribeAutoScalingGroups',
            'autoscaling:DescribeAutoScalingInstances',
            'autoscaling:DescribeLaunchConfigurations',
            'autoscaling:DescribeScalingActivities',
            'autoscaling:DescribeTags',
            'ec2:DescribeImages',
            'ec2:DescribeInstanceTypes',
            'ec2:DescribeLaunchTemplateVersions',
            'ec2:GetInstanceTypesFromInstanceRequirements',
            'eks:DescribeNodegroup',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'ScaleTaggedNodeGroups',
          // The two actions that change anything, and the only ones scoped.
          // The resource pattern cannot name a group — see the method
          // docstring — so the tag condition is what actually bounds this:
          // without it, the role could resize every Auto Scaling group in the
          // account, including another cluster's.
          actions: [
            'autoscaling:SetDesiredCapacity',
            'autoscaling:TerminateInstanceInAutoScalingGroup',
          ],
          resources: [
            `arn:${this.partition}:autoscaling:${this.region}:${this.account}:autoScalingGroup:*:autoScalingGroupName/*`,
          ],
          conditions: { StringEquals: ownedByThisCluster },
        }),
      ],
    });

    const chart = this.cluster.addHelmChart('ClusterAutoscaler', {
      chart: 'cluster-autoscaler',
      repository: 'https://kubernetes.github.io/autoscaler',
      release: CLUSTER_AUTOSCALER_SERVICE_ACCOUNT,
      namespace: KUBE_SYSTEM,
      version: options.chartVersion ?? DEFAULT_CLUSTER_AUTOSCALER_CHART_VERSION,
      // `wait` turns a chart that installs but never becomes ready into a failed
      // stack update instead of a green deploy with no autoscaler running.
      wait: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        cloudProvider: 'aws',
        awsRegion: this.region,
        autoDiscovery: { clusterName },
        rbac: {
          serviceAccount: {
            create: true,
            name: CLUSTER_AUTOSCALER_SERVICE_ACCOUNT,
            // The other half of IRSA. The trust policy above names
            // `kube-system:cluster-autoscaler`; this names the role from the
            // Kubernetes side, and the two have to agree or every AWS call the
            // autoscaler makes fails with an access denied that looks like a
            // policy problem.
            annotations: { 'eks.amazonaws.com/role-arn': role.roleArn },
          },
        },
        extraArgs: {
          expander: options.expander ?? 'least-waste',
          // Keeps groups that are interchangeable at similar sizes, which is
          // what makes a multi-AZ fleet stay multi-AZ under scale-up.
          'balance-similar-node-groups': true,
          'scale-down-utilization-threshold': options.scaleDownUtilizationThreshold ?? 0.5,
          'scale-down-unneeded-time': goDuration(
            options.scaleDownUnneededTime ?? cdk.Duration.minutes(10),
          ),
          'scale-down-delay-after-add': goDuration(
            options.scaleDownDelayAfterAdd ?? cdk.Duration.minutes(10),
          ),
          'max-node-provision-time': goDuration(
            options.maxNodeProvisionTime ?? cdk.Duration.minutes(15),
          ),
          // Explicit rather than inherited: a node with an emptyDir or a
          // hostPath is left alone, because removing it destroys data the pod
          // believes is still there. It is also the flag most often flipped by
          // someone chasing a node that will not go away, so it is written down
          // here with the reason attached.
          'skip-nodes-with-local-storage': true,
          // The chart defaults to v=4, which logs a scheduler simulation per
          // scan interval.
          v: 2,
        },
        // Without this the autoscaler can evict itself while draining a node it
        // has just decided to remove, and the decision dies with the pod.
        podAnnotations: { 'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false' },
        priorityClassName: 'system-cluster-critical',
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 65534,
          runAsGroup: 65534,
          fsGroup: 65534,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containerSecurityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
        // Memory equal to its request: the autoscaler holds a model of every
        // node and pending pod, so its footprint grows with the cluster and a
        // BestEffort autoscaler is evicted by exactly the node pressure it
        // exists to resolve.
        resources: {
          requests: { cpu: '100m', memory: '300Mi' },
          limits: { memory: '300Mi' },
        },
      },
    });

    // The chart is a Deployment, and a Deployment that cannot schedule leaves
    // `wait: true` hanging until the timeout.
    chart.node.addDependency(this.systemNodeGroup);

    return role;
  }

  /**
   * Add a managed node group whose instances launch from a hardened launch
   * template: IMDSv2 required at a hop limit of 1, and an encrypted gp3 root
   * volume.
   *
   * The disk size lives in the launch template rather than on the node group —
   * EKS rejects a node group that sets both.
   */
  public addManagedNodeGroup(id: string, options: ManagedNodeGroupOptions = {}): eks.Nodegroup {
    const nodegroupName = options.nodegroupName ?? `${this.envName}-${id.toLowerCase()}`;
    const minSize = options.minSize ?? 2;
    const maxSize = options.maxSize ?? 6;

    const launchTemplate = new ec2.LaunchTemplate(this, `${id}LaunchTemplate`, {
      launchTemplateName: `${nodegroupName}-lt`,
      versionDescription: `Hardened node template for ${nodegroupName}`,
      // Session tokens only, and one hop: the kubelet on the host can read
      // instance metadata, a pod in its own network namespace cannot.
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
      httpPutResponseHopLimit: 1,
      httpEndpoint: true,
      blockDevices: [
        {
          deviceName: AL2023_ROOT_DEVICE,
          volume: ec2.BlockDeviceVolume.ebs(options.diskSizeGiB ?? 50, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
      // Neither an AMI nor user data is set: supplying either turns this into a
      // custom-AMI node group, where EKS stops injecting the bootstrap script
      // and the nodes never join.
    });

    return this.cluster.addNodegroupCapacity(id, {
      nodegroupName,
      instanceTypes: options.instanceTypes ?? [new ec2.InstanceType('m6i.large')],
      amiType: options.amiType ?? eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minSize,
      maxSize,
      desiredSize: options.desiredSize ?? minSize,
      capacityType: options.capacityType ?? eks.CapacityType.ON_DEMAND,
      nodeRole: this.nodeRole,
      labels: options.labels,
      taints: options.taints,
      maxUnavailablePercentage: options.maxUnavailablePercentage ?? 25,
      launchTemplateSpec: {
        id: launchTemplate.launchTemplateId!,
        version: launchTemplate.latestVersionNumber,
      },
      tags: { Environment: this.envName, ManagedBy: 'CDK' },
    });
  }

  /**
   * Create an IAM role a Kubernetes service account can assume through IRSA.
   *
   * The trust policy is scoped to one `namespace/serviceaccount` pair and to the
   * `sts.amazonaws.com` audience. Both conditions matter: without the `sub`
   * condition every service account in the cluster can assume the role, and
   * without `aud` a token minted for a different audience is accepted.
   *
   * Use this for service accounts something else creates — an EKS add-on, a Helm
   * chart, an ArgoCD application. For a service account CDK should create in the
   * cluster itself, `cluster.addServiceAccount()` does both halves at once.
   */
  public addIrsaRole(id: string, options: IrsaRoleOptions): iam.Role {
    const issuer = this.cluster.clusterOpenIdConnectIssuer;

    // The issuer is only known at deploy time, so the condition keys are tokens.
    // A plain object literal would stringify them into the template as
    // `${Token[...]}:sub`; CfnJson defers the whole map to resolution time.
    const conditions = new cdk.CfnJson(this, `${id}TrustConditions`, {
      value: {
        [`${issuer}:aud`]: 'sts.amazonaws.com',
        [`${issuer}:sub`]: `system:serviceaccount:${options.namespace}:${options.serviceAccountName}`,
      },
    });

    const role = new iam.Role(this, id, {
      roleName: options.roleName,
      description:
        options.description ??
        `IRSA role for ${options.namespace}/${options.serviceAccountName}`,
      maxSessionDuration: options.maxSessionDuration,
      managedPolicies: options.managedPolicies,
      assumedBy: new iam.FederatedPrincipal(
        this.cluster.openIdConnectProvider.openIdConnectProviderArn,
        { StringEquals: conditions },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    for (const statement of options.inlinePolicyStatements ?? []) {
      role.addToPolicy(statement);
    }

    return role;
  }
}
