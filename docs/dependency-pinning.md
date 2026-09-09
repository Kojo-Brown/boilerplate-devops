# Dependency pinning by digest

Every third-party thing this repository *executes* is named by content rather
than by a pointer somebody else controls: actions by commit SHA, container
images by manifest digest. `npm run audit:pins` fails the build when one is not,
and fails it again when a pin carries no version comment — an unlabelled pin is
a dependency that never gets updated, which is a different failure with the same
cause.

```
uses: actions/checkout@v4                         ← a ref in someone else's repo
uses: actions/checkout@11d5960a… # v4.4.0         ← a commit, and what it is

image: public.ecr.aws/xray/aws-xray-daemon:latest ← resolved at every placement
image: public.ecr.aws/xray/aws-xray-daemon@sha256:b675…   # 3.7.0
```

## 1. What a tag actually is

`actions/checkout@v4` is not a version. It is a git ref in the `actions`
organisation's repository, and a ref is mutable by whoever holds the repository.
When the job starts, the runner resolves `v4` to whatever commit it points at
*then*, fetches it, and runs it with the job's `GITHUB_TOKEN`, its OIDC identity
and every secret the job can see.

Nothing about that is visible here. The workflow file does not change, so there
is no diff, no review, and no signal in the run log distinguishing the day the
tag moved from the day before. The compromise route that keeps happening in
practice is not a malicious release — it is an account takeover followed by a
tag move, because the tag move is the part nobody watches.

A container tag is the same shape of problem with a different blast radius. A
task definition holding `:latest` resolves at every task placement. Two tasks in
one service can be running different images; CloudFormation reports no drift,
because the string in the template did not change; and rolling back to the
previous task definition rolls back to the same moving tag. The first time the
difference is visible is when one task is failing and its twin is not.

A commit SHA and an image digest are content addresses. They resolve to the same
bytes forever, or they fail to resolve — and a failed pull at task placement is
a loud, immediate, diagnosable failure, which is the good outcome here.

## 2. The two halves of the policy

Pinning on its own produces a repository that is frozen rather than safe. A bare
SHA is unreadable in review — nobody can tell `11d5960a` from `49933ea5`, or say
whether the bump in front of them is a patch or two majors — and Dependabot
reads the trailing comment to know what version it is proposing to move you off.
Strip the comments and it stops opening pull requests.

So both of these are violations:

```yaml
uses: actions/checkout@v4                              # action-not-pinned
uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
                                                       # action-pin-unlabelled
uses: actions/checkout@11d5960a…  # main               # action-pin-label-not-version
```

and only this is not:

```yaml
uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

The same rule applies to images. `lib/base-images.ts` holds a `reference` (the
digest, which is what a task definition is handed) next to a `version` (the tag
it was resolved from, which is what a reviewer reads). They move together; a
`version` bumped without its digest is worse than no pin at all, because it
reads as one.

## 3. What is *not* pinned here, and why

**Your own application image.** `123456789012.dkr.ecr.us-east-1.amazonaws.com/app:sha-abc123`
is the artifact this pipeline builds, not a dependency it consumes. Its digest
is decided per release and cannot be a literal in the tree. That it reaches a
runtime by digest rather than by tag is enforced instead by
`audit-image-signing.ts`, and that is a stronger rule than this one: the digest
has to be the one a `cosign verify` just resolved, so verifying a tag and
deploying that tag — two registry reads with a window between them — is refused.
See [`docs/image-signing.md`](image-signing.md).

**The Helm chart's `image.tag`.** Also your application. `values.schema.json`
refuses `latest`, `main`, `master`, `stable`, `edge`, `dev` and `prod` there, and
`npm run audit:helm` checks the schema still says so. See
[`docs/helm-chart.md`](helm-chart.md).

**Local composite actions.** `uses: ./.github/actions/…` is this repository's own
code at this repository's own commit. There is no third party.

## 4. Resolving a pin

For an action, resolve the release tag to the commit it dereferences to, and
label the pin with that tag:

```bash
git ls-remote --tags https://github.com/actions/checkout | grep 'v4\.4\.0\^{}'
# 11d5960a326750d5838078e36cf38b85af677262  refs/tags/v4.4.0^{}
```

The `^{}` matters: an annotated tag's own object is not the commit, and pinning
the tag object gives you a SHA that no ref ever resolves to at runtime.

Check what the floating major points at before choosing a release, because they
are not always the same commit. `pnpm/action-setup@v4` resolves to `v4.3.0`,
while `v4.4.0` is the same commit as `v5.0.0` — pinning "the newest v4" there
would have been a major upgrade wearing a minor's version number. The pins in
this repository are the commits the previous floating tags actually resolved to,
so introducing them changed nothing about what runs.

For an image, ask the registry for the manifest digest:

```bash
TOKEN=$(curl -s "https://public.ecr.aws/token/?scope=repository:xray/aws-xray-daemon:pull" \
  | jq -r .token)
