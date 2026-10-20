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
		httpClient: &http.Client{Timeout: 10 * time.Second},
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
// and silently ignores everything else.
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
// is both unnecessary and destructive. A read first avoids an unnecessary
// write when already configured. The read goes through /control/dns_info:
// in v0.107.x /control/dns_config is POST-only (a GET returns 405).
func (c *Client) EnsureCustomBlockingMode(ctx context.Context, ipv4 string) error {
	cfg, err := c.GetDNSInfo(ctx)
	if err != nil {
		return fmt.Errorf("read dns config: %w", err)
	}
	if cfg.BlockingMode == "custom_ip" && cfg.BlockingIPv4 == ipv4 {
		return nil // already configured
	}

	body := map[string]interface{}{
		"blocking_mode": "custom_ip",
		"blocking_ipv4": ipv4,
		"blocking_ipv6": "::",
	}
	resp, err := c.do(ctx, "POST", "/control/dns_config", body)
	if err != nil {
		return fmt.Errorf("set blocking mode: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("adguard dns_config set %d: %s", resp.StatusCode, b)
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
// (i.e. the client did NOT reach the domain).
func (e QueryLogEntry) IsBlocked() bool { return isBlockedReason(e.Reason) }

// isBlockedReason reports whether an AdGuard filtering reason means the query
// was blocked. Shared by query-log entries and check_host results.
func isBlockedReason(reason string) bool {
	switch reason {
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

// DNSInfo is the subset of GET /control/dns_info the console cares about.
type DNSInfo struct {
	ProtectionEnabled bool   `json:"protection_enabled"`
	BlockingMode      string `json:"blocking_mode"`
	BlockingIPv4      string `json:"blocking_ipv4"`
	BlockingIPv6      string `json:"blocking_ipv6"`
	CacheTTLMax       uint32 `json:"cache_ttl_max"`
}

// LiveStatus is the live protection state from GET /control/status.
type LiveStatus struct {
	ProtectionEnabled          bool  `json:"protection_enabled"`
	ProtectionDisabledDuration int64 `json:"protection_disabled_duration"`
}

// CheckHostResult is the result of GET /control/filtering/check_host.
type CheckHostResult struct {
	Reason string `json:"reason"`
	Rule   string `json:"rule"`
	Rules  []struct {
		Text         string `json:"text"`
		FilterListID int64  `json:"filter_list_id"`
	} `json:"rules"`
	CanonName   string   `json:"cname"`
	IPList      []string `json:"ip_addrs"`
	ServiceName string   `json:"service_name"`
}

// Blocked reports whether AdGuard's filtering matched a blocking rule.
func (r CheckHostResult) Blocked() bool { return isBlockedReason(r.Reason) }

// Status describes AdGuard Home's live filtering state, used by the console
// to confirm rules really are applied (not just stored in the DB).
type Status struct {
	Reachable bool   `json:"reachable"`
	Error     string `json:"error,omitempty"`
	// FilteringEnabled is the AdGuard "filtering" setting. It is NOT the
	// protection pause: paused protection keeps this true.
	FilteringEnabled bool `json:"filtering_enabled"`
	// ProtectionEnabled is the live protection state (/control/status).
	ProtectionEnabled bool `json:"protection_enabled"`
	// ProtectionDisabledDuration is the remaining pause in milliseconds.
	ProtectionDisabledDuration int64    `json:"protection_disabled_duration"`
	UserRules                  []string `json:"user_rules"`
	IntervalHours              uint32   `json:"interval"`
	BlockMode                  string   `json:"blocking_mode"`
	BlockIPv4                  string   `json:"blocking_ipv4"`
	BlockIPv6                  string   `json:"blocking_ipv6"`
}

// GetStatus reads the full AdGuard state the console needs:
//   - /control/filtering/status: the filtering setting + custom rules
//   - /control/status: live protection state (a pause is NOT the same as the
//     filtering setting — a paused AdGuard still reports enabled=true on
//     /control/filtering/status)
//   - /control/dns_info: blocking mode; also a protection fallback
//
// A connectivity/credential problem is reported in the returned Status
// (Reachable=false + Error) rather than as a Go error, so callers can show it.
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
		Interval  uint32   `json:"interval"`
		UserRules []string `json:"user_rules"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&fs); err != nil {
		st.Error = fmt.Sprintf("decode filtering status: %v", err)
		return st
	}
	st.FilteringEnabled = fs.Enabled
	st.IntervalHours = fs.Interval
	st.UserRules = fs.UserRules

	info, infoErr := c.GetDNSInfo(ctx)
	if infoErr == nil {
		st.BlockMode = info.BlockingMode
		st.BlockIPv4 = info.BlockingIPv4
		st.BlockIPv6 = info.BlockingIPv6
	}

	live, liveErr := c.GetLiveStatus(ctx)
	switch {
	case liveErr == nil:
		st.ProtectionEnabled = live.ProtectionEnabled
		st.ProtectionDisabledDuration = live.ProtectionDisabledDuration
	case infoErr == nil:
		// Older AdGuard builds may not expose /control/status; dns_info echoes
		// the same protection flag.
		st.ProtectionEnabled = info.ProtectionEnabled
	default:
		st.Error = liveErr.Error()
	}

	st.Reachable = true
	return st
}

// GetDNSInfo reads GET /control/dns_info (the DNS settings endpoint; GET
// /control/dns_config does not exist — that path is POST-only).
func (c *Client) GetDNSInfo(ctx context.Context) (DNSInfo, error) {
	var info DNSInfo
	resp, err := c.do(ctx, "GET", "/control/dns_info", nil)
	if err != nil {
		return info, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return info, fmt.Errorf("adguard dns_info %d: %s", resp.StatusCode, body)
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return info, fmt.Errorf("decode dns_info: %w", err)
	}
	return info, nil
}

// GetLiveStatus reads the live protection state from GET /control/status.
func (c *Client) GetLiveStatus(ctx context.Context) (LiveStatus, error) {
	var st LiveStatus
	resp, err := c.do(ctx, "GET", "/control/status", nil)
	if err != nil {
		return st, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return st, fmt.Errorf("adguard status %d: %s", resp.StatusCode, body)
	}
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		return st, fmt.Errorf("decode status: %w", err)
	}
	return st, nil
}

// SetProtection enables or disables AdGuard's protection pause.
func (c *Client) SetProtection(ctx context.Context, enabled bool) error {
	body := map[string]interface{}{"enabled": enabled, "duration": 0}
	resp, err := c.do(ctx, "POST", "/control/protection", body)
	if err != nil {
		return fmt.Errorf("set protection: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("adguard protection set %d: %s", resp.StatusCode, b)
	}
	return nil
}

// SetFilteringEnabled toggles AdGuard's filtering setting. intervalHours must
// be the value currently configured (the API validates it), so callers pass
// status.IntervalHours.
func (c *Client) SetFilteringEnabled(ctx context.Context, enabled bool, intervalHours uint32) error {
	if intervalHours == 0 {
		intervalHours = 24
	}
	body := map[string]interface{}{
		"enabled":  enabled,
		"interval": intervalHours,
	}
	resp, err := c.do(ctx, "POST", "/control/filtering/config", body)
	if err != nil {
		return fmt.Errorf("set filtering config: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("adguard filtering config set %d: %s", resp.StatusCode, b)
	}
	return nil
}

// CheckHost asks AdGuard whether a host is currently blocked (optionally for
// a specific client IP, used for $client= scoped rules).
func (c *Client) CheckHost(ctx context.Context, host, clientIP, qtype string) (CheckHostResult, error) {
	var res CheckHostResult
	q := url.Values{}
	q.Set("name", host)
	if qtype == "" {
		qtype = "A"
	}
	q.Set("qtype", qtype)
	if clientIP != "" {
		q.Set("client", clientIP)
	}

	resp, err := c.do(ctx, "GET", "/control/filtering/check_host?"+q.Encode(), nil)
	if err != nil {
		return res, fmt.Errorf("check_host request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return res, fmt.Errorf("adguard check_host %d: %s", resp.StatusCode, body)
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return res, fmt.Errorf("decode check_host: %w", err)
	}
	return res, nil
}
