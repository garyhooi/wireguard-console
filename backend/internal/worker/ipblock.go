package worker

import (
	"context"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/wgclient"
)

// IPBlockHitWorker samples the cumulative nftables counters of the IP-block
// drop rules, diffs them, attributes each delta to the source peer/user and
// stores it in ip_block_hits. Blocked packets never hit DNS, so this is the
// only way to surface them in Statistics / Web Activity.
//
// Counter semantics match TrafficWorker: WireGuard/nftables counters are
// cumulative but reset when the tables are re-rendered (rule edit, kill switch,
// reboot). A counter that went backwards is a reset, not negative traffic:
// re-baseline it and store nothing for that tick.
type IPBlockHitWorker struct {
	pool     *pgxpool.Pool
	interval time.Duration
	last     map[string]ipBlockHitCounter
}

type ipBlockHitCounter struct {
	packets uint64
	bytes   uint64
}

func NewIPBlockHitWorker(pool *pgxpool.Pool, interval time.Duration) *IPBlockHitWorker {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &IPBlockHitWorker{pool: pool, interval: interval, last: map[string]ipBlockHitCounter{}}
}

func (w *IPBlockHitWorker) Start(ctx context.Context) {
	log.Println("IP-block hit worker started (sampling nftables counters every 30s)")
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.poll(ctx); err != nil {
				log.Printf("IP-block hit poll: %v", err)
			}
		}
	}
}

func (w *IPBlockHitWorker) poll(ctx context.Context) error {
	rows, err := w.pool.Query(ctx, `
		SELECT id::text, interface_name FROM servers
		WHERE status = 'active' AND managed_mode = 'local'
	`)
	if err != nil {
		return err
	}
	type serverRef struct {
		id    string
		iface string
	}
	var servers []serverRef
	for rows.Next() {
		var s serverRef
		if err := rows.Scan(&s.id, &s.iface); err != nil {
			rows.Close()
			return err
		}
		servers = append(servers, s)
	}
	rows.Close()

	seen := map[string]bool{}
	for _, srv := range servers {
		counters, err := wgclient.IPBlockStats(srv.iface)
		if err != nil {
			continue // wg-helper offline or interface not applied yet
		}
		serverID, err := uuid.Parse(srv.id)
		if err != nil {
			continue
		}
		for _, counter := range counters {
			key := srv.id + "|" + counter.Family + "|" + counter.SourceIP + "|" + counter.CIDR
			seen[key] = true
			prev, known := w.last[key]
			w.last[key] = ipBlockHitCounter{packets: counter.Packets, bytes: counter.Bytes}
			if !known || counter.Packets < prev.packets {
				continue // first sight = baseline; backwards = counter reset
			}
			deltaPackets := counter.Packets - prev.packets
			var deltaBytes uint64
			if counter.Bytes >= prev.bytes {
				deltaBytes = counter.Bytes - prev.bytes
			}
			if deltaPackets == 0 && deltaBytes == 0 {
				continue
			}

			var peerID, userID *uuid.UUID
			var clientIP *string
			if counter.SourceIP != "" {
				var pID, uID uuid.UUID
				if err := w.pool.QueryRow(ctx, `
					SELECT id, user_id FROM peers
					WHERE server_id = $1 AND status = 'active' AND host(allowed_ip) = $2
					LIMIT 1
				`, serverID, counter.SourceIP).Scan(&pID, &uID); err == nil {
					peerID, userID = &pID, &uID
				}
				src := counter.SourceIP
				clientIP = &src
			}

			family := 4
			if counter.Family == "ipv6" {
				family = 6
			}
			if _, err := w.pool.Exec(ctx, `
				INSERT INTO ip_block_hits
					(server_id, peer_id, user_id, client_ip, dest_cidr, family, packets, bytes)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			`, serverID, peerID, userID, clientIP, counter.CIDR, family,
				int64(deltaPackets), int64(deltaBytes)); err != nil {
				log.Printf("IP-block hit insert: %v", err)
			}
		}
	}

	// Drop tracked counters whose rule disappeared (rule edit/delete) so the map
	// cannot grow without bound.
	for key := range w.last {
		if !seen[key] {
			delete(w.last, key)
		}
	}
	return nil
}

