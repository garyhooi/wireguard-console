-- IP groups + IP-block hit accounting (v1.0.21).
-- Idempotent: the migration runner executes every .sql file at each boot.

-- Reusable named sets of IPv4/IPv6 CIDRs; a blocking rule can target a group.
CREATE TABLE IF NOT EXISTS ip_groups (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_by UUID REFERENCES admins(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ip_groups_name_unique
    ON ip_groups (lower(name));

CREATE TABLE IF NOT EXISTS ip_group_cidrs (
    group_id UUID NOT NULL REFERENCES ip_groups(id) ON DELETE CASCADE,
    cidr     TEXT NOT NULL,
    PRIMARY KEY (group_id, cidr)
);

-- A rule targets either one CIDR or a group (exactly one; enforced by the API).
ALTER TABLE ip_block_rules
    ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES ip_groups(id) ON DELETE CASCADE;
ALTER TABLE ip_block_rules
    ALTER COLUMN cidr DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ip_block_rules_group_unique
    ON ip_block_rules (
        scope,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        group_id
    )
    WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_block_rules_group_id
    ON ip_block_rules (group_id) WHERE group_id IS NOT NULL;

-- Blocked-IP hit accounting: the wg-helper IP-block rules carry counters; a
-- worker samples them, diffs the cumulative counters, attributes the source
-- peer/user and stores the delta here. Web Activity and Statistics read it.
CREATE TABLE IF NOT EXISTS ip_block_hits (
    id         BIGSERIAL PRIMARY KEY,
    server_id  UUID REFERENCES servers(id) ON DELETE CASCADE,
    peer_id    UUID REFERENCES peers(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    client_ip  INET,
    dest_cidr  TEXT NOT NULL,
    family     SMALLINT NOT NULL,
    packets    BIGINT NOT NULL,
    bytes      BIGINT NOT NULL,
    sampled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ip_block_hits_sampled_at
    ON ip_block_hits (sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_block_hits_dest
    ON ip_block_hits (dest_cidr, sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_block_hits_peer
    ON ip_block_hits (peer_id, sampled_at DESC) WHERE peer_id IS NOT NULL;
