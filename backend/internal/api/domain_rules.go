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

func syncDomainRulesToAdGuard(store *Store, rules []db.DomainRule) error {
	client := adguard.NewClient()
	ctx := context.Background()

	var adguardRules []string

	for _, rule := range rules {
		agRule := fmt.Sprintf("||%s^", rule.Domain)

		if rule.Scope == "user" && rule.UserID != nil {
			// Get peer IP for this user
			var allowedIP string
			store.pool.QueryRow(ctx, `
				SELECT allowed_ip::text FROM peers 
				WHERE user_id = $1 AND status = 'active' AND server_id = (SELECT id FROM servers WHERE status = 'active' LIMIT 1)
				LIMIT 1
			`, *rule.UserID).Scan(&allowedIP)

			if allowedIP != "" {
				ip := strings.Split(allowedIP, "/")[0]
				agRule += fmt.Sprintf("$client=%s", ip)
			}
		}

		adguardRules = append(adguardRules, agRule)
	}

	if err := client.SetCustomRules(ctx, adguardRules); err != nil {
		return fmt.Errorf("failed to sync rules to AdGuard: %w", err)
	}

	return nil
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
