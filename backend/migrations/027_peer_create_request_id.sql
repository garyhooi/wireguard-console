-- Idempotent peer creation: a peer create is committed before the
-- (slow, asynchronous) kernel apply, so a browser or proxy that times out
-- after the commit retries POST /api/peers and would otherwise create a
-- duplicate peer. The client may send an optional request_id with the create;
-- the API replays the original public_key/allowed_ip instead of inserting
-- again.
--
-- The partial unique index is the concurrency backstop: two overlapping
-- requests carrying the same request_id collide on insert, and the loser
-- re-reads the winner's row (Postgres blocks the duplicate index entry until
-- the winning transaction commits or aborts). NULL is excluded, so peers
-- created without a request_id keep the legacy behaviour.
--
-- Idempotent: the migration runner executes every .sql file at each boot.

ALTER TABLE peers ADD COLUMN IF NOT EXISTS create_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS peers_create_request_id_key
    ON peers (create_request_id)
    WHERE create_request_id IS NOT NULL;
