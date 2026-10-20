package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeNFT installs a fake nft binary that records its arguments and consumes
// stdin on "-f -" invocations, returning the record path.
func fakeNFT(t *testing.T) (record string) {
	t.Helper()
	dir := t.TempDir()
	record = filepath.Join(dir, "nft-calls")
	fake := filepath.Join(dir, "fake-nft")
	body := "#!/bin/sh\necho \"$*\" >> " + record + "\ncat > /dev/null 2>/dev/null || true\n"
	if err := os.WriteFile(fake, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake nft: %v", err)
	}
	old := nftPath
	nftPath = fake
	t.Cleanup(func() { nftPath = old })
	return record
}

func TestSplitIPBlockRules(t *testing.T) {
	v4, v6, warnings := splitIPBlockRules([]ipBlockRule{
		{SourceIP: "", CIDR: "203.0.113.9/24"},        // canonicalised to .0/24
		{SourceIP: "", CIDR: "203.0.113.0/24"},        // duplicate after canon
		{SourceIP: "10.8.0.2", CIDR: "198.51.100.7"},  // bare IP -> /32
		{SourceIP: "", CIDR: "2001:DB8:bad::/48"},     // v6 + lowercased
		{SourceIP: "10.8.0.2", CIDR: "2001:db8::/48"}, // mixed family -> warned
		{SourceIP: "", CIDR: "not-a-cidr"},            // invalid -> warned
		{SourceIP: "nope", CIDR: "192.0.2.1/32"},      // bad source -> warned
	})
	if len(v4) != 2 {
		t.Fatalf("v4 = %v, want 2 canonical unique entries", v4)
	}
	if v4[0].CIDR != "203.0.113.0/24" || v4[1].CIDR != "198.51.100.7/32" {
		t.Errorf("v4 canonicalisation wrong: %v", v4)
	}
	if len(v6) != 1 || v6[0].CIDR != "2001:db8:bad::/48" {
		t.Errorf("v6 = %v, want 2001:db8:bad::/48", v6)
	}
	if len(warnings) != 3 {
		t.Errorf("warnings = %v, want 3 (mixed family, bad CIDR, bad source)", warnings)
	}
}

func TestRenderIPBlockTableV4(t *testing.T) {
	rules := []ipBlockRule{
		{SourceIP: "", CIDR: "203.0.113.0/24"},
		{SourceIP: "10.8.0.2", CIDR: "198.51.100.0/24"},
		{SourceIP: "10.8.0.3", CIDR: "10.0.0.0/8"},
	}
	script, hasRules := renderIPBlockTable("wg0", true, rules)
	if !hasRules {
		t.Fatal("hasRules = false, want true")
	}
	for _, want := range []string{
		"table ip wgc_ipblk_wg0",
		"delete table ip wgc_ipblk_wg0",
		"type ipv4_addr",
		"flags interval",
		"set blocked",
		"203.0.113.0/24",
		"198.51.100.0/24",
		"10.0.0.0/8",
		"priority -140",
		"iifname \"wg0\" ip daddr @blocked counter drop",
		"ip saddr 10.8.0.2 ip daddr @src_",
		"ip saddr 10.8.0.3 ip daddr @src_",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("script missing %q", want)
		}
	}
	// Atomic ordering: "table ip X" then "delete table ip X" then definition.
	if strings.Index(script, "delete table ip wgc_ipblk_wg0") > strings.Index(script, "table ip wgc_ipblk_wg0 {") {
		t.Error("delete must come before the table definition")
	}
	// Sources are sorted, sets are deterministic, and no log rules exist.
	if strings.Index(script, "10.8.0.2") > strings.Index(script, "10.8.0.3") {
		t.Error("source rules are not sorted")
	}
	if strings.Contains(script, " log ") {
		t.Error("IP blocking must use counters only, never nft log rules")
	}
	if !strings.Contains(script, ipBlockSourceSetName("10.8.0.2")) {
		t.Error("per-source set name is not the deterministic helper value")
	}
}

func TestRenderIPBlockTableV6(t *testing.T) {
	rules := []ipBlockRule{
		{SourceIP: "", CIDR: "2001:db8:bad::/48"},
	}
	script, hasRules := renderIPBlockTable("wg0", false, rules)
	if !hasRules {
		t.Fatal("hasRules = false, want true")
	}
	for _, want := range []string{
		"table ip6 wgc_ipblk6_wg0",
		"delete table ip6 wgc_ipblk6_wg0",
		"type ipv6_addr",
		"2001:db8:bad::/48",
		"iifname \"wg0\" ip6 daddr @blocked counter drop",
		"priority -140",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("v6 script missing %q", want)
		}
	}
	if strings.Contains(script, "203.0.113") {
		t.Error("v6 script must not contain IPv4 destinations")
	}
}

