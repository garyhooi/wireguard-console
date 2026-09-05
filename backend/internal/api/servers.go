package api

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/db"
	"github.com/wireguard-console/backend/internal/email"
	"github.com/wireguard-console/backend/internal/wgclient"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func ListServers(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		servers := []db.Server{}
		rows, err := store.pool.Query(ctx, `
			SELECT id, name, public_endpoint, listen_port, interface_name, server_public_key,
			       network_cidr::text, dns_servers, default_allowed_ips, mtu, persistent_keepalive, managed_mode, node_id, status, created_at
			FROM servers
			ORDER BY created_at DESC
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query servers")
			return
		}
		defer rows.Close()

		for rows.Next() {
			var s db.Server
			if err := rows.Scan(&s.ID, &s.Name, &s.PublicEndpoint, &s.ListenPort, &s.InterfaceName,
				&s.ServerPublicKey, &s.NetworkCIDR, &s.DNSServers, &s.DefaultAllowedIPs,
				&s.MTU, &s.PersistentKeepalive, &s.ManagedMode, &s.NodeID, &s.Status, &s.CreatedAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan server")
				return
			}
			servers = append(servers, s)
		}

		writeJSON(w, http.StatusOK, servers)
	}
}

func GetServer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid server ID")
			return
		}

		ctx := context.Background()

		var s db.Server
		err = store.pool.QueryRow(ctx, `
			SELECT id, name, public_endpoint, listen_port, interface_name, server_public_key,
			       network_cidr::text, dns_servers, default_allowed_ips, mtu, persistent_keepalive, status, created_at
			FROM servers
			WHERE id = $1
		`, serverID).Scan(
			&s.ID, &s.Name, &s.PublicEndpoint, &s.ListenPort, &s.InterfaceName,
			&s.ServerPublicKey, &s.NetworkCIDR, &s.DNSServers, &s.DefaultAllowedIPs,
			&s.MTU, &s.PersistentKeepalive, &s.Status, &s.CreatedAt,
		)

		if err != nil {
			writeError(w, http.StatusNotFound, "Server not found")
			return
		}

		writeJSON(w, http.StatusOK, s)
	}
}

func CreateServer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name                string     `json:"name"`
			PublicEndpoint      string     `json:"public_endpoint"`
			ListenPort          int        `json:"listen_port"`
			InterfaceName       string     `json:"interface_name"`
			ServerPublicKey     string     `json:"server_public_key"`
			ServerPrivateKeyEnc string     `json:"server_private_key_enc"`
			NetworkCIDR         string     `json:"network_cidr"`
			DNSServers          []string   `json:"dns_servers"`
			DefaultAllowedIPs   string     `json:"default_allowed_ips"`
			MTU                 int        `json:"mtu"`
			PersistentKeepalive int        `json:"persistent_keepalive"`
			ManagedMode         string     `json:"managed_mode"` // "local" | "remote" (node) | "manual"
			NodeID              *uuid.UUID `json:"node_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		// Defaults so the "just works" path needs only name + endpoint.
		if req.InterfaceName == "" {
			req.InterfaceName = "wg0"
		}
		if req.ListenPort == 0 {
			req.ListenPort = 51820
		}
		if req.NetworkCIDR == "" {
			req.NetworkCIDR = "10.8.0.0/24"
		}
		if len(req.DNSServers) == 0 {
			// Default DNS is the tunnel gateway: AdGuard Home listens there
			// (host), so every peer's queries pass the domain filter.
			gw, _, gerr := gatewayForCIDR(req.NetworkCIDR)
			if gerr == nil {
				req.DNSServers = []string{gw}
			} else {
				req.DNSServers = []string{"1.1.1.1", "8.8.8.8"}
			}
		}
		if req.DefaultAllowedIPs == "" {
			req.DefaultAllowedIPs = "0.0.0.0/0, ::/0"
		}
		if req.MTU == 0 {
			req.MTU = 1420
		}
		if req.PersistentKeepalive == 0 {
			req.PersistentKeepalive = 25
		}
		if req.ManagedMode == "" {
			req.ManagedMode = "local"
		}
		if req.ManagedMode != "local" && req.ManagedMode != "remote" && req.ManagedMode != "manual" {
			writeError(w, http.StatusBadRequest, "managed_mode must be 'local', 'remote' or 'manual'")
			return
		}
		if req.ManagedMode == "remote" && req.NodeID == nil {
			writeError(w, http.StatusBadRequest, "node_id is required for remote mode")
			return
		}
		if req.ManagedMode == "remote" {
			var exists bool
			if err := store.pool.QueryRow(context.Background(),
				`SELECT true FROM nodes WHERE id = $1 AND status = 'active'`, *req.NodeID).Scan(&exists); err != nil {
				writeError(w, http.StatusBadRequest, "node not found or inactive")
				return
			}
		}

		// Generate the server keypair here when the client doesn't supply
		// one — a browser cannot produce the AES-encrypted private key
		// format the database stores. The private key is encrypted with
		// APP_ENCRYPTION_KEY before it is ever persisted.
		if req.ServerPrivateKeyEnc == "" || req.ServerPublicKey == "" {
			priv, err := wgtypes.GeneratePrivateKey()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to generate server keys")
				return
			}
			encSvc, err := auth.NewEncryptionService()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Encryption is not configured")
				return
			}
			encPriv, err := encSvc.Encrypt(priv.String())
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to encrypt server key")
				return
			}
			req.ServerPublicKey = priv.PublicKey().String()
			req.ServerPrivateKeyEnc = encPriv
		}

		var newID uuid.UUID
		err := store.pool.QueryRow(ctx, `
			INSERT INTO servers (name, public_endpoint, listen_port, interface_name, server_public_key,
			                     server_private_key_encrypted, network_cidr, dns_servers, default_allowed_ips,
			                     mtu, persistent_keepalive, managed_mode, node_id, status)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active')
			RETURNING id
		`, req.Name, req.PublicEndpoint, req.ListenPort, req.InterfaceName, req.ServerPublicKey,
			req.ServerPrivateKeyEnc, req.NetworkCIDR, req.DNSServers, req.DefaultAllowedIPs,
			req.MTU, req.PersistentKeepalive, req.ManagedMode, req.NodeID).Scan(&newID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create server")
			return
		}

		logAudit(ctx, store, adminID, "server.create", "server", "", nil)

		// Automatically provision the interface on the host (wg-helper) —
		// unless this server lives on a remote node (manual mode).
		warning := ""
		if req.ManagedMode == "local" {
			warning = syncServerLogged(ctx, store.pool, newID)
		} else if req.ManagedMode == "remote" {
			warning = "assigned to node — the node agent will apply it on its next poll"
		}

		writeJSON(w, http.StatusCreated, map[string]string{
			"status":        "created",
			"managed_mode":  req.ManagedMode,
			"apply_warning": warning,
		})
	}
}

