-- migration: 007_contract_drop_full_name
-- phase: contract
-- release: 1.7.0
-- safe-after: 1.6.0
-- transaction: implicit
-- rollback: none. This is the step that cannot be undone — see below.
--
-- Remove the old shape. Nothing running reads or writes `full_name`.
--
-- `safe-after: 1.6.0` is a claim with a checkable meaning: 1.6.0 is the release
-- that stopped reading `full_name`, and it is fully rolled out. Before merging
-- this, confirm both halves — that the readers really are gone (grep the
-- application, then check `pg_stat_statements` for queries still naming the
-- column), and that no instance of 1.5.x or earlier is still running anywhere,
-- including the batch jobs and the admin console that deploy on their own
-- schedule.
--
-- The reason the check is worth doing carefully is that this is the one step in
-- the sequence a rollback cannot save. Redeploying 1.6.0 brings the old code
-- back; it does not bring the column back, and the data that was in it is gone.
-- Every earlier migration here is reversible, which is why they are allowed to
-- ship on the deployment's schedule and this one is not.
--
-- Three releases of daylight between the last reader (1.6.0) and this drop is
-- the point of the gap, not a formality. It is what makes "roll back to the
-- previous release" a working answer for the whole window in which the split
-- columns are being trusted for the first time.
--
-- The trigger and the split functions go with the column: the trigger only
-- exists to keep `full_name` in step, and once the column is gone it is dead
-- code that fires on every write to the table.

DROP TRIGGER users_sync_name_trigger ON users;

DROP FUNCTION users_sync_name();

DROP FUNCTION name_first_part(text);

DROP FUNCTION name_last_part(text);

ALTER TABLE users DROP COLUMN full_name;
