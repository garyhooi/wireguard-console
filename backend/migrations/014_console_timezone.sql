-- Console-wide timezone preference, editable from Configuration.
--
-- Every timestamp the SPA renders (statistics, web activity, audit log,
-- handshakes, …) is converted to this zone on the client, and the hourly
-- traffic chart buckets samples by hour in this zone. Stored as an IANA
-- name (e.g. 'Asia/Kuala_Lumpur'); empty/null means "follow the viewer's
-- browser" so nothing changes until an admin explicitly picks a zone.
--
-- The config table is a single-row table (id = 1 CHECK constraint, created
-- by 003_smtp_config.sql) that later migrations extend with ADD COLUMN. A
-- fresh install runs 003 first, so the row may not exist yet on upgrades of
-- very old installs that predate 003 — seed it idempotently.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING): the
-- migration runner executes every .sql file at each boot with no tracking
-- table, so each statement must tolerate re-runs.
ALTER TABLE config ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT '';

INSERT INTO config (id, timezone)
VALUES (1, '')
ON CONFLICT (id) DO NOTHING;
