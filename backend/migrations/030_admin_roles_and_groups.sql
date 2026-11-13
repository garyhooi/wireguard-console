-- Dynamic admin roles (permission policies) and organizational admin groups.
-- The migration runner re-executes every file on startup, so everything here
-- is idempotent and the system-role seed uses ON CONFLICT DO NOTHING. Existing
-- edits to the admin/auditor roles are therefore preserved across upgrades.

CREATE TABLE IF NOT EXISTS admin_roles (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    permissions TEXT[] NOT NULL DEFAULT '{}',
    is_system   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_roles_name_lower_key
    ON admin_roles (lower(name));

INSERT INTO admin_roles (slug, name, description, permissions, is_system)
VALUES
    ('super_admin', 'Super admin', 'Full access to every console capability.', ARRAY['*']::TEXT[], TRUE),
    ('admin', 'Admin', 'Day-to-day operations, without access-control or security-policy changes.', ARRAY[
        'monitoring.view', 'activity.view', 'audit.view',
        'network.view', 'network.manage', 'network.secrets',
        'directory.view', 'directory.manage',
        'rules.view', 'rules.manage',
        'system.view', 'system.manage',
        'backups.view', 'backups.manage'
    ]::TEXT[], TRUE),
    ('auditor', 'Auditor', 'Read-only visibility across the console.', ARRAY[
        'monitoring.view', 'activity.view', 'audit.view',
        'network.view', 'directory.view', 'rules.view',
        'system.view', 'backups.view'
    ]::TEXT[], TRUE)
ON CONFLICT (slug) DO NOTHING;

-- The old column check limited admins.role to three literals. Replace it with
-- a foreign key to the role table; the stored value remains the role slug, so
-- existing rows and the public API stay compatible.
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'admins_role_fkey'
          AND conrelid = 'admins'::regclass
    ) THEN
        ALTER TABLE admins
            ADD CONSTRAINT admins_role_fkey
            FOREIGN KEY (role) REFERENCES admin_roles(slug)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS admin_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_groups_name_lower_key
    ON admin_groups (lower(name));

CREATE TABLE IF NOT EXISTS admin_group_members (
    group_id UUID NOT NULL REFERENCES admin_groups(id) ON DELETE CASCADE,
    admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, admin_id)
);

CREATE INDEX IF NOT EXISTS admin_group_members_admin_id_idx
    ON admin_group_members (admin_id);
