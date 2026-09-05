package worker

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/api"
)

// WGReconcileWorker keeps the WireGuard kernel state in sync with the
// database for locally-managed servers.
//
// Why this exists: wg-helper (local mode) is passive — it only applies
// WireGuard interfaces/NAT when the API pushes state, and the API only
// pushes on server/peer create/edit/delete. A host reboot therefore loses
// the kernel interface AND the iptables MASQUERADE rules, and nothing would
// restore them until an admin touched a server or peer — silently killing
// the VPN's connectivity. This worker re-applies the desired state after a
// reboot (and periodically thereafter), so the tunnel self-heals.
//
// Boot behaviour: reconcile fast (every 10s) until at least one interface
// has been applied successfully, so a fresh boot is repaired in seconds even
// though wg-helper may still be starting. Once healthy (or after a short
// grace period when wg-helper is absent, e.g. dev), it settles into the
// configured slow interval. The apply is idempotent and atomic (wgctrl
// ConfigureDevice replaces the whole peer set), so repeated passes are safe.
type WGReconcileWorker struct {
	pool     *pgxpool.Pool
	interval time.Duration
}

func NewWGReconcileWorker(pool *pgxpool.Pool, interval time.Duration) *WGReconcileWorker {
	return &WGReconcileWorker{pool: pool, interval: interval}
}

func (w *WGReconcileWorker) Start(ctx context.Context) {
	if w.interval <= 0 {
		w.interval = 2 * time.Minute
	}
	log.Println("WG reconcile worker started (restores local interfaces after reboot)")

	fastTick := time.NewTicker(10 * time.Second)
	defer fastTick.Stop()
	slowTick := time.NewTicker(w.interval)
	defer slowTick.Stop()

	healthy := false
	fastAttempts := 0
	const fastAttemptCap = 6 // ~60s of fast attempts before settling

	// Run once immediately so a reboot is repaired right away.
	healthy = w.reconcile(ctx)
	fastAttempts++

	for {
		select {
		case <-ctx.Done():
			return
		case <-fastTick.C:
			if healthy || fastAttempts >= fastAttemptCap {
				continue
			}
			fastAttempts++
			healthy = w.reconcile(ctx)
			if fastAttempts >= fastAttemptCap && !healthy {
				log.Println("WG reconcile worker: wg-helper not reachable yet; will keep retrying on the slow interval")
			}
		case <-slowTick.C:
			if !healthy && fastAttempts < fastAttemptCap {
				continue // still in the fast phase
			}
			healthy = w.reconcile(ctx)
		}
	}
}

// reconcile re-applies every active local server's desired state to
// wg-helper and reports whether at least one server applied cleanly.
func (w *WGReconcileWorker) reconcile(ctx context.Context) bool {
	n, err := api.SyncAllLocalServersToKernel(w.pool)
	if err != nil {
		log.Printf("WG reconcile worker: failed to sync local servers: %v", err)
		return false
	}
	if n > 0 {
		log.Printf("WG reconcile worker: applied %d local server(s)", n)
	}
	// No locally-managed servers is a healthy state too — there is nothing
	// to repair.
	return err == nil
}
