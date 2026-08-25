import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { EksStack, EksStackProps } from '../lib/eks-stack';
import { VpcStack } from '../lib/vpc-stack';
import {
  TOKEN,
  flattenIntrinsic,
  managedPolicyArns,
  outputByExportName,
  resourceProps,
} from './support/cfn';

const ENV = { account: '123456789012', region: 'us-east-1' };

/**
 * The cluster is a `Custom::AWSCDK-EKS-Cluster`, not `AWS::EKS::Cluster`: CDK
 * drives cluster creation through its own resource handler so that properties
 * CloudFormation cannot change in place (endpoint access, logging, access
 * config) can be updated without replacing the cluster. Everything the API
 * receives sits under `Config`.
 */
const clusterConfig = (template: Template): Record<string, any> => {
  const [cluster] = resourceProps(template, 'Custom::AWSCDK-EKS-Cluster');
  return cluster.Config as Record<string, any>;
};

const roleByDescription = (template: Template, description: string): Record<string, any> =>
  resourceProps(template, 'AWS::IAM::Role').find((role) => role.Description === description) ??
  (() => {
    throw new Error(`no IAM role described as "${description}"`);
  })();

const addonByName = (template: Template, addonName: string): Record<string, any> =>
  resourceProps(template, 'AWS::EKS::Addon').find((addon) => addon.AddonName === addonName) ??
  (() => {
    throw new Error(`no EKS add-on named "${addonName}"`);
  })();

const nodegroupByName = (template: Template, nodegroupName: string): Record<string, any> =>
  resourceProps(template, 'AWS::EKS::Nodegroup').find(
    (group) => group.NodegroupName === nodegroupName,
  ) ??
  (() => {
    throw new Error(`no node group named "${nodegroupName}"`);
  })();

const helmChartByRelease = (template: Template, release: string): Record<string, any> =>
  resourceProps(template, 'Custom::AWSCDK-EKS-HelmChart').find(
    (chart) => chart.Release === release,
  ) ??
  (() => {
    throw new Error(`no Helm chart released as "${release}"`);
  })();

/**
 * A Helm release's values, as one JSON string.
 *
 * CDK serialises the values map to JSON and then splices the deploy-time tokens
 * back in, so the template holds an `Fn::Join` of JSON fragments rather than a
 * structure. Flattening it produces the JSON a reader would expect, with each
 * unresolved token replaced by a placeholder — which is why the assertions below
 * match on fragments such as `"name":"cluster-autoscaler"` and not on parsed
 * objects.
 */
const helmValues = (template: Template, release: string): string =>
  flattenIntrinsic(helmChartByRelease(template, release).Values);

/** The inline policy carrying the Cluster Autoscaler's statements. */
const clusterAutoscalerPolicy = (template: Template): Record<string, any>[] =>
  resourceProps(template, 'AWS::IAM::Policy')
    .map((policy) => (policy.PolicyDocument as any).Statement as Record<string, any>[])
    .find((statements) =>
      statements.some((statement) => statement.Sid === 'DiscoverScalableCapacity'),
    ) ??
  (() => {
    throw new Error('no IAM policy carrying the Cluster Autoscaler statements');
  })();

const statementBySid = (
  statements: Record<string, any>[],
  sid: string,
): Record<string, any> =>
  statements.find((statement) => statement.Sid === sid) ??
  (() => {
    throw new Error(`no statement with Sid "${sid}"`);
  })();

/**
 * Serialised form of a value, intrinsics included.
 *
 * Subnet IDs arrive as `Fn::ImportValue` of an export whose name carries the
 * producing stack's construct path — `...VpcPrivateSubnet1...`. That is the only
 * evidence in the consuming template of which subnets were selected, and
 * `flattenIntrinsic` collapses a non-Join intrinsic to a placeholder, so these
 * assertions read the raw JSON.
 */
const raw = (value: unknown): string => JSON.stringify(value);

const synthesize = (props?: Partial<EksStackProps>) => {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, 'TestVpcStack', { env: ENV, envName: 'staging' });
  const stack = new EksStack(app, 'TestEksStack', {
    env: ENV,
    envName: 'staging',
    vpc: vpcStack.vpc,
    ...props,
  });
  return { app, stack, template: Template.fromStack(stack) };
};

