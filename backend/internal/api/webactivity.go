package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ---------------------------------------------------------------------------
// Web-activity records (per-peer DNS browsing history imported from AdGuard
// Home by worker.BrowseWorker). Routes:
//
//	GET  /api/web-activity                    records (filters + page)
//	GET  /api/web-activity/summary            per-peer / per-user tallies in a range
//	GET  /api/web-activity/top-domains        top-10 allowed + blocked domains, 7 days
//	DELETE /api/web-activity                  super_admin housekeeping purge
//
// "Browsing" here means DNS lookups (domain names), which is the only layer
// observable through an encrypted WireGuard tunnel; see worker/browse.go.
// ---------------------------------------------------------------------------

func parseDayParam(v string, fallback time.Time) time.Time {
	if t, err := time.Parse("2006-01-02", v); err == nil {
		return t
	}
	return fallback
}

// parseDayRange converts inclusive YYYY-MM-DD bounds into a half-open
// [from, to) interval on the raw timestamp column so the index is usable.
func parseDayRange(fromStr, toStr string, fallbackDays int) (time.Time, time.Time) {
	to := time.Now()
	from := parseDayParam(fromStr, to.AddDate(0, 0, -fallbackDays))
	to = parseDayParam(toStr, to)
	// Make "to" inclusive of the whole day.
	to = to.Add(24*time.Hour - time.Nanosecond)
	return from, to
}

// ListWebActivity returns browsing records with optional filters:
//
//	GET /api/web-activity?user_id=&peer_id=&blocked=all|blocked|allowed
//	                       &q=&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=200
//
// block states: "all" (default), "blocked" (only blocked), "allowed" (only
// allowed). Each row is joined to its peer and VPN user for display.
func ListWebActivity(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		q := r.URL.Query()

		blocked := q.Get("blocked")
		if blocked != "blocked" && blocked != "allowed" {
			blocked = "all"
		}
		from, to := parseDayRange(q.Get("from"), q.Get("to"), 7)

		limit := 200
		if raw := q.Get("limit"); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 1000 {
				limit = n
			}
		}

		where := []string{"b.queried_at >= $1 AND b.queried_at < $2"}
		args := []interface{}{from, to}
		if v := q.Get("user_id"); v != "" {
			if _, err := uuid.Parse(v); err == nil {
				args = append(args, v)
				where = append(where, "p.user_id = $"+strconv.Itoa(len(args)))
			}
		}
		if v := q.Get("peer_id"); v != "" {
			if _, err := uuid.Parse(v); err == nil {
				args = append(args, v)
				where = append(where, "b.peer_id = $"+strconv.Itoa(len(args)))
			}
		}
		if blocked == "blocked" {
			where = append(where, "b.blocked = TRUE")
		} else if blocked == "allowed" {
			where = append(where, "b.blocked = FALSE")
		}
		if v := strings.TrimSpace(q.Get("q")); v != "" {
			args = append(args, "%"+strings.ToLower(v)+"%")
			where = append(where, "(b.host ILIKE $"+strconv.Itoa(len(args))+
				" OR b.base_domain ILIKE $"+strconv.Itoa(len(args))+")")
		}
		args = append(args, limit)
		limitPh := "$" + strconv.Itoa(len(args))

		sql := `
			SELECT b.id, b.peer_id, p.name, p.user_id, COALESCE(u.full_name, u.email, ''),
			       COALESCE(u.email, ''), host(b.client_ip), b.host, b.base_domain,
			       b.blocked, b.reason, b.queried_at
			FROM browsing_records b
			JOIN peers p ON p.id = b.peer_id
			LEFT JOIN users u ON u.id = p.user_id
			WHERE ` + strings.Join(where, " AND ") + `
			ORDER BY b.queried_at DESC
			LIMIT ` + limitPh
		rows, err := store.pool.Query(ctx, sql, args...)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query web activity")
			return
		}
		defer rows.Close()

		type record struct {
			ID         int64      `json:"id"`
			PeerID     uuid.UUID  `json:"peer_id"`
			PeerName   string     `json:"peer_name"`
			UserID     *uuid.UUID `json:"user_id"`
			UserName   string     `json:"user_name"`
			UserEmail  string     `json:"user_email"`
			ClientIP   string     `json:"client_ip"`
			Host       string     `json:"host"`
			BaseDomain string     `json:"base_domain"`
			Blocked    bool       `json:"blocked"`
			Reason     *string    `json:"reason"`
			QueriedAt  time.Time  `json:"queried_at"`
		}
		out := []record{}
		for rows.Next() {
			var rc record
			if err := rows.Scan(&rc.ID, &rc.PeerID, &rc.PeerName, &rc.UserID, &rc.UserName,
				&rc.UserEmail, &rc.ClientIP, &rc.Host, &rc.BaseDomain,
				&rc.Blocked, &rc.Reason, &rc.QueriedAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan web activity")
				return
			}
			out = append(out, rc)
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"from":  from.Format("2006-01-02"),
			"to":    to.Format("2006-01-02"),
			"limit": limit,
			"rows":  out,
			"count": len(out),
		})
	}
}

