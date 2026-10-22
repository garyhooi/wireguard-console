-- Peer-scoped blocking rules (v1.0.43): a user-scoped domain/IP block can
-- target only a subset of that user's peers. An empty peer_ids array keeps the
-- legacy behaviour (the rule applies to every active peer of the user);
-- global/department rules always keep it empty.
--
-- peer_ids is always written sorted + de-duplicated by the API so array
-- equality in the unique indexes is deterministic.
--
-- Idempotent: the migration runner executes every .sql file at each boot.

ALTER TABLE domain_block_rules
    ADD COLUMN IF NOT EXISTS peer_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE ip_block_rules
    ADD COLUMN IF NOT EXISTS peer_ids UUID[] NOT NULL DEFAULT '{}';

-- Replace the scope/target consistency checks (drop-all + re-add, the same
-- pattern migration 024 uses): peer_ids is only valid for user-scoped rules.
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'domain_block_rules'::regclass AND contype = 'c' LOOP
        EXECUTE format('ALTER TABLE domain_block_rules DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;
ALTER TABLE domain_block_rules ADD CONSTRAINT domain_block_rules_scope_check CHECK (
    (scope = 'global' AND user_id IS NULL AND department_id IS NULL AND cardinality(peer_ids) = 0)
    OR (scope = 'user' AND user_id IS NOT NULL AND department_id IS NULL)
    OR (scope = 'department' AND department_id IS NOT NULL AND user_id IS NULL AND cardinality(peer_ids) = 0)
);

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'ip_block_rules'::regclass AND contype = 'c' LOOP
        EXECUTE format('ALTER TABLE ip_block_rules DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;
ALTER TABLE ip_block_rules ADD CONSTRAINT ip_block_rules_scope_check CHECK (
    (scope = 'global' AND user_id IS NULL AND department_id IS NULL AND cardinality(peer_ids) = 0)
    OR (scope = 'user' AND user_id IS NOT NULL AND department_id IS NULL)
    OR (scope = 'department' AND department_id IS NOT NULL AND user_id IS NULL AND cardinality(peer_ids) = 0)
);

-- Uniqueness now includes the peer subset: the same domain/CIDR may be blocked
-- once per (scope, target, peer set), so one user can block a domain for one
-- peer while another rule covers a different subset.
DROP INDEX IF EXISTS idx_domain_block_rules_unique;
CREATE UNIQUE INDEX idx_domain_block_rules_unique
    ON domain_block_rules (
        scope,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(domain),
        peer_ids
    )
    WHERE domain IS NOT NULL;

DROP INDEX IF EXISTS idx_domain_block_rules_group_unique;
CREATE UNIQUE INDEX idx_domain_block_rules_group_unique
    ON domain_block_rules (
        scope,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
        group_id,
        peer_ids
    )
    WHERE group_id IS NOT NULL;

DROP INDEX IF EXISTS idx_ip_block_rules_unique;
CREATE UNIQUE INDEX idx_ip_block_rules_unique
    ON ip_block_rules (
        scope,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
        cidr,
        peer_ids
    )
    WHERE cidr IS NOT NULL;

DROP INDEX IF EXISTS idx_ip_block_rules_group_unique;
CREATE UNIQUE INDEX idx_ip_block_rules_group_unique
    ON ip_block_rules (
        scope,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
        group_id,
        peer_ids
    )
    WHERE group_id IS NOT NULL;
