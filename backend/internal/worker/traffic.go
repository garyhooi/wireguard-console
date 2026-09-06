package worker

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/wgclient"
)

// counterDeltas returns the rx/tx bytes transferred since the previous
// kernel-counter reading.
//
// WireGuard kernel counters are cumulative and monotonic while a peer lives,
// but restart at 0 whenever the peer or its interface is re-applied — a peer
// edit (wg-helper /apply replaces peers), a reconcile rebuild after a host
// reboot, or the interface being torn down and recreated. A counter that went
// backwards is a RESET, not negative traffic: report 0 for that direction so
// the uint64 subtraction can never wrap to ~2^64 and store a huge negative
// int64 sample (that is what dragged the hourly "Traffic over time" chart
// below 0 B).
func counterDeltas(prevRX, prevTX, curRX, curTX uint64) (rx, tx int64) {
	if curRX >= prevRX {
		rx = int64(curRX - prevRX)
	}
	if curTX >= prevTX {
		tx = int64(curTX - prevTX)
	}
	return rx, tx
}

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
				// A counter that went backwards means the kernel reset it
				// (peer/interface re-applied); guard so no negative sample
				// is ever written (see counterDeltas).
				deltaRX, deltaTX := counterDeltas(prev.RXBytes, prev.TXBytes, rx, tx)
				if _, err := w.pool.Exec(ctx, `
					INSERT INTO peer_traffic_samples (peer_id, rx_bytes, tx_bytes)
					SELECT id, $2, $3 FROM peers
					WHERE server_id = $1 AND public_key = $4 AND status != 'removed'
				`, srv.id, deltaRX, deltaTX, st.PublicKey); err != nil {
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
