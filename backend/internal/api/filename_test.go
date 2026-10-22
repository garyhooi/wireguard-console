package api

import (
	"regexp"
	"strings"
	"testing"
)

func TestConfigFileName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"space", "AI Agent", "ai-agent.conf"},
		{"padded spaces", "  AI   Agent  ", "ai-agent.conf"},
		{"double space collapse", "My  VPN", "my-vpn.conf"},
		{"apostrophe", "John's Device", "john-s-device.conf"},
		{"parentheses", "VPN (Work)", "vpn-work.conf"},
		{"underscore", "my_tunnel", "my-tunnel.conf"},
		{"path traversal", "../../etc/passwd", "etc-passwd.conf"},
		{"non-ascii", "我的设备", "wireguard.conf"},
		{"empty", "", "wireguard.conf"},
		{"only punctuation", ".-.-.", "wireguard.conf"},
		{"already a slug", "office-laptop", "office-laptop.conf"},
		{"mixed case and digits", "Peer 42B", "peer-42b.conf"},
		{"surrounding tabs and newlines", "\t\n Laptop \r\n", "laptop.conf"},
		// ASCII-only lowercasing keeps this identical to the frontend helper
		// (Unicode full case mapping would yield "i-x.conf" in JS).
		{"unicode special casing", "İx", "x.conf"},
	}
	for _, c := range cases {
		if got := configFileName(c.in); got != c.want {
			t.Errorf("configFileName(%q) = %q, want %q (%s)", c.in, got, c.want, c.name)
		}
	}

	// Truncation: the base is capped at 64 characters before ".conf".
	if got, want := configFileName(strings.Repeat("a", 80)), strings.Repeat("a", 64)+".conf"; got != want {
		t.Errorf("configFileName(80 x 'a') = %q, want %q", got, want)
	}

	// A cut landing on a '-' must be trimmed again after capping.
	got := configFileName(strings.Repeat("a", 63) + " bbb")
	want := strings.Repeat("a", 63) + ".conf"
	if got != want {
		t.Errorf("configFileName(63 x 'a' + ' bbb') = %q, want %q (trailing '-' after cap must be trimmed)", got, want)
	}
}

func TestConfigFileNameInvariants(t *testing.T) {
	valid := regexp.MustCompile("^[a-z0-9-]+\\.conf$")
	inputs := []string{
		"AI Agent",
		"  AI   Agent  ",
		"John's Device",
		"VPN (Work)",
		"my_tunnel",
		"../../etc/passwd",
		"我的设备",
		"",
		"   ",
		"A  B",
		"UPPER lower 123",
		"quote\"name'",
		"back\\slash",
		"tab\tname",
		"line\nbreak",
		"emoji 🚀 peer",
		strings.Repeat("a", 80),
		strings.Repeat("-", 10),
		"peer/../../etc/shadow",
	}
	for _, in := range inputs {
		got := configFileName(in)
		if !valid.MatchString(got) {
			t.Errorf("configFileName(%q) = %q does not match %s", in, got, valid)
		}
		if strings.ContainsAny(got, " \t\n\r\"'\\/_") {
			t.Errorf("configFileName(%q) = %q contains a forbidden character", in, got)
		}
		base := strings.TrimSuffix(got, ".conf")
		if len(base) > 64 {
			t.Errorf("configFileName(%q) = %q: slug base longer than 64 characters", in, got)
		}
		if strings.HasPrefix(base, "-") || strings.HasSuffix(base, "-") {
			t.Errorf("configFileName(%q) = %q: slug base has a leading or trailing '-'", in, got)
		}
	}
}