/**
 * Synthesising an EKS stack takes a second or so — the module bundles two Lambda
 * layers and two nested provider stacks — and most assertions here read the same
 * default configuration. The templates are immutable once synthesised, so the
 * default one is built once and shared; a call with props always synthesises
 * afresh.
 */
let defaultSynth: ReturnType<typeof synthesize> | undefined;

const makeStack = (props?: Partial<EksStackProps>) => {
  if (props) return synthesize(props);
  defaultSynth ??= synthesize();
  return defaultSynth;
};

describe('EksStack', () => {
  describe('Control plane', () => {
    it('creates exactly one cluster, named for the environment', () => {
      const { template } = makeStack();
      template.resourceCountIs('Custom::AWSCDK-EKS-Cluster', 1);
      expect(clusterConfig(template).name).toBe('staging-eks');
    });

    it('pins the Kubernetes version the bundled kubectl layer supports', () => {
      const { template } = makeStack();
      expect(clusterConfig(template).version).toBe('1.33');
    });

    it('keeps the API server endpoint private by default', () => {
      const { template } = makeStack();
      expect(clusterConfig(template).resourcesVpcConfig).toMatchObject({
        endpointPublicAccess: false,
        endpointPrivateAccess: true,
      });
    });

    it('opens the public endpoint only to the CIDRs it is given', () => {
      const { template } = makeStack({ publicApiAccessCidrs: ['203.0.113.0/24'] });
      expect(clusterConfig(template).resourcesVpcConfig).toMatchObject({
        endpointPublicAccess: true,
        endpointPrivateAccess: true,
        publicAccessCidrs: ['203.0.113.0/24'],
      });
    });

    it.each(['0.0.0.0/0', '::/0'])('refuses to open the endpoint to %s', (cidr) => {
      expect(() => makeStack({ publicApiAccessCidrs: [cidr] })).toThrow(
        /may not contain an open CIDR/,
      );
    });

    it('places the control plane in the private subnets', () => {
      const { template } = makeStack();
      const subnetIds = raw(clusterConfig(template).resourcesVpcConfig.subnetIds);
      expect(subnetIds).toContain('PrivateSubnet');
      expect(subnetIds).not.toContain('PublicSubnet');
    });

    it('enables all five control-plane log types', () => {
      const { template } = makeStack();
      expect(clusterConfig(template).logging.clusterLogging).toEqual([
        {
          enabled: true,
          types: ['api', 'audit', 'authenticator', 'controllerManager', 'scheduler'],
        },
      ]);
    });

    it('honours a narrowed logging selection', () => {
      const { template } = makeStack({ clusterLogging: [eks.ClusterLoggingTypes.AUDIT] });
      expect(clusterConfig(template).logging.clusterLogging).toEqual([
        { enabled: true, types: ['audit'] },
      ]);
    });

    it('envelope-encrypts Kubernetes secrets with a rotating customer-managed key', () => {
      const { template } = makeStack();

      expect(clusterConfig(template).encryptionConfig).toEqual([
        { provider: { keyArn: { 'Fn::GetAtt': ['SecretsKey317DCF94', 'Arn'] } } , resources: ['secrets'] },
      ]);
      template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
      template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: 'alias/staging-eks-secrets',
      });
    });

    it('reuses a supplied key instead of creating one', () => {
      const app = new cdk.App();
      const vpcStack = new VpcStack(app, 'KeyVpcStack', { env: ENV });
      const keyStack = new cdk.Stack(app, 'KeyStack', { env: ENV });
      const key = new kms.Key(keyStack, 'ExternalKey');
      const stack = new EksStack(app, 'KeyEksStack', {
        env: ENV,
        vpc: vpcStack.vpc,
        secretsEncryptionKey: key,
      });

      Template.fromStack(stack).resourceCountIs('AWS::KMS::Key', 0);
    });

    it('retains the secrets key in production and destroys it elsewhere', () => {
      const { template: staging } = makeStack({ envName: 'staging' });
      staging.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Delete' });

      const { template: production } = makeStack({ envName: 'production' });
      production.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
    });

    it('enables access entries alongside the aws-auth ConfigMap', () => {
      const { template } = makeStack();
      expect(clusterConfig(template).accessConfig).toEqual({
        authenticationMode: 'API_AND_CONFIG_MAP',
      });
    });

    it('grants cluster-admin to each supplied role through an access entry', () => {
      const { template } = makeStack({
        clusterAdminRoleArns: [
          'arn:aws:iam::123456789012:role/PlatformAdmin',
          'arn:aws:iam::123456789012:role/Sre',
        ],
      });

      template.resourceCountIs('AWS::EKS::AccessEntry', 2);
      template.hasResourceProperties('AWS::EKS::AccessEntry', {
        PrincipalArn: 'arn:aws:iam::123456789012:role/PlatformAdmin',
        AccessPolicies: [
          Match.objectLike({
            AccessScope: { Type: 'cluster' },
            PolicyArn: Match.anyValue(),
          }),
        ],
      });
    });

    it('creates no access entries when no admin roles are named', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::EKS::AccessEntry', 0);
    });

    it('rejects a Kubernetes version override with no matching kubectl layer', () => {
      expect(() => makeStack({ kubernetesVersion: eks.KubernetesVersion.V1_32 })).toThrow(
        /kubectlLayer/,
      );
    });

    it('accepts a version override when the layer is supplied with it', () => {
      const app = new cdk.App();
      const vpcStack = new VpcStack(app, 'V32VpcStack', { env: ENV });
      const stack = new EksStack(app, 'V32EksStack', {
        env: ENV,
        vpc: vpcStack.vpc,
        kubernetesVersion: eks.KubernetesVersion.V1_32,
        // Imported by ARN: the point under test is the version/layer pairing,
        // not which binaries the layer carries.
        kubectlLayer: lambda.LayerVersion.fromLayerVersionArn(
          vpcStack,
          'KubectlV32',
          'arn:aws:lambda:us-east-1:123456789012:layer:kubectl-v32:1',
        ),
      });

      expect(clusterConfig(Template.fromStack(stack)).version).toBe('1.32');
    });
  });

  describe('Node role', () => {
    it('carries the worker and ECR-read policies', () => {
      const { template } = makeStack();
      const arns = managedPolicyArns(
        roleByDescription(template, 'EC2 role for staging EKS managed node groups'),
      );

      expect(arns).toEqual([
        expect.stringContaining('AmazonEKSWorkerNodePolicy'),
        expect.stringContaining('AmazonEC2ContainerRegistryReadOnly'),
      ]);
    });

    it('does not carry AmazonEKS_CNI_Policy — the CNI holds it through IRSA', () => {
      const { template } = makeStack();
      const arns = managedPolicyArns(
        roleByDescription(template, 'EC2 role for staging EKS managed node groups'),
      );

      expect(arns.join(' ')).not.toContain('AmazonEKS_CNI_Policy');
      expect(
        managedPolicyArns(
          roleByDescription(template, 'VPC CNI (aws-node) for the staging EKS cluster'),
        ).join(' '),
      ).toContain('AmazonEKS_CNI_Policy');
    });

    it('adds Session Manager access only when asked', () => {
      const { template: without } = makeStack();
      expect(
        managedPolicyArns(
          roleByDescription(without, 'EC2 role for staging EKS managed node groups'),
        ).join(' '),
      ).not.toContain('AmazonSSMManagedInstanceCore');

      const { template: with_ } = makeStack({ enableSsmAccess: true });
      expect(
        managedPolicyArns(
          roleByDescription(with_, 'EC2 role for staging EKS managed node groups'),
        ).join(' '),
      ).toContain('AmazonSSMManagedInstanceCore');
    });

    it('is assumable by EC2 only', () => {
      const { template } = makeStack();
      const role = roleByDescription(template, 'EC2 role for staging EKS managed node groups');

      expect(role.AssumeRolePolicyDocument).toEqual({
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'ec2.amazonaws.com' },
          },
        ],
      });
    });
  });

  describe('Managed node groups', () => {
    it('creates the system node group in the private subnets', () => {
      const { template } = makeStack();
      const nodegroup = nodegroupByName(template, 'staging-system');

      expect(raw(nodegroup.Subnets)).toContain('PrivateSubnet');
      expect(raw(nodegroup.Subnets)).not.toContain('PublicSubnet');
    });

    it('defaults to on-demand AL2023 capacity with a rolling upgrade budget', () => {
      const { template } = makeStack();
      const nodegroup = nodegroupByName(template, 'staging-system');

      expect(nodegroup).toMatchObject({
        AmiType: 'AL2023_x86_64_STANDARD',
        CapacityType: 'ON_DEMAND',
        InstanceTypes: ['m6i.large'],
        ScalingConfig: { MinSize: 2, MaxSize: 6, DesiredSize: 2 },
        UpdateConfig: { MaxUnavailablePercentage: 25 },
        Labels: { 'workload-type': 'system' },
      });
    });

    it('applies node group overrides', () => {
      const { template } = makeStack({
        systemNodeGroup: {
          instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE)],
          minSize: 1,
          maxSize: 3,
          desiredSize: 2,
          maxUnavailablePercentage: 50,
        },
      });

      expect(nodegroupByName(template, 'staging-system')).toMatchObject({
        InstanceTypes: ['t3.large'],
        ScalingConfig: { MinSize: 1, MaxSize: 3, DesiredSize: 2 },
        UpdateConfig: { MaxUnavailablePercentage: 50 },
      });
    });

    it('launches nodes from a template that requires IMDSv2 at one hop', () => {
      const { template } = makeStack();
      const [launchTemplate] = resourceProps(template, 'AWS::EC2::LaunchTemplate');

      // Hop limit 1 is the point: IMDSv2 alone still answers a pod on the host
      // network, and the second hop is what a container in its own namespace
      // needs to reach 169.254.169.254.
      expect((launchTemplate.LaunchTemplateData as any).MetadataOptions).toEqual({
        HttpEndpoint: 'enabled',
        HttpTokens: 'required',
        HttpPutResponseHopLimit: 1,
      });
    });

    it('gives nodes an encrypted gp3 root volume', () => {
      const { template } = makeStack({ systemNodeGroup: { diskSizeGiB: 80 } });
      const [launchTemplate] = resourceProps(template, 'AWS::EC2::LaunchTemplate');

      expect((launchTemplate.LaunchTemplateData as any).BlockDeviceMappings).toEqual([
        {
          DeviceName: '/dev/xvda',
          Ebs: {
            DeleteOnTermination: true,
            Encrypted: true,
            VolumeSize: 80,
            VolumeType: 'gp3',
          },
        },
      ]);
    });

    it('sets no AMI or user data, so EKS keeps injecting its bootstrap', () => {
      const { template } = makeStack();
      const data = resourceProps(template, 'AWS::EC2::LaunchTemplate')[0]
        .LaunchTemplateData as Record<string, unknown>;

      expect(data.ImageId).toBeUndefined();
      expect(data.UserData).toBeUndefined();
    });

    it('never sets DiskSize on the node group — EKS rejects it beside a launch template', () => {
      const { template } = makeStack();
      expect(nodegroupByName(template, 'staging-system').DiskSize).toBeUndefined();
    });

    it('adds further node groups sharing the node role, each with its own template', () => {
      const app = new cdk.App();
      const vpcStack = new VpcStack(app, 'ExtraVpcStack', { env: ENV });
      const stack = new EksStack(app, 'ExtraEksStack', {
        env: ENV,
        envName: 'staging',
        vpc: vpcStack.vpc,
      });

      stack.addManagedNodeGroup('SpotWorkers', {
        capacityType: eks.CapacityType.SPOT,
        instanceTypes: [
          new ec2.InstanceType('m6i.large'),
          new ec2.InstanceType('m6a.large'),
        ],
        taints: [
          { effect: eks.TaintEffect.NO_SCHEDULE, key: 'workload-type', value: 'batch' },
        ],
        diskSizeGiB: 100,
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::EKS::Nodegroup', 2);
      template.resourceCountIs('AWS::EC2::LaunchTemplate', 2);

      const spot = nodegroupByName(template, 'staging-spotworkers');
      expect(spot).toMatchObject({
        CapacityType: 'SPOT',
        InstanceTypes: ['m6i.large', 'm6a.large'],
        Taints: [{ Effect: 'NO_SCHEDULE', Key: 'workload-type', Value: 'batch' }],
      });
      expect(raw(spot.NodeRole)).toContain('NodeRole');
    });
  });

  describe('Add-ons', () => {
    it('manages the four cluster add-ons', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::EKS::Addon', 4);

      expect(
        resourceProps(template, 'AWS::EKS::Addon')
          .map((addon) => addon.AddonName)
          .sort(),
      ).toEqual(['aws-ebs-csi-driver', 'coredns', 'kube-proxy', 'vpc-cni']);
    });

    it('adopts the add-ons EKS pre-installs as self-managed', () => {
      const { template } = makeStack();
      for (const addon of resourceProps(template, 'AWS::EKS::Addon')) {
        expect(addon.ResolveConflicts).toBe('OVERWRITE');
      }
    });

    it('pins no add-on version, so EKS tracks the cluster version', () => {
      const { template } = makeStack();
      for (const addon of resourceProps(template, 'AWS::EKS::Addon')) {
        expect(addon.AddonVersion).toBeUndefined();
      }
    });

    it('gives the CNI and the EBS CSI driver an IRSA role, and the others none', () => {
      const { template } = makeStack();

      expect(addonByName(template, 'vpc-cni').ServiceAccountRoleArn).toBeDefined();
      expect(addonByName(template, 'aws-ebs-csi-driver').ServiceAccountRoleArn).toBeDefined();
      expect(addonByName(template, 'kube-proxy').ServiceAccountRoleArn).toBeUndefined();
      expect(addonByName(template, 'coredns').ServiceAccountRoleArn).toBeUndefined();
    });

    it('scopes the EBS CSI role to the driver service account', () => {
      const { template } = makeStack();
      const conditions = resourceProps(template, 'Custom::AWSCDKCfnJson').map((json) =>
        flattenIntrinsic(json.Value),
      );

      expect(conditions).toContainEqual(
        expect.stringContaining('system:serviceaccount:kube-system:ebs-csi-controller-sa'),
      );
    });

    it('waits for nodes before installing the add-ons that need a pod to schedule', () => {
      const { template } = makeStack();
      const addons = template.findResources('AWS::EKS::Addon');
      const nodegroupId = Object.keys(template.findResources('AWS::EKS::Nodegroup'))[0];

      for (const [logicalId, addon] of Object.entries(addons)) {
        const dependsOn = (addon.DependsOn ?? []) as string[];
        const isDeployment = ['CoreDnsAddon', 'EbsCsiDriverAddon'].includes(logicalId);
        expect(dependsOn.includes(nodegroupId)).toBe(isDeployment);
      }
    });

    it('configures the CNI before any node joins', () => {
      const { template } = makeStack();
      const [[, nodegroup]] = Object.entries(template.findResources('AWS::EKS::Nodegroup'));

      expect((nodegroup.DependsOn ?? []) as string[]).toEqual(
        expect.arrayContaining(['VpcCniAddon', 'KubeProxyAddon']),
      );
    });
  });

  describe('IRSA', () => {
    it('creates one OIDC provider for the cluster', () => {
      const { template } = makeStack();
      template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
    });

    it('scopes a role to a single service account and the STS audience', () => {
      const app = new cdk.App();
      const vpcStack = new VpcStack(app, 'IrsaVpcStack', { env: ENV });
      const stack = new EksStack(app, 'IrsaEksStack', {
        env: ENV,
        envName: 'staging',
        vpc: vpcStack.vpc,
      });

      stack.addIrsaRole('CheckoutServiceRole', {
        namespace: 'shop',
        serviceAccountName: 'checkout',
        inlinePolicyStatements: [
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: ['arn:aws:s3:::example-bucket/*'],
          }),
        ],
      });

      const template = Template.fromStack(stack);
      const role = roleByDescription(template, 'IRSA role for shop/checkout');
      const statement = (role.AssumeRolePolicyDocument as any).Statement[0];

      expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
      expect(raw(statement.Principal.Federated)).toContain('OpenIdConnectProvider');
      expect(Object.keys(statement.Condition)).toEqual(['StringEquals']);

      const conditions = resourceProps(template, 'Custom::AWSCDKCfnJson').map((json) =>
        flattenIntrinsic(json.Value),
      );
      expect(conditions).toContainEqual(
        expect.stringContaining('system:serviceaccount:shop:checkout'),
      );
      expect(conditions).toContainEqual(expect.stringContaining(':aud":"sts.amazonaws.com"'));

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 's3:GetObject',
              Resource: 'arn:aws:s3:::example-bucket/*',
            }),
          ]),
        }),
      });
    });

    it('binds the trust conditions to the cluster issuer, not a literal', () => {
      const { template } = makeStack();
      const [conditions] = resourceProps(template, 'Custom::AWSCDKCfnJson');

      // The issuer only exists once the cluster does, which is why the map is
      // built through CfnJson rather than written into the trust policy.
      expect(raw(conditions.Value)).toContain('OpenIdConnectIssuer');
    });
  });

  describe('Cluster Autoscaler', () => {
    it('installs the upstream chart, pinned, into kube-system', () => {
      const { template } = makeStack();
      const chart = helmChartByRelease(template, 'cluster-autoscaler');

      expect(chart.Chart).toBe('cluster-autoscaler');
      expect(chart.Repository).toBe('https://kubernetes.github.io/autoscaler');
      expect(chart.Namespace).toBe('kube-system');
      // The chart version selects the autoscaler release, which is not skew
      // tolerant against the control plane. An unpinned chart would drift off
      // the cluster's Kubernetes version on the next deploy.
      expect(chart.Version).toBe('9.51.0');
      // Without `Wait`, a chart that installs but never becomes ready is a
      // green deploy with no autoscaler running.
      expect(chart.Wait).toBe(true);
    });

    it('discovers node groups by this cluster’s tag rather than by name', () => {
      const { template } = makeStack();
      const values = helmValues(template, 'cluster-autoscaler');

      // EKS, not CloudFormation, creates the ASG behind a managed node group,
      // so its name does not exist at synth time and auto-discovery is the
      // only option that works.
      expect(values).toContain('"autoDiscovery":{"clusterName":"');
      expect(values).not.toContain('autoscalingGroups');
    });

    it('runs under the service account its IRSA role trusts', () => {
      const { template } = makeStack();
      const values = helmValues(template, 'cluster-autoscaler');
      const conditions = resourceProps(template, 'Custom::AWSCDKCfnJson').map((json) =>
        flattenIntrinsic(json.Value),
      );

      // Both halves of IRSA, which nothing in Kubernetes reconciles: the trust
      // policy names the service account, the annotation names the role, and a
      // disagreement fails at the first AWS call rather than at deploy time.
      expect(values).toContain('"name":"cluster-autoscaler"');
      expect(values).toContain('"eks.amazonaws.com/role-arn"');
      expect(conditions).toContainEqual(
        expect.stringContaining('system:serviceaccount:kube-system:cluster-autoscaler'),
      );
    });

    it('scopes every mutating action to groups tagged as owned by this cluster', () => {
      const { template } = makeStack();
      const scaling = statementBySid(clusterAutoscalerPolicy(template), 'ScaleTaggedNodeGroups');

      expect(scaling.Action).toEqual([
        'autoscaling:SetDesiredCapacity',
        'autoscaling:TerminateInstanceInAutoScalingGroup',
      ]);
      // The partition is a token, not `aws`: this template has to synthesize
      // the same way in GovCloud and China, where the literal would be wrong.
      expect(flattenIntrinsic(scaling.Resource)).toBe(
        `arn:${TOKEN}:autoscaling:us-east-1:123456789012:autoScalingGroup:*:autoScalingGroupName/*`,
      );
      // The resource pattern cannot name a group, so the condition is what
      // stops this role resizing another cluster's node groups. It is built
      // through CfnJson because the cluster name — and so the condition key —
      // only exists once the cluster does.
      expect(Object.keys(scaling.Condition)).toEqual(['StringEquals']);
      expect(
        resourceProps(template, 'Custom::AWSCDKCfnJson').map((json) => flattenIntrinsic(json.Value)),
      ).toContainEqual(expect.stringContaining('aws:ResourceTag/k8s.io/cluster-autoscaler/'));
    });

    it('grants nothing but reads on the unscoped statement', () => {
      const { template } = makeStack();
      const discovery = statementBySid(
        clusterAutoscalerPolicy(template),
        'DiscoverScalableCapacity',
      );

      // The wildcard is unavoidable — these actions do not support
      // resource-level permissions — so what keeps it safe is that every action
      // in it is a read. This is the assertion that fails if someone adds a
      // write to the convenient statement.
      expect(discovery.Resource).toBe('*');
      for (const action of discovery.Action as string[]) {
        expect(action).toMatch(/:(Describe|Get|List)[A-Za-z]+$/);
      }
    });

    it('renders every threshold as a Go duration the autoscaler can parse', () => {
      const { template } = makeStack();
      const values = helmValues(template, 'cluster-autoscaler');

      // A bare number is nanoseconds to Go's duration parser, and CDK's own ISO
      // string is not a duration it accepts at all.
      expect(values).toContain('"scale-down-unneeded-time":"600s"');
      expect(values).toContain('"scale-down-delay-after-add":"600s"');
      expect(values).toContain('"max-node-provision-time":"900s"');
      expect(values).toContain('"scale-down-utilization-threshold":0.5');
      expect(values).toContain('"expander":"least-waste"');
    });

    it('takes overridden thresholds', () => {
      const { template } = makeStack({
        clusterAutoscaler: {
          expander: 'most-pods',
          scaleDownUnneededTime: cdk.Duration.minutes(30),
          scaleDownUtilizationThreshold: 0.7,
        },
      });
      const values = helmValues(template, 'cluster-autoscaler');

      expect(values).toContain('"scale-down-unneeded-time":"1800s"');
      expect(values).toContain('"scale-down-utilization-threshold":0.7');
      expect(values).toContain('"expander":"most-pods"');
    });

    it('keeps itself out of its own scale-down decisions', () => {
      const { template } = makeStack();
      const values = helmValues(template, 'cluster-autoscaler');

      // Draining a node it has decided to remove would otherwise be able to
      // evict the pod holding the decision.
      expect(values).toContain('"cluster-autoscaler.kubernetes.io/safe-to-evict":"false"');
      expect(values).toContain('"priorityClassName":"system-cluster-critical"');
    });

    it('waits for the node group, since a Deployment needs somewhere to land', () => {
      const { template } = makeStack();
      const [logicalId] = Object.keys(template.findResources('Custom::AWSCDK-EKS-HelmChart'));
      const nodegroupId = Object.keys(template.findResources('AWS::EKS::Nodegroup'))[0];
      const chart = template.findResources('Custom::AWSCDK-EKS-HelmChart')[logicalId];

      expect((chart.DependsOn ?? []) as string[]).toContain(nodegroupId);
    });

    it('can be left out entirely', () => {
      const { stack, template } = makeStack({ clusterAutoscaler: { enabled: false } });

      template.resourceCountIs('Custom::AWSCDK-EKS-HelmChart', 0);
      expect(stack.clusterAutoscalerRole).toBeUndefined();
      expect(outputByExportName(template, 'staging-eks-cluster-autoscaler-role-arn')).toBeUndefined();
    });
  });

  describe('Outputs', () => {
    it.each([
      'staging-eks-cluster-name',
      'staging-eks-cluster-arn',
      'staging-eks-cluster-endpoint',
      'staging-eks-oidc-provider-arn',
      'staging-eks-oidc-issuer-url',
      'staging-eks-node-role-arn',
      'staging-eks-cluster-security-group-id',
      'staging-eks-cluster-autoscaler-role-arn',
    ])('exports %s', (exportName) => {
      const { template } = makeStack();
      expect(outputByExportName(template, exportName)).toBeDefined();
    });

    it('names the exports for the environment', () => {
      const { template } = makeStack({ envName: 'production' });
      expect(outputByExportName(template, 'production-eks-cluster-name')).toBeDefined();
    });
  });

  describe('Tagging', () => {
    it('tags the cluster and the node group', () => {
      const { template } = makeStack();

      expect(clusterConfig(template).tags).toMatchObject({
        Environment: 'staging',
        ManagedBy: 'CDK',
      });
      expect(nodegroupByName(template, 'staging-system').Tags).toMatchObject({
        Environment: 'staging',
        ManagedBy: 'CDK',
      });
    });
  });
});
