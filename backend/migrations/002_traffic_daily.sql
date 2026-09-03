-- Add daily traffic aggregation table
CREATE TABLE IF NOT EXISTS peer_traffic_daily (
    peer_id     UUID NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
    date        DATE NOT NULL,
    rx_bytes    BIGINT NOT NULL DEFAULT 0,
    tx_bytes    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (peer_id, date)
);

CREATE INDEX IF NOT EXISTS idx_peer_traffic_daily_date ON peer_traffic_daily (date);