func TestRenderIPBlockTableEmpty(t *testing.T) {
	script, hasRules := renderIPBlockTable("wg0", true, nil)
	if hasRules {
		t.Error("empty family must report hasRules=false")
	}
	if strings.Contains(script, "counter drop") {
		t.Error("empty ruleset must not contain drop rules")
	}
}

func TestEnsureIPBlockingBothFamilies(t *testing.T) {
	t.Setenv("WG_IP_BLOCK", "1")
	record := fakeNFT(t)

	rules := []ipBlockRule{
		{SourceIP: "", CIDR: "203.0.113.0/24"},
		{SourceIP: "", CIDR: "2001:db8:bad::/48"},
	}
	warnings, err := EnsureIPBlocking("wg0", rules)
	if err != nil {
		t.Fatalf("EnsureIPBlocking: %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	calls := readNFTCalls(t, record)
	if len(calls) != 2 {
		t.Fatalf("nft calls = %v, want two script applies (v4 + v6)", calls)
	}
	for _, call := range calls {
		if call != "-f -" {
			t.Errorf("unexpected nft invocation %q", call)
		}
	}
}

func TestEnsureIPBlockingV4OnlyDeletesV6Table(t *testing.T) {
	t.Setenv("WG_IP_BLOCK", "1")
	record := fakeNFT(t)

	if _, err := EnsureIPBlocking("wg0", []ipBlockRule{{CIDR: "203.0.113.0/24"}}); err != nil {
		t.Fatalf("EnsureIPBlocking: %v", err)
	}
	calls := readNFTCalls(t, record)
	want := []string{"-f -", "delete table ip6 wgc_ipblk6_wg0"}
	if len(calls) != len(want) {
		t.Fatalf("nft calls = %v, want %v", calls, want)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Errorf("call %d = %q, want %q", i, calls[i], want[i])
		}
	}
}

func TestEnsureIPBlockingEmptyDeletesBothTables(t *testing.T) {
	t.Setenv("WG_IP_BLOCK", "1")
	record := fakeNFT(t)

	if _, err := EnsureIPBlocking("wg0", nil); err != nil {
		t.Fatalf("EnsureIPBlocking: %v", err)
	}
	calls := readNFTCalls(t, record)
	want := []string{"delete table ip wgc_ipblk_wg0", "delete table ip6 wgc_ipblk6_wg0"}
	if len(calls) != len(want) {
		t.Fatalf("nft calls = %v, want %v", calls, want)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Errorf("call %d = %q, want %q", i, calls[i], want[i])
		}
	}
}

func TestIPBlockKillSwitchRemovesTables(t *testing.T) {
	t.Setenv("WG_IP_BLOCK", "0")
	record := fakeNFT(t)

	if _, err := EnsureIPBlocking("wg0", []ipBlockRule{{CIDR: "203.0.113.0/24"}}); err != nil {
		t.Fatalf("EnsureIPBlocking (disabled): %v", err)
	}
	calls := readNFTCalls(t, record)
	if len(calls) != 2 {
		t.Fatalf("nft calls = %v, want two table deletes and no apply", calls)
	}
	for _, call := range calls {
		if !strings.HasPrefix(call, "delete table ") {
			t.Errorf("disabled enforcement must only delete tables, got %q", call)
		}
	}
}

func TestRemoveIPBlocking(t *testing.T) {
	record := fakeNFT(t)
	if err := RemoveIPBlocking("wg0"); err != nil {
		t.Fatalf("RemoveIPBlocking: %v", err)
	}
	calls := readNFTCalls(t, record)
	want := []string{"delete table ip wgc_ipblk_wg0", "delete table ip6 wgc_ipblk6_wg0"}
	if len(calls) != len(want) {
		t.Fatalf("nft calls = %v, want %v", calls, want)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Errorf("call %d = %q, want %q", i, calls[i], want[i])
		}
	}
}

func TestIPBlockTableNameSanitizesInterface(t *testing.T) {
	v4a, v6a := guardTableNames(ipBlockTablePrefixV4, ipBlockTablePrefixV6, "Br-LAN!")
	if strings.ContainsAny(v4a, "-!A-Z") || strings.ContainsAny(v6a, "-!A-Z") {
		t.Errorf("unsanitized table names: %q %q", v4a, v6a)
	}
	v4b, _ := guardTableNames(ipBlockTablePrefixV4, ipBlockTablePrefixV6, "Br_LAN!")
	if v4a == v4b {
		t.Error("sanitized interface names must not collide")
	}
	if got := ipBlockSourceSetName("10.8.0.2"); got != ipBlockSourceSetName("10.8.0.2") {
		t.Error("set names must be deterministic")
	}
}
