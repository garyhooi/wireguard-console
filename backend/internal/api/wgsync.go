package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/wgclient"
)

// wgSyncStore is what the sync helpers need from the store.
type wgSyncStore struct {
	pool *pgxpool.Pool
}

// syncServerToKernel pushes the current desired state of a server (and all
// its active peers) to wg-helper, which creates the interface, applies keys,
// and installs NAT/routing. It also refreshes handshake timestamps from the
// kernel. Best-effort: failures are logged, never fatal to the API call.
func syncServerToKernel(ctx context.Context, pool *pgxpool.Pool, serverID uuid.UUID) error {
	socket := os.Getenv("WG_HELPER_SOCKET")
	if socket == "" {
		return nil // local development without wg-helper
	}

	var (
		ifaceName  string
		listenPort int
		privEnc    string
		cidr       string
		mode       string
	)
	err := pool.QueryRow(ctx, `
		SELECT interface_name, listen_port, server_private_key_encrypted, network_cidr::text, managed_mode
		FROM servers WHERE id = $1
	`, serverID).Scan(&ifaceName, &listenPort, &privEnc, &cidr, &mode)
	if err != nil {
		return fmt.Errorf("server lookup: %w", err)
	}
	if mode == "manual" || mode == "remote" {
		return nil // manual: Host Setup covers it; remote: the node agent applies it
	}
	if privEnc == "" {
		return fmt.Errorf("server has no private key stored")
	}

	encSvc, err := auth.NewEncryptionService()
	if err != nil {
		return err
	}
	privKey, err := encSvc.Decrypt(privEnc)
	if err != nil {
		return fmt.Errorf("decrypt server key: %w", err)
	}

	gw, maskBits, err := gatewayForCIDR(cidr)
	if err != nil {
		return err
	}

	rows, err := pool.Query(ctx, `
		SELECT host(allowed_ip), public_key FROM peers
		WHERE server_id = $1 AND status = 'active'
		ORDER BY allowed_ip
	`, serverID)
	if err != nil {
		return fmt.Errorf("peer lookup: %w", err)
	}
	defer rows.Close()

	var peers []wgclient.ApplyPeer
	for rows.Next() {
		var ip, pub string
		if err := rows.Scan(&ip, &pub); err != nil {
			return err
		}
		peers = append(peers, wgclient.ApplyPeer{PublicKey: pub, AllowedIP: ip})
	}

	// IP-blocking drops for this server (expanded to per-peer source IPs).
	// A payload failure is non-fatal: the reconcile worker keeps repairing the
	// kernel state, and the server/peer apply below must not be blocked by it.
	ipRules, _, _, ipErr := buildIPBlockPayload(ctx, pool, serverID)
	if ipErr != nil {
		log.Printf("ip-block payload for server %s: %v", serverID, ipErr)
	}

	req := &wgclient.ApplyRequest{
		InterfaceName:  ifaceName,
		ListenPort:     listenPort,
		PrivateKey:     privKey,
		Address:        fmt.Sprintf("%s/%d", gw, maskBits),
		NatCIDR:        cidr,
		DNSEnforcement: true, // local servers share the host with AdGuard
		IPBlockRules:   ipRules,
		Peers:          peers,
	}
	if err := wgclient.Apply(ifaceName, req); err != nil {
		return err
	}

	// Refresh last_handshake_at from the kernel so the UI shows real state.
	if stats, err := wgclient.Stats(ifaceName); err == nil {
		for _, sp := range stats {
			if sp.LastHandshakeAt == "" {
				continue
			}
			if t, err := time.Parse(time.RFC3339, sp.LastHandshakeAt); err == nil {
				_, _ = pool.Exec(ctx, `
					UPDATE peers SET last_handshake_at = $1
					WHERE server_id = $2 AND public_key = $3
				`, t, serverID, sp.PublicKey)
			}
		}
	}

	return nil
}

// Kernel-state sync runs through a per-server coalescing queue — the
// mutation-handler counterpart to RequestDomainRuleSync. Why: handlers used to
// apply the full server state to wg-helper synchronously, before answering. A
// slow kernel apply (many peers, large nftables rule sets) could outlive the
// browser/proxy timeout, so the UI reported "Load failed" for a peer that was
// already committed — and the retry created a duplicate. Handlers now commit,
// answer, and let this queue apply the new state.
//
// Per server there is at most one goroutine; a request arriving while it runs
// sets dirty so exactly one more pass runs. Each pass re-reads the database, so
// the newest committed state always wins over an earlier pass. Removal (server
// delete) is the terminal operation: it runs after the in-flight apply, so a
// delete racing a slow apply can never leave the interface up.
var (
	serverSyncMu   sync.Mutex
	serverSyncJobs = map[uuid.UUID]*serverSyncJob{}
)

