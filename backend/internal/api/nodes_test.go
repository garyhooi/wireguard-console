package api

import (
	"encoding/json"
	"testing"
)

func TestAgentVersionInfo(t *testing.T) {
	withHost := func(v string) json.RawMessage {
		b, _ := json.Marshal(map[string]interface{}{
			"host": map[string]string{"agent_version": v},
		})
		return b
	}

	cases := []struct {
		name       string
		consoleVer string // APP_VERSION the console runs as
		metrics    json.RawMessage
		wantVer    string
		wantMism   bool
	}{
		{"no host block", "1.2.3", json.RawMessage(`{"cpu":{"percent":5}}`), "", false},
		{"no metrics", "1.2.3", nil, "", false},
		{"empty agent version", "1.2.3", withHost(""), "", false},
		{"dev agent never mismatches", "1.2.3", withHost("dev"), "dev", false},
		{"matching version", "1.2.3", withHost("1.2.3"), "1.2.3", false},
		{"older agent mismatches", "1.2.3", withHost("1.2.0"), "1.2.0", true},
		{"newer agent mismatches too", "1.2.3", withHost("1.3.0"), "1.3.0", true},
		{"v-prefixed agent matches bare console", "1.2.3", withHost("v1.2.3"), "v1.2.3", false},
		{"console dev never flags", "dev", withHost("1.2.0"), "1.2.0", false},
		{"console empty never flags", "", withHost("1.2.0"), "1.2.0", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("APP_VERSION", c.consoleVer)
			got, mism := agentVersionInfo(c.metrics)
			if got != c.wantVer || mism != c.wantMism {
				t.Fatalf("agentVersionInfo = (%q, %v), want (%q, %v)", got, mism, c.wantVer, c.wantMism)
			}
		})
	}
}
