package worker

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SessionPurgeWorker removes expired admin_sessions rows so the table never
// grows without bound. Rows are deleted once their absolute expiry passes —
// idle-expired rows are already deleted inline by AuthMiddleware when a
// stale cookie is presented; this worker is the backstop for sessions that
// simply age out while nobody uses the cookie.
type SessionPurgeWorker struct {
	pool     *pgxpool.Pool
	interval time.Duration
}

func NewSessionPurgeWorker(pool *pgxpool.Pool, interval time.Duration) *SessionPurgeWorker {
	return &SessionPurgeWorker{pool: pool, interval: interval}
}

func (w *SessionPurgeWorker) Start(ctx context.Context) {
	if w.interval <= 0 {
		w.interval = time.Hour
	}
	log.Println("Session purge worker started (expired sessions + housekeeping)")

	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	w.purge(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.purge(ctx)
		}
	}
}

// purge removes rows that would otherwise grow without bound: expired
// sessions/invites/access tokens (they are dead on arrival once the expiry
// passes) plus long-finished email jobs and old audit-log rows. Runs hourly.
func (w *SessionPurgeWorker) purge(ctx context.Context) {
	queries := []struct {
		name string
		sql  string
	}{
		{"expired session(s)", `DELETE FROM admin_sessions WHERE expires_at <= now()`},
		{"expired invite(s)", `DELETE FROM invites WHERE expires_at <= now()`},
		{"expired peer access token(s)", `DELETE FROM peer_access_tokens WHERE expires_at <= now()`},
		{"finished email job(s)", `DELETE FROM jobs WHERE (completed_at IS NOT NULL OR failed_at IS NOT NULL) AND created_at < now() - interval '7 days'`},
		{"old audit log row(s)", `DELETE FROM audit_logs WHERE created_at < now() - interval '90 days'`},
	}
	for _, q := range queries {
		tag, err := w.pool.Exec(ctx, q.sql)
		if err != nil {
			log.Printf("Session purge worker: failed to purge %s: %v", q.name, err)
			continue
		}
		if n := tag.RowsAffected(); n > 0 {
			log.Printf("Session purge worker: removed %d %s", n, q.name)
		}
	}
}
