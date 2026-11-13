package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/wireguard-console/backend/internal/authz"
)

type adminRole struct {
	Slug        string    `json:"slug"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Permissions []string  `json:"permissions"`
	IsSystem    bool      `json:"is_system"`
	AdminCount  int       `json:"admin_count"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func loadAdminRole(ctx context.Context, store *Store, slug string) (adminRole, error) {
	var role adminRole
	err := store.pool.QueryRow(ctx, `
		SELECT r.slug, r.name, r.description, r.permissions, r.is_system, r.created_at, r.updated_at,
		       (SELECT count(*) FROM admins a WHERE a.role = r.slug)
		FROM admin_roles r
		WHERE r.slug = $1
	`, slug).Scan(&role.Slug, &role.Name, &role.Description, &role.Permissions, &role.IsSystem, &role.CreatedAt, &role.UpdatedAt, &role.AdminCount)
	if role.Permissions == nil {
		role.Permissions = []string{}
	}
	return role, err
}

func roleExists(ctx context.Context, store *Store, slug string) (bool, error) {
	if strings.TrimSpace(slug) == "" {
		return false, nil
	}
	var one int
	err := store.pool.QueryRow(ctx, `SELECT 1 FROM admin_roles WHERE slug = $1`, slug).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func roleSlugAvailable(ctx context.Context, store *Store, name, exceptSlug string) (bool, error) {
	var one int
	err := store.pool.QueryRow(ctx, `
		SELECT 1 FROM admin_roles
		WHERE lower(name) = lower($1) AND slug <> $2
	`, name, exceptSlug).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	return false, err
}

// ListAdminRoles returns the role rows and the permission catalogue the role
// editor needs. The response is one object so the UI never renders a role
// editor with a stale or missing key list.
func ListAdminRoles(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		rows, err := store.pool.Query(ctx, `
			SELECT r.slug, r.name, r.description, r.permissions, r.is_system, r.created_at, r.updated_at,
			       (SELECT count(*) FROM admins a WHERE a.role = r.slug)
			FROM admin_roles r
			ORDER BY r.is_system DESC, lower(r.name)
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load roles")
			return
		}
		defer rows.Close()

		roles := []adminRole{}
		for rows.Next() {
			var role adminRole
			if err := rows.Scan(&role.Slug, &role.Name, &role.Description, &role.Permissions, &role.IsSystem, &role.CreatedAt, &role.UpdatedAt, &role.AdminCount); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to read roles")
				return
			}
			if role.Permissions == nil {
				role.Permissions = []string{}
			}
			roles = append(roles, role)
		}
		if err := rows.Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to read roles")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"roles":       roles,
			"permissions": authz.All(),
			"groups":      authz.Groups(),
			"defaults":    authz.DefaultRoles,
		})
	}
}

func CreateAdminRole(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name        string   `json:"name"`
			Description string   `json:"description"`
			Permissions []string `json:"permissions"`
			Code        string   `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		ctx := context.Background()
		actorID := getAdminID(r)
		if !verifyActorMFA(w, r, ctx, store, actorID, req.Code) {
			return
		}

		name := strings.TrimSpace(req.Name)
		if name == "" || len(name) > 80 {
			writeError(w, http.StatusBadRequest, "Role name must be between 1 and 80 characters")
			return
		}
		if len(req.Description) > 300 {
			writeError(w, http.StatusBadRequest, "Role description must be at most 300 characters")
			return
		}
		slug := authz.Slugify(name)
		if slug == "" {
			writeError(w, http.StatusBadRequest, "Role name must contain letters or numbers")
			return
		}
		if len(slug) > 40 {
			writeError(w, http.StatusBadRequest, "Role name is too long (40 characters after normalization)")
			return
		}
		if slug == "super_admin" {
			writeError(w, http.StatusBadRequest, "That role name is reserved")
			return
		}
		taken, err := roleExists(ctx, store, slug)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to check role")
			return
		}
		if taken {
			writeError(w, http.StatusConflict, "A role with that name already exists")
			return
		}
		available, err := roleSlugAvailable(ctx, store, name, "")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to check role name")
			return
		}
		if !available {
			writeError(w, http.StatusConflict, "A role with that name already exists")
			return
		}
		policy, err := authz.Canonical(req.Permissions)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		if _, err := store.pool.Exec(ctx, `
			INSERT INTO admin_roles (slug, name, description, permissions, is_system)
			VALUES ($1, $2, $3, $4, FALSE)
		`, slug, name, strings.TrimSpace(req.Description), policy); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create role")
			return
		}
		logAudit(ctx, store, actorID, "role.create", "admin_role", slug, map[string]interface{}{
			"name":        name,
			"permissions": policy,
		})
		role, err := loadAdminRole(ctx, store, slug)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Role created but could not be read")
			return
		}
		writeJSON(w, http.StatusCreated, role)
	}
}

