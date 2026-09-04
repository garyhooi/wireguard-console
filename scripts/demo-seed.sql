-- Demo seed data for WireGuard Console screenshots.
-- Generates a believable small deployment: a handful of VPN users, admins,
-- servers, peers, layered traffic samples over the last 24h (for the
-- dashboard KPIs, the traffic area/bar charts and the usage report), a
-- couple of domain-blocking rules and a realistic audit log.
--
-- Safe to re-run: it is idempotent (deletes demo rows first, then re-inserts
-- them). It NEVER touches the bootstrap super_admin (admin@company.com).
--
-- Usage:
--   PGPASSWORD=... psql -h localhost -U wgconsole -d wgconsole \
--     -f scripts/demo-seed.sql
--
-- NOTE: peer/server private keys are placeholder strings. They are used only
-- for rendering the UI (public keys are shown truncated); the demo keypairs
-- are NOT cryptographically valid and must not be used for real tunnels.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Identities (fixed UUIDs so traffic/AuditLog FKs are stable across runs)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Idempotent: clear this demo's rows first, in FK-safe dependency order
-- (children before parents). Extra tables here are cleared so re-runs don't
-- trip foreign keys; the bootstrap super_admin (admin@company.com) is kept.
DELETE FROM peer_traffic_daily;
DELETE FROM peer_traffic_samples;
DELETE FROM peers;
DELETE FROM servers;
DELETE FROM domain_block_rules;
DELETE FROM audit_logs;
DELETE FROM users;
DELETE FROM admins WHERE email IN ('ops@example.com', 'audit@example.com');

INSERT INTO admins (id, email, password_hash, role, status, totp_enabled, created_at, updated_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'ops@example.com',
   '$2a$10$7EqJtq98hPqEX7fNZaFWoOoZ0y5R6F9bF1sV1q0yq0yq0yq0yq0yq', 'admin',
   'active', true, now() - interval '90 days', now() - interval '90 days'),
  ('22222222-2222-4222-8222-222222222222', 'audit@example.com',
   '$2a$10$7EqJtq98hPqEX7fNZaFWoOoZ0y5R6F9bF1sV1q0yq0yq0yq0yq0yq', 'auditor',
   'active', false, now() - interval '60 days', now() - interval '60 days');

