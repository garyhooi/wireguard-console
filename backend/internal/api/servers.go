package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/db"
	"github.com/wireguard-console/backend/internal/wgclient"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func ListServers(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		servers := []db.Server{}
		rows, err := store.pool.Query(ctx, `
			SELECT id, name, public_endpoint, listen_port, interface_name, server_public_key,
			       network_cidr::text, dns_servers, default_allowed_ips, mtu, persistent_keepalive, status, created_at
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
				&s.MTU, &s.PersistentKeepalive, &s.Status, &s.CreatedAt); err != nil {
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
			Name                string   `json:"name"`
			PublicEndpoint      string   `json:"public_endpoint"`
			ListenPort          int      `json:"listen_port"`
			InterfaceName       string   `json:"interface_name"`
			ServerPublicKey     string   `json:"server_public_key"`
			ServerPrivateKeyEnc string   `json:"server_private_key_enc"`
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
			req.DNSServers = []string{"1.1.1.1", "8.8.8.8"}
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
			                     mtu, persistent_keepalive, status)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
			RETURNING id
		`, req.Name, req.PublicEndpoint, req.ListenPort, req.InterfaceName, req.ServerPublicKey,
			req.ServerPrivateKeyEnc, req.NetworkCIDR, req.DNSServers, req.DefaultAllowedIPs,
			req.MTU, req.PersistentKeepalive).Scan(&newID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create server")
			return
		}

		logAudit(ctx, store, adminID, "server.create", "server", "", nil)

		// Automatically provision the interface on the host (wg-helper).
		warning := syncServerLogged(ctx, store.pool, newID)

		writeJSON(w, http.StatusCreated, map[string]string{
			"status":        "created",
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

		var admins []struct {
			ID          uuid.UUID `json:"id"`
			Email       string    `json:"email"`
			Role        string    `json:"role"`
			TOTPEnabled bool      `json:"totp_enabled"`
			Status      string    `json:"status"`
			CreatedAt   string    `json:"created_at"`
		}

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

		for rows.Next() {
			var a struct {
				ID          uuid.UUID `json:"id"`
				Email       string    `json:"email"`
				Role        string    `json:"role"`
				TOTPEnabled bool      `json:"totp_enabled"`
				Status      string    `json:"status"`
				CreatedAt   string    `json:"created_at"`
			}
			if err := rows.Scan(&a.ID, &a.Email, &a.Role, &a.TOTPEnabled, &a.Status, &a.CreatedAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan admin")
				return
			}
			admins = append(admins, a)
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

		ctx := context.Background()
		adminID := getAdminID(r)

		_, err := store.pool.Exec(ctx, `
			INSERT INTO admins (email, password_hash, role, status)
			VALUES ($1, $2, $3, 'active')
		`, req.Email, "pending_setup", req.Role)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to invite admin")
			return
		}

		logAudit(ctx, store, adminID, "admin.invite", "admin", "", nil)

		writeJSON(w, http.StatusCreated, map[string]string{"status": "invited"})
	}
}

func GetAdmin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin ID")
			return
		}

		ctx := context.Background()

		var a struct {
			ID          uuid.UUID `json:"id"`
			Email       string    `json:"email"`
			Role        string    `json:"role"`
			TOTPEnabled bool      `json:"totp_enabled"`
			Status      string    `json:"status"`
			CreatedAt   string    `json:"created_at"`
		}

		err = store.pool.QueryRow(ctx, `
			SELECT id, email, role, totp_enabled, status, created_at
			FROM admins
			WHERE id = $1
		`, adminID).Scan(&a.ID, &a.Email, &a.Role, &a.TOTPEnabled, &a.Status, &a.CreatedAt)

		if err != nil {
			writeError(w, http.StatusNotFound, "Admin not found")
			return
		}

		writeJSON(w, http.StatusOK, a)
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
			Role string `json:"role"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		actorID := getAdminID(r)

		_, err = store.pool.Exec(ctx, `
			UPDATE admins SET role = $1, updated_at = now() WHERE id = $2
		`, req.Role, adminID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update admin")
			return
		}

		logAudit(ctx, store, actorID, "admin.update", "admin", adminID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
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

		logAudit(ctx, store, actorID, "admin.delete", "admin", adminID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}
