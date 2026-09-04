package adguard

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestQueryLogEntry_IsBlocked(t *testing.T) {
	cases := []struct {
		reason string
		want   bool
	}{
		{"FilteredBlackList", true},
		{"FilteredSafeBrowsing", true},
		{"FilteredParental", true},
		{"FilteredInvalid", true},
		{"FilteredSafeSearch", true},
		{"FilteredBlockedService", true},
		// Allowed / processed outcomes.
		{"NotFilteredNotFound", false},
		{"NotFilteredWhiteList", false},
		{"NotFilteredError", false},
		{"Rewrite", false},
		{"RewriteEtcHosts", false},
		{"RewriteRule", false},
		{"", false}, // older AGH entries may omit reason
	}
	for _, c := range cases {
		if got := (QueryLogEntry{Reason: c.reason}).IsBlocked(); got != c.want {
			t.Errorf("IsBlocked(%q) = %v, want %v", c.reason, got, c.want)
		}
	}
}

func TestGetQueryLog_DecodesEntries(t *testing.T) {
	body := `{
		"oldest": "2026-01-01T00:00:00Z",
		"data": [
			{
				"time": "2026-02-01T10:00:00.123456789Z",
				"client": "10.8.0.2",
				"question": {"name": "www.Example.com.", "type": "A", "class": "IN"},
				"reason": "FilteredBlackList",
				"rule": "||example.com^",
				"cached": false
			},
			{
				"time": "2026-02-01T09:59:59Z",
				"client": "10.8.0.3",
				"question": {"name": "api.github.com"},
				"reason": "NotFilteredNotFound"
			}
		]
	}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/control/querylog" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "500" {
			t.Errorf("limit = %q, want 500", got)
		}
		if got := r.URL.Query().Get("older_than"); got != "" {
			t.Errorf("older_than = %q, want empty on first page", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(body))
	}))
	defer srv.Close()

	oldURL := os.Getenv("ADGUARD_URL")
	os.Setenv("ADGUARD_URL", srv.URL)
	defer os.Setenv("ADGUARD_URL", oldURL)

	entries, err := NewClient().GetQueryLog(context.Background(), time.Time{}, 500)
	if err != nil {
		t.Fatalf("GetQueryLog: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	e := entries[0]
	if e.Question.Name != "www.Example.com." {
		t.Errorf("host = %q", e.Question.Name)
	}
	if e.Reason != "FilteredBlackList" || !e.IsBlocked() {
		t.Errorf("entry 0 should be blocked: reason=%q blocked=%v", e.Reason, e.IsBlocked())
	}
	if e.Rule != "||example.com^" {
		t.Errorf("rule = %q", e.Rule)
	}
	if entries[1].IsBlocked() {
		t.Error("entry 1 (NotFilteredNotFound) should not be blocked")
	}
}
