# Autoscaling: the HPA, the Cluster Autoscaler, and where the numbers come from

Two loops, not one.

The **Horizontal Pod Autoscaler** is in the chart (`k8s/charts/app/templates/hpa.yaml`).
It watches per-pod CPU as a fraction of the CPU *request* and changes the
Deployment's replica count. It reacts in roughly ninety seconds and it cannot
create capacity — it can only ask for pods.

The **Cluster Autoscaler** is in `EksStack` (`aws/cdk/lib/eks-stack.ts`). It
watches for pods that are Pending because nothing can hold them, and grows the
managed node groups' Auto Scaling groups. It reacts in two to four minutes,
because an EC2 instance has to boot, join the cluster and pull images.

Neither is useful alone. An HPA with no room underneath it turns a traffic spike
into Pending pods and reports success. A Cluster Autoscaler with a fixed replica
count adds nodes nothing schedules onto, and then removes them again.

---

## 1. What is configured where

| | HPA | Cluster Autoscaler |
|---|---|---|
| Lives in | `values.yaml` → `autoscaling` | `EksStack`, `clusterAutoscaler` props |
| Unit it moves | pods | nodes |
| Bounds | `minReplicas` / `maxReplicas` | the node group's `minSize` / `maxSize` |
| Reaction time | ~90s | 2–4 min |
| Reads | metrics-server, per-pod CPU vs request | the scheduler's view of Pending pods |
| Gated by | `values.schema.json`, `npm run audit:helm` | `test/eks-stack.test.ts`, Checkov |

The autoscaler does not read `minReplicas` or `maxReplicas`, and the HPA does not
read the node group's sizes. Nothing reconciles them, which is why §3 does the
arithmetic that ties them together by hand.

### The shipped values

| | staging | production |
|---|---|---|
| `autoscaling.minReplicas` | 2 | 4 |
| `autoscaling.maxReplicas` | 4 | 20 |
| `autoscaling.targetCPUUtilizationPercentage` | 60 | 60 |
| `behavior.scaleUp` | +100% or +4 pods / 30s, no window | same |
| `behavior.scaleDown` | −25% / 60s, 300s window | −25% / 60s, 600s window |
| `resources.requests.cpu` | 50m | 500m |
| `podDisruptionBudget.minAvailable` | 1 | 3 |
| Node group | 2–4 × t3.large | 3–9 × m6i.large |

---

## 2. The two things that are not obvious

**The Deployment stops declaring `replicas`.** With the HPA enabled,
`deployment.yaml` renders no `replicas` field at all. It has to: `replicas` is
part of the manifest, so every `helm upgrade` writes whatever the template says,
and with an HPA also writing it the two fight. The visible symptom is a capacity
dip on every deploy, worst when the fleet is largest — which is when a deploy can
least afford it.

The cost is that the *first* install creates the Deployment at the Kubernetes
default of one replica, and the HPA raises it to `minReplicas` on its next sync
(15s). Upgrades are unaffected, because an absent field is left alone. If that
first fifteen seconds matters, install with `--set autoscaling.enabled=false`,
then upgrade with it on.

`replicaCount` is still required, and `npm run audit:helm` keeps it inside
`[minReplicas, maxReplicas]`. While the HPA is on it reaches nothing; the moment
someone sets `autoscaling.enabled: false` it becomes the fleet size. Keeping it
in range means that switch changes the mechanism and not the capacity.

**The PodDisruptionBudget is checked against the floor, not the nominal size.**
`minAvailable: 4` looks generous against eight replicas and permits no
disruption at all once the HPA has settled to a floor of four. The drain that
matters — a node rotation during a cluster upgrade, a Cluster Autoscaler
scale-down — is the one that arrives at 4am, when the fleet is at its smallest.
So `audit:helm` compares `minAvailable` against `autoscaling.minReplicas`
whenever the HPA is on, and against `replicaCount` when it is not.

