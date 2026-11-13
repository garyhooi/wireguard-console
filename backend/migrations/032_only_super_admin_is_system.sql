-- Only the break-glass super_admin role is a locked system role now. Admin
-- and Auditor are ordinary seeded roles: they can be edited, renamed and
-- deleted once no admin is assigned to them. The migration runner executes
-- every file on startup, so this stays idempotent and repairs databases seeded
-- by the earlier migration.

UPDATE admin_roles SET is_system = (slug = 'super_admin');
