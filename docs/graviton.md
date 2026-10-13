# Graviton / ARM on this repository

Everything in here is about one question: which of this repository's 87 compute
resources can run on AWS Graviton, what each one is worth, and what is actually
stopping the rest.

The honest headline is that it splits three ways rather than two. **40 resources
run on arm64 as of this change, 11 are blocked by a single line in one workflow
template, and 36 cannot move at all** — and the third group is the one nobody
counts, because 26 of its members are Lambda functions that no file in `lib/` or
`bin/` names.

Two things to know before reading any number below.

**The prices are measured.** Every figure in §2 was read out of AWS's own public
price list — `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<offer>/current/us-east-1/index.json`,
which needs no credentials and no account — and each one carries the SKU it came
from and the publication date of the offer file it was read from. §5 has the
commands to re-read them.

**The performance is not.** Nothing in this repository has ever executed on an
arm64 host. CI is `ubuntu-latest`, and measuring a Graviton instance needs an AWS
account, which a fork's pull request cannot have. So there is no benchmark here,
there are vendor claims in §6 with the pages they came from, and there is one
performance number this repository *can* state: the slowdown each price saving
tolerates before it is gone. That column is in §2, and it is the one to argue
with.

The data behind all of it is `aws/cdk/lib/graviton-migration.ts`. The gate that
keeps this document true is `npm run audit:graviton`, described in §10. Both
tables below are **rendered** from that file rather than checked against it, so
hand-editing one of them fails the build.

## 1. Why a flag is not a migration

The Graviton advice everyone has read is one line per service: set
`architecture: ARM_64` on the function, `cpuArchitecture: ARM64` on the task
definition, `t4g` instead of `t3` on the instance. That advice is correct, and
following it on the ECS service here would have produced a deployment that
synthesises, passes every gate in this repository, deploys — and then fails in
somebody else's account, minutes after their first release:

```
CannotPullContainerError: ... no matching manifest for linux/arm64/v8 in the manifest list entries
```

Worse than that, it would have looked fine from here. `EcsStack`'s default
container image is the nginx placeholder in `lib/base-images.ts`, which is a
two-platform index, so a bare `cdk deploy` with the defaults would have started
and served and passed its health check on ARM64. The failure arrives only once a
consumer supplies the image they built — which is the entire point of the
boilerplate, and is the one case nothing in this repository deploys.

A task definition's architecture is a request. Whether it can be satisfied
depends on bytes in a registry that no template, no unit test and no `cdk synth`
looks at. The same shape appears three more times in this repository: in a
Lambda layer whose binaries are compiled for one architecture, in an EKS node
group whose AMI type and instance types can disagree, and in a Helm chart whose
image is the consumer's. Each is invisible in review and each fails after the
deploy.

So the order of work is the reverse of the advice: find out what the bytes are,
then flip the flag.

## 2. What it is worth, per unit, from the price list

| Service | Unit | x86 | Graviton | Saving | Tolerated slowdown | Offer published |
| --- | --- | --- | --- | --- | --- | --- |
| AWS Lambda | GB-second | Lambda-GB-Second `$0.0000166667` | Lambda-GB-Second-ARM `$0.0000133334` | 20.00% | 25.00% | 2026-10-12 |
| AWS Fargate (ECS) | vCPU-hour | USE1-Fargate-vCPU-Hours:perCPU `$0.04048` | USE1-Fargate-ARM-vCPU-Hours:perCPU `$0.03238` | 20.01% | 25.02% | 2026-09-11 |
| AWS Fargate (ECS) | GB-hour | USE1-Fargate-GB-Hours `$0.004445` | USE1-Fargate-ARM-GB-Hours `$0.00356` | 19.91% | 24.86% | 2026-09-11 |
| Amazon EC2 (Linux, shared tenancy) | instance-hour | m6i.large `$0.096` | m7g.large `$0.0816` | 15.00% | 17.65% | 2026-10-12 |
| Amazon EC2 (Linux, shared tenancy) | instance-hour | m6i.large `$0.096` | m8g.large `$0.08976` | 6.50% | 6.95% | 2026-10-12 |
| Amazon RDS for PostgreSQL (Single-AZ) | instance-hour | db.t3.medium `$0.072` | db.t4g.medium `$0.065` | 9.72% | 10.77% | 2026-10-06 |
| Amazon RDS for PostgreSQL (Multi-AZ) | instance-hour | db.t3.medium `$0.145` | db.t4g.medium `$0.129` | 11.03% | 12.40% | 2026-10-06 |
| Amazon ElastiCache for Redis | node-hour | cache.t3.small `$0.034` | cache.t4g.small `$0.032` | 5.88% | 6.25% | 2026-09-14 |

