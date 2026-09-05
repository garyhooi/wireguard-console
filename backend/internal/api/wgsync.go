package api

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/google/uuid"
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

	req := &wgclient.ApplyRequest{
		InterfaceName: ifaceName,
		ListenPort:    listenPort,
		PrivateKey:    privKey,
		Address:       fmt.Sprintf("%s/%d", gw, maskBits),
		NatCIDR:       cidr,
		Peers:         peers,
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

// syncServerLogged wraps syncServerToKernel for mutation handlers, logging
// any failure and returning a human-readable warning (optional).
func syncServerLogged(ctx context.Context, pool *pgxpool.Pool, serverID uuid.UUID) string {
	if err := syncServerToKernel(ctx, pool, serverID); err != nil {
		log.Printf("wg sync failed for server %s: %v", serverID, err)
		return fmt.Sprintf("kernel sync: %v", err)
	}
	return ""
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

// removeServerFromKernel tears down the host interface of a deleted server.
func removeServerFromKernel(ctx context.Context, pool *pgxpool.Pool, serverID uuid.UUID) error {
	var ifaceName string
	if err := pool.QueryRow(ctx, `SELECT interface_name FROM servers WHERE id = $1`, serverID).Scan(&ifaceName); err != nil {
		return err
	}
	return wgclient.Remove(ifaceName)
}
