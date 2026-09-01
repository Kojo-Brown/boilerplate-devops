# Helm: the `app` chart, per-environment values, and a schema that is a gate

`k8s/charts/app` is the application delivery path the EKS cluster did not have.
It installs a stateless HTTP service — Deployment, Service, ServiceAccount wired
for IRSA, a configuration ConfigMap, a PodDisruptionBudget, a
HorizontalPodAutoscaler and a default-deny NetworkPolicy with an explicit
allowlist — and every value it accepts is constrained by `values.schema.json`.

```
k8s/charts/app/
├── Chart.yaml
├── values.yaml                 defaults, and the documentation of every key
├── values.schema.json          the contract Helm enforces on every install
├── values-staging.yaml         only what staging changes
├── values-production.yaml      only what production changes
├── schema-fixtures/            values files the schema must reject
├── render-fixtures/            values files the templates must render
└── templates/
```

---

## 1. Deploying

```bash
helm upgrade --install app-staging k8s/charts/app \
  --namespace staging --create-namespace \
  --values k8s/charts/app/values-staging.yaml \
  --set image.tag="$GIT_SHA" \
  --wait --timeout 5m
```

Production adds `--atomic`:

```bash
helm upgrade --install app-production k8s/charts/app \
  --namespace production --create-namespace \
  --values k8s/charts/app/values-production.yaml \
  --set image.tag="$RELEASE_TAG" \
  --atomic --wait --timeout 5m
```

`--wait` matters because without it `helm upgrade` returns as soon as the API
server *accepts* the manifests. A release whose pods never become ready is
reported as successful, and the rollback has to be a human noticing. `--atomic`
adds the rollback: a release that fails to become ready inside the timeout is
rolled back to the previous revision rather than left half-applied.

The API endpoint is private (`docs/eks.md` §3), so this runs from inside the
VPC — a bastion, a VPN, or a CI job in a self-hosted runner — not from a laptop.

---

## 2. What is in the chart, and what is deliberately not

| Object | Note |
|---|---|
| `Deployment` | RollingUpdate, `maxUnavailable: 0`, startup + liveness + readiness probes |
| `Service` | ClusterIP, `targetPort` referenced by name |
| `ServiceAccount` | Where the IRSA `eks.amazonaws.com/role-arn` annotation goes |
| `ConfigMap` | `config` values as environment variables, hashed into the pod template |
| `PodDisruptionBudget` | `minAvailable` as a count, checked against the fleet's floor |
| `HorizontalPodAutoscaler` | `autoscaling/v2`, CPU against the request, with an explicit `behavior` |
| `NetworkPolicy` ×2 | A default-deny for this release's pods, and the allowlist — see §2.2 |
| `Ingress` | TLS-only, one certificate over `ingress.hosts` — see [docs/ingress.md](./ingress.md) |

The Ingress renders only when `ingress.enabled` is true, which both environment
files set and the chart defaults do not: the object is meaningless without the
three controllers behind it, and they are installed through Argo CD rather than
by this chart.

The pod security context landed with §2.1 below and the network policy with
§2.2: the rendered pods no longer run with the cluster's defaults, and nothing
in the cluster can reach them that is not named in a values file.

### 2.1 Pod security

The two security contexts together satisfy the [restricted Pod Security
Standard][pss], which is what a namespace labelled
`pod-security.kubernetes.io/enforce: restricted` admits. The chart does not
apply that label — the namespace belongs to the cluster operator — but a chart
that cannot pass the standard takes the label away from them.

| Setting | Where | Why |
|---|---|---|
| `runAsNonRoot: true`, `runAsUser`/`runAsGroup`/`fsGroup: 10001` | pod | Root in a container is root on the node the moment anything else goes wrong |
| `seccompProfile.type: RuntimeDefault` | pod | Absent means `Unconfined`, so leaving it out is the weakest setting, not no setting |
| `allowPrivilegeEscalation: false` | container | Blocks setuid binaries and file capabilities from raising privileges mid-process |
| `privileged: false` | container | Nothing here is an agent or a CSI driver |
| `readOnlyRootFilesystem: true` | container | A compromise cannot drop a binary into the image, and a stray write fails visibly instead of vanishing at the next rollout |
| `capabilities.drop: [ALL]` | container | Drops `CAP_NET_RAW`, `CAP_CHOWN`, `CAP_SETUID` and the rest of containerd's default 14 |

Four things about it are worth knowing before editing the values:

- **The pod/container split is the API's, not a style choice.** Identity
  (`runAsUser`, `runAsGroup`, `fsGroup`) and `seccompProfile` are pod-level;
  `capabilities`, `readOnlyRootFilesystem` and `allowPrivilegeEscalation` are
  container-level and do not exist in a `PodSecurityContext`. The schema closes
  both objects, so a field in the wrong one fails to render rather than being
  accepted and ignored.
- **These are `const` in the schema, not defaults.** An environment file that
  sets `privileged: true` or `readOnlyRootFilesystem: false` is not overriding a
  value, it is opting out of the posture the rest of the chart assumes, and it
  fails at `helm lint`. There is no `--set` that gets past it either.
- **`readOnlyRootFilesystem` costs something, and it is paid in
  `writableVolumes`.** Almost every runtime writes somewhere — Node's inspector
  socket and `os.tmpdir()`, the JVM's `hsperfdata`, Go's `os.CreateTemp`, any
  TLS library spooling a large body. The chart mounts one `emptyDir` at `/tmp`;
  a service that needs another path adds an entry rather than turning the flag
  off. `sizeLimit` is required, because an unbounded `emptyDir` draws on the
  node's shared ephemeral storage and a service that leaks temporary files
  evicts its neighbours before it evicts itself.
- **The scratch volumes are disk-backed on purpose.** `medium: Memory` is not
  offered: a tmpfs `emptyDir` counts against the container's memory limit, and
  `requests.memory == limits.memory` here — so a full `/tmp` arrives as an
  OOMKill with no stack, having quietly shrunk the heap available to the process
  long before that.

`10001` rather than `1000`: a low UID collides with the first real account in
most base images, and inheriting that account's home directory and supplementary
groups is not something the image meant to grant. The UID has to exist in the
image, or `getpwuid()` fails — which most language runtimes call, for
`os.homedir()` and friends, without saying so.

[pss]: https://kubernetes.io/docs/concepts/security/pod-security-standards/

### 2.2 Network policy

The chart renders `<release>-default-deny`, which selects this release's pods
and denies both directions, and `<release>-allow`, which permits the peers named
in `networkPolicy.ingress` and `networkPolicy.egress`. The defaults allow
cluster DNS and HTTPS to AWS outbound, and nothing inbound.

Four things matter before editing that block, and
[docs/network-policies.md](./network-policies.md) has the rest:

- **A NetworkPolicy has no status, and Kubernetes has no policy controller.** On
  a CNI that does not implement policy the objects are stored and ignored —
  accepted, visible in `kubectl get netpol`, enforcing nothing, with no field
  that says so. `EksStack` turns on the VPC CNI's network policy agent, which is
  what makes these objects load-bearing on the clusters this repository creates.
- **One values entry is one peer, so its selectors are ANDed.** Two selectors in
  one `from` element mean "pods matching B in namespaces matching A"; the same
  two as separate elements mean "either". The chart only ever renders the first
  form, so allowing two sources means writing two entries.
- **Ports are the pod's, not the Service's.** kube-proxy rewrites the
  destination to `containerPort` before policy is evaluated, so an ingress entry
  naming `service.port` matches nothing and the connections it was written to
  permit are dropped. `npm run audit:helm` fails on it.
- **`ingress` carries exactly one entry in both environments**: the ingress
  controller. Enabling the chart's Ingress without it is a release that returns
  503 with everything above it reporting healthy, which `npm run audit:helm`
  fails as `ingress-peer-not-allowed`. Because one entry of one shape is the
  whole allowlist, `render-fixtures/` is what keeps the other peer shapes
  rendered by a gate; see §5.

The HPA and the Cluster Autoscaler in `EksStack` are two halves of one thing and
are documented together in [docs/autoscaling.md](./autoscaling.md), including
where every threshold comes from. Two consequences land in this chart and are
worth knowing before reading the templates:

- **With the HPA enabled the Deployment renders no `replicas` field.** If it
  did, every `helm upgrade` would reset the replica count and the HPA would
  climb back — a capacity dip on every deploy. The cost is that a first install
  starts at one pod until the HPA's next sync.
- **`replicaCount` stops reaching the cluster** but stays required, and
  `audit:helm` keeps it inside `[minReplicas, maxReplicas]` so that turning
  autoscaling off changes the mechanism and not the capacity.

Two decisions inside the chart are worth knowing about because they look like
oversights:

- **CPU has a request but no limit; memory has both.** The request is what
  reserves capacity, and a CPU limit adds CFS throttling latency to a service
  that is not otherwise short of CPU. Memory is not compressible, so it carries
  a limit, set equal to the request — which also puts the pod in the Guaranteed
  QoS class.
- **`automountServiceAccountToken: false`.** IRSA credentials arrive through a
  projected token volume the kubelet mounts because of the role-arn annotation,
  not through the service account's Kubernetes API token. Turning the API token
  off leaves AWS access working and removes one credential from the container.

---

## 3. Per-environment values

An environment file lists only what it changes. Helm merges maps deeply, so
`values-production.yaml` setting `resources.requests.cpu` keeps every other key
under `resources` from the defaults.

|  | staging | production |
|---|---|---|
| `replicaCount` | 2 | 4 |
| `autoscaling.minReplicas` / `maxReplicas` | 2 / 4 | 4 / 20 |
| `autoscaling.behavior.scaleDown` window | 300s (default) | 600s |
| `resources.requests` | 50m / 128Mi | 500m / 1Gi |
| `config.LOG_LEVEL` | `debug` | `info` |
| `podDisruptionBudget.minAvailable` | 1 | 3 |
| `terminationGracePeriodSeconds` | 30 (default) | 60 |
| `serviceAccount.annotations` | staging IRSA role | production IRSA role |

The IRSA annotations are the half of `docs/eks.md` §2 that lives outside CDK.
`EksStack.addIrsaRole` writes a trust policy naming one `namespace/serviceaccount`
pair; this annotation names the role from the other side. They have to agree on
both halves, and nothing in Kubernetes checks that they do — a mismatch fails at
the first AWS SDK call the pod makes, not at deploy time.

### The `null` trap

A key set to `null` in a values file **deletes** the chart default rather than
overriding it:

```yaml
# values-production.yaml
resources: null      # not "use the defaults" — the container now has no
                     # requests and no limits at all
```

This is Helm's `CoalesceTables` nullifying rather than assigning, and it is the
single most surprising thing about values files. `npm run audit:helm` reports
every `null` in an environment file as its own violation rather than leaving it
to surface later as a confusing "required property" error.

---

## 4. The schema, and why it is `additionalProperties: false` everywhere

The value of a values schema is not that it documents the keys. It is that a key
that is *not* in it fails the release:

```yaml
replicas: 3        # the Deployment field. The chart value is `replicaCount`.
```

Without `additionalProperties: false` that installs the default replica count
and reports success. The mistake is invisible in review — `replicas` is a real
Kubernetes field — and invisible at deploy time, and shows up as capacity that
was never there.

So every object in the schema closes: `additionalProperties: false` for a fixed
set of keys, or a typed `additionalProperties` for a genuinely free-form map
such as `annotations` or `config`. `npm run audit:helm` walks the schema and
fails on any object node that does neither, because one dropped line reopens a
subtree without changing anything else that a reader would notice.

The rules the schema carries that are policy rather than typing:

- **`image.tag` may not be `latest`, `main`, `master`, `stable`, `edge`, `dev`
  or `prod`.** With a moving tag the running image is a function of when a pod
  last restarted: two pods in one ReplicaSet can serve different code, and a
  rollback has no fixed target to return to.
- **`resources` is required**, with `requests.cpu`, `requests.memory` and
  `limits.memory`. A container with no requests is scheduled BestEffort and is
  the first thing evicted under node pressure; one with no memory limit can take
  every other pod on its node down with it. `requests.cpu` is also the
  denominator of the HPA's percentage: without it the HPA reports `<unknown>`
  and scales nothing, silently and only under the load meant to trigger it.
- **`autoscaling.minReplicas` may not be 0.** Scaling to zero needs the
  `HPAScaleToZero` feature gate, which EKS does not enable, so the manifest is
  rejected by the API server — after the Deployment in the same release has
  already been updated.
- **A scale-down `stabilizationWindowSeconds` below 60 is refused.** Zero is
  legal Kubernetes and it flaps: the HPA removes pods on the first low sample
  and adds them back on the next, which turns ordinary traffic noise into a
  rollout. The floor is deliberately below Kubernetes' own default of 300, so a
  service with genuinely short troughs can opt into a faster one.
- **`config` values must be strings.** ConfigMap data is string-valued, so an
  unquoted `PORT: 8080` is rejected by the API server at apply time — after the
  release has started. Here it is rejected at lint time.
- **`environment` is an enum of the environments that exist**, so a release
  cannot claim to be one that has no values file.

### What the schema cannot do