Five things in that table are worth more than the table:

**"Graviton is 20% cheaper" is true of two rows.** It is 15.00% for the EC2
m-family, 9.72% and 11.03% for the same pair of RDS classes, and **5.88% for the
ElastiCache node this repository runs**. The spread across one repository, from
one price list, on one day, is 3.4x.

**The same two RDS classes have two different savings.** Multi-AZ is not exactly
twice Single-AZ on either side, so staging (Single-AZ) saves 9.72% and production
(Multi-AZ) saves 11.03%. A migration document that quotes one number quotes the
wrong one for half the estates it is read in.

**The newest Graviton is not the cheapest.** `m8g.large` (Graviton4) costs 10%
*more per hour* than `m7g.large` (Graviton3). Both are cheaper than `m6i.large`,
but picking the newest generation is a performance bet that shows up as a higher
bill until a benchmark comes back — which is a different decision from moving
off x86, and is why both EC2 rows are in the table.

**Fargate has no single percentage.** The vCPU meter is discounted 20.01% and the
memory meter 19.91%, so a task's saving depends on its own cpu:memory ratio;
`blendedFargateSaving(cpuUnits, memoryMiB)` computes it. The useful finding is a
negative one: across every cpu:memory combination Fargate actually permits, the
blend lands between 19.9% and 20.0%, and for every task shape in this repository
it is 19.98–19.99%. The distinction is real and immaterial here — worth one
decimal place, not a spreadsheet.

**The last column is the only performance statement here that is not somebody
else's.** A 20% cheaper hour buys 25% more hours: if arm64 runs the same work
25% slower, the saving is exactly zero. For the ElastiCache node the margin is
6.25%. So the service with the *smallest* price gap needs the *strongest*
performance evidence — the opposite of where anyone bothers to measure, and the
reason §6 exists rather than a confident sentence about Graviton being faster.

## 3. What runs where, after this change

