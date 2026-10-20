package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// IP groups are the L3 analogue of domain groups: a named, reusable set of
// IPv4/IPv6 CIDRs. A single IP rule can target the whole group, and editing
// the group re-expands every rule that references it.

// ipGroupView is the API shape of an IP group.
type ipGroupView struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	CIDRs      []string  `json:"cidrs"`
	RangeCount int       `json:"range_count"`
	// RuleCount is how many blocking rules (global + per-user) use this group.
	RuleCount int       `json:"rule_count"`
	CreatedAt time.Time `json:"created_at"`
}

// normalizeCIDRList flattens a pasted list (one per line, commas/spaces also
// accepted), canonicalises every entry and de-duplicates.
func normalizeCIDRList(input []string) ([]string, error) {
	raw := expandDomainInput(input)
	if len(raw) == 0 {
		return nil, fmt.Errorf("at least one IP address or CIDR is required")
	}
	if len(raw) > 500 {
		return nil, fmt.Errorf("too many ranges (max 500 per group)")
	}

	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		cidr, err := normalizeIPRuleCIDR(item)
		if err != nil {
			return nil, err
		}
		if seen[cidr] {
			continue
		}
		seen[cidr] = true
		out = append(out, cidr)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("at least one IP address or CIDR is required")
	}
	return out, nil
}

// ListIPGroups returns every group with its ranges and usage count.
func ListIPGroups(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		rows, err := store.pool.Query(ctx, `
			SELECT g.id, g.name, g.created_at,
			       (SELECT count(*) FROM ip_block_rules r WHERE r.group_id = g.id)
			FROM ip_groups g
			ORDER BY lower(g.name)
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query IP groups")
			return
		}
		defer rows.Close()

		groups := []ipGroupView{}
		index := map[uuid.UUID]int{}
		for rows.Next() {
			var g ipGroupView
			if err := rows.Scan(&g.ID, &g.Name, &g.CreatedAt, &g.RuleCount); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan IP group")
				return
			}
			g.CIDRs = []string{}
			groups = append(groups, g)
			index[g.ID] = len(groups) - 1
		}
		if err := rows.Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to read IP groups")
			return
		}

		cidrRows, err := store.pool.Query(ctx, `
			SELECT group_id, cidr FROM ip_group_cidrs ORDER BY group_id, cidr
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query group ranges")
			return
		}
		defer cidrRows.Close()
		for cidrRows.Next() {
			var groupID uuid.UUID
			var cidr string
			if err := cidrRows.Scan(&groupID, &cidr); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan group range")
				return
			}
			if i, ok := index[groupID]; ok {
				groups[i].CIDRs = append(groups[i].CIDRs, cidr)
				groups[i].RangeCount++
			}
		}

		writeJSON(w, http.StatusOK, groups)
	}
}

func getIPGroupView(ctx context.Context, store *Store, id uuid.UUID) (ipGroupView, error) {
	var g ipGroupView
	err := store.pool.QueryRow(ctx, `
		SELECT g.id, g.name, g.created_at,
		       (SELECT count(*) FROM ip_block_rules r WHERE r.group_id = g.id)
		FROM ip_groups g WHERE g.id = $1
	`, id).Scan(&g.ID, &g.Name, &g.CreatedAt, &g.RuleCount)
	if err != nil {
		return g, err
	}

	rows, err := store.pool.Query(ctx, `
		SELECT cidr FROM ip_group_cidrs WHERE group_id = $1 ORDER BY cidr
	`, id)
	if err != nil {
		return g, err
	}
	defer rows.Close()
	g.CIDRs = []string{}
	for rows.Next() {
		var cidr string
		if err := rows.Scan(&cidr); err != nil {
			return g, err
		}
		g.CIDRs = append(g.CIDRs, cidr)
	}
	g.RangeCount = len(g.CIDRs)
	return g, rows.Err()
}

