-- 2FA step-up grace window (Configuration → Security, super_admin only).
--
-- step_up_minutes: how long after one successful step-up 2FA verification an
-- admin's SAME SESSION is trusted for the other sensitive actions (server /
-- node edits, deletes, backup download/restore, …) without re-entering a
-- code. 0 (default) = disabled: every sensitive action asks for a code, the
-- previous behaviour.
--
-- step_up_verified_at: per-session timestamp of the last successful step-up
-- verification, stamped by verifyActor2FA. Session-scoped deliberately: a
-- fresh login or another admin's session never inherits the grace, and any
-- password/2FA change revokes sessions anyway (so grace can't survive a
-- credential change).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / INSERT ... ON CONFLICT): the
-- migration runner executes every .sql file at each boot with no tracking
-- table, so each statement must tolerate re-runs.
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS step_up_verified_at TIMESTAMPTZ;
ALTER TABLE config ADD COLUMN IF NOT EXISTS step_up_minutes INT NOT NULL DEFAULT 0;

INSERT INTO config (id, step_up_minutes)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