// WebActivitySummary is the tallies behind the per-VPN-user / per-peer
// records table on the Web Activity page.
type WebActivitySummary struct {
	// Scope is "user" or "peer".
	Scope    string     `json:"scope"`
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Email    string     `json:"email"`
	Peers    int64      `json:"peers"`
	Allowed  int64      `json:"allowed"`
	Blocked  int64      `json:"blocked"`
	LastSeen *time.Time `json:"last_seen"`
}

// GetWebActivitySummary groups counts by VPN user or peer in a date range:
//
//	GET /api/web-activity/summary?scope=user|peer&from=&to=
func GetWebActivitySummary(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		q := r.URL.Query()
		scope := q.Get("scope")
		if scope != "peer" {
			scope = "user"
		}
		from, to := parseDayRange(q.Get("from"), q.Get("to"), 7)

		var sql string
		if scope == "peer" {
			sql = `
				SELECT 'peer' AS scope, p.id::text AS id,
				       COALESCE(NULLIF(p.name, ''), 'peer') AS name,
				       COALESCE(u.email, '') AS email,
				       CAST(1 AS BIGINT) AS peers,
				       COUNT(*) FILTER (WHERE b.blocked = FALSE) AS allowed,
				       COUNT(*) FILTER (WHERE b.blocked = TRUE)  AS blocked,
				       MAX(b.queried_at) AS last_seen
				FROM browsing_records b
				JOIN peers p ON p.id = b.peer_id
				LEFT JOIN users u ON u.id = p.user_id
				WHERE b.queried_at >= $1 AND b.queried_at < $2
				GROUP BY p.id, p.name, u.email
				ORDER BY (COUNT(*) FILTER (WHERE b.blocked = FALSE) +
				          COUNT(*) FILTER (WHERE b.blocked = TRUE)) DESC`
		} else {
			sql = `
				SELECT 'user' AS scope, u.id::text AS id,
				       COALESCE(u.full_name, u.email, 'user') AS name,
				       COALESCE(u.email, '') AS email,
				       COUNT(DISTINCT p.id) AS peers,
				       COUNT(*) FILTER (WHERE b.blocked = FALSE) AS allowed,
				       COUNT(*) FILTER (WHERE b.blocked = TRUE)  AS blocked,
				       MAX(b.queried_at) AS last_seen
				FROM browsing_records b
				JOIN peers p ON p.id = b.peer_id
				LEFT JOIN users u ON u.id = p.user_id
				WHERE b.queried_at >= $1 AND b.queried_at < $2
				GROUP BY u.id, u.full_name, u.email
				ORDER BY (COUNT(*) FILTER (WHERE b.blocked = FALSE) +
				          COUNT(*) FILTER (WHERE b.blocked = TRUE)) DESC`
		}
		rows, err := store.pool.Query(ctx, sql, from, to)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query web activity summary")
			return
		}
		defer rows.Close()

		out := []WebActivitySummary{}
		for rows.Next() {
			var s WebActivitySummary
			if err := rows.Scan(&s.Scope, &s.ID, &s.Name, &s.Email, &s.Peers, &s.Allowed, &s.Blocked, &s.LastSeen); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan web activity summary")
				return
			}
			out = append(out, s)
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"scope": scope,
			"from":  from.Format("2006-01-02"),
			"to":    to.Format("2006-01-02"),
			"rows":  out,
		})
	}
}

