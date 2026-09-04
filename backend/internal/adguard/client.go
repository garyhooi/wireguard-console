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
func (c *Client) ReplaceUserRules(ctx context.Context, rules []string) error {
	// Read current config so we preserve enabled/interval/filters.
	resp, err := c.do(ctx, "GET", "/control/filtering/status", nil)
	if err != nil {
		return fmt.Errorf("read filtering status: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("adguard filtering status %d: %s", resp.StatusCode, body)
	}
	var status struct {
		Enabled         bool          `json:"enabled"`
		Interval        int           `json:"interval"`
		Filters         []interface{} `json:"filters"`
		WhitelistFilter []interface{} `json:"whitelist_filters"`
		UserRules       []string      `json:"user_rules"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return fmt.Errorf("decode filtering status: %w", err)
	}

	status.UserRules = rules
	cfg := map[string]interface{}{
		"enabled":           status.Enabled,
		"interval":          status.Interval,
		"filters":           status.Filters,
		"whitelist_filters": status.WhitelistFilter,
		"user_rules":        status.UserRules,
	}

	resp2, err := c.do(ctx, "POST", "/control/filtering/config", cfg)
	if err != nil {
		return fmt.Errorf("set user rules: %w", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp2.Body)
		return fmt.Errorf("adguard filtering config %d: %s", resp2.StatusCode, body)
	}
	return nil
}

// EnsureCustomBlockingMode switches AdGuard to return a custom IP for
// blocked domains (so an HTTP listener there can show a branded page).
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
		Upstreams          []string `json:"upstream_dns"`
		BootstrapDNS       []string `json:"bootstrap_dns"`
		FallbackDNS        []string `json:"fallback_dns"`
		UpstreamMode       string   `json:"upstream_mode"`
		RateLimit          int      `json:"ratelimit"`
		BlockingMode       string   `json:"blocking_mode"`
		BlockingIPv4       string   `json:"blocking_ipv4"`
		BlockingIPv6       string   `json:"blocking_ipv6"`
		BlockedResponseTTL int      `json:"blocked_response_ttl"`
		EDNSCSEnabled      bool     `json:"edns_cs_enabled"`
		DNSSECEnabled      bool     `json:"dnssec_enabled"`
		DisableIPv6        bool     `json:"disable_ipv6"`
		UpstreamDNSFile    bool     `json:"upstream_dns_file"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		return fmt.Errorf("decode dns config: %w", err)
	}
	if cfg.BlockingMode == "custom_ip" && cfg.BlockingIPv4 == ipv4 {
		return nil // already configured
	}
	cfg.BlockingMode = "custom_ip"
	cfg.BlockingIPv4 = ipv4
	if cfg.BlockingIPv6 == "" {
		cfg.BlockingIPv6 = "::"
	}

	resp2, err := c.do(ctx, "POST", "/control/dns_config", cfg)
	if err != nil {
		return fmt.Errorf("set blocking mode: %w", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp2.Body)
		return fmt.Errorf("adguard dns_config set %d: %s", resp2.StatusCode, body)
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
