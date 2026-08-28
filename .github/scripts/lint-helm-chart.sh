#!/usr/bin/env bash
#
# Lint and render every chart under k8s/charts, once per environment, and prove
# the values schema still rejects what it claims to.
#
# `npm run audit:helm` validates the same values with ajv, which is what lets
# the check run in the CDK job without a Helm binary. This is the other half:
# the validator that decides whether a real `helm upgrade` succeeds is Helm's
# own (`xeipuuv/gojsonschema`), not ajv, and the two are different
# implementations of the same draft. A schema that only ever passes through ajv
# is a schema nobody has checked against the tool that enforces it.
#
# Four things happen per chart:
#
#   1. `helm lint --strict` on the chart's own defaults. Warnings are errors:
#      the ones Helm emits are things like an unparseable template or an
#      icon-less Chart.yaml, and the first class is never acceptable.
#   2. `helm lint --strict` and `helm template` per environment values file, so
#      a values file that renders invalid YAML fails here rather than at apply
#      time.
#   3. Every file in `render-fixtures/` must *render*. A chart's gates only
#      execute the template paths its own values files reach, so an optional
#      block that both environments leave off — the NetworkPolicy ingress
#      allowlist, today — is unchecked until someone turns it on. These turn
#      those paths on.
#   4. Every file in `schema-fixtures/` must be *rejected*. A gate that has
#      stopped catching anything looks exactly like a gate with nothing to
#      catch, and these are what tell the two apart.
#
# `--kube-version` is passed explicitly so the render does not depend on which
# Kubernetes version the local Helm build happens to default to; the value is
# the cluster version EksStack creates (docs/eks.md §4).
#
# Usage:
#   .github/scripts/lint-helm-chart.sh [charts-directory]

set -euo pipefail

charts_directory="${1:-k8s/charts}"
kube_version="${KUBE_VERSION:-1.33.0}"

if ! command -v helm >/dev/null 2>&1; then
  echo "helm is not installed; install it or run this in CI." >&2
  exit 2
fi

if [ ! -d "$charts_directory" ]; then
  echo "no such directory: $charts_directory" >&2
  exit 2
fi

shopt -s nullglob

charts=("$charts_directory"/*/)
if [ ${#charts[@]} -eq 0 ]; then
  echo "no charts under $charts_directory" >&2
  exit 2
fi

failures=0

for chart in "${charts[@]}"; do
  chart="${chart%/}"
  name="$(basename "$chart")"

  echo "==> $chart: lint (chart defaults)"
  helm lint "$chart" --strict

  for values in "$chart"/values-*.yaml; do
    environment="$(basename "$values" .yaml)"
    environment="${environment#values-}"

    echo "==> $chart: lint ($environment)"
    helm lint "$chart" --strict --values "$values"

    echo "==> $chart: template ($environment)"
    # A release name per environment, matching what the deploy commands in
    # docs/helm-chart.md use, because the name feeds every generated object
    # name through `app.fullname` — rendering under a different one would not
    # be rendering what gets deployed.
    helm template "$name-$environment" "$chart" \
      --namespace "$environment" \
      --values "$values" \
      --kube-version "$kube_version" \
      >/dev/null
  done

  for fixture in "$chart"/render-fixtures/*.yaml; do
    echo "==> $chart: template ($(basename "$fixture"))"
    # No release name per fixture: these are not deployments, and rendering
    # them under one name keeps the diff between two fixtures about the values
    # rather than about the object names.
    helm template "$name-fixture" "$chart" \
      --values "$fixture" \
      --kube-version "$kube_version" \
      >/dev/null
  done

  for fixture in "$chart"/schema-fixtures/*.yaml; do
    if helm template "$name-fixture" "$chart" \
      --values "$fixture" \
      --kube-version "$kube_version" \
      >/dev/null 2>&1; then
      echo "::error file=$fixture::values.schema.json accepted $fixture, which exists to be rejected."
      failures=$((failures + 1))
    else
      echo "==> $chart: $(basename "$fixture") rejected, as intended"
    fi
  done
done

if [ "$failures" -gt 0 ]; then
  echo
  echo "$failures schema fixture(s) were accepted. See k8s/charts/*/schema-fixtures/README.md." >&2
  exit 1
fi

echo
echo "${#charts[@]} chart(s) linted and rendered."
