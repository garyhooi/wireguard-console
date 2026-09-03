package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"

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

type syncResponse struct {
	Status string `json:"status"`
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

func (h *Handler) handleSync(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Note: the interface's own private key is left untouched here — the
	// interface is expected to be pre-configured (e.g. via wg-quick or the
	// console's server setup); syncing only replaces the peer list.

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

	log.Printf("Synced %d peers to %s", len(req.Peers), req.InterfaceName)

	writeJSON(w, http.StatusOK, syncResponse{Status: "synced"})
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
			lastHandshake = peer.LastHandshakeTime.String()
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
