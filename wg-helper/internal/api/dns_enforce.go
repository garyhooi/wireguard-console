package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// Server-side DNS enforcement (P0-1).
//
// WireGuard clients are untrusted at the edge: the DNS line in their .conf is
// advisory, so a peer can switch to 8.8.8.8, use DoT (:853) or DoH (:443) and
// bypass AdGuard entirely. wg-helper is the only privileged component and
// shares the host network namespace with AdGuard, so it installs one nftables
// table per WireGuard interface to:
//
//   - redirect every plain-DNS packet (53/udp+tcp) from the peer subnet to the
//     local AdGuard listener (redirect picks the tunnel gateway automatically
//     and preserves the peer source IP, keeping $client= rules and AdGuard
//     query attribution intact),
//   - drop DoT/DoQ (853/udp+tcp) and DoH/DoH3 (443 to the known resolver IPs
//     below).
//
// Tables are per interface and fully rebuilt from ONE atomic nft transaction
// on every ensure, so re-applying is idempotent and a syntax error can never
// leave a partial ruleset. Failures are warnings only: enforcement problems
// must never abort the VPN apply.
//
// Known residual bypasses (documented, cannot be fixed at L3/L4): DoH to
// shared CDN IPs or arbitrary IPs/ports, native IPv6 DNS outside the tunnel,
// split-tunnel peers and clients that ignore the tunnel entirely.

// dohV4 is the starter IPv4 blocklist for known public DoH/DoH3 resolver
// endpoints. Peer-originated 443/udp+tcp traffic to these addresses is
// dropped; plain DNS to them is redirected to AdGuard anyway. Keep this list
// in one place and revisit it quarterly.
//
// Sources (2026-10 snapshot):
//   - https://en.wikipedia.org/wiki/Public_recursive_name_server
//   - provider docs: cloudflare-dns.com, dns.google, dns.quad9.net,
//     doh.opendns.com, dns.adguard-dns.com, dns.nextdns.io,
//     dns.controld.com, doh.mullvad.net
//
// Deliberately NOT blocked: Cloudflare shared CDN ranges (104.16.0.0/12).
// cloudflare-dns.com and Firefox mozilla.cloudflare-dns.com resolve into
// those ranges, which also serve ordinary websites, so blocking them would
// break the web. That residual DoH path needs TLS inspection, not this list.
var dohV4 = []string{
	// Cloudflare (one.one.one.one / security / family).
	"1.0.0.1", "1.0.0.2", "1.0.0.3",
	"1.1.1.1", "1.1.1.2", "1.1.1.3",
	// Google Public DNS (dns.google).
	"8.8.8.8", "8.8.4.4",
	// Quad9 (dns.quad9.net, dns10, dns11).
	"9.9.9.9", "9.9.9.10", "9.9.9.11",
	"149.112.112.10", "149.112.112.11", "149.112.112.112",
	// OpenDNS / Cisco Umbrella (dns.opendns.com, doh.opendns.com).
	"208.67.222.222", "208.67.220.220", "146.112.41.2",
	// AdGuard DNS (dns.adguard-dns.com, family/unfiltered endpoints).
	"94.140.14.14", "94.140.14.15", "94.140.15.15", "94.140.15.16",
	"94.140.14.140", "94.140.14.141",
	// NextDNS anycast ranges (profile DoH names resolve via GeoDNS; only the
	// documented anycast /24s are covered).
	"45.90.28.0/24", "45.90.30.0/24",
	// ControlD (dns.controld.com).
	"76.76.2.0/24", "76.76.10.0/24",
	// Mullvad (doh.mullvad.net / dns.mullvad.net).
	"194.242.2.0/24",
}

// dohV6 is the IPv6 equivalent of dohV4 for the defense-in-depth ip6 table.
// AdGuard has no IPv6 listener today; these entries only close the
// encrypted-DNS escape if a peer ever gets an IPv6 tunnel address.
var dohV6 = []string{
	// Cloudflare.
	"2606:4700:4700::1001", "2606:4700:4700::1002", "2606:4700:4700::1003",
	"2606:4700:4700::1111", "2606:4700:4700::1112", "2606:4700:4700::1113",
	// Google.
	"2001:4860:4860::8844", "2001:4860:4860::8888",
	// Quad9.
	"2620:fe::9", "2620:fe::10", "2620:fe::11",
	"2620:fe::fe", "2620:fe::fe:10", "2620:fe::fe:11",
	// OpenDNS / Cisco Umbrella.
	"2620:119:35::35", "2620:119:53::53",
	"2620:119:35::123", "2620:119:53::123", "2620:119:fc::2",
	// AdGuard DNS.
	"2a10:50c0::ad1:ff", "2a10:50c0::ad2:ff",
	"2a10:50c0::bad1:ff", "2a10:50c0::bad2:ff",
	"2a10:50c0::1:ff", "2a10:50c0::2:ff",
	// Mullvad.
	"2a07:e340::2", "2a07:e340::3", "2a07:e340::4", "2a07:e340::5",
	"2a07:e340::9",
	// NextDNS.
	"2a07:a8c0::/32", "2a07:a8c1::/32",
	// ControlD.
	"2606:1a40::/32",
}

