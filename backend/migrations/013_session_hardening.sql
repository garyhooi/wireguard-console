-- Session auth hardening: HttpOnly-cookie sessions + per-session CSRF.
--
-- The admin session token moves out of localStorage into an HttpOnly
-- SameSite=Strict cookie (wgc_session). Because the credential then travels
-- automatically on every same-site request, state-changing requests must
-- carry a per-session CSRF token (X-CSRF-Token) validated server-side
-- against this row — defense-in-depth over SameSite=Strict.
--
-- csrf_token:  random 32-byte (hex) value minted with the session, returned
--              once in JSON to the SPA, kept in JS memory (never stored
--              client-side in a way XSS can exfiltrate alongside the cookie —
--              HttpOnly keeps the cookie out of JS entirely).
-- last_seen_at: idle-timeout tracking (written throttled by the middleware).
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS): the
-- migration runner executes every .sql file at each boot with no tracking
-- table, so each statement must tolerate re-runs.
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS csrf_token   TEXT;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Revocation (DELETE ... WHERE admin_id = $1) and expiry purge both scan on
-- admin_id / expires_at.
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id   ON admin_sessions (admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions (expires_at);
