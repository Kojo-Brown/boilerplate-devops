# NetworkPolicy: default-deny, an explicit allowlist, and the ways it silently does nothing

The `app` chart renders two `NetworkPolicy` objects per release: one that denies
both directions for the release's pods, and one that allows the peers named in
`networkPolicy.ingress` and `networkPolicy.egress`. `EksStack` turns on the
enforcement that makes either of them mean anything.

Everything in this document is about one property of NetworkPolicy that has no
equivalent elsewhere in Kubernetes: **a policy has no status**. Nothing reports
that a policy is unenforced, that a rule matched nothing, or that a selector
resolved to zero pods. Every failure mode below produces a cluster that
describes correctly, `kubectl get netpol` cleanly, and behaves differently from
what the manifest says.

---

## 1. Enforcement is not part of Kubernetes

Kubernetes ships no NetworkPolicy controller. The API server validates a policy
and stores it; whether anything acts on it is entirely up to the CNI plugin. On
a CNI that does not implement policy, a default-deny policy is accepted,
appears in `kubectl get networkpolicy`, prints its rules under `kubectl
describe`, and enforces nothing at all. There is no event, no condition and no
field that distinguishes that cluster from one where the policy is being
enforced.

On EKS the enforcer is the VPC CNI's network policy agent, which is off by
default. `EksStack` turns it on through the add-on's configuration:

```ts
new eks.CfnAddon(this, 'VpcCniAddon', {
  addonName: 'vpc-cni',
  // ...
  configurationValues: JSON.stringify({ enableNetworkPolicy: 'true' }),
});
```

Two details are load-bearing:

- The value is the **string** `"true"`. The add-on's configuration schema types
  it as a string, and the EKS API rejects a JSON boolean.
- It needs **no additional IAM**. The agent watches policy objects through the
  Kubernetes API, not through AWS, so the CNI's IRSA role is unchanged.

Turning it on starts the agent inside the existing `aws-node` DaemonSet, which
compiles policies into eBPF programs on each node.

To check it on a running cluster:

```sh
aws eks describe-addon --cluster-name production-eks --addon-name vpc-cni \
  --query 'addon.configurationValues'

kubectl -n kube-system get ds aws-node \
  -o jsonpath='{.spec.template.spec.containers[*].name}'   # aws-node aws-eks-nodeagent
```

---

## 2. Two objects, not one

```
<release>-default-deny    podSelector: this release's pods
                          policyTypes: [Ingress, Egress]
                          (no rules)

<release>-allow           podSelector: this release's pods
                          policyTypes: only the directions it allows something in
                          ingress/egress: the allowlist
```

Policies are additive: a pod selected by any policy is denied everything in that
policy's directions that some policy selecting it does not explicitly allow. So
a single object carrying both `policyTypes` and the allow rules would be
exactly equivalent — until someone edits or deletes it at 3am, at which point
the pods go from *allowlisted* to *unrestricted* rather than to *denied*.
Splitting the floor from the allowlist makes the failure mode of losing the
second object a service that stops talking, which is loud, instead of a
boundary that stops existing, which is silent.

The deny policy also selects **only this release's pods**, never `podSelector:
{}`. A namespace-wide default-deny is what most examples show and it is wrong
for a chart: it would apply to every pod in the namespace, including ones this
release did not create. Installing a chart should not cut the network out from
under a neighbour. If a namespace should be closed by default, that is one
policy its owner applies — not a side effect of `helm install`.

---

## 3. Writing an allowlist entry

```yaml
networkPolicy:
  ingress:
    - name: ingress-controller           # not rendered; for review and audit messages
      namespaceLabels:
        kubernetes.io/metadata.name: ingress-nginx
      podLabels:
        app.kubernetes.io/name: ingress-nginx
      ports:
        - port: http                     # the container port, by name
          protocol: TCP
```

An entry is either a pair of selectors or a `cidr` — never both, because
`ipBlock` and the selectors are mutually exclusive within one peer and what a
CNI does with an entry carrying both is not defined by anything worth relying
on. `values.schema.json` refuses the combination.

Three traps, all of which produce a policy Kubernetes accepts:

**One entry is one peer, so its selectors are ANDed.** In the API, two selectors
in one `from` element mean "pods matching B, in namespaces matching A"; the same
two as *separate* elements mean "either". The difference is a `-` and two spaces:

```yaml
from:                             from:
  - namespaceSelector: {...}        - namespaceSelector: {...}
    podSelector: {...}            - podSelector: {...}
