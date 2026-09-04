-- Peer config access links: a short-lived, revocable-by-expiry bearer token
-- that lets a VPN user (or anyone the admin shares the link with) download
-- their peer's .conf / scan the QR WITHOUT the console emailing the private
-- key around. Only the sha256 hash of the raw token is stored, matching the
-- invites table pattern.
CREATE TABLE IF NOT EXISTS peer_access_tokens (
    token_hash TEXT PRIMARY KEY,
    peer_id    UUID NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_peer_access_tokens_peer_id ON peer_access_tokens (peer_id);

-- Drop expired tokens opportunistically.
DELETE FROM peer_access_tokens WHERE expires_at <= now();
