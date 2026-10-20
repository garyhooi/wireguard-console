package api

import "testing"

func TestNormalizeIPRuleCIDR(t *testing.T) {
	valid := []struct{ in, want string }{
		{"203.0.113.0/24", "203.0.113.0/24"},
		{"10.1.2.5/24", "10.1.2.0/24"},     // host bits canonicalised
		{"203.0.113.7", "203.0.113.7/32"},  // bare IPv4 becomes /32
		{"2001:DB8::1", "2001:db8::1/128"}, // bare IPv6 + lowercased
		{"2001:db8::/48", "2001:db8::/48"},
		{"192.0.2.0/24", "192.0.2.0/24"},
		{"169.254.169.254", "169.254.169.254/32"}, // metadata address is allowed
		{"224.0.0.251", "224.0.0.251/32"},         // mDNS is a legit block target
		{" 198.51.100.9/32 ", "198.51.100.9/32"},
	}
	for _, c := range valid {
		got, err := normalizeIPRuleCIDR(c.in)
		if err != nil {
			t.Errorf("normalizeIPRuleCIDR(%q): unexpected error: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("normalizeIPRuleCIDR(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	invalid := []string{
		"", " ", "not-an-ip", "300.1.2.3", "10.0.0.0/33", "2001:db8::/129",
		"0.0.0.0/0", "::/0", "0.0.0.0", "::", "127.0.0.1", "127.0.0.0/8", "::1",
	}
	for _, in := range invalid {
		if _, err := normalizeIPRuleCIDR(in); err == nil {
			t.Errorf("normalizeIPRuleCIDR(%q): expected an error", in)
		}
	}
}

func TestCIDRHelpers(t *testing.T) {
	if !cidrContains("10.8.0.0/24", "10.8.0.1") {
		t.Error("cidrContains should match a gateway inside the tunnel CIDR")
	}
	if cidrContains("10.8.0.0/24", "10.9.0.1") {
		t.Error("cidrContains should not match another subnet")
	}
	if !cidrIsIPv4("10.8.0.0/24") || cidrIsIPv4("2001:db8::/48") {
		t.Error("cidrIsIPv4 misclassified a CIDR")
	}
	if !isIPv4Address("10.8.0.2") || isIPv4Address("2001:db8::2") {
		t.Error("isIPv4Address misclassified an address")
	}
}
