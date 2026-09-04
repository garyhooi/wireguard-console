-- Servers can be managed two ways:
--   'local'  (default): the console's wg-helper applies this interface on
--            the host running the stack, automatically, on every change.
--   'manual': the interface lives elsewhere (a different node); the
--            console skips kernel sync and relies on the Host Setup panel
--            to hand out the config for that node.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS managed_mode TEXT NOT NULL DEFAULT 'local';