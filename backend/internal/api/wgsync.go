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

// removeServerFromKernel tears down the host interface of a deleted server.
func removeServerFromKernel(ctx context.Context, pool *pgxpool.Pool, serverID uuid.UUID) error {
	var ifaceName string
	if err := pool.QueryRow(ctx, `SELECT interface_name FROM servers WHERE id = $1`, serverID).Scan(&ifaceName); err != nil {
		return err
	}
	return wgclient.Remove(ifaceName)
}
