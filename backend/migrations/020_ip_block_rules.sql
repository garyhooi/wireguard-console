-- IP blocking: admin-defined IPv4/IPv6 destinations dropped for VPN peer
-- traffic at the WireGuard server's forward hook (wg-helper nftables).
-- Idempotent: the migration runner executes every .sql file at each boot.
CREATE TABLE IF NOT EXISTS ip_block_rules (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope      TEXT NOT NULL CHECK (scope IN ('global', 'user')),
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    -- Canonical network form: "203.0.113.0/24" / "2001:db8::/48";
    -- a bare address is stored as /32 or /128.
    cidr       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_by UUID REFERENCES admins(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scope = 'global' AND user_id IS NULL)
        OR (scope = 'user'   AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ip_block_rules_unique
    ON ip_block_rules (
        scope,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        cidr
    );
CREATE INDEX IF NOT EXISTS idx_ip_block_rules_user_id
    ON ip_block_rules (user_id) WHERE user_id IS NOT NULL;
