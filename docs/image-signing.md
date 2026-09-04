# Container image signing

Every image `workflow-templates/docker-build-push.yml` publishes is signed with
[Sigstore][sigstore] cosign, keylessly, using the build's own GitHub OIDC
identity. Every workflow here that deploys an image verifies that signature
first and refuses to deploy when it does not check out.

Both halves are needed, and the second is the one that does the work. A
signature is a statement nobody has to read. The control is the deploy that
stops.

```
docker push  ──►  cosign sign (digest)  ──►  cosign verify (self-check)
                                                     │
                            ECR ◄────────────────────┘
                             │
        cosign verify  ◄─────┘   identity + issuer pinned
             │
             ▼
        deploy the digest that was verified
```

## Why keyless

cosign can sign with a key pair. This repository does not, for the same reason
it assumes OIDC role assumption rather than long-lived AWS keys.

A key signature says *whoever holds this key signed this*. That claim stops
being useful at exactly the moment it matters — when the key is stolen — and
until then it costs you a secret to store, rotate, scope, and keep out of logs.

A keyless signature says *this workflow, in this repository, at this ref, signed
this*. cosign exchanges the job's OIDC token for a short-lived Fulcio
certificate that records those claims, signs, and logs the result in the Rekor
transparency log; the private key never outlives the run. There is nothing to
store and nothing to steal, and what a deploy checks is the identity of the
build rather than the custody of a secret.

That is why the signing job needs `id-token: write` — the same permission it
already has for assuming its AWS role — and why `npm run audit:signing` reports
a `cosign sign` in a workflow that does not grant it: keyless signing fails at
run time, after the image is already published.

## Sign the digest, never the tag

`cosign sign registry/app:v1` resolves `v1` and signs whatever it points at at
that instant. That is not the same statement as "this run signed the image this
run built", and the resulting signature — which is over a digest either way —
looks identical to a correct one.

`docker-build-push.yml` reads the digest out of the push output, cross-checks it
against what the local daemon holds, and signs `registry/app@sha256:…`. It
exports that reference as the `image-ref` output. Hand *that* to a deploy.

## The ordering is the opposite of the SBOM's

The SBOM is generated **before** the push, so an image that cannot be
inventoried never becomes a release ([docs/sbom.md](./sbom.md)).

The signature can only be made **after** it. Until the push completes there is
no manifest in the registry to sign. This is why `audit-sbom.ts` reports a scan
that runs after publishing and `audit-image-signing.ts` reports a signature made
before it: the two gates read the same workflow in opposite directions, and both
are right.

## Sign, then verify, in the same job

The build verifies its own signature before it reports success, with the same
`--certificate-identity-regexp` and `--certificate-oidc-issuer` a deploy will
use.

Without that step, a signature that nothing can verify is indistinguishable from
a good one: the wrong issuer, an identity no deploy expects, a Rekor entry that
never landed. The build stays green, and the failure surfaces in a different
repository, hours later, as a deploy that cannot ship.

By default the build checks its own signature against any workflow in the
repository the run belongs to, which is right when the template has been copied
into that repository. When the workflow is *called* from another repository, the
signing identity is the reusable workflow's own path in the repository that
hosts it — pass `signer-identity-regexp` to match it. The failure message says
so.

## Verification at deploy

`deploy-ecs.yml`, `blue-green-deploy.yml`, `canary-deploy.yml` and
`preview-environment.yml` each verify before the image reaches a runtime. They
take two inputs:

| Input | Meaning |
|---|---|
| `signer-identity-regexp` | Pattern the signing certificate's identity must match. Required. |
| `signer-oidc-issuer` | Issuer that must have issued it. Defaults to `https://token.actions.githubusercontent.com`. |

A realistic value for a build on the default branch:

```
^https://github\.com/OWNER/REPO/\.github/workflows/build\.yml@refs/heads/main$
```

Both flags are mandatory for cosign itself, which is why **the way this gate
gets defeated in practice is not omission — it is `.*`**. An identity pattern
that matches everything verifies that somebody, anybody, signed the image, and
anyone who can run a GitHub Actions workflow can arrange that for an image of
their own. The templates refuse a catch-all pattern at run time and
`npm run audit:signing` refuses one in review.

The same applies to the issuer. An identity string is evidence of who signed
only if the issuer that asserted it is pinned too.

### The verified reference is the deployed reference

Verifying `app:v1` and then deploying `app:v1` are two registry reads with a
window between them. A tag repointed inside that window puts an unverified image
into production behind a green signature check.

