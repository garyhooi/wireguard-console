package adguard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newTestClient points a client at srv.
func newTestClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	t.Setenv("ADGUARD_URL", srv.URL)
	t.Setenv("ADGUARD_API_PASSWORD", "test-pass")
	return NewClient()
}

// TestGetStatusReadsLiveProtection verifies that protection_on comes from
// /control/status (the live pause), not /control/filtering/status.enabled
// (the filtering setting), and that blocking mode comes from /control/dns_info
// (GET /control/dns_config does not exist).
func TestGetStatusReadsLiveProtection(t *testing.T) {
	var gotPaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/control/filtering/status":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"enabled": true, "interval": 24, "user_rules": []string{"||youtube.com^"},
			})
		case "/control/status":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"protection_enabled": false, "protection_disabled_duration": 60000,
			})
		case "/control/dns_info":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"protection_enabled": true, "blocking_mode": "custom_ip", "blocking_ipv4": "10.8.0.1",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	st := newTestClient(t, srv).GetStatus(context.Background())
	if !st.Reachable {
		t.Fatalf("Reachable = false, error %q", st.Error)
	}
	if !st.FilteringEnabled {
		t.Error("FilteringEnabled should be true")
	}
	if st.ProtectionEnabled {
		t.Error("ProtectionEnabled should be false (live pause must win over filtering setting)")
	}
	if st.ProtectionDisabledDuration != 60000 {
		t.Errorf("ProtectionDisabledDuration = %d, want 60000", st.ProtectionDisabledDuration)
	}
	if st.BlockMode != "custom_ip" || st.BlockIPv4 != "10.8.0.1" {
		t.Errorf("blocking mode = %q/%q, want custom_ip/10.8.0.1", st.BlockMode, st.BlockIPv4)
	}
	if len(st.UserRules) != 1 || st.UserRules[0] != "||youtube.com^" {
		t.Errorf("user rules = %v", st.UserRules)
	}
}

func TestEnsureCustomBlockingModeUsesDNSInfo(t *testing.T) {
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/control/dns_info":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"blocking_mode": "custom_ip", "blocking_ipv4": "10.8.0.1",
			})
		case "/control/dns_config":
			posts++
			if r.Method != http.MethodPost {
				t.Errorf("dns_config method = %s, want POST", r.Method)
			}
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["blocking_mode"] != "custom_ip" || body["blocking_ipv4"] != "10.8.0.1" {
				t.Errorf("unexpected dns_config body: %v", body)
			}
		}
	}))
	defer srv.Close()

	client := newTestClient(t, srv)
	if err := client.EnsureCustomBlockingMode(context.Background(), "10.8.0.1"); err != nil {
		t.Fatalf("EnsureCustomBlockingMode: %v", err)
	}
	if posts != 0 {
		t.Fatalf("already-configured blocking mode issued %d POST(s), want 0", posts)
	}
}

func TestCheckHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/control/filtering/check_host" {
			t.Errorf("path = %q", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("name") != "www.youtube.com" || q.Get("qtype") != "A" || q.Get("client") != "10.8.0.2" {
			t.Errorf("unexpected query: %v", q)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"reason": "FilteredBlackList",
			"rule":   "||youtube.com^",
			"rules":  []map[string]interface{}{{"text": "||youtube.com^", "filter_list_id": 1}},
		})
	}))
	defer srv.Close()

	res, err := newTestClient(t, srv).CheckHost(context.Background(), "www.youtube.com", "10.8.0.2", "A")
	if err != nil {
		t.Fatalf("CheckHost: %v", err)
	}
	if !res.Blocked() {
		t.Errorf("Blocked() = false, reason %q", res.Reason)
	}
	if res.Rule != "||youtube.com^" || len(res.Rules) != 1 {
		t.Errorf("unexpected result: %+v", res)
	}
}

func TestSetProtectionAndFiltering(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/control/protection":
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["enabled"] != true {
				t.Errorf("protection body = %v", body)
			}
		case "/control/filtering/config":
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["enabled"] != true || body["interval"] != float64(24) {
				t.Errorf("filtering config body = %v", body)
			}
		}
	}))
	defer srv.Close()

	client := newTestClient(t, srv)
	if err := client.SetProtection(context.Background(), true); err != nil {
		t.Fatalf("SetProtection: %v", err)
	}
	if err := client.SetFilteringEnabled(context.Background(), true, 24); err != nil {
		t.Fatalf("SetFilteringEnabled: %v", err)
	}
}
