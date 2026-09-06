-- Clamp negative traffic samples (and the daily rollup they fed into).
--
-- Context: the traffic sampler once subtracted unsigned WireGuard kernel
-- counters without a reset guard. Whenever an interface or peer was
-- re-applied (host reboot, wg-helper restart, reconcile rebuild) the kernel
-- restarted its counters near 0, the uint64 subtraction wrapped to ~2^64,
-- and the wrapped value was stored as a huge negative BIGINT sample. Those
-- negatives made the hourly "Traffic over time" chart dip below 0 B.
--
-- This migration repairs rows already written by the buggy worker; the
-- sampler itself now refuses to write negatives (see counterDeltas in
-- internal/worker/traffic.go), so nothing new can appear.
--
-- Idempotent (UPDATE ... WHERE ... >= 0 is a no-op once clean; the runner
-- executes every .sql file at each boot with no tracking table, so each
-- statement must tolerate re-runs).
UPDATE peer_traffic_samples SET rx_bytes = 0 WHERE rx_bytes < 0;
UPDATE peer_traffic_samples SET tx_bytes = 0 WHERE tx_bytes < 0;

-- The nightly rollup (internal/worker/rollup.go) summed whatever samples
-- were present, so an already-rolled-up day may carry a negative total that
-- no longer exists in raw samples to correct it.
UPDATE peer_traffic_daily SET rx_bytes = 0 WHERE rx_bytes < 0;
UPDATE peer_traffic_daily SET tx_bytes = 0 WHERE tx_bytes < 0;
