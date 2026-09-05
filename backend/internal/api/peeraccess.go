package api

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/db"
)

// Peer access links give a VPN user a way to fetch their own .conf / scan
// their QR without the console ever emailing the private key. The link
// embeds a random bearer token whose sha256 hash is stored (same pattern as
// user invite tokens). Links expire after peerAccessLinkTTL.
const peerAccessLinkTTL = 72 * time.Hour

// configLinkURL builds the public peer-config URL for a raw token.
func configLinkURL(token string) string {
	domain := strings.TrimPrefix(strings.TrimPrefix(os.Getenv("CONSOLE_DOMAIN"), "https://"), "http://")
	return "https://" + domain + "/peer/" + token
}

// issuePeerAccessLink mints a fresh 72h access link for a peer and returns
// the public URL. The peer must exist, be active, and have a stored
// (generated) private key — that is what lets the link page serve a real
// client config. Repeated calls are fine: each returns a new token and old
// ones stay valid until they expire.
func issuePeerAccessLink(ctx context.Context, pool *pgxpool.Pool, peerID uuid.UUID) (string, error) {
	var privEnc string
	var status string
	err := pool.QueryRow(ctx,
		`SELECT private_key_encrypted, status FROM peers WHERE id = $1`, peerID).
		Scan(&privEnc, &status)
	if err != nil {
		return "", err
	}
	if status != "active" {
		return "", errPeerNotActive
	}
	if privEnc == "" {
		return "", errNoPrivateKey
	}

	token, err := generateToken()
	if err != nil {
		return "", err
	}

	expiresAt := time.Now().Add(peerAccessLinkTTL)
	if _, err := pool.Exec(ctx, `
		INSERT INTO peer_access_tokens (token_hash, peer_id, expires_at)
		VALUES ($1, $2, $3)
	`, hashToken(token), peerID, expiresAt); err != nil {
		return "", err
	}
	return configLinkURL(token), nil
}

var (
	errPeerNotActive = fmt.Errorf("peer is not active")
	errNoPrivateKey  = fmt.Errorf("no private key stored for this peer (it was created with an external key)")
)

// CreatePeerAccessLink issues a fresh access link for a peer. Only peers
// that have a stored (generated) private key can produce a client config,
// so that is required. Repeated calls are fine — each returns a new token
// and the old ones stay valid until they expire.
func CreatePeerAccessLink(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peerID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid peer ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		configLink, err := issuePeerAccessLink(ctx, store.pool, peerID)
		if err != nil {
			if err == errPeerNotActive {
				writeError(w, http.StatusConflict, errPeerNotActive.Error())
			} else if err == errNoPrivateKey {
				writeError(w, http.StatusConflict, errNoPrivateKey.Error())
			} else {
				writeError(w, http.StatusNotFound, "Peer not found")
			}
			return
		}

		logAudit(ctx, store, adminID, "peer.access_link.create", "peer", peerID.String(), nil)

		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"config_link":      configLink,
			"expires_in_hours": int(peerAccessLinkTTL.Hours()),
		})
	}
}

// GetPeerConfigByToken is the PUBLIC endpoint behind a peer access link.
// It resolves the token to its peer and returns the client config as JSON
// so the frontend can offer Download .conf + Scan QR. The token is only
// valid while the peer is active and the link is unexpired.
func GetPeerConfigByToken(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("token")
		if token == "" {
			writeError(w, http.StatusBadRequest, "Missing token")
			return
		}

		ctx := context.Background()

		var peerID uuid.UUID
		err := store.pool.QueryRow(ctx, `
			SELECT t.peer_id
			FROM peer_access_tokens t
			JOIN peers p ON p.id = t.peer_id
			WHERE t.token_hash = $1
			  AND t.expires_at > now()
			  AND p.status = 'active'
		`, hashToken(token)).Scan(&peerID)
		if err != nil {
			writeError(w, http.StatusNotFound, "Link is invalid or has expired")
			return
		}

		config, peerName, err := peerConfigPayload(ctx, store, peerID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"peer_name": peerName,
			"config":    config,
		})
	}
}

// peerConfigPayload builds the ready-to-import client config for a peer,
// returning it alongside the peer name. Used by both the admin config
// endpoint and the public access-link endpoint.
func peerConfigPayload(ctx context.Context, store *Store, peerID uuid.UUID) (config, peerName string, err error) {
	var peer db.Peer
	var server db.Server
	e := store.pool.QueryRow(ctx, `
		SELECT p.id, p.user_id, p.server_id, p.name, p.public_key, host(p.allowed_ip),
		       p.status, p.last_handshake_at, p.created_at, p.suspended_at, p.removed_at
		FROM peers p
		WHERE p.id = $1
	`, peerID).Scan(
		&peer.ID, &peer.UserID, &peer.ServerID, &peer.Name, &peer.PublicKey, &peer.AllowedIP,
		&peer.Status, &peer.LastHandshakeAt, &peer.CreatedAt, &peer.SuspendedAt, &peer.RemovedAt,
	)
	if e != nil {
		return "", "", fmt.Errorf("peer lookup: %w", e)
	}
	e = store.pool.QueryRow(ctx, `
		SELECT id, name, public_endpoint, listen_port, interface_name, server_public_key,
		       network_cidr::text, dns_servers, default_allowed_ips, mtu, persistent_keepalive
		FROM servers
		WHERE id = $1
	`, peer.ServerID).Scan(
		&server.ID, &server.Name, &server.PublicEndpoint, &server.ListenPort, &server.InterfaceName,
		&server.ServerPublicKey, &server.NetworkCIDR, &server.DNSServers, &server.DefaultAllowedIPs,
		&server.MTU, &server.PersistentKeepalive,
	)
	if e != nil {
		return "", "", fmt.Errorf("server lookup: %w", e)
	}

	var privEnc string
	if e := store.pool.QueryRow(ctx,
		`SELECT private_key_encrypted FROM peers WHERE id = $1`, peerID).Scan(&privEnc); e != nil || privEnc == "" {
		return "", "", fmt.Errorf("no private key stored for this peer (it was created with an external key)")
	}
	encSvc, e := auth.NewEncryptionService()
	if e != nil {
		return "", "", fmt.Errorf("encryption is not configured")
	}
	privKey, e := encSvc.Decrypt(privEnc)
	if e != nil {
		return "", "", fmt.Errorf("failed to decrypt peer private key")
	}

	return generateWireGuardConfig(&peer, &server, privKey), peer.Name, nil
}
