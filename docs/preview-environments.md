# Preview environments

Every open pull request gets a running copy of the application at
`https://pr-<number>.preview.example.com`, seeded with fixtures from that pull
request's own commit, and deleted when the pull request closes.

Two stacks and one workflow:

| Piece | Lives in | Deployed |
|---|---|---|
| `PreviewEnvironmentStack` | `aws/cdk/lib/preview-environment-stack.ts` | Once |
| `PreviewPrStack` | `aws/cdk/lib/preview-pr-stack.ts` | Per pull request |
| `preview-environment.yml` | `.github/workflows/` | Called from your `pull_request` workflow |

```
  *.preview.example.com  →  shared ALB  ─┬─ host=pr-123…  →  TG  →  service   ┐
                                         ├─ host=pr-124…  →  TG  →  service   │ per-PR
                                         └─ default       →  404              ┘  stacks

  shared Postgres  ─┬─ preview_pr_123
                    └─ preview_pr_124
```

## What is shared, and why

A preview environment is only useful if opening a pull request is enough to get
one. That rules out a VPC, a load balancer, and a database per pull request:
fifteen minutes of provisioning before a reviewer sees anything, and a standing
bill for every open branch.

So everything slow or expensive is deployed once, and a pull request adds only
what genuinely cannot be shared — a task definition, a service, a target group,
and a listener rule. That deploys in about a minute and deletes in less.

What that costs in exchange is isolation. Previews share a load balancer, a
database instance, and a security group, so a pull request can exhaust shared
capacity for the others. For reviewing a branch that is the right trade; for
load-testing one it is not, and a preview is the wrong tool for that anyway.

Two consequences of sharing are worth knowing before you copy this:

**Per-PR stacks create no security-group rules.** Every preview task attaches to
the shared task security group, which the shared stack has already allowed into
the database. If each preview added its own ingress rule instead, the rule would
live in a stack designed to be deleted while the group it modifies outlives it —
and a preview that fails to delete cleanly strands a rule against a resource
with a hard limit of 60 rules.

**The listener's default action is a 404.** The wildcard DNS record resolves for
every hostname under the preview domain, including previews that no longer
exist. Whatever the default action is, that is what a stale link in a pull
request comment reaches. Anything other than an explicit "not here" serves an
unrelated pull request to somebody who thinks they are looking at their own.

## Ordering: database, then seed, then serve

The service is declared with **zero tasks**. That is not a mistake to fix.

CloudFormation creates the task definition and the service in the same
operation. A service declared with one task starts the application inside that
operation, against a database that has no schema yet — because the seed cannot
run until the task definition it overrides exists. The application crash-loops,
the deployment circuit breaker trips or CloudFormation waits for a service that
will never reach steady state, and the stack fails on the deploy that matters
most: the first one.

So the deploy workflow does this instead:

1. **Create the database.** `CREATE DATABASE` cannot run inside a transaction
   and needs a connection to a different database, so it cannot be part of the
   application's own migration step. A throwaway Fargate task running the stock
   `postgres` image does it, idempotently.
2. **Deploy the stack.** It converges immediately, with nothing running.
3. **Seed.** The same task definition the service uses, run once with the
   command overridden. Same image, so the migrations and the fixtures are the
   ones in the commit under review.
4. **Scale to one and wait for the service to stabilise.**

Every push repeats all four. The preview goes down, gets fresh fixtures, and
comes back — which is what makes redeploys deterministic instead of leaving a
half-migrated database behind whenever a branch changes its schema.

## Seeding: the contract

Your application image needs one command that is safe to run repeatedly against
a preview database:

```jsonc
// package.json
"scripts": {
  "seed:preview": "prisma migrate deploy && tsx scripts/seed-preview.ts"
}
```

Pass a different one as `seedCommand` on `PreviewPrStack` in `bin/app.ts`. The
workflow reads it back from the stack's `PreviewSeedCommand` output rather than
taking it as an input, so there is one place it can be wrong instead of two.
What the workflow guarantees is only that it runs on the image under review,
exactly once per deploy, and that a non-zero exit fails the deploy before the
service scales up.

The connection details arrive as libpq's own environment variables — `PGHOST`,
`PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` — which most Postgres drivers
read without being asked. If your application insists on a `DATABASE_URL`,
compose it in the entrypoint:

```sh
export DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"
```

