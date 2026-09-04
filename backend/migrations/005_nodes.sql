-- Distributed nodes: one console manages many machines. Each node runs
-- wg-helper in agent mode: it polls the console for desired state, applies
-- it to its local kernel, and reports back.
CREATE TABLE IF NOT EXISTS nodes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    location     TEXT NOT NULL DEFAULT '',
    token_hash   TEXT NOT NULL,          -- sha256 hex of the agent token
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    last_seen_at TIMESTAMPTZ,
    last_status  TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- servers.node_id NULL = managed by the console's own host (local);
-- set = the interface lives on this remote node (managed_mode 'remote').
ALTER TABLE servers ADD COLUMN IF NOT EXISTS node_id UUID REFERENCES nodes(id);