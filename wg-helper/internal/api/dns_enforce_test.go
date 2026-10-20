package api

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// findOrdered fails when one of the needles is missing or occurs out of order
// in s.
func findOrdered(t *testing.T, s string, needles ...string) {
	t.Helper()
	last := -1
	for _, needle := range needles {
		pos := strings.Index(s, needle)
		if pos < 0 {
			t.Fatalf("rendered script is missing %q", needle)
		}
		if pos <= last {
			t.Fatalf("rendered script has %q out of order", needle)
		}
		last = pos
	}
}

var logRulePattern = regexp.MustCompile("\\blog\\b")

// assertNoLogRules guards the design decision to use counters only: an nft log
// rule would make the kernel need extra modules. A warning-level event is
// enough, so no log statement may appear in any rendered script.
func assertNoLogRules(t *testing.T, script string) {
	t.Helper()
	if loc := logRulePattern.FindStringIndex(script); loc != nil {
		t.Fatalf("rendered script contains a log rule at offset %d", loc[0])
	}
}

func TestRenderDNSEnforcementV4(t *testing.T) {
	script, err := renderDNSEnforcementV4("wg0", "10.8.0.0/24")
	if err != nil {
		t.Fatalf("renderDNSEnforcementV4: %v", err)
	}

	// One atomic transaction: add the table, delete the old incarnation,
	// then redefine it.
	findOrdered(t, script,
		"table ip wgc_dns_wg0",
		"delete table ip wgc_dns_wg0",
		"table ip wgc_dns_wg0 {",
	)
	if got := strings.Count(script, "table ip wgc_dns_wg0 {"); got != 1 {
		t.Fatalf("expected exactly one table definition, got %d", got)
	}

	// Non-empty DoH resolver set containing every configured IPv4 endpoint.
	if len(dohV4) == 0 {
		t.Fatal("dohV4 blocklist is empty")
	}
	if !strings.Contains(script, "set doh_v4 {") || !strings.Contains(script, "type ipv4_addr") || !strings.Contains(script, "flags interval") {
		t.Fatalf("missing doh_v4 interval set:\n%s", script)
	}
	for _, ip := range dohV4 {
		if !strings.Contains(script, ip) {
			t.Errorf("doh_v4 set is missing %s", ip)
		}
	}

	// Plain DNS is redirected to AdGuard for both UDP and TCP.
	for _, proto := range []string{"udp", "tcp"} {
		want := "iifname \"wg0\" ip saddr 10.8.0.0/24 " + proto + " dport 53 counter redirect to :53"
		if !strings.Contains(script, want) {
			t.Errorf("missing redirect rule %q", want)
		}
	}

	// DoT / DoQ drops.
	for _, proto := range []string{"tcp", "udp"} {
		want := "iifname \"wg0\" ip saddr 10.8.0.0/24 " + proto + " dport 853 counter drop"
		if !strings.Contains(script, want) {
			t.Errorf("missing %s/853 drop rule %q", proto, want)
		}
	}

	// DoH / DoH3 drops to the known resolver set.
	for _, proto := range []string{"tcp", "udp"} {
		want := "iifname \"wg0\" ip saddr 10.8.0.0/24 ip daddr @doh_v4 " + proto + " dport 443 counter drop"
		if !strings.Contains(script, want) {
			t.Errorf("missing %s/443 DoH drop rule %q", proto, want)
		}
	}

	// Shared Cloudflare CDN ranges must never be blocked: they also serve
	// ordinary websites.
	if strings.Contains(script, "104.16.") {
		t.Error("rendered script blocks the shared Cloudflare CDN range")
	}

	assertNoLogRules(t, script)
}

func TestRenderDNSEnforcementV4ScopesInterfaceAndSubnet(t *testing.T) {
	script, err := renderDNSEnforcementV4("wg1", "10.9.0.0/24")
	if err != nil {
		t.Fatalf("renderDNSEnforcementV4: %v", err)
	}
	if !strings.Contains(script, "table ip wgc_dns_wg1") {
		t.Error("table name does not follow the interface")
	}
	if !strings.Contains(script, "iifname \"wg1\" ip saddr 10.9.0.0/24 ") {
		t.Error("rules are not scoped to the requested interface and subnet")
	}
}