func UpdateAdminRole(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slug := strings.TrimSpace(r.PathValue("slug"))
		var req struct {
			Name        string    `json:"name"`
			Description *string   `json:"description"`
			Permissions *[]string `json:"permissions"`
			Code        string    `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		ctx := context.Background()
		actorID := getAdminID(r)
		cur, err := loadAdminRole(ctx, store, slug)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Role not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load role")
			return
		}
		if slug == "super_admin" {
			writeError(w, http.StatusBadRequest, "The super_admin policy is locked")
			return
		}
		if !verifyActorMFA(w, r, ctx, store, actorID, req.Code) {
			return
		}

		name := strings.TrimSpace(req.Name)
		if name == "" {
			name = cur.Name
		}
		if len(name) > 80 {
			writeError(w, http.StatusBadRequest, "Role name must be at most 80 characters")
			return
		}
		available, err := roleSlugAvailable(ctx, store, name, slug)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to check role name")
			return
		}
		if !available {
			writeError(w, http.StatusConflict, "A role with that name already exists")
			return
		}
		description := cur.Description
		if req.Description != nil {
			if len(*req.Description) > 300 {
				writeError(w, http.StatusBadRequest, "Role description must be at most 300 characters")
				return
			}
			description = strings.TrimSpace(*req.Description)
		}
		policy := cur.Permissions
		if req.Permissions != nil {
			policy, err = authz.Canonical(*req.Permissions)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
		}
		if policy == nil {
			policy = []string{}
		}

		if _, err := store.pool.Exec(ctx, `
			UPDATE admin_roles
			SET name = $1, description = $2, permissions = $3, updated_at = now()
			WHERE slug = $4
		`, name, description, policy, slug); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update role")
			return
		}
		logAudit(ctx, store, actorID, "role.update", "admin_role", slug, map[string]interface{}{
			"name":        name,
			"permissions": policy,
			"before":      cur.Permissions,
		})
		updated, err := loadAdminRole(ctx, store, slug)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Role updated but could not be read")
			return
		}
		writeJSON(w, http.StatusOK, updated)
	}
}

func DeleteAdminRole(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slug := strings.TrimSpace(r.PathValue("slug"))
		var req stepUpRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		ctx := context.Background()
		cur, err := loadAdminRole(ctx, store, slug)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Role not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load role")
			return
		}
		if cur.IsSystem || slug == "super_admin" {
			writeError(w, http.StatusBadRequest, "The super_admin role cannot be deleted")
			return
		}
		if cur.AdminCount > 0 {
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"error":       "Reassign the admins using this role before deleting it",
				"code":        "role_in_use",
				"admin_count": cur.AdminCount,
			})
			return
		}
		if !verifyActorMFA(w, r, ctx, store, getAdminID(r), req.Code) {
			return
		}
		if _, err := store.pool.Exec(ctx, `DELETE FROM admin_roles WHERE slug = $1`, slug); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete role")
			return
		}
		logAudit(ctx, store, getAdminID(r), "role.delete", "admin_role", slug, map[string]interface{}{"name": cur.Name})
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}
