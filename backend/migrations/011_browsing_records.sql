-- Web-activity records: per-peer DNS browsing history imported from AdGuard
-- Home's query log (the DNS layer is the only place a VPN console can observe
-- what domains each peer/user browses — page URLs and paths stay encrypted).
--
-- Every DNS query a peer makes through the tunnel is answered by AdGuard Home,
-- which logs it with the peer's tunnel IP, the queried hostname, and the
-- filtering outcome. A background worker (worker.BrowseWorker) imports those
-- entries here on a short tick, and the nightly rollup purges rows older than
-- the retention window (BROWSE_RETENTION_DAYS, default 30) so the table stays
-- bounded. Super admins can additionally purge from the Web Activity page.
CREATE TABLE IF NOT EXISTS browsing_records (
    id            BIGSERIAL PRIMARY KEY,
    peer_id       UUID NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
    client_ip     INET NOT NULL,
    host          TEXT NOT NULL,       -- full queried hostname, e.g. www.youtube.com
    base_domain   TEXT NOT NULL,       -- registrable domain, e.g. youtube.com
    blocked       BOOLEAN NOT NULL DEFAULT FALSE,
    reason        TEXT,                -- AdGuard filtering reason when blocked
    matched_rule  TEXT,                -- rule text that blocked the query, when known
    queried_at    TIMESTAMPTZ NOT NULL, -- when the DNS request was processed (AGH clock)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Import idempotency: the same (client, host, instant) can be returned by
-- overlapping querylog pages, so the worker inserts with ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_browsing_records_dedupe
    ON browsing_records (client_ip, host, queried_at);

-- Per-peer record listing (Web Activity page).
CREATE INDEX IF NOT EXISTS idx_browsing_records_peer_time
    ON browsing_records (peer_id, queried_at DESC);

-- Retention purge + broad time-window queries.
CREATE INDEX IF NOT EXISTS idx_browsing_records_time
    ON browsing_records (queried_at);

-- Top-domain statistics over a window (allowed + blocked) group by base_domain.
CREATE INDEX IF NOT EXISTS idx_browsing_records_domain_time
    ON browsing_records (base_domain, queried_at);

CREATE INDEX IF NOT EXISTS idx_browsing_records_blocked_time
    ON browsing_records (blocked, queried_at);

-- Import high-water mark: the newest queried_at already imported from
-- AdGuard's query log. Single fixed row (id = 1). Lets the browse worker
-- skip already-imported history on every 30s tick (no re-scan / re-insert
-- churn) and bound backfill after the worker or AdGuard was down.
CREATE TABLE IF NOT EXISTS browse_import_state (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_imported_at TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO browse_import_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
