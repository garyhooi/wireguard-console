package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
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
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Location    string          `json:"location"`
	Status      string          `json:"status"`
	LastSeenAt  *string         `json:"last_seen_at"`
	LastStatus  string          `json:"last_status"`
	ServerCount int             `json:"server_count"`
	Metrics     json.RawMessage `json:"metrics"` // latest host snapshot (see metrics package)
	MetricsAt   *string         `json:"metrics_at"`
	// AgentVersion is the wg-helper build this node reports (from
	// metrics.host.agent_version), and AgentMismatch is true when that
	// version differs from the console's own APP_VERSION — the admin then
	// knows the node is running an older agent and should re-run the node
	// installer. Both are "" / false when the node hasn't reported metrics
	// yet, or when the console itself is a "dev" build (no comparison).
	AgentVersion  string `json:"agent_version"`
	AgentMismatch bool   `json:"agent_mismatch"`
}

func ListNodes(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		rows, err := store.pool.Query(ctx, `
			SELECT n.id, n.name, n.location, n.status, n.last_seen_at, n.last_status,
			       (SELECT count(*) FROM servers s WHERE s.node_id = n.id AND s.status = 'active'),
			       n.metrics, n.metrics_at
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
			var lastSeen, metricsAt *time.Time
			var metrics json.RawMessage
			if err := rows.Scan(&n.ID, &n.Name, &n.Location, &n.Status, &lastSeen, &n.LastStatus, &n.ServerCount, &metrics, &metricsAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan node")
				return
			}
			if lastSeen != nil {
				ts := lastSeen.UTC().Format(time.RFC3339)
				n.LastSeenAt = &ts
			}
			if metricsAt != nil {
				ts := metricsAt.UTC().Format(time.RFC3339)
				n.MetricsAt = &ts
			}
			if len(metrics) == 0 || string(metrics) == "null" {
				n.Metrics = json.RawMessage("{}")
			} else {
				n.Metrics = metrics
				n.AgentVersion, n.AgentMismatch = agentVersionInfo(metrics)
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

// RotateNodeToken issues a fresh agent token for a node and returns the full
// join command carrying it. Only the token's hash is stored (the plaintext is
// shown once at creation), so "show me the join command again" is implemented
// as a rotation: the old token stops working the moment this runs and the new
// one must be applied by re-running node-install.sh on the node. super_admin
// only (route-gated) — a node token can re-enroll a replacement machine.
func RotateNodeToken(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		nodeID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid node ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		// Re-issuing a node token hands out a working agent credential —
		// require the acting super_admin's own 2FA code first.
		var req stepUpRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if !verifyActor2FA(w, r, ctx, store, adminID, req.Code) {
			return
		}

		var exists bool
		if err := store.pool.QueryRow(ctx,
			`SELECT true FROM nodes WHERE id = $1`, nodeID).Scan(&exists); err != nil {
			writeError(w, http.StatusNotFound, "Node not found")
			return
		}

		token, err := generateNodeToken()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate token")
			return
		}
		if _, err := store.pool.Exec(ctx,
			`UPDATE nodes SET token_hash = $1 WHERE id = $2`,
			hashNodeToken(token), nodeID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to rotate token")
			return
		}

		logAudit(ctx, store, adminID, "node.token_rotate", "node", nodeID.String(), nil)

		domain := os.Getenv("CONSOLE_DOMAIN")
		join := fmt.Sprintf(
			"curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/node-install.sh | sudo bash -s -- %s https://%s %s",
			token, domain, nodeID.String())

		writeJSON(w, http.StatusOK, map[string]string{
			"status":       "rotated",
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

		// Deleting a node drops its agent access — require the acting
		// admin's own 2FA code first.
		var req stepUpRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if !verifyActor2FA(w, r, ctx, store, adminID, req.Code) {
			return
		}

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

// GetLocalNodeStatus returns the console host's own live metrics from the
// local wg-helper (same host snapshot schema the remote agents report). The
// monitoring page renders this as a synthetic "Local host" card so every
// WireGuard machine appears in one place. 503 when wg-helper is
// unreachable/absent (dev mode without the helper) — the UI hides the card.
func GetLocalNodeStatus(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := wgclient.System()
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "Local wg-helper is not available")
			return
		}
		if raw == nil {
			writeError(w, http.StatusServiceUnavailable, "Local wg-helper is not configured")
			return
		}
		sanitized, err := sanitizeMetrics(raw)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "Local wg-helper returned invalid metrics")
			return
		}
		agentVersion, mismatch := agentVersionInfo(sanitized)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"hostname":       "Local host (console)",
			"is_local":       true,
			"metrics":        json.RawMessage(sanitized),
			"metrics_at":     time.Now().UTC().Format(time.RFC3339),
			"agent_version":  agentVersion,
			"agent_mismatch": mismatch,
		})
	}
}

// agentVersionInfo extracts the wg-helper agent version a machine reports
// from its sanitized host-metrics payload (metrics.host.agent_version) and
// whether it differs from the console's own version. The console stamps its
// APP_VERSION on every install; node agents are stamped with the repo VERSION
// they were built from (node-install.sh). A mismatch means the machine runs
// an agent older than the console and the node installer should be re-run.
// Returns ("", false) when no version is reported, when it is "dev" (an
// unstamped build — nothing to compare), or when the console is a dev build.
func agentVersionInfo(metricsJSON json.RawMessage) (string, bool) {
	var m struct {
		Host struct {
			AgentVersion string `json:"agent_version"`
		} `json:"host"`
	}
	if err := json.Unmarshal(metricsJSON, &m); err != nil {
		return "", false
	}
	v := strings.TrimSpace(m.Host.AgentVersion)
	if v == "" || v == "dev" {
		return v, false
	}
	cur := strings.TrimSpace(ConsoleVersion())
	if cur == "" || cur == "dev" {
		return v, false // console itself unknown — can't judge
	}
	// "v1.2.3" (a GitHub-style tag) and "1.2.3" (repo VERSION) are the same
	// release — compare with the leading "v" normalized away.
	norm := func(s string) string { return strings.TrimPrefix(s, "v") }
	return v, norm(v) != norm(cur)
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

// ReportNodeState is called by the agent after each apply cycle. The body
// may carry a host metrics snapshot (from agents with monitoring support)
// which is stored on the node row for the monitoring page. Old agents omit
// it and simply keep the previous snapshot.
func ReportNodeState(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		nodeID, err := parseUUID(r.PathValue("id"))
		if err != nil || !nodeTokenAuth(store, r, nodeID) {
			writeError(w, http.StatusUnauthorized, "Unauthorized")
			return
		}

		// Guard against a misbehaving agent flooding the row with a huge
		// payload (a valid snapshot is a few hundred bytes).
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)

		var req struct {
			Status  string          `json:"status"`
			Details string          `json:"details"`
			Metrics json.RawMessage `json:"metrics"` // optional host snapshot
			// Interfaces carries the agent's live per-peer kernel state for
			// each interface this node manages (see wg-helper agent.go). Old
			// agents omit it; when present we refresh peers.last_handshake_at
			// so node-server peers show real handshake times in the UI.
			Interfaces []struct {
				InterfaceName string `json:"interface_name"`
				Peers         []struct {
					PublicKey       string `json:"public_key"`
					LastHandshakeAt string `json:"last_handshake_at"`
				} `json:"peers"`
			} `json:"interfaces"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if req.Status == "" {
			req.Status = "ok"
		}

		var metricsJSON []byte
		if len(req.Metrics) > 0 && string(req.Metrics) != "null" {
			metricsJSON, err = sanitizeMetrics(req.Metrics)
			if err != nil {
				// Garbage metrics never fail the poll: log and keep the
				// previous snapshot on the row.
				log.Printf("node %s: ignoring invalid metrics payload: %v", nodeID, err)
				metricsJSON = nil
			}
		}

		var qerr error
		if metricsJSON != nil {
			_, qerr = store.pool.Exec(context.Background(), `
				UPDATE nodes SET last_seen_at = now(), last_status = $1,
				                 metrics = $2::jsonb, metrics_at = now()
				WHERE id = $3
			`, req.Status+" "+req.Details, string(metricsJSON), nodeID)
		} else {
			_, qerr = store.pool.Exec(context.Background(), `
				UPDATE nodes SET last_seen_at = now(), last_status = $1
				WHERE id = $2
			`, req.Status+" "+req.Details, nodeID)
		}
		if qerr != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update node")
			return
		}

		// Refresh last_handshake_at for every peer the agent reports live
		// state for. The console's traffic worker only samples local servers,
		// so without this, peers on remote-node servers would stay "Never"
		// forever. Resolve each interface_name to this node's server id and
		// update peers by (server, public_key).
		if len(req.Interfaces) > 0 {
			ctx := context.Background()
			for _, iface := range req.Interfaces {
				if len(iface.Peers) == 0 {
					continue
				}
				var serverID uuid.UUID
				err := store.pool.QueryRow(ctx, `
					SELECT id FROM servers
					WHERE node_id = $1 AND interface_name = $2
					  AND status = 'active' AND managed_mode = 'remote'
				`, nodeID, iface.InterfaceName).Scan(&serverID)
				if err != nil {
					continue // not one of this node's servers — skip
				}
				for _, p := range iface.Peers {
					if p.LastHandshakeAt == "" || p.PublicKey == "" {
						continue
					}
					if t, err := time.Parse(time.RFC3339, p.LastHandshakeAt); err == nil {
						_, _ = store.pool.Exec(ctx, `
							UPDATE peers SET last_handshake_at = $1
							WHERE server_id = $2 AND public_key = $3
						`, t, serverID, p.PublicKey)
					}
				}
			}
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// sanitizeMetrics validates and bounds a reported metrics payload so the
// JSONB column only ever holds well-formed, sane numbers. It re-marshals a
// strict subset of the agent's snapshot schema; unknown fields are dropped.
func sanitizeMetrics(raw json.RawMessage) ([]byte, error) {
	var in struct {
		CPU struct {
			Cores   *int     `json:"cores"`
			Percent *float64 `json:"percent"`
		} `json:"cpu"`
		Load []float64 `json:"load"`
		Mem  struct {
			Total   *uint64  `json:"total"`
			Used    *uint64  `json:"used"`
			Percent *float64 `json:"percent"`
		} `json:"mem"`
		Swap struct {
			Total   *uint64  `json:"total"`
			Used    *uint64  `json:"used"`
			Percent *float64 `json:"percent"`
		} `json:"swap"`
		Disk []struct {
			Mount   string  `json:"mount"`
			Device  string  `json:"device"`
			FS      string  `json:"fs"`
			Total   uint64  `json:"total"`
			Used    uint64  `json:"used"`
			Percent float64 `json:"percent"`
		} `json:"disk"`
		Net []struct {
			Interface string  `json:"interface"`
			RxBps     float64 `json:"rx_bps"`
			TxBps     float64 `json:"tx_bps"`
		} `json:"net"`
		UptimeSec   *int64          `json:"uptime_s"`
		Host        json.RawMessage `json:"host"`
		CollectedAt *time.Time      `json:"collected_at"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, err
	}
	if in.CPU.Cores != nil && (*in.CPU.Cores < 1 || *in.CPU.Cores > 1024) {
		return nil, fmt.Errorf("cpu cores out of range")
	}

	clampPct := func(p *float64) *float64 {
		if p == nil {
			return nil
		}
		v := *p
		if v < 0 {
			v = 0
		}
		if v > 100 {
			v = 100
		}
		return &v
	}

	type memOut struct {
		Total   uint64   `json:"total"`
		Used    uint64   `json:"used"`
		Percent *float64 `json:"percent"`
	}
	memOutOf := func(m struct {
		Total   *uint64  `json:"total"`
		Used    *uint64  `json:"used"`
		Percent *float64 `json:"percent"`
	}) memOut {
		var o memOut
		if m.Total != nil {
			o.Total = *m.Total
		}
		if m.Used != nil {
			o.Used = *m.Used
		}
		if o.Used > o.Total {
			o.Used = o.Total
		}
		o.Percent = clampPct(m.Percent)
		return o
	}

	type diskOut struct {
		Mount   string   `json:"mount"`
		Device  string   `json:"device"`
		FS      string   `json:"fs"`
		Total   uint64   `json:"total"`
		Used    uint64   `json:"used"`
		Percent *float64 `json:"percent"`
	}
	disks := make([]diskOut, 0, len(in.Disk))
	for _, d := range in.Disk {
		if d.Mount == "" || d.Device == "" || len(disks) >= 16 {
			continue
		}
		used := d.Used
		if used > d.Total {
			used = d.Total
		}
		disks = append(disks, diskOut{
			Mount: d.Mount, Device: d.Device, FS: d.FS,
			Total: d.Total, Used: used, Percent: clampPct(&d.Percent),
		})
	}

	type netOut struct {
		Interface string   `json:"interface"`
		RxBps     *float64 `json:"rx_bps"`
		TxBps     *float64 `json:"tx_bps"`
	}
	nets := make([]netOut, 0, len(in.Net))
	for _, n := range in.Net {
		if n.Interface == "" || len(nets) >= 8 {
			continue
		}
		clampRate := func(v float64) *float64 {
			if v < 0 {
				v = 0
			}
			if v > 1<<40 { // 1 TB/s sanity cap
				v = 1 << 40
			}
			return &v
		}
		nets = append(nets, netOut{Interface: n.Interface, RxBps: clampRate(n.RxBps), TxBps: clampRate(n.TxBps)})
	}

	load := in.Load
	if len(load) > 3 {
		load = load[:3]
	}
	for i, v := range load {
		if v < 0 {
			load[i] = 0
		}
		if v > 1<<20 {
			load[i] = 1 << 20
		}
	}

	out := map[string]interface{}{
		"cpu": map[string]interface{}{
			"cores":   in.CPU.Cores,
			"percent": clampPct(in.CPU.Percent),
		},
		"load":     load,
		"mem":      memOutOf(in.Mem),
		"swap":     memOutOf(in.Swap),
		"disk":     disks,
		"net":      nets,
		"uptime_s": in.UptimeSec,
	}
	if len(in.Host) > 0 && string(in.Host) != "null" {
		var host struct {
			Hostname     string `json:"hostname"`
			OS           string `json:"os"`
			Arch         string `json:"arch"`
			Kernel       string `json:"kernel"`
			AgentVersion string `json:"agent_version"`
		}
		// Host is informational only: if it fails to parse, drop it.
		if err := json.Unmarshal(in.Host, &host); err == nil {
			if len(host.Hostname) > 128 {
				host.Hostname = ""
			}
			out["host"] = host
		}
	}
	if in.CollectedAt != nil {
		out["collected_at"] = in.CollectedAt.UTC().Format(time.RFC3339)
	}

	return json.Marshal(out)
}
