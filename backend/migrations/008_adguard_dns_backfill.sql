-- Domain blocking depends on peers querying AdGuard Home. Servers created
-- before the DNS default change used public resolvers (1.1.1.1 / 8.8.8.8),
-- which bypasses the filter. Point them at their tunnel gateway instead.
UPDATE servers
SET dns_servers = ARRAY[host(network(network_cidr)::inet + 1)::text]
WHERE dns_servers = ARRAY['1.1.1.1','8.8.8.8'];
