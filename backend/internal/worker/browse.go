package worker

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/net/publicsuffix"

	"github.com/wireguard-console/backend/internal/adguard"
)

// BrowseWorker imports AdGuard Home's DNS query log into browsing_records so
// the console can show what each VPN user / peer browsed and whether each
// domain was blocked (by the DNS filter) or allowed.
//
// Why AdGuard's query log? WireGuard carries encrypted traffic, so the only
// layer the console can observe per-peer web activity at is DNS: every peer
// resolves through the bundled AdGuard Home (tunnel gateway), which logs each
// query with the peer's tunnel IP, the queried hostname and the filtering
// outcome. A worker imports those rows into Postgres on a short tick; pages,
// statistics and super-admin housekeeping then read from the DB.
//
// Import model: AGH returns entries newest-first and only pages backwards via
// older_than. A single-row high-water mark (browse_import_state) records how
// far the import has reached so a normal tick imports just the newest page
// (minus rows already held) instead of re-scanning the retained window every
// 30s. Imports are idempotent (ON CONFLICT DO NOTHING on the natural
// client+host+instant key), so overlapping pages never duplicate. The worker
// never imports queries older than the retention window — those rows are
// purged nightly anyway.
type BrowseWorker struct {
	pool *pgxpool.Pool
}

const (
	browsePollInterval = 30 * time.Second
	browsePageSize     = 1000
	// browseMaxPages caps how far a single tick walks back. Steady state
	// touches one page; a large backlog (worker/AdGuard downtime, fresh
	// install) is caught up over several ticks (~60k rows per 30s) instead
	// of hammering the DB in one giant batch.
	browseMaxPages       = 60
	defaultRetentionDays = 30
)

// peerRef maps one tunnel client IP to its owning peer.
type peerRef struct {
	peerID string
	userID string
}

func NewBrowseWorker(pool *pgxpool.Pool) *BrowseWorker {
	return &BrowseWorker{pool: pool}
}

// retentionDays returns how long raw browsing records are kept before the
// nightly purge, from BROWSE_RETENTION_DAYS (default 30).
func retentionDays() int {
	raw := os.Getenv("BROWSE_RETENTION_DAYS")
	if n, err := strconv.Atoi(raw); err == nil && n >= 1 {
		return n
	}
	return defaultRetentionDays
}

func (w *BrowseWorker) Start(ctx context.Context) {
	log.Printf("Browse worker started (imports AdGuard query log every %s, retention %d days)",
		browsePollInterval, retentionDays())

	// Purge on startup and nightly so a long-running install never grows
	// without bound even if the worker restarts.
	if err := w.purge(ctx); err != nil {
		log.Printf("Browse worker: initial purge failed: %v", err)
	}

	poll := time.NewTicker(browsePollInterval)
	defer poll.Stop()
	purge := time.NewTicker(24 * time.Hour)
	defer purge.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
			if err := w.sync(ctx); err != nil {
				log.Printf("Browse worker: %v", err)
			}
		case <-purge.C:
			if err := w.purge(ctx); err != nil {
				log.Printf("Browse worker: nightly purge failed: %v", err)
			}
		}
	}
}

