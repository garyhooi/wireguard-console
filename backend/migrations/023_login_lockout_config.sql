-- Security policy: login lockout (Configuration → Security).
-- Defaults: 3 wrong passwords, 60s lock for the source IP and for the account.
ALTER TABLE config ADD COLUMN IF NOT EXISTS login_max_attempts INT NOT NULL DEFAULT 3;
ALTER TABLE config ADD COLUMN IF NOT EXISTS login_ip_lockout_seconds INT NOT NULL DEFAULT 60;
ALTER TABLE config ADD COLUMN IF NOT EXISTS login_account_lockout_seconds INT NOT NULL DEFAULT 60;
