# Expand/contract database migrations

A deployment is not atomic. For a window that runs from seconds on a rolling
deploy to the better part of an hour on a canary, two versions of the
application are serving production traffic against one database. Every schema
change has to be true for both of them.

In this repository the window is wider than that, and in the more dangerous
direction. `DbMigrationStack` runs migrations from CodeDeploy's
**BeforeAllowTraffic** hook, which is the right place for them — a failed
migration fails the hook and the deployment rolls back before a single request
reaches the new tasks. But it means that at the moment a migration commits, the
only code running is the **old** code. A migration that needs the new code to
already be deployed does not fail at the end of the rollout. It fails at the
start of it, against the version you were trying to replace.

So the constraint is not "the migration and the release ship together". It is:

> A migration must leave the database in a state that the currently running
> release is happy with, and that the next release will also be happy with.

Expand/contract is how you get that. Every change is split into an additive
step the old code cannot notice, and a destructive step that ships only once no
running code refers to the thing being removed — usually several releases later.

| | Expand | Contract |
|---|---|---|
| Does what | adds columns, tables, indexes, constraints | drops them |
| Old code | does not know it happened | would break |
| Reversible | yes | no |
| Ships | with the release that needs it, or earlier | releases after the last reader is gone |

`npm run audit:migrations` enforces the parts of this that can be checked
mechanically, and runs in CI. The rules are listed at the bottom.

## The worked example

[`db/migrations/`](../db/migrations) splits `users.full_name` into `first_name`
and `last_name` without a maintenance window. It is the canonical hard case:
renaming or reshaping a column that is read and written on every request.

A rename cannot be done in one step — `ALTER TABLE ... RENAME COLUMN` is
instantaneous and atomic, and that is precisely the problem. There is no instant
at which both names exist, so whichever half of the fleet has not been replaced
yet is broken until it is. The audit rejects renames outright for that reason.

Here is the whole sequence. Read the middle column as "what the application does
during this release", not "what changed in it".

| Release | Application | Migration | Reversible |
|---|---|---|---|
| 1.3.0 | reads and writes `full_name` | `000` baseline | — |
| 1.4.0 | unchanged | `001` add nullable columns + sync trigger<br>`002` build the index concurrently | yes |
| 1.4.1 | unchanged | `003` backfill in batches | yes |
| 1.5.0 | **writes** `first_name`/`last_name`; still reads `full_name` | `004` `CHECK ... NOT VALID` | yes |
| 1.5.1 | unchanged | `005` `VALIDATE CONSTRAINT` | yes |
| 1.5.2 | unchanged | `006` `SET NOT NULL`, drop the now-redundant CHECK | yes |
| 1.6.0 | **reads** `first_name`/`last_name`; stops touching `full_name` | *none* | yes |
| 1.7.0 | unchanged | `007` drop the trigger, the functions, and `full_name` | **no** |

Five things in that table are doing real work.

**The columns go in nullable.** They are added while 1.3.0 is the only thing
running, and 1.3.0 does not supply them. `ADD COLUMN ... NOT NULL` without a
default fails immediately on a non-empty table; with a default it succeeds, and
then every INSERT from the old code fails instead. Nullable now, constrained in
1.5.2, once there is something to constrain.

**A trigger keeps the two shapes in step, not application dual-write.**
Dual-write in the application only holds while every writer is running a version
that does it, and during a rollout — and during a rollback — that is exactly what
is not true. The trigger commits with the schema, is one deployment unit, and
covers the writers nobody remembers: the admin console, a psql session, the seed
job. The price is that name-splitting becomes database logic, in the same
knowingly-wrong form the application already used.

**The backfill is its own release, and it is batched.** Its own release because
shipping it alongside the trigger means finding a bug in the splitting rule
after it has already been applied to every row. Batched because a single
`UPDATE users SET ...` locks every row it touches until the statement ends,
writes a new version of every row into one transaction that autovacuum cannot
clean up behind, and — killed at 90% — starts again from nothing. The loop in
`003` commits every thousand rows, so each batch releases its locks and is
separately vacuumable, and an interrupted run resumes where it stopped.

