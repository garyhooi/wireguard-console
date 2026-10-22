package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/wireguard-console/backend/internal/adguard"
	"github.com/wireguard-console/backend/internal/db"
)

// Domain-rule sync is a small state machine with three goals:
//  1. Serialize full-set pushes so concurrent create/delete cannot race and
//     overwrite a fresher DB snapshot with a stale one.
//  2. Coalesce event-driven requests (peer/user/server changes) into
//     single-flight background syncs instead of one HTTP round trip each.
//  3. Remember the last attempt so the console can show whether AdGuard
//     really has the rules, instead of optimistically claiming success.
var (
	domainSyncMu sync.Mutex // held for the duration of one full sync

	domainSyncStateMu sync.Mutex
	domainSyncLastAt  time.Time
	domainSyncLastErr string

	domainSyncReq struct {
		mu      sync.Mutex
		running bool
		dirty   bool
	}
)

func recordDomainSync(err error) {
	domainSyncStateMu.Lock()
	defer domainSyncStateMu.Unlock()
	domainSyncLastAt = time.Now()
	domainSyncLastErr = ""
	if err != nil {
		domainSyncLastErr = err.Error()
	}
}

func lastDomainSync() (time.Time, string) {
	domainSyncStateMu.Lock()
	defer domainSyncStateMu.Unlock()
	return domainSyncLastAt, domainSyncLastErr
}

// RequestDomainRuleSync asks for an async re-sync of the rule set. Repeated
// requests while a sync is running are coalesced into one more pass (the DB is
// re-read at the start of each pass, so the newest rules always win).
func RequestDomainRuleSync(store *Store) {
	domainSyncReq.mu.Lock()
	if domainSyncReq.running {
		domainSyncReq.dirty = true
		domainSyncReq.mu.Unlock()
		return
	}
	domainSyncReq.running = true
	domainSyncReq.mu.Unlock()

	go func() {
		for {
			if _, err := SyncDomainRulesToAdGuard(store); err != nil {
				log.Printf("Domain-rule sync: %v", err)
			}

			domainSyncReq.mu.Lock()
			if !domainSyncReq.dirty {
				domainSyncReq.running = false
				domainSyncReq.mu.Unlock()
				return
			}
			domainSyncReq.dirty = false
			domainSyncReq.mu.Unlock()
		}
	}()
}

func loadDomainRules(ctx context.Context, store *Store) ([]db.DomainRule, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT id, scope, user_id, department_id, domain, group_id, created_by, created_at,
		       COALESCE(array_to_string(peer_ids, ','), '')
		FROM domain_block_rules
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("query domain rules: %w", err)
	}
	defer rows.Close()

	var rules []db.DomainRule
	for rows.Next() {
		var rule db.DomainRule
		var domain sql.NullString
		var peerIDsRaw string
		if err := rows.Scan(&rule.ID, &rule.Scope, &rule.UserID, &rule.DepartmentID, &domain, &rule.GroupID,
			&rule.CreatedBy, &rule.CreatedAt, &peerIDsRaw); err != nil {
			return nil, fmt.Errorf("scan domain rule: %w", err)
		}
		rule.Domain = domain.String
		rule.PeerIDs = parseStoredPeerIDs(peerIDsRaw)
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate domain rules: %w", err)
	}
	return rules, nil
}