// nftPath is the nftables binary in the wg-helper runtime image (Debian 12
// ships nftables 1.0.6 as /usr/sbin/nft). It is a variable so tests can
// substitute a fake binary.
var nftPath = "/usr/sbin/nft"

// iptablesPath is iptables in the wg-helper runtime image (debian:12-slim, with
// the nft backend). Used only for the INPUT admission fix below; a variable so
// tests can substitute a fake binary.
var iptablesPath = "/usr/sbin/iptables"

// nftMu serializes nft invocations: /apply and /enforce can run concurrently
// (console apply + reconcile tick + agent loop) and two overlapping table
// rebuilds would race on the same table names.
var nftMu sync.Mutex

// sanitizeTableName converts an interface name into the two nft table names
// used for DNS enforcement: "wgc_dns_<name>" (ip family) and
// "wgc_dns6_<name>" (ip6 family).
//
// nft identifiers cannot contain "-" or other punctuation and are
// case-sensitive, so the name is lowercased and every character outside
// [a-z0-9_] is replaced with "_". When sanitizing changed the name, a short
// deterministic sha256 suffix (first 8 hex chars of the original name) is
// appended so two interfaces that sanitize to the same base name (for example
// "Br-LAN!" and "Br_LAN!") can never collide.
func sanitizeTableName(iface string) (v4, v6 string) {
	return guardTableNames("wgc_dns_", "wgc_dns6_", iface)
}

// guardTableNames builds the per-family nft table names for one interface
// using the given prefixes (one per address family). nft identifiers cannot
// contain "-" or other punctuation and are case-sensitive, so the name is
// lowercased and every character outside [a-z0-9_] is replaced with "_". When
// sanitizing changed the name, a short deterministic sha256 suffix (first 8 hex
// chars of the original name) is appended so two interfaces that sanitize to
// the same base name (for example "Br-LAN!" and "Br_LAN!") can never collide.
func guardTableNames(prefixV4, prefixV6, iface string) (v4, v6 string) {
	var b strings.Builder
	b.Grow(len(iface))
	changed := false
	for _, r := range iface {
		var out rune
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			out = r
		case r >= 'A' && r <= 'Z':
			out = r - 'A' + 'a'
		default:
			out = '_'
		}
		if out != r {
			changed = true
		}
		b.WriteRune(out)
	}
	name := b.String()
	if changed {
		sum := sha256.Sum256([]byte(iface))
		name += "_" + hex.EncodeToString(sum[:4])
	}
	return prefixV4 + name, prefixV6 + name
}

// nftSetElements renders a set element list, four elements per line, indented
// for a "set" block nested inside a table.
func nftSetElements(elements []string) []string {
	const perLine = 4
	var lines []string
	for i := 0; i < len(elements); i += perLine {
		end := i + perLine
		if end > len(elements) {
			end = len(elements)
		}
		line := "\t\t\t" + strings.Join(elements[i:end], ", ")
		if end < len(elements) {
			line += ","
		}
		lines = append(lines, line)
	}
	return lines
}

