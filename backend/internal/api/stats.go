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

// GetTrafficUsage returns aggregated rx/tx for a date range, grouped by
// peer or by VPN user. Reads both live samples and the older daily rollup
// (they never overlap: the rollup deletes samples older than 30 days).
//
//	GET /api/stats/usage?scope=peer|user&from=YYYY-MM-DD&to=YYYY-MM-DD
func GetTrafficUsage(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		scope := r.URL.Query().Get("scope")
		if scope != "user" {
			scope = "peer"
		}
		parseDay := func(v string, fallback time.Time) time.Time {
			if t, err := time.Parse("2006-01-02", v); err == nil {
				return t
			}
			return fallback
		}
		to := time.Now()
		from := parseDay(r.URL.Query().Get("from"), to.AddDate(0, 0, -6))
		to = parseDay(r.URL.Query().Get("to"), to)

		var rows []map[string]interface{}
		var err error
		if scope == "user" {
			rows, err = queryUsage(store, ctx, true, from, to)
		} else {
			rows, err = queryUsage(store, ctx, false, from, to)
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query usage")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"scope": scope,
			"from":  from.Format("2006-01-02"),
			"to":    to.Format("2006-01-02"),
			"rows":  rows,
		})
	}
}

func queryUsage(store *Store, ctx context.Context, byUser bool, from, to time.Time) ([]map[string]interface{}, error) {
	cte := `
		WITH t AS (
			SELECT peer_id, rx_bytes, tx_bytes
			FROM peer_traffic_samples WHERE sampled_at::date BETWEEN $1 AND $2
			UNION ALL
			SELECT peer_id, rx_bytes, tx_bytes
			FROM peer_traffic_daily WHERE date BETWEEN $1 AND $2
		)`
	if byUser {
		rows, err := store.pool.Query(ctx, cte+`
			SELECT u.id::text, u.email, COALESCE(u.full_name, ''),
			       COALESCE(SUM(t.rx_bytes), 0), COALESCE(SUM(t.tx_bytes), 0),
			       COUNT(DISTINCT t.peer_id)
			FROM t
			JOIN peers p ON p.id = t.peer_id
			JOIN users u ON u.id = p.user_id
			GROUP BY u.id, u.email, u.full_name
			ORDER BY (COALESCE(SUM(t.rx_bytes),0) + COALESCE(SUM(t.tx_bytes),0)) DESC
		`, from, to)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []map[string]interface{}{}
		for rows.Next() {
			var id, email, full string
			var rx, tx, peers int64
			if err := rows.Scan(&id, &email, &full, &rx, &tx, &peers); err != nil {
				return nil, err
			}
			out = append(out, map[string]interface{}{
				"id": id, "name": full, "email": email, "full_name": full,
				"rx_bytes": rx, "tx_bytes": tx, "peers": peers,
			})
		}
		return out, nil
	}

	rows, err := store.pool.Query(ctx, cte+`
		SELECT p.id::text, p.name, host(p.allowed_ip),
		       COALESCE(u.email, ''), COALESCE(u.full_name, ''),
		       COALESCE(SUM(t.rx_bytes), 0), COALESCE(SUM(t.tx_bytes), 0)
		FROM t
		JOIN peers p ON p.id = t.peer_id
		LEFT JOIN users u ON u.id = p.user_id
		GROUP BY p.id, p.name, p.allowed_ip, u.email, u.full_name
		ORDER BY (COALESCE(SUM(t.rx_bytes),0) + COALESCE(SUM(t.tx_bytes),0)) DESC
	`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]interface{}{}
	for rows.Next() {
		var id, name, ip, email, full string
		var rx, tx int64
		if err := rows.Scan(&id, &name, &ip, &email, &full, &rx, &tx); err != nil {
			return nil, err
		}
		out = append(out, map[string]interface{}{
			"id": id, "name": name, "email": email, "full_name": full, "allowed_ip": ip,
			"rx_bytes": rx, "tx_bytes": tx,
		})
	}
	return out, nil
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
