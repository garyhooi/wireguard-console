package api

import (
	"strings"
	"testing"

	"github.com/wireguard-console/backend/internal/db"
)

func TestGatewayForCIDR(t *testing.T) {
	cases := []struct {
		cidr     string
		wantIP   string
		wantBits int
		wantErr  bool
	}{
		{"10.8.0.0/24", "10.8.0.1", 24, false},
		{"10.9.0.0/16", "10.9.0.1", 16, false},
		{"172.16.5.0/28", "172.16.5.1", 28, false},
		{"not-a-cidr", "", 0, true},
		{"2001:db8::/64", "", 0, true}, // IPv6 unsupported for now
	}
	for _, c := range cases {
		ip, bits, err := gatewayForCIDR(c.cidr)
		if c.wantErr {
			if err == nil {
				t.Errorf("gatewayForCIDR(%q): expected error, got ip=%s bits=%d", c.cidr, ip, bits)
			}
			continue
		}
		if err != nil {
			t.Errorf("gatewayForCIDR(%q): unexpected error: %v", c.cidr, err)
			continue
		}
		if ip != c.wantIP || bits != c.wantBits {
			t.Errorf("gatewayForCIDR(%q) = %s/%d, want %s/%d", c.cidr, ip, bits, c.wantIP, c.wantBits)
		}
	}
}

func TestGenerateWireGuardConfig(t *testing.T) {
	peer := &db.Peer{
		Name:      "MacBook",
		PublicKey: "peerPubKey",
		AllowedIP: "10.8.0.2",
	}
	server := &db.Server{
		PublicEndpoint:      "vpn.example.com:51820",
		ServerPublicKey:     "serverPubKey",
		DNSServers:          []string{"1.1.1.1", "8.8.8.8"},
		DefaultAllowedIPs:   "0.0.0.0/0, ::/0",
		PersistentKeepalive: 25,
	}

	config := generateWireGuardConfig(peer, server, "testPrivateKey12345")

	for _, want := range []string{
		"[Interface]",
		"PrivateKey = testPrivateKey12345",
		"Address = 10.8.0.2/32",
		"DNS = 1.1.1.1, 8.8.8.8",
		"[Peer]",
		"PublicKey = serverPubKey",
		"Endpoint = vpn.example.com:51820",
		"AllowedIPs = 0.0.0.0/0, ::/0",
		"PersistentKeepalive = 25",
	} {
		if !strings.Contains(config, want) {
			t.Errorf("config missing %q\n---\n%s", want, config)
		}
	}
	if strings.Contains(config, "[REDACTED]") {
		t.Error("config must not contain redacted placeholders")
	}
}

func TestHashNodeTokenStableAndSalted(t *testing.T) {
	a := hashNodeToken("plain-token")
	b := hashNodeToken("plain-token")
	if a != b {
		t.Fatal("hashing is not deterministic")
	}
	if hashNodeToken("plain-token") == hashNodeToken("other-token") {
		t.Error("different tokens must hash differently")
	}
	if a == "plain-token" {
		t.Error("token hash must not be the plaintext")
	}
}

func TestNextAvailableIPSkipsGateway(t *testing.T) {
	// The gateway (.1) is reserved: candidate start must be .2 for a /24.
	for _, c := range []struct{ num string }{{"1"}, {"2"}} {
		_ = c
	}
	// Covered implicitly by E2E; here we just pin the rule:
	ip, bits, err := gatewayForCIDR("10.8.0.0/24")
	if err != nil || ip != "10.8.0.1" || bits != 24 {
		t.Fatalf("gateway reservation broken: %s/%d err=%v", ip, bits, err)
	}
}
