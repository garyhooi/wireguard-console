package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
)

// IP blocking (P0 for v1.0.20): the console expands its IPv4/IPv6 destination
// rules per server and peer, and wg-helper installs one nftables table per
// interface and family. Both tables are rebuilt from one atomic nft
// transaction, exactly like the DNS-enforcement tables, so re-applying is
// idempotent and a syntax error can never leave a partial ruleset.
//
// Matching is limited to forwarded traffic that entered through the tunnel
// (iifname), so the host's own traffic, AdGuard and the console are never
// affected. Counters only: no log rules, no kernel logging dependency.

// ipBlockRule is one expanded drop entry sent by the console: drop traffic from
// SourceIP (empty = every peer on the interface) to CIDR.
type ipBlockRule struct {
	SourceIP string `json:"source_ip"`
	CIDR     string `json:"cidr"`
}

const (
	ipBlockTablePrefixV4 = "wgc_ipblk_"
	ipBlockTablePrefixV6 = "wgc_ipblk6_"
)

// ipBlockSourceSetName is the deterministic nft set name for one per-user
// source IP: [a-z0-9_] only and collision-safe (full sha256 prefix).
func ipBlockSourceSetName(sourceIP string) string {
	sum := sha256.Sum256([]byte(sourceIP))
	return "src_" + hex.EncodeToString(sum[:8])
}

// splitIPBlockRules canonicalises destinations and splits them per family.
// Invalid entries and mixed source/destination families are skipped with a
// warning: the console validates first, this is defence in depth.
func splitIPBlockRules(rules []ipBlockRule) (v4, v6 []ipBlockRule, warnings []string) {
	appendUnique := func(list []ipBlockRule, rule ipBlockRule) []ipBlockRule {
		for _, existing := range list {
			if existing.SourceIP == rule.SourceIP && existing.CIDR == rule.CIDR {
				return list
			}
		}
		return append(list, rule)
	}

	for _, rule := range rules {
		source := strings.TrimSpace(rule.SourceIP)
		rawDst := strings.TrimSpace(rule.CIDR)
		var network *net.IPNet
		if strings.Contains(rawDst, "/") {
			_, parsed, err := net.ParseCIDR(rawDst)
			if err != nil {
				warnings = append(warnings, fmt.Sprintf("skipping invalid CIDR %q: %v", rule.CIDR, err))
				continue
			}
			network = parsed
		} else {
			ip := net.ParseIP(rawDst)
			if ip == nil {
				warnings = append(warnings, fmt.Sprintf("skipping invalid IP %q", rule.CIDR))
				continue
			}
			if v4 := ip.To4(); v4 != nil {
				network = &net.IPNet{IP: v4, Mask: net.CIDRMask(32, 32)}
			} else {
				network = &net.IPNet{IP: ip, Mask: net.CIDRMask(128, 128)}
			}
		}
		dest := network.String()
		destV4 := network.IP.To4() != nil

		src := ""
		if source != "" {
			ip := net.ParseIP(source)
			if ip == nil {
				warnings = append(warnings, fmt.Sprintf("skipping rule with invalid source IP %q", source))
				continue
			}
			if (ip.To4() != nil) != destV4 {
				warnings = append(warnings, fmt.Sprintf("skipping mixed-family rule (%s -> %s)", source, dest))
				continue
			}
			src = ip.String()
		}

		entry := ipBlockRule{SourceIP: src, CIDR: dest}
		if destV4 {
			v4 = appendUnique(v4, entry)
		} else {
			v6 = appendUnique(v6, entry)
		}
	}
	return v4, v6, warnings
}