**The NOT NULL constraint arrives in three steps, and each one is cheap.**
`SET NOT NULL` normally scans every row under an `ACCESS EXCLUSIVE` lock, which
blocks reads as well as writes. Postgres 12 and later will skip that scan if a
*validated* `CHECK (col IS NOT NULL)` already proves it. So: add the CHECK
`NOT VALID` (locks for one catalogue write, and enforces on all new rows from
that instant), `VALIDATE` it in a later migration (a full scan, but under
`SHARE UPDATE EXCLUSIVE`, so traffic continues), then `SET NOT NULL` for free.

**1.6.0 has no migration at all.** It is the release where reads move over, and
it is the one that starts the clock on the drop. `007` names it in a
`safe-after:` header, which is a claim someone has to check before merging.

## Locks, in the order they matter

Every rule the audit enforces reduces to one of these. `ACCESS EXCLUSIVE` is the
one that ends careers: it blocks readers, not just writers.

| Operation | Lock | Held for |
|---|---|---|
| `ADD COLUMN` (nullable, or with a default, PG11+) | ACCESS EXCLUSIVE | a catalogue write |
| `ADD COLUMN ... NOT NULL` without a default | ACCESS EXCLUSIVE | fails, or breaks old writers |
| `ADD CONSTRAINT ... NOT VALID` | ACCESS EXCLUSIVE | a catalogue write |
| `ADD CONSTRAINT` (validating) | ACCESS EXCLUSIVE | **a full table scan** |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE | a full table scan, concurrent with traffic |
| `SET NOT NULL` without a validated CHECK | ACCESS EXCLUSIVE | **a full table scan** |
| `SET NOT NULL` with one (PG12+) | ACCESS EXCLUSIVE | a catalogue write |
| `ALTER COLUMN ... TYPE` | ACCESS EXCLUSIVE | **a full table rewrite** |
| `CREATE INDEX` | SHARE | the build — blocks writes |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | two scans, concurrent with traffic |
| `DROP CONSTRAINT` | ACCESS EXCLUSIVE | a catalogue write |
| `DROP INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | a catalogue write |

The last two are compatible with any running release — widening what the
database accepts, or making a lookup slower, has never broken a writer — so they
do not have to wait for a contract release. They still take a lock, and still
want a `lock_timeout`.

Two practical notes on `CONCURRENTLY`. It cannot run inside a transaction block,
so the file must declare `-- transaction: none` and the runner must honour it;
otherwise the deploy fails with `CREATE INDEX CONCURRENTLY cannot run inside a
transaction block`. And a build that fails partway leaves an `INVALID` index
behind that the planner ignores and a retry does not repair — find them with

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

and `DROP INDEX CONCURRENTLY` before re-running.

Set a `lock_timeout` on the migration session regardless. An `ACCESS EXCLUSIVE`
request that queues behind a long-running read also blocks every request that
arrives after it, so a migration that would have taken a millisecond takes the
site down for the length of someone's analytics query:

```sql
SET lock_timeout = '3s';
SET statement_timeout = '15min';
```

Failing fast and retrying is strictly better than waiting, because waiting is
not passive.

## Rollback

Every migration up to and including `006` is reversible, which is what makes
"roll back to the previous release" a working answer for the whole period in
which the new columns are being trusted for the first time.

`007` is not. Redeploying 1.6.0 brings the old code back; it does not bring
`full_name` back, and the data that was in it is gone. That asymmetry is the
reason for the gap between the last reader (1.6.0) and the drop (1.7.0) — not
ceremony, just the recognition that this is the one step where being wrong is
not recoverable at deploy speed.

Before merging a contract migration, check both halves of its `safe-after:`
claim:

```bash
# 1. No code refers to it. Search the application, not just this service.
rg -w 'full_name' --glob '!db/migrations'

# 2. The database agrees nothing has asked for it recently.
psql -c "SELECT calls, query FROM pg_stat_statements
          WHERE query ILIKE '%full_name%' ORDER BY calls DESC LIMIT 20;"
