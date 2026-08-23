# Helm: the `app` chart, per-environment values, and a schema that is a gate

`k8s/charts/app` is the application delivery path the EKS cluster did not have.
It installs a stateless HTTP service — Deployment, Service, ServiceAccount wired
for IRSA, a configuration ConfigMap, and a PodDisruptionBudget — and every value
it accepts is constrained by `values.schema.json`.

```
k8s/charts/app/
├── Chart.yaml
├── values.yaml                 defaults, and the documentation of every key
├── values.schema.json          the contract Helm enforces on every install
├── values-staging.yaml         only what staging changes
├── values-production.yaml      only what production changes
├── schema-fixtures/            values files the schema must reject
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
| `PodDisruptionBudget` | `minAvailable` as a count, checked against `replicaCount` |

Not here, and each its own Phase 8 item: the HPA and Cluster Autoscaler
thresholds, the pod security context (non-root, read-only rootfs, dropped
capabilities, seccomp), the default-deny NetworkPolicy, the ArgoCD app-of-apps,
and the Ingress with cert-manager. The chart is the delivery path; hardening it
and automating its rollout come next. **Until the pod security item lands, the
rendered pods run with the cluster's defaults** — that is a real gap, not an
omission from the docs.

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
  every other pod on its node down with it.
- **`config` values must be strings.** ConfigMap data is string-valued, so an
  unquoted `PORT: 8080` is rejected by the API server at apply time — after the
  release has started. Here it is rejected at lint time.
- **`environment` is an enum of the environments that exist**, so a release
  cannot claim to be one that has no values file.

### What the schema cannot do

JSON Schema cannot compare two properties, so these are in
`aws/cdk/tools/audit-helm-values.ts` instead:

- `podDisruptionBudget.minAvailable` must stay below `replicaCount`. A budget
  equal to the replica count permits no voluntary disruption at all: `kubectl
  drain` blocks forever, and every node rotation and cluster upgrade stalls on
  it. It is a PDB that protects the service from the platform by stopping the
  platform.
- Production may not run a single replica.
- `values-production.yaml` must declare `environment: production`. A file that
  leaves it to the default deploys production pods labelled `staging`, and the
  label is what an incident responder reads.

---

## 5. The gates

Two, and they run in different jobs for a reason.

**`npm run audit:helm`** (in the `CDK typecheck, test, synth` job) validates
with [ajv], which is already a dependency, so it needs no Helm binary. It covers
schema hygiene, environment coverage, the cross-field rules above, and the
merged values for every environment.

**`.github/scripts/lint-helm-chart.sh`** (in the `Helm chart` job) runs
`helm lint --strict` and `helm template` per environment. The validator that
decides whether a real `helm upgrade` succeeds is Helm's own
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

`k8s/charts/app/schema-fixtures/` is what tells them apart — five values files
that must each be **rejected**, checked against the specific keyword that should
catch each one:

| Fixture | Keyword |
|---|---|
| `unknown-key.yaml` | `additionalProperties` |
| `unknown-environment.yaml` | `enum` |
| `mutable-image-tag.yaml` | `not` |
| `non-string-config-value.yaml` | `type` |
| `nullified-required-key.yaml` | `required` |

`aws/cdk/test/audit-helm-values.test.ts` asserts the ajv side; the shell script
asserts Helm's. Checked against the failure it names: removing the root
`additionalProperties: false` makes the script exit 1 on `unknown-key.yaml` and
the audit exit 1 with `schema-open-object`.

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
- **No deploy workflow.** `workflow-templates/` has no `deploy-helm.yml` yet;
  the rollout path is GitOps, which is its own Phase 8 item, and a
  `helm upgrade` workflow written now would be replaced by it.
- **Checkov does not scan the rendered manifests.** Its Kubernetes checks are
  almost entirely pod-security checks — non-root, read-only root filesystem,
  dropped capabilities, seccomp — which is the *next* Phase 8 item. Wiring the
  scan up before that item lands would mean either implementing it early or
  writing a suppression list that then has to be unwound.
- **No `helm test` hooks and no chart-testing (`ct`) install test**, for the
  same reason as the first point: both want a cluster.

[ajv]: https://ajv.js.org