type serverSyncJob struct {
	pool     *pgxpool.Pool
	serverID uuid.UUID
	running  bool
	dirty    bool   // a request arrived during the current pass: run one more
	remove   bool   // teardown requested: terminal, no further apply passes
	iface    string // interface to tear down (captured while the row still exists)
}

// requestServerSync queues an async apply of one server's desired state to
// wg-helper. It never blocks on the kernel and never returns an error: the DB
// is re-read when the pass runs, so callers only have to enqueue after commit.
func requestServerSync(pool *pgxpool.Pool, serverID uuid.UUID) {
	serverSyncMu.Lock()
	job := serverSyncJobs[serverID]
	if job != nil && job.remove {
		// Teardown is terminal: a straggler apply for an already-deleted
		// server must not resurrect its interface.
		serverSyncMu.Unlock()
		return
	}
	if job == nil {
		job = &serverSyncJob{pool: pool, serverID: serverID}
		serverSyncJobs[serverID] = job
	}
	job.dirty = true
	start := !job.running
	job.running = true
	serverSyncMu.Unlock()

	if start {
		go runServerSync(job)
	}
}

// requestPeerServerSync resolves a peer's server and queues that server's
// apply, for handlers that know a peer ID but not its server.
func requestPeerServerSync(pool *pgxpool.Pool, peerID uuid.UUID) {
	var serverID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`SELECT server_id FROM peers WHERE id = $1`, peerID).Scan(&serverID); err != nil {
		return // peer already gone: nothing to sync
	}
	requestServerSync(pool, serverID)
}

// requestServerRemoval tears down a deleted server's interface after any
// queued or in-flight apply has finished. Routing the teardown through the
// same per-server queue is what orders it after the apply; calling
// wgclient.Remove directly could tear down the old interface while a stale
// apply was still creating it again.
func requestServerRemoval(serverID uuid.UUID, iface string) {
	serverSyncMu.Lock()
	job := serverSyncJobs[serverID]
	if job == nil {
		job = &serverSyncJob{serverID: serverID}
		serverSyncJobs[serverID] = job
	}
	job.remove = true
	if iface != "" {
		job.iface = iface
	}
	start := !job.running
	job.running = true
	serverSyncMu.Unlock()

	if start {
		go runServerSync(job)
	}
}

func runServerSync(job *serverSyncJob) {
	for {
		serverSyncMu.Lock()
		remove := job.remove
		iface := job.iface
		job.dirty = false
		serverSyncMu.Unlock()

		if remove {
			if iface != "" {
				if err := wgclient.Remove(iface); err != nil {
					log.Printf("wg remove %s: %v", iface, err)
				}
			}
			serverSyncMu.Lock()
			job.running = false
			delete(serverSyncJobs, job.serverID)
			serverSyncMu.Unlock()
			return
		}

		if err := syncServerToKernel(context.Background(), job.pool, job.serverID); err != nil {
			// The server may have been deleted after this pass was queued;
			// there is nothing left to apply then, so it is not a failure.
			if !errors.Is(err, pgx.ErrNoRows) {
				log.Printf("wg sync failed for server %s: %v", job.serverID, err)
			}
		}

		serverSyncMu.Lock()
		if job.remove {
			// A delete landed while the apply was in flight: loop once more
			// so teardown runs after the apply, never before it.
			serverSyncMu.Unlock()
			continue
		}
		if !job.dirty {
			job.running = false
			delete(serverSyncJobs, job.serverID)
			serverSyncMu.Unlock()
			return
		}
		serverSyncMu.Unlock()
	}
}

