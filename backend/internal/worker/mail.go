package worker

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/email"
)

// MailWorker drains the jobs table and sends queued emails (user invites,
// admin invites, test emails) over SMTP. It is a no-op while SMTP is not
// configured (SMTP_HOST unset) — jobs stay queued instead of failing, so
// invites sent before SMTP setup can still be delivered once it is added.
type MailWorker struct {
	pool *pgxpool.Pool
}

func NewMailWorker(pool *pgxpool.Pool) *MailWorker {
	return &MailWorker{pool: pool}
}

func (w *MailWorker) Start(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	log.Println("Mail worker started (queued invites/test emails will be sent once SMTP is configured)")

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// SMTP config now lives in the database (set from the console
			// UI, with env vars as a fallback). No config, no sending.
			cfg := email.LoadConfig(ctx, w.pool)
			if cfg.Host == "" {
				continue
			}
			svc := email.NewServiceWithConfig(cfg)
			q := email.NewQueue(w.pool, svc)
			if err := q.ProcessNext(ctx); err != nil {
				log.Printf("Mail worker: %v", err)
			}
		}
	}
}