// SyncDomainRulesToAdGuard reloads every rule from the database, verifies that
// AdGuard is actually enforcing (filtering + protection on), pushes the full
// user-rule set and then verifies the result by reading the rules back.
//
// It returns the number of DB rule rows (not the expanded per-client rule
// count). Failures are recorded in the sync state and surfaced by
// DomainRuleSyncStatus; they are never silently swallowed.
func SyncDomainRulesToAdGuard(store *Store) (int, error) {
	domainSyncMu.Lock()
	defer domainSyncMu.Unlock()

	ctx := context.Background()

	rules, err := loadDomainRules(ctx, store)
	if err != nil {
		recordDomainSync(err)
		return 0, err
	}

	built, err := buildAdGuardRules(ctx, store, rules)
	if err != nil {
		recordDomainSync(err)
		return len(rules), err
	}

	client := adguard.NewClient()

	// Reachability/credential check first: surface misconfiguration instead of
	// silently doing nothing.
	if err := client.Ping(ctx); err != nil {
		err = fmt.Errorf("AdGuard unreachable (ADGUARD_URL / ADGUARD_API_PASSWORD): %w", err)
		recordDomainSync(err)
		return len(rules), err
	}

	status := client.GetStatus(ctx)
	if !status.Reachable {
		err = fmt.Errorf("AdGuard status: %s", status.Error)
		recordDomainSync(err)
		return len(rules), err
	}

	// A paused protection or disabled filtering means the rules exist but do
	// nothing. The console owns enforcement, so heal both states; a paused
	// protection is otherwise invisible on /control/filtering/status.
	if !status.FilteringEnabled {
		if err := client.SetFilteringEnabled(ctx, true, status.IntervalHours); err != nil {
			err = fmt.Errorf("enable AdGuard filtering: %w", err)
			recordDomainSync(err)
			return len(rules), err
		}
		log.Printf("Domain-rule sync: AdGuard filtering was disabled — re-enabled it")
	}
	if !status.ProtectionEnabled {
		if err := client.SetProtection(ctx, true); err != nil {
			err = fmt.Errorf("resume AdGuard protection: %w", err)
			recordDomainSync(err)
			return len(rules), err
		}
		log.Printf("Domain-rule sync: AdGuard protection was paused — resumed it")
		recordSystemAudit(store, "domain_rules.protection_resume", "AdGuard protection was paused; the console resumed it so domain rules are enforced")
	}

	// Blocked domains resolve to the branded block-page IP.
	if blockIP := blockingIP(store); blockIP != "" {
		if err := client.EnsureCustomBlockingMode(ctx, blockIP); err != nil {
			// Not fatal for rule enforcement, but record it.
			log.Printf("Domain-rule sync: blocking mode: %v", err)
		}
	}

	if err := client.ReplaceUserRules(ctx, built.AdGuard); err != nil {
		err = fmt.Errorf("push rules to AdGuard: %w", err)
		recordDomainSync(err)
		return len(rules), err
	}

	// Verify what AdGuard actually stored (it accepts rules asynchronously in
	// some versions), so "synced" means effective, not just "request accepted".
	after := client.GetStatus(ctx)
	if !after.Reachable {
		err = fmt.Errorf("verify rules: AdGuard unreachable after push: %s", after.Error)
		recordDomainSync(err)
		return len(rules), err
	}
	missing, unexpected := diffRuleSets(built.AdGuard, after.UserRules)
	if missing > 0 || unexpected > 0 {
		err = fmt.Errorf("rule verification failed: %d expected rule(s) missing, %d unexpected in AdGuard", missing, unexpected)
		recordDomainSync(err)
		return len(rules), err
	}
	if !after.ProtectionEnabled {
		err = fmt.Errorf("AdGuard protection is still paused after sync")
		recordDomainSync(err)
		return len(rules), err
	}

	recordDomainSync(nil)
	return len(rules), nil
}

// recordSystemAudit writes an audit row for an action performed by the console
// itself (no admin actor).
func recordSystemAudit(store *Store, action, detail string) {
	if _, err := store.pool.Exec(context.Background(), `
		INSERT INTO audit_logs (action, target_type, target_id) VALUES ($1, 'adguard', '')
	`, action); err != nil {
		log.Printf("audit %s: %v", action, err)
	}
}

// blockingIP returns the address the console serves the branded block page on
// (the tunnel gateway), or "" when no local server exists.
func blockingIP(store *Store) string {
	return blockingIPForPool(context.Background(), store.pool)
}

