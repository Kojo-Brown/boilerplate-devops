# SLSA build provenance

Every image `workflow-templates/docker-build-push.yml` publishes carries a
signed [SLSA build provenance][slsa] attestation: an in-toto statement, bound to
the digest the push returned, saying which repository and commit the image was
built from, which workflow at which ref built it, and on what kind of runner.
GitHub mints it, signs it with the same short-lived Sigstore certificate the
cosign signature uses, uploads it to the attestations API, and pushes it to the
registry as an OCI referrer on the image.

```
docker push  ──►  actions/attest (digest, push-to-registry)
                          │
                          ├──► GitHub attestations API   (keyed to the repository)
                          └──► ECR, as an OCI referrer   (keyed to the digest)
                                        │
        gh attestation verify --bundle-from-oci  ◄──┘   self-check
                identity + repository + predicate type pinned
```

## 1. Why this is a third gate and not a repeat of the other two

This repository already inventories and signs what it publishes. Provenance is
neither of those, and the three answer questions that do not substitute for one
another:

| Gate | Question it answers |
|---|---|
| SBOM (`docs/sbom.md`) | What is *inside* this image? |
| Signature (`docs/image-signing.md`) | Did the workflow that claims to have published this image publish it? |
| Provenance | What went in, and what built it? |

The signature is the closest of the three, and it is still a different claim. It
proves a workflow in a repository signed a digest. It does not record the commit
that was built, the ref that was checked out, the workflow file that ran, or
whether the runner was GitHub-hosted or someone's laptop with a runner token.
"Did the thing in production come from `main`?" is answerable from a signature
only by inference, and from provenance by reading it.

That gap is not hypothetical. It is the question every rollback, every
"which commit is actually deployed", and every dependency-confusion post-mortem
opens with.

## 2. Attest the pushed digest, never a path

`actions/attest` will happily take a `subject-path`. For a container image that
is the wrong subject: it attests a file on the runner — a build context, a
tarball, a layer — and produces a real, signed attestation about something
nobody pulls. Nothing downstream can match it to the image, because the image is
identified by its manifest digest and the attestation is not about that digest.

So the subject is `subject-digest` plus `subject-name`, where the digest is the
one the registry returned from the push and the name is the repository *without
a tag* on it:

```yaml
- uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2
  with:
    subject-name: ${{ steps.build.outputs.image-repository }}
    subject-digest: ${{ steps.push.outputs.image-digest }}
    push-to-registry: true
```

A tag in `subject-name` makes the push to the registry target a reference that
is not the image. `npm run audit:provenance` reports both mistakes.

## 3. `push-to-registry` is what makes it travel

Without it the attestation exists in exactly one place: GitHub's attestations
API, keyed to the repository that built the image. That is enough for
`gh attestation verify example.bin --repo owner/name`, and it is not enough for
anything that has the image and not the repository — a registry replica, another
account's ECR, an air-gapped pull, an incident responder holding a digest off a
running task.

With it, the attestation is an OCI referrer on the image manifest, discoverable
from the digest alone, which is the only identifier a consumer is guaranteed to
have. This is the same reasoning that puts the SBOM in the registry rather than
leaving it as a 90-day workflow artifact.

It is also why the workflow's self-check passes `--bundle-from-oci`: that reads
the attestation back **out of the registry** rather than off the runner or out
of GitHub's API, so a push that did not land fails the build instead of being
discovered by the first consumer who needed it.

## 4. Attest, then verify, in the same job

`actions/attest` chooses what kind of attestation to make from which inputs it
was given:

| Inputs | What you get |
|---|---|
| neither a predicate nor `sbom-path` | SLSA build provenance |
| `sbom-path` | an SBOM attestation |
| `predicate-type` / `predicate` / `predicate-path` | a custom attestation |

All three sign, upload and attach identically, and every gate that asks only
"is there an attestation?" is satisfied by all three. So the workflow reads the
predicate type back out of the bundle it just produced and fails when it is not
`https://slsa.dev/provenance/v1`, and then runs the verification a consumer
would run, with the identity, the repository and the predicate type all pinned.

That second step is what turns a signature nobody can use into a failure at
build time rather than in someone else's pipeline hours later.

### The identity, when this workflow is called from elsewhere

The signing identity in the certificate is the path of the workflow that
*asked* for the attestation. When `docker-build-push.yml` is called as a
reusable workflow from another repository, that is this file's own path in the
repository hosting it — not the caller's. It is the same nuance the cosign
signature has, and both self-checks resolve it from one `signer-identity-regexp`
input so they cannot drift apart.

### Passing `--cert-identity-regex '.*'` is worse than omitting it

`gh attestation verify` derives its certificate policy from `--repo` or
`--owner`. Supplying `--cert-identity-regex` **replaces** that derived identity
rather than narrowing it, so a catch-all there is strictly weaker than leaving
the flag out — it verifies that somebody, anybody with a GitHub account,
attested this digest. This is the same shape as the catch-all that defeats
`cosign verify`, and it is what a defeated gate looks like in practice, since
neither tool lets you simply omit the check.

## 5. This is Build L2, not L3

Under [SLSA v1.0][slsa-levels], Build L2 wants provenance that is generated by
the build platform, signed, and distributed with the artifact. That is what this
is.

Build L3 additionally wants the provenance generated by a build service the
caller cannot reach into. Here the build, the push and the attestation all run
in the same job as everything else in the workflow, so anything that can
influence that job — a compromised action, an injected step, a `run:` block
reading an attacker-controlled input — can influence what the provenance says
about it. The GitHub CLI documents this directly: only the certificate contents
and the verified timestamps are outside the workflow's reach; the predicate is
assembled inside it.

