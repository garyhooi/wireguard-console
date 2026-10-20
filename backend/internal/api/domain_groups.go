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
)

// domainGroupView is the API shape of a Domain Group: a named, reusable set
// of domains that a blocking rule can reference.
type domainGroupView struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Domains     []string  `json:"domains"`
	DomainCount int       `json:"domain_count"`
	// RuleCount is how many blocking rules (global + per-user) use this group.
	RuleCount int       `json:"rule_count"`
	CreatedAt time.Time `json:"created_at"`
}

// ListDomainGroups returns every group with its domains and usage count.
func ListDomainGroups(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		rows, err := store.pool.Query(ctx, `
			SELECT g.id, g.name, g.created_at,
			       (SELECT count(*) FROM domain_block_rules dr WHERE dr.group_id = g.id)
			FROM domain_groups g
			ORDER BY lower(g.name)
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query domain groups")
			return
		}
		defer rows.Close()

		groups := []domainGroupView{}
		index := map[uuid.UUID]int{}
		for rows.Next() {
			var g domainGroupView
			if err := rows.Scan(&g.ID, &g.Name, &g.CreatedAt, &g.RuleCount); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan domain group")
				return
			}
			g.Domains = []string{}
			groups = append(groups, g)
			index[g.ID] = len(groups) - 1
		}
		if err := rows.Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to read domain groups")
			return
		}

		domainRows, err := store.pool.Query(ctx, `
			SELECT group_id, domain FROM domain_group_domains ORDER BY group_id, domain
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query group domains")
			return
		}
		defer domainRows.Close()
		for domainRows.Next() {
			var groupID uuid.UUID
			var domain string
			if err := domainRows.Scan(&groupID, &domain); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan group domain")
				return
			}
			if i, ok := index[groupID]; ok {
				groups[i].Domains = append(groups[i].Domains, domain)
				groups[i].DomainCount++
			}
		}

		writeJSON(w, http.StatusOK, groups)
	}
}

func getDomainGroupView(ctx context.Context, store *Store, id uuid.UUID) (domainGroupView, error) {
	var g domainGroupView
	err := store.pool.QueryRow(ctx, `
		SELECT g.id, g.name, g.created_at,
		       (SELECT count(*) FROM domain_block_rules dr WHERE dr.group_id = g.id)
		FROM domain_groups g WHERE g.id = $1
	`, id).Scan(&g.ID, &g.Name, &g.CreatedAt, &g.RuleCount)
	if err != nil {
		return g, err
	}

	rows, err := store.pool.Query(ctx, `
		SELECT domain FROM domain_group_domains WHERE group_id = $1 ORDER BY domain
	`, id)
	if err != nil {
		return g, err
	}
	defer rows.Close()
	g.Domains = []string{}
	for rows.Next() {
		var domain string
		if err := rows.Scan(&domain); err != nil {
			return g, err
		}
		g.Domains = append(g.Domains, domain)
	}
	g.DomainCount = len(g.Domains)
	return g, rows.Err()
}

// CreateDomainGroup creates a group and its domain list in one transaction.
func CreateDomainGroup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name    string   `json:"name"`
			Domains []string `json:"domains"`
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
		domains, err := normalizeDomainList(req.Domains)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create domain group")
			return
		}
		defer tx.Rollback(ctx)

		var id uuid.UUID
		err = tx.QueryRow(ctx, `
			INSERT INTO domain_groups (name, created_by) VALUES ($1, $2) RETURNING id
		`, name, adminID).Scan(&id)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				writeError(w, http.StatusConflict, fmt.Sprintf("a group named %q already exists", name))
				return
			}
			writeError(w, http.StatusInternalServerError, "Failed to create domain group")
			return
		}

		for _, domain := range domains {
			if _, err := tx.Exec(ctx, `
				INSERT INTO domain_group_domains (group_id, domain) VALUES ($1, $2)
				ON CONFLICT (group_id, domain) DO NOTHING
			`, id, domain); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to add group domains")
				return
			}
		}

		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to commit domain group")
			return
		}

		logAudit(ctx, store, adminID, "domain_group.create", "domain_group", id.String(), nil)

		view, err := getDomainGroupView(ctx, store, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load domain group")
			return
		}
		writeJSON(w, http.StatusCreated, view)
	}
}

// UpdateDomainGroup renames a group and/or replaces its domain list. Rules
// referencing the group pick up the change on the next sync (triggered here).
func UpdateDomainGroup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groupID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid group ID")
			return
		}

		var req struct {
			Name    *string   `json:"name"`
			Domains *[]string `json:"domains"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update domain group")
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
				UPDATE domain_groups SET name = $1, updated_at = now() WHERE id = $2
			`, name, groupID)
			if err != nil {
				var pgErr *pgconn.PgError
				if errors.As(err, &pgErr) && pgErr.Code == "23505" {
					writeError(w, http.StatusConflict, fmt.Sprintf("a group named %q already exists", name))
					return
				}
				writeError(w, http.StatusInternalServerError, "Failed to rename domain group")
				return
			}
			if res.RowsAffected() == 0 {
				writeError(w, http.StatusNotFound, "Domain group not found")
				return
			}
		}

		if req.Domains != nil {
			domains, err := normalizeDomainList(*req.Domains)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			if _, err := tx.Exec(ctx, `DELETE FROM domain_group_domains WHERE group_id = $1`, groupID); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to replace group domains")
				return
			}
			for _, domain := range domains {
				if _, err := tx.Exec(ctx, `
					INSERT INTO domain_group_domains (group_id, domain) VALUES ($1, $2)
					ON CONFLICT (group_id, domain) DO NOTHING
				`, groupID, domain); err != nil {
					writeError(w, http.StatusInternalServerError, "Failed to add group domains")
					return
				}
			}
		}

		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to commit domain group")
			return
		}

		logAudit(ctx, store, adminID, "domain_group.update", "domain_group", groupID.String(), nil)
		// Rules referencing this group must be re-expanded.
		RequestDomainRuleSync(store)

		view, err := getDomainGroupView(ctx, store, groupID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load domain group")
			return
		}
		writeJSON(w, http.StatusOK, view)
	}
}

// DeleteDomainGroup deletes a group. Rules that referenced it cascade away
// (the FK is ON DELETE CASCADE), so the UI can warn how many were removed.
func DeleteDomainGroup(store *Store) http.HandlerFunc {
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
			`SELECT count(*) FROM domain_block_rules WHERE group_id = $1`, groupID).Scan(&rulesRemoved)

		res, err := store.pool.Exec(ctx, `DELETE FROM domain_groups WHERE id = $1`, groupID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete domain group")
			return
		}
		if res.RowsAffected() == 0 {
			writeError(w, http.StatusNotFound, "Domain group not found")
			return
		}

		logAudit(ctx, store, adminID, "domain_group.delete", "domain_group", groupID.String(), nil)
		RequestDomainRuleSync(store)

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":        "deleted",
			"rules_removed": rulesRemoved,
		})
	}
}
