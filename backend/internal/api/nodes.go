package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/wgclient"
)

func generateNodeToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func hashNodeToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// nodeTokenAuth validates the agent's Bearer token for a node id.
func nodeTokenAuth(store *Store, r *http.Request, nodeID uuid.UUID) bool {
	token := r.Header.Get("Authorization")
	if len(token) > 7 && token[:7] == "Bearer " {
		token = token[7:]
	}
	if token == "" {
		return false
	}
	var hash, status string
	err := store.pool.QueryRow(context.Background(),
		`SELECT token_hash, status FROM nodes WHERE id = $1`, nodeID).Scan(&hash, &status)
	if err != nil || status != "active" {
		return false
	}
	expected := hashNodeToken(token)
	return expected == hash
}

type nodeView struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Location    string  `json:"location"`
	Status      string  `json:"status"`
	LastSeenAt  *string `json:"last_seen_at"`
	LastStatus  string  `json:"last_status"`
	ServerCount int     `json:"server_count"`
}

func ListNodes(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		rows, err := store.pool.Query(ctx, `
			SELECT n.id, n.name, n.location, n.status, n.last_seen_at, n.last_status,
			       (SELECT count(*) FROM servers s WHERE s.node_id = n.id AND s.status = 'active')
			FROM nodes n
			ORDER BY n.created_at ASC
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to list nodes")
			return
		}
		defer rows.Close()

		nodes := []nodeView{}
		for rows.Next() {
			var n nodeView
			var lastSeen *time.Time
			if err := rows.Scan(&n.ID, &n.Name, &n.Location, &n.Status, &lastSeen, &n.LastStatus, &n.ServerCount); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan node")
				return
			}
			if lastSeen != nil {
				ts := lastSeen.UTC().Format(time.RFC3339)
				n.LastSeenAt = &ts
			}
			nodes = append(nodes, n)
		}
		writeJSON(w, http.StatusOK, nodes)
	}
}

func CreateNode(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name     string `json:"name"`
			Location string `json:"location"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		token, err := generateNodeToken()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate token")
			return
		}

		var nodeID uuid.UUID
		err = store.pool.QueryRow(ctx, `
			INSERT INTO nodes (name, location, token_hash)
			VALUES ($1, $2, $3)
			RETURNING id
		`, req.Name, req.Location, hashNodeToken(token)).Scan(&nodeID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create node")
			return
		}

		logAudit(ctx, store, adminID, "node.create", "node", nodeID.String(), nil)

		// The plaintext token is shown exactly once, inside the join command.
		domain := os.Getenv("CONSOLE_DOMAIN")
		join := fmt.Sprintf(
			"curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/node-install.sh | sudo bash -s -- %s https://%s %s",
			token, domain, nodeID.String())

		writeJSON(w, http.StatusCreated, map[string]string{
			"status":       "created",
			"node_id":      nodeID.String(),
			"token":        token,
			"join_command": join,
		})
	}
}

func DeleteNode(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		nodeID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid node ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		// Unassign servers first so they fall back to manual mode.
		if _, err := store.pool.Exec(ctx, `
			UPDATE servers SET node_id = NULL, managed_mode = 'manual' WHERE node_id = $1
		`, nodeID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to unassign servers")
			return
		}
		if _, err := store.pool.Exec(ctx, `DELETE FROM nodes WHERE id = $1`, nodeID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete node")
			return
		}

		logAudit(ctx, store, adminID, "node.delete", "node", nodeID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}

// ---- Agent-facing endpoints (token auth) ----

// GetNodeState returns every server assigned to this node, with the
// decrypted keys and peers needed to build the interfaces locally.
func GetNodeState(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		nodeID, err := parseUUID(r.PathValue("id"))
		if err != nil || !nodeTokenAuth(store, r, nodeID) {
			writeError(w, http.StatusUnauthorized, "Unauthorized")
			return
		}

		ctx := context.Background()
		rows, err := store.pool.Query(ctx, `
			SELECT s.id::text, s.interface_name, s.listen_port,
			       s.server_private_key_encrypted, s.network_cidr::text, s.public_endpoint
			FROM servers s
			WHERE s.node_id = $1 AND s.status = 'active' AND s.managed_mode = 'remote'
		`, nodeID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query servers")
			return
		}
		defer rows.Close()

		encSvc, err := auth.NewEncryptionService()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Encryption is not configured")
			return
		}

		type serverState struct {
			ID            string               `json:"id"`
			InterfaceName string               `json:"interface_name"`
			ListenPort    int                  `json:"listen_port"`
			PrivateKey    string               `json:"private_key"`
			Address       string               `json:"address"`
			NatCIDR       string               `json:"nat_cidr"`
			Endpoint      string               `json:"endpoint"`
			Peers         []wgclient.ApplyPeer `json:"peers"`
		}

		servers := []serverState{}
		for rows.Next() {
			var id, iface, privEnc, cidr, endpoint string
			var port int
			if err := rows.Scan(&id, &iface, &port, &privEnc, &cidr, &endpoint); err != nil {
				continue
			}
			priv, err := encSvc.Decrypt(privEnc)
			if err != nil {
				continue
			}
			gw, maskBits, err := gatewayForCIDR(cidr)
			if err != nil {
				continue
			}

			peerRows, err := store.pool.Query(ctx, `
				SELECT host(allowed_ip), public_key FROM peers
				WHERE server_id = $1 AND status = 'active' ORDER BY allowed_ip
			`, id)
			if err != nil {
				continue
			}
			peers := []wgclient.ApplyPeer{}
			for peerRows.Next() {
				var ip, pub string
				if peerRows.Scan(&ip, &pub) == nil {
					peers = append(peers, wgclient.ApplyPeer{PublicKey: pub, AllowedIP: ip})
				}
			}
			peerRows.Close()

			servers = append(servers, serverState{
				ID: id, InterfaceName: iface, ListenPort: port, PrivateKey: priv,
				Address: fmt.Sprintf("%s/%d", gw, maskBits), NatCIDR: cidr, Endpoint: endpoint,
				Peers: peers,
			})
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"node_id": nodeID.String(),
			"servers": servers,
		})
	}
}

// ReportNodeState is called by the agent after each apply cycle.
func ReportNodeState(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		nodeID, err := parseUUID(r.PathValue("id"))
		if err != nil || !nodeTokenAuth(store, r, nodeID) {
			writeError(w, http.StatusUnauthorized, "Unauthorized")
			return
		}

		var req struct {
			Status  string `json:"status"`
			Details string `json:"details"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if req.Status == "" {
			req.Status = "ok"
		}

		_, err = store.pool.Exec(context.Background(), `
			UPDATE nodes SET last_seen_at = now(), last_status = $1 WHERE id = $2
		`, req.Status+" "+req.Details, nodeID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update node")
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}