func TestRenderDNSEnforcementV4RejectsNonIPv4CIDR(t *testing.T) {
	for _, cidr := range []string{"", "10.8.0.0", "10.8.0.0/33", "not-a-cidr", "fd00::/64"} {
		if _, err := renderDNSEnforcementV4("wg0", cidr); err == nil {
			t.Errorf("expected an error for CIDR %q", cidr)
		}
	}
}

func TestRenderDNSEnforcementV6(t *testing.T) {
	script := renderDNSEnforcementV6("wg0")

	findOrdered(t, script,
		"table ip6 wgc_dns6_wg0",
		"delete table ip6 wgc_dns6_wg0",
		"table ip6 wgc_dns6_wg0 {",
	)
	if got := strings.Count(script, "table ip6 wgc_dns6_wg0 {"); got != 1 {
		t.Fatalf("expected exactly one table definition, got %d", got)
	}

	if len(dohV6) == 0 {
		t.Fatal("dohV6 blocklist is empty")
	}
	if !strings.Contains(script, "set doh_v6 {") || !strings.Contains(script, "type ipv6_addr") || !strings.Contains(script, "flags interval") {
		t.Fatalf("missing doh_v6 interval set:\n%s", script)
	}
	for _, ip := range dohV6 {
		if !strings.Contains(script, ip) {
			t.Errorf("doh_v6 set is missing %s", ip)
		}
	}

	// No IPv6 AdGuard listener: plain v6 DNS is dropped, never redirected.
	if strings.Contains(script, "counter redirect") {
		t.Error("IPv6 table must not redirect plain DNS")
	}
	for _, proto := range []string{"udp", "tcp"} {
		want := "iifname \"wg0\" " + proto + " dport 53 counter drop"
		if !strings.Contains(script, want) {
			t.Errorf("missing %s/53 drop rule %q", proto, want)
		}
		dot := "iifname \"wg0\" " + proto + " dport 853 counter drop"
		if !strings.Contains(script, dot) {
			t.Errorf("missing %s/853 drop rule %q", proto, dot)
		}
		doh := "iifname \"wg0\" ip6 daddr @doh_v6 " + proto + " dport 443 counter drop"
		if !strings.Contains(script, doh) {
			t.Errorf("missing %s/443 DoH drop rule %q", proto, doh)
		}
	}

	assertNoLogRules(t, script)
}

func TestSanitizeTableName(t *testing.T) {
	v4Pattern := regexp.MustCompile("^wgc_dns_[a-z0-9_]+$")
	v6Pattern := regexp.MustCompile("^wgc_dns6_[a-z0-9_]+$")
	hashSuffix := regexp.MustCompile("_[0-9a-f]{8}$")

	v4, v6 := sanitizeTableName("wg0")
	if v4 != "wgc_dns_wg0" || v6 != "wgc_dns6_wg0" {
		t.Fatalf("wg0 should not need sanitizing, got %q / %q", v4, v6)
	}

	for _, in := range []string{"wg-0", "Br-LAN!", "WG0", "wg.0", "interface name"} {
		v4, v6 = sanitizeTableName(in)
		if !v4Pattern.MatchString(v4) || !v6Pattern.MatchString(v6) {
			t.Errorf("%q: invalid nft table name %q / %q", in, v4, v6)
		}
		if !hashSuffix.MatchString(v4) || !hashSuffix.MatchString(v6) {
			t.Errorf("%q: expected a deterministic hash suffix, got %q / %q", in, v4, v6)
		}
		sum := sha256.Sum256([]byte(in))
		wantSuffix := "_" + hex.EncodeToString(sum[:4])
		if !strings.HasSuffix(v4, wantSuffix) || !strings.HasSuffix(v6, wantSuffix) {
			t.Errorf("%q: hash suffix does not match sha256 of the original name", in)
		}
		v4Again, v6Again := sanitizeTableName(in)
		if v4 != v4Again || v6 != v6Again {
			t.Errorf("%q: sanitizeTableName is not deterministic", in)
		}
	}

	// Distinct originals that sanitize to the same base must not collide.
	a4, _ := sanitizeTableName("Br-LAN!")
	b4, _ := sanitizeTableName("Br_LAN!")
	if a4 == b4 {
		t.Fatalf("sanitized names collide: %q", a4)
	}

	// Long names stay inside the allowed alphabet and remain deterministic.
	long := strings.Repeat("Very-Long-Interface-Name-", 8) + "!"
	lv4, lv6 := sanitizeTableName(long)
	if !v4Pattern.MatchString(lv4) || !v6Pattern.MatchString(lv6) {
		t.Fatalf("long name produced invalid table names %q / %q", lv4, lv6)
	}
	if !hashSuffix.MatchString(lv4) || !hashSuffix.MatchString(lv6) {
		t.Fatalf("long changed name should carry a hash suffix, got %q / %q", lv4, lv6)
	}
}