func ListDomainRules(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		// Join the owning user so the UI can show who a user-scoped rule
		// applies to (same shape as ListPeers: user_email/user_full_name).
		type domainRuleRow struct {
			db.DomainRule
			UserEmail          string   `json:"user_email"`
			UserFullName       string   `json:"user_full_name"`
			UserDepartmentName string   `json:"user_department_name"`
			DepartmentName     string   `json:"department_name"`
			GroupName          string   `json:"group_name,omitempty"`
			PeerNames          []string `json:"peer_names"`
		}
		var rules []domainRuleRow
		rows, err := store.pool.Query(ctx, `
			SELECT dr.id, dr.scope, dr.user_id, dr.department_id, dr.domain, dr.group_id, dr.created_by, dr.created_at,
			       COALESCE(array_to_string(dr.peer_ids, ','), ''),
			       COALESCE(u.email, ''), COALESCE(u.full_name, ''), COALESCE(d.name, ''),
			       COALESCE(dd.name, ''), COALESCE(g.name, ''),
			       COALESCE((SELECT array_agg(p.name ORDER BY p.name)
			                 FROM peers p WHERE p.id = ANY(dr.peer_ids)), ARRAY[]::text[])
			FROM domain_block_rules dr
			LEFT JOIN users u ON u.id = dr.user_id
			LEFT JOIN departments d ON d.id = u.department_id
			LEFT JOIN departments dd ON dd.id = dr.department_id
			LEFT JOIN domain_groups g ON g.id = dr.group_id
			ORDER BY dr.created_at DESC
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query domain rules")
			return
		}
		defer rows.Close()

		for rows.Next() {
			var rule domainRuleRow
			var domain sql.NullString
			var peerIDsRaw string
			if err := rows.Scan(&rule.ID, &rule.Scope, &rule.UserID, &rule.DepartmentID, &domain, &rule.GroupID,
				&rule.CreatedBy, &rule.CreatedAt, &peerIDsRaw, &rule.UserEmail, &rule.UserFullName,
				&rule.UserDepartmentName, &rule.DepartmentName, &rule.GroupName, &rule.PeerNames); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan domain rule")
				return
			}
			rule.Domain = domain.String
			rule.PeerIDs = parseStoredPeerIDs(peerIDsRaw)
			if rule.PeerNames == nil {
				rule.PeerNames = []string{}
			}
			rules = append(rules, rule)
		}

		writeJSON(w, http.StatusOK, rules)
	}
}

func CreateDomainRule(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Scope        string     `json:"scope"`
			UserID       *uuid.UUID `json:"user_id"`
			DepartmentID *uuid.UUID `json:"department_id"`
			Domain       string     `json:"domain"`
			GroupID      *uuid.UUID `json:"group_id"`
			PeerIDs      []string   `json:"peer_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		switch req.Scope {
		case "global":
			req.UserID = nil
			req.DepartmentID = nil
		case "user":
			if req.UserID == nil {
				writeError(w, http.StatusBadRequest, "A user is required for user-scoped rules")
				return
			}
			req.DepartmentID = nil
		case "department":
			if req.DepartmentID == nil {
				writeError(w, http.StatusBadRequest, "A department is required for department-scoped rules")
				return
			}
			req.UserID = nil
			ok, err := departmentExists(context.Background(), store, *req.DepartmentID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to check department")
				return
			}
			if !ok {
				writeError(w, http.StatusBadRequest, "Department not found")
				return
			}
		default:
			writeError(w, http.StatusBadRequest, "Scope must be global, user or department")
			return
		}

		ctx := context.Background()

		// Optional peer selection: only user-scoped rules may target a subset
		// of the user's peers (empty/absent = all peers, legacy behaviour).
		peerIDs, peerErr := parseRulePeerIDs(req.PeerIDs)
		if peerErr != nil {
			writeError(w, http.StatusBadRequest, peerErr.Error())
			return
		}
		if len(peerIDs) > 0 && req.Scope != "user" {
			writeError(w, http.StatusBadRequest, "Peer selection is only valid for user-scoped rules")
			return
		}
		if len(peerIDs) > 0 {
			ok, err := peersOwnedByUser(ctx, store.pool, *req.UserID, peerIDs)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to check peers")
				return
			}
			if !ok {
				writeError(w, http.StatusBadRequest, "Selected peers do not belong to the chosen user")
				return
			}
		}

		hasDomain := strings.TrimSpace(req.Domain) != ""
		hasGroup := req.GroupID != nil
		if hasDomain == hasGroup {
			writeError(w, http.StatusBadRequest, "Provide either a domain or a domain group (exactly one)")
			return
		}

		adminID := getAdminID(r)

		var domain string
		if hasDomain {
			var err error
			domain, err = normalizeDomain(req.Domain)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}

			// Dedupe deliberately (the DB has a unique index too, but a clear
			// 409 is nicer than a constraint-violation error).
			var exists bool
			err = store.pool.QueryRow(ctx, `
				SELECT true FROM domain_block_rules
				WHERE scope = $1
				  AND COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
				    = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
				  AND COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid)
				    = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
				  AND domain = $4
				  AND peer_ids = $5::text[]::uuid[]
				LIMIT 1
			`, req.Scope, req.UserID, req.DepartmentID, domain, peerIDStrings(peerIDs)).Scan(&exists)
			if err == nil {
				msg := fmt.Sprintf("%s is already blocked for this scope", domain)
				if len(peerIDs) > 0 {
					msg = fmt.Sprintf("%s is already blocked for the chosen peers", domain)
				}
				writeError(w, http.StatusConflict, msg)
				return
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusInternalServerError, "Failed to check existing rules")
				return
			}
		} else {
			// Validate that the group exists (and grab its name for the audit
			// message + clear 409 text).
			var groupName string
			err := store.pool.QueryRow(ctx, `SELECT name FROM domain_groups WHERE id = $1`, *req.GroupID).Scan(&groupName)
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					writeError(w, http.StatusNotFound, "Domain group not found")
					return
				}
				writeError(w, http.StatusInternalServerError, "Failed to check domain group")
				return
			}

			var exists bool
			err = store.pool.QueryRow(ctx, `
				SELECT true FROM domain_block_rules
				WHERE scope = $1
				  AND COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
				    = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
				  AND COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid)
				    = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
				  AND group_id = $4
				  AND peer_ids = $5::text[]::uuid[]
				LIMIT 1
			`, req.Scope, req.UserID, req.DepartmentID, *req.GroupID, peerIDStrings(peerIDs)).Scan(&exists)
			if err == nil {
				msg := fmt.Sprintf("group %q is already blocked for this scope", groupName)
				if len(peerIDs) > 0 {
					msg = fmt.Sprintf("group %q is already blocked for the chosen peers", groupName)
				}
				writeError(w, http.StatusConflict, msg)
				return
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusInternalServerError, "Failed to check existing rules")
				return
			}
			domain = "" // group rules keep domain NULL
		}

		var domainArg *string
		if hasDomain {
			domainArg = &domain
		}
		_, err := store.pool.Exec(ctx, `
			INSERT INTO domain_block_rules (scope, user_id, department_id, domain, group_id, created_by, peer_ids)
			VALUES ($1, $2, $3, $4, $5, $6, $7::text[]::uuid[])
		`, req.Scope, req.UserID, req.DepartmentID, domainArg, req.GroupID, adminID, peerIDStrings(peerIDs))
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				writeError(w, http.StatusConflict, "This rule already exists for this scope")
				return
			}
			writeError(w, http.StatusInternalServerError, "Failed to create domain rule")
			return
		}

		targetID := domain
		if hasGroup {
			targetID = req.GroupID.String()
		}
		logAudit(ctx, store, adminID, "domain_rule.create", "domain_rule", targetID, nil)

		// Push asynchronously (coalesced) so the API stays fast when AdGuard is
		// slow/unreachable; the status endpoint reports sync failures.
		RequestDomainRuleSync(store)

		resp := map[string]string{"status": "created"}
		if hasDomain {
			resp["domain"] = domain
		} else {
			resp["group_id"] = req.GroupID.String()
		}
		writeJSON(w, http.StatusCreated, resp)
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

		_, err = store.pool.Exec(ctx, `DELETE FROM domain_block_rules WHERE id = $1`, ruleID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete domain rule")
			return
		}

		logAudit(ctx, store, adminID, "domain_rule.delete", "domain_rule", ruleID.String(), nil)
		RequestDomainRuleSync(store)

		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}

