# Schema fixtures

Values files that `values.schema.json` must **reject**. Nothing installs them.

A schema is only a gate if a violation actually fails, and the way that stops
being true is quiet: a `required` list loses an entry in a refactor, an
`additionalProperties: false` is dropped to let one key through, and the schema
goes on passing every valid file while catching nothing. Each file here is one
violation, checked against the specific keyword that should catch it:

| File | Violation | Keyword |
|---|---|---|
| `unknown-key.yaml` | `replicas` instead of `replicaCount` | `additionalProperties` |
| `unknown-environment.yaml` | an environment with no values file | `enum` |
| `mutable-image-tag.yaml` | `image.tag: latest` | `not` |
| `non-string-config-value.yaml` | an unquoted number in `config` | `type` |
| `nullified-required-key.yaml` | `resources: null`, which deletes rather than overrides | `required` |
| `zero-min-replicas.yaml` | `autoscaling.minReplicas: 0` without the HPAScaleToZero gate | `minimum` |
| `flapping-scale-down.yaml` | a scale-down with no stabilization window | `minimum` (via `allOf`) |
| `privileged-container.yaml` | `securityContext.privileged: true` | `const` |
| `writable-root-filesystem.yaml` | `readOnlyRootFilesystem: false` | `const` |
| `capabilities-retained.yaml` | named capabilities dropped instead of `ALL` | `contains` |
| `root-user.yaml` | `podSecurityContext.runAsUser: 0` | `minimum` |
| `unconfined-seccomp.yaml` | `seccompProfile.type: Unconfined` | `enum` |

The last five each have a near-miss that would pass a looser assertion, which is
why the keyword matters and not just the failure. `drop: [NET_RAW, SYS_CHROOT]`
is a valid list of capabilities that happens not to include the one that counts,
so `contains` is what catches it. `runAsUser: 0` and `runAsNonRoot: true` are
individually valid and only contradict each other, which JSON Schema cannot see
— so root is excluded by the `minimum` on the UID instead.

`aws/cdk/test/audit-helm-values.test.ts` asserts each is rejected, and by the
keyword named above rather than by any error at all. `.github/scripts/lint-helm-chart.sh`
runs `helm lint` over the same files, because the schema that matters at deploy
time is the one Helm's own validator reads, not the one `ajv` does.