curl -sI -H "Authorization: Bearer ${TOKEN}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://public.ecr.aws/v2/xray/aws-xray-daemon/manifests/3.7.0 \
  | grep -i docker-content-digest
# docker-content-digest: sha256:b67576293f4d3a0a155f807244957ed0aa4bc945df1573d62d81380a1d548071
```

Resolve the *index* digest, not a per-architecture manifest: the index is what
supports both `linux/amd64` and `linux/arm64`, and pinning one platform's
manifest produces a task definition that cannot be scheduled on Graviton.

Amazon ECS documents `repository:tag` and `repository@digest` as the two forms a
container definition accepts, and says nothing about the combined
`repository:tag@digest` that Docker accepts. So `lib/base-images.ts` keeps the
tag in `version`, out of the string ECS is handed. In a workflow, where the
reference goes to `docker pull`, the combined form is used — it is what
Dependabot's docker ecosystem expects, and it is readable.

## 5. Keeping pins current

| What | Proposer |
|---|---|
| `aws/cdk` npm dependencies | Dependabot, weekly |
| Actions in `.github/workflows/` | Dependabot, weekly |
| Actions in `workflow-templates/` | the `action-pin-inconsistent` rule, for the ten actions also used in `.github/workflows/` |
| Actions used **only** in templates | nothing — see below |
| Images in `lib/base-images.ts` | nothing — see below |

Dependabot's `github-actions` ecosystem looks for `<directory>/.github/workflows`
and for an `action.yml` at `<directory>`. `workflow-templates/` is neither, so it
cannot see the templates at all. What partly covers them is the audit's
`action-pin-inconsistent` rule: one action pinned to two different commits fails
CI, so a Dependabot pull request bumping an action used in both places goes red
until the template is updated alongside it. That is deliberate — the red is the
reminder.

**Known gap.** Six actions appear only in templates —
`aws-actions/amazon-ecs-deploy-task-definition`, `pnpm/action-setup`,
`anchore/sbom-action`, `oras-project/setup-oras`, `actions/attest` and
`github/codeql-action` — and nothing proposes updates for them. So does the
image table: Dependabot's docker ecosystem reads Dockerfiles and compose files,
not TypeScript, and there is no Dockerfile in this repository. Both are on a
human to refresh, with §4 as the procedure. A scheduled job that resolves each
pin's labelled version and opens a pull request when the digest has moved would
close it, and is not written.

**Not a gap, worth saying plainly.** A pin freezes the code, not the
vulnerabilities in it. Pinning is why an upgrade is a reviewable event; it is not
why the version you are on is safe. That question belongs to the Trivy/Grype
gate, which is the next Phase 9 item and is not built yet.

## 6. The audit

`aws/cdk/tools/audit-dependency-pins.ts`, run by CI as `npm run audit:pins` and
covered by `test/audit-dependency-pins.test.ts`.

| Rule | What it prevents |
|---|---|
| `action-not-pinned` | `uses:` names a tag or branch, not a commit |
| `docker-action-not-pinned` | `uses: docker://…` names a tag, not a digest |
| `action-pin-unlabelled` | pinned, but nothing says which version it is |
| `action-pin-label-not-version` | the label is `# main`, which is a pointer again |
| `action-pin-inconsistent` | one action, two SHAs — a half-applied upgrade |
| `image-not-pinned` | a third-party image named by tag |
| `image-digest-malformed` | an `@sha256:` that is not 64 hex characters |
| `image-outside-pin-module` | an image literal in a stack instead of `lib/base-images.ts` |

It reads workflows as text, not as YAML, because the version label the rules
check is a comment and a YAML parser discards it. For the image rules it strips
comments first, so a usage example in a template's header — where a caller is
shown passing their own `:sha-abc123` tag — is prose rather than a finding.

Two shapes drove the design and are worth keeping in mind when extending it.
`ghcr.io/owner/tool:${TOOL_VERSION}` has no literal tag, and a pattern that
reads it as "untagged" lets exactly the unpinned case through — so the tag
alternation matches `${VAR}` and `${{ expr }}` too. And `kubernetes.io/role/elb`
parses as a registry reference and is a label on a subnet; an annotation key
never carries a tag or a digest, so the known-non-registry list is consulted
only for references that have neither.

Run against the tree as it stood before this was introduced, the audit reports
64 violations: 50 unpinned actions, 8 unpinned images, and 6 image literals
outside the pin module. A gate that stops seeing anything reports nothing and
passes, so the suite also asserts that the tool still parses the real
workflows — over 40 `uses:` references across more than five distinct action
repositories — rather than only that it finds no violations.

## 7. Upgrading a pin

1. Resolve the new commit or digest (§4).
2. Change the SHA **and** the version comment together. One without the other is
   the failure mode this policy exists to make impossible.
3. If the action appears in `workflow-templates/` as well as
   `.github/workflows/`, change both — `npm run audit:pins` will tell you if you
   did not.
4. For an image, edit `lib/base-images.ts` only. Nothing else in `lib/` or
   `bin/` may name a registry image; the audit enforces that.