JSON Schema cannot compare two properties, so these are in
`aws/cdk/tools/audit-helm-values.ts` instead:

- `podDisruptionBudget.minAvailable` must stay below the fleet's **floor** —
  `autoscaling.minReplicas` when the HPA is on, `replicaCount` when it is not. A
  budget equal to the floor permits no voluntary disruption at all: `kubectl
  drain` blocks forever, and every node rotation, cluster upgrade and Cluster
  Autoscaler scale-down stalls on it. It is a PDB that protects the service from
  the platform by stopping the platform. Checking against `replicaCount` while
  an HPA is running would miss it entirely: `minAvailable: 4` looks generous
  against eight replicas and blocks every drain once the fleet settles to four.
- Production may not run a single replica, floor included.
- `autoscaling.maxReplicas` must be above `minReplicas`. Equal is accepted by
  Kubernetes and reports itself healthy while pinning the fleet at one size.
- `replicaCount` must sit inside the HPA's range. It reaches nothing while
  autoscaling is on and becomes the fleet size the moment it is turned off.
- `values-production.yaml` must declare `environment: production`. A file that
  leaves it to the default deploys production pods labelled `staging`, and the
  label is what an incident responder reads.
- **No capability may be granted back after `drop: [ALL]`**, except the ones in
  `ALLOWED_ADDED_CAPABILITIES` — today just `NET_BIND_SERVICE`. The list is in
  code rather than in the schema so that adding to it is a reviewed change with
  a reason attached, the same shape as `lib/checkov-suppressions.ts`.
- **`containerPort` below 1024 requires `NET_BIND_SERVICE`**, and having it
  without a privileged port is reported too. A non-root container that drops
  every capability and declares `containerPort: 80` is admitted, rolls out
  cleanly, and then fails with `EACCES` on `bind()` — a CrashLoopBackOff whose
  cause is two values that are each individually fine. The fix is almost always
  to listen above 1024 and let `service.port` map 80 to it.
- **Two `writableVolumes` may not share a name or a mount path.** The API server
  rejects the duplicate name at apply time, after CI was green, with an error
  that names the pod rather than the values file; a duplicated mount path is
  accepted and one of the two silently wins.
- **An ingress allowlist entry must name a port the pods listen on.** Writing
  `service.port` there is the common form of this and it matches nothing, since
  kube-proxy rewrites the destination first. Reported as
  `ingress-port-mismatch`, which says when the number is `service.port`.
- **`networkPolicy.enabled: false` is reported.** It exists for a cluster whose
  CNI cannot enforce policy — not as a way to unblock a service, which is what
  it would otherwise be reached for first.
- **DNS must be reachable.** `dns.enabled: false` with no egress entry allowing
  port 53 is a release whose every name lookup times out, and the symptom is
  five-second latency rather than anything naming the network
  (`dns-egress-blocked`).
- **An egress `ipBlock` must except the instance metadata address** if it
  contains it (`metadata-service-reachable`), and an ingress entry may not admit
  `0.0.0.0/0` (`ingress-from-anywhere`). Neither is expressible in JSON Schema,
  which cannot reason about what a CIDR contains.
- **Two allowlist entries may not share a `name`.** The name never reaches the
  cluster, so this breaks no deploy — it breaks every message about the rule,
  including the ones above.

---

## 5. The gates

Two, and they run in different jobs for a reason.

**`npm run audit:helm`** (in the `CDK typecheck, test, synth` job) validates
with [ajv], which is already a dependency, so it needs no Helm binary. It covers
schema hygiene, environment coverage, the cross-field rules above, and the
merged values for every environment.

**`.github/scripts/lint-helm-chart.sh`** (in the `Helm chart` job) runs
`helm lint --strict` and `helm template` per environment, renders every
`render-fixtures/` file, and requires every `schema-fixtures/` file to fail. The
validator that decides whether a real `helm upgrade` succeeds is Helm's own
(`xeipuuv/gojsonschema`), a different implementation of the same draft from
ajv's — a schema checked only against ajv has not been checked against the tool
that enforces it.

Both are wired to `k8s/charts/*`, so a second chart is covered the day it is
added.

### The fixtures

A schema stops being a gate quietly: a `required` entry is lost in a refactor,
an `additionalProperties: false` is dropped to let one key through, and the
schema goes on passing every valid file while catching nothing. A passing gate
and a gate with nothing left to catch look identical.

