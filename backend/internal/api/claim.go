package api

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
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
		var server serverInfo
		err = store.pool.QueryRow(ctx, `
			SELECT id, listen_port, network_cidr::text, dns_servers, default_allowed_ips, server_public_key, public_endpoint
			FROM servers
			WHERE status = 'active'
			LIMIT 1
		`).Scan(&server.ID, &server.ListenPort, &server.NetworkCIDR, &server.DNSServers, &server.DefaultAllowedIPs, &server.PublicKey, &server.Endpoint)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "No active server found")
			return
		}

		// Generate random allowed IP in the server's network
		allowedIP := generateAllowedIP(server.NetworkCIDR)

		// Create peer
		peerID := uuid.New()
		_, err = store.pool.Exec(ctx, `
			INSERT INTO peers (id, user_id, server_id, name, public_key, allowed_ip, preshared_key_encrypted, status)
			VALUES ($1, $2, $3, $4, $5, $6, '', 'active')
		`, peerID, invite.UserID, server.ID, req.FullName+"'s Device", peerKey.PublicKey().String(), allowedIP)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create peer")
			return
		}

		syncServerLogged(ctx, store.pool, server.ID)

		// Generate WireGuard config
		config := generatePeerConfig(peerKey, server, allowedIP)

		// Generate QR code
		qrCodeURL := generateQRCode(config)

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"peer_id":     peerID.String(),
			"config":      config,
			"qr_code_url": qrCodeURL,
		})
	}
}

func generateAllowedIP(networkCIDR string) string {
	// Simple IP generation - in production, track assigned IPs
	b := make([]byte, 4)
	rand.Read(b)
	return "10.10.0." + string(rune(b[0]%254+2)) + "/32"
}

type serverInfo struct {
	ID                uuid.UUID
	ListenPort        int
	NetworkCIDR       string
	DNSServers        []string
	DefaultAllowedIPs string
	PublicKey         string
	Endpoint          string
}

func generatePeerConfig(key wgtypes.Key, server serverInfo, allowedIP string) string {
	return "[Interface]\n" +
		"PrivateKey = [CLIENT_PRIVATE_KEY]\n" +
		"Address = " + allowedIP + "\n" +
		"DNS = " + joinStrings(server.DNSServers, ",") + "\n\n" +
		"[Peer]\n" +
		"PublicKey = " + server.PublicKey + "\n" +
		"Endpoint = " + server.Endpoint + ":" + fmt.Sprintf("%d", server.ListenPort) + "\n" +
		"AllowedIPs = " + server.DefaultAllowedIPs + "\n" +
		"PersistentKeepalive = 25\n"
}

func generateQRCode(config string) string {
	// In production, use a QR code library to generate actual QR code
	// For now, return a placeholder
	return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
}

func joinStrings(strs []string, sep string) string {
	result := ""
	for i, s := range strs {
		if i > 0 {
			result += sep
		}
		result += s
	}
	return result
}
