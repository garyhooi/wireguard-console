-- MFA + Passkeys: session state, WebAuthn credentials, ceremonies, policy.
-- The migration runner executes EVERY .sql file on EVERY boot with no tracking
-- table (see internal/db/db.go), so every statement below must be idempotent.

-- Session state: an explicit pending kind makes "pending verification" and
-- "pending enrollment" distinguishable (previously inferred from csrf_token
-- being NULL). mfa_attempts bounds second-factor guessing per pending login;
-- last_totp_counter prevents same-session authenticator-code replay;
-- step_up_* record how/when the acting session last passed a step-up check.
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS pending_kind TEXT;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS mfa_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS last_totp_counter BIGINT;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS step_up_method TEXT;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS step_up_fresh_until TIMESTAMPTZ;

-- Pre-upgrade pending rows (10-minute TTL) predate pending_kind; drop them so
-- no untyped pending row can ever be resolved again.
DELETE FROM admin_sessions WHERE csrf_token IS NULL AND pending_kind IS NULL;

-- One row per registered passkey. Credentials are bound to their RP ID: a
-- console-domain change orphans them (they stay listed but unusable). The
-- flags column stores the RAW protocol AuthenticatorFlags octet and MUST be
-- restored with webauthn.NewCredentialFlags - the backup-eligible bit is
-- re-checked on every login, so losing it fails every login for synced
-- passkeys. attestation/extensions are stored whole, as the library's storage
-- contract requires.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id           UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    rp_id              TEXT NOT NULL,
    credential_id      BYTEA NOT NULL,
    public_key         BYTEA NOT NULL,
    aaguid             BYTEA,
    sign_count         BIGINT NOT NULL DEFAULT 0,
    clone_warning      BOOLEAN NOT NULL DEFAULT FALSE,
    attachment         TEXT NOT NULL DEFAULT '',
    transports         TEXT NOT NULL DEFAULT '',
    flags              SMALLINT NOT NULL DEFAULT 0,
    user_present       BOOLEAN NOT NULL DEFAULT FALSE,
    user_verified      BOOLEAN NOT NULL DEFAULT FALSE,
    backup_eligible    BOOLEAN NOT NULL DEFAULT FALSE,
    backup_state       BOOLEAN NOT NULL DEFAULT FALSE,
    attestation_type   TEXT NOT NULL DEFAULT '',
    attestation_format TEXT NOT NULL DEFAULT '',
    attestation        JSONB,
    extensions         JSONB,
    label              TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS webauthn_credentials_rp_kid
    ON webauthn_credentials (rp_id, credential_id);
CREATE INDEX IF NOT EXISTS webauthn_credentials_admin_id
    ON webauthn_credentials (admin_id);

-- One stable, opaque WebAuthn user handle per (rp_id, admin). The handle is
-- what discoverable credentials would resolve to; it is NOT the admin UUID and
-- must stay stable for the account's lifetime under that RP ID.
CREATE TABLE IF NOT EXISTS webauthn_users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rp_id      TEXT NOT NULL,
    admin_id   UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    handle     BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS webauthn_users_rp_admin
    ON webauthn_users (rp_id, admin_id);
CREATE UNIQUE INDEX IF NOT EXISTS webauthn_users_rp_handle
    ON webauthn_users (rp_id, handle);

-- One row per in-flight WebAuthn ceremony. session_data is the library's
-- *webauthn.SessionData persisted verbatim (never hand-rebuilt: rebuilding
-- loses the requested-extension record and rejects legitimate outputs).
-- session_binding ties the ceremony to the browser cookie that started it.
-- Single-use is enforced with an atomic UPDATE ... RETURNING claim.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purpose         TEXT NOT NULL CHECK (purpose IN ('login','enroll','stepup')),
    admin_id        UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    session_binding TEXT NOT NULL DEFAULT '',
    rp_id           TEXT NOT NULL,
    origin          TEXT NOT NULL DEFAULT '',
    challenge_hash  TEXT NOT NULL,
    session_data    JSONB NOT NULL,
    lib_version     TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS webauthn_challenges_hash
    ON webauthn_challenges (challenge_hash);
CREATE INDEX IF NOT EXISTS webauthn_challenges_admin_purpose
    ON webauthn_challenges (admin_id, purpose);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expires_at
    ON webauthn_challenges (expires_at);

-- Organisation policy: which factors every admin must have before a session
-- is issued. 'any' = at least one factor; 'totp'/'passkey' = that factor
-- required; 'both' = both required. Deployment capability (can this install
-- do passkeys at all?) is derived at boot, never stored here.
ALTER TABLE config ADD COLUMN IF NOT EXISTS mfa_require_methods TEXT NOT NULL DEFAULT 'any';
INSERT INTO config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
