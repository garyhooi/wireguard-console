package worker

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/api"
)

// DomainRuleWorker periodically re-pushes the domain-block rules from the
// database into AdGuard Home.
//
// Rules are normally synced on create/delete and once at API startup, but
// AdGuard can lose them out-of-band: a re-provision (configure-adguard.sh
// writes a clean AdGuardHome.yaml with empty user_rules), a manual edit in
// the AdGuard UI, or a failed/partial sync that only logged an error. A
// periodic reconciliation guarantees the DB is the source of truth and the
// rules are actually applied — otherwise "rule exists but isn't blocking"
// can go unnoticed indefinitely.
type DomainRuleWorker struct {
	pool     *pgxpool.Pool
	interval time.Duration
}

func NewDomainRuleWorker(pool *pgxpool.Pool, interval time.Duration) *DomainRuleWorker {
	return &DomainRuleWorker{pool: pool, interval: interval}
}

func (w *DomainRuleWorker) Start(ctx context.Context) {
	if w.interval <= 0 {
		w.interval = 5 * time.Minute
	}
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	log.Printf("Domain-rule worker started (re-syncs rules to AdGuard every %s)", w.interval)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			store := api.NewStore(w.pool)
			n, err := api.SyncDomainRulesToAdGuard(store)
			if err != nil {
				log.Printf("Domain-rule worker: failed to sync to AdGuard: %v", err)
				continue
			}
			if n > 0 {
				log.Printf("Domain-rule worker: synced %d rule(s) to AdGuard", n)
			}
		}
	}
}