func UpdateServer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid server ID")
			return
		}

		var req struct {
			Name                string   `json:"name"`
			PublicEndpoint      string   `json:"public_endpoint"`
			ListenPort          int      `json:"listen_port"`
			NetworkCIDR         string   `json:"network_cidr"`
			DNSServers          []string `json:"dns_servers"`
			DefaultAllowedIPs   string   `json:"default_allowed_ips"`
			MTU                 int      `json:"mtu"`
			PersistentKeepalive int      `json:"persistent_keepalive"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		_, err = store.pool.Exec(ctx, `
			UPDATE servers 
			SET name = $1, public_endpoint = $2, listen_port = $3, network_cidr = $4,
			    dns_servers = $5, default_allowed_ips = $6, mtu = $7, persistent_keepalive = $8
			WHERE id = $9
		`, req.Name, req.PublicEndpoint, req.ListenPort, req.NetworkCIDR,
			req.DNSServers, req.DefaultAllowedIPs, req.MTU, req.PersistentKeepalive, serverID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update server")
			return
		}

		logAudit(ctx, store, adminID, "server.update", "server", serverID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}

func DeleteServer(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid server ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		var ifaceName string
		if err := store.pool.QueryRow(ctx, `SELECT interface_name FROM servers WHERE id = $1`, serverID).Scan(&ifaceName); err != nil {
			writeError(w, http.StatusNotFound, "Server not found")
			return
		}

		// Remove the server and everything attached to it (peers).
		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete server")
			return
		}
		defer tx.Rollback(ctx)

		if _, err := tx.Exec(ctx, `DELETE FROM peers WHERE server_id = $1`, serverID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete server peers")
			return
		}
		if _, err := tx.Exec(ctx, `DELETE FROM servers WHERE id = $1`, serverID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete server")
			return
		}
		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete server")
			return
		}

		// Tear the interface down on the host (best effort).
		if err := wgclient.Remove(ifaceName); err != nil {
			log.Printf("wg remove %s: %v", ifaceName, err)
		}

		logAudit(ctx, store, adminID, "server.delete", "server", serverID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}

// GetServerHostConfig returns a wg-quick config for the HOST side of a
// server: the server's own interface (decrypted private key, gateway
// address, listen port) plus every active peer, and the one-time NAT
// command required for client internet access.
func GetServerHostConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid server ID")
			return
		}

		ctx := context.Background()

		var (
			ifaceName      string
			endpoint       string
			listenPort     int
			serverPub      string
			privEnc        string
			cidr           string
			defaultAllowed string
		)
		err = store.pool.QueryRow(ctx, `
			SELECT interface_name, public_endpoint, listen_port, server_public_key,
			       server_private_key_encrypted, network_cidr::text, default_allowed_ips
			FROM servers WHERE id = $1
		`, serverID).Scan(&ifaceName, &endpoint, &listenPort, &serverPub, &privEnc, &cidr, &defaultAllowed)
		if err != nil {
			writeError(w, http.StatusNotFound, "Server not found")
			return
		}
		if privEnc == "" {
			writeError(w, http.StatusConflict, "No server private key stored")
			return
		}
		encSvc, err := auth.NewEncryptionService()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Encryption is not configured")
			return
		}
		privKey, err := encSvc.Decrypt(privEnc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to decrypt server key")
			return
		}

		// Gateway = first host address in the server's network.
		ip, maskBits, err := gatewayForCIDR(cidr)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Invalid server network: "+err.Error())
			return
		}

		var sb strings.Builder
		sb.WriteString("[Interface]\n")
		sb.WriteString("Address = " + ip + "/" + strconv.Itoa(maskBits) + "\n")
		sb.WriteString("ListenPort = " + strconv.Itoa(listenPort) + "\n")
		sb.WriteString("PrivateKey = " + privKey + "\n\n")
		sb.WriteString("# One-time NAT rule so clients can reach the internet:\n")
		sb.WriteString("#   sudo iptables -t nat -A POSTROUTING -s " + cidr + " -o eth0 -j MASQUERADE\n")
		sb.WriteString("#   (make it persistent: sudo apt install -y iptables-persistent && sudo netfilter-persistent save)\n")
		sb.WriteString("# ip_forward is enabled by the installer; verify: sysctl net.ipv4.ip_forward\n\n")

		rows, err := store.pool.Query(ctx, `
			SELECT host(allowed_ip), public_key FROM peers
			WHERE server_id = $1 AND status = 'active'
			ORDER BY allowed_ip
		`, serverID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to list peers")
			return
		}
		defer rows.Close()
		for rows.Next() {
			var peerIP, peerPub string
			if err := rows.Scan(&peerIP, &peerPub); err != nil {
				continue
			}
			sb.WriteString("[Peer]\n")
			sb.WriteString("PublicKey = " + peerPub + "\n")
			sb.WriteString("AllowedIPs = " + peerIP + "/32\n\n")
		}

		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Disposition", "attachment; filename="+ifaceName+".conf")
		w.Write([]byte(sb.String()))
	}
}

// gatewayForCIDR returns the first host address and mask bits of an IPv4
// CIDR (base+1, so .1 for a /24).
func gatewayForCIDR(cidr string) (string, int, error) {
	_, ipnet, err := net.ParseCIDR(cidr)
	if err != nil {
		return "", 0, err
	}
	ones, _ := ipnet.Mask.Size()
	base := ipnet.IP.To4()
	if base == nil {
		return "", 0, fmt.Errorf("IPv4 networks only")
	}
	base[3]++
	return base.String(), ones, nil
}

func GetServerStatus(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid server ID")
			return
		}

		ctx := context.Background()

		var peerCount int
		store.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM peers WHERE server_id = $1 AND status = 'active'
		`, serverID).Scan(&peerCount)

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"server_id":    serverID,
			"active_peers": peerCount,
			"status":       "healthy",
		})
	}
}

