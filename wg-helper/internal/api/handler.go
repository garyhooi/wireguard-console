package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

type Handler struct {
	client *wgctrl.Client
}

func NewHandler(client *wgctrl.Client) *Handler {
	return &Handler{client: client}
}

type syncRequest struct {
	InterfaceName string        `json:"interface_name"`
	Peers         []wgtypes.Key `json:"peers"`
}

// applyRequest is the full desired state of one WireGuard interface.
// The console sends this after any server/peer change so the kernel
// reflects the database automatically.
type applyRequest struct {
	InterfaceName string      `json:"interface_name"`
	ListenPort    int         `json:"listen_port"`
	PrivateKey    string      `json:"private_key"`
	Address       string      `json:"address"`  // gateway address, e.g. 10.8.0.1/24
	NatCIDR       string      `json:"nat_cidr"` // client subnet to masquerade, e.g. 10.8.0.0/24
	Peers         []applyPeer `json:"peers"`
}

type applyPeer struct {
	PublicKey string `json:"public_key"`
	AllowedIP string `json:"allowed_ip"` // bare IP, /32 applied
}

type applyResponse struct {
	Status   string   `json:"status"`
	Warnings []string `json:"warnings,omitempty"`
}

type statsRequest struct {
	InterfaceName string `json:"interface_name"`
}

type peerStats struct {
	PublicKey       string `json:"public_key"`
	ReceiveBytes    int64  `json:"receive_bytes"`
	TransmitBytes   int64  `json:"transmit_bytes"`
	LastHandshakeAt string `json:"last_handshake_at"`
}

type statsResponse struct {
	Peers []peerStats `json:"peers"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/apply":
		h.handleApply(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/remove":
		h.handleRemove(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/sync":
		h.handleSync(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/stats":
		h.handleStats(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/health":
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	default:
		http.Error(w, "Not found", http.StatusNotFound)
	}
}

// run executes a host command (we run on the host network namespace with
// NET_ADMIN). Errors are collected as warnings for the console to surface.
func run(cmd *exec.Cmd) error {
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v (%s)", cmd.String(), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (h *Handler) handleApply(w http.ResponseWriter, r *http.Request) {
	var req applyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.InterfaceName == "" || req.PrivateKey == "" {
		writeError(w, http.StatusBadRequest, "interface_name and private_key are required")
		return
	}

	var warnings []string
	warn := func(format string, a ...interface{}) {
		warnings = append(warnings, fmt.Sprintf(format, a...))
		log.Printf("wg-helper [%s]: %s", req.InterfaceName, fmt.Sprintf(format, a...))
	}

	// 1. Create the interface if it doesn't exist yet.
	if err := run(exec.Command("ip", "link", "add", req.InterfaceName, "type", "wireguard")); err != nil {
		if !strings.Contains(err.Error(), "File exists") {
			warn("%v", err)
		}
	}

	// 2. Apply the server's private key + listen port.
	keyFile, err := os.CreateTemp("", "wg-key-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create temp key file")
		return
	}
	defer os.Remove(keyFile.Name())
	if _, err := keyFile.WriteString(req.PrivateKey + "\n"); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to write key file")
		return
	}
	keyFile.Close()

	if err := run(exec.Command("wg", "set", req.InterfaceName, "listen-port", fmt.Sprintf("%d", req.ListenPort), "private-key", keyFile.Name())); err != nil {
		warn("%v", err)
	}

	// 3. Gateway address + bring the interface up.
	if req.Address != "" {
		if err := run(exec.Command("ip", "address", "replace", req.Address, "dev", req.InterfaceName)); err != nil {
			warn("%v", err)
		}
	}
	if err := run(exec.Command("ip", "link", "set", req.InterfaceName, "up")); err != nil {
		warn("%v", err)
	}

	// 4. Peers (replace the whole list, mirroring the database).
	config := wgtypes.Config{
		ReplacePeers: true,
	}
	for _, p := range req.Peers {
		key, err := wgtypes.ParseKey(p.PublicKey)
		if err != nil {
			warn("skipping peer %s: %v", p.PublicKey, err)
			continue
		}
		_, ipnet, err := net.ParseCIDR(p.AllowedIP + "/32")
		if err != nil {
			warn("skipping peer %s: bad IP %s", p.PublicKey, p.AllowedIP)
			continue
		}
		config.Peers = append(config.Peers, wgtypes.PeerConfig{
			PublicKey:         key,
			ReplaceAllowedIPs: true,
			AllowedIPs:        []net.IPNet{*ipnet},
		})
	}
	// Always apply (even an empty list with ReplacePeers clears the device).
	if err := h.client.ConfigureDevice(req.InterfaceName, config); err != nil {
		warn("applying peers: %v", err)
	}

	// 5. Routing + NAT so clients reach the internet (idempotent).
	run(exec.Command("sysctl", "-w", "net.ipv4.ip_forward=1"))
	if req.NatCIDR != "" {
		for _, args := range [][]string{
			{"-t", "nat", "-C", "POSTROUTING", "-s", req.NatCIDR, "-j", "MASQUERADE"},
			{"-C", "FORWARD", "-s", req.NatCIDR, "-j", "ACCEPT"},
			{"-C", "FORWARD", "-d", req.NatCIDR, "-j", "ACCEPT"},
		} {
			check := exec.Command("iptables", args...)
			if err := run(check); err != nil {
				// Turn the check rule into an add rule (-C -> -A).
				addArgs := append([]string(nil), args...)
				for i, a := range addArgs {
					if a == "-C" {
						addArgs[i] = "-A"
						break
					}
				}
				if err := run(exec.Command("iptables", addArgs...)); err != nil {
					warn("iptables %v: %v", addArgs, err)
				}
			}
		}
	}

	log.Printf("wg-helper [%s]: applied %d peers", req.InterfaceName, len(config.Peers))
	writeJSON(w, http.StatusOK, applyResponse{Status: "ok", Warnings: warnings})
}

func (h *Handler) handleRemove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		InterfaceName string `json:"interface_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.InterfaceName == "" {
		writeError(w, http.StatusBadRequest, "interface_name is required")
		return
	}

	var warnings []string
	warn := func(format string, a ...interface{}) {
		warnings = append(warnings, fmt.Sprintf(format, a...))
	}

	if err := run(exec.Command("ip", "link", "del", req.InterfaceName)); err != nil {
		if !strings.Contains(err.Error(), "does not exist") {
			warn("%v", err)
		}
	}
	// Best-effort: drop NAT/forward rules if the interface disappeared
	// with them still set (we don't know the CIDR here, so nothing to clean
	// precisely — the interface removal drops the routing entries).

	log.Printf("wg-helper [%s]: interface removed", req.InterfaceName)
	writeJSON(w, http.StatusOK, applyResponse{Status: "removed", Warnings: warnings})
}

