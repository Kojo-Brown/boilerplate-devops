# EKS: cluster, managed node groups, IRSA

`aws/cdk/lib/eks-stack.ts` provisions a cluster with a private API endpoint,
one managed node group, four EKS-managed add-ons, and the OIDC provider that
lets a pod hold IAM permissions of its own.

The three parts are separable in principle and inseparable in practice: a
cluster with no node group runs nothing, and a node group without IRSA means
every pod on a node inherits that node's IAM role — so the blast radius of any
compromised container is whatever the noisiest workload on the cluster needed.

---

## 1. What gets created

| Resource | Why |
|---|---|
| EKS cluster, private endpoint | Control plane. `kubectl` reaches it from inside the VPC only, unless CIDRs are supplied |
| KMS key (rotating) | Envelope encryption for `Secret` objects, on top of the AWS-owned key EKS uses for etcd |
| Node IAM role | Shared by every node group; worker + ECR-read only |
| Launch template per node group | IMDSv2 required at hop limit 1, encrypted gp3 root volume |
| Managed node group | On-demand AL2023 nodes in the private subnets |
| `vpc-cni`, `kube-proxy`, `coredns`, `aws-ebs-csi-driver` | EKS-managed add-ons, versions tracking the cluster version |
| `vpc-cni` with `enableNetworkPolicy` | The agent that enforces NetworkPolicy objects. Without it they are stored and ignored — see [docs/network-policies.md](./network-policies.md) §1 |
| IAM OIDC provider | The identity half of IRSA |
| IRSA roles for the CNI and the EBS CSI driver | The two add-ons that need AWS permissions |

```ts
const cluster = new EksStack(app, 'EksStack-Production', {
  vpc: vpcStackProduction.vpc,
  envName: 'production',
  clusterAdminRoleArns: ['arn:aws:iam::<account>:role/PlatformAdmin'],
  systemNodeGroup: { minSize: 3, maxSize: 9, diskSizeGiB: 50 },
});
```

Both environments are wired in `aws/cdk/bin/app.ts` as `EksStack-Staging` and
`EksStack-Production`, each in the VPC its ECS stack already uses.

---

## 2. IRSA, and why the node role is thin

Without IRSA, an AWS SDK call from a pod is signed with credentials from the
instance metadata service, which returns the *node's* role. Every pod on the
node therefore has every permission any pod on that node needs, and the union
grows with each workload scheduled there.

IRSA replaces that. The cluster publishes an OIDC discovery document; the
provider registered here makes IAM trust it; a pod's projected service-account
token is exchanged through `sts:AssumeRoleWithWebIdentity` for credentials
scoped to one role.

Two things make the scoping real, and both are in the trust policy this stack
writes:

```jsonc
{
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Principal": { "Federated": "<the cluster's OIDC provider>" },
  "Condition": {
    "StringEquals": {
      "<issuer>:aud": "sts.amazonaws.com",
      "<issuer>:sub": "system:serviceaccount:shop:checkout"
    }
  }
}
```

Drop the `sub` condition and *every* service account in the cluster can assume
the role. Drop `aud` and a token minted for another audience is accepted.

Three consequences follow through the rest of the stack:

- **The node role does not carry `AmazonEKS_CNI_Policy`.** The VPC CNI holds
  those ENI permissions through its own IRSA role, attached to the `aws-node`
  service account. CDK's default node role includes the policy; this stack
  passes its own role instead.
- **Nodes require IMDSv2 with a hop limit of 1.** A pod sits one network hop
  further from the metadata service than the kubelet does, so a hop limit of 1
  makes IMDS unreachable from inside a container while leaving it reachable to
  the node itself. Without this, a compromised pod can simply ask for the node
  role and ignore IRSA entirely.
- **Add-ons that need AWS permissions get roles, not node permissions.** The
  EBS CSI driver's role is scoped to `kube-system/ebs-csi-controller-sa`.

### Adding a role for your own workload

For a service account something else creates — a Helm chart, an ArgoCD
application, an add-on:

```ts
const role = eksStack.addIrsaRole('CheckoutServiceRole', {
  namespace: 'shop',
  serviceAccountName: 'checkout',
  inlinePolicyStatements: [
    new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::orders-bucket/*'],
    }),
  ],
});
```

Then annotate the service account with the role ARN:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: checkout
  namespace: shop
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<account>:role/<the role>
```

For a service account CDK should create in the cluster itself,
`cluster.addServiceAccount()` does both halves in one call.

---

## 3. Reaching the API server

The endpoint is private by default. `kubectl` therefore works from inside the
VPC — a bastion, a VPN, an SSM port-forward — and not from a laptop on the open
internet:

```bash
aws eks update-kubeconfig --name production-eks --region us-east-1
```

To expose it to known ranges instead, supply them; an open CIDR is rejected at
synth time rather than deployed:

```bash
cdk deploy EksStack-Production \
  --context productionEksPublicAccessCidrs=203.0.113.0/24,198.51.100.7/32
