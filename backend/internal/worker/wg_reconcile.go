package worker

import (
	"context"
	"log"
	"os"
	"strconv"
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
// the VPN's connectivity. This worker detects missing interfaces and
// re-applies them, so the tunnel self-heals after a reboot.
//
// Boot behaviour: reconcile fast (every 10s) until every local interface is
// confirmed present (wg-helper may still be starting right after boot), then
// it settles into the configured slow interval. Each pass PROBES the kernel
// interface first and only re-applies servers whose interface is missing —
// a healthy running interface is never re-applied (a force re-apply would
// ReplacePeers and reset live kernel counters/handshakes, corrupting traffic
// statistics and dropping connected clients).
type WGReconcileWorker struct {
	pool     *pgxpool.Pool
	interval time.Duration
}

func NewWGReconcileWorker(pool *pgxpool.Pool, interval time.Duration) *WGReconcileWorker {
	if interval <= 0 {
		interval = 2 * time.Minute
	}
	// WG_RECONCILE_INTERVAL (seconds) overrides the slow-tick interval — used
	// by tests to exercise the probe-before-apply behaviour without waiting
	// the real two minutes.
	if v := os.Getenv("WG_RECONCILE_INTERVAL"); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
			interval = time.Duration(secs) * time.Second
		}
	}
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

// reconcile probes every active local server's kernel interface and re-applies
// only those that are missing (post-reboot). Reports true when every server's
// interface is present — i.e. nothing is left to repair — so the caller can
// settle out of the fast retry loop.
func (w *WGReconcileWorker) reconcile(ctx context.Context) bool {
	n, err := api.SyncAllLocalServersToKernel(w.pool)
	if err != nil {
		log.Printf("WG reconcile worker: failed to sync local servers: %v", err)
		return false
	}
	if n > 0 {
		log.Printf("WG reconcile worker: applied %d local server(s)", n)
	}
	// n==0 means every local interface is already up (or none exist / no
	// socket in dev) — a fully healthy state.
	return err == nil && n == 0
}
