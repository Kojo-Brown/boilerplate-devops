#!/usr/bin/env bash
#
# Run the Conftest/OPA policy gate over the synthesised CloudFormation.
#
# The Checkov job next door asks whether the templates break a rule that is true
# of everyone's infrastructure. This asks whether they break one that is true of
# *ours* — which tags a resource must carry, which ports may face the internet,
# what production owes a database that staging does not. See
# docs/policy-as-code.md for why those two are separate jobs.
#
# Three phases, in this order, because each is worthless without the one before:
#
#   1. `conftest verify` — the policies' own unit tests. A rule can be wrong in
#      a way that makes it never fire, and a gate made of rules that never fire
#      is green against every repository in the world.
#
#   2. The deny canary — a synthetic template that trips every rule exactly
#      once. This checks the *wiring* rather than the rules: the policy path,
#      the --namespace flag, the binary that got installed, and whether anything
#      reads the exit code. conftest prints `0 tests, 0 passed` and exits 0 when
#      --namespace names a package that does not exist, so a typo in the command
#      below produces a green check over an evaluation that never happened.
#
#   3. The real scan, over every template `cdk synth` wrote.
#
# Usage:
#   .github/scripts/run-policy-gate.sh <directory-of-synthesised-templates>

set -euo pipefail

template_directory="${1:-}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
policy_directory="$repo_root/policy/cloudformation"
canary="$repo_root/policy/fixtures/deny-canary.json"
expectations="$repo_root/policy/canary-expectations.txt"

# The package every rule in the pack declares. Named explicitly rather than
# --all-namespaces so that adding a second pack later is a deliberate edit to
# this line, not an automatic widening of what this gate covers.
namespace="cloudformation"

fail() {
  echo "policy gate: $*" >&2
  exit 1
}

if [ -z "$template_directory" ]; then
  fail "usage: .github/scripts/run-policy-gate.sh <directory-of-synthesised-templates>"
fi

command -v conftest >/dev/null 2>&1 || fail "conftest is not installed; install it or run this in CI."
command -v jq >/dev/null 2>&1 || fail "jq is not installed; install it or run this in CI."

[ -d "$policy_directory" ] || fail "no policy directory at $policy_directory"
[ -f "$canary" ] || fail "no deny canary at $canary"
[ -f "$expectations" ] || fail "no canary expectations at $expectations"

shopt -s nullglob
templates=("$template_directory"/*.template.json)

if [ ${#templates[@]} -eq 0 ]; then
  fail "no *.template.json under $template_directory — did \`cdk synth\` run?"
fi

echo "==> $(conftest --version | tr '\n' ' ')"

echo "==> policy unit tests"
conftest verify --policy "$policy_directory"

echo "==> deny canary"
canary_output="$(mktemp)"
# shellcheck disable=SC2064 # expand canary_output now: it is never reassigned.
trap "rm -f '$canary_output'" EXIT

canary_status=0
conftest test \
  --namespace "$namespace" \
  --policy "$policy_directory" \
  --output json \
  "$canary" >"$canary_output" 2>/dev/null || canary_status=$?

# Exit 0 means the canary satisfied the policies, which is only possible if the
# evaluation did not actually happen.
if [ "$canary_status" -eq 0 ]; then
  fail "the deny canary passed, so the pack evaluated nothing. Check --namespace \"$namespace\" against the package declared in $policy_directory."
fi

reported="$(jq -r '.[].failures[]?.msg' <"$canary_output" |
  sed -n 's/^\[\([a-z-]\{1,\}\)\].*/\1/p' | sort -u)"
expected="$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$expectations" | sed '/^$/d' | sort -u)"

if [ "$reported" != "$expected" ]; then
  echo "policy gate: the deny canary did not report the rule ids it should have." >&2
  echo "  expected but never fired (a rule nobody has seen work):" >&2
  comm -13 <(echo "$reported") <(echo "$expected") | sed 's/^/    /' >&2
  echo "  fired but not in $expectations (a rule added without a canary case):" >&2
  comm -23 <(echo "$reported") <(echo "$expected") | sed 's/^/    /' >&2
  exit 1
fi

echo "    $(echo "$expected" | wc -l | tr -d ' ') rule(s) fired on the canary, as expected"

echo "==> scanning ${#templates[@]} template(s) in $template_directory"
conftest test --namespace "$namespace" --policy "$policy_directory" "${templates[@]}"