---

## 3. Deriving the thresholds

The ramp in `k8s/load-test/hpa-ramp.js` produces four measurements, and each
threshold falls out of one of them. What follows is the derivation worked
through for the reference service profile — a Go HTTP service at 500m CPU
request, the profile `values-production.yaml` describes.

> **These are not measurements from a cluster.** There is no cluster in CI and
> none was stood up for this change, so the four inputs below are the reference
> profile's stated characteristics, not a recorded run. The arithmetic is what
> is being shipped: run `hpa-ramp.js` against your own service, substitute your
> own four numbers, and the same steps give you your own thresholds. Where a
> number below would change with a real measurement, it is the input that
> changes, not the method.

**Inputs** (reference profile):

| | |
|---|---|
| Requests per second one pod serves at 500m | 120 |
| Utilization at which p99 turns up sharply — the knee | 85% of request |
| Observed peak | 600 req/s |
| Seconds from a step to new pods serving | 90 |

**Where the 90 seconds comes from.** It is not a measurement of the service, it
is the sum of the control loop: metrics-server scrapes every 15s, the HPA syncs
every 15s, and a pod has a 60s startup budget (`probes.startup`, 30 × 2s). A
step that lands just after a scrape waits out all three.

**`targetCPUUtilizationPercentage: 60`.** During those 90 seconds the existing
pods absorb the whole step. Starting at 60% of request with a knee at 85%, they
absorb a step of 85 ÷ 60 ≈ **1.4×** before latency degrades. At a target of 70%
that tolerance falls to 85 ÷ 70 ≈ 1.2×; at 50% it rises to 1.7× and the steady
state costs 20% more pods. 60 is the point where the fleet survives the largest
step the ramp's staircase produces without paying for headroom that is never
used.

**`maxReplicas: 20`.** Two constraints, and the binding one is the second.

- *Traffic:* 20 × 120 req/s = 2400 req/s, about 4× the observed peak.
- *Capacity:* 20 × 500m = **10 vCPU of requests**. The production node group
  tops out at 9 × m6i.large, ≈ 1.93 vCPU allocatable each ≈ **17.4 vCPU**.
  DaemonSets and the kube-system Deployments take roughly 1.5 vCPU of that, so
  about 15.9 remain. 10 fits, with room for the surge pod every rollout adds.

A `maxReplicas` above what the node group can supply does not fail anywhere. The
HPA raises the replica count, the Cluster Autoscaler hits `maxSize`, and the
remainder sit Pending while every dashboard reports the autoscaler working.
Raising `maxReplicas` means raising the node group's `maxSize` in `bin/app.ts`
in the same change.

**`minReplicas: 4`.** The floor is set by availability, not by load:
`podDisruptionBudget.minAvailable: 3` needs at least 4 to permit one voluntary
disruption, and four pods spread over three availability zones survive losing
one. Load would have allowed less — the observed peak needs five pods at target,
and the trough needs one.

**The scale-up policy: +100% or +4 pods per 30s, no stabilization window.**
Doubling every 30s takes the fleet from 4 to 20 in about 75 seconds, which is
the same order as the 90s it takes a pod to start serving. Faster would only
queue pods the nodes cannot yet hold; slower would make the HPA, rather than
pod startup, the thing the recovery is waiting on. The `+4 pods` policy is what
does the work at the bottom of the range, where +100% of 4 is 4 anyway and
+100% of 1 is 1.

**The scale-down policy: −25% per 60s, 600s window in production.**
`stabilizationWindowSeconds` is the period the HPA takes its *highest*
recommendation from, so ten minutes means a trough has to last ten minutes
before anything is removed. Production traffic has a daily shape with troughs
longer than that and spikes shorter than it, so the window removes capacity on
the shape and not on the spikes. Removing at most a quarter of the fleet per
minute means a scale-down that turns out to be wrong is undone by a single
scale-up period. Staging uses 300s because its troughs are whatever a test last
did.