// handleSync kept for backwards compatibility — same as apply minus the
// interface/key/networking steps (interface must already exist).
func (h *Handler) handleSync(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	config := wgtypes.Config{
		ReplacePeers: true,
	}

	allAllowedIPs := []net.IPNet{{IP: net.IPv4zero, Mask: net.CIDRMask(0, 32)}}

	for _, peerKey := range req.Peers {
		config.Peers = append(config.Peers, wgtypes.PeerConfig{
			PublicKey:         peerKey,
			ReplaceAllowedIPs: true,
			AllowedIPs:        allAllowedIPs,
		})
	}

	if err := h.client.ConfigureDevice(req.InterfaceName, config); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to configure device: %v", err))
		return
	}

	log.Printf("wg-helper [%s]: synced %d peers", req.InterfaceName, len(req.Peers))

	writeJSON(w, http.StatusOK, map[string]string{"status": "synced"})
}

func (h *Handler) handleStats(w http.ResponseWriter, r *http.Request) {
	var req statsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	dev, err := h.client.Device(req.InterfaceName)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to get device: %v", err))
		return
	}

	var peers []peerStats
	for _, peer := range dev.Peers {
		lastHandshake := ""
		if !peer.LastHandshakeTime.IsZero() {
			lastHandshake = peer.LastHandshakeTime.Format(time.RFC3339)
		}
		peers = append(peers, peerStats{
			PublicKey:       peer.PublicKey.String(),
			ReceiveBytes:    peer.ReceiveBytes,
			TransmitBytes:   peer.TransmitBytes,
			LastHandshakeAt: lastHandshake,
		})
	}

	writeJSON(w, http.StatusOK, statsResponse{Peers: peers})
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
