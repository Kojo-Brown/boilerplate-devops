-- migration: 000_baseline_users
-- phase: baseline
-- release: 1.3.0
-- transaction: implicit
-- rollback: DROP TABLE users. Nothing has run against it yet.
--
-- The schema this worked example starts from: one `full_name` column, which is
-- the shape every application has before someone asks to sort the user list by
-- surname. Everything from 001 onwards exists to replace it without a
-- maintenance window.
--
-- Indexes here are built without CONCURRENTLY on purpose. The table is created
-- in this same migration, so it holds no rows and serves no traffic — the lock
-- a plain CREATE INDEX takes is a lock on nothing. `audit:migrations` knows
-- this and only requires CONCURRENTLY for indexes on pre-existing tables.

CREATE TABLE users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email      text        NOT NULL,
    full_name  text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE INDEX users_created_at_idx ON users (created_at DESC);
