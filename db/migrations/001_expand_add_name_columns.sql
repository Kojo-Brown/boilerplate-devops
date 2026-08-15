-- migration: 001_expand_add_name_columns
-- phase: expand
-- release: 1.4.0
-- transaction: implicit
-- rollback: DROP the trigger, the functions, and the two columns. Release 1.3.0
--           never reads them, so this is reversible right up until 1.5.0 has
--           written rows whose names the old shape cannot represent — which is
--           why the contract step waits rather than following behind.
--
-- Add the target shape alongside the current one and keep the two in step.
--
-- The columns are nullable. They have to be: this migration runs from
-- CodeDeploy's BeforeAllowTraffic hook, so at the moment it commits, the only
-- code running is 1.3.0, which has never heard of `first_name` and will not
-- supply it. A NOT NULL column here would fail every INSERT the old code makes
-- until traffic shifted, which is the opposite of the property being bought.
--
-- Synchronisation is a trigger rather than dual-write in the application, for
-- one reason: application dual-write only holds while *every* writer is running
-- a version that does it, and during the rollout — and during a rollback — that
-- is exactly what is not true. The trigger is one deployment unit, it commits
-- with the schema, and it covers the writers nobody remembers: the admin
-- console, a psql session, the seed job.
--
-- The cost is that name splitting becomes database logic, and splitting a
-- personal name on whitespace is wrong for a large share of the world's names.
-- That is a property of the product decision this migration inherits, not of
-- the technique; the trigger reproduces whatever the application already did,
-- and does not get to be more correct than the data it derives from.
--
-- `full_name` keeps its NOT NULL constraint. A BEFORE trigger runs ahead of
-- constraint checking, so an INSERT from 1.5.0 supplying only the split columns
-- still has `full_name` populated by the time the constraint is evaluated.

-- The split rules live in functions rather than inline in the trigger so that
-- the backfill in 003 applies exactly the same transformation. Two copies of a
-- splitting rule diverge, and the divergence shows up as rows that disagree
-- with themselves depending on which release wrote them.
CREATE FUNCTION name_first_part(full_name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT
AS $$
    SELECT NULLIF(split_part(btrim(full_name), ' ', 1), '')
$$;

CREATE FUNCTION name_last_part(full_name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT
AS $$
    SELECT NULLIF(
        btrim(substr(btrim(full_name), length(split_part(btrim(full_name), ' ', 1)) + 1)),
        ''
    )
$$;

ALTER TABLE users ADD COLUMN first_name text;

ALTER TABLE users ADD COLUMN last_name text;

CREATE FUNCTION users_sync_name() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    wrote_full_name  boolean;
    wrote_split_name boolean;
BEGIN
    -- The backfill sets the split columns from `full_name` directly and must not
    -- have `full_name` recomputed back out of them: that would rewrite a column
    -- 1.3.0 is still reading, in a batch job, for no reason anybody asked for.
    -- A session GUC is the narrowest available escape hatch — it is scoped to
    -- the one connection doing the backfill, where DISABLE TRIGGER would take an
    -- ACCESS EXCLUSIVE lock and turn the trigger off for every other session too.
    IF current_setting('app.skip_name_sync', true) = 'on' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        wrote_full_name  := NEW.full_name IS NOT NULL;
        wrote_split_name := NEW.first_name IS NOT NULL OR NEW.last_name IS NOT NULL;
    ELSE
        wrote_full_name  := NEW.full_name IS DISTINCT FROM OLD.full_name;
        wrote_split_name := NEW.first_name IS DISTINCT FROM OLD.first_name
                         OR NEW.last_name  IS DISTINCT FROM OLD.last_name;
    END IF;

    -- Each direction fires only when the other side was left alone. A writer
    -- that sets both columns has said what it means and is not second-guessed;
    -- that is what 1.5.0 does during the release where it writes both shapes.
    IF wrote_split_name AND NOT wrote_full_name THEN
        NEW.full_name := NULLIF(
            btrim(concat_ws(' ', NULLIF(btrim(NEW.first_name), ''), NULLIF(btrim(NEW.last_name), ''))),
            ''
        );
    ELSIF wrote_full_name AND NOT wrote_split_name THEN
        NEW.first_name := name_first_part(NEW.full_name);
        NEW.last_name  := name_last_part(NEW.full_name);
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER users_sync_name_trigger
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION users_sync_name();
