-- Seed the two starting non-system roles once. The migration runner re-runs
-- every SQL file on boot, so a durable marker is required: ON CONFLICT alone
-- would silently recreate Admin/Auditor after an operator deleted them.

CREATE TABLE IF NOT EXISTS schema_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_meta WHERE key = 'admin_roles_seeded') THEN
        INSERT INTO admin_roles (slug, name, description, permissions, is_system)
        VALUES
            ('admin', 'Admin', 'Day-to-day operations, without access-control or security-policy changes.', ARRAY[
                'monitoring.view', 'activity.view', 'audit.view',
                'network.view', 'network.manage', 'network.secrets',
                'directory.view', 'directory.manage',
                'rules.view', 'rules.manage',
                'system.view', 'system.manage',
                'backups.view', 'backups.manage'
            ]::TEXT[], FALSE),
            ('auditor', 'Auditor', 'Read-only visibility across the console.', ARRAY[
                'monitoring.view', 'activity.view', 'audit.view',
                'network.view', 'directory.view', 'rules.view',
                'system.view', 'backups.view'
            ]::TEXT[], FALSE)
        ON CONFLICT (slug) DO NOTHING;

        INSERT INTO schema_meta (key, value)
        VALUES ('admin_roles_seeded', '1')
        ON CONFLICT (key) DO NOTHING;
    END IF;
END $$;
