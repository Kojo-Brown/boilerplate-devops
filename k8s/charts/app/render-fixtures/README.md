# Render fixtures

Values files that must **render**. Nothing installs them.

`schema-fixtures/` is the other half of this pair and holds files that must be
*rejected* — it keeps the schema from quietly stopping to catch anything. These
keep the *templates* from quietly stopping to render anything, which is the
same failure one layer down.

A chart's gates only ever execute the template paths its own values files
reach. Every optional block — an `{{- if }}` around a whole object, a `range`
over a list that is empty in both environments — is unrendered by `helm
template` in CI and therefore unchecked, so a broken one is found by the next
person to turn the feature on.

| File | Template path it covers |
|---|---|
| `network-policy-allowlist.yaml` | `networkPolicy.ingress` entries, all three peer shapes, and both port forms |
| `ingress-overrides.yaml` | several hosts, an adopted TLS secret, pass-through controller annotations, a non-default `pathType` |

`network-policy-allowlist.yaml` predates the Ingress and still earns its place:
the environment files now carry one ingress allowlist entry each, and it is the
same shape in both, so the `cidr`+`except` peer and the same-namespace
`podLabels`-only peer are reached by nothing else.

`.github/scripts/lint-helm-chart.sh` renders each of these with
`helm template --kube-version`, so a fixture that produces invalid YAML or trips
the values schema fails the `Helm chart` job.
`aws/cdk/test/audit-helm-values.test.ts` asserts the schema accepts each one and
that every file here is covered — a fixture that has drifted into being rejected
would otherwise turn into a render the script silently stops performing.

These are **not** environment values. `tools/audit-helm-values.ts` reads
`values-<environment>.yaml` at the chart root and nothing under this directory,
so a fixture here is neither audited as an environment nor mistaken for a
missing one.