// renderDNSEnforcementV4 renders the complete nftables script for the IPv4
// DNS-enforcement table of one interface. The script is one atomic
// transaction: "add" the table (no error if it already exists), delete the old
// incarnation, then redefine it. Any error aborts the whole batch, so a failed
// apply never leaves a partial ruleset and re-running is a data-plane no-op.
func renderDNSEnforcementV4(iface, cidr string) (string, error) {
	ip, subnet, err := net.ParseCIDR(cidr)
	if err != nil {
		return "", fmt.Errorf("invalid NAT CIDR %q: %w", cidr, err)
	}
	if ip.To4() == nil {
		return "", fmt.Errorf("NAT CIDR %q is not IPv4: DNS redirect requires an IPv4 peer subnet", cidr)
	}
	table, _ := sanitizeTableName(iface)
	quotedIface := fmt.Sprintf("%q", iface)
	peerSubnet := subnet.String()

	lines := []string{
		"# Managed by wg-helper; re-rendered on every apply. Do not edit by hand.",
		"table ip " + table,
		"delete table ip " + table,
		"table ip " + table + " {",
		"\t# Known DoH/DoH3 resolver endpoints (keep in sync with dohV4).",
		"\tset doh_v4 {",
		"\t\ttype ipv4_addr",
		"\t\tflags interval",
		"\t\telements = {",
	}
	lines = append(lines, nftSetElements(dohV4)...)
	lines = append(lines,
		"\t\t}",
		"\t}",
		"",
		"\t# Redirect all plain DNS from the peer subnet to the local AdGuard",
		"\t# listener on :53. The kernel picks the incoming interface's first",
		"\t# IPv4 address (the tunnel gateway) as the redirect destination, and",
		"\t# the peer source IP is preserved so AdGuard attribution still works.",
		"\tchain dns_redirect {",
		"\t\ttype nat hook prerouting priority dstnat; policy accept;",
		"\t\tiifname "+quotedIface+" ip saddr "+peerSubnet+" udp dport 53 counter redirect to :53",
		"\t\tiifname "+quotedIface+" ip saddr "+peerSubnet+" tcp dport 53 counter redirect to :53",
		"\t}",
		"",
		"\t# Drop encrypted-DNS escapes (DoT/DoQ on 853, DoH/DoH3 on 443 to the",
		"\t# resolver set). priority -150 runs before Docker/ufw filter chains at",
		"\t# priority 0. Counters only (no kernel module dependency); never combine",
		"\t# limit and drop in one rule.",
		"\tchain dns_forward {",
		"\t\ttype filter hook forward priority -150; policy accept;",
		"\t\tiifname "+quotedIface+" ip saddr "+peerSubnet+" tcp dport 853 counter drop",
		"\t\tiifname "+quotedIface+" ip saddr "+peerSubnet+" udp dport 853 counter drop",
		"\t\tiifname "+quotedIface+" ip saddr "+peerSubnet+" ip daddr @doh_v4 tcp dport 443 counter drop",
		"\t\tiifname "+quotedIface+" ip saddr "+peerSubnet+" ip daddr @doh_v4 udp dport 443 counter drop",
		"\t}",
		"}",
	)
	return strings.Join(lines, "\n") + "\n", nil
}

// renderDNSEnforcementV6 renders the complete nftables script for the IPv6
// defense-in-depth table of one interface. AdGuard has no IPv6 listener, so
// there is nothing to redirect plain v6 DNS to: it is dropped fail-closed,
// together with the same DoT/DoH escapes as IPv4. The script is one atomic
// transaction (add/delete/redefine), like the IPv4 one.
func renderDNSEnforcementV6(iface string) string {
	_, table := sanitizeTableName(iface)
	quotedIface := fmt.Sprintf("%q", iface)

	lines := []string{
		"# Managed by wg-helper; re-rendered on every apply. Do not edit by hand.",
		"table ip6 " + table,
		"delete table ip6 " + table,
		"table ip6 " + table + " {",
		"\t# Known DoH/DoH3 resolver endpoints (keep in sync with dohV6).",
		"\tset doh_v6 {",
		"\t\ttype ipv6_addr",
		"\t\tflags interval",
		"\t\telements = {",
	}
	lines = append(lines, nftSetElements(dohV6)...)
	lines = append(lines,
		"\t\t}",
		"\t}",
		"",
		"\t# AdGuard has no IPv6 listener and the tunnel has no IPv6 gateway, so",
		"\t# there is no redirect target: drop plain IPv6 DNS from the peer",
		"\t# (fail-closed) plus the same encrypted-DNS escapes. Defense in depth",
		"\t# for peers that manually add an IPv6 tunnel address.",
		"\tchain dns6_forward {",
		"\t\ttype filter hook forward priority -150; policy accept;",
		"\t\tiifname "+quotedIface+" udp dport 53 counter drop",
		"\t\tiifname "+quotedIface+" tcp dport 53 counter drop",
		"\t\tiifname "+quotedIface+" tcp dport 853 counter drop",
		"\t\tiifname "+quotedIface+" udp dport 853 counter drop",
		"\t\tiifname "+quotedIface+" ip6 daddr @doh_v6 tcp dport 443 counter drop",
		"\t\tiifname "+quotedIface+" ip6 daddr @doh_v6 udp dport 443 counter drop",
		"\t}",
		"}",
	)
	return strings.Join(lines, "\n") + "\n"
}

// nftBinary resolves the nft binary to use: the image path first, then PATH.
func nftBinary() (string, error) {
	if _, err := os.Stat(nftPath); err == nil {
		return nftPath, nil
	}
	if path, err := exec.LookPath("nft"); err == nil {
		return path, nil
	}
	return "", errors.New("nft not found (install nftables in the wg-helper image)")
}

