package api

import (
	"fmt"
	"net"
	"strings"
)

// normalizeIPRuleCIDR canonicalises an IP-blocking destination.
//
// Accepts a bare IPv4/IPv6 address or a CIDR and returns the canonical network
// form ("203.0.113.0/24", "2001:db8::/48") so storage, duplicate detection and
// nftables set elements are deterministic. Host bits are normalised to the
// network address, and IPv6 text form is normalised (lowercase, compressed).
func normalizeIPRuleCIDR(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("an IP address or CIDR is required")
	}

	var ipnet *net.IPNet
	if strings.Contains(s, "/") {
		_, n, err := net.ParseCIDR(s)
		if err != nil {
			return "", fmt.Errorf("invalid CIDR %q: %v", raw, err)
		}
		ipnet = n
	} else {
		ip := net.ParseIP(s)
		if ip == nil {
			return "", fmt.Errorf("invalid IP address %q", raw)
		}
		if v4 := ip.To4(); v4 != nil {
			ipnet = &net.IPNet{IP: v4, Mask: net.CIDRMask(32, 32)}
		} else {
			ipnet = &net.IPNet{IP: ip, Mask: net.CIDRMask(128, 128)}
		}
	}

	if err := validateIPRuleCIDR(ipnet); err != nil {
		return "", err
	}
	return ipnet.String(), nil
}

// validateIPRuleCIDR rejects destinations that can only be mistakes: a default
// route (would cut all internet access), the unspecified address, and loopback
// (never traverses the forward hook). Private, LAN, link-local (e.g. the cloud
// metadata address 169.254.169.254) and multicast ranges stay allowed — they
// are legitimate blocking targets.
func validateIPRuleCIDR(n *net.IPNet) error {
	ones, _ := n.Mask.Size()
	if ones == 0 {
		return fmt.Errorf("%s would block all internet traffic — disable the tunnel instead", n.String())
	}
	if n.IP.IsUnspecified() {
		return fmt.Errorf("%s is the unspecified address", n.String())
	}
	if n.IP.IsLoopback() {
		return fmt.Errorf("%s is a loopback range", n.String())
	}
	return nil
}

// isIPv4Address reports whether s is a bare IPv4 address (peer tunnel IPs).
func isIPv4Address(s string) bool {
	ip := net.ParseIP(s)
	return ip != nil && ip.To4() != nil
}

// cidrIsIPv4 reports whether a canonical CIDR is IPv4.
func cidrIsIPv4(cidr string) bool {
	ip, _, err := net.ParseCIDR(cidr)
	return err == nil && ip.To4() != nil
}

// cidrContains reports whether cidr contains addr.
func cidrContains(cidr, addr string) bool {
	ip := net.ParseIP(addr)
	if ip == nil {
		return false
	}
	_, n, err := net.ParseCIDR(cidr)
	if err != nil {
		return false
	}
	return n.Contains(ip)
}
