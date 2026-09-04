package worker

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/wgclient"
)

// TrafficWorker samples per-peer kernel counters (rx/tx bytes and last
// handshake) from wg-helper for every locally-managed server, stores the
// deltas as samples, and refreshes last_handshake_at.
type TrafficWorker struct {
	pool       *pgxpool.Pool
	interval   time.Duration
	lastValues map[string]*TrafficValues
}

type TrafficValues struct {
	RXBytes uint64
	TXBytes uint64
}

func NewTrafficWorker(pool *pgxpool.Pool, interval time.Duration) *TrafficWorker {
	return &TrafficWorker{
		pool:       pool,
		interval:   interval,
		lastValues: make(map[string]*TrafficValues),
	}
}

func (w *TrafficWorker) Start(ctx context.Context) {
	log.Println("Traffic worker started (sampling kernel counters every 30s)")
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.pollTraffic(ctx); err != nil {
				log.Printf("Failed to poll traffic: %v", err)
			}
		}
	}
}

func (w *TrafficWorker) pollTraffic(ctx context.Context) error {
	rows, err := w.pool.Query(ctx, `
		SELECT id::text, interface_name FROM servers
		WHERE status = 'active' AND managed_mode = 'local'
	`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type serverRef struct {
		id    string
		iface string
	}
	var servers []serverRef
	for rows.Next() {
		var s serverRef
		if err := rows.Scan(&s.id, &s.iface); err != nil {
			return err
		}
		servers = append(servers, s)
	}

	for _, srv := range servers {
		stats, err := wgclient.Stats(srv.iface)
		if err != nil || stats == nil {
			continue // interface may not exist yet, or wg-helper offline
		}
		for _, st := range stats {
			key := srv.id + "|" + st.PublicKey
			prev, seen := w.lastValues[key]

			rx := uint64(st.ReceiveBytes)
			tx := uint64(st.TransmitBytes)
			if seen {
				deltaRX := rx - prev.RXBytes
				deltaTX := tx - prev.TXBytes
				if _, err := w.pool.Exec(ctx, `
					INSERT INTO peer_traffic_samples (peer_id, rx_bytes, tx_bytes)
					SELECT id, $2, $3 FROM peers
					WHERE server_id = $1 AND public_key = $4 AND status != 'removed'
				`, srv.id, int64(deltaRX), int64(deltaTX), st.PublicKey); err != nil {
					log.Printf("traffic sample insert: %v", err)
				}
			}
			w.lastValues[key] = &TrafficValues{RXBytes: rx, TXBytes: tx}

			// Live handshake timestamps for the UI.
			if st.LastHandshakeAt != "" {
				if t, err := time.Parse(time.RFC3339, st.LastHandshakeAt); err == nil {
					_, _ = w.pool.Exec(ctx, `
						UPDATE peers SET last_handshake_at = $1
						WHERE server_id = $2 AND public_key = $3
					`, t, srv.id, st.PublicKey)
				}
			}
		}
	}
	return nil
}
