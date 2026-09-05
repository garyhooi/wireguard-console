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
	log.Println("Session purge worker started (expired admin_sessions)")

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

func (w *SessionPurgeWorker) purge(ctx context.Context) {
	tag, err := w.pool.Exec(ctx, `
		DELETE FROM admin_sessions WHERE expires_at <= now()
	`)
	if err != nil {
		log.Printf("Session purge worker: failed to purge expired sessions: %v", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("Session purge worker: removed %d expired session(s)", n)
	}
}