func ListAdmins(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		rows, err := store.pool.Query(ctx, `
			SELECT id, email, role, totp_enabled, status, created_at
			FROM admins
			ORDER BY created_at DESC
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query admins")
			return
		}
		defer rows.Close()

		admins := []map[string]interface{}{}
		for rows.Next() {
			var (
				id          uuid.UUID
				email       string
				role        string
				totpEnabled bool
				status      string
				createdAt   time.Time
			)
			if err := rows.Scan(&id, &email, &role, &totpEnabled, &status, &createdAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan admin")
				return
			}
			admins = append(admins, map[string]interface{}{
				"id": id.String(), "email": email, "role": role,
				"totp_enabled": totpEnabled, "status": status,
				"created_at": createdAt.UTC().Format(time.RFC3339),
			})
		}

		writeJSON(w, http.StatusOK, admins)
	}
}

func InviteAdmin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		if req.Role == "" {
			req.Role = "admin"
		}
		if req.Role != "super_admin" && req.Role != "admin" && req.Role != "auditor" {
			writeError(w, http.StatusBadRequest, "role must be super_admin, admin or auditor")
			return
		}

		// Generate initial credentials: the invited admin changes the
		// password after first login (Profile -> Change password).
		initialPassword := randomPassword(16)
		passwordHash := hashPassword(initialPassword)

		ctx := context.Background()
		adminID := getAdminID(r)

		_, err := store.pool.Exec(ctx, `
			INSERT INTO admins (email, password_hash, role, status)
			VALUES ($1, $2, $3, 'active')
		`, req.Email, passwordHash, req.Role)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to invite admin")
			return
		}

		logAudit(ctx, store, adminID, "admin.invite", "admin", "", nil)

		// Email the initial credentials (silent without SMTP, like invites).
		subject, body := loadEmailTemplate(ctx, store.pool, "admin_invite",
			"You've been invited to manage WireGuard Console",
			"Login at {{console_url}} with email {{email}} and the temporary password {{password}}, then change it in Profile.")
		vars := map[string]string{
			"console_url": "https://" + domainFromEnv(),
			"email":       req.Email,
			"password":    initialPassword,
		}
		subject = renderTemplate(subject, vars)
		body = renderTemplate(body, vars)
		queue := email.NewQueue(store.pool, nil)
		_ = queue.EnqueueRenderedEmail(ctx, req.Email, subject, body)

		writeJSON(w, http.StatusCreated, map[string]string{"status": "invited"})
	}
}

// randomPassword returns a printable 16-char password.
func randomPassword(n int) string {
	const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%"
	b, _ := randBytes(n)
	out := make([]byte, n)
	for i := range out {
		out[i] = chars[int(b[i])%len(chars)]
	}
	return string(out)
}

func randBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	_, err := rand.Read(b)
	return b, err
}

func domainFromEnv() string {
	d := strings.TrimPrefix(strings.TrimPrefix(os.Getenv("CONSOLE_DOMAIN"), "https://"), "http://")
	return d
}

func GetAdmin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin ID")
			return
		}

		ctx := context.Background()

		var (
			a struct {
				ID          uuid.UUID `json:"id"`
				Email       string    `json:"email"`
				Role        string    `json:"role"`
				TOTPEnabled bool      `json:"totp_enabled"`
				Status      string    `json:"status"`
			}
			createdAt time.Time
		)
		err = store.pool.QueryRow(ctx, `
			SELECT id, email, role, totp_enabled, status, created_at
			FROM admins
			WHERE id = $1
		`, adminID).Scan(&a.ID, &a.Email, &a.Role, &a.TOTPEnabled, &a.Status, &createdAt)

		if err != nil {
			writeError(w, http.StatusNotFound, "Admin not found")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"id": a.ID.String(), "email": a.Email, "role": a.Role,
			"totp_enabled": a.TOTPEnabled, "status": a.Status,
			"created_at": createdAt.UTC().Format(time.RFC3339),
		})
	}
}

func UpdateAdmin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin ID")
			return
		}

		var req struct {
			Email  string `json:"email"`
			Role   string `json:"role"`
			Status string `json:"status"`
			Code   string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		actorID := getAdminID(r)
		isSelf := adminID == actorID

		// Changing an admin's email, role or status is a privileged action:
		// the acting admin must confirm with their own 2FA code (step-up).
		// A no-op PATCH (nothing to change) is allowed through untouched so
		// the UI can send the current values safely.
		if req.Email != "" || req.Role != "" || req.Status != "" {
			if !verifyActor2FA(w, ctx, store, actorID, req.Code) {
				return
			}
		}

		// The current admin may not disable themselves (would lock everyone out).
		if req.Status == "disabled" && isSelf {
			writeError(w, http.StatusBadRequest, "You cannot disable your own account")
			return
		}

		// Load the row being edited so defaults and role invariants below can
		// be evaluated against its current state (email and role changes are
		// optional, partial updates).
		var cur struct {
			email  string
			role   string
			status string
		}
		if err := store.pool.QueryRow(ctx, `
			SELECT email, role, status FROM admins WHERE id = $1
		`, adminID).Scan(&cur.email, &cur.role, &cur.status); err != nil {
			writeError(w, http.StatusNotFound, "Admin not found")
			return
		}

		// Role updates are validated up-front so the "last super_admin" guard
		// below can reason about the target role reliably.
		if req.Role != "" && req.Role != "super_admin" && req.Role != "admin" && req.Role != "auditor" {
			writeError(w, http.StatusBadRequest, "role must be super_admin, admin or auditor")
			return
		}

		// Resolve effective values: absent fields keep the current value.
		newRole := req.Role
		if newRole == "" {
			newRole = cur.role
		}
		newStatus := req.Status
		if newStatus == "" {
			newStatus = cur.status
		}
		if newStatus != "active" && newStatus != "disabled" {
			writeError(w, http.StatusBadRequest, "status must be 'active' or 'disabled'")
			return
		}

		// A super_admin cannot demote themselves — that would leave the
		// account able to edit but no longer able to restore its own role,
		// and an accidental self-demotion while they are the only super_admin
		// would lock everyone out of admin management entirely.
		if isSelf && cur.role == "super_admin" && newRole != "super_admin" {
			writeError(w, http.StatusBadRequest, "You cannot change your own role")
			return
		}

		// If this is the last active super_admin, it may not be demoted or
		// disabled (that would permanently lock admin management).
		if cur.role == "super_admin" && (newRole != "super_admin" || newStatus == "disabled") {
			var others int
			if err := store.pool.QueryRow(ctx, `
				SELECT COUNT(*) FROM admins
				WHERE role = 'super_admin' AND status = 'active' AND id <> $1
			`, adminID).Scan(&others); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to check super_admin count")
				return
			}
			if others == 0 {
				writeError(w, http.StatusBadRequest, "Cannot demote or disable the last active super_admin")
				return
			}
		}

		// Email change: reject blanks, duplicates, and identity changes on a
		// disabled target (a disabled admin must not be reachable by a new
		// email, and reviving them is a separate action).
		newEmail := req.Email
		if req.Email != "" && req.Email != cur.email {
			if newStatus == "disabled" {
				writeError(w, http.StatusBadRequest, "Cannot change the email of a disabled admin")
				return
			}
			var taken uuid.UUID
			err := store.pool.QueryRow(ctx, `
				SELECT id FROM admins WHERE email = $1 AND id <> $2
			`, req.Email, adminID).Scan(&taken)
			if err == nil {
				writeError(w, http.StatusConflict, "An admin with this email already exists")
				return
			} else if err != pgx.ErrNoRows {
				writeError(w, http.StatusInternalServerError, "Failed to check email availability")
				return
			}
		} else {
			// Absent/empty email means "leave unchanged" — never blank it.
			newEmail = cur.email
		}

		_, err = store.pool.Exec(ctx, `
			UPDATE admins SET email = $1, role = $2, status = $3, updated_at = now()
			WHERE id = $4
		`, newEmail, newRole, newStatus, adminID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update admin")
			return
		}

		// Record what actually changed for the audit trail.
		meta := map[string]string{}
		if req.Email != "" && req.Email != cur.email {
			meta["email"] = req.Email
		}
		if newRole != cur.role {
			meta["role"] = newRole
		}
		if newStatus != cur.status {
			meta["status"] = newStatus
		}
		if len(meta) > 0 {
			logAudit(ctx, store, actorID, "admin.update", "admin", adminID.String(), meta)

			// Role/email/status changed: revoke the target admin's sessions
			// so the new state applies immediately. When the actor edited
			// themselves the current (2FA-confirmed) session survives.
			if isSelf {
				if err := revokeAdminSessionsExcept(ctx, store, adminID, currentSessionTokenHash(r)); err != nil {
					log.Printf("Failed to revoke other sessions after self admin.update: admin_id=%s, err=%v", adminID, err)
				}
			} else {
				if err := revokeAdminSessions(ctx, store, adminID); err != nil {
					log.Printf("Failed to revoke sessions after admin.update: admin_id=%s, err=%v", adminID, err)
				}
			}
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}

// ResetAdminPassword issues a new temporary password for an admin
// (emailed when SMTP is configured; always returned once for manual share).
// The acting super_admin must confirm with their own 2FA code.
func ResetAdminPassword(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin ID")
			return
		}
		ctx := context.Background()
		actorID := getAdminID(r)

		// Resetting someone's password is a privileged action: require the
		// actor's own 2FA code (step-up) before issuing a new password.
		var req stepUpRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if !verifyActor2FA(w, ctx, store, actorID, req.Code) {
			return
		}

		newPassword := randomPassword(16)
		if _, err := store.pool.Exec(ctx, `
			UPDATE admins SET password_hash = $1, updated_at = now() WHERE id = $2
		`, hashPassword(newPassword), adminID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to reset password")
			return
		}

		// The target's credentials changed under them: revoke every session
		// so they must sign in again with the new temporary password.
		if err := revokeAdminSessions(ctx, store, adminID); err != nil {
			log.Printf("Failed to revoke sessions after password reset: admin_id=%s, err=%v", adminID, err)
		}

		var adminEmail string
		store.pool.QueryRow(ctx, `SELECT email FROM admins WHERE id = $1`, adminID).Scan(&adminEmail)

		subject, body := loadEmailTemplate(ctx, store.pool, "admin_invite",
			"WireGuard Console: temporary password",
			"Login at {{console_url}} with {{email}} and password {{password}}.")
		vars := map[string]string{"console_url": "https://" + domainFromEnv(), "email": adminEmail, "password": newPassword}
		queue := email.NewQueue(store.pool, nil)
		if adminEmail != "" {
			_ = queue.EnqueueRenderedEmail(ctx, adminEmail, renderTemplate(subject, vars), renderTemplate(body, vars))
		}

		logAudit(ctx, store, actorID, "admin.reset_password", "admin", adminID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "reset", "password": newPassword})
	}
}

func DeleteAdmin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin ID")
			return
		}

		ctx := context.Background()
		actorID := getAdminID(r)

		_, err = store.pool.Exec(ctx, `
			UPDATE admins SET status = 'disabled', updated_at = now() WHERE id = $1
		`, adminID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete admin")
			return
		}

		// Disabled admin: kill their live sessions so the state applies now.
		if err := revokeAdminSessions(ctx, store, adminID); err != nil {
			log.Printf("Failed to revoke sessions after admin delete: admin_id=%s, err=%v", adminID, err)
		}

		logAudit(ctx, store, actorID, "admin.delete", "admin", adminID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}
