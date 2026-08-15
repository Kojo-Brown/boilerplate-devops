# db/

The worked example that accompanies
[`docs/expand-contract-migrations.md`](../docs/expand-contract-migrations.md):
splitting `users.full_name` into `first_name` and `last_name` across five
releases, without a maintenance window.

These migrations are **reference material, not this repository's schema**. This
repository has no database. They are here to be read alongside the playbook, and
to be checked by the same gate that will check yours:

```bash
cd aws/cdk
npm run audit:migrations                     # this directory
npx ts-node tools/audit-migrations.ts path/to/your/migrations
```

`npm run audit:migrations` runs in CI against this directory on every pull
request, so the example is executed rather than illustrative. If it ever stops
being expand/contract safe, the playbook is telling readers to do something this
repository does not do itself.

| File | Phase | Release | What it does |
|---|---|---|---|
| `000_baseline_users.sql` | baseline | 1.3.0 | the schema everything else starts from |
| `001_expand_add_name_columns.sql` | expand | 1.4.0 | nullable columns, split functions, sync trigger |
| `002_expand_index_last_name.sql` | expand | 1.4.0 | `CREATE INDEX CONCURRENTLY` |
| `003_backfill_name_columns.sql` | backfill | 1.4.1 | batched, committing, resumable |
| `004_expand_check_first_name_not_null.sql` | expand | 1.5.0 | `CHECK ... NOT VALID` |
| `005_expand_validate_first_name.sql` | expand | 1.5.1 | `VALIDATE CONSTRAINT` |
| `006_expand_set_first_name_not_null.sql` | expand | 1.5.2 | `SET NOT NULL`, scan-free |
| `007_contract_drop_full_name.sql` | contract | 1.7.0 | the drop — the one irreversible step |

Release 1.6.0 has no migration. It is the release where reads move to the new
columns, and it is what `007`'s `safe-after:` header refers to.

Dialect is PostgreSQL. Each file carries a header block declaring its phase,
release, transaction requirements, and how to roll it back; the header format
and the rules enforced against it are documented in the playbook.