// runNFTScript feeds one rendered script to "nft -f -".
func runNFTScript(nft, script string) error {
	cmd := exec.Command(nft, "-f", "-")
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("nft -f -: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// EnsureDNSEnforcement (re)installs the DNS-enforcement tables for one
// WireGuard interface. It is idempotent and safe to call on every apply and
// reconcile tick: the IPv4 and IPv6 scripts are each applied as one atomic nft
// transaction. IPv4 and IPv6 are separate nft calls so a v6 failure cannot
// roll back the critical v4 enforcement; both failures are returned joined.
//
// Set WG_DNS_ENFORCE=0 to disable enforcement (rollback switch).
func EnsureDNSEnforcement(iface, cidr string) error {
	if os.Getenv("WG_DNS_ENFORCE") == "0" {
		return nil
	}
	v4Script, err := renderDNSEnforcementV4(iface, cidr)
	if err != nil {
		return err
	}
	v6Script := renderDNSEnforcementV6(iface)

	nft, err := nftBinary()
	if err != nil {
		return err
	}

	nftMu.Lock()
	defer nftMu.Unlock()

	var errs []error
	if err := runNFTScript(nft, v4Script); err != nil {
		errs = append(errs, fmt.Errorf("ipv4 rules: %w", err))
	}
	if err := runNFTScript(nft, v6Script); err != nil {
		errs = append(errs, fmt.Errorf("ipv6 rules: %w", err))
	}
	// Redirected DNS becomes host-local INPUT traffic; ufw's default-deny
	// INPUT would silently drop it for interfaces created after install (or
	// after a ufw reload). A separate nft accept chain cannot outrank ufw's
	// later drop, so the admission rule must live in the same INPUT chain.
	if err := ensureDNSInputAccept(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// RemoveDNSEnforcement deletes both DNS-enforcement tables for one interface.
// Not finding the tables is not an error (remove may run twice, or before
// enforcement was ever installed); any other nft failure is returned.
func RemoveDNSEnforcement(iface string) error {
	v4Table, v6Table := sanitizeTableName(iface)

	nft, err := nftBinary()
	if err != nil {
		return err
	}

	nftMu.Lock()
	defer nftMu.Unlock()

	var errs []error
	if err := deleteNFTable(nft, "ip", v4Table); err != nil {
		errs = append(errs, err)
	}
	if err := deleteNFTable(nft, "ip6", v6Table); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// iptablesBinary resolves the iptables binary (image path first, then PATH).
func iptablesBinary() (string, error) {
	if _, err := os.Stat(iptablesPath); err == nil {
		return iptablesPath, nil
	}
	if path, err := exec.LookPath("iptables"); err == nil {
		return path, nil
	}
	return "", errors.New("iptables not found in the wg-helper image")
}

// ensureDNSInputAccept idempotently admits redirected DNS on all WireGuard
// interfaces. install.sh only adds a ufw exception per interface that exists
// at install time (or wg0); with several local servers, a later-created wg1
// would otherwise have its redirected DNS dropped by ufw's default-deny INPUT.
// ufw reloads also rebuild INPUT, so this is re-asserted on every ensure.
func ensureDNSInputAccept() error {
	bin, err := iptablesBinary()
	if err != nil {
		return err
	}

	var errs []error
	for _, proto := range []string{"udp", "tcp"} {
		match := []string{"-C", "INPUT", "-i", "wg+", "-p", proto, "--dport", "53", "-j", "ACCEPT"}
		if exec.Command(bin, match...).Run() == nil {
			continue // already present
		}
		insert := []string{"-I", "INPUT", "1", "-i", "wg+", "-p", proto, "--dport", "53", "-j", "ACCEPT"}
		if out, err := exec.Command(bin, insert...).CombinedOutput(); err != nil {
			errs = append(errs, fmt.Errorf("iptables INPUT accept %s/53: %w (%s)", proto, err, strings.TrimSpace(string(out))))
		}
	}
	return errors.Join(errs...)
}

// deleteNFTable removes one nft table, tolerating the "does not exist" error.
func deleteNFTable(nft, family, table string) error {
	out, err := exec.Command(nft, "delete", "table", family, table).CombinedOutput()
	if err == nil {
		return nil
	}
	msg := strings.ToLower(string(out) + " " + err.Error())
	if strings.Contains(msg, "no such file or directory") || strings.Contains(msg, "does not exist") {
		return nil
	}
	return fmt.Errorf("nft delete table %s %s: %w (%s)", family, table, err, strings.TrimSpace(string(out)))
}
