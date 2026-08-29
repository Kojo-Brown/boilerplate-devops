# GitOps with Argo CD: app-of-apps, sync waves, and drift

`k8s/argocd/` describes what each EKS cluster runs. One Argo CD per cluster, one
root Application per Argo CD, and everything below it — the projects that bound
what may be deployed, the add-ons, the application release — described by files
that a pull request changes and a cluster converges on.

The theme of this document is the same one that runs through
`docs/network-policies.md`: most of the ways a GitOps setup fails do not look
like failures. An application whose self-heal was never enabled reports the
drift it is not correcting. An app-of-apps whose waves are in the right order
does not wait for the wave underneath it. A production Application rendering
staging's values deploys, becomes Healthy, and serves traffic. None of that
fails a `kubectl apply`, and none of it fails an Argo CD sync.

---

## 1. Bootstrapping a cluster

Three steps, in this order, per cluster.

**Install Argo CD.** It is not installed by anything in this repository — see
§8. Pin the version:

```bash
kubectl create namespace argocd
kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.2/manifests/install.yaml
```

**Restore the health assessment of `Application`.** Argo CD removed the
built-in health check for its own `Application` kind in 1.8, and without it sync
waves between child applications do not wait for anything — §4 is about exactly
this. The upstream fix is a resource customization:

```bash
kubectl patch configmap argocd-cm -n argocd --type merge --patch '
data:
  resource.customizations.health.argoproj.io_Application: |
    hs = {}
    hs.status = "Progressing"
    hs.message = ""
    if obj.status ~= nil then
      if obj.status.health ~= nil then
        hs.status = obj.status.health.status
        if obj.status.health.message ~= nil then
          hs.message = obj.status.health.message
        end
      end
    end
    return hs
'
```

**Apply the root.** One file, one command, and everything else follows:

```bash
aws eks update-kubeconfig --name staging-eks --region us-east-1
kubectl apply -f k8s/argocd/staging/root.yaml
```

That file holds two documents — an `AppProject` called `bootstrap` and the root
`Application` that belongs to it. The root reads `k8s/argocd/staging/`, applies
the two projects and the two applications under it, and from then on the cluster
follows `main`.

---

## 2. The trust root is applied by hand, and nothing manages it

`root.yaml` is the one manifest in this tree that no Argo CD applies. Its
`include` pattern covers `projects/*.yaml` and `applications/*.yaml` and nothing
else, so the root Application does not manage the file that declares it or the
project that bounds it. `npm run audit:argocd` fails if that stops being true.

Self-management is a common and reasonable pattern, and it is rejected here for
one reason: it makes the boundary something that whatever gets through it can
widen. The `bootstrap` project is what limits the root Application to
Applications and AppProjects in the `argocd` namespace. If the root managed that
project, a pull request that widened it would be applied by the thing it widens,
and a pull request that deleted it would prune it — leaving Argo CD with an
Application referencing a project that no longer exists, and no path back except
the file that was just pruned.

The cost is that drift on those two objects is not corrected. It is a cost worth
naming: an edit to the `bootstrap` project on the cluster stays until somebody
re-applies the file. The recovery is `kubectl apply -f root.yaml`, which is the
same command that created it.

Argo CD's own documentation is blunt about the shape of this risk: app-of-apps
is an admin-only tool, only admins should have push access to the parent
Application's source repository, and the `project` field of each child is the
field to read carefully in review. `argocd-namespace-target` in the audit is the
mechanical half of that — a child Application deploying into the `argocd`
namespace can rewrite every project in the cluster, and only the root has any
business being there.

---

## 3. Two projects, because add-ons and releases need different things

| | `platform` | `app` |
|---|---|---|
| Deploys | cluster add-ons | the application release |
| Namespace | `kube-system` | `staging` / `production` |
| Cluster-scoped resources | `APIService`, `ClusterRole`, `ClusterRoleBinding` | its own `Namespace`, by name |
| Orphaned-resource warnings | off | on |

The split exists because metrics-server cannot be confined to a namespace: an
add-on that extends the Kubernetes API needs an `APIService` and the RBAC that
lets the API server delegate authentication to it. The application release needs
none of that, and giving it the same project would hand every chart bump the
ability to create a `ClusterRoleBinding`.

Two Argo CD semantics matter when reading these files:

- **Cluster-scoped resources are restricted by allow-list; namespaced ones by
  deny-list.** So `clusterResourceWhitelist: []` is a closed door, while an empty
  `namespaceResourceBlacklist` is an open one. That asymmetry is why the
  `bootstrap` project states its namespaced permissions as a *whitelist* instead.
