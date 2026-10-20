package api

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

// IPBlockedActivity surfaces blocked-IP connection attempts in the console.
// Blocked packets are dropped before DNS, so they never appear in the
// AdGuard-derived browsing records; they come from wg-helper's nftables rule
// counters (sampled by worker.IPBlockHitWorker into ip_block_hits).
//
//	GET /api/web-activity/ip-blocked?days=7&limit=100
//
// limit=0 returns only the totals + top destinations (Statistics).
func IPBlockedActivity(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		days := 7
		if raw := r.URL.Query().Get("days"); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil && n >= 1 && n <= 90 {
				days = n
			}
		}
		limit := 100
		if raw := r.URL.Query().Get("limit"); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil && n >= 0 && n <= 500 {
				limit = n
			}
		}
		from := time.Now().AddDate(0, 0, -days)

		var totalHits int64
		_ = store.pool.QueryRow(ctx,
			`SELECT COALESCE(SUM(packets), 0) FROM ip_block_hits WHERE sampled_at >= $1`, from,
		).Scan(&totalHits)

		type topEntry struct {
			DestCIDR string `json:"dest_cidr"`
			Hits     int64  `json:"hits"`
		}
		top := []topEntry{}
		topRows, err := store.pool.Query(ctx, `
			SELECT dest_cidr, SUM(packets)::bigint AS hits
			FROM ip_block_hits
			WHERE sampled_at >= $1
			GROUP BY dest_cidr
			ORDER BY hits DESC
			LIMIT 10
		`, from)
		if err == nil {
			defer topRows.Close()
			for topRows.Next() {
				var entry topEntry
				if topRows.Scan(&entry.DestCIDR, &entry.Hits) == nil {
					top = append(top, entry)
				}
			}
		}

		type hitRecord struct {
			ID        int64     `json:"id"`
			UserName  string    `json:"user_name"`
			UserEmail string    `json:"user_email"`
			ClientIP  string    `json:"client_ip"`
			DestCIDR  string    `json:"dest_cidr"`
			Packets   int64     `json:"packets"`
			SampledAt time.Time `json:"sampled_at"`
		}
		records := []hitRecord{}
		if limit > 0 {
			rows, err := store.pool.Query(ctx, `
				SELECT h.id, COALESCE(u.full_name, ''), COALESCE(u.email, ''),
				       COALESCE(host(h.client_ip), ''), h.dest_cidr, h.packets, h.sampled_at
				FROM ip_block_hits h
				LEFT JOIN users u ON u.id = h.user_id
				WHERE h.sampled_at >= $1
				ORDER BY h.sampled_at DESC
				LIMIT $2
			`, from, limit)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to query blocked-IP activity")
				return
			}
			defer rows.Close()
			for rows.Next() {
				var rec hitRecord
				if err := rows.Scan(&rec.ID, &rec.UserName, &rec.UserEmail, &rec.ClientIP,
					&rec.DestCIDR, &rec.Packets, &rec.SampledAt); err != nil {
					writeError(w, http.StatusInternalServerError, "Failed to scan blocked-IP activity")
					return
				}
				records = append(records, rec)
			}
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"days":       days,
			"total_hits": totalHits,
			"top":        top,
			"records":    records,
		})
	}
}
