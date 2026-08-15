-- migration: 006_expand_set_first_name_not_null
-- phase: expand
-- release: 1.5.2
-- transaction: implicit
-- rollback: ALTER TABLE users ALTER COLUMN first_name DROP NOT NULL, and re-add
--           the CHECK constraint NOT VALID if the rollback needs to be complete.
--
-- Turn the proven CHECK into a real NOT NULL, and drop the scaffolding.
--
-- On Postgres 12 and later this is a catalogue update rather than a scan.
-- SET NOT NULL normally reads every row to prove none is NULL, but the planner
-- will accept a *validated* CHECK (first_name IS NOT NULL) as that proof and
-- skip the scan entirely. 004 and 005 exist to make that proof available here;
-- without them this statement is a full scan under ACCESS EXCLUSIVE, which is
-- the failure mode `audit:migrations` refuses.
--
-- Once the column is NOT NULL the CHECK is redundant — same rule, stated twice,
-- evaluated twice on every write. Dropping a constraint only widens what the
-- database will accept, so no running version of the application can notice; it
-- is not a contract step and does not have to wait for one.

ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT users_first_name_not_null;