- **A cluster-scoped entry may be restricted by name.** The `app` project permits
  exactly one: `Namespace` named `staging` (or `production`), which is what
  `CreateNamespace=true` needs and nothing more.

`PLATFORM_CLUSTER_KINDS` in `aws/cdk/tools/audit-argocd.ts` is the ceiling on the
first row of that table. Adding a kind to a project without adding it there fails
the audit, which is the point: it is the list that decides what a compromised
upstream chart can do to the cluster, so it should be widened in a diff with a
reason attached rather than in a routine version bump.

---

## 4. What a sync wave orders, and what it does not

The tree uses three waves:

| Wave | What is in it |
|---|---|
| `-10` | the `platform` and `app` AppProjects |
| `0` | metrics-server |
| `10` | the application release |

Argo CD applies resources from the lowest wave upward, inserting a delay between
waves (2 seconds, `ARGOCD_SYNC_WAVE_DELAY`) and advancing only once the current
wave is synced and healthy. During a *prune* the order reverses, so the release
is removed before the add-ons it depends on.

The projects being in the first wave is a real dependency: an Application naming
a project that does not exist is admitted by the API server and then reports a
comparison error, which reads like a broken application rather than a race.

**The second ordering is weaker than it looks, and this is the part worth
knowing.** Argo CD removed the health assessment of its own `Application` kind in
1.8. Without the `argocd-cm` customization in §1, a child Application has no
health of its own — the controller's own comment says a "Missing or Unknown
health status of child Argo CD app should not affect parent" — so the parent's
wave gate has nothing to wait on. Wave 0 completes when the metrics-server
*Application object* has been created, not when metrics-server is running, and
wave 10 follows about two seconds later.

The practical consequence on a fresh cluster is mild — the release starts, its
HPA reports `<unknown>` for a minute or two, then starts working — which is
precisely why it is worth writing down: nothing about it looks like a failure,
so an assumption that waves sequence add-ons before workloads survives
indefinitely and is wrong wherever the dependency is harder than this one. Apply
the customization, and the wave gate becomes what the annotation implies.

Equal waves are not an ordering either. Within a wave Argo CD sorts by kind and
then by name, so `app-staging` before `metrics-server` is alphabetical
coincidence. `sync-wave-ordering` in the audit treats a shared wave as a
violation for that reason.

---

## 5. What promotes a change

The image tag in `k8s/charts/app/values-production.yaml`, committed to `main`.

Both root Applications track `main`, and both releases render the chart from
`main`. The environments differ only in which values file they render, so a
change to the chart reaches staging and production on the same commit, while a
change to an image tag reaches exactly one environment. A deployment pipeline
under this model builds an image, pushes it, and opens or commits a one-line
change to a values file; it holds no cluster credentials at all.

The other defensible arrangement is a production root pinned to a release tag
while staging follows `main`, which moves the promotion into `targetRevision` and
gives chart changes their own promotion step. It is a larger change than it
looks — the tag has to be created by something, and the "what is deployed"
question moves from a values file to a git tag — so it is not the default here.

What is *not* a promotion mechanism is `targetRevision: HEAD`, which the audit
rejects. It resolves to whatever the repository's default branch is at the time,
so renaming that branch repoints every cluster silently, and reading the manifest
tells you nothing about which branch a cluster follows.

---

## 6. Drift, in three layers

**Layer 1 — self-heal.** `syncPolicy.automated.selfHeal: true` on every
Application. Argo CD compares live state against the rendered manifests and
reverts what does not match, roughly 5 seconds after noticing (the
`--self-heal-timeout-seconds` default) and within one reconciliation period of
the change (120 seconds plus up to 60 seconds of jitter, or immediately on a
webhook).

Self-heal is inside `automated`, which is the reason production is on automated
sync rather than manual. A manually-synced production application is one where
drift is detected, displayed, and left — the environment where drift matters
most would be the one with no correction.

That choice has a price, and it is not the one people expect. Argo CD **refuses
to roll back an application with automated sync enabled**: the way back from a
bad release is a revert commit, not a button. `--atomic --wait` in the Helm
comments in `values-production.yaml` is a different mechanism that does not
apply here either — Argo CD renders with `helm template` and applies the result,
so there is no Helm release to roll back and no `--wait` to fail. What replaces
them is the health assessment plus `retry`, and a revert.

**Layer 2 — orphaned resources.** Self-heal only reconciles resources an
Application already manages. A Deployment created beside the release during an
incident, a Secret applied by hand, a Job left behind by a migration: these
belong to no Application, so nothing reverts them, nothing prunes them, and
nothing mentions them. `orphanedResources: { warn: true }` on the `app` project
reports them.

