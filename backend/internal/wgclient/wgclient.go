package wgclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"
)

// ApplyRequest mirrors the wg-helper /apply endpoint.
type ApplyRequest struct {
	InterfaceName string      `json:"interface_name"`
	ListenPort    int         `json:"listen_port"`
	PrivateKey    string      `json:"private_key"`
	Address       string      `json:"address"`
	NatCIDR       string      `json:"nat_cidr"`
	Peers         []ApplyPeer `json:"peers"`
}

type ApplyPeer struct {
	PublicKey string `json:"public_key"`
	AllowedIP string `json:"allowed_ip"`
}

type RemoveRequest struct {
	InterfaceName string `json:"interface_name"`
}

type StatsPeer struct {
	PublicKey       string `json:"public_key"`
	ReceiveBytes    int64  `json:"receive_bytes"`
	TransmitBytes   int64  `json:"transmit_bytes"`
	LastHandshakeAt string `json:"last_handshake_at"`
}

// Socket returns the wg-helper unix socket path, or "" when not configured
// (e.g. local development without the helper) — callers skip the sync then.
func Socket() string {
	return os.Getenv("WG_HELPER_SOCKET")
}

func post(socket, path string, body interface{}) (*http.Response, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return request("POST", socket, path, bytes.NewReader(buf))
}

// get performs a GET against the wg-helper unix socket.
func get(socket, path string) (*http.Response, error) {
	return request("GET", socket, path, nil)
}

func request(method, socket, path string, body io.Reader) (*http.Response, error) {
	client := &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			},
		},
	}
	req, err := http.NewRequest(method, "http://wg-helper"+path, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return client.Do(req)
}

// Apply pushes a server's full desired state to wg-helper.
func Apply(interfaceName string, req *ApplyRequest) error {
	socket := Socket()
	if socket == "" {
		return nil
	}
	resp, err := post(socket, "/apply", req)
	if err != nil {
		return fmt.Errorf("wg-helper apply: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&e)
		return fmt.Errorf("wg-helper apply: %s", e.Error)
	}
	var out struct {
		Status   string   `json:"status"`
		Warnings []string `json:"warnings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("wg-helper apply: bad response: %w", err)
	}
	if len(out.Warnings) > 0 {
		return fmt.Errorf("wg-helper warnings: %v", out.Warnings)
	}
	return nil
}

// Remove deletes a server's interface from the kernel.
func Remove(interfaceName string) error {
	socket := Socket()
	if socket == "" {
		return nil
	}
	resp, err := post(socket, "/remove", RemoveRequest{InterfaceName: interfaceName})
	if err != nil {
		return fmt.Errorf("wg-helper remove: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("wg-helper remove: status %d", resp.StatusCode)
	}
	return nil
}

// Stats returns per-peer kernel stats for an interface.
func Stats(interfaceName string) ([]StatsPeer, error) {
	socket := Socket()
	if socket == "" {
		return nil, nil
	}
	resp, err := post(socket, "/stats", map[string]string{"interface_name": interfaceName})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("wg-helper stats: status %d", resp.StatusCode)
	}
	var out struct {
		Peers []StatsPeer `json:"peers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Peers, nil
}

// System returns the wg-helper host snapshot (CPU/mem/disk/load/uptime) for
// the console host's own monitoring card. Returns (nil, nil) when no socket
// is configured (e.g. local development) so callers can skip the card.
//
// Must be a GET: wg-helper serves /system only on GET (the agent's other
// endpoints /apply /remove /sync /stats are POST). Sending POST here 404s
// and the monitoring page would never see the console host.
func System() (json.RawMessage, error) {
	socket := Socket()
	if socket == "" {
		return nil, nil
	}
	resp, err := get(socket, "/system")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("wg-helper system: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, err
	}
	return json.RawMessage(body), nil
}