Closing that gap means moving the build into a trusted builder whose execution
the caller cannot alter — [`slsa-framework/slsa-github-generator`][generator],
or a reusable workflow that does the build itself and is verified with
`--signer-workflow` — and it is a restructuring of how images are built here,
not a flag. Claiming L3 without it would be the more expensive mistake, so this
document claims L2.

## 6. Verification at deploy is not wired up

The deploy templates in this repository (`deploy-ecs.yml`,
`blue-green-deploy.yml`, `canary-deploy.yml`, `preview-environment.yml`) gate on
the **signature** today, and refuse an image whose signature does not check out
against a pinned identity. None of them checks provenance.

That is a deliberate boundary and a real gap, in that order. What a deployment
should require of provenance — a particular source ref, a particular builder, a
minimum SLSA level — is a policy belonging to whoever runs the service, and it
is enforced in different places depending on the runtime: a deploy job, an
admission controller, or a registry policy. The materials are all in place for
it:

```bash
gh attestation verify "oci://$IMAGE_REF" \
  --bundle-from-oci \
  --repo OWNER/REPO \
  --signer-workflow OWNER/REPO/.github/workflows/docker-build-push.yml \
  --predicate-type https://slsa.dev/provenance/v1 \
  --source-ref refs/heads/main
```

`npm run audit:provenance` already audits any such step it finds — the catch-all
identity, the missing scope, the tag in place of a digest — it just does not yet
require one to exist.

## 7. The audit

`npm run audit:provenance` (`aws/cdk/tools/audit-provenance.ts`) runs on every
pull request and reads both the workflows this repository runs and the templates
it ships. It shares `audit-image-signing.ts`'s notion of what publishing an
image *is*, on purpose: if the two disagreed about that, an image could satisfy
the signing gate and never be seen by this one.

| Rule | The failure it prevents |
|---|---|
| `image-published-without-provenance` | how the image was built was never recorded |
| `provenance-before-push` | nothing in the registry to attach to yet |
| `provenance-not-pushed-to-registry` | the attestation cannot travel with the image |
| `provenance-subject-not-digest` | attests something other than what was pushed |
| `attestation-not-provenance` | an attestation, but not this kind |
| `provenance-without-attestations-permission` | fails at run time, after the image ships |
| `provenance-not-verified-at-build` | an unverifiable attestation ships as a good one |
| `provenance-verification-unpinned` | "attested by anyone" verified as "attested" |
| `verifies-mutable-subject` | verified a tag, which is not a thing |
| `attest-action-unpinned` | the attestor itself is mutable |

### What the audit does not do

It reads workflow shape. It cannot tell you that the provenance a run emits
describes that run truthfully — nothing static can, because the predicate is
assembled at run time, which is exactly the L2/L3 boundary in §5. It does not
require provenance to be verified at deploy (§6). And it says nothing about
artifacts that are not container images: `deploy-static-site.yml` publishes a
bundle to S3, where the objects are not content-addressed by the deploy and
there is no single digest a verifier could name.

## 8. Permissions

```yaml
permissions:
  id-token: write      # mint the OIDC token Sigstore exchanges for a certificate
  contents: read
  attestations: write  # persist the attestation
```

Two things about `attestations: write` are easy to get wrong:

- A job's own `permissions:` block **replaces** the workflow's rather than
  adding to it, so a job that narrows permissions for another reason silently
  takes this away.
- For a reusable workflow the effective token is the **intersection** of the
  called workflow's block and the caller job's, so a consumer of
  `docker-build-push.yml` has to grant it too.

Either way the failure is the same and it is late: the attest step fails after
the image has already been published.

`create-storage-record: false` is set deliberately. The storage record is a
GitHub-side index entry and creating one needs a fourth permission,
`artifact-metadata: write`; it is not the attestation, which still reaches both
the attestations API and the registry without it. That scope is also newer than
the `actionlint` version this repository pins — 1.7.7 rejects it as an unknown
permission scope — so adding it would mean bumping the linter for an index entry
nothing here reads. Turn the record on, and add the permission, if you want the
artifact to appear in GitHub's artifact metadata views.

## 9. Reading provenance back

```bash
# Verify, and print the whole statement
gh attestation verify "oci://$IMAGE_REF" --bundle-from-oci \
  --repo OWNER/REPO --format json

# What commit was this built from
gh attestation verify "oci://$IMAGE_REF" --bundle-from-oci \
  --repo OWNER/REPO --format json \
  | jq -r '.[0].verificationResult.statement.predicate.buildDefinition
             .externalParameters.workflow'

# Everything attached to the image, provenance and SBOM alike
oras discover "$IMAGE_REF"
```

Read `signature.certificate` for anything you intend to make a decision on. The
predicate is populated by the build; the certificate is populated by GitHub from
the OIDC token, and is the half a compromised workflow cannot forge.

## 10. Known gaps

- Provenance is not enforced at deploy (§6).
- Build L2, not L3 (§5).
- Artifact attestations need a GitHub Enterprise Cloud plan on private or
  internal repositories; on GitHub Free, Pro and Team they are available for
  public repositories only. The attest step fails on a private repository
  without that plan, and it fails *after* the push.
- `deploy-static-site.yml` publishes a bundle with no provenance (§7).
- Nothing here has attested an image in a real registry: the gates read shape,
  and the self-check in the template has not been exercised by a run of this
  repository's CI, which builds no images.

[slsa]: https://slsa.dev/spec/v1.0/provenance
[slsa-levels]: https://slsa.dev/spec/v1.0/levels
[generator]: https://github.com/slsa-framework/slsa-github-generator
