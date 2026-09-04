package api

import (
	"context"
	"net/http"
	"time"

	"github.com/wireguard-console/backend/internal/db"
)

func GetStatsOverview(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		var stats db.StatsOverview

		store.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM peers
		`).Scan(&stats.TotalPeers)

		store.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM peers WHERE status = 'active'
		`).Scan(&stats.ActivePeers)

		store.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM peers WHERE status = 'suspended'
		`).Scan(&stats.SuspendedPeers)

		store.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM users
		`).Scan(&stats.TotalUsers)

		store.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM users WHERE status = 'active'
		`).Scan(&stats.ActiveUsers)

		store.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM servers WHERE status = 'active'
		`).Scan(&stats.TotalServers)

		store.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM peers 
			WHERE last_handshake_at > now() - interval '3 minutes'
		`).Scan(&stats.ConnectedPeers)

		writeJSON(w, http.StatusOK, stats)
	}
}

func GetPeerTraffic(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peerID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid peer ID")
			return
		}

		ctx := context.Background()

		type trafficSample struct {
			RXBytes   int64     `json:"rx_bytes"`
			TXBytes   int64     `json:"tx_bytes"`
			SampledAt time.Time `json:"sampled_at"`
		}
		var samples []trafficSample

		rows, err := store.pool.Query(ctx, `
			SELECT rx_bytes, tx_bytes, sampled_at
			FROM peer_traffic_samples
			WHERE peer_id = $1
			ORDER BY sampled_at DESC
			LIMIT 100
		`, peerID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query traffic")
			return
		}
		defer rows.Close()

		for rows.Next() {
			var s trafficSample
			if err := rows.Scan(&s.RXBytes, &s.TXBytes, &s.SampledAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan traffic sample")
				return
			}
			samples = append(samples, s)
		}

		writeJSON(w, http.StatusOK, samples)
	}
}

func GetUserTraffic(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid user ID")
			return
		}

		ctx := context.Background()

		var totalRX, totalTX int64
		store.pool.QueryRow(ctx, `
			SELECT COALESCE(SUM(rx_bytes), 0), COALESCE(SUM(tx_bytes), 0)
			FROM peer_traffic_samples pts
			JOIN peers p ON pts.peer_id = p.id
			WHERE p.user_id = $1
		`, userID).Scan(&totalRX, &totalTX)

		writeJSON(w, http.StatusOK, map[string]int64{
			"total_rx_bytes": totalRX,
			"total_tx_bytes": totalTX,
		})
	}
}

// GetTrafficStats returns hourly traffic for the last 24 hours plus the
// top peers by volume — real data from the kernel sampler.
func GetTrafficStats(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		seriesRows, err := store.pool.Query(ctx, `
			SELECT to_char(date_trunc('hour', sampled_at), 'HH24:00') AS hour,
			       SUM(rx_bytes) AS rx, SUM(tx_bytes) AS tx
			FROM peer_traffic_samples
			WHERE sampled_at >= now() - interval '24 hours'
			GROUP BY 1 ORDER BY 1
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query traffic series")
			return
		}
		series := []map[string]interface{}{}
		for seriesRows.Next() {
			var hour string
			var rx, tx int64
			if err := seriesRows.Scan(&hour, &rx, &tx); err != nil {
				continue
			}
			series = append(series, map[string]interface{}{"time": hour, "rx": rx, "tx": tx})
		}
		seriesRows.Close()

		topRows, err := store.pool.Query(ctx, `
			SELECT COALESCE(p.name, 'unknown'), SUM(t.rx_bytes), SUM(t.tx_bytes)
			FROM peer_traffic_samples t
			JOIN peers p ON p.id = t.peer_id
			WHERE t.sampled_at >= now() - interval '24 hours'
			GROUP BY p.name ORDER BY (SUM(t.rx_bytes) + SUM(t.tx_bytes)) DESC LIMIT 10
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query top peers")
			return
		}
		top := []map[string]interface{}{}
		for topRows.Next() {
			var name string
			var rx, tx int64
			if err := topRows.Scan(&name, &rx, &tx); err != nil {
				continue
			}
			top = append(top, map[string]interface{}{"name": name, "rx": rx, "tx": tx})
		}
		topRows.Close()

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"series": series,
			"top":    top,
		})
	}
}

func ListAuditLogs(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		logs := []db.AuditLog{}
		rows, err := store.pool.Query(ctx, `
			SELECT id, actor_admin_id, action, target_type, target_id, metadata, ip_address, created_at
			FROM audit_logs
			ORDER BY created_at DESC
			LIMIT 100
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query audit logs")
			return
		}
		defer rows.Close()

		for rows.Next() {
			var l db.AuditLog
			if err := rows.Scan(&l.ID, &l.ActorAdminID, &l.Action, &l.TargetType,
				&l.TargetID, &l.Metadata, &l.IPAddress, &l.CreatedAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan audit log")
				return
			}
			logs = append(logs, l)
		}

		writeJSON(w, http.StatusOK, logs)
	}
}
