package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/db"
	"github.com/wireguard-console/backend/internal/email"
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

// normalizePeerCreateRequestID trims an optional idempotency key and rejects
// over-long values: the column is unbounded TEXT, but an unbounded key would
// bloat the unique index and every replay lookup.
func normalizePeerCreateRequestID(raw string) (string, bool) {
	id := strings.TrimSpace(raw)
	if len(id) > 128 {
		return "", false
	}
	return id, true
}

// peerCreateReplay finds the peer created with an idempotency key. Request-id
// replays and lost insert races both resolve to this row instead of creating
// (or failing) a duplicate.
func peerCreateReplay(ctx context.Context, pool *pgxpool.Pool, requestID string) (publicKey, allowedIP string, found bool, err error) {
	err = pool.QueryRow(ctx, `
		SELECT public_key, host(allowed_ip) FROM peers WHERE create_request_id = $1
	`, requestID).Scan(&publicKey, &allowedIP)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return publicKey, allowedIP, true, nil
}

// writePeerCreateReplay is the idempotent success response for a retried
// create: same fields the frontend needs, status "exists" (200 instead of the
// original 201) so a retry after a network timeout is a no-op.
func writePeerCreateReplay(w http.ResponseWriter, publicKey, allowedIP string) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":     "exists",
		"public_key": publicKey,
		"allowed_ip": allowedIP,
	})
}

