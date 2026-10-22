package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/wireguard-console/backend/internal/db"
	"github.com/wireguard-console/backend/internal/wgclient"
)

// IP blocking is the L3/L4 counterpart to domain blocking: admin-defined
// IPv4/IPv6 destinations are expanded per server/peer and enforced by
// wg-helper's nftables tables (forward hook priority -140). Unlike the AdGuard
// sync this is a pure kernel push, so it is fast and has no external
// dependency — but it still needs the same serialization/coalescing and status
// bookkeeping so concurrent edits cannot race and the UI can show the truth.

var (
	ipBlockSyncMu sync.Mutex // serializes full push passes (reconcile vs CRUD)

	ipBlockStateMu sync.Mutex
	ipBlockLastAt  time.Time
	ipBlockLastErr string

	ipBlockServerResults = map[uuid.UUID]ipBlockServerResult{}

	ipBlockReq struct {
		mu      sync.Mutex
		running bool
		dirty   bool
	}
)

type ipBlockServerResult struct {
	OK  bool
	Err string
	At  time.Time
}

func recordIPBlockSync(err error) {
	ipBlockStateMu.Lock()
	defer ipBlockStateMu.Unlock()
	ipBlockLastAt = time.Now()
	ipBlockLastErr = ""
	if err != nil {
		ipBlockLastErr = err.Error()
	}
}

func lastIPBlockSync() (time.Time, string) {
	ipBlockStateMu.Lock()
	defer ipBlockStateMu.Unlock()
	return ipBlockLastAt, ipBlockLastErr
}

func recordIPBlockServerResult(serverID uuid.UUID, err error) {
	ipBlockStateMu.Lock()
	defer ipBlockStateMu.Unlock()
	res := ipBlockServerResult{OK: err == nil, At: time.Now()}
	if err != nil {
		res.Err = err.Error()
	}
	ipBlockServerResults[serverID] = res
}

func ipBlockServerResultFor(serverID uuid.UUID) (ipBlockServerResult, bool) {
	ipBlockStateMu.Lock()
	defer ipBlockStateMu.Unlock()
	res, ok := ipBlockServerResults[serverID]
	return res, ok
}

// RequestIPBlockSync asks for an async re-push of the expanded IP-block rule
// set. Repeated requests while a pass is running are coalesced into one more
// pass (the DB is re-read at the start of each pass, so the newest rules win).
func RequestIPBlockSync(store *Store) {
	ipBlockReq.mu.Lock()
	if ipBlockReq.running {
		ipBlockReq.dirty = true
		ipBlockReq.mu.Unlock()
		return
	}
	ipBlockReq.running = true
	ipBlockReq.mu.Unlock()

	go func() {
		for {
			if err := EnsureLocalIPBlocking(store.pool); err != nil {
				log.Printf("IP-block sync: %v", err)
			}
			ipBlockReq.mu.Lock()
			if !ipBlockReq.dirty {
				ipBlockReq.running = false
				ipBlockReq.mu.Unlock()
				return
			}
			ipBlockReq.dirty = false
			ipBlockReq.mu.Unlock()
		}
	}()
}

// ipRuleRow is the API shape of a rule with its user joined in.
type ipRuleRow struct {
	db.IPBlockRule
	UserEmail          string   `json:"user_email"`
	UserFullName       string   `json:"user_full_name"`
	UserDepartmentName string   `json:"user_department_name"`
	DepartmentName     string   `json:"department_name"`
	GroupName          string   `json:"group_name,omitempty"`
	PeerNames          []string `json:"peer_names"`
}

func loadIPBlockRules(ctx context.Context, pool *pgxpool.Pool) ([]db.IPBlockRule, error) {
	rows, err := pool.Query(ctx, `
		SELECT id, scope, user_id, department_id, cidr, group_id, note, created_by, created_at,
		       COALESCE(array_to_string(peer_ids, ','), '')
		FROM ip_block_rules
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("query IP rules: %w", err)
	}
	defer rows.Close()

	var rules []db.IPBlockRule
	for rows.Next() {
		var rule db.IPBlockRule
		var cidr sql.NullString
		var peerIDsRaw string
		if err := rows.Scan(&rule.ID, &rule.Scope, &rule.UserID, &rule.DepartmentID, &cidr, &rule.GroupID,
			&rule.Note, &rule.CreatedBy, &rule.CreatedAt, &peerIDsRaw); err != nil {
			return nil, fmt.Errorf("scan IP rule: %w", err)
		}
		rule.CIDR = cidr.String
		rule.PeerIDs = parseStoredPeerIDs(peerIDsRaw)
		rules = append(rules, rule)
	}
	return rules, rows.Err()
}

// blockingIPForPool returns the tunnel gateway address that serves the branded
// block page / AdGuard listener, or "" when no local server exists.
func blockingIPForPool(ctx context.Context, pool *pgxpool.Pool) string {
	var ip string
	err := pool.QueryRow(ctx, `
		SELECT host(network(network_cidr)::inet + 1)
		FROM servers WHERE status = 'active' AND managed_mode = 'local'
		ORDER BY created_at LIMIT 1
	`).Scan(&ip)
	if err != nil {
		return ""
	}
	return ip
}

// ipBlockConflict is one rule/server pair that was deliberately not enforced
// because it would break the tunnel's own control plane.
type ipBlockConflict struct {
	RuleID uuid.UUID `json:"rule_id"`
	CIDR   string    `json:"cidr"`
	Reason string    `json:"reason"`
}

// serverPeer is one active peer as seen by one server: its id (used to filter
// peer-scoped rules) and its tunnel IP (the source address in the drop rule).
type serverPeer struct {
	ID uuid.UUID
	IP string
}

// peersByUserForServer maps each user to their active peers on this server
// (peer id + tunnel IP), the source data for per-user blocking rules.
func peersByUserForServer(ctx context.Context, pool *pgxpool.Pool, serverID uuid.UUID) (map[uuid.UUID][]serverPeer, error) {
	rows, err := pool.Query(ctx, `
		SELECT user_id, id, host(allowed_ip) FROM peers
		WHERE server_id = $1 AND status = 'active'
		ORDER BY allowed_ip
	`, serverID)
	if err != nil {
		return nil, fmt.Errorf("query peers: %w", err)
	}
	defer rows.Close()

	out := map[uuid.UUID][]serverPeer{}
	for rows.Next() {
		var userID, peerID uuid.UUID
		var ip string
		if err := rows.Scan(&userID, &peerID, &ip); err != nil {
			return nil, err
		}
		out[userID] = append(out[userID], serverPeer{ID: peerID, IP: ip})
	}
	return out, rows.Err()
}

// peersByDepartmentForServer maps each department with active peers on the
// server to those peer IPs (for department-scoped rules).
func peersByDepartmentForServer(ctx context.Context, pool *pgxpool.Pool, serverID uuid.UUID) (map[uuid.UUID][]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT u.department_id, host(p.allowed_ip)
		FROM peers p
		JOIN users u ON u.id = p.user_id
		WHERE p.server_id = $1 AND p.status = 'active' AND u.department_id IS NOT NULL
		ORDER BY u.department_id, p.allowed_ip
	`, serverID)
	if err != nil {
		return nil, fmt.Errorf("query department peers: %w", err)
	}
	defer rows.Close()

	out := map[uuid.UUID][]string{}
	for rows.Next() {
		var departmentID uuid.UUID
		var ip string
		if err := rows.Scan(&departmentID, &ip); err != nil {
			return nil, err
		}
		out[departmentID] = append(out[departmentID], ip)
	}
	return out, rows.Err()
}

// expandIPBlockRules turns stored rules into the exact per-server drop list:
// global rules once with an empty source, per-user rules once per active peer
// (narrowed to the rule's peer selection when it has one), source/destination
// family pairs kept consistent, and control-plane conflicts filtered out. Pure
// function (unit-testable).
func expandIPBlockRules(
	rules []db.IPBlockRule,
	peersByUser map[uuid.UUID][]serverPeer,
	peersByDepartment map[uuid.UUID][]string,
	groupCIDRs map[uuid.UUID][]string,
	gatewayIP, blockPageIP string,
) ([]wgclient.IPBlockRule, []ipBlockConflict, []uuid.UUID) {
	type key struct{ source, cidr string }
	seen := map[key]bool{}
	entries := []wgclient.IPBlockRule{}
	var conflicts []ipBlockConflict
	var unexpanded []uuid.UUID

	add := func(source, cidr string) {
		k := key{source, cidr}
		if seen[k] {
			return
		}
		seen[k] = true
		entries = append(entries, wgclient.IPBlockRule{SourceIP: source, CIDR: cidr})
	}

	for _, rule := range rules {
		// Resolve the rule's destinations: one CIDR, or every range in its group.
		dests := []string{rule.CIDR}
		if rule.GroupID != nil {
			dests = groupCIDRs[*rule.GroupID]
			if len(dests) == 0 {
				unexpanded = append(unexpanded, rule.ID)
				continue
			}
		}

		ruleAdded := false
		for _, dest := range dests {
			reason := ""
			if gatewayIP != "" && cidrContains(dest, gatewayIP) {
				reason = "contains the tunnel gateway " + gatewayIP + " (DNS/block page)"
			} else if blockPageIP != "" && cidrContains(dest, blockPageIP) {
				reason = "contains the block-page/AdGuard address " + blockPageIP
			}
			if reason != "" {
				conflicts = append(conflicts, ipBlockConflict{RuleID: rule.ID, CIDR: dest, Reason: reason})
				continue
			}

			if rule.Scope == "user" && rule.UserID != nil {
				peerFilter := peerIDSet(rule.PeerIDs)
				for _, peer := range peersByUser[*rule.UserID] {
					// A peer-scoped rule expands only to its selected peers; an
					// empty selection keeps the legacy all-peers behaviour.
					if peerFilter != nil && !peerFilter[peer.ID] {
						continue
					}
					if cidrIsIPv4(dest) != isIPv4Address(peer.IP) {
						continue // no valid source of this family on this server
					}
					add(peer.IP, dest)
					ruleAdded = true
				}
				continue
			}
			if rule.Scope == "department" && rule.DepartmentID != nil {
				for _, peerIP := range peersByDepartment[*rule.DepartmentID] {
					if cidrIsIPv4(dest) != isIPv4Address(peerIP) {
						continue // no valid source of this family on this server
					}
					add(peerIP, dest)
					ruleAdded = true
				}
				continue
			}
			add("", dest)
			ruleAdded = true
		}
		if (rule.Scope == "user" && rule.UserID != nil && !ruleAdded) ||
			(rule.Scope == "department" && rule.DepartmentID != nil && !ruleAdded) {
			unexpanded = append(unexpanded, rule.ID)
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].SourceIP != entries[j].SourceIP {
			return entries[i].SourceIP < entries[j].SourceIP
		}
		return entries[i].CIDR < entries[j].CIDR
	})
	return entries, conflicts, unexpanded
}

// buildIPBlockPayload loads the rules and the server's peers and expands the
// complete drop list for one server. Conflicts are reported (and skipped).
func buildIPBlockPayload(ctx context.Context, pool *pgxpool.Pool, serverID uuid.UUID) (
	[]wgclient.IPBlockRule, []ipBlockConflict, []uuid.UUID, error,
) {
	var cidr, mode string
	if err := pool.QueryRow(ctx,
		`SELECT network_cidr::text, managed_mode FROM servers WHERE id = $1`, serverID,
	).Scan(&cidr, &mode); err != nil {
		return nil, nil, nil, fmt.Errorf("server lookup: %w", err)
	}
	gatewayIP, _, err := gatewayForCIDR(cidr)
	if err != nil {
		return nil, nil, nil, err
	}
	blockPageIP := ""
	if mode == "local" {
		// Only a local server shares the host with AdGuard and the block page.
		blockPageIP = blockingIPForPool(ctx, pool)
	}

	rules, err := loadIPBlockRules(ctx, pool)
	if err != nil {
		return nil, nil, nil, err
	}
	groupCIDRs, err := loadIPGroupCIDRs(ctx, pool)
	if err != nil {
		return nil, nil, nil, err
	}
	peers, err := peersByUserForServer(ctx, pool, serverID)
	if err != nil {
		return nil, nil, nil, err
	}
	departmentPeers, err := peersByDepartmentForServer(ctx, pool, serverID)
	if err != nil {
		return nil, nil, nil, err
	}
	entries, conflicts, unexpanded := expandIPBlockRules(rules, peers, departmentPeers, groupCIDRs, gatewayIP, blockPageIP)
	return entries, conflicts, unexpanded, nil
}

// ListIPRules returns every IP rule with the owning user's display fields.
func ListIPRules(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		rows, err := store.pool.Query(ctx, `
			SELECT r.id, r.scope, r.user_id, r.department_id, r.cidr, r.group_id, r.note, r.created_by, r.created_at,
			       COALESCE(array_to_string(r.peer_ids, ','), ''),
			       COALESCE(u.email, ''), COALESCE(u.full_name, ''), COALESCE(d.name, ''),
			       COALESCE(dd.name, ''), COALESCE(g.name, ''),
			       COALESCE((SELECT array_agg(p.name ORDER BY p.name)
			                 FROM peers p WHERE p.id = ANY(r.peer_ids)), ARRAY[]::text[])
			FROM ip_block_rules r
			LEFT JOIN users u ON u.id = r.user_id
			LEFT JOIN departments d ON d.id = u.department_id
			LEFT JOIN departments dd ON dd.id = r.department_id
			LEFT JOIN ip_groups g ON g.id = r.group_id
			ORDER BY r.created_at DESC
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query IP rules")
			return
		}
		defer rows.Close()

		rules := []ipRuleRow{}
		for rows.Next() {
			var rule ipRuleRow
			var cidr sql.NullString
			var peerIDsRaw string
			if err := rows.Scan(&rule.ID, &rule.Scope, &rule.UserID, &rule.DepartmentID, &cidr, &rule.GroupID,
				&rule.Note, &rule.CreatedBy, &rule.CreatedAt, &peerIDsRaw, &rule.UserEmail, &rule.UserFullName,
				&rule.UserDepartmentName, &rule.DepartmentName, &rule.GroupName, &rule.PeerNames); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan IP rule")
				return
			}
			rule.CIDR = cidr.String
			rule.PeerIDs = parseStoredPeerIDs(peerIDsRaw)
			if rule.PeerNames == nil {
				rule.PeerNames = []string{}
			}
			rules = append(rules, rule)
		}
		writeJSON(w, http.StatusOK, rules)
	}
}

func getIPRule(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) (ipRuleRow, error) {
	var rule ipRuleRow
	var cidr sql.NullString
	var peerIDsRaw string
	err := pool.QueryRow(ctx, `
		SELECT r.id, r.scope, r.user_id, r.department_id, r.cidr, r.group_id, r.note, r.created_by, r.created_at,
		       COALESCE(array_to_string(r.peer_ids, ','), ''),
		       COALESCE(u.email, ''), COALESCE(u.full_name, ''), COALESCE(d.name, ''),
		       COALESCE(dd.name, ''), COALESCE(g.name, ''),
		       COALESCE((SELECT array_agg(p.name ORDER BY p.name)
		                 FROM peers p WHERE p.id = ANY(r.peer_ids)), ARRAY[]::text[])
		FROM ip_block_rules r
		LEFT JOIN users u ON u.id = r.user_id
		LEFT JOIN departments d ON d.id = u.department_id
		LEFT JOIN departments dd ON dd.id = r.department_id
		LEFT JOIN ip_groups g ON g.id = r.group_id
		WHERE r.id = $1
	`, id).Scan(&rule.ID, &rule.Scope, &rule.UserID, &rule.DepartmentID, &cidr, &rule.GroupID, &rule.Note,
		&rule.CreatedBy, &rule.CreatedAt, &peerIDsRaw, &rule.UserEmail, &rule.UserFullName,
		&rule.UserDepartmentName, &rule.DepartmentName, &rule.GroupName, &rule.PeerNames)
	rule.CIDR = cidr.String
	rule.PeerIDs = parseStoredPeerIDs(peerIDsRaw)
	if rule.PeerNames == nil {
		rule.PeerNames = []string{}
	}
	return rule, err
}

// CreateIPRule validates and stores an IP/CIDR block, then re-pushes the
// expanded rule set to every local server (async, coalesced).
func CreateIPRule(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Scope        string     `json:"scope"`
			UserID       *uuid.UUID `json:"user_id"`
			DepartmentID *uuid.UUID `json:"department_id"`
			CIDR         string     `json:"cidr"`
			GroupID      *uuid.UUID `json:"group_id"`
			Note         string     `json:"note"`
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
		default:
			writeError(w, http.StatusBadRequest, "Scope must be global, user or department")
			return
		}
		if len(req.Note) > 200 {
			writeError(w, http.StatusBadRequest, "Note is too long (max 200 characters)")
			return
		}

		hasCIDR := strings.TrimSpace(req.CIDR) != ""
		hasGroup := req.GroupID != nil
		if hasCIDR == hasGroup {
			writeError(w, http.StatusBadRequest, "Provide either an IP/CIDR or an IP group (exactly one)")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		var (
			cidr      string
			domainArg *string
			groupName string
		)
		var targetID string

		if hasCIDR {
			var err error
			cidr, err = normalizeIPRuleCIDR(req.CIDR)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			domainArg = &cidr
			targetID = cidr
		} else {
			if err := store.pool.QueryRow(ctx,
				`SELECT name FROM ip_groups WHERE id = $1`, *req.GroupID).Scan(&groupName); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					writeError(w, http.StatusNotFound, "IP group not found")
					return
				}
				writeError(w, http.StatusInternalServerError, "Failed to check IP group")
				return
			}
			targetID = req.GroupID.String()
		}

		if req.UserID != nil {
			var exists bool
			err := store.pool.QueryRow(ctx, `SELECT true FROM users WHERE id = $1`, *req.UserID).Scan(&exists)
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusBadRequest, "User not found")
				return
			}
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to check user")
				return
			}
		}
		if req.DepartmentID != nil {
			ok, err := departmentExists(ctx, store, *req.DepartmentID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to check department")
				return
			}
			if !ok {
				writeError(w, http.StatusBadRequest, "Department not found")
				return
			}
		}

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

		var exists bool
		var err error
		if hasCIDR {
			err = store.pool.QueryRow(ctx, `
				SELECT true FROM ip_block_rules
				WHERE scope = $1
				  AND COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
				    = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
				  AND COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid)
				    = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
				  AND cidr = $4
				  AND peer_ids = $5::text[]::uuid[]
				LIMIT 1
			`, req.Scope, req.UserID, req.DepartmentID, cidr, peerIDStrings(peerIDs)).Scan(&exists)
		} else {
			err = store.pool.QueryRow(ctx, `
				SELECT true FROM ip_block_rules
				WHERE scope = $1
				  AND COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
				    = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
				  AND COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid)
				    = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
				  AND group_id = $4
				  AND peer_ids = $5::text[]::uuid[]
				LIMIT 1
			`, req.Scope, req.UserID, req.DepartmentID, *req.GroupID, peerIDStrings(peerIDs)).Scan(&exists)
		}
		if err == nil {
			suffix := " for this scope"
			if len(peerIDs) > 0 {
				suffix = " for the chosen peers"
			}
			if hasCIDR {
				writeError(w, http.StatusConflict, fmt.Sprintf("%s is already blocked%s", cidr, suffix))
			} else {
				writeError(w, http.StatusConflict, fmt.Sprintf("group %q is already blocked%s", groupName, suffix))
			}
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "Failed to check existing rules")
			return
		}

		var id uuid.UUID
		err = store.pool.QueryRow(ctx, `
			INSERT INTO ip_block_rules (scope, user_id, department_id, cidr, group_id, note, created_by, peer_ids)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[]::uuid[]) RETURNING id
		`, req.Scope, req.UserID, req.DepartmentID, domainArg, req.GroupID, req.Note, adminID, peerIDStrings(peerIDs)).Scan(&id)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				writeError(w, http.StatusConflict, "This rule already exists for this scope")
				return
			}
			writeError(w, http.StatusInternalServerError, "Failed to create IP rule")
			return
		}

		logAudit(ctx, store, adminID, "ip_rule.create", "ip_rule", targetID, nil)
		RequestIPBlockSync(store)

		rule, err := getIPRule(ctx, store.pool, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load IP rule")
			return
		}
		writeJSON(w, http.StatusCreated, rule)
	}
}

// DeleteIPRule removes a rule; the next sync clears it from the kernel.
func DeleteIPRule(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ruleID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid rule ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		res, err := store.pool.Exec(ctx, `DELETE FROM ip_block_rules WHERE id = $1`, ruleID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete IP rule")
			return
		}
		if res.RowsAffected() == 0 {
			writeError(w, http.StatusNotFound, "IP rule not found")
			return
		}

		logAudit(ctx, store, adminID, "ip_rule.delete", "ip_rule", ruleID.String(), nil)
		RequestIPBlockSync(store)

		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}

// IPRuleStatus reports what the kernel should/does have, so the UI can show
// enforcement truth instead of a silent no-op.
func IPRuleStatus(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		rules, err := loadIPBlockRules(ctx, store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query IP rules")
			return
		}

		type localServerStatus struct {
			ServerID  uuid.UUID `json:"server_id"`
			Name      string    `json:"name"`
			Interface string    `json:"interface"`
			OK        bool      `json:"ok"`
			Error     string    `json:"error"`
			AppliedAt string    `json:"applied_at,omitempty"`
		}
		type conflictView struct {
			RuleID uuid.UUID `json:"rule_id"`
			CIDR   string    `json:"cidr"`
			Server string    `json:"server"`
			Reason string    `json:"reason"`
		}

		servers := []localServerStatus{}
		conflicts := []conflictView{}
		expected, applied, failed := 0, 0, 0

		rows, err := store.pool.Query(ctx, `
			SELECT id, name, interface_name FROM servers
			WHERE status = 'active' AND managed_mode = 'local'
			ORDER BY created_at
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query servers")
			return
		}
		type serverRef struct {
			id    uuid.UUID
			name  string
			iface string
		}
		var refs []serverRef
		for rows.Next() {
			var s serverRef
			if err := rows.Scan(&s.id, &s.name, &s.iface); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan server")
				return
			}
			refs = append(refs, s)
		}
		rows.Close()

		for _, ref := range refs {
			entries, serverConflicts, _, err := buildIPBlockPayload(ctx, store.pool, ref.id)
			sv := localServerStatus{ServerID: ref.id, Name: ref.name, Interface: ref.iface}
			if err != nil {
				sv.OK = false
				sv.Error = "expand: " + err.Error()
				failed++
			} else {
				expected += len(entries)
				for _, c := range serverConflicts {
					conflicts = append(conflicts, conflictView{RuleID: c.RuleID, CIDR: c.CIDR, Server: ref.name, Reason: c.Reason})
				}
				if res, ok := ipBlockServerResultFor(ref.id); ok {
					sv.OK, sv.Error = res.OK, res.Err
					if !res.At.IsZero() {
						sv.AppliedAt = res.At.UTC().Format(time.RFC3339)
					}
					if res.OK {
						applied++
					} else {
						failed++
					}
				} else {
					sv.OK = false
					failed++
				}
			}
			servers = append(servers, sv)
		}

		// A user rule is "waiting" only when none of its target peers (the whole
		// user when peer-scoped with an empty selection) has an active peer on ANY
		// active server; partial expansion elsewhere still enforces it.
		unexpandedCount := 0
		if err := store.pool.QueryRow(ctx, `
			SELECT count(*) FROM ip_block_rules r
			WHERE r.scope = 'user' AND NOT EXISTS (
				SELECT 1 FROM peers p JOIN servers s ON s.id = p.server_id
				WHERE p.user_id = r.user_id AND p.status = 'active' AND s.status = 'active'
				  AND (cardinality(r.peer_ids) = 0 OR p.id = ANY(r.peer_ids))
			)
		`).Scan(&unexpandedCount); err != nil {
			unexpandedCount = 0
		}

		// Department rules are "waiting" only when no member user has an
		// active peer on any active server.
		unexpandedDepartmentCount := 0
		if err := store.pool.QueryRow(ctx, `
			SELECT count(*) FROM ip_block_rules r
			WHERE r.scope = 'department' AND NOT EXISTS (
				SELECT 1 FROM peers p
				JOIN users u ON u.id = p.user_id
				JOIN servers s ON s.id = p.server_id
				WHERE u.department_id = r.department_id AND p.status = 'active' AND s.status = 'active'
			)
		`).Scan(&unexpandedDepartmentCount); err != nil {
			unexpandedDepartmentCount = 0
		}

		global, user, department := 0, 0, 0
		for _, rule := range rules {
			switch rule.Scope {
			case "global":
				global++
			case "department":
				department++
			default:
				user++
			}
		}

		resp := map[string]interface{}{
			"enabled":                     os.Getenv("WG_IP_BLOCK") != "0",
			"rules_total":                 len(rules),
			"global_rules":                global,
			"user_rules":                  user,
			"department_rules":            department,
			"expected_entries":            expected,
			"applied_servers":             applied,
			"failed_servers":              failed,
			"local_servers":               servers,
			"unexpanded_user_rules":       unexpandedCount,
			"unexpanded_department_rules": unexpandedDepartmentCount,
			"conflicts":                   conflicts,
		}
		if lastAt, lastErr := lastIPBlockSync(); !lastAt.IsZero() {
			resp["last_sync_at"] = lastAt.UTC().Format(time.RFC3339)
			if lastErr != "" {
				resp["last_sync_error"] = lastErr
			}
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// ResyncIPRules forces an immediate full push (super_admin).
func ResyncIPRules(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		rules, err := loadIPBlockRules(ctx, store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query IP rules")
			return
		}
		if err := EnsureLocalIPBlocking(store.pool); err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to sync IP rules: %v", err))
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status": "synced",
			"rules":  len(rules),
		})
	}
}
