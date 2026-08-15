-- migration: 003_backfill_name_columns
-- phase: backfill
-- release: 1.4.1
-- transaction: none
-- rollback: none needed. The statement is idempotent and writes only columns
--           that no released code reads yet; re-running it is free.
--
-- Fill in the rows that existed before 001. The trigger only sees writes, so
-- every user who has not been edited since 1.4.0 shipped still has NULL split
-- columns, and the constraint in 004 cannot be validated until they do not.
--
-- Ships as its own release, after 001 has been in production long enough to
-- prove the trigger is correct. Backfilling in the same deploy that adds the
-- trigger means discovering a bug in the splitting rule after it has already
-- been applied to every row in the table.
--
-- Batching is the whole point. A single
--     UPDATE users SET first_name = ..., last_name = ...
-- takes a row lock on every row in the table and holds it until the statement
-- ends, writes a new version of every row into one transaction that autovacuum
-- cannot clean up behind, and — if it is killed at 90% — has to start again
-- from nothing. The loop below does the same work in 1,000-row transactions:
-- each commit releases its locks, each batch is separately vacuumable, and an
-- interrupted run resumes where it stopped because `first_name IS NULL` is the
-- only cursor it needs.
--
-- The ORDER BY is not cosmetic. Without it, concurrent batches would pick
-- overlapping row sets and deadlock against each other.
--
-- `-- transaction: none` because a DO block cannot COMMIT if the runner has
-- already opened a transaction around the file.

-- Suppress the sync trigger for this session only: this backfill derives the
-- split columns *from* `full_name`, and letting the trigger derive `full_name`
-- back out of them would rewrite a column 1.3.0 still reads, normalising
-- whitespace nobody asked to have normalised.
SET app.skip_name_sync = 'on';

DO $$
DECLARE
    batch_size constant integer := 1000;
    updated    integer;
    total      bigint := 0;
BEGIN
    LOOP
        UPDATE users
           SET first_name = name_first_part(full_name),
               last_name  = name_last_part(full_name)
         WHERE id IN (
                   SELECT id
                     FROM users
                    WHERE first_name IS NULL
                      AND full_name IS NOT NULL
                    ORDER BY id
                    LIMIT batch_size
               );

        GET DIAGNOSTICS updated = ROW_COUNT;
        total := total + updated;

        COMMIT;
        EXIT WHEN updated = 0;
    END LOOP;

    RAISE NOTICE 'backfilled % rows into users.first_name/last_name', total;
END
$$;

RESET app.skip_name_sync;
