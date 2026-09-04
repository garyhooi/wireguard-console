package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/db"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func ClaimUser(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Token     string `json:"token"`
			FullName  string `json:"full_name"`
			PublicKey string `json:"public_key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()

		// Find pending invite
		var invite struct {
			ID        uuid.UUID
			UserID    uuid.UUID
			ExpiresAt time.Time
		}
		err := store.pool.QueryRow(ctx, `
			SELECT id, user_id, expires_at
			FROM invites
			WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
		`, hashToken(req.Token)).Scan(&invite.ID, &invite.UserID, &invite.ExpiresAt)

		if err != nil {
			writeError(w, http.StatusNotFound, "Invalid or expired invite")
			return
		}

		// Update user status
		now := time.Now()
		_, err = store.pool.Exec(ctx, `
			UPDATE users
			SET status = 'active', activated_at = $1, updated_at = now()
			WHERE id = $2
		`, now, invite.UserID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to activate user")
			return
		}

		// Mark invite as accepted
		_, err = store.pool.Exec(ctx, `
			UPDATE invites SET accepted_at = now() WHERE id = $1
		`, invite.ID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update invite")
			return
		}

		// Generate peer
		peerKey, err := wgtypes.GenerateKey()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate key")
			return
		}

		// Get server and calculate allowed IP
		var server struct {
			ID                  uuid.UUID
			ListenPort          int
			NetworkCIDR         string
			DNSServers          []string
			DefaultAllowedIPs   string
			PublicKey           string
			Endpoint            string
			MTU                 int
			PersistentKeepalive int
		}
		err = store.pool.QueryRow(ctx, `
			SELECT id, listen_port, network_cidr::text, dns_servers, default_allowed_ips,
			       server_public_key, public_endpoint, mtu, persistent_keepalive
			FROM servers
			WHERE status = 'active'
			LIMIT 1
		`).Scan(&server.ID, &server.ListenPort, &server.NetworkCIDR, &server.DNSServers,
			&server.DefaultAllowedIPs, &server.PublicKey, &server.Endpoint, &server.MTU, &server.PersistentKeepalive)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "No active server found")
			return
		}

		// Allocate the next free IP in the server's network.
		allowedIP, err := nextAvailableIP(ctx, store.pool, server.ID.String())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "No free addresses on the server: "+err.Error())
			return
		}

		// Keep the generated private key (encrypted) so the console can
		// re-download this peer's config later.
		encSvc, err := auth.NewEncryptionService()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Encryption is not configured")
			return
		}
		privEnc, err := encSvc.Encrypt(peerKey.String())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to encrypt peer key")
			return
		}

		// Create peer
		peerID := uuid.New()
		_, err = store.pool.Exec(ctx, `
			INSERT INTO peers (id, user_id, server_id, name, public_key, allowed_ip, preshared_key_encrypted, private_key_encrypted, status)
			VALUES ($1, $2, $3, $4, $5, $6, '', $7, 'active')
		`, peerID, invite.UserID, server.ID, req.FullName+"'s Device", peerKey.PublicKey().String(), allowedIP, privEnc)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create peer")
			return
		}

		syncServerLogged(ctx, store.pool, server.ID)

		// Real client config (private key included for immediate import).
		peer := &db.Peer{Name: req.FullName + "'s Device", PublicKey: peerKey.PublicKey().String(), AllowedIP: allowedIP}
		srv := &db.Server{
			PublicEndpoint: server.Endpoint, ListenPort: server.ListenPort,
			ServerPublicKey: server.PublicKey, DNSServers: server.DNSServers,
			DefaultAllowedIPs: server.DefaultAllowedIPs, MTU: server.MTU,
			PersistentKeepalive: server.PersistentKeepalive,
		}
		config := generateWireGuardConfig(peer, srv, peerKey.String())

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"peer_id": peerID.String(),
			"config":  config,
		})
	}
}