// SyncAllLocalServersToKernel re-applies the full desired state of every
// active locally-managed server to wg-helper, but ONLY for servers whose
// kernel interface is currently MISSING (e.g. after a host reboot). A server
// whose interface is already up and reporting is left completely untouched —
// re-applying it would force-replace its peers (ReplacePeers) and reset the
// kernel's cumulative rx/tx counters and live handshake state, corrupting
// traffic statistics and briefly dropping every connected client.
//
// Returns the number of servers (re)applied and the first error (if any);
// per-server failures are logged but do not stop the rest.
func SyncAllLocalServersToKernel(pool *pgxpool.Pool) (int, error) {
	if os.Getenv("WG_HELPER_SOCKET") == "" {
		return 0, nil // local development without wg-helper
	}

	ctx := context.Background()
	rows, err := pool.Query(ctx, `
		SELECT id, interface_name FROM servers
		WHERE status = 'active' AND managed_mode = 'local'
		ORDER BY created_at
	`)
	if err != nil {
		return 0, fmt.Errorf("query local servers: %w", err)
	}
	defer rows.Close()

	type serverRef struct {
		id    uuid.UUID
		iface string
	}
	var servers []serverRef
	for rows.Next() {
		var s serverRef
		if err := rows.Scan(&s.id, &s.iface); err != nil {
			return 0, err
		}
		servers = append(servers, s)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	applied := 0
	var firstErr error
	for _, srv := range servers {
		// Probe first: /stats answers 200 only when the interface exists in
		// the kernel. A healthy, running interface is never re-applied (see
		// the doc comment above about ReplacePeers resetting counters).
		if _, err := wgclient.Stats(srv.iface); err == nil {
			continue // interface is up and reporting — leave it alone
		}
		if err := syncServerToKernel(ctx, pool, srv.id); err != nil {
			log.Printf("wg reconcile failed for server %s: %v", srv.id, err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		applied++
	}
	return applied, firstErr
}

// EnsureLocalDNSEnforcement re-applies the DNS enforcement rules for every
// active local server. Called on every reconcile tick: the kernel interface
// can stay up while nftables state is lost (reboot, manual flush, ufw reload,
// partial apply), which would silently re-open the client-DNS bypass.
func EnsureLocalDNSEnforcement(pool *pgxpool.Pool) error {
	if os.Getenv("WG_HELPER_SOCKET") == "" {
		return nil // local development without wg-helper
	}

	ctx := context.Background()
	rows, err := pool.Query(ctx, `
		SELECT interface_name, network_cidr::text FROM servers
		WHERE status = 'active' AND managed_mode = 'local'
		ORDER BY created_at
	`)
	if err != nil {
		return fmt.Errorf("query local servers: %w", err)
	}
	defer rows.Close()

	var firstErr error
	for rows.Next() {
		var iface, cidr string
		if err := rows.Scan(&iface, &cidr); err != nil {
			return err
		}
		if err := wgclient.EnforceDNS(iface, cidr); err != nil {
			log.Printf("dns enforcement failed for %s: %v", iface, err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// EnsureLocalIPBlocking (re)installs the IP-blocking tables for every active
// local server. Called on every reconcile tick: the kernel interface can stay
// up while nftables state is lost (reboot, manual flush, ufw reload, partial
// apply), which would silently drop every IP rule.
func EnsureLocalIPBlocking(pool *pgxpool.Pool) error {
	if os.Getenv("WG_HELPER_SOCKET") == "" {
		return nil // local development without wg-helper
	}

	ipBlockSyncMu.Lock()
	defer ipBlockSyncMu.Unlock()

	ctx := context.Background()
	rows, err := pool.Query(ctx, `
		SELECT id, interface_name, network_cidr::text FROM servers
		WHERE status = 'active' AND managed_mode = 'local'
		ORDER BY created_at
	`)
	if err != nil {
		recordIPBlockSync(err)
		return fmt.Errorf("query local servers: %w", err)
	}
	defer rows.Close()

	var firstErr error
	for rows.Next() {
		var serverID uuid.UUID
		var iface, cidr string
		if err := rows.Scan(&serverID, &iface, &cidr); err != nil {
			recordIPBlockSync(err)
			return err
		}
		entries, _, _, expandErr := buildIPBlockPayload(ctx, pool, serverID)
		if expandErr == nil {
			// dnsEnforcement=true is harmless here (idempotent) and keeps the
			// /enforce contract simple: one call repairs both guards.
			expandErr = wgclient.EnforceGuards(iface, cidr, true, entries)
		}
		recordIPBlockServerResult(serverID, expandErr)
		if expandErr != nil {
			log.Printf("ip-block enforcement failed for %s: %v", iface, expandErr)
			if firstErr == nil {
				firstErr = expandErr
			}
		}
	}
	if err := rows.Err(); err != nil && firstErr == nil {
		firstErr = err
	}
	recordIPBlockSync(firstErr)
	return firstErr
}
