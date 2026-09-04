package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/db"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// nextAvailableIP returns the first unused host address in the server's
// network CIDR (starting at .2 — .1 is treated as the gateway).
func nextAvailableIP(ctx context.Context, pool *pgxpool.Pool, serverID string) (string, error) {
	var cidr string
	if err := pool.QueryRow(ctx, `SELECT network_cidr::text FROM servers WHERE id = $1`, serverID).Scan(&cidr); err != nil {
		return "", fmt.Errorf("server not found: %w", err)
	}

	_, ipnet, err := net.ParseCIDR(cidr)
	if err != nil {
		return "", fmt.Errorf("invalid server network %q: %w", cidr, err)
	}
	base := ipnet.IP.To4()
	if base == nil {
		return "", fmt.Errorf("peer IP allocation currently supports IPv4 networks only")
	}

	used := map[string]bool{}
	rows, err := pool.Query(ctx, `SELECT host(allowed_ip) FROM peers WHERE server_id = $1`, serverID)
	if err != nil {
		return "", fmt.Errorf("failed to list peers: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var ip string
		if err := rows.Scan(&ip); err != nil {
			return "", fmt.Errorf("failed to scan peer: %w", err)
		}
		used[ip] = true
	}

	// Skip the network address and .1 (gateway), scan to the last host.
	ip := make(net.IP, len(base))
	copy(ip, base)
	ip[3] = 2
	for ip[3] < 255 {
		candidate := ip.String()
		if !used[candidate] {
			return candidate, nil
		}
		ip[3]++
	}
	return "", fmt.Errorf("no free addresses left in %s", cidr)
}

func ListPeers(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		peers := []db.Peer{}
		rows, err := store.pool.Query(ctx, `
			SELECT p.id, p.user_id, p.server_id, p.name, p.public_key, host(p.allowed_ip), 
			       p.status, p.last_handshake_at, p.created_at, p.suspended_at, p.removed_at
			FROM peers p
			ORDER BY p.created_at DESC
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query peers")
			return
		}
		defer rows.Close()

		for rows.Next() {
			var p db.Peer
			if err := rows.Scan(&p.ID, &p.UserID, &p.ServerID, &p.Name, &p.PublicKey,
				&p.AllowedIP, &p.Status, &p.LastHandshakeAt, &p.CreatedAt, &p.SuspendedAt, &p.RemovedAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan peer")
				return
			}
			peers = append(peers, p)
		}

		writeJSON(w, http.StatusOK, peers)
	}
}

func GetPeer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peerID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid peer ID")
			return
		}

		ctx := context.Background()

		var p db.Peer
		err = store.pool.QueryRow(ctx, `
			SELECT id, user_id, server_id, name, public_key, host(allowed_ip), 
			       status, last_handshake_at, created_at, suspended_at, removed_at
			FROM peers
			WHERE id = $1
		`, peerID).Scan(
			&p.ID, &p.UserID, &p.ServerID, &p.Name, &p.PublicKey, &p.AllowedIP,
			&p.Status, &p.LastHandshakeAt, &p.CreatedAt, &p.SuspendedAt, &p.RemovedAt,
		)

		if err != nil {
			writeError(w, http.StatusNotFound, "Peer not found")
			return
		}

		writeJSON(w, http.StatusOK, p)
	}
}

func CreatePeer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			UserID        uuid.UUID `json:"user_id"`
			ServerID      uuid.UUID `json:"server_id"`
			Name          string    `json:"name"`
			PublicKey     string    `json:"public_key"`
			AllowedIP     string    `json:"allowed_ip"`
			PrivateKeyEnc string    `json:"private_key_enc"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if req.Name == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		// The browser shouldn't have to generate keys or pick an IP —
		// generate the peer keypair and allocate the next free address
		// from the server's network when the client doesn't supply them.
		if req.PublicKey == "" {
			k, err := wgtypes.GenerateKey()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to generate peer key")
				return
			}
			req.PublicKey = k.PublicKey().String()

			// Keep the private key (encrypted) so the admin can download a
			// working client config / QR for this peer later. Peers created
			// with an externally supplied key have no private key stored.
			encSvc, err := auth.NewEncryptionService()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Encryption is not configured")
				return
			}
			encPriv, err := encSvc.Encrypt(k.String())
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to encrypt peer key")
				return
			}
			req.PrivateKeyEnc = encPriv
		}
		if req.AllowedIP == "" {
			ip, err := nextAvailableIP(ctx, store.pool, req.ServerID.String())
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			req.AllowedIP = ip
		}

		_, err := store.pool.Exec(ctx, `
			INSERT INTO peers (user_id, server_id, name, public_key, allowed_ip, preshared_key_encrypted, private_key_encrypted, status)
			VALUES ($1, $2, $3, $4, $5, '', $6, 'active')
		`, req.UserID, req.ServerID, req.Name, req.PublicKey, req.AllowedIP, req.PrivateKeyEnc)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create peer")
			return
		}

		logAudit(ctx, store, adminID, "peer.create", "peer", "", nil)

		writeJSON(w, http.StatusCreated, map[string]string{
			"status":     "created",
			"public_key": req.PublicKey,
			"allowed_ip": req.AllowedIP,
		})
	}
}

