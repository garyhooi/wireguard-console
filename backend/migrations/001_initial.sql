CREATE TABLE IF NOT EXISTS admins (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                  TEXT UNIQUE NOT NULL,
    password_hash          TEXT NOT NULL,
    role                   TEXT NOT NULL CHECK (role IN ('super_admin','admin','auditor')),
    totp_secret_encrypted  TEXT,
    totp_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
    backup_codes_hash      TEXT[],
    status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    failed_login_count     INT NOT NULL DEFAULT 0,
    locked_until           TIMESTAMPTZ,
    last_login_at          TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id     UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    ip_address   INET,
    user_agent   TEXT,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email        TEXT UNIQUE NOT NULL,
    full_name    TEXT,
    status       TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended','removed')),
    invited_by   UUID REFERENCES admins(id),
    invited_at   TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    accepted_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS servers (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                        TEXT NOT NULL,
    public_endpoint             TEXT NOT NULL,
    listen_port                 INT NOT NULL,
    interface_name              TEXT NOT NULL,
    server_public_key           TEXT NOT NULL,
    server_private_key_encrypted TEXT NOT NULL,
    network_cidr                CIDR NOT NULL,
    dns_servers                 TEXT[] NOT NULL,
    default_allowed_ips         TEXT NOT NULL DEFAULT '0.0.0.0/0',
    mtu                         INT NOT NULL DEFAULT 1420,
    persistent_keepalive        INT NOT NULL DEFAULT 25,
    status                      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS peers (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id                UUID NOT NULL REFERENCES servers(id),
    name                     TEXT NOT NULL,
    public_key               TEXT UNIQUE NOT NULL,
    private_key_encrypted    TEXT,
    preshared_key_encrypted  TEXT NOT NULL,
    allowed_ip               INET NOT NULL,
    status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
    last_handshake_at        TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    suspended_at               TIMESTAMPTZ,
    removed_at                 TIMESTAMPTZ,
    UNIQUE (server_id, allowed_ip)
);

CREATE TABLE IF NOT EXISTS peer_traffic_samples (
    id          BIGSERIAL PRIMARY KEY,
    peer_id     UUID NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
    rx_bytes    BIGINT NOT NULL,
    tx_bytes    BIGINT NOT NULL,
    sampled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_peer_traffic_samples_peer_id_sampled_at ON peer_traffic_samples (peer_id, sampled_at);

CREATE TABLE IF NOT EXISTS domain_block_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope       TEXT NOT NULL CHECK (scope IN ('global','user')),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    domain      TEXT NOT NULL,
    created_by  UUID REFERENCES admins(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scope = 'global' AND user_id IS NULL) OR (scope = 'user' AND user_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id               BIGSERIAL PRIMARY KEY,
    actor_admin_id   UUID REFERENCES admins(id),
    action           TEXT NOT NULL,
    target_type      TEXT,
    target_id        TEXT,
    metadata         JSONB,
    ip_address       INET,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_admin_id ON audit_logs (actor_admin_id);

CREATE TABLE IF NOT EXISTS jobs (
    id           BIGSERIAL PRIMARY KEY,
    kind         TEXT NOT NULL,
    payload      JSONB NOT NULL,
    attempts     INT NOT NULL DEFAULT 0,
    run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at    TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at    TIMESTAMPTZ,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
