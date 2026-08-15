-- migration: 004_expand_check_first_name_not_null
-- phase: expand
-- release: 1.5.0
-- transaction: implicit
-- rollback: ALTER TABLE users DROP CONSTRAINT users_first_name_not_null.
--
-- Start enforcing what the backfill established, without a table scan.
--
-- `NOT VALID` is the load-bearing word. Adding a CHECK constraint normally
-- validates every existing row before it will commit, and it holds an ACCESS
-- EXCLUSIVE lock — which blocks reads, not just writes — for the whole scan.
-- On a large table that is a stall of unbounded length in the middle of a
-- deployment, and it happens under the BeforeAllowTraffic hook, where the only
-- code running is the old code.
--
-- `NOT VALID` takes the same lock for the microsecond it needs to write one
-- catalogue row, and from that instant the constraint is enforced on every
-- INSERT and UPDATE. What it does not do is make any claim about rows written
-- earlier. 005 makes that claim, separately, under a weaker lock.
--
-- The constraint is a CHECK rather than SET NOT NULL for the same reason. Both
-- express the same rule; only one of them can be added without scanning.
--
-- Only `first_name` is constrained. `last_name` is legitimately NULL for a
-- single-word name, and constraining it would encode an assumption about names
-- that this migration has no business making.
--
-- Before merging, ask the database whether the rule is actually true — 005 will
-- find out either way, but it will find out mid-deployment:
--   SELECT count(*) FROM users WHERE first_name IS NULL;
-- A non-zero answer usually means 003 has not finished. It can also mean the
-- rule does not hold: here, a row whose `full_name` is entirely whitespace
-- splits to nothing.

ALTER TABLE users
    ADD CONSTRAINT users_first_name_not_null
    CHECK (first_name IS NOT NULL)
    NOT VALID;