func TestEnsureDNSEnforcementDisabled(t *testing.T) {
	t.Setenv("WG_DNS_ENFORCE", "0")
	old := nftPath
	nftPath = filepath.Join(t.TempDir(), "does-not-exist")
	defer func() { nftPath = old }()

	if err := EnsureDNSEnforcement("wg0", "10.8.0.0/24"); err != nil {
		t.Fatalf("expected enforcement to be disabled, got %v", err)
	}
}

func TestEnsureDNSEnforcementRejectsBadCIDR(t *testing.T) {
	t.Setenv("WG_DNS_ENFORCE", "1")
	if err := EnsureDNSEnforcement("wg0", "10.8.0.0"); err == nil {
		t.Fatal("expected an error for a CIDR without a prefix length")
	}
}

func TestEnsureDNSEnforcementMissingNFT(t *testing.T) {
	t.Setenv("WG_DNS_ENFORCE", "1")
	t.Setenv("PATH", t.TempDir())
	old := nftPath
	nftPath = filepath.Join(t.TempDir(), "missing-nft")
	defer func() { nftPath = old }()

	err := EnsureDNSEnforcement("wg0", "10.8.0.0/24")
	if err == nil {
		t.Fatal("expected an error when nft is unavailable")
	}
	if !strings.Contains(err.Error(), "nft not found (install nftables in the wg-helper image)") {
		t.Fatalf("error should tell the operator to install nftables, got: %v", err)
	}
}

// TestEnsureAndRemoveDNSEnforcementInvokeNFT swaps nftPath for a fake binary
// and checks the exact argument shape of the ensure/remove invocations.
func TestEnsureAndRemoveDNSEnforcementInvokeNFT(t *testing.T) {
	t.Setenv("WG_DNS_ENFORCE", "1")
	dir := t.TempDir()
	record := filepath.Join(dir, "nft-calls")
	fake := filepath.Join(dir, "fake-nft")
	body := "#!/bin/sh\necho \"$*\" >> " + record + "\ncat > /dev/null\n"
	if err := os.WriteFile(fake, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake nft: %v", err)
	}
	old := nftPath
	nftPath = fake
	defer func() { nftPath = old }()

	// Ensure also asserts the ufw INPUT admission rule; stub iptables too.
	iptFake := filepath.Join(dir, "fake-iptables")
	if err := os.WriteFile(iptFake, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake iptables: %v", err)
	}
	oldIpt := iptablesPath
	iptablesPath = iptFake
	defer func() { iptablesPath = oldIpt }()

	if err := EnsureDNSEnforcement("wg0", "10.8.0.0/24"); err != nil {
		t.Fatalf("EnsureDNSEnforcement: %v", err)
	}
	calls := readNFTCalls(t, record)
	if len(calls) != 2 {
		t.Fatalf("expected one nft call per family, got %v", calls)
	}
	for _, call := range calls {
		if call != "-f -" {
			t.Errorf("unexpected nft ensure invocation %q", call)
		}
	}

	if err := os.Remove(record); err != nil {
		t.Fatalf("reset call record: %v", err)
	}
	if err := RemoveDNSEnforcement("wg0"); err != nil {
		t.Fatalf("RemoveDNSEnforcement: %v", err)
	}
	calls = readNFTCalls(t, record)
	want := []string{"delete table ip wgc_dns_wg0", "delete table ip6 wgc_dns6_wg0"}
	if len(calls) != len(want) {
		t.Fatalf("unexpected remove invocations: %v", calls)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Errorf("remove invocation %d = %q, want %q", i, calls[i], want[i])
		}
	}
}