INSERT INTO users (id, email, full_name, status, invited_by, invited_at, activated_at, created_at) VALUES
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'sarah@acme.io',   'Sarah Chen',    'active',    'fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', now() - interval '80 days', now() - interval '80 days', now() - interval '80 days'),
  ('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 'mike@acme.io',     'Mike Osei',     'active',    'fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', now() - interval '65 days', now() - interval '65 days', now() - interval '65 days'),
  ('aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'priya@acme.io',    'Priya Nair',    'active',    'fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', now() - interval '50 days', now() - interval '50 days', now() - interval '50 days'),
  ('aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa', 'david@acme.io',    'David Kim',     'suspended', 'fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', now() - interval '40 days', now() - interval '39 days', now() - interval '40 days'),
  ('aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa', 'lena@acme.io',     'Lena Hoffman',  'invited',   '11111111-1111-4111-8111-111111111111', now() - interval '2 days',  NULL,                      now() - interval '2 days'),
  ('aaaaaaaa-6666-4666-8666-aaaaaaaaaaaa', 'tom@acme.io',      'Tom Alvarez',   'removed',   'fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', now() - interval '30 days', now() - interval '28 days', now() - interval '30 days');

-- ---------------------------------------------------------------------------
-- 2. Servers
-- ---------------------------------------------------------------------------
INSERT INTO servers
  (id, name, public_endpoint, listen_port, interface_name, server_public_key,
   server_private_key_encrypted, network_cidr, dns_servers, default_allowed_ips,
   mtu, persistent_keepalive, status, managed_mode, node_id, created_at) VALUES
  ('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'Production VPN',
   '203.0.113.5:51820', 51820, 'wg0',
   'u4Gx7vQ9sL2mN8pR5tY0kC1hE6fA3dW9zX2bV4nM6q=',
   'enc:placeholder-production-key', '10.8.0.0/24',
   ARRAY['10.8.0.1'], '0.0.0.0/0, ::/0', 1420, 25, 'active', 'local', NULL,
   now() - interval '120 days'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'Engineering Lab',
   '198.51.100.8:51821', 51821, 'wg1',
   'v7nR2kP9mX4cJ8sQ1tY5wE6hA3dF0gU2zB8vN5jK1o=',
   'enc:placeholder-lab-key', '10.9.0.0/24',
   ARRAY['10.9.0.1'], '0.0.0.0/0, ::/0', 1420, 25, 'active', 'local', NULL,
   now() - interval '75 days');

-- ---------------------------------------------------------------------------
-- 3. Peers (each with a realistic name, IP, status, and recent handshake)
-- ---------------------------------------------------------------------------
INSERT INTO peers
  (id, user_id, server_id, name, public_key, private_key_encrypted,
   preshared_key_encrypted, allowed_ip, status, last_handshake_at, created_at, suspended_at, removed_at) VALUES
  ('cccccccc-1111-4111-8111-cccccccccccc', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'Sarah MacBook', '9xK2mP8rT5vN7qW3cJ1hL6eA4dF0gU2zB8yC5nR1o=', 'enc:sarah', 'psk:aaaa', '10.8.0.2', 'active',    now() - interval '40 seconds', now() - interval '80 days', NULL, NULL),
  ('cccccccc-2222-4222-8222-cccccccccccc', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'Sarah iPhone',  '5hT8wQ2mX9nP4cV1jR6kL3eA7dF0gU2zB8yC5nR1o=', 'enc:sarah', 'psk:bbbb', '10.8.0.3', 'active',    now() - interval '2 minutes',  now() - interval '75 days', NULL, NULL),
  ('cccccccc-3333-4333-8333-cccccccccccc', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'Mike Desktop',  '2pL6kD9sR4vY7nQ1wX3cM8eA5dF0gU2zB8yC5nR1o=', 'enc:mike',  'psk:cccc', '10.8.0.4', 'active',    now() - interval '45 seconds', now() - interval '65 days', NULL, NULL),
  ('cccccccc-4444-4444-8444-cccccccccccc', 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'Priya Laptop',  '8cB3nJ7vQ0tX5mR9kP2wH6eA4dF0gU2zB8yC5nR1o=', 'enc:priya', 'psk:dddd', '10.8.0.5', 'active',    now() - interval '12 minutes', now() - interval '50 days', NULL, NULL),
  ('cccccccc-5555-4555-8555-cccccccccccc', 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'Priya Phone',   '6mN4rX1tQ8vK3cJ7wP5eA2hD9fF0gU2zB8yC5nR1o=', 'enc:priya', 'psk:eeee', '10.9.0.2', 'suspended', now() - interval '2 days',    now() - interval '45 days', now() - interval '3 days', NULL),
  ('cccccccc-6666-4666-8666-cccccccccccc', 'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'David Workstation', '3qZ7kF4sX0nM2rT9wV5cL8eA1dD6gU2zB8yC5nR1o=', 'enc:david', 'psk:ffff', '10.9.0.3', 'suspended', now() - interval '5 days',    now() - interval '40 days', now() - interval '6 days', NULL),
  ('cccccccc-7777-4777-8777-cccccccccccc', 'aaaaaaaa-6666-4666-8666-aaaaaaaaaaaa', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'Tom Old Laptop', '1wT5yB8uD3fG7hJ0kL2nP4rV6xC8zQ1mE3aF5dG7h=', 'enc:tom',  'psk:gggg', '10.8.0.6', 'removed',    null,                    now() - interval '30 days', NULL, now() - interval '28 days');

-- ---------------------------------------------------------------------------
-- 4. Traffic samples over the last 24h (one per hour per active peer) — this
--    drives the dashboard "connected" KPI, the traffic area chart, the top
--    peers bar chart and the usage report. Values are deterministic-ish so
--    the charts look natural (ramp up through the workday, taper at night).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  hr int;
  peer RECORD;
  rx bigint;
  tx bigint;
  base_rx bigint;
  base_tx bigint;
  factor numeric;
BEGIN
  -- Per-peer base volumes so "top peers" has a spread.
  CREATE TEMP TABLE _peer_base (peer_id uuid, brx bigint, btx bigint) ON COMMIT DROP;
  INSERT INTO _peer_base (peer_id, brx, btx) VALUES
    ('cccccccc-1111-4111-8111-cccccccccccc', 2600000000, 480000000),
    ('cccccccc-2222-4222-8222-cccccccccccc', 1500000000, 320000000),
    ('cccccccc-3333-4333-8333-cccccccccccc', 3400000000, 610000000),
    ('cccccccc-4444-4444-8444-cccccccccccc', 900000000,  180000000),
    ('cccccccc-5555-4555-8555-cccccccccccc', 120000000,  40000000),
    ('cccccccc-6666-4666-8666-cccccccccccc', 0,           0);

  -- Hourly samples for the past 24 hours (skip the suspended/removed peers
  -- once they stopped, and only sample the two "active" ones down through
  -- the last hour so the area chart has real volume).
  FOR hr IN REVERSE 23..0 LOOP
    factor := CASE
      WHEN hr BETWEEN 9 AND 19 THEN 1.0        -- busy workday hours
      WHEN hr BETWEEN 20 AND 22 THEN 0.55      -- evening
      ELSE 0.28                               -- night
    END;
    FOR peer IN
      SELECT p.id FROM peers p
      JOIN _peer_base b ON b.peer_id = p.id
      WHERE p.id IN ('cccccccc-1111-4111-8111-cccccccccccc','cccccccc-2222-4222-8222-cccccccccccc','cccccccc-3333-4333-8333-cccccccccccc','cccccccc-4444-4444-8444-cccccccccccc')
    LOOP
      SELECT brx, btx INTO base_rx, base_tx FROM _peer_base WHERE peer_id = peer.id;
      rx := floor(base_rx * factor / 24.0 * (1 + random()*0.5));
      tx := floor(base_tx * factor / 24.0 * (1 + random()*0.4));
      INSERT INTO peer_traffic_samples (peer_id, rx_bytes, tx_bytes, sampled_at)
      VALUES (peer.id, rx, tx, now() - (hr || ' hours')::interval);
    END LOOP;
  END LOOP;

  -- The suspended peers still had some traffic earlier in the day, before
  -- they were suspended (so they appear in the day's top peers but low).
  INSERT INTO peer_traffic_samples (peer_id, rx_bytes, tx_bytes, sampled_at)
  SELECT 'cccccccc-5555-4555-8555-cccccccccccc', floor(random()*40000000+10000000), floor(random()*15000000+4000000), now() - ((gs || ' hours')::interval)
  FROM generate_series(10, 22) AS gs;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Daily rollup for the usage report date range (older days)
-- ---------------------------------------------------------------------------
INSERT INTO peer_traffic_daily (peer_id, date, rx_bytes, tx_bytes)
SELECT p.id, d::date, floor(3000000000 + random()*2000000000), floor(500000000 + random()*400000000)
FROM peers p CROSS JOIN generate_series(CURRENT_DATE - 6, CURRENT_DATE - 1, '1 day'::interval) d
WHERE p.status <> 'removed';

-- ---------------------------------------------------------------------------
-- 6. Domain-blocking rules
-- ---------------------------------------------------------------------------
INSERT INTO domain_block_rules (id, scope, user_id, domain, created_by, created_at) VALUES
  ('dddddddd-1111-4111-8111-dddddddddddd', 'global', NULL, 'douyin.com',  'fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', now() - interval '20 days'),
  ('dddddddd-2222-4222-8222-dddddddddddd', 'global', NULL, 'tiktok.com',  'fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', now() - interval '18 days'),
  ('dddddddd-3333-4333-8333-dddddddddddd', 'user',   'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 'reddit.com', '11111111-1111-4111-8111-111111111111', now() - interval '3 days');

-- ---------------------------------------------------------------------------
-- 7. Audit log (newest-first; the UI shows the latest 100)
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id, metadata, ip_address, created_at) VALUES
  ('fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', 'peer.config.download', 'peer', 'cccccccc-1111-4111-8111-cccccccccccc', '{"name":"Sarah MacBook"}',   '203.0.113.5', now() - interval '20 minutes'),
  ('11111111-1111-4111-8111-111111111111', 'peer.suspend',          'peer', 'cccccccc-5555-4555-8555-cccccccccccc', '{"name":"Priya Phone"}',     '198.51.100.8', now() - interval '3 hours'),
  ('fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', 'user.invite',           'user', 'aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa', '{"email":"lena@acme.io"}',   '203.0.113.5', now() - interval '2 days'),
  ('11111111-1111-4111-8111-111111111111', 'domain_rule.create',    'domain_block_rule', 'dddddddd-3333-4333-8333-dddddddddddd', '{"domain":"reddit.com","scope":"user"}', '198.51.100.8', now() - interval '3 days'),
  ('fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', 'server.create',         'server', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', '{"name":"Production VPN"}',  '203.0.113.5', now() - interval '120 days'),
  ('fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', 'server.create',         'server', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', '{"name":"Engineering Lab"}', '203.0.113.5', now() - interval '75 days'),
  ('fd61c29c-9fa3-4700-9f7c-6dc8d1cbe066', 'admin.login',           NULL, NULL, NULL, '203.0.113.5', now() - interval '40 minutes');

COMMIT;