func UpdatePeer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peerID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid peer ID")
			return
		}

		var req struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		_, err = store.pool.Exec(ctx, `
			UPDATE peers SET name = $1 WHERE id = $2
		`, req.Name, peerID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update peer")
			return
		}

		logAudit(ctx, store, adminID, "peer.update", "peer", peerID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}

func SuspendPeer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peerID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid peer ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)
		now := time.Now()

		_, err = store.pool.Exec(ctx, `
			UPDATE peers SET status = 'suspended', suspended_at = $1 WHERE id = $2
		`, now, peerID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to suspend peer")
			return
		}

		logAudit(ctx, store, adminID, "peer.suspend", "peer", peerID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "suspended"})
	}
}

func ResumePeer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peerID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid peer ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		_, err = store.pool.Exec(ctx, `
			UPDATE peers SET status = 'active', suspended_at = NULL WHERE id = $1
		`, peerID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to resume peer")
			return
		}

		logAudit(ctx, store, adminID, "peer.resume", "peer", peerID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "resumed"})
	}
}

func DeletePeer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peerID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid peer ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)
		now := time.Now()

		_, err = store.pool.Exec(ctx, `
			UPDATE peers SET status = 'removed', removed_at = $1 WHERE id = $2
		`, now, peerID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to remove peer")
			return
		}

		logAudit(ctx, store, adminID, "peer.remove", "peer", peerID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
	}
}

func GetPeerConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peerID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid peer ID")
			return
		}

		ctx := context.Background()

		var peer db.Peer
		var server db.Server
		err = store.pool.QueryRow(ctx, `
			SELECT p.id, p.user_id, p.server_id, p.name, p.public_key, host(p.allowed_ip), 
			       p.status, p.last_handshake_at, p.created_at, p.suspended_at, p.removed_at
			FROM peers p
			WHERE p.id = $1
		`, peerID).Scan(
			&peer.ID, &peer.UserID, &peer.ServerID, &peer.Name, &peer.PublicKey, &peer.AllowedIP,
			&peer.Status, &peer.LastHandshakeAt, &peer.CreatedAt, &peer.SuspendedAt, &peer.RemovedAt,
		)

		if err != nil {
			writeError(w, http.StatusNotFound, "Peer not found")
			return
		}

		err = store.pool.QueryRow(ctx, `
			SELECT id, name, public_endpoint, listen_port, interface_name, server_public_key,
			       network_cidr::text, dns_servers, default_allowed_ips, mtu, persistent_keepalive
			FROM servers
			WHERE id = $1
		`, peer.ServerID).Scan(
			&server.ID, &server.Name, &server.PublicEndpoint, &server.ListenPort, &server.InterfaceName,
			&server.ServerPublicKey, &server.NetworkCIDR, &server.DNSServers, &server.DefaultAllowedIPs,
			&server.MTU, &server.PersistentKeepalive,
		)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to get server")
			return
		}

		// A downloadable client config needs the peer's private key, which
		// is only available for peers created here (generated keys). Peers
		// created with an external key have none stored.
		var privKeyEnc string
		if err := store.pool.QueryRow(ctx, `SELECT private_key_encrypted FROM peers WHERE id = $1`, peerID).Scan(&privKeyEnc); err != nil || privKeyEnc == "" {
			writeError(w, http.StatusConflict, "No private key stored for this peer (it was created with an external key)")
			return
		}
		encSvc, err := auth.NewEncryptionService()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Encryption is not configured")
			return
		}
		privKey, err := encSvc.Decrypt(privKeyEnc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to decrypt peer private key")
			return
		}

		config := generateWireGuardConfig(&peer, &server, privKey)

		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Disposition", "attachment; filename="+peer.Name+".conf")
		w.Write([]byte(config))
	}
}

func generateWireGuardConfig(peer *db.Peer, server *db.Server, privateKey string) string {
	dns := strings.Join(server.DNSServers, ", ")

	config := `[Interface]
PrivateKey = ` + privateKey + `
Address = ` + peer.AllowedIP + `/32
DNS = ` + dns + `

[Peer]
PublicKey = ` + server.ServerPublicKey + `
Endpoint = ` + server.PublicEndpoint + `
AllowedIPs = ` + server.DefaultAllowedIPs + `
PersistentKeepalive = ` + strconv.Itoa(server.PersistentKeepalive) + `
`
	return config
}