It is enabled there and not on `platform` for the reason Argo CD's documentation
gives: watching a namespace full of resources Argo CD did not create has real
performance cost, and `kube-system` is exactly that namespace. The `staging` and
`production` namespaces hold one release each, and Kubernetes' own additions —
the `default` ServiceAccount, the `kube-root-ca.crt` ConfigMap — are already
exempt, so a warning there means a person put something in the namespace and did
not commit it.

**Layer 3 — a report from outside the cluster.**
`workflow-templates/argocd-drift-report.yml` is a scheduled read of the Argo CD
API that fails when anything is OutOfSync, unhealthy, running without automated
sync or self-heal, or carrying an orphaned-resource warning. It exists because
the first two layers are both inside the cluster and both report into a UI:

- A sync that keeps *failing* leaves an application OutOfSync indefinitely.
  Self-heal retries forever, and the git history looks like the change landed.
- An application switched to manual sync from the UI during an incident — by
  someone who meant to switch it back — stops correcting drift entirely.
- An orphaned-resource warning is a condition on an Application that nobody is
  looking at.

---

## 7. What the gates check

`npm run audit:argocd` runs in the `CDK typecheck, test, synth` job on every pull
request. It reads `k8s/argocd/` and checks roughly thirty things the API server
and Argo CD both accept: a project that does not exist, a destination the project
does not permit, a `selfHeal` that is off, a chart version that is a range, a
staging Application rendering `values-production.yaml`, a manifest in the tree
that the root's `include` pattern does not match, a wave annotation that is a
YAML integer rather than a string. The header comment in
`aws/cdk/tools/audit-argocd.ts` lists every rule with the failure it prevents.

Two of those rules deserve their own note:

- **`unmanaged-manifest`.** A manifest inside a tree that the root Application's
  `include` does not match is committed, reviewed, and applied by nothing — it
  reads as deployed to everyone looking at the repository. Checking it means
  reimplementing Argo CD's glob matching, which is gobwas/glob compiled with *no
  separator runes*: `*` matches `/` as well, so `*.yaml` matches
  `projects/app.yaml` and everything nested below it. The audit implements the
  subset those patterns need and refuses anything else with
  `include-pattern-unsupported`, rather than approximating the match and
  reporting on a file set the cluster does not use.
- **`trees-not-parallel`.** The two environments must hold the same files. It is
  the same guarantee `npm run audit:helm` gives `values-staging.yaml` and
  `values-production.yaml`, one level up: a control plane change that reaches
  production without being exercised in staging is the failure this repository's
  environment split exists to prevent.

`k8s/argocd/fixtures/` holds twenty manifests the audit must reject, each
asserted in `aws/cdk/test/audit-argocd.test.ts` against the specific rule that
must catch it. An audit only stops being a gate quietly, and a fixture that
started failing for a different reason would otherwise look like it was still
working.

---

## 8. What this does not cover

**Argo CD itself is not installed by this repository.** §1 installs it with
`kubectl apply` from an upstream manifest; nothing here pins that manifest by
digest, configures SSO, sets up ingress, or manages the `argocd-cm`
customization the wave ordering in §4 needs. An Argo CD that installs and
upgrades itself through this tree is the natural next step and is a real design
decision — a self-managed Argo CD can break its own upgrade path.

**Nothing here has been applied to a cluster.** There is no cluster in CI and
none was created. Everything above is a property of these manifests plus
documented Argo CD behaviour: the gates parse, cross-check and reject: they do
not observe a sync.

**One Argo CD per cluster, and neither knows about the other.** There is no
management cluster, no cluster secret, and no `ApplicationSet` — the two trees
are parallel copies kept honest by an audit rule rather than generated from one
source. An `ApplicationSet` with a git generator would remove the duplication and
add a controller whose failure mode is generating the wrong applications; with
two environments and four files each, the duplication is the cheaper of the two.

**Notifications are not configured.** `argocd-notifications` can subscribe to
sync and health events and push them to Slack or a webhook. The drift report in
§6 is the poll-based substitute, and it is coarser: it says what is wrong on a
schedule rather than the moment it happens.

**No progressive delivery.** A sync applies the new manifests and the Deployment
does a rolling update. The blue/green and canary paths in this repository
(`aws/cdk/lib/blue-green-deploy-stack.ts`, `canary-deploy-stack.ts`) are ECS, not
EKS; the Kubernetes equivalent is Argo Rollouts, which is a controller and a
`Rollout` kind, not a setting.

**The application release is the only workload.** There is no ingress controller
(the chart's NetworkPolicy ingress allowlist is still empty for that reason), no
cert-manager, no external-dns and no observability stack — those are the next
`platform` applications, and each is one file in `applications/` per environment.