// DomainRuleSyncStatus returns what AdGuard Home actually has right now, so
// the UI can show "synced / paused / unreachable / mismatch" instead of a
// silent failure. Combines the DB rule set (expanded per peer IP) with AGH's
// live filtering/protection state and the last sync result.
func DomainRuleSyncStatus(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		rules, err := loadDomainRules(ctx, store)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query domain rules")
			return
		}
		built, err := buildAdGuardRules(ctx, store, rules)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to expand domain rules")
			return
		}

		client := adguard.NewClient()
		ag := client.GetStatus(ctx)

		missing, unexpected := 0, 0
		if ag.Reachable {
			missing, unexpected = diffRuleSets(built.AdGuard, ag.UserRules)
		}

		lastAt, lastErr := lastDomainSync()
		resp := map[string]interface{}{
			"reachable":                    ag.Reachable,
			"error":                        ag.Error,
			"filtering_enabled":            ag.FilteringEnabled,
			"protection_enabled":           ag.ProtectionEnabled,
			"protection_on":                ag.ProtectionEnabled, // backward-compatible alias for the UI
			"protection_disabled_duration": ag.ProtectionDisabledDuration,
			"blocking_mode":                ag.BlockMode,
			"blocking_ipv4":                ag.BlockIPv4,
			"expected_rules":               len(built.AdGuard),
			"actual_rules":                 len(ag.UserRules),
			"missing_rules":                missing,
			"unexpected_rules":             unexpected,
			"invalid_rules":                len(built.Invalid),
			"unexpanded_rules":             built.Unexpanded,
			"db_rules":                     built.AdGuard,
			"ag_rules":                     ag.UserRules,
			"block_page_ip":                blockingIP(store),
		}
		if !lastAt.IsZero() {
			resp["last_sync_at"] = lastAt.UTC().Format(time.RFC3339)
		}
		if lastErr != "" {
			resp["last_sync_error"] = lastErr
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// CheckDomainRule asks AdGuard whether a domain is blocked right now (and, for
// user-scoped test, for a specific user's peer IP). Read-only diagnostics.
func CheckDomainRule(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := r.URL.Query().Get("domain")
		domain, err := normalizeDomain(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		ctx := context.Background()
		clientIP := ""
		if uidRaw := r.URL.Query().Get("user_id"); uidRaw != "" {
			uid, err := uuid.Parse(uidRaw)
			if err != nil {
				writeError(w, http.StatusBadRequest, "Invalid user ID")
				return
			}
			ips, err := userPeerIPs(ctx, store, uid, nil)
			if err == nil && len(ips) > 0 {
				clientIP = ips[0]
			}
		}

		client := adguard.NewClient()
		status := client.GetStatus(ctx)
		res, err := client.CheckHost(ctx, domain, clientIP, r.URL.Query().Get("qtype"))
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"domain":             domain,
				"blocked":            false,
				"reachable":          false,
				"error":              err.Error(),
				"protection_enabled": status.ProtectionEnabled,
				"filtering_enabled":  status.FilteringEnabled,
			})
			return
		}

		rules := make([]map[string]interface{}, 0, len(res.Rules))
		for _, rule := range res.Rules {
			rules = append(rules, map[string]interface{}{
				"text":           rule.Text,
				"filter_list_id": rule.FilterListID,
			})
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"domain":             domain,
			"blocked":            res.Blocked(),
			"reachable":          true,
			"reason":             res.Reason,
			"rule":               res.Rule,
			"rules":              rules,
			"canonical_name":     res.CanonName,
			"ip_addrs":           res.IPList,
			"protection_enabled": status.ProtectionEnabled,
			"filtering_enabled":  status.FilteringEnabled,
		})
	}
}

// ResyncDomainRules forces a full sync now (the "Resync now" button).
func ResyncDomainRules(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		n, err := SyncDomainRulesToAdGuard(store)
		if err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to sync rules: %v", err))
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status": "synced",
			"rules":  n,
		})
	}
}