So the verify step resolves the reference to a digest — directly when the caller
already passed one, or through `aws ecr describe-images` when it passed a tag —
verifies *that*, and exports it as `steps.verify.outputs.image-ref`. The task
definition, the CDK context, and the state machine input all take the digest.

Tag resolution assumes ECR: the account id is read from the registry host. For
another registry, resolve the digest with `crane digest` and leave the rest
alone.

### What the deploy role needs

Two permissions beyond what these workflows already required:

- `ecr:GetAuthorizationToken` — the signature is an artifact in the same private
  ECR repository as the image, and cosign reads it with the credentials
  `amazon-ecr-login` writes to `~/.docker/config.json`.
- `ecr:DescribeImages` on the repository — only when a tag is passed rather than
  a digest.

## Pinning

`sigstore/cosign-installer` is pinned to a commit SHA and `cosign-release` to an
exact version (`v3.0.6`, the release that installer defaults to). cosign is what
decides whether a signature verifies; an unpinned verifier is a supply-chain
dependency of every deploy that trusts it, and bumping the action is an ordinary
dependency update that would otherwise change it silently.

## The audit

`npm run audit:signing` (`aws/cdk/tools/audit-image-signing.ts`) reads every
workflow in `.github/workflows/` and `workflow-templates/` and reports:

| Rule | What it catches |
|---|---|
| `image-published-without-signature` | an image ships with no provenance at all |
| `signature-before-push` | signing a manifest the registry does not have yet |
| `signs-mutable-tag` | signing whatever the tag points at right now |
| `signature-not-verified-at-build` | an unverifiable signature shipping as a good one |
| `keyless-signing-without-id-token` | cosign cannot get a certificate at run time |
| `long-lived-signing-key` | key custody in place of workflow identity |
| `image-deployed-without-verification` | the gate does not exist on this deploy path |
| `verification-identity-unpinned` | "signed by anyone" verified as "signed" |
| `deploys-unverified-reference` | verified a digest, deployed a tag |
| `cosign-unpinned` | the verifier itself is mutable |

It runs in the `cdk` job of `.github/workflows/ci.yml`, on every pull request.

### What the audit does not do

It reads workflow *shape* — which steps exist, what they are pointed at, and in
what order. It cannot prove that the signature a run makes covers the image that
run published; the sign-then-verify step is what checks that, at run time.

Deploy steps are recognised by command and action name, so a deploy mechanism
none of those patterns match is invisible to it. Adding one means adding it to
`DEPLOY_ACTIONS` or `DEPLOY_COMMANDS`.

A job only counts as deploying an image if it *names* one. That is deliberate:
`rollback.yml` re-points a service at a task definition that was already
verified when it was first deployed, introduces no new image reference, and has
nothing to check.

## Known gaps

**Nothing has verified a signature against a real registry.** The gates here
parse workflows and the unit tests drive the parser; no run in this repository
has yet signed an image in ECR or watched a deploy refuse an unsigned one. That
is a weaker claim than it may look, and it is the same gap `docs/sbom.md`
records for the inventory.

**Enforcement is in the pipeline, not in the cluster.** Everything above stops
an unsigned image at the workflow that deploys it. It does nothing about an
image that reaches a runtime another way — `kubectl` from a laptop, an Argo CD
sync of a manifest edited in the GitOps tree, an ECS task definition registered
by hand. Cluster-side enforcement is admission control ([Sigstore policy
controller][policy-controller] or Kyverno's `verifyImages`), which is a
different mechanism with its own failure modes and is not in this repository.
The GitOps tree in `k8s/argocd/` is therefore *not* covered by this gate.

**Only container images are signed.** `deploy-static-site.yml` publishes a
bundle to S3 and `sbom.yml` uploads release assets; neither is signed.
`cosign sign-blob` is the tool for that and is not wired up here.

**Nothing revokes.** A signature proves who built an image, not that the image
is still fit to run. An image signed by the right workflow six months ago, with
a critical CVE found since, verifies perfectly. That is the vulnerability gate's
job — a later Phase 9 item — not this one.

**Provenance beyond identity is not attested yet.** The signature says which
workflow signed. It does not say what source revision, what build parameters, or
what dependencies produced the image; that is SLSA provenance, the next item.

[sigstore]: https://www.sigstore.dev/
[policy-controller]: https://docs.sigstore.dev/policy-controller/overview/
