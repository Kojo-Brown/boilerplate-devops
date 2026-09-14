#!/usr/bin/env bash
#
# Run AWS IAM Access Analyzer over every synthesised CloudFormation template.
#
# `cfn-policy-validator validate` parses the IAM identity-based and
# resource-based policies out of a template, resolves the intrinsics, and sends
# each one to the `ValidatePolicy` API. Findings come back typed — ERROR,
# SECURITY_WARNING, WARNING, SUGGESTION — and the tool exits non-zero when a
# blocking one is present.
#
# Three things this script is careful about, all of them the same failure: a run
# that gates nothing and looks exactly like a run that found nothing.
#
#   • **An empty input.** `cdk.out` with no templates in it produces no
#     findings and a zero exit. That is indistinguishable from a clean account
#     unless somebody checks, so this fails instead.
#
#   • **A short-circuited loop.** One template that errors must not stop the
#     other forty-six from being validated, and must not be forgotten either.
#     Every template is validated; the failure is remembered and re-raised at
#     the end. There is deliberately no `|| true` here — `npm run audit:iam`
#     rejects one, because swallowing the exit code is the entire difference
#     between this and a report.
#
#   • **A narrowed threshold.** `--treat-finding-type-as-blocking` is passed
#     explicitly at its default of `ERROR,SECURITY_WARNING`. Passing it reads
#     like tightening, and dropping `SECURITY_WARNING` from it is where
#     `PASS_ROLE_WITH_STAR_IN_RESOURCE` — the finding that started this whole
#     item — stops failing the build. `npm run audit:iam` checks both are still
#     listed.
#
# Usage:
#   .github/scripts/run-iam-access-analyzer.sh <template-dir> <report-dir>
#
# Requires AWS credentials: the validator calls `sts:GetCallerIdentity` before
# it does anything else. See docs/iam-least-privilege.md.
set -euo pipefail

template_dir="${1:?usage: run-iam-access-analyzer.sh <template-dir> <report-dir>}"
report_dir="${2:?usage: run-iam-access-analyzer.sh <template-dir> <report-dir>}"
region="${AWS_REGION:-us-east-1}"

mkdir -p "$report_dir"

shopt -s nullglob
templates=("$template_dir"/*.template.json)
shopt -u nullglob

if [ "${#templates[@]}" -eq 0 ]; then
  echo "No *.template.json under '${template_dir}'. Run 'npx cdk synth' first —" >&2
  echo "validating nothing succeeds, and reads in the log like validating everything." >&2
  exit 1
fi

echo "Validating ${#templates[@]} template(s) against IAM Access Analyzer in ${region}."

status=0
failed=0

for template in "${templates[@]}"; do
  name="$(basename "$template" .template.json)"
  echo "::group::${name}"

  if ! cfn-policy-validator validate \
    --template-path "$template" \
    --region "$region" \
    --treat-finding-type-as-blocking ERROR,SECURITY_WARNING \
    | tee "${report_dir}/${name}.validate.json"; then
    status=1
    failed=$((failed + 1))
    echo "Blocking findings (or a validation error) in ${name}." >&2
  fi

  echo "::endgroup::"
done

if [ "$status" -ne 0 ]; then
  echo >&2
  echo "${failed} of ${#templates[@]} template(s) reported blocking findings." >&2
  echo "Per-template JSON is in '${report_dir}'. See docs/iam-least-privilege.md." >&2
  exit 1
fi

echo "${#templates[@]} template(s): no ERROR or SECURITY_WARNING findings."
