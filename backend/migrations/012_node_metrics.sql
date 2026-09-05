-- Server monitoring: each node's wg-helper agent attaches a host resource
-- snapshot (cpu/memory/disk/load/uptime) to its periodic report. The console
-- stores the latest snapshot as JSONB so the monitoring page can show live
-- gauges for every machine in one place without a time-series table.
--
-- agents report every ~15s; a JSONB upsert per row is negligible. History
-- (rolling samples + charts) is a later phase and will get its own table.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS metrics     JSONB NOT NULL DEFAULT '{}';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS metrics_at  TIMESTAMPTZ;
