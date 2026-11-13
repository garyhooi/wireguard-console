-- Optional S3-compatible backup destination and automatic backup schedule.
-- Credentials are stored encrypted with APP_ENCRYPTION_KEY, like SMTP and
-- backup passphrases. The migration runner re-executes every file on startup.

ALTER TABLE config ADD COLUMN IF NOT EXISTS s3_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS s3_endpoint TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN IF NOT EXISTS s3_region TEXT NOT NULL DEFAULT 'us-east-1';
ALTER TABLE config ADD COLUMN IF NOT EXISTS s3_bucket TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN IF NOT EXISTS s3_prefix TEXT NOT NULL DEFAULT 'wireguard-console/backups';
ALTER TABLE config ADD COLUMN IF NOT EXISTS s3_access_key_id TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN IF NOT EXISTS s3_secret_key_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN IF NOT EXISTS s3_session_token_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN IF NOT EXISTS s3_force_path_style BOOLEAN NOT NULL DEFAULT FALSE;

-- 0 = automatic backups disabled; otherwise the interval in hours.
ALTER TABLE config ADD COLUMN IF NOT EXISTS backup_interval_hours INT NOT NULL DEFAULT 0;
-- 0 = keep every backup; otherwise the maximum number of local/remote archives.
ALTER TABLE config ADD COLUMN IF NOT EXISTS backup_retention_count INT NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN IF NOT EXISTS backup_last_auto_at TIMESTAMPTZ;
