package adguard

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
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

// QueryLogEntry is one DNS query as recorded by AdGuard Home. Only the fields
// the console needs to build per-peer browsing records are decoded.
type QueryLogEntry struct {
	// Time is when the DNS request was processed (RFC3339Nano, AGH clock).
	Time string `json:"time"`
	// Client is the source IP — for tunnel clients this is the peer's
	// tunnel IP (10.x.y.z), which is how records are attributed to peers.
	Client string `json:"client"`
	// Question is the DNS question block: {"name": "...", "type": "A", ...}.
	Question struct {
		Name string `json:"name"`
	} `json:"question"`
	// Reason is the AdGuard filtering reason (e.g. "FilteredBlackList").
	Reason string `json:"reason"`
	// Rule is the first rule that matched (populated when filtered).
	Rule string `json:"rule"`
	// Cached marks responses served from AdGuard's cache.
	Cached bool `json:"cached"`
}

// IsBlocked reports whether an AGH reason means the query was filtered out
// (i.e. the client did NOT reach the domain). Anything else — including
// NotFiltered*, Rewrite and RewriteEtcHosts/Registry, and empty reasons from
// older versions — counts as an allowed/processed query.
func (e QueryLogEntry) IsBlocked() bool {
	switch e.Reason {
	case "FilteredBlackList",
		"FilteredSafeBrowsing",
		"FilteredParental",
		"FilteredInvalid",
		"FilteredSafeSearch",
		"FilteredBlockedService":
		return true
	}
	return false
}

// GetQueryLog fetches up to limit query-log entries, newest first. When
// olderThan is non-zero only entries strictly older than that instant are
// returned (AdGuard pagination semantics), so the worker walks history back
// page by page with limit entries per call.
func (c *Client) GetQueryLog(ctx context.Context, olderThan time.Time, limit int) ([]QueryLogEntry, error) {
	q := url.Values{}
	q.Set("limit", fmt.Sprintf("%d", limit))
	if !olderThan.IsZero() {
		q.Set("older_than", olderThan.Format(time.RFC3339Nano))
	}
	resp, err := c.do(ctx, "GET", "/control/querylog?"+q.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("querylog request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("adguard querylog %d: %s", resp.StatusCode, body)
	}
	var out struct {
		Data []QueryLogEntry `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode querylog: %w", err)
	}
	return out.Data, nil
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
