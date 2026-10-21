-- Trusted-link expiry (Configuration → Security). These govern how long a
-- newly issued invite / claim link stays usable.
ALTER TABLE config ADD COLUMN IF NOT EXISTS vpn_invite_expiry_hours INT NOT NULL DEFAULT 72;
ALTER TABLE config ADD COLUMN IF NOT EXISTS peer_claim_expiry_hours INT NOT NULL DEFAULT 72;
ALTER TABLE config ADD COLUMN IF NOT EXISTS admin_invite_expiry_hours INT NOT NULL DEFAULT 72;

-- Expiry of an invited admin's temporary credentials (login is refused after
-- this; a password reset / re-invite refreshes it, a successful login clears it).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;
