package api

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strings"
	"unicode/utf8"

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

// normalizeGroupName trims and validates a domain-group name.
func normalizeGroupName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("group name is required")
	}
	if utf8.RuneCountInString(name) > 64 {
		return "", fmt.Errorf("group name is too long (max 64 characters)")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("group name contains control characters")
		}
	}
	return name, nil
}

// expandDomainInput flattens the UI/API domain list. The frontend sends one
// entry per pasted line, but the API also accepts a single comma/space
// separated string for convenience.
func expandDomainInput(input []string) []string {
	var out []string
	for _, item := range input {
		fields := strings.FieldsFunc(item, func(r rune) bool {
			switch r {
			case '\n', '\r', ',', ';', ' ', '\t':
				return true
			}
			return false
		})
		out = append(out, fields...)
	}
	return out
}

// normalizeDomainList normalizes + de-duplicates a pasted domain list.
func normalizeDomainList(input []string) ([]string, error) {
	raw := expandDomainInput(input)
	if len(raw) == 0 {
		return nil, fmt.Errorf("at least one domain is required")
	}
	if len(raw) > 500 {
		return nil, fmt.Errorf("too many domains (max 500 per group)")
	}

	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		domain, err := normalizeDomain(item)
		if err != nil {
			return nil, err
		}
		if seen[domain] {
			continue
		}
		seen[domain] = true
		out = append(out, domain)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("at least one domain is required")
	}
	return out, nil
}

// builtRules is the result of expanding the DB rule set into the exact rule
// strings AdGuard must hold.
type builtRules struct {
	// AdGuard is the final, deduplicated, sorted user-rule list (single-domain
	// rules, group rules and per-peer $client= expansions).
	AdGuard []string
	// Invalid holds raw domain values that cannot be normalized (legacy rows
	// or group domains entered before validation existed).
	Invalid []string
	// Unexpanded counts group rules with no domains and user-scoped rules
	// whose user currently has no active peer on an active server.
	Unexpanded int
}

// buildAdGuardRules expands every stored rule (single domain or domain group)
// into the AdGuard user-rule array. The same builder is used by the sync and
// by the status comparison, so "expected" and "sent" can never diverge.
func buildAdGuardRules(ctx context.Context, store *Store, rules []db.DomainRule) (builtRules, error) {
	out := builtRules{AdGuard: []string{}}
	groups, err := loadGroupDomains(ctx, store)
	if err != nil {
		return out, err
	}

	seen := make(map[string]bool, len(rules))
	add := func(rule string) {
		if seen[rule] {
			return
		}
		seen[rule] = true
		out.AdGuard = append(out.AdGuard, rule)
	}

	for _, rule := range rules {
		// Resolve the rule's domain list: a single domain or every domain in
		// its group.
		var domains []string
		if rule.GroupID != nil {
			domains = groups[*rule.GroupID]
			if len(domains) == 0 {
				out.Unexpanded++
				continue
			}
		} else {
			domains = []string{rule.Domain}
		}

		valid := make([]string, 0, len(domains))
		for _, raw := range domains {
			domain, err := normalizeDomain(raw)
			if err != nil {
				out.Invalid = append(out.Invalid, raw)
				continue
			}
			valid = append(valid, domain)
		}
		if len(valid) == 0 {
			continue
		}

		if rule.Scope == "user" && rule.UserID != nil {
			ips, err := userPeerIPs(ctx, store, *rule.UserID)
			if err != nil {
				return out, fmt.Errorf("expand user rule %s: %w", rule.ID, err)
			}
			if len(ips) == 0 {
				out.Unexpanded++
				continue
			}
			for _, ip := range ips {
				for _, domain := range valid {
					add("||" + domain + "^$client=" + ip)
				}
			}
			continue
		}
		if rule.Scope == "department" && rule.DepartmentID != nil {
			ips, err := departmentPeerIPs(ctx, store, *rule.DepartmentID)
			if err != nil {
				return out, fmt.Errorf("expand department rule %s: %w", rule.ID, err)
			}
			if len(ips) == 0 {
				out.Unexpanded++
				continue
			}
			for _, ip := range ips {
				for _, domain := range valid {
					add("||" + domain + "^$client=" + ip)
				}
			}
			continue
		}
		for _, domain := range valid {
			add("||" + domain + "^")
		}
	}

	sort.Strings(out.AdGuard)
	return out, nil
}

// loadGroupDomains returns every group's domain list keyed by group id.
func loadGroupDomains(ctx context.Context, store *Store) (map[uuid.UUID][]string, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT group_id, domain FROM domain_group_domains ORDER BY group_id, domain
	`)
	if err != nil {
		return nil, fmt.Errorf("query domain group domains: %w", err)
	}
	defer rows.Close()

	out := make(map[uuid.UUID][]string)
	for rows.Next() {
		var groupID uuid.UUID
		var domain string
		if err := rows.Scan(&groupID, &domain); err != nil {
			return nil, err
		}
		out[groupID] = append(out[groupID], domain)
	}
	return out, rows.Err()
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

// departmentPeerIPs returns the client IPs of every active peer belonging to
// a user in the department (active peers on active servers).
func departmentPeerIPs(ctx context.Context, store *Store, departmentID uuid.UUID) ([]string, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT DISTINCT host(p.allowed_ip)
		FROM peers p
		JOIN users u ON u.id = p.user_id
		JOIN servers s ON s.id = p.server_id
		WHERE u.department_id = $1 AND p.status = 'active' AND s.status = 'active'
		ORDER BY 1
	`, departmentID)
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
