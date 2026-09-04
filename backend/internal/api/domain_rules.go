package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"strings"

	"github.com/google/uuid"
	"github.com/wireguard-console/backend/internal/adguard"
	"github.com/wireguard-console/backend/internal/db"
)

// syncDomainRulesToAdGuard mirrors the full rule set into AdGuard Home.
// Global rules apply to every client; user rules are scoped with
// $client=<tunnel-ip>. Also ensures the block mode returns the block-page
// IP so browsers hit the branded page instead of a dead address.
func syncDomainRulesToAdGuard(store *Store, rules []db.DomainRule) error {
	client := adguard.NewClient()
	ctx := context.Background()

	// Credential/reachability check first: surface misconfig instead of
	// silently doing nothing.
	if err := client.Ping(ctx); err != nil {
		return fmt.Errorf("AdGuard unreachable (ADGUARD_URL / ADGUARD_API_PASSWORD): %w", err)
	}

	var adguardRules []string

	for _, rule := range rules {
		domain := strings.Trim(strings.TrimSpace(rule.Domain), "^")
		domain = strings.TrimPrefix(strings.TrimPrefix(domain, "||"), "|")
		domain = strings.TrimPrefix(domain, "https://")
		domain = strings.TrimPrefix(domain, "http://")

		agRule := fmt.Sprintf("||%s^", domain)

		if rule.Scope == "user" && rule.UserID != nil {
			// AdGuard identifies clients by source IP: the peer's tunnel IP.
			rows, err := store.pool.Query(ctx, `
				SELECT DISTINCT host(p.allowed_ip)
				FROM peers p
				JOIN servers s ON s.id = p.server_id
				WHERE p.user_id = $1 AND p.status = 'active' AND s.status = 'active'
			`, *rule.UserID)
			if err == nil {
				var ips []string
				for rows.Next() {
					var ip string
					if rows.Scan(&ip) == nil {
						ips = append(ips, strings.Split(ip, "/")[0])
					}
				}
				rows.Close()
				for _, ip := range ips {
					adguardRules = append(adguardRules, agRule+"$client="+ip)
				}
			}
		} else {
			adguardRules = append(adguardRules, agRule)
		}
	}

	if err := client.ReplaceUserRules(ctx, adguardRules); err != nil {
		return fmt.Errorf("failed to sync rules to AdGuard: %w", err)
	}

	// Blocked domains resolve to a placeholder IP that serves the block page.
	blockIP := blockingIP(store)
	if blockIP != "" {
		_ = client.EnsureCustomBlockingMode(ctx, blockIP)
	}

	return nil
}

// blockingIP returns the address the console serves the branded block page
// on (the tunnel gateway), or "" when no local server exists.
func blockingIP(store *Store) string {
	var ip string
	err := store.pool.QueryRow(context.Background(), `
		SELECT host(network(network_cidr)::inet + 1)
		FROM servers WHERE status = 'active' AND managed_mode = 'local'
		ORDER BY created_at LIMIT 1
	`).Scan(&ip)
	if err != nil {
		return ""
	}
	return ip
}

func ListDomainRules(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		var rules []db.DomainRule
		rows, err := store.pool.Query(ctx, `
			SELECT id, scope, user_id, domain, created_by, created_at
			FROM domain_block_rules
			ORDER BY created_at DESC
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query domain rules")
			return
		}
		defer rows.Close()

		for rows.Next() {
			var rule db.DomainRule
			if err := rows.Scan(&rule.ID, &rule.Scope, &rule.UserID, &rule.Domain,
				&rule.CreatedBy, &rule.CreatedAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan domain rule")
				return
			}
			rules = append(rules, rule)
		}

		writeJSON(w, http.StatusOK, rules)
	}
}

func CreateDomainRule(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Scope  string     `json:"scope"`
			UserID *uuid.UUID `json:"user_id"`
			Domain string     `json:"domain"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		_, err := store.pool.Exec(ctx, `
			INSERT INTO domain_block_rules (scope, user_id, domain, created_by)
			VALUES ($1, $2, $3, $4)
		`, req.Scope, req.UserID, req.Domain, adminID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create domain rule")
			return
		}

		// Sync to AdGuard
		rows, err := store.pool.Query(ctx, `
			SELECT id, scope, user_id, domain, created_by, created_at
			FROM domain_block_rules
			ORDER BY created_at DESC
		`)
		if err == nil {
			var allRules []db.DomainRule
			for rows.Next() {
				var rule db.DomainRule
				if err := rows.Scan(&rule.ID, &rule.Scope, &rule.UserID, &rule.Domain, &rule.CreatedBy, &rule.CreatedAt); err == nil {
					allRules = append(allRules, rule)
				}
			}
			rows.Close()
			if err := syncDomainRulesToAdGuard(store, allRules); err != nil {
				log.Printf("Failed to sync domain rules to AdGuard: %v", err)
			}
		}

		logAudit(ctx, store, adminID, "domain_rule.create", "domain_rule", "", nil)

		writeJSON(w, http.StatusCreated, map[string]string{"status": "created"})
	}
}

func DeleteDomainRule(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ruleID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid rule ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		_, err = store.pool.Exec(ctx, `
			DELETE FROM domain_block_rules WHERE id = $1
		`, ruleID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete domain rule")
			return
		}

		// Sync to AdGuard
		rows, err := store.pool.Query(ctx, `
			SELECT id, scope, user_id, domain, created_by, created_at
			FROM domain_block_rules
			ORDER BY created_at DESC
		`)
		if err == nil {
			var allRules []db.DomainRule
			for rows.Next() {
				var rule db.DomainRule
				if err := rows.Scan(&rule.ID, &rule.Scope, &rule.UserID, &rule.Domain, &rule.CreatedBy, &rule.CreatedAt); err == nil {
					allRules = append(allRules, rule)
				}
			}
			rows.Close()
			if err := syncDomainRulesToAdGuard(store, allRules); err != nil {
				log.Printf("Failed to sync domain rules to AdGuard: %v", err)
			}
		}

		logAudit(ctx, store, adminID, "domain_rule.delete", "domain_rule", ruleID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}

func ApplyNFTablesRules() error {
	// Get the WireGuard interface name and subnet
	_ = "wg0"
	subnet := "10.10.0.0/24"
	dnsServer := "10.10.0.1" // AdGuard Home IP

	// Flush existing rules for our chain
	cmd := exec.Command("nft", "flush", "chain", "inet", "fw", "wg-dns")
	if err := cmd.Run(); err != nil {
		// Chain might not exist yet, that's ok
	}

	// Create chain if it doesn't exist
	cmd = exec.Command("nft", "add", "chain", "inet", "fw", "wg-dns")
	cmd.Run()

	// Add rules to redirect DNS traffic from WG subnet to AdGuard Home
	rules := fmt.Sprintf(`
		table inet fw {
			chain wg-dns {
				ip saddr %s tcp dport 53 ip daddr %s accept
				ip saddr %s udp dport 53 ip daddr %s accept
				ip saddr %s counter drop
			}
		}
	`, subnet, dnsServer, subnet, dnsServer, subnet)

	cmd = exec.Command("nft", "-f", "/dev/stdin")
	cmd.Stdin = strings.NewReader(rules)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to apply nftables rules: %w", err)
	}

	return nil
}