The chart's schema refuses a scale-down window below 60s outright. Zero is legal
Kubernetes and it flaps: the HPA removes pods on the first low sample and adds
them back on the next, turning ordinary traffic noise into a rollout.

---

## 4. Cluster Autoscaler thresholds

Every default below is set explicitly in `EksStack.addClusterAutoscaler` and
overridable through `clusterAutoscaler` props.

| Flag | Value | Why |
|---|---|---|
| `expander` | `least-waste` | Grows the group that leaves the least idle CPU and memory once the pod lands. Only meaningful with more than one node group, but it is the wrong default to discover later. |
| `balance-similar-node-groups` | `true` | Keeps interchangeable groups at similar sizes, which is what keeps a multi-AZ fleet multi-AZ under scale-up. |
| `scale-down-utilization-threshold` | `0.5` | A node whose **requests** are under half its allocatable is a scale-down candidate. Requests, not usage: the autoscaler simulates the scheduler, and the scheduler packs on requests. A fleet that over-requests never scales down however idle its dashboards look. |
| `scale-down-unneeded-time` | `10m` | The whole of the scale-down hysteresis. Shorter reclaims cost sooner and thrashes on traffic that returns; longer pays for genuinely idle nodes. |
| `scale-down-delay-after-add` | `10m` | Without it, a burst that adds a node can be followed immediately by a decision to remove a different one. |
| `max-node-provision-time` | `15m` | How long a node may take to join before the autoscaler gives up and tries elsewhere — a group whose instance type has no capacity in an AZ, for instance. |
| `skip-nodes-with-local-storage` | `true` | A node running a pod with an `emptyDir` or `hostPath` is left alone, because removing it destroys data the pod believes is still there. This is the flag most often flipped by someone chasing a node that will not go away. |

### Discovery, and what bounds it

The autoscaler finds node groups by ASG tag —
`k8s.io/cluster-autoscaler/enabled` and `k8s.io/cluster-autoscaler/<cluster>` —
rather than by name. It has to: EKS, not CloudFormation, creates the ASG behind
a managed node group, so no name exists at synth time. **EKS applies both tags
to the ASGs it creates for managed node groups**, so nothing in this repository
tags anything. A *self-managed* ASG added later is invisible to the autoscaler
until someone tags it by hand.

The min and max the autoscaler works within are the ASG's own, which come from
`minSize` and `maxSize` on `EksStack.addManagedNodeGroup`. Nothing in the
autoscaler's configuration can move a group outside them.

### What it will not remove

Two defaults are kept deliberately, and both mean nodes that stay up:

- A node running a **kube-system pod that is not part of a DaemonSet** is left
  alone (`--skip-nodes-with-system-pods`, default `true`). With the single node
  group this stack creates, CoreDNS, the EBS CSI controller and the autoscaler
  itself pin a couple of nodes above the group's minimum. The alternative is an
  autoscaler that evicts CoreDNS to save an instance.
- A node running a pod with **local storage**, as above.

If that pinning costs more than it is worth, the fix is a second node group —
one fixed-size group for system workloads and one autoscaled group for the
application, with `nodeSelector` on the chart pointing at the second. That is a
change to node topology, not to these thresholds.

### IAM

The autoscaler's IRSA role holds two statements:

- **`DiscoverScalableCapacity`** — reads, on `*`. Unavoidable: none of these
  actions supports resource-level permissions, and the autoscaler has to see
  groups it does not manage in order to answer "would this pending pod fit
  anywhere". A test asserts every action in this statement is a
  `Describe`/`Get`/`List`, which is what keeps the wildcard safe.
- **`ScaleTaggedNodeGroups`** — `SetDesiredCapacity` and
  `TerminateInstanceInAutoScalingGroup`, on Auto Scaling group ARNs, conditioned
  on `aws:ResourceTag/k8s.io/cluster-autoscaler/<cluster> = owned`. The resource
  pattern cannot name a group, so the tag condition is the actual bound —
  without it the role could resize every ASG in the account, another cluster's
  included.

