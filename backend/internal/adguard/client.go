package adguard

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// Client talks to AdGuard Home's /control API. AdGuard Home authenticates
// with HTTP Basic auth (user "admin" by default), NOT an API key.
type Client struct {
	baseURL    string
	user       string
	password   string
	httpClient *http.Client
}

func NewClient() *Client {
	baseURL := os.Getenv("ADGUARD_URL")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:3000"
	}
	user := os.Getenv("ADGUARD_API_USER")
	if user == "" {
		user = "admin"
	}
	password := os.Getenv("ADGUARD_API_PASSWORD")

	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		user:       user,
		password:   password,
		httpClient: &http.Client{},
	}
}

func (c *Client) do(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBody)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(c.user, c.password)
	return c.httpClient.Do(req)
}

// ReplaceUserRules atomically replaces AdGuard's custom user rules.
//
// The correct endpoint is POST /control/filtering/set_rules with
// {"rules": [...]}. POST /control/filtering/config does NOT apply user_rules
// in AdGuard Home v0.107.x — its handler only reads `enabled` and `interval`
// and silently ignores everything else, so round-tripping the filtering
// status through /filtering/config made sync "succeed" while no rule ever
// took effect.
func (c *Client) ReplaceUserRules(ctx context.Context, rules []string) error {
	reqBody := map[string]interface{}{"rules": rules}
	resp, err := c.do(ctx, "POST", "/control/filtering/set_rules", reqBody)
	if err != nil {
		return fmt.Errorf("set user rules: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("adguard filtering set_rules %d: %s", resp.StatusCode, body)
	}
	return nil
}

// EnsureCustomBlockingMode switches AdGuard to return a custom IP for
// blocked domains (so an HTTP listener there can show a branded page).
//
// Only the blocking fields are sent: AGH's /control/dns_config applies each
// provided field independently, so a GET→POST round-trip of the full config
// is both unnecessary and destructive (non-pointer fields like blocking_ipv4
// would reset unrelated settings, e.g. disable EDNS/DNSSEC or clear the
// cache). A read first avoids an unnecessary write when already configured.
func (c *Client) EnsureCustomBlockingMode(ctx context.Context, ipv4 string) error {
	resp, err := c.do(ctx, "GET", "/control/dns_config", nil)
	if err != nil {
		return fmt.Errorf("read dns config: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("adguard dns_config %d: %s", resp.StatusCode, body)
	}
	var cfg struct {
		BlockingMode string `json:"blocking_mode"`
		BlockingIPv4 string `json:"blocking_ipv4"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		return fmt.Errorf("decode dns config: %w", err)
	}
	if cfg.BlockingMode == "custom_ip" && cfg.BlockingIPv4 == ipv4 {
		return nil // already configured
	}

	body := map[string]interface{}{
		"blocking_mode": "custom_ip",
		"blocking_ipv4": ipv4,
		"blocking_ipv6": "::",
	}
	resp2, err := c.do(ctx, "POST", "/control/dns_config", body)
	if err != nil {
		return fmt.Errorf("set blocking mode: %w", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		body2, _ := io.ReadAll(resp2.Body)
		return fmt.Errorf("adguard dns_config set %d: %s", resp2.StatusCode, body2)
	}
	return nil
}

// Ping checks connectivity + credentials.
func (c *Client) Ping(ctx context.Context) error {
	resp, err := c.do(ctx, "GET", "/control/status", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("adguard status %d", resp.StatusCode)
	}
	return nil
}

// Status describes AdGuard Home's live filtering state, used by the console
// to confirm rules really are applied (not just stored in the DB).
type Status struct {
	Reachable   bool     `json:"reachable"`
	Error       string   `json:"error,omitempty"`
	ProtEnabled bool     `json:"protection_enabled"`
	UserRules   []string `json:"user_rules"`
	BlockMode   string   `json:"blocking_mode"`
	BlockIPv4   string   `json:"blocking_ipv4"`
}

// GetStatus reads AGH filtering + DNS state. A connectivity/credential
// problem is reported in the returned Status (Reachable=false + Error)
// rather than as a Go error, so callers can show it in the UI.
func (c *Client) GetStatus(ctx context.Context) Status {
	st := Status{}

	resp, err := c.do(ctx, "GET", "/control/filtering/status", nil)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		st.Error = fmt.Sprintf("adguard filtering status %d: %s", resp.StatusCode, body)
		return st
	}
	var fs struct {
		Enabled   bool     `json:"enabled"`
		UserRules []string `json:"user_rules"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&fs); err != nil {
		st.Error = fmt.Sprintf("decode filtering status: %v", err)
		return st
	}

	resp2, err := c.do(ctx, "GET", "/control/dns_config", nil)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	defer resp2.Body.Close()
	var ds struct {
		BlockingMode string `json:"blocking_mode"`
		BlockingIPv4 string `json:"blocking_ipv4"`
	}
	if resp2.StatusCode == http.StatusOK {
		_ = json.NewDecoder(resp2.Body).Decode(&ds)
	}

	st.Reachable = true
	st.ProtEnabled = fs.Enabled
	st.UserRules = fs.UserRules
	st.BlockMode = ds.BlockingMode
	st.BlockIPv4 = ds.BlockingIPv4
	return st
}
