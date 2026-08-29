# Argo CD fixtures

Manifests that `npm run audit:argocd` must **reject**. Nothing applies them.

They sit here, outside `staging/` and `production/`, on purpose: every file
inside an environment tree is a file some cluster's root Application applies, so
a manifest that must never reach a cluster cannot live in one. The
`stray-manifest` rule fails the audit if a manifest is dropped anywhere else
under `k8s/argocd/`, which is what stops one of these from being moved into a
tree during a refactor.

The audit only stops being a gate quietly. A rule loses its call site in a
refactor, a condition inverts, an `if` moves one level out — and the audit goes
on passing every conforming tree while catching nothing. Each file here is one
mistake, asserted in `aws/cdk/test/audit-argocd.test.ts` against the rule that
must catch it:

| File | Mistake | Rule |
|---|---|---|
| `application-without-finalizer.yaml` | deletion orphans every resource the release created | `missing-finalizer` |
| `application-without-self-heal.yaml` | drift is detected and left in place | `drift-uncorrected` |
| `application-without-automated-sync.yaml` | no automated sync, so self-heal has nowhere to live | `drift-uncorrected` |
| `application-without-prune.yaml` | deleting a file removes nothing from the cluster | `prune-disabled` |
| `application-allow-empty.yaml` | an empty render prunes the whole release | `allow-empty-enabled` |
| `application-tracking-head.yaml` | `targetRevision: HEAD` | `mutable-target-revision` |
| `application-floating-chart-version.yaml` | a chart version range | `mutable-target-revision` |
| `application-unknown-project.yaml` | a project no AppProject declares | `unknown-project` |
| `application-foreign-values-file.yaml` | staging rendering `values-production.yaml` | `values-file-mismatch` |
| `application-outside-project-destination.yaml` | a namespace the project does not permit | `destination-not-permitted` |
| `application-from-foreign-repo.yaml` | a repository the project does not permit | `source-not-permitted` |
| `application-into-argocd-namespace.yaml` | a child Application deploying beside Argo CD itself | `argocd-namespace-target` |
| `application-with-ambiguous-destination.yaml` | `destination.name` and `destination.server` together | `ambiguous-destination` |
| `application-without-release-name.yaml` | the Helm release name left to default | `release-name-not-pinned` |
| `application-without-namespace-creation.yaml` | a destination namespace nothing creates | `namespace-not-created` |
| `application-without-sync-wave.yaml` | no wave annotation | `missing-sync-wave` |
| `application-unquoted-sync-wave.yaml` | an unquoted wave, which is a YAML integer | `annotation-not-a-string` |
| `application-sharing-platform-wave.yaml` | a workload in the same wave as the add-on it reads | `sync-wave-ordering` |
| `project-with-wildcard-destination.yaml` | `namespace: "*"` in a workload project | `open-project-scope` |
| `project-granting-cluster-rbac.yaml` | a workload project permitting ClusterRoleBindings | `cluster-scope-escalation` |

Several files trip more than one rule, because the mistakes are not independent:
an Application pointed at `staging-canary` is both outside its project's
destinations and outside its own environment's namespace, and one pointed at
`argocd` is both an admin escalation and a destination the project never
permitted. The table names the rule each file exists for, and the test asserts
that rule specifically rather than "some violation" — a fixture that started
failing for a different reason would otherwise look like it was still working.

The mistakes themselves are all things Kubernetes and Argo CD accept. Every one
of these manifests is admitted by the API server; most of them produce a running
application. That is the point: what fails here is not schema validity, it is
what the file quietly means.