// renderIPBlockTable renders the complete nftables script for one family of
// one interface (atomic add/delete/redefine). hasRules reports whether the
// family has any entries — callers delete the table instead of applying an
// empty ruleset so removing the last rule cleans the kernel state.
func renderIPBlockTable(iface string, v4 bool, rules []ipBlockRule) (script string, hasRules bool) {
	tableV4, tableV6 := guardTableNames(ipBlockTablePrefixV4, ipBlockTablePrefixV6, iface)
	table := tableV4
	if !v4 {
		table = tableV6
	}

	family := "ip"
	setType := "ipv4_addr"
	chain := "ipblk_forward"
	if !v4 {
		family = "ip6"
		setType = "ipv6_addr"
		chain = "ipblk6_forward"
	}
	quotedIface := fmt.Sprintf("%q", iface)

	global := []string{}
	bySource := map[string][]string{}
	for _, rule := range rules {
		if rule.SourceIP == "" {
			global = append(global, rule.CIDR)
		} else {
			bySource[rule.SourceIP] = append(bySource[rule.SourceIP], rule.CIDR)
		}
	}
	sort.Strings(global)
	sources := make([]string, 0, len(bySource))
	for source := range bySource {
		sort.Strings(bySource[source])
		sources = append(sources, source)
	}
	sort.Strings(sources)
	hasRules = len(global) > 0 || len(sources) > 0

	lines := []string{
		"# Managed by wg-helper; re-rendered on every apply. Do not edit by hand.",
		"table " + family + " " + table,
		"delete table " + family + " " + table,
		"table " + family + " " + table + " {",
	}
	if len(global) > 0 {
		lines = append(lines,
			"	set blocked {",
			"		type "+setType,
			"		flags interval",
			"		elements = {",
		)
		lines = append(lines, nftSetElements(global)...)
		lines = append(lines, "		}", "	}")
	}
	for _, source := range sources {
		lines = append(lines,
			"	set "+ipBlockSourceSetName(source)+" {",
			"		type "+setType,
			"		flags interval",
			"		elements = {",
		)
		lines = append(lines, nftSetElements(bySource[source])...)
		lines = append(lines, "		}", "	}")
	}

	lines = append(lines,
		"",
		"	# Drop blocked destinations from peer traffic. priority -140 runs",
		"	# after the DNS-enforcement chain (-150) and before ufw/docker (0);",
		"	# a drop here is final. Counters only (no packet logging).",
		"	chain "+chain+" {",
		"		type filter hook forward priority -140; policy accept;",
	)
	if len(global) > 0 {
		lines = append(lines, "		iifname "+quotedIface+" "+family+" daddr @blocked counter drop")
	}
	for _, source := range sources {
		lines = append(lines, "		iifname "+quotedIface+" "+family+" saddr "+source+
			" "+family+" daddr @"+ipBlockSourceSetName(source)+" counter drop")
	}
	lines = append(lines, "	}", "}")
	return strings.Join(lines, "\n") + "\n", hasRules
}

// EnsureIPBlocking (re)installs the IPv4 and IPv6 IP-blocking tables for one
// WireGuard interface. It is idempotent and safe on every apply and reconcile
// tick. A family with no rules has its table deleted so removing the last rule
// cleans the kernel state. Set WG_IP_BLOCK=0 to disable enforcement (rollback
// switch): existing tables are removed and nothing is dropped.
func EnsureIPBlocking(iface string, rules []ipBlockRule) ([]string, error) {
	if os.Getenv("WG_IP_BLOCK") == "0" {
		return nil, RemoveIPBlocking(iface)
	}

	nft, err := nftBinary()
	if err != nil {
		return nil, err
	}

	v4, v6, warnings := splitIPBlockRules(rules)
	v4Script, v4HasRules := renderIPBlockTable(iface, true, v4)
	v6Script, v6HasRules := renderIPBlockTable(iface, false, v6)
	tableV4, tableV6 := guardTableNames(ipBlockTablePrefixV4, ipBlockTablePrefixV6, iface)

	nftMu.Lock()
	defer nftMu.Unlock()

	var errs []error
	if v4HasRules {
		if err := runNFTScript(nft, v4Script); err != nil {
			errs = append(errs, fmt.Errorf("ipv4 rules: %w", err))
		}
	} else if err := deleteNFTable(nft, "ip", tableV4); err != nil {
		errs = append(errs, err)
	}
	if v6HasRules {
		if err := runNFTScript(nft, v6Script); err != nil {
			errs = append(errs, fmt.Errorf("ipv6 rules: %w", err))
		}
	} else if err := deleteNFTable(nft, "ip6", tableV6); err != nil {
		errs = append(errs, err)
	}
	return warnings, errors.Join(errs...)
}

// RemoveIPBlocking deletes both IP-blocking tables for an interface (tolerating
// missing tables). Called on interface removal and by the kill switch.
func RemoveIPBlocking(iface string) error {
	nft, err := nftBinary()
	if err != nil {
		return err
	}
	tableV4, tableV6 := guardTableNames(ipBlockTablePrefixV4, ipBlockTablePrefixV6, iface)

	nftMu.Lock()
	defer nftMu.Unlock()

	var errs []error
	if err := deleteNFTable(nft, "ip", tableV4); err != nil {
		errs = append(errs, err)
	}
	if err := deleteNFTable(nft, "ip6", tableV6); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
