-- Domain-rule hygiene (P0): normalize legacy rows, drop duplicates and
-- enforce one row per (scope, user, domain).
--
-- Idempotent: the migration runner executes every .sql file on each boot with
-- no tracking table, so every statement must tolerate re-runs.
--
-- Later migrations widened the rule key (department_id in 024, peer_ids in
-- 026). This file re-runs before them on every boot, so the duplicate check
-- and the index below include those columns as soon as they exist. Without
-- that, a database legitimately holding two rules with the same domain but
-- different peer subsets (or different departments) would silently lose one
-- on the next restart.

-- 1) Drop duplicates that only differ by case/whitespace/trailing dot, keeping
--    the oldest row. Done before normalising so the UPDATE below cannot
--    violate the new unique index on an installation that already has the
--    index from a previous boot.
DO $$
DECLARE
    stmt text := $dedupe$
        DELETE FROM domain_block_rules a
        USING domain_block_rules b
        WHERE a.id > b.id
          AND a.scope = b.scope
          AND COALESCE(a.user_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE(b.user_id, '00000000-0000-0000-0000-000000000000'::uuid)
          AND rtrim(lower(btrim(a.domain)), '.') = rtrim(lower(btrim(b.domain)), '.')
    $dedupe$;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = 'domain_block_rules'::regclass
                 AND attname = 'department_id' AND NOT attisdropped) THEN
        stmt := stmt || $cond$
          AND COALESCE(a.department_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE(b.department_id, '00000000-0000-0000-0000-000000000000'::uuid)
        $cond$;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = 'domain_block_rules'::regclass
                 AND attname = 'peer_ids' AND NOT attisdropped) THEN
        stmt := stmt || ' AND a.peer_ids = b.peer_ids';
    END IF;
    EXECUTE stmt;
END $$;

-- 2) Normalize: lowercase, trim, strip trailing dots.
UPDATE domain_block_rules
SET domain = rtrim(lower(btrim(domain)), '.')
WHERE domain <> rtrim(lower(btrim(domain)), '.');

-- 3) One rule per scope/client/domain (domain comparison is case-insensitive
--    so future direct-DB writes cannot create confusing duplicates). The key
--    grows with the later migrations: include their columns when present.
DO $$
DECLARE
    cols text := $cols$scope,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(domain)$cols$;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = 'domain_block_rules'::regclass
                 AND attname = 'department_id' AND NOT attisdropped) THEN
        cols := cols || $cols$,
        COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid)$cols$;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = 'domain_block_rules'::regclass
                 AND attname = 'peer_ids' AND NOT attisdropped) THEN
        cols := cols || ', peer_ids';
    END IF;
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_block_rules_unique
        ON domain_block_rules (' || cols || ')';
END $$;