---

## 5. Where the two loops interact

**Version skew.** The Cluster Autoscaler reads scheduler internals to decide
whether a pending pod would fit a hypothetical node, so its release tracks the
Kubernetes minor version and is not skew tolerant. `EksStack` pins the Helm
chart version, and the chart's `appVersion` is the autoscaler release: chart
`9.51.0` ships autoscaler `v1.33.0` for a 1.33 control plane. Overriding
`kubernetesVersion` means overriding `clusterAutoscaler.chartVersion` too — the
same pairing `kubectlLayer` already has.

**The PDB is what makes a scale-down safe.** The autoscaler drains a node it has
decided to remove, and a drain respects PodDisruptionBudgets. Without one, a
scale-down can take every replica that happened to land on the same node. With
one that permits no disruption, the drain blocks forever and the node is never
removed — which is why `audit:helm` fails on `minAvailable >= ` the floor.

**A scale-up that needs a node is bounded by the slower loop.** The HPA reaches
its ceiling in ~75 seconds; a new node takes two to four minutes. So the fleet's
floor is sized to fit on the nodes that already exist: 4 × 500m = 2 vCPU against
3 × 1.93 ≈ 5.8 vCPU allocatable at the node group's minimum. The common case —
a spike inside the existing fleet's headroom — never waits for EC2.

---

## 6. Gates

| Gate | What it catches |
|---|---|
| `npm run audit:helm` | `minAvailable` at or above the floor, `maxReplicas` not above `minReplicas`, `replicaCount` outside the HPA's range |
| `values.schema.json` (ajv, and Helm's own validator) | `minReplicas: 0`, a scale-down window under 60s, an unknown key under `autoscaling`, a policy with no `percent` and no `pods` |
| `schema-fixtures/` | that the two rules above still fail — a schema that has stopped catching anything looks exactly like one with nothing to catch |
| `test/eks-stack.test.ts` | the chart pin, the IRSA pairing, the tag condition on every mutating action, reads-only on the wildcard statement, Go-formatted durations |
| Checkov | the IAM policy, against the baseline |

---

## 7. What this does not cover

- **Nothing has been load tested.** There is no cluster in CI and none was
  created for this change. `k8s/load-test/hpa-ramp.js` is runnable and the
  derivation in §3 is complete, but the four inputs it consumes are the
  reference profile's stated characteristics rather than numbers read off a
  run. Treat the shipped thresholds as a defensible starting point for a service
  shaped like the reference one, and re-derive before trusting them for one that
  is not.
- **No custom or external metrics.** Scaling on queue depth or on requests per
  second needs `custom.metrics.k8s.io` or `external.metrics.k8s.io` and an
  adapter — KEDA, or the Prometheus adapter — neither of which is installed. CPU
  is a proxy for load and it is a poor one for a service that blocks on I/O.
- **No metrics-server.** The HPA reads it and this stack does not install it;
  EKS does not ship it as a managed add-on. Without it the HPA reports
  `<unknown>` for current utilization and scales nothing. Install it before
  enabling the chart's HPA on a real cluster.
- **No Vertical Pod Autoscaler**, so the CPU request the HPA measures against is
  a number a human chose. A request set too high makes 60% utilization mean a
  quarter of the real capacity.
- **No Karpenter.** It replaces the node-group model with per-pod instance
  selection and is what most new EKS clusters should use; the Cluster Autoscaler
  is here because it works with the managed node groups this stack already
  creates. Switching is a change to `EksStack`, not to the chart.
- **No pod topology spread.** Four replicas over three AZs is what the
  scheduler happens to do, not something the chart requires. That belongs with
  the pod-security item, which is the next thing to touch the pod spec.
