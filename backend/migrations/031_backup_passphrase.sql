-- Backup encryption passphrase. The passphrase itself is stored encrypted
-- with APP_ENCRYPTION_KEY; the API only returns whether encryption is enabled.
-- History retains encrypted previous passphrases so backups created before a
-- passphrase change remain restorable. The runner re-executes migrations on
-- every boot, so every statement is idempotent.

ALTER TABLE config ADD COLUMN IF NOT EXISTS backup_passphrase_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN IF NOT EXISTS backup_passphrase_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS backup_passphrase_history_enc TEXT[] NOT NULL DEFAULT '{}';
