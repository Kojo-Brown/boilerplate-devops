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

`aws/cdk/test/audit-helm-values.test.ts` asserts each is rejected, and by the
keyword named above rather than by any error at all. `.github/scripts/lint-helm-chart.sh`
runs `helm lint` over the same files, because the schema that matters at deploy
time is the one Helm's own validator reads, not the one `ajv` does.