| Workload | Kind | Copies | Decided by | Image | Verdict | Blocker | Migrates by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `slo-budget-reporter` | lambda | 2 | repository | none | migrated | — | redeploy |
| `slo-burn-rate-rollback` | lambda | 2 | repository | none | migrated | — | redeploy |
| `rollback-automation` | lambda | 2 | repository | none | migrated | — | redeploy |
| `runbook-enricher` | lambda | 2 | repository | none | migrated | — | redeploy |
| `log-scrubber` | lambda | 2 | repository | none | migrated | — | redeploy |
| `migration-hook` | lambda | 2 | repository | none | migrated | — | redeploy |
| `canary-analyzer` | lambda | 2 | repository | none | migrated | — | redeploy |
| `canary-controller` | lambda | 2 | repository | none | migrated | — | redeploy |
| `game-day-conductor` | lambda | 2 | repository | none | migrated | — | redeploy |
| `game-day-probe` | lambda | 2 | repository | none | migrated | — | redeploy |
| `game-day-recorder` | lambda | 2 | repository | none | migrated | — | redeploy |
| `restore-drill-conductor` | lambda | 2 | repository | none | migrated | — | redeploy |
| `restore-drill-sweeper` | lambda | 2 | repository | none | migrated | — | redeploy |
| `restore-drill-verifier` | lambda | 2 | repository | none | migrated | — | redeploy |
| `dora-aggregator` | lambda | 1 | repository | none | migrated | — | redeploy |
| `dora-recorder` | lambda | 1 | repository | none | migrated | — | redeploy |
| `feature-flag-sweep` | lambda | 1 | repository | none | migrated | — | redeploy |
| `preview-reaper` | lambda | 1 | repository | none | migrated | — | redeploy |
| `cdk-eks-kubectl-handler` | lambda | 2 | cdk | aws-managed | unavailable | layer-binaries-x86 | none |
| `cdk-eks-cluster-oneventhandler` | lambda | 2 | cdk | aws-managed | unavailable | layer-binaries-x86 | none |
| `cdk-eks-cluster-iscompletehandler` | lambda | 2 | cdk | aws-managed | unavailable | layer-binaries-x86 | none |
| `cdk-provider-framework-onevent` | lambda | 4 | cdk | aws-managed | unavailable | framework-chooses | none |
| `cdk-provider-framework-iscomplete` | lambda | 2 | cdk | aws-managed | unavailable | framework-chooses | none |
| `cdk-provider-framework-ontimeout` | lambda | 2 | cdk | aws-managed | unavailable | framework-chooses | none |
| `cdk-cfn-utils-provider` | lambda | 2 | cdk | aws-managed | unavailable | framework-chooses | none |
| `cdk-oidc-provider` | lambda | 3 | cdk | aws-managed | unavailable | framework-chooses | none |
| `cdk-s3-auto-delete-objects` | lambda | 3 | cdk | aws-managed | unavailable | framework-chooses | none |
| `cdk-vpc-restrict-default-sg` | lambda | 2 | cdk | aws-managed | unavailable | framework-chooses | none |
| `cdk-log-retention` | lambda | 2 | cdk | aws-managed | unavailable | framework-chooses | none |
| `otel-sampler-task` | fargate-task-definition | 2 | repository | repository-pinned | migrated | — | task-revision |
| `preview-db-admin-task` | fargate-task-definition | 1 | repository | repository-pinned | migrated | — | task-revision |
| `app-service-task` | fargate-task-definition | 7 | repository | consumer-supplied | blocked | consumer-image-single-platform | task-revision |
| `db-migration-task` | fargate-task-definition | 2 | repository | consumer-supplied | blocked | consumer-image-single-platform | task-revision |
| `eks-system-nodegroup` | eks-nodegroup | 2 | repository | consumer-supplied | blocked | consumer-image-single-platform | node-replacement |
| `rds-postgres-instance` | rds-instance | 2 | repository | none | migrated | — | instance-modify-reboot |
| `preview-rds-instance` | rds-instance | 1 | repository | none | migrated | — | instance-modify-reboot |
| `elasticache-redis-nodes` | elasticache-node | 2 | repository | none | migrated | — | instance-modify-reboot |
| `synthetic-canaries` | synthetics-canary | 10 | aws | aws-managed | unavailable | no-arm64-runtime | none |

`Copies` is how many resources in `cdk.out` the entry covers, which is why the
numbers are mostly 2: staging and production. The audit requires the count to be
exact, so adding an environment forces the new copy to be classified rather than
letting it arrive unexamined.

What moved, and what it took:

* **18 Lambda functions → arm64.** Every one is `lambda.Code.fromInline` on
  `NODEJS_22_X`: the artifact is a JavaScript string and the runtime is AWS's, so
  there is nothing in the package that could be architecture-specific. This is
  the one case where the one-line advice is the whole job.
* **2 Fargate task definitions → ARM64.** The ADOT tail-sampling collector and
  the preview database admin task. Both run images pinned in
  `lib/base-images.ts`, both of which were measured as multi-platform indexes
  carrying `linux/arm64` (§5) before either was moved.
* **2 RDS instances and 2 ElastiCache replication groups → Graviton2.**
  `db.t3.medium` → `db.t4g.medium`, and `cache.t3.small`/`cache.t3.micro` →
  `cache.t4g.small`/`cache.t4g.micro`. Identical vCPU and memory on both sides,
  no image anywhere in the picture, so the class name is the entire migration.
  A third RDS instance needed nothing: the preview database was *already*
  `db.t4g.micro` — the only Graviton resource in the repository before this
  change, and nothing recorded that it was one, which is its own argument for
  the table in §3.
* **10 task definitions gained a declaration they did not have.** Before this
  change, two of the twelve set `runtimePlatform`; the other ten deployed X86_64
  by ECS's default with nothing in the template saying so. "Unexamined" and
  "deliberately x86" produced identical CloudFormation, which is why
  `architecture-undeclared` is a violation and not a note.

## 4. The one line that blocks the big savings

Eleven resources are blocked, and all eleven are blocked by the same thing:

```yaml
# workflow-templates/docker-build-push.yml
- name: Build image
  run: |
    docker build -f "$DOCKERFILE" -t "$IMAGE_URI" -t "$REGISTRY/$IMAGE:latest" .
```

