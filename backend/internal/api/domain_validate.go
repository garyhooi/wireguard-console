package api

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/net/idna"

	"github.com/wireguard-console/backend/internal/db"
)

// normalizeDomain turns whatever an admin pasted into a canonical bare
// hostname for an AdGuard `||domain^` rule.
//
// Accepted: "YouTube.com", " www.youtube.com ", "https://www.youtube.com/watch?v=x",
// "youtube.com/path", "youtube.com:443", "münchen.de".
// Rejected (clear 400): empty, wildcards, comma lists, bare IPs, anything that
// is not a valid hostname.
//
// A leading "www." is collapsed to the apex because the generated rule matches
// the whole subtree anyway — this prevents "youtube.com" and "www.youtube.com"
// from becoming two separate, confusing rules.
func normalizeDomain(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("domain is required")
	}

	// Accept a pasted URL: take its hostname.
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil || u.Hostname() == "" {
			return "", fmt.Errorf("invalid domain %q: enter a bare domain like example.com", raw)
		}
		s = u.Hostname()
	} else {
		// Bare host, possibly with a path ("example.com/page") or port.
		if i := strings.IndexAny(s, "/?#"); i >= 0 {
			s = s[:i]
		}
	}

	// Strip an explicit port ("example.com:443").
	if host, _, err := net.SplitHostPort(s); err == nil {
		s = host
	}

	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimRight(s, ".")

	// Normalize internationalized domains (IDN) to punycode.
	if ascii, err := idna.Lookup.ToASCII(s); err == nil {
		s = strings.ToLower(ascii)
	}

	s = strings.TrimPrefix(s, "www.")
	s = strings.TrimRight(s, ".")

	if err := validateHostname(s); err != nil {
		return "", fmt.Errorf("invalid domain %q: %w", raw, err)
	}
	return s, nil
}

// validateHostname enforces a strict bare-hostname shape (letters, digits,
// hyphen; no wildcards, spaces, underscores, IP literals or empty labels).
func validateHostname(host string) error {
	if host == "" {
		return fmt.Errorf("enter a bare domain like example.com")
	}
	if len(host) > 253 {
		return fmt.Errorf("domain is too long (max 253 characters)")
	}
	if net.ParseIP(host) != nil {
		return fmt.Errorf("enter a domain, not an IP address")
	}
	labels := strings.Split(host, ".")
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return fmt.Errorf("each part must be 1-63 characters")
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return fmt.Errorf("parts cannot start or end with a hyphen")
		}
		for _, ch := range label {
			if (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' {
				continue
			}
			return fmt.Errorf("only letters, digits and hyphens are allowed (not %q)", string(ch))
		}
	}
	return nil
}

// builtRules is the result of expanding the DB rule set into the exact rule
// strings AdGuard must hold.
type builtRules struct {
	// AdGuard is the final, deduplicated, sorted user-rule list (global rules
	// plus per-peer $client= expansions).
	AdGuard []string
	// Invalid holds stored rules that cannot be normalized (legacy/pasted
	// URLs). They are never sent to AdGuard and are surfaced in the status.
	Invalid []db.DomainRule
	// Unexpanded holds user-scoped rules whose user currently has no active
	// peer on an active server, so there is no client IP to expand to.
	Unexpanded []db.DomainRule
}

// buildAdGuardRules expands every stored rule into the AdGuard user-rule array.
// The same builder is used by the sync and by the status comparison, so
// "expected" and "sent" can never diverge.
func buildAdGuardRules(ctx context.Context, store *Store, rules []db.DomainRule) (builtRules, error) {
	out := builtRules{AdGuard: []string{}}
	seen := make(map[string]bool, len(rules))

	add := func(rule string) {
		if seen[rule] {
			return
		}
		seen[rule] = true
		out.AdGuard = append(out.AdGuard, rule)
	}

	for _, rule := range rules {
		domain, err := normalizeDomain(rule.Domain)
		if err != nil {
			out.Invalid = append(out.Invalid, rule)
			continue
		}

		agRule := "||" + domain + "^"
		if rule.Scope == "user" && rule.UserID != nil {
			ips, err := userPeerIPs(ctx, store, *rule.UserID)
			if err != nil {
				return out, fmt.Errorf("expand user rule %s: %w", rule.ID, err)
			}
			if len(ips) == 0 {
				out.Unexpanded = append(out.Unexpanded, rule)
				continue
			}
			for _, ip := range ips {
				add(agRule + "$client=" + ip)
			}
			continue
		}
		add(agRule)
	}

	sort.Strings(out.AdGuard)
	return out, nil
}

// userPeerIPs returns the tunnel IPs of a user's active peers on active
// servers (AdGuard identifies clients by DNS packet source IP).
func userPeerIPs(ctx context.Context, store *Store, userID uuid.UUID) ([]string, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT DISTINCT host(p.allowed_ip)
		FROM peers p
		JOIN servers s ON s.id = p.server_id
		WHERE p.user_id = $1 AND p.status = 'active' AND s.status = 'active'
		ORDER BY 1
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ips []string
	for rows.Next() {
		var ip string
		if err := rows.Scan(&ip); err != nil {
			return nil, err
		}
		ips = append(ips, ip)
	}
	return ips, rows.Err()
}

// diffRuleSets compares the expected rules with AdGuard's actual user rules
// (order-insensitive).
func diffRuleSets(expected, actual []string) (missing, unexpected int) {
	want := make(map[string]bool, len(expected))
	for _, rule := range expected {
		want[rule] = true
	}
	have := make(map[string]bool, len(actual))
	for _, rule := range actual {
		have[rule] = true
	}
	for rule := range want {
		if !have[rule] {
			missing++
		}
	}
	for rule := range have {
		if !want[rule] {
			unexpected++
		}
	}
	return missing, unexpected
}
