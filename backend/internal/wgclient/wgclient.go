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
	"sync"
	"time"
)

// ApplyRequest mirrors the wg-helper /apply endpoint.
type ApplyRequest struct {
	InterfaceName string `json:"interface_name"`
	ListenPort    int    `json:"listen_port"`
	PrivateKey    string `json:"private_key"`
	Address       string `json:"address"`
	NatCIDR       string `json:"nat_cidr"`
	// DNSEnforcement tells wg-helper to install the server-side DNS
	// enforcement rules (redirect peer :53 to the local AdGuard, drop DoT and
	// known DoH resolvers). Only local-mode servers set it: remote nodes have
	// no local AdGuard, so forcing DNS there would break their peers.
	DNSEnforcement bool `json:"dns_enforcement"`
	// IPBlockRules are expanded destination blocks (global rules carry an
	// empty SourceIP; per-user rules carry the peer's tunnel IP).
	IPBlockRules []IPBlockRule `json:"ip_block_rules"`
	Peers        []ApplyPeer   `json:"peers"`
}

// IPBlockRule is one expanded IP-blocking entry: drop traffic from SourceIP
// ("" = every peer on the interface) to CIDR.
type IPBlockRule struct {
	SourceIP string `json:"source_ip"`
	CIDR     string `json:"cidr"`
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

// helperClients caches one HTTP client per wg-helper socket path. A client
// (and its Transport) must never be created per request: when the response
// body is closed, net/http parks the keep-alive connection in the transport's
// idle pool; a zero-value Transport has IdleConnTimeout == 0 (nothing ever
// reaps it) and nothing calls CloseIdleConnections, so the connection, its
// readLoop/writeLoop goroutines and buffers leaked on every call. Reusing one
// client with keep-alive disabled keeps this channel leak-free.
var (
	helperClientsMu sync.Mutex
	helperClients   = map[string]*http.Client{}
)

// helperClient returns the process-wide HTTP client for a wg-helper socket.
func helperClient(socket string) *http.Client {
	helperClientsMu.Lock()
	defer helperClientsMu.Unlock()

	if c, ok := helperClients[socket]; ok {
		return c
	}
	c := &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			},
			// The helper is a local unix socket hit a few times a minute;
			// connection reuse buys nothing, and an idle pooled connection is
			// exactly what leaked when the transport was per-call.
			DisableKeepAlives:     true,
			IdleConnTimeout:       90 * time.Second, // belt-and-braces if keep-alive is ever re-enabled
			ResponseHeaderTimeout: 10 * time.Second,
		},
	}
	helperClients[socket] = c
	return c
}

func request(method, socket, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequest(method, "http://wg-helper"+path, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return helperClient(socket).Do(req)
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

// EnforceDNS asks wg-helper to (re)install the DNS enforcement rules for an
// interface without touching the interface itself. Used by the reconcile
// worker to self-heal after a reboot, an nftables flush or a ufw reload.
func EnforceDNS(interfaceName, natCIDR string) error {
	return enforce(interfaceName, natCIDR, true, nil)
}

// EnforceGuards (re)installs both role guards — DNS enforcement and IP
// blocking — for one interface without touching the WireGuard device. The
// rules slice is always sent (empty means "no IP rules": wg-helper clears the
// tables), so a deleted rule is removed from the kernel too.
func EnforceGuards(interfaceName, natCIDR string, dnsEnforcement bool, rules []IPBlockRule) error {
	if rules == nil {
		rules = []IPBlockRule{}
	}
	return enforce(interfaceName, natCIDR, dnsEnforcement, &rules)
}

// enforce posts /enforce. A nil rules pointer keeps the field out of the
// payload (legacy DNS-only callers), so wg-helper leaves IP-block state alone.
func enforce(interfaceName, natCIDR string, dnsEnforcement bool, rules *[]IPBlockRule) error {
	socket := Socket()
	if socket == "" {
		return nil
	}
	body := map[string]interface{}{
		"interface_name":  interfaceName,
		"nat_cidr":        natCIDR,
		"dns_enforcement": dnsEnforcement,
	}
	if rules != nil {
		body["ip_block_rules"] = *rules
	}
	resp, err := post(socket, "/enforce", body)
	if err != nil {
		return fmt.Errorf("wg-helper enforce: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("wg-helper enforce: status %d", resp.StatusCode)
	}
	var out struct {
		Warnings []string `json:"warnings"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if len(out.Warnings) > 0 {
		return fmt.Errorf("wg-helper enforce: %v", out.Warnings)
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
