-- Emails must be reusable after an account is removed/disabled:
--   users:  one active-or-invited user per email; removed rows may repeat
--   admins: one active-or-disabled row per email (only one disabled keeper)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_active
    ON users (email) WHERE status <> 'removed';

ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS admins_email_unique_active
    ON admins (email) WHERE status <> 'disabled';