// TestEnsureDNSEnforcementAddsInputAcceptance checks the ufw INPUT admission
// fix: redirected DNS becomes host-local INPUT traffic, so wg+ :53 must be
// accepted ahead of ufw's default-deny chain, idempotently.
func TestEnsureDNSEnforcementAddsInputAcceptance(t *testing.T) {
	t.Setenv("WG_DNS_ENFORCE", "1")
	dir := t.TempDir()

	nftFake := filepath.Join(dir, "fake-nft")
	nftScript := "#!/bin/sh\necho \"$*\" >> /dev/null\ncat > /dev/null\n"
	if err := os.WriteFile(nftFake, []byte(nftScript), 0o755); err != nil {
		t.Fatalf("write fake nft: %v", err)
	}

	iptRecord := filepath.Join(dir, "ipt-calls")
	iptFake := filepath.Join(dir, "fake-iptables")
	// -C always fails (rule missing) until the test rewrites the script.
	missingRule := "#!/bin/sh\necho \"$*\" >> " + iptRecord + "\ncase \"$1\" in -C) exit 1 ;; *) exit 0 ;; esac\n"
	if err := os.WriteFile(iptFake, []byte(missingRule), 0o755); err != nil {
		t.Fatalf("write fake iptables: %v", err)
	}

	oldNft, oldIpt := nftPath, iptablesPath
	nftPath, iptablesPath = nftFake, iptFake
	defer func() { nftPath, iptablesPath = oldNft, oldIpt }()

	if err := EnsureDNSEnforcement("wg0", "10.8.0.0/24"); err != nil {
		t.Fatalf("EnsureDNSEnforcement: %v", err)
	}
	got := readNFTCalls(t, iptRecord)
	expected := []string{
		"-C INPUT -i wg+ -p udp --dport 53 -j ACCEPT",
		"-I INPUT 1 -i wg+ -p udp --dport 53 -j ACCEPT",
		"-C INPUT -i wg+ -p tcp --dport 53 -j ACCEPT",
		"-I INPUT 1 -i wg+ -p tcp --dport 53 -j ACCEPT",
	}
	if len(got) != len(expected) {
		t.Fatalf("iptables calls = %v, want %v", got, expected)
	}
	for i := range expected {
		if got[i] != expected[i] {
			t.Errorf("iptables call %d = %q, want %q", i, got[i], expected[i])
		}
	}

	// Once the rule exists (-C succeeds), a second ensure must not add again.
	presentRule := "#!/bin/sh\necho \"$*\" >> " + iptRecord + "\nexit 0\n"
	if err := os.WriteFile(iptFake, []byte(presentRule), 0o755); err != nil {
		t.Fatalf("rewrite fake iptables: %v", err)
	}
	if err := os.Remove(iptRecord); err != nil {
		t.Fatalf("reset iptables record: %v", err)
	}
	if err := EnsureDNSEnforcement("wg0", "10.8.0.0/24"); err != nil {
		t.Fatalf("EnsureDNSEnforcement (second): %v", err)
	}
	second := readNFTCalls(t, iptRecord)
	if len(second) != 2 {
		t.Fatalf("second ensure iptables calls = %v, want only the two -C probes", second)
	}
	for _, call := range second {
		if !strings.HasPrefix(call, "-C ") {
			t.Errorf("second ensure ran non-probe iptables call %q", call)
		}
	}
}

func readNFTCalls(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read nft call record: %v", err)
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "\n")
}