```

and confirm that no instance of 1.5.x or earlier is still running anywhere —
including the batch jobs, the admin console, and anything else that deploys on
its own schedule rather than yours.

The same care applies one step earlier, to constraints. `005` will fail if any
row still violates the CHECK, which is the good outcome, but it fails *during a
deployment*. Ask first:

```sql
SELECT count(*) FROM users WHERE first_name IS NULL;
```

A non-zero answer usually means the backfill did not finish. It can also mean
the constraint is not true of your data — in this example, rows whose
`full_name` is entirely whitespace split to nothing.

## The gate

```bash
cd aws/cdk
npm run audit:migrations                     # db/migrations
npx ts-node tools/audit-migrations.ts path/to/your/migrations
```

It runs in the CDK job in CI. It is not a SQL linter: it does not care about
style and does not build a syntax tree. It masks comments and string literals,
splits into statements, looks inside `DO` blocks and function bodies — a
`DROP TABLE` is no less destructive for being wrapped in PL/pgSQL — classifies
each statement as additive or destructive, and compares that with what the
migration declares about itself.

Every migration carries a header, and the header is the part a reviewer reads:

```sql
-- migration: 007_contract_drop_full_name   -- must match the filename
-- phase: contract                          -- baseline | expand | backfill | contract
-- release: 1.7.0
-- safe-after: 1.6.0                        -- required for contract: the release
--                                          -- that stopped using the object
-- transaction: implicit                    -- or `none`, for CONCURRENTLY and
--                                          -- for DO blocks that COMMIT
-- rollback: <how, or why there is no way back>
```

| Rule | Fires when |
|---|---|
| `missing-header` | no `migration:`, `phase:`, or `release:` |
| `header-name-mismatch` | the header names a different file — a copied header |
| `unknown-phase` | a phase outside the vocabulary |
| `duplicate-sequence` | two branches renumbered onto the same ordinal |
| `mixed-phase` | one file both adds and removes, so no release is safe to roll back to |
| `phase-mismatch` | the file does something its declared phase forbids |
| `contract-without-safe-after` | a drop with no record of what stopped using it |
| `irreversible-rename` | `RENAME COLUMN` / `RENAME TO` |
| `in-place-type-change` | `ALTER COLUMN ... TYPE` |
| `not-null-without-default` | `ADD COLUMN ... NOT NULL` with no default |
| `set-not-null-full-scan` | `SET NOT NULL` with no validated CHECK behind it |
| `index-without-concurrently` | index built on a table that already exists |
| `concurrent-index-in-transaction` | `CONCURRENTLY` without `-- transaction: none` |
| `unvalidated-constraint` | `ADD CONSTRAINT` (CHECK / FK) without `NOT VALID` |
| `constraint-never-validated` | `NOT VALID` added and never validated anywhere |
| `unbounded-backfill` | `UPDATE`/`DELETE` with no `WHERE` |
| `unbatched-backfill` | a backfill phase with no `LIMIT` anywhere |

Statements the audit cannot classify are left alone. It is a floor, not a proof:
it will not tell you whether your application is ready for the shape you are
adding, and it cannot know whether `safe-after:` is true. Those are review
questions, and the header exists so that review has something to ask about.

## Running them

The migration container runs whatever `DbMigrationStack` is configured to run —
`['npm', 'run', 'migrate']` by default — so the runner is your choice. What it
has to support:

- **Ordering by the numeric prefix**, and refusing to run out of order.
- **Per-file transaction control**, honouring `-- transaction: none`. A runner
  that always wraps files in `BEGIN`/`COMMIT` cannot run `002` or `003` at all.
- **Advisory locking**, so two deployments cannot migrate at once. Rolling
  deploys and canaries both make that concurrency reachable.

Wire it into a deployment one of two ways, both already in this repository:

- **`DbMigrationStack`** registers a Lambda as CodeDeploy's `BeforeAllowTraffic`
  hook. The Lambda runs the migration task, waits, and reports Succeeded or
  Failed; a failure rolls the deployment back before traffic shifts. This is the
  path that makes the "old code only" constraint above absolute.
- **`workflow-templates/db-migration-deploy.yml`** runs the same ECS task as a
  workflow job, with the deploy job `needs:` it. Use it when the deployment is
  not CodeDeploy-driven — the rolling `EcsStack` path, or a canary.

Either way the migration runs against the old code, and either way expand/contract
is what makes that survivable rather than lucky.

## What this does not cover

- **Cross-service changes.** The sequence above assumes one application owns the
  table. When two services write it, each phase needs every service through it
  before the next begins, and the release timeline is the slowest of them.
- **Table rewrites at scale.** Some changes have no additive form — repartitioning,
  or a type change on a table too large to copy inside a maintenance window.
  Those want a shadow table and a switchover, or a tool built for it
  (`pg_repack`, `pgroll`), not this playbook.
- **Data migrations with business meaning.** Splitting a name is mechanical.
  Recomputing a balance is not, and it needs a reconciliation step this pattern
  has nothing to say about.