// TopDomain is one row of the top-10 domain panels.
type TopDomain struct {
	Domain  string `json:"domain"`
	Count   int64  `json:"count"`
	Blocked int64  `json:"blocked,omitempty"`
}

// GetTopDomains returns the top-10 most-browsed domains (allowed) and the
// top-10 domains users tried to reach but were blocked, over the last 7 days:
//
//	GET /api/web-activity/top-domains
func GetTopDomains(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		days := 7
		if raw := r.URL.Query().Get("days"); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 90 {
				days = n
			}
		}

		type pairs struct {
			label string
			sql   string
		}
		// Allowed queries: responses NOT blocked by the filter.
		allowed, err := topDomains(ctx, store, `
			SELECT base_domain AS domain, COUNT(*) AS count
			FROM browsing_records
			WHERE queried_at >= now() - make_interval(days => $1)
			  AND blocked = FALSE
			GROUP BY base_domain
			ORDER BY COUNT(*) DESC
			LIMIT 10`, days)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query top domains")
			return
		}
		// Blocked attempts: DNS queries the filter refused.
		blocked, err := topDomains(ctx, store, `
			SELECT base_domain AS domain, COUNT(*) AS count
			FROM browsing_records
			WHERE queried_at >= now() - make_interval(days => $1)
			  AND blocked = TRUE
			GROUP BY base_domain
			ORDER BY COUNT(*) DESC
			LIMIT 10`, days)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query blocked domains")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"days":    days,
			"allowed": allowed,
			"blocked": blocked,
		})
	}
}

func topDomains(ctx context.Context, store *Store, sql string, days int) ([]TopDomain, error) {
	rows, err := store.pool.Query(ctx, sql, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopDomain{}
	for rows.Next() {
		var t TopDomain
		if err := rows.Scan(&t.Domain, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// PurgeWebActivity deletes browsing records — super_admin housekeeping
// (route-gated), mirroring PurgeAuditLogs semantics:
//
//	DELETE /api/web-activity?days=90   → older than 90 days
//	DELETE /api/web-activity           → clear everything
func PurgeWebActivity(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		actorID := getAdminID(r)

		days := 0
		if raw := r.URL.Query().Get("days"); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 {
				writeError(w, http.StatusBadRequest, "days must be a positive integer")
				return
			}
			days = n
		}

		var tag string
		var deleted int64
		if days > 0 {
			tag = "older_than_days"
			ct, err := store.pool.Exec(ctx, `
				DELETE FROM browsing_records WHERE queried_at < now() - make_interval(days => $1)
			`, days)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to purge web activity")
				return
			}
			deleted = ct.RowsAffected()
		} else {
			tag = "all"
			ct, err := store.pool.Exec(ctx, `DELETE FROM browsing_records`)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to clear web activity")
				return
			}
			deleted = ct.RowsAffected()
		}

		// The import high-water mark is intentionally left untouched: it
		// points at the newest entry AdGuard has already seen, and purging our
		// stored copy must not trigger a re-import of the whole window (that
		// would defeat the housekeeping). After a full clear only queries
		// newer than the mark get imported, so the page records fresh activity
		// from now on.

		logAudit(ctx, store, actorID, "web_activity.purge", "web_activity", "", map[string]interface{}{
			"scope":   tag,
			"days":    days,
			"deleted": deleted,
		})

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":  "purged",
			"deleted": deleted,
			"scope":   tag,
		})
	}
}