#   AND — one peer                #   OR — two peers
```

The chart never renders the second form. One values entry becomes one peer, so
allowing two sources means writing two entries.

**An omitted `namespaceLabels` does not mean "any namespace".** A peer with only
a `podSelector` matches those pods *in the release's own namespace*. That is
usually what you want and never what it looks like.

**An empty `matchLabels` matches everything.** `namespaceSelector: {matchLabels:
{}}` is every namespace in the cluster, including whatever gets installed next
year. It is the widest rule you can write and it reads as the narrowest, so the
schema requires at least one label (`schema-fixtures/network-policy-open-namespace-selector.yaml`).

### Ports are the destination pod's, not the Service's

This is the mistake nearly everyone makes once. `service.port` is `80`, the
container listens on `8080`, and the obvious ingress rule says `port: 80`. It
matches nothing: kube-proxy rewrites the destination to the container port
*before* policy is evaluated, so no packet with destination port 80 ever reaches
the policy. The rule is accepted, the default-deny drops the traffic, and the
symptom is connections that hang — which looks like an unresponsive application.

`npm run audit:helm` fails on it specifically (`ingress-port-mismatch`), and
names `service.port` when that is what the number is. Write `port: http`, which
is the container port by name and moves with it.

Named ports work on **ingress only**. On egress the name resolves against the
destination pod's containers, which belong to somebody else — so it means
whatever they happen to call their ports, and matches nothing the day they
rename one. The schema requires egress ports to be numbers.

---

## 4. The default allowlist

| Direction | Entry | Why |
|---|---|---|
| Egress | cluster DNS, UDP+TCP 53 | Rendered from `networkPolicy.dns`, not from the list |
| Egress | `0.0.0.0/0` except `169.254.169.254/32`, TCP 443 | HTTPS to AWS |
| Ingress | *(empty)* | Nothing should be reaching these pods yet |

**DNS is held apart from the list** because it is not a policy decision. A
default-deny egress policy without it drops every name lookup these pods make,
and the failure does not look like a network failure: the resolver waits out its
timeout, so every outbound call takes five seconds and then fails with
`EAI_AGAIN`. Both protocols are allowed — UDP carries the ordinary query, TCP
carries the retry when a response exceeds 512 bytes and any resolver configured
with `use-vc`. Allowing only UDP works until the first large answer.
`npm run audit:helm` fails (`dns-egress-blocked`) if DNS is turned off and no
egress entry allows port 53.

**HTTPS to anywhere** is what the workload actually needs: IRSA exchanges the
projected service account token at STS, and any SDK call — Secrets Manager, S3,
DynamoDB — is HTTPS to a public endpoint reached through the NAT gateway.
Narrowing it means creating interface VPC endpoints for those services and
allowlisting the endpoint ENIs' subnet ranges instead:

```yaml
egress:
  - name: aws-vpc-endpoints
    cidr: 10.0.0.0/16        # the private subnets the endpoint ENIs live in
    ports:
      - port: 443
        protocol: TCP
```

That is a real improvement and it needs the endpoints to exist first, which is
not something this repository provisions.

**The `except` is the instance metadata service**, and it is worth being precise
about what it does. The node launch template already requires IMDSv2 at a hop
limit of 1, and *that* is the control that puts IMDS out of a container's reach
— a pod that reached it would be signed with the node's role, which holds the
union of what every pod on that node needs, which is the thing IRSA exists to
stop. The `except` is the second control. It matters because the first belongs
to the node and can be lowered for an afternoon of debugging, and this one
belongs to the release and cannot be lowered without a commit.
`npm run audit:helm` fails (`metadata-service-reachable`) on an egress `ipBlock`
that contains the metadata address and excepts nothing covering it.

**Ingress is one entry: the ingress controller.** The chart defaults leave it
empty — with `ingress.enabled: false` there is nothing that should be reaching
these pods — and both environment files add the peer that opens it, because both
serve an Ingress:

```yaml
networkPolicy:
  ingress:
    - name: ingress-controller
      namespaceLabels:
        kubernetes.io/metadata.name: ingress-nginx
      podLabels:
        app.kubernetes.io/name: ingress-nginx
      ports:
        - port: http          # the container port by name, not service.port
          protocol: TCP