func ListPeers(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		rows, err := store.pool.Query(ctx, `
			SELECT p.id, p.user_id, p.server_id, p.name, p.public_key, host(p.allowed_ip),
			       p.status, p.last_handshake_at, p.created_at, p.suspended_at, p.removed_at,
			       COALESCE(u.email, ''), COALESCE(u.full_name, ''), COALESCE(d.name, ''),
			       COALESCE(s.name, '')
			FROM peers p
			LEFT JOIN users u ON u.id = p.user_id
			LEFT JOIN departments d ON d.id = u.department_id
			LEFT JOIN servers s ON s.id = p.server_id
			ORDER BY p.created_at DESC
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query peers")
			return
		}
		defer rows.Close()

		type peerRow struct {
			db.Peer
			UserEmail          string `json:"user_email"`
			UserFullName       string `json:"user_full_name"`
			UserDepartmentName string `json:"user_department_name"`
			ServerName         string `json:"server_name"`
		}
		peers := []peerRow{}
		for rows.Next() {
			var pr peerRow
			if err := rows.Scan(&pr.ID, &pr.UserID, &pr.ServerID, &pr.Name, &pr.PublicKey,
				&pr.AllowedIP, &pr.Status, &pr.LastHandshakeAt, &pr.CreatedAt, &pr.SuspendedAt, &pr.RemovedAt,
				&pr.UserEmail, &pr.UserFullName, &pr.UserDepartmentName, &pr.ServerName); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan peer")
				return
			}
			peers = append(peers, pr)
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
			SendEmail     bool      `json:"send_email"`
			// Optional idempotency key: a create retried after a network
			// timeout (the browser saw "Load failed" although the peer was
			// committed) replays the original result instead of inserting a
			// duplicate peer.
			RequestID string `json:"request_id"`
		}
		var generatedPrivKey string
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if req.Name == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		requestID, ok := normalizePeerCreateRequestID(req.RequestID)
		if !ok {
			writeError(w, http.StatusBadRequest, "request_id must be at most 128 characters")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		// A replay of an already-committed create (see create_request_id in
		// migration 027) must not insert or email again — just report the
		// original peer so the client can treat the retry as a success.
		if requestID != "" {
			if publicKey, allowedIP, found, err := peerCreateReplay(ctx, store.pool, requestID); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to check request_id")
				return
			} else if found {
				writePeerCreateReplay(w, publicKey, allowedIP)
				return
			}
		}

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
			generatedPrivKey = k.String()
		}
		if req.AllowedIP == "" {
			ip, err := nextAvailableIP(ctx, store.pool, req.ServerID.String())
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			req.AllowedIP = ip
		}

		// NULL (not "") when no idempotency key was sent: the partial unique
		// index only covers non-NULL ids, so legacy creates never collide.
		var createRequestID any
		if requestID != "" {
			createRequestID = requestID
		}

		var newID uuid.UUID
		err := store.pool.QueryRow(ctx, `
			INSERT INTO peers (user_id, server_id, name, public_key, allowed_ip, preshared_key_encrypted, private_key_encrypted, create_request_id, status)
			VALUES ($1, $2, $3, $4, $5, '', $6, $7, 'active')
			RETURNING id
		`, req.UserID, req.ServerID, req.Name, req.PublicKey, req.AllowedIP, req.PrivateKeyEnc, createRequestID).Scan(&newID)

		if err != nil {
			// Two overlapping creates with the same request_id race on the
			// partial unique index; the winner's row is the one the caller
			// must see. Re-select instead of failing a request that actually
			// succeeded — a retried POST must be idempotent even when both
			// attempts overlap. Any other unique violation (or no key) is a
			// real create failure.
			var pgErr *pgconn.PgError
			if requestID != "" && errors.As(err, &pgErr) && pgErr.Code == "23505" {
				if publicKey, allowedIP, found, lookupErr := peerCreateReplay(ctx, store.pool, requestID); lookupErr == nil && found {
					writePeerCreateReplay(w, publicKey, allowedIP)
					return
				}
			}
			writeError(w, http.StatusInternalServerError, "Failed to create peer")
			return
		}

		logAudit(ctx, store, adminID, "peer.create", "peer", newID.String(), nil)

		// Kernel apply is queued, not awaited: the row is committed, so the
		// client must get its 201 even when wg-helper is slow (a browser or
		// proxy timeout here made a successful create look like a failure).
		requestServerSync(store.pool, req.ServerID)

		// Optionally email the user a secure link to their config (needs the
		// generated private key + configured SMTP). The email contains a
		// claim-style URL, never the config/private key itself — the link
		// opens a page where the user downloads the .conf or scans a QR.
		configLink := ""
		if req.SendEmail && generatedPrivKey != "" {
			token, err := generateToken()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to generate access token")
				return
			}
			policy := loadInvitePolicy(ctx, store.pool)
			expiresAt := time.Now().Add(policy.PeerClaim)
			if _, err := store.pool.Exec(ctx, `
				INSERT INTO peer_access_tokens (token_hash, peer_id, expires_at)
				VALUES ($1, $2, $3)
			`, hashToken(token), newID, expiresAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to create access link")
				return
			}
			configLink = configLinkURL(token)
			sendPeerConfigLinkEmail(ctx, store, req.UserID, req.Name, configLink)
		}

		// A new peer adds a $client= expansion for user-scoped rules.
		RequestDomainRuleSync(store)

		writeJSON(w, http.StatusCreated, map[string]string{
			"status":        "created",
			"public_key":    req.PublicKey,
			"allowed_ip":    req.AllowedIP,
			"apply_warning": "",
			"config_link":   configLink,
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

		requestPeerServerSync(store.pool, peerID)

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "apply_warning": ""})
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

		requestPeerServerSync(store.pool, peerID)
		RequestDomainRuleSync(store) // drop this peer's $client= rules

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

		requestPeerServerSync(store.pool, peerID)
		RequestDomainRuleSync(store) // re-add this peer's $client= rules

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

		requestPeerServerSync(store.pool, peerID)
		RequestDomainRuleSync(store) // drop this peer's $client= rules

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
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", configFileName(peer.Name)))
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

// ResendPeerConfigEmail re-issues the config-link email for an existing
// peer. The original email may have failed on an SMTP hiccup or been lost
// — resending mints a fresh 72h link (old links stay valid) and emails the
// owning user again. Only peers with a stored (generated) private key can
// be re-emailed, since the link page must serve a real client config.
func ResendPeerConfigEmail(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peerID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid peer ID")
			return
		}
		ctx := context.Background()
		adminID := getAdminID(r)

		var userID uuid.UUID
		var peerName string
		if err := store.pool.QueryRow(ctx, `
			SELECT user_id, name FROM peers WHERE id = $1
		`, peerID).Scan(&userID, &peerName); err != nil {
			writeError(w, http.StatusNotFound, "Peer not found")
			return
		}

		configLink, _, err := issuePeerAccessLink(ctx, store.pool, peerID)
		if err != nil {
			if err == errPeerNotActive {
				writeError(w, http.StatusConflict, errPeerNotActive.Error())
			} else if err == errNoPrivateKey {
				writeError(w, http.StatusConflict, errNoPrivateKey.Error())
			} else {
				writeError(w, http.StatusInternalServerError, "Failed to create access link")
			}
			return
		}

		sendPeerConfigLinkEmail(ctx, store, userID, peerName, configLink)

		logAudit(ctx, store, adminID, "peer.config_email.resend", "peer", peerID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{
			"status":      "resent",
			"config_link": configLink,
		})
	}
}

// sendPeerConfigLinkEmail emails the user a secure link to their peer's
// config page (download .conf / scan QR). The email never contains the
// config or private key. Silent when SMTP is not configured.
func sendPeerConfigLinkEmail(ctx context.Context, store *Store, userID uuid.UUID, peerName, configLink string) {
	cfg := email.LoadConfig(ctx, store.pool)
	if cfg.Host == "" {
		return
	}

	var userEmail, fullName string
	if err := store.pool.QueryRow(ctx,
		`SELECT email, COALESCE(full_name, '') FROM users WHERE id = $1`, userID).Scan(&userEmail, &fullName); err != nil {
		return
	}

	subject, body := loadEmailTemplate(ctx, store.pool, "peer_config",
		"Your WireGuard configuration is ready",
		"Hello {{full_name}}, your peer {{peer_name}} is ready. Open {{config_link}} to download the config or scan the QR code.")
	vars := map[string]string{"full_name": fullName, "peer_name": peerName, "config_link": configLink}
	subject = renderTemplate(subject, vars)
	body = renderTemplate(body, vars)

	queue := email.NewQueue(store.pool, nil)
	if err := queue.EnqueueRenderedEmail(ctx, userEmail, subject, body); err != nil {
		log.Printf("Failed to enqueue peer config email: %v", err)
	}
}