// peerIndex loads the tunnel IP → peer map for every active peer on an active
// server. Only those clients generate DNS traffic through the filter, so only
// their queries are imported.
func (w *BrowseWorker) peerIndex(ctx context.Context) (map[string]peerRef, error) {
	rows, err := w.pool.Query(ctx, `
		SELECT p.id::text, p.user_id::text, host(p.allowed_ip)
		FROM peers p
		JOIN servers s ON s.id = p.server_id
		WHERE p.status = 'active' AND s.status = 'active'
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	index := make(map[string]peerRef)
	for rows.Next() {
		var id, uid, ip string
		if err := rows.Scan(&id, &uid, &ip); err != nil {
			return nil, err
		}
		index[normalizeIP(ip)] = peerRef{peerID: id, userID: uid}
	}
	return index, rows.Err()
}

// sync imports new AdGuard query-log entries since the last successful run.
// Idempotent and safe to run concurrently-ish (ON CONFLICT DO NOTHING); the
// high-water mark prevents re-importing the whole window each tick.
func (w *BrowseWorker) sync(ctx context.Context) error {
	index, err := w.peerIndex(ctx)
	if err != nil {
		return fmt.Errorf("load peer index: %w", err)
	}
	if len(index) == 0 {
		return nil // no tunnel peers yet — nothing to attribute
	}

	client := adguard.NewClient()
	cutoff := time.Now().AddDate(0, 0, -retentionDays())

	// Never import rows we would purge anyway. Clamping the cursor to the
	// retention horizon also makes a fresh install import only the retained
	// window instead of AdGuard's whole log (default 90 days).
	cursor, err := w.readCursor(ctx)
	if err != nil {
		return fmt.Errorf("read import cursor: %w", err)
	}
	if cursor.Before(cutoff) {
		cursor = cutoff
	}

	var imported int
	// newestSeen: time of the newest entry on page 0 — the steady-state
	// resume point once this tick reaches previously-imported history.
	var newestSeen time.Time
	// deepestSeen: time of the oldest entry examined this tick. If the page
	// cap is hit before reaching known history, the cursor resumes from here
	// next tick so a huge backlog still converges.
	var deepestSeen time.Time
	reachedHistory := false

	olderThan := time.Time{}
pageLoop:
	for page := 0; page < browseMaxPages; page++ {
		entries, err := client.GetQueryLog(ctx, olderThan, browsePageSize)
		if err != nil {
			if imported > 0 {
				log.Printf("Browse worker: partial import (%d rows) before AdGuard error: %v", imported, err)
			}
			return fmt.Errorf("fetch AdGuard query log: %w", err)
		}
		if len(entries) == 0 {
			reachedHistory = true
			break
		}

		if page == 0 {
			if ts, err := time.Parse(time.RFC3339Nano, entries[0].Time); err == nil {
				newestSeen = ts
			}
		}
		if oldest, err := time.Parse(time.RFC3339Nano, entries[len(entries)-1].Time); err == nil {
			deepestSeen = oldest
		}

		// Entries are newest-first; the first one not newer than the cursor
		// means everything after it was already imported (or is beyond the
		// retention horizon). Import rows above that boundary only.
		rows := make([][]interface{}, 0, len(entries))
		for _, e := range entries {
			ts, err := time.Parse(time.RFC3339Nano, e.Time)
			if err != nil {
				continue // unparseable AGH clock — skip
			}
			if !ts.After(cursor) {
				reachedHistory = true
				break
			}
			peer, ok := index[normalizeIP(e.Client)]
			if !ok {
				continue // host-network / non-peer client
			}
			host := cleanHost(e.Question.Name)
			if host == "" {
				continue
			}
			rows = append(rows, []interface{}{
				peer.peerID,
				normalizeIP(e.Client),
				host,
				registrableDomain(host),
				e.IsBlocked(),
				nullableReason(e),
				e.Rule,
				ts,
			})
		}
		if len(rows) > 0 {
			if err := w.insertBatch(ctx, rows); err != nil {
				return fmt.Errorf("insert browsing records: %w", err)
			}
			imported += len(rows)
		}
		if reachedHistory {
			break pageLoop
		}

		// This page was entirely newer than the cursor — more new history may
		// sit in older pages (busy tick / catch-up after downtime).
		olderThan = deepestSeen
		if olderThan.IsZero() {
			break
		}
	}

	// Advance the high-water mark. In the common case we saw the newest entry
	// and walked until already-imported history — resume from the newest. If
	// the page cap stopped us short of known history (huge backlog), resume
	// from the deepest entry examined so the next tick keeps digging.
	advance := newestSeen
	if !reachedHistory && deepestSeen.Before(newestSeen) {
		advance = deepestSeen
	}
	if err := w.saveCursor(ctx, advance); err != nil {
		return fmt.Errorf("save import cursor: %w", err)
	}
	if imported > 0 {
		log.Printf("Browse worker: imported %d new browsing record(s)", imported)
	}
	return nil
}

// readCursor returns the newest queried_at already imported (zero when never
// set).
func (w *BrowseWorker) readCursor(ctx context.Context) (time.Time, error) {
	var t *time.Time
	err := w.pool.QueryRow(ctx,
		`SELECT last_imported_at FROM browse_import_state WHERE id = 1`).Scan(&t)
	if err == pgx.ErrNoRows {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	if t == nil {
		return time.Time{}, nil
	}
	return *t, nil
}

func (w *BrowseWorker) saveCursor(ctx context.Context, t time.Time) error {
	if t.IsZero() {
		return nil
	}
	_, err := w.pool.Exec(ctx, `
		INSERT INTO browse_import_state (id, last_imported_at, updated_at)
		VALUES (1, $1, now())
		ON CONFLICT (id) DO UPDATE
			SET last_imported_at = GREATEST(browse_import_state.last_imported_at, $1),
			    updated_at = now()
	`, t)
	return err
}

// insertBatch inserts rows with ON CONFLICT DO NOTHING (idempotent).
func (w *BrowseWorker) insertBatch(ctx context.Context, rows [][]interface{}) error {
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(`
			INSERT INTO browsing_records
				(peer_id, client_ip, host, base_domain, blocked, reason, matched_rule, queried_at)
			VALUES ($1, $2::inet, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (client_ip, host, queried_at) DO NOTHING
		`, r...)
	}
	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()
	for range rows {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

func (w *BrowseWorker) purge(ctx context.Context) error {
	days := retentionDays()
	ct, err := w.pool.Exec(ctx, `
		DELETE FROM browsing_records
		WHERE queried_at < now() - make_interval(days => $1)
	`, days)
	if err != nil {
		return err
	}
	if n := ct.RowsAffected(); n > 0 {
		log.Printf("Browse worker: purged %d browsing record(s) older than %d days", n, days)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Host / domain helpers
// ---------------------------------------------------------------------------

// cleanHost lower-cases a queried hostname and drops the trailing dot.
func cleanHost(h string) string {
	h = strings.ToLower(strings.TrimSpace(strings.TrimSuffix(h, ".")))
	return h
}

// normalizeIP canonicalizes a client IP (handles IPv4-mapped IPv6 like
// ::ffff:10.8.0.1) so it matches host(allowed_ip) values.
func normalizeIP(s string) string {
	ip := net.ParseIP(strings.TrimSpace(s))
	if ip == nil {
		return strings.TrimSpace(s)
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

// registrableDomain returns the eTLD+1 (e.g. "www.youtube.com" → "youtube.com",
// "blog.github.io" → "blog.github.io" because github.io is a private suffix).
// Falls back to the host itself when no registrable suffix is known.
func registrableDomain(host string) string {
	if host == "" {
		return host
	}
	if d, err := publicsuffix.EffectiveTLDPlusOne(host); err == nil {
		return d
	}
	parts := strings.Split(host, ".")
	if len(parts) >= 3 {
		return strings.Join(parts[len(parts)-2:], ".")
	}
	return host
}

// nullableReason turns a blocking reason into a displayable value; only kept
// for genuinely blocked queries.
func nullableReason(e adguard.QueryLogEntry) interface{} {
	if e.IsBlocked() && e.Reason != "" {
		return e.Reason
	}
	return nil
}