`k8s/charts/app/schema-fixtures/` is what tells them apart — sixteen values
files that must each be **rejected**, checked against the specific keyword that
should catch each one:

| Fixture | Keyword |
|---|---|
| `unknown-key.yaml` | `additionalProperties` |
| `unknown-environment.yaml` | `enum` |
| `mutable-image-tag.yaml` | `not` |
| `non-string-config-value.yaml` | `type` |
| `nullified-required-key.yaml` | `required` |
| `zero-min-replicas.yaml` | `minimum` |
| `flapping-scale-down.yaml` | `minimum`, in the `allOf` branch over `hpaScalingRules` |
| `privileged-container.yaml` | `const` |
| `writable-root-filesystem.yaml` | `const` |
| `capabilities-retained.yaml` | `contains` |
| `root-user.yaml` | `minimum` |
| `unconfined-seccomp.yaml` | `enum` |
| `network-policy-open-namespace-selector.yaml` | `minProperties` |
| `network-policy-rule-without-ports.yaml` | `required` |
| `network-policy-named-egress-port.yaml` | `type`, in the `allOf` branch over `networkPolicyRule` |
| `network-policy-peerless-rule.yaml` | `anyOf` |

The five security fixtures are asserted against those keywords rather than
against "some error", because each one has a near-miss that would pass. Dropping
`NET_RAW` and `SYS_CHROOT` is a perfectly valid list of capabilities — what has
to catch it is `contains: ALL`, not the item type. `runAsUser: 0` beside
`runAsNonRoot: true` is two individually valid values, so what catches it is the
`minimum` on the UID and not the `const` on the boolean. `namespaceLabels: {}` is
a valid selector that happens to match every namespace in the cluster, so what
catches it is `minProperties` and not anything about the labels themselves.

`aws/cdk/test/audit-helm-values.test.ts` asserts the ajv side; the shell script
asserts Helm's. Checked against the failure it names: removing the root
`additionalProperties: false` makes the script exit 1 on `unknown-key.yaml` and
the audit exit 1 with `schema-open-object`.

### The render fixtures

The mirror image, and it covers the templates rather than the schema. A chart's
gates only execute the template paths its own values files reach, so an
`{{- if }}` around a whole object — or a `range` over a list both environments
leave empty — is rendered by nothing and is therefore unchecked. Today that is
the NetworkPolicy ingress allowlist, which is empty in `values.yaml` and in both
environment files and correctly so.

`k8s/charts/app/render-fixtures/` holds values files that must **render**. The
shell script runs `helm template` over each; the jest suite asserts the schema
still accepts them, and that they still exercise something the environment files
do not — otherwise a fixture could be quietly reduced to a copy of the defaults
and go on passing.

---

## 6. Adding an environment

Four edits, and the gates fail until all four are made:

1. `k8s/charts/app/values-<env>.yaml`, declaring `environment: <env>`.
2. The `environment` enum in `values.schema.json`.
3. `ENVIRONMENTS` in `aws/cdk/tools/audit-helm-values.ts`.
4. The `EksStack-<Env>` instance in `aws/cdk/bin/app.ts`, if it needs its own
   cluster.

A values file with no entry in `ENVIRONMENTS` is reported as an orphan rather
than ignored: an unreferenced values file drifts silently and is then trusted by
whoever finally uses it.

---

## 7. What this does not cover

- **Nothing is deployed.** Both gates are lint-and-render: they prove the chart
  produces well-formed manifests for both environments, not that a release comes
  up healthy on a cluster. There is no cluster in CI.
- **No deploy workflow, deliberately.** `workflow-templates/` has no
  `deploy-helm.yml`: the rollout path is GitOps
  ([docs/gitops-argocd.md](./gitops-argocd.md)), and a pipeline holding cluster
  credentials beside it would be a second, unreviewed way in.
- **Checkov does not scan the rendered manifests.** Its Kubernetes checks are
  almost entirely pod-security checks — non-root, read-only root filesystem,
  dropped capabilities, seccomp — all of which `values.schema.json` now fixes as
  `const` rather than defaults, with a must-fail fixture per rule. Wiring the
  scan up would duplicate that gate against a weaker one.
- **No `helm test` hooks and no chart-testing (`ct`) install test**, for the
  same reason as the first point: both want a cluster.
- **No policy has been observed to permit or deny a packet.** §2.2 and
  [docs/network-policies.md](./network-policies.md) describe manifests and
  documented CNI behaviour; nothing in CI runs a cluster that could enforce
  them.

[ajv]: https://ajv.js.org