`docker build` with no `--platform` builds for the runner, and the runner is
`ubuntu-latest`, which is amd64. Every workload whose image comes out of that
pipeline — the ECS service, the blue/green and canary services, the per-PR
preview task, the database migration task, and the EKS node group the
application's pods land on — therefore cannot be moved by changing its
architecture, however many times the change is proposed. It is also where the
money is: the always-on Fargate services and the node group dominate this
repository's compute bill, and the Lambda fleet that *could* move is billed in
GB-seconds of handlers that run for under a second.

**The cheap migration is where the savings are not, and the expensive one is
where they are.** That is the finding, and it is not a general truth about
Graviton — it is a property of this repository's pipeline.

Fixing it is deliberately not part of this change, because it is not one line
back. Multi-platform builds collide with the ordering every supply-chain gate
here depends on:

* `docker buildx build --platform linux/amd64,linux/arm64` **cannot `--load`**.
  Buildx refuses to load more than one platform into the local Docker daemon, and
  the current pipeline builds locally, inventories the local image with Syft,
  scans it with Trivy, and only then pushes — an order `audit:sbom` and
  `audit:vulns` both enforce, because a scan after the push gates nothing.
* The way out is a **per-platform matrix**: build, inventory, scan and push each
  platform separately, then join them with `docker buildx imagetools create`.
  That means two SBOMs and two scan reports per release rather than one.
* Both signing gates then change subject. `cosign sign` and `actions/attest`
  currently run over the digest the push returned; after a manifest list is
  created, the digest a deploy resolves is the **index**, not either platform
  manifest. A signature over one platform manifest verifies nothing about the
  reference anyone pulls, and `audit:signing` and `audit:provenance` both have
  rules that would need to say which of the three digests is the subject.
* Trivy and Syft read **one platform** out of a multi-platform reference unless
  told otherwise. A pipeline that builds both and scans the index scans amd64 and
  says nothing about the arm64 layers actually running — which looks exactly like
  a clean scan.

None of that is hard. All of it is a change to four audited workflows, and it
belongs in its own pull request with its own reasoning. Until it lands, the
blocker is recorded against every workload it holds, and
`npm run audit:graviton` checks it **in both directions**: while the pipeline
builds one platform every consumer-image workload must carry the blocker, and the
day the pipeline builds `linux/arm64` the blocker becomes a lie and the gate says
so. A blocker outliving its constraint is how a task definition stays on x86 for
a year.

## 5. Re-measuring any of this

**A price.** The bulk price list is public, unauthenticated, and per-region.
Lambda's `us-east-1` file is 700 KB; EC2's is 480 MB, so use the CSV and stream
it.

```bash
# Fargate, both architectures, with the SKU each number comes from
curl -s https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/us-east-1/index.json \
  | jq -r '.publicationDate, (.products | to_entries[]
      | select(.value.attributes.usagetype | test("Fargate-(ARM-)?(vCPU|GB)-Hours"))
      | [.key, .value.attributes.usagetype] | @tsv)'

# EC2 on-demand Linux, by instance type, without downloading 480 MB to disk
curl -s https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.csv \
  | grep -E '"\$[0-9.]+ per On Demand Linux (m7g|m6i)\.large Instance Hour"' \
  | cut -d, -f1,5,10
```

The `publicationDate` of the offer file goes into the catalogue beside the price.
`npm run audit:graviton -- --now` fails any price read from a file older than 90
days — deliberately opt-in, like `audit:flags` and `audit:vulns`, so that a date
nobody chose does not turn an unrelated pull request red.

**An image's platforms.** This is the measurement that decides whether an ARM64
task definition can start at all. No Docker daemon required:

```bash
REPO=aws-observability/aws-otel-collector
DIGEST=sha256:7968fb60db6a2390a47ba6a2df029745638486e285c9b2487da1b722d0855a3e
TOKEN=$(curl -s "https://public.ecr.aws/token/?scope=repository:$REPO:pull&service=public.ecr.aws" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  "https://public.ecr.aws/v2/$REPO/manifests/$DIGEST" \
  | jq -r '.mediaType, (.manifests[] | [.platform.os, .platform.architecture] | @tsv)'
```

