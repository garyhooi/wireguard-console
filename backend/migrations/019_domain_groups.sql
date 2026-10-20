-- Domain Groups: a named, reusable set of domains that a blocking rule can
-- reference. Adding a "YouTube" group with all related domains then blocking
-- the group applies every domain at once, and editing the group updates all
-- rules that reference it.
--
-- Idempotent: the migration runner executes every .sql file at each boot.
CREATE TABLE IF NOT EXISTS domain_groups (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_by UUID REFERENCES admins(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_groups_name_unique
    ON domain_groups (lower(name));

CREATE TABLE IF NOT EXISTS domain_group_domains (
    group_id UUID NOT NULL REFERENCES domain_groups(id) ON DELETE CASCADE,
    domain   TEXT NOT NULL,
    PRIMARY KEY (group_id, domain)
);

-- A rule now targets either a single domain or a group (exactly one; enforced
-- by the API). Group rules cascade with the group so deleting a group can
-- never leave orphaned rules behind.
ALTER TABLE domain_block_rules
    ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES domain_groups(id) ON DELETE CASCADE;
ALTER TABLE domain_block_rules
    ALTER COLUMN domain DROP NOT NULL;

-- One rule per (scope, client, group); the existing domain index from
-- migration 018 keeps enforcing one rule per (scope, client, domain).
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_block_rules_group_unique
    ON domain_block_rules (
        scope,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        group_id
    )
    WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_domain_block_rules_group_id
    ON domain_block_rules (group_id)
    WHERE group_id IS NOT NULL;