There is no `DATABASE_URL` in the task definition on purpose: the password would
have to be in it as plaintext, where `aws ecs describe-task-definition` hands it
to anyone with read access to the cluster. `PGPASSWORD` is injected by ECS from
Secrets Manager instead, which keeps it out of the definition entirely.

**Seed fixtures, never a production snapshot.** A preview is reachable from the
internet, is protected by nothing but an unguessable hostname, and is destroyed
without ceremony by an hourly Lambda. Restoring real customer data into one is a
breach with a redeploy schedule.

## Teardown: two mechanisms, on purpose

The workflow's `destroy` action is the fast path. It runs on
`pull_request: closed`, drops the database, and deletes the stack.

It is not the guarantee. A `closed` event fails to reach a runner whenever the
run is cancelled, Actions is disabled or degraded, the workflow file is not on
the branch being closed, or the job fails for an unrelated reason. Every one of
those is silent, and the environment keeps running and keeps billing until
somebody happens to look at the ECS console.

So `PreviewEnvironmentStack` also deploys a **reaper**: an hourly Lambda that
deletes preview stacks nothing else collected.

| Situation | What the reaper does |
|---|---|
| Pull request closed | Delete |
| Pull request open, stack older than `maxLifetimeHours` (7 days) | Delete |
| Pull request state unknown, stack older than `unknownStateTtlHours` (3 days) | Delete |
| Pull request open, within the limit | Keep |
| Pull request state unknown, within the limit | Keep |

The distinction between *closed* and *unknown* is the one that matters. Every
GitHub failure — no token, a rate limit, an outage, a repository rename, a 404 —
returns `unknown`, never `closed`. An environment deleted mid-review because
GitHub returned a 500 cannot be given back, and the lifetime bound already caps
what being wrong in the other direction costs.

Three further guards, because a reaper is a program whose bugs delete things:

- A stack is only touched when the marker tag, a numeric pull-request tag, and
  the stack-name prefix all agree. The third is enforced by IAM — the reaper's
  `cloudformation:DeleteStack` permission is scoped to `{envName}-pr-*` — so the
  narrowest check does not depend on the handler being correct.
- The shared stack's name is refused explicitly, and the shared stack is never
  tagged as disposable.
- At most `maxDeletionsPerRun` (10) stacks go per sweep, oldest first, and the
  summary names every stack the cap deferred. A sweep permanently behind is
  visible rather than looking like a clean one.

Set `reaperDryRun: true` to run the sweep and report its verdicts without
deleting anything. Worth doing for a day when adopting this on an account that
already has preview stacks in it.

`DescribeStacks` accepts no resource-level permissions, so the reaper reads
every stack in the account and filters in the handler. Only `DeleteStack` — the
call that destroys something — is scoped by name.

### Why deleting uses DeleteStack, not `cdk destroy`

Both the workflow and the reaper call `cloudformation:DeleteStack` directly.
`cdk destroy` would need the repository checked out at a commit that still
synthesises this stack, and by the time a pull request closes its branch is
usually deleted. A teardown that requires the branch to still exist is a
teardown that fails exactly when it is needed.

This relies on the stack having been deployed by the CDK's default synthesiser,
which records the bootstrap execution role on the stack. CloudFormation reuses
that role for the delete, so the caller needs only `DeleteStack` rather than
delete permissions on every resource type a preview contains. Deploying with the
legacy synthesiser, or with `--no-role-arn`, breaks that and the deletes will
fail with access-denied errors on the resources.

## Wiring it up

### 1. Prerequisites

- A wildcard ACM certificate for `*.preview.example.com`.
- A Route 53 hosted zone, if you want the stack to create the wildcard alias
  record; otherwise point `*.preview.example.com` at the ALB yourself.
- A GitHub OIDC role (see `github-oidc-stack.ts`) the deploy workflow can
  assume.
- Optionally, a Secrets Manager secret holding a GitHub token with
  `pull_requests: read`, as `{"token": "..."}`. Without it the reaper cannot see
  whether a pull request is open and falls back to age alone — which means every
  preview lives for `unknownStateTtlHours` whether or not its pull request
  closed the same afternoon.

### 2. Deploy the shared stack

```sh
cd aws/cdk
npx cdk deploy preview-shared \
  --context previewCertificateArn=arn:aws:acm:us-east-1:123456789012:certificate/… \
  --context previewDomain=preview.example.com \
  --context previewRepository=your-org/your-repo \
  --context previewGitHubTokenSecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:…
```

