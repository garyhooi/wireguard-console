-- Domain-rule hygiene (P0): normalize legacy rows, drop duplicates and
-- enforce one row per (scope, user, domain).
--
-- Idempotent: the migration runner executes every .sql file on each boot with
-- no tracking table, so every statement must tolerate re-runs.

-- 1) Drop duplicates that only differ by case/whitespace/trailing dot, keeping
--    the oldest row. Done before normalising so the UPDATE below cannot
--    violate the new unique index on an installation that already has the
--    index from a previous boot.
DELETE FROM domain_block_rules a
USING domain_block_rules b
WHERE a.id > b.id
  AND a.scope = b.scope
  AND COALESCE(a.user_id, '00000000-0000-0000-0000-000000000000'::uuid)
    = COALESCE(b.user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  AND rtrim(lower(btrim(a.domain)), '.') = rtrim(lower(btrim(b.domain)), '.');

-- 2) Normalize: lowercase, trim, strip trailing dots.
UPDATE domain_block_rules
SET domain = rtrim(lower(btrim(domain)), '.')
WHERE domain <> rtrim(lower(btrim(domain)), '.');

-- 3) One rule per scope/client/domain (domain comparison is case-insensitive
--    so future direct-DB writes cannot create confusing duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_block_rules_unique
    ON domain_block_rules (
        scope,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(domain)
    );