// CreateIPGroup creates a group and its ranges in one transaction.
func CreateIPGroup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name  string   `json:"name"`
			CIDRs []string `json:"cidrs"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		name, err := normalizeGroupName(req.Name)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		cidrs, err := normalizeCIDRList(req.CIDRs)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create IP group")
			return
		}
		defer tx.Rollback(ctx)

		var id uuid.UUID
		err = tx.QueryRow(ctx, `
			INSERT INTO ip_groups (name, created_by) VALUES ($1, $2) RETURNING id
		`, name, adminID).Scan(&id)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				writeError(w, http.StatusConflict, fmt.Sprintf("a group named %q already exists", name))
				return
			}
			writeError(w, http.StatusInternalServerError, "Failed to create IP group")
			return
		}

		for _, cidr := range cidrs {
			if _, err := tx.Exec(ctx, `
				INSERT INTO ip_group_cidrs (group_id, cidr) VALUES ($1, $2)
				ON CONFLICT (group_id, cidr) DO NOTHING
			`, id, cidr); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to add group ranges")
				return
			}
		}

		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to commit IP group")
			return
		}

		logAudit(ctx, store, adminID, "ip_group.create", "ip_group", id.String(), nil)

		view, err := getIPGroupView(ctx, store, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load IP group")
			return
		}
		writeJSON(w, http.StatusCreated, view)
	}
}

// UpdateIPGroup renames a group and/or replaces its ranges.
func UpdateIPGroup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groupID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid group ID")
			return
		}

		var req struct {
			Name  *string   `json:"name"`
			CIDRs *[]string `json:"cidrs"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update IP group")
			return
		}
		defer tx.Rollback(ctx)

		if req.Name != nil {
			name, err := normalizeGroupName(*req.Name)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			res, err := tx.Exec(ctx, `
				UPDATE ip_groups SET name = $1, updated_at = now() WHERE id = $2
			`, name, groupID)
			if err != nil {
				var pgErr *pgconn.PgError
				if errors.As(err, &pgErr) && pgErr.Code == "23505" {
					writeError(w, http.StatusConflict, fmt.Sprintf("a group named %q already exists", name))
					return
				}
				writeError(w, http.StatusInternalServerError, "Failed to rename IP group")
				return
			}
			if res.RowsAffected() == 0 {
				writeError(w, http.StatusNotFound, "IP group not found")
				return
			}
		}

		if req.CIDRs != nil {
			cidrs, err := normalizeCIDRList(*req.CIDRs)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			if _, err := tx.Exec(ctx, `DELETE FROM ip_group_cidrs WHERE group_id = $1`, groupID); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to replace group ranges")
				return
			}
			for _, cidr := range cidrs {
				if _, err := tx.Exec(ctx, `
					INSERT INTO ip_group_cidrs (group_id, cidr) VALUES ($1, $2)
					ON CONFLICT (group_id, cidr) DO NOTHING
				`, groupID, cidr); err != nil {
					writeError(w, http.StatusInternalServerError, "Failed to add group ranges")
					return
				}
			}
		}

		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to commit IP group")
			return
		}

		logAudit(ctx, store, adminID, "ip_group.update", "ip_group", groupID.String(), nil)
		// Rules referencing this group must be re-expanded.
		RequestIPBlockSync(store)

		view, err := getIPGroupView(ctx, store, groupID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load IP group")
			return
		}
		writeJSON(w, http.StatusOK, view)
	}
}

// DeleteIPGroup deletes a group; rules that referenced it cascade away.
func DeleteIPGroup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groupID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid group ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		var rulesRemoved int
		_ = store.pool.QueryRow(ctx,
			`SELECT count(*) FROM ip_block_rules WHERE group_id = $1`, groupID).Scan(&rulesRemoved)

		res, err := store.pool.Exec(ctx, `DELETE FROM ip_groups WHERE id = $1`, groupID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete IP group")
			return
		}
		if res.RowsAffected() == 0 {
			writeError(w, http.StatusNotFound, "IP group not found")
			return
		}

		logAudit(ctx, store, adminID, "ip_group.delete", "ip_group", groupID.String(), nil)
		RequestIPBlockSync(store)

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":        "deleted",
			"rules_removed": rulesRemoved,
		})
	}
}

// loadIPGroupCIDRs returns every group's ranges keyed by group id.
func loadIPGroupCIDRs(ctx context.Context, pool *pgxpool.Pool) (map[uuid.UUID][]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT group_id, cidr FROM ip_group_cidrs ORDER BY group_id, cidr
	`)
	if err != nil {
		return nil, fmt.Errorf("query IP group ranges: %w", err)
	}
	defer rows.Close()

	out := map[uuid.UUID][]string{}
	for rows.Next() {
		var groupID uuid.UUID
		var cidr string
		if err := rows.Scan(&groupID, &cidr); err != nil {
			return nil, err
		}
		out[groupID] = append(out[groupID], cidr)
	}
	return out, rows.Err()
}
