-- Time-window aggregates on peer_traffic_samples filter on sampled_at alone
-- (24h charts, per-peer/user usage ranges). The existing composite index is
-- (peer_id, sampled_at), so those time-only queries could not use it and fell
-- back to scanning the whole retained window (~30 days of 30s samples). Add a
-- plain sampled_at index so the aggregates stay cheap on long-running installs.
--
-- Idempotent: the migration runner executes every .sql file on each boot with
-- no tracking table, so every statement must tolerate re-runs.
CREATE INDEX IF NOT EXISTS idx_peer_traffic_samples_sampled_at
    ON peer_traffic_samples (sampled_at);