```

Enabling the Ingress *without* it is the failure `npm run audit:helm` reports as
`ingress-peer-not-allowed`, and it is the worst-behaved one in this document:
DNS resolves, the certificate is issued, the Ingress has an address, the Service
has endpoints, the pods are Ready — and the controller returns 503 because it
cannot open a connection to any of them. Nothing in the Ingress, the Service or
the Deployment is wrong. See [docs/ingress.md](./ingress.md) §8.

One entry of one shape is also the whole allowlist in both environments, which
leaves the other peer shapes — a `podSelector` alone, an `ipBlock` with an
`except` — rendered by no gate. `render-fixtures/network-policy-allowlist.yaml`
is what turns those paths on; see
`k8s/charts/app/render-fixtures/README.md`.

### Health probes

Kubelet probes are not in the allowlist and do not need to be. They originate on
the node rather than from a pod, and the VPC CNI's policy agent does not apply
policy to node-to-pod traffic — which is what keeps a default-deny ingress
policy from failing every readiness probe on the cluster. That is CNI-specific
behaviour rather than something the API guarantees, so it is the first thing to
check on a cluster running something else.

---

## 5. When a connection is dropped

A denied connection produces no Kubernetes event and no error on either side —
the client sees a timeout. What exists is a per-node log:

```sh
kubectl -n kube-system logs -l k8s-app=aws-node -c aws-eks-nodeagent --tail=50
# on the node itself:
/var/log/aws-routed-eni/network-policy-agent.log
```

Shipping those decisions to CloudWatch is a further add-on setting
(`nodeAgent.enableCloudWatchLogs`) and does require `logs:CreateLogGroup`,
`logs:CreateLogStream` and `logs:PutLogEvents` on the node role, so it is left
to the operator rather than turned on here — it is a per-connection log stream
with a per-connection bill.

Working through a drop:

1. **Is the policy enforced at all?** §1. On a cluster where it is not, every
   symptom below is impossible and the problem is elsewhere.
2. **Which policies select the pod?**
   `kubectl describe pod <pod> | grep -A5 Labels`, then
   `kubectl get netpol -o wide` — a policy selects by label, and a pod that
   drifted out of `app.kubernetes.io/instance` is a pod no policy covers.
3. **Is it the port?** The single most likely answer, and `npm run audit:helm`
   already fails on the version of it that is in the values file. The version it
   cannot see is a container that listens on a port other than the one
   `containerPort` declares.
4. **Is it DNS?** A five-second delay before the failure is the signature. `kubectl
   exec` into the pod and resolve something.
5. **Is it the AND?** Two selectors in one entry are ANDed. A peer naming a
   namespace and a pod label where the pod carries neither in that namespace
   matches nothing and looks correct.

---

## 6. What this does not cover

- **Nothing is deployed.** The gates render manifests; they do not run a
  cluster, so no policy in this repository has been observed to permit or deny a
  packet. Everything above is a property of the manifests and of documented
  behaviour, not of an observed run.
- **Egress is IP-based, and DNS names are not.** An allowlist for a third-party
  API whose addresses move is a range that either goes stale or is wide enough
  not to. Kubernetes has no DNS-based egress policy; that is what a service mesh
  or a forward proxy is for.
- **No cluster-wide baseline.** The chart closes its own pods. Every other pod
  in the cluster is unrestricted, and nothing stops a namespace from being
  created without a policy. `AdminNetworkPolicy` (a cluster-scoped API, still
  alpha in most distributions) is the standards-track answer.
- **No IPv6.** Nothing here provisions a dual-stack cluster, and a v6 range in an
  allowlist on a v4-only cluster is a rule that silently matches nothing — so
  the schema rejects one rather than accepting it.
- **`endPort` is not exposed.** Port ranges in a policy are a 1.25 feature; the
  chart allows named ports and single numbers, which is what an allowlist for
  one HTTP service needs.
