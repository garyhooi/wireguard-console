-- Department-scoped blocking rules: a rule can target every active peer of
-- the users in one department (domain + IP blocking). Deleting a department
-- cascades its rules, mirroring user-scoped rules.
ALTER TABLE domain_block_rules
    ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE CASCADE;
ALTER TABLE ip_block_rules
    ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE CASCADE;

-- Replace the scope/target consistency checks so 'department' is allowed.
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'domain_block_rules'::regclass AND contype = 'c' LOOP
        EXECUTE format('ALTER TABLE domain_block_rules DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;
ALTER TABLE domain_block_rules ADD CONSTRAINT domain_block_rules_scope_check CHECK (
    (scope = 'global' AND user_id IS NULL AND department_id IS NULL)
    OR (scope = 'user' AND user_id IS NOT NULL AND department_id IS NULL)
    OR (scope = 'department' AND department_id IS NOT NULL AND user_id IS NULL)
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
    (scope = 'global' AND user_id IS NULL AND department_id IS NULL)
    OR (scope = 'user' AND user_id IS NOT NULL AND department_id IS NULL)
    OR (scope = 'department' AND department_id IS NOT NULL AND user_id IS NULL)
);

-- Uniqueness must include the department: two departments may block the same
-- domain/CIDR independently. Once the peer-scope migration (026) has added
-- peer_ids, the peer subset (always written sorted) is part of the key too,
-- so one user can hold the same target for different peer selections. This
-- file re-runs before 026 on every boot, hence the column check: without the
-- widened key here, boot would fail rebuilding the index over peer-subset
-- duplicates.
DO $$
DECLARE
    peer_col text := '';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = 'domain_block_rules'::regclass
                 AND attname = 'peer_ids' AND NOT attisdropped) THEN
        peer_col := ', peer_ids';
    END IF;

    DROP INDEX IF EXISTS idx_domain_block_rules_unique;
    EXECUTE $idx$
        CREATE UNIQUE INDEX idx_domain_block_rules_unique
            ON domain_block_rules (
                scope,
                COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
                COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                lower(domain)$idx$ || peer_col || $idx$
            )
            WHERE domain IS NOT NULL$idx$;

    DROP INDEX IF EXISTS idx_domain_block_rules_group_unique;
    EXECUTE $idx$
        CREATE UNIQUE INDEX idx_domain_block_rules_group_unique
            ON domain_block_rules (
                scope,
                COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
                COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                group_id$idx$ || peer_col || $idx$
            )
            WHERE group_id IS NOT NULL$idx$;
END $$;

DO $$
DECLARE
    peer_col text := '';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = 'ip_block_rules'::regclass
                 AND attname = 'peer_ids' AND NOT attisdropped) THEN
        peer_col := ', peer_ids';
    END IF;

    DROP INDEX IF EXISTS idx_ip_block_rules_unique;
    EXECUTE $idx$
        CREATE UNIQUE INDEX idx_ip_block_rules_unique
            ON ip_block_rules (
                scope,
                COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
                COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                cidr$idx$ || peer_col || $idx$
            )
            WHERE cidr IS NOT NULL$idx$;

    DROP INDEX IF EXISTS idx_ip_block_rules_group_unique;
    EXECUTE $idx$
        CREATE UNIQUE INDEX idx_ip_block_rules_group_unique
            ON ip_block_rules (
                scope,
                COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
                COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                group_id$idx$ || peer_col || $idx$
            )
            WHERE group_id IS NOT NULL$idx$;
END $$;

CREATE INDEX IF NOT EXISTS idx_domain_block_rules_department_id
    ON domain_block_rules (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_block_rules_department_id
    ON ip_block_rules (department_id) WHERE department_id IS NOT NULL;