All four images pinned in `lib/base-images.ts` were measured this way on
2026-10-13 and all four are multi-platform indexes carrying `linux/arm64`;
`IMAGE_PLATFORMS` records what each one holds. Two notes from doing it:

* **Count platforms, not manifests.** A buildkit-built index carries attestation
  manifests under `unknown/unknown`, so an index with two real architectures
  reports four entries. A check that counts `manifests` is satisfied by an index
  holding one architecture and two signatures of it.
* **The token is per repository.** `/token/` with no scope returns one that works
  for a single pull and then answers `TOOMANYREQUESTS` for everything else, which
  reads like a rate limit and is actually a scope error.

The audit requires every pin in `base-images.ts` to appear in `IMAGE_PLATFORMS`,
so a new pin cannot be added without classifying it, and it checks every image of
every ARM64 task definition against those records.

## 6. What is not measured, and what would settle it

No benchmark in this repository has run on Graviton, and the three claims the
catalogue records are all somebody else's:

| Claim | Publisher | Measured here |
| --- | --- | --- |
| Up to 25% better compute performance than Graviton2; up to 40% better price performance than comparable x86 | AWS | no |
| Up to 34% better price performance for Lambda | AWS | no |
| Up to 35% higher throughput for open-source database engines | AWS | no |

Each carries a caveat in `BENCHMARK_CLAIMS` for why it does not transfer. The
Lambda one is the clearest: 20 of its 34 points are the price cut this repository
*can* verify from the price list, and the remainder is a throughput claim about
workloads unlike 18 event-driven handlers that each run for under a second and
spend most of it waiting on an SDK round-trip. The RDS one is published for
sustained m6g/r6g workloads, and the instance here is a burstable `t4g` whose
throughput is decided by its CPU credit balance long before its processor matters.

What would settle it, in the order the margins demand:

1. **ElastiCache (6.25% of margin).** `k8s/load-test/hpa-ramp.js` against the
   same application on `cache.t3.small` and `cache.t4g.small`, comparing p99 at
   fixed throughput. The smallest margin in the repository and the one nobody
   ever measures.
2. **RDS (10.77% Single-AZ).** `pgbench` at a fixed scale factor on both classes,
   long enough to exhaust the burst balance — a short run on a `t*` instance
   measures credits, not processors.
3. **Fargate (≈20%).** The same image built for both platforms behind the same
   ALB, which is the one that cannot be done until §4 lands.

`BENCHMARK_CLAIMS` entries are marked `measured: false`, and the audit rejects a
`true` with no artifact path beside it. That is the only thing keeping this
section honest.

## 7. The half of the Lambda fleet nobody names

`cdk.out` holds **58** `AWS::Lambda::Function` resources. This repository writes
**32** of them. The other 26 are created by the CDK framework — custom-resource
providers, the provider framework's `onEvent`/`isComplete`/`onTimeout` handlers,
the OIDC provider, S3 auto-delete, the default-security-group restriction, log
retention, and the EKS cluster and kubectl providers — and nothing in `lib/` or
`bin/` mentions a single one.

So "migrate the Lambda fleet to arm64" tops out at 32 of 58 functions, and the
gap is invisible to anyone reading the TypeScript. Two reasons, and they are
different:

**Six of them carry layers whose binaries are x86.** The EKS kubectl provider
carries `@aws-cdk/lambda-layer-kubectl-v33` and `@aws-cdk/asset-awscli-v1`; the
cluster resource provider's two handlers carry the awscli layer. Reading the ELF
headers out of the layer zips in `node_modules`:

```
@aws-cdk/lambda-layer-kubectl-v33  kubectl/kubectl  ELF x86-64
@aws-cdk/lambda-layer-kubectl-v33  helm/helm        ELF x86-64
@aws-cdk/asset-awscli-v1           _yaml...so       ELF x86-64
```

That is not a configuration to change. An arm64 function with that layer attached
starts and fails on the first `kubectl` call, inside a custom resource, during a
cluster deployment. `audit-graviton.ts` reads those headers on every run (a
~90-line zip reader, because `unzip` is not on the runner by contract and adding
a dependency for twenty bytes is not a trade worth making) and reports if they
ever stop being x86 — at which point the blocker is wrong and the functions
should be reclassified.