```

Authorisation is separate from reachability. `clusterAdminRoleArns` creates an
EKS *access entry* per role with `AmazonEKSClusterAdminPolicy`, so the roles
that operate the cluster are declared in code rather than edited into the
`aws-auth` ConfigMap by hand after the fact. The cluster runs in
`API_AND_CONFIG_MAP` mode: access entries take priority, and the ConfigMap stays
readable for tooling that still expects it. Switching to `API` is a one-way
door — everything mapped only in the ConfigMap loses access at that moment.

---

## 4. Versions

`version` and `kubectlLayer` are a matched pair. The CDK kubectl handler runs
the binary from that Lambda layer against the control plane, and kubectl
supports one minor version of skew either way. The default is Kubernetes 1.33
with `@aws-cdk/lambda-layer-kubectl-v33`; overriding the version without
supplying a layer throws rather than deploying a handler that cannot talk to
the cluster it just created.

To move to 1.34: install `@aws-cdk/lambda-layer-kubectl-v34`, then pass both.

Add-on versions are deliberately unpinned. EKS installs the default version for
the cluster's Kubernetes version, so an add-on moves with a control-plane
upgrade instead of drifting behind a literal in git.

---

## 5. Subnet tags

`VpcStack` takes `tagSubnetsForEks`, which puts `kubernetes.io/role/elb` on the
public subnets and `kubernetes.io/role/internal-elb` on the private ones. The
AWS Load Balancer Controller reads those tags to choose subnets; without them
every `Ingress` and `Service type=LoadBalancer` stays pending, and it stays
pending long after the cluster itself came up healthy, which is what makes it
hard to diagnose.

The tags live on `VpcStack` rather than `EksStack` because CloudFormation cannot
tag a resource another stack owns.

---

## 6. Checkov suppressions

The CDK EKS module emits its own deployment-time machinery — a cluster resource
handler, a kubectl handler, the `Provider` framework Lambdas behind both, and a
`CfnJson` evaluator — and those functions are generated with properties no
construct prop reaches. Four Checkov checks fire on them (reserved concurrency,
DLQ, VPC attachment, environment-variable CMK) plus one on the CDK-generated
cluster creation policy.

`aws/cdk/lib/checkov-suppressions.ts` suppresses those, per resource and with a
written reason, through an aspect scoped to the CDK-internal construct paths.
`test/checkov-suppressions.test.ts` pins the exact list, so the escape hatch
cannot spread to resources this repository writes: a suppression landing on the
node role, the launch template, an add-on or the KMS key fails the suite.

What was rejected: adding the findings to `.checkov.baseline` (which records
what existed when the gate was introduced — new infrastructure entering it is
the regression the gate exists to catch), and setting the properties anyway
through `addPropertyOverride` on CDK internals (a DLQ nothing consumes, a CMK
for environment variables CDK writes itself).

---

## 7. Cluster Autoscaler

Installed by default, from the upstream Helm chart, into `kube-system`. It grows
and shrinks the managed node groups' Auto Scaling groups in response to pods
that cannot be scheduled — the other half of the chart's HPA, which can ask for
pods but cannot create anywhere to put them.

Three things about it are specific to this stack:

- **Discovery is by ASG tag**, not by name. EKS creates the ASG behind a managed
  node group, so no name exists at synth time; `k8s.io/cluster-autoscaler/enabled`
  and `k8s.io/cluster-autoscaler/<cluster>` are applied by EKS itself, so nothing
  here tags anything. A self-managed ASG added later needs both tags by hand.
- **The bounds are the node group's**, `minSize` and `maxSize` on
  `addManagedNodeGroup`. No autoscaler flag can move a group outside them, which
  makes `maxSize` the real ceiling an HPA's `maxReplicas` has to fit inside.
- **The chart version is pinned to the cluster version.** The autoscaler reads
  scheduler internals to decide whether a pending pod would fit a hypothetical
  node, so its release is not skew tolerant: chart `9.51.0` ships autoscaler
  `v1.33.0` for the 1.33 control plane §4 creates. Overriding `kubernetesVersion`
  means overriding `clusterAutoscaler.chartVersion` too, the same way
  `kubectlLayer` has to move with it.

The IRSA role splits into a read-only statement on `*` — those actions support
no resource-level permissions — and a mutating statement scoped to Auto Scaling
group ARNs and conditioned on this cluster's ownership tag. Without that
condition the role could resize every ASG in the account.

Set `clusterAutoscaler: { enabled: false }` to leave it out; the thresholds and
the reasoning behind each one are in
[docs/autoscaling.md](./autoscaling.md) §4.

---

## 8. What this stack does not do

Later Phase 8 items, deliberately out of scope here:

- No ArgoCD, no ingress controller. The cluster has capacity, identity, node
  scaling, an application chart and policy enforcement; it has no automated
  rollout path and nothing in front of it.
- **No cluster-wide network baseline.** The CNI enforces policy, and the `app`
  chart closes its own pods (see
  [docs/network-policies.md](./network-policies.md)), but every other pod in the
  cluster is unrestricted and nothing stops a namespace from being created
  without a policy.
- **Policy decisions are not shipped anywhere.** The network policy agent logs
  them on the node at `/var/log/aws-routed-eni/network-policy-agent.log`;
  forwarding them to CloudWatch is a further add-on setting that needs `logs:*`
  on the node role, and a per-connection log stream with a per-connection bill.
- **No metrics-server**, which the chart's HPA reads and EKS does not ship as a
  managed add-on. Without it the HPA reports `<unknown>` and scales nothing.
- No pod security defaults are enforced cluster-wide. The `app` chart's pods
  satisfy the `restricted` Pod Security Standard on their own (see
  [docs/helm-chart.md](./helm-chart.md) §2.1), but no namespace carries a
  `pod-security.kubernetes.io/enforce` label, so nothing stops a *different*
  workload from running privileged. The chart being admissible is what makes
  applying that label a one-line change rather than a migration.
- One node group, shared by system and application workloads. That is why the
  autoscaler leaves a couple of nodes above the group's minimum pinned — see
  [docs/autoscaling.md](./autoscaling.md) §4.
- `enableSsmAccess` is off, so nodes carry no `AmazonSSMManagedInstanceCore`.
  Turn it on if you need a Session Manager shell on a node.