Deploy it from the same CDK app that defines `PreviewPrStack`, which `bin/app.ts`
already does. The per-PR stack references the shared cluster, listener, security
group, log group, and database, and the CDK turns those into CloudFormation
exports on the shared stack — but only if the consumer is present when the
producer is synthesised. That is why `bin/app.ts` instantiates a preview stack
unconditionally, defaulting to pull request 1: the exports are identical for
every pull request number, so one exemplar is enough to create them, and it also
gives `cdk synth` a per-PR template for Checkov to scan.

Pass the same `previewDomain` and `envName` to every later `cdk deploy` of a
preview. The hostname on the listener rule comes from the domain, and a mismatch
routes a preview to a name the wildcard certificate does not cover.

### 3. Call the workflow from your pull request workflow

```yaml
name: Pull request

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  build:
    if: github.event.action != 'closed'
    # … build and push an image tagged with the head SHA, output image-uri …

  preview:
    if: github.event.action != 'closed'
    needs: build
    uses: ./.github/workflows/preview-environment.yml
    with:
      action: deploy
      pr-number: ${{ github.event.pull_request.number }}
      image-uri: ${{ needs.build.outputs.image-uri }}
      is-fork: ${{ github.event.pull_request.head.repo.fork }}
      preview-domain: preview.example.com
      env-name: preview
    secrets:
      AWS_ROLE_ARN: ${{ secrets.PREVIEW_DEPLOY_ROLE_ARN }}

  teardown:
    if: github.event.action == 'closed'
    uses: ./.github/workflows/preview-environment.yml
    with:
      action: destroy
      pr-number: ${{ github.event.pull_request.number }}
    secrets:
      AWS_ROLE_ARN: ${{ secrets.PREVIEW_DEPLOY_ROLE_ARN }}
```

### Forks get no preview

The deploy assumes an AWS role in your account and then runs the pull request's
own code against it — including its seed command, against a database on a shared
instance. For a fork that is a supply-chain hole rather than a convenience, so
`is-fork: true` fails the job immediately.

The workaround people reach for, `pull_request_target`, makes it worse: it hands
the base repository's secrets to a workflow that then builds the fork's code. If
you need previews for fork contributions, gate them behind a maintainer applying
a label and a manually approved deployment environment, and accept that you are
reviewing the diff for supply-chain risk before it deploys.

## Limits

| Limit | Value | What happens when you hit it |
|---|---|---|
| Rules per ALB listener | 100 (adjustable) | The 101st concurrent preview fails to deploy |
| Target groups per ALB | 100 (adjustable) | Same |
| Listener-rule priorities | 1–50000 | Handled by wrapping, below |
| Security-group rules | 60 | Not reached: per-PR stacks add none |

Rule priorities are **derived** from the pull request number
(`1000 + prNumber % 40000`), not allocated. Allocation needs somewhere to record
which priorities are taken, and two pull requests deploying at the same moment
would race for the same free slot. Deriving means the answer is the same every
time and two deploys cannot disagree.

The wrap exists so a repository that reaches pull request 50000 does not start
synthesising priorities the ALB rejects. It trades that for a collision between
two open pull requests numbered exactly 40000 apart, which is not silent:
CloudFormation refuses the second rule with `PriorityInUse`. Widen the range or
move the base if you ever see it.

## Cost

Roughly, in `us-east-1`, at the defaults:

| | |
|---|---|
| ALB | ~$16/month + LCUs, shared |
| `db.t4g.micro` + 20 GiB gp3 | ~$14/month, shared |
| Reaper Lambda + schedule | Cents |
| Per preview (0.5 vCPU / 1 GiB Fargate) | ~$18/month if it ran continuously |

The standing cost is about $30/month whether or not anything is open. Per-preview
cost is the number that argues for the reaper: ten forgotten environments is
$180/month of nothing, and forgetting is the default outcome of relying on a
webhook.

## What is deliberately not here

- **Per-preview isolation of the database instance.** One database per pull
  request inside one instance. A pull request that fills the disk affects the
  others; a pull request that needs a different Postgres version is not
  supported. Both are fixable by moving to Aurora Serverless v2 with a cluster
  per preview, at roughly ten times the standing cost.
- **Access control.** Previews are reachable by anyone who knows the hostname.
  Put Cognito or an OIDC-aware proxy on the listener if the fixtures are
  sensitive — but the better answer is fixtures that are not.
- **Seeded object storage or queues.** Only the database is provisioned per pull
  request. An application that needs an S3 prefix or an SQS queue per preview
  should add them to `PreviewPrStack`, where they will be deleted with it.
