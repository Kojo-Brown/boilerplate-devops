# Software bills of materials

An SBOM is the answer to one question, asked under time pressure: *is this
thing we shipped affected?* It is worth exactly as much as its completeness and
its reachability, and both fail quietly. This repository therefore treats an
SBOM as part of the release rather than a report about it — every artifact it
publishes is inventoried before it ships, and the inventory travels with it.

| Piece | Where it lives | What it does |
|-------|----------------|--------------|
| Image SBOM | `workflow-templates/docker-build-push.yml` | Scans the built image, then attaches the SBOM to it in ECR |
| Bundle SBOM | `workflow-templates/deploy-static-site.yml` | Scans the source tree after the build, before the S3 sync |
| Standalone SBOM | `workflow-templates/sbom.yml` | Reusable workflow for artifacts the other two do not build |
| Audit of all three | `npm run audit:sbom` | Fails CI when a workflow publishes something it has not inventoried |

Format is **CycloneDX JSON** throughout, produced by [Syft], pinned to
`v1.51.1`. Two runs of the same commit must not disagree about what shipped
because the scanner moved underneath them, which is the same reason the
lockfile is committed.

[Syft]: https://github.com/anchore/syft

## What "attached" means

It means something different for each artifact shape, and the difference is the
whole design.

**A container image carries its own SBOM.** `oras attach` pushes the SBOM as a
separate manifest whose `subject` is the image manifest — an [OCI 1.1 referrer].
`docker pull` is unaffected, nothing about the image changes, and the inventory
is findable from the image reference alone:

```bash
oras discover 111122223333.dkr.ecr.us-east-1.amazonaws.com/api:<sha>
```

This matters because the workflow artifact expires after ninety days and the
image does not. Six months into an image's life the run that built it is gone,
its logs are gone, and the artifact retention window closed long ago. The image
is still deployed. Anything not attached to the image is not there when it is
needed, which is why `audit:sbom` treats an image whose SBOM lives only in a
workflow artifact as a violation (`image-sbom-not-in-registry`) rather than as
good enough.

ECR implements the OCI 1.1 Referrers API. ORAS negotiates it and falls back to
the referrers-tag schema on registries that predate it, so the same step works
against older registries without a flag.

[OCI 1.1 referrer]: https://github.com/opencontainers/distribution-spec/blob/main/spec.md#listing-referrers

**A directory has nowhere to carry anything.** The static-site bundle's SBOM is
uploaded as a workflow artifact, and `sbom.yml` will additionally attach it to
the GitHub Release for a tag when asked. It is deliberately **not** synced into
the site bucket: that bucket is served to the public through CloudFront, and a
complete dependency-and-version list published there is a CVE shortlist handed
to an attacker for free.

Release-asset upload needs `contents: write`. That permission lives in
`sbom.yml` and not in the deploy templates on purpose — a deploy workflow that
can rewrite the repository is a much larger blast radius than one that cannot,
and the deploy templates do not need it.

## Scan the artifact, not the repository

For an image, the SBOM is taken from the **image**:

```yaml
- uses: anchore/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26 # v0.24.2
  with:
    image: ${{ steps.build.outputs.image-uri }}
    format: cyclonedx-json
```

A scan of `.` reports what the repository *declares*. It cannot see the base
image's OS packages, anything a `RUN apt-get install` added, or a dependency the
build vendored in — and those are the layers CVEs are usually found in. The
resulting SBOM looks entirely healthy and is wrong in precisely the place that
matters. `audit:sbom` rejects it (`sbom-describes-source-not-image`).

For the static-site bundle the opposite is true, and the audit does not apply
the rule there. A bundler erases package identity: a scan of `dist/` finds a
handful of minified files and no components at all, while the lockfile beside it
names every dependency that went in. The scan runs *after* the build so that a
build which rewrites the lockfile is inventoried as it shipped.

## Scan before publishing

In every template the SBOM is generated and verified **before** the push or the
sync. A scan that runs afterwards cannot gate anything: when it fails, the build
goes red over an artifact that is already in the registry and already
deployable. `audit:sbom` enforces the ordering within a job
(`sbom-after-publish`).

The ordering rule is same-job only. Inventorying a pushed image from a separate
downstream job is a legitimate pattern — it just cannot be "before" a step in
another job — and the audit accepts an SBOM produced by any job that
transitively `needs` the publishing one.

## Verify the SBOM

This is the failure mode that catches people:

> Syft exits 0 and writes a schema-valid CycloneDX document when it finds
> nothing at all.

A mistyped reference, an ecosystem it does not recognise, a `working-directory`
pointing one level too high, an install that never ran — each produces
`"components": []`. That file is valid JSON, valid CycloneDX, passes every
schema check, uploads cleanly, and attaches to the image without complaint. It
is also worthless, and it is worthless in exactly the situation the SBOM exists
for.

So every template asserts, before the artifact ships:

```bash
jq empty "$SBOM_FILE"                                    # it parses
[ "$(jq -r .bomFormat "$SBOM_FILE")" = "CycloneDX" ]     # it is what it claims
[ -n "$(jq -r .specVersion "$SBOM_FILE")" ]              # it declares a version
[ "$(jq '.components | length' "$SBOM_FILE")" -gt 0 ]    # it found something
```