**The other twenty have no knob at all.** `custom_resources.Provider`,
`logRetention`, `iam.OpenIdConnectProvider` and the singleton custom-resource
providers inside `aws-cdk-lib` do not expose `architecture`. There is no
supported way to set it from here, so the catalogue records
`framework-chooses` and the audit holds the line that they are *classified*
rather than merely absent — which is the whole reason the inventory is a gate and
not a list.

The cost of those 26 is real but small: they run on deployments and on custom
resource lifecycle events, not on request traffic. The reason they matter is
arithmetic. "We moved our Lambdas to Graviton" is 55% true here, and nothing in
the repository would have said so.

## 8. Where there is no arm64 to move to

The 10 CloudWatch Synthetics canaries run `syn-nodejs-puppeteer-13.0`. Synthetics
publishes one runtime family per language and no arm64 variant of any of them:
there is no architecture property on `AWS::Synthetics::Canary`, and the canary is
billed per run rather than per hour, so there would be no hourly saving to chase
even if there were. Recorded as `no-arm64-runtime`, which is a different fact
from "blocked" and is kept distinct on purpose — a blocked workload is waiting on
us, an unavailable one is waiting on AWS.

## 9. Migrating something that already exists

Everything above is about a fresh `cdk deploy`. For an estate that is already
running, the mechanics differ per service and only one of them is free:

| Workload | Mechanics | What a caller sees |
| --- | --- | --- |
| Lambda (zip) | New version published | Nothing. The next invocation runs the new architecture. |
| Fargate task definition | New revision, rolling deployment | Nothing, if the service's deployment configuration is the one in `EcsStack`. |
| RDS instance | Instance-class modification | Single-AZ: one reboot, typically a few minutes. Multi-AZ: a failover, so the endpoint stays and connections drop. `docs/game-days.md` is the measurement of what that actually costs here. |
| ElastiCache node | Node-type modification | With a replica (production, `numReadReplicas: 1`) the replica is replaced first and the primary fails over to it. With none (staging) there is nothing to promote, so the single node is replaced and the cache is cold afterwards. Either way, clients that cache DNS past the TTL see errors — the same defect `docs/game-days.md` §2 measured for the database endpoint. |
| EKS node group | Node replacement | Pods are evicted onto the new nodes. The PodDisruptionBudget in `k8s/charts/app` is what decides whether that is a rollout or an outage. |

Two orderings worth stating:

**Do the stateless ones first, and separately.** A Lambda redeploy is reversible
in one deploy and observable within minutes. An instance-class change is neither.
Moving both in one pull request means that if latency moves afterwards, nothing
says which half did it.

**For RDS, prefer a blue/green deployment to a modification** if the engine
supports it in your version: it stands up a Graviton replica, keeps it in sync,
and switches over in about a minute, which converts a reboot into a planned
switchover and gives a rollback that is not another reboot. It also costs a
second instance for the duration, which is why it is a choice rather than a
default.

## 10. The gate

`npm run audit:graviton` runs in CI after `cdk synth`, because every rule it has
is about what synth *wrote* rather than about what the TypeScript says. It reads
all 74 synthesised templates, the four image measurements, the two layer zips in
`node_modules`, `workflow-templates/docker-build-push.yml` and this document, and
fails on:

* a compute resource no catalogue entry matches, or one that two entries both
  claim, or a matched count that has drifted from what an entry declares;
* an architecture in a template that is not the one the catalogue claims, or one
  of ours left to a service default;
* an EKS node group whose AMI type and instance types disagree — which
  CloudFormation accepts and whose nodes then never join;
* an ARM64 task definition pulling an image with no measured `linux/arm64`
  manifest, or a pin in `base-images.ts` that nobody has measured;
* a `layer-binaries-x86` blocker whose layer can no longer be read, or no longer
  holds x86 binaries;
* the pipeline blocker in either direction (§4);
* either table in this document not matching what the data renders, or a blocker
  with no section here to explain it;
* with `--now`, a price older than 90 days.

The rules it does **not** have are worth naming too. It cannot tell whether
Graviton is faster for this workload — nothing here can, see §6 — and it does not
reach the registry: the image platforms are a recorded measurement with a date on
them, not a live lookup, because a gate that fails when a public registry is
rate-limiting is a gate people learn to re-run.
