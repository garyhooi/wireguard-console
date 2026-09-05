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
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"hostname":   "Local host (console)",
			"is_local":   true,
			"metrics":    json.RawMessage(sanitized),
			"metrics_at": time.Now().UTC().Format(time.RFC3339),
		})
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