and, for an image, that `metadata.component` names the image being attached to
— otherwise the file describes something else and attaching it would be a lie
told with a valid document.

`audit:sbom` requires such a step in any job that generates an SBOM
(`sbom-unverified`). It identifies one by the literal string `bomFormat`: that
is the CycloneDX field distinguishing a real CycloneDX document from any other
JSON, so a step that reads it is a step checking the document rather than moving
it. The marker is deliberately a literal — the alternative is guessing at shell,
and a gate that guesses is a gate nobody trusts.

A scratch or distroless image holding a single statically linked binary is the
one legitimate way to have zero components. If you ship one, that assertion is
the line to change, with a comment saying which image and why.

## The audit

`npm run audit:sbom` reads every workflow in `.github/workflows/` **and** every
template in `workflow-templates/`. The templates matter more, not less: a
template with no SBOM is the product being broken, and it is broken identically
in every repository that copied it.

| Rule | What it catches |
|------|-----------------|
| `release-artifact-without-sbom` | A job publishes and nothing inventories it |
| `sbom-format-not-cyclonedx` | SPDX — the action's default — rather than CycloneDX |
| `sbom-describes-source-not-image` | An image publish inventoried from a path |
| `sbom-after-publish` | The artifact shipped before the scan ran |
| `sbom-not-attached` | Generated, then dropped on the floor |
| `image-sbom-not-in-registry` | Kept only somewhere that expires |
| `sbom-generator-unpinned` | The scanner itself on a mutable tag |
| `sbom-unverified` | An empty SBOM would pass unnoticed |

`sbom-format-not-cyclonedx` earns its place on its own. `anchore/sbom-action`'s
`format` input **defaults to `spdx-json`**, so omitting one line produces a
perfectly good SBOM in the wrong format, and every tool downstream reads
CycloneDX. Nothing else in a build notices.

### What the audit does not do

It reads workflow *shape*: which steps exist, what they are pointed at, and what
order they run in. It cannot prove that the SBOM a run produces actually
describes the artifact that run published — only the `bomFormat` and
`metadata.component` assertions in the workflows themselves can do that, at run
time, which is why `sbom-unverified` insists they be there.

Step classification is by command and action name. A publisher invoked by some
means the pattern tables in `aws/cdk/tools/audit-sbom.ts` do not match is
invisible to the audit, so **adding a new way to publish means adding it
there**. The patterns lean conservative: `npm publish --dry-run` is still read as
a publish, because a false positive costs one job an SBOM it did not need while
a false negative ships an uninventoried artifact.

## Pinning

`anchore/sbom-action` is pinned to a full commit SHA in every template. The
scanner decides what the inventory *says*, which makes an unpinned scanner a
supply-chain dependency of every artifact the workflow releases — the one place
where a repointed tag rewrites history rather than just changing behaviour. A
short SHA is rejected too: GitHub resolves it, but it is not collision-safe.

The audit applies this rule to SBOM generators only. Pinning every action in the
repository by digest is [its own SPEC item](../SPEC.md) and a larger change;
this is the subset where an unpinned tag corrupts the evidence rather than the
build.

## Using the standalone workflow

For an artifact neither deploy template builds. GitHub only resolves `uses:`
against `.github/workflows/`, so copy `workflow-templates/sbom.yml` there first
— into the consuming repository, or into whichever repository holds your shared
workflows — and call it by that path:

```yaml
jobs:
  sbom:
    uses: <owner>/<repo>/.github/workflows/sbom.yml@main
    with:
      artifact-kind: image
      image: 111122223333.dkr.ecr.us-east-1.amazonaws.com/api:${{ github.sha }}
      aws-region: us-east-1
    secrets:
      aws-role-arn: ${{ secrets.AWS_ROLE_ARN }}
```

```yaml
jobs:
  sbom:
    uses: <owner>/<repo>/.github/workflows/sbom.yml@main
    with:
      artifact-kind: directory
      path: .
      attach-to-release: true      # uploads to the Release for the current tag
```

`attach-to-release` needs `contents: write`, which `sbom.yml` declares
unconditionally: GitHub resolves `permissions:` before any input is read, so a
job cannot narrow them at run time. A copy that only ever inventories
directories and never cuts releases should delete both that and `id-token`.

It outputs `sbom-sha256` so a caller can pin the exact inventory a deploy was
gated on, and `sbom-artifact` for the workflow-artifact name.

## Reading an SBOM back

```bash
# What is attached to an image, without pulling the image. The default output
# is a tree; `--format json` is still experimental, so the filter goes through
# the stable `--artifact-type` flag.
oras discover "$IMAGE_URI"

REF=$(oras discover --artifact-type application/vnd.cyclonedx+json \
        --format json "$IMAGE_URI" | jq -r '.referrers[0].reference')
oras pull "$REF" --output ./sbom

# What is in it
jq -r '.components[] | "\(.name)@\(.version)"' sbom/sbom.cdx.json | sort

# Is a given package in it
jq -r '.components[] | select(.name == "log4j-core") | .version' sbom/sbom.cdx.json
```

## What comes next

The SBOM says what is in the artifact. It does not say who built it, or that
nobody edited it in transit — an SBOM attached to an image is only as
trustworthy as the registry holding both. Signing (`cosign`) and provenance
(SLSA) are the next two SPEC items in this phase and are what close that gap;
neither is implemented yet.
