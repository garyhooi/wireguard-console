package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Departments are free-form labels for VPN users (e.g. Engineering, Sales).
// A user belongs to at most one department; deleting a department unassigns
// its users (ON DELETE SET NULL) — it never deletes accounts.

type departmentView struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	UserCount int       `json:"user_count"`
	CreatedAt time.Time `json:"created_at"`
}

func normalizeDepartmentName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("department name is required")
	}
	if utf8.RuneCountInString(name) > 80 {
		return "", fmt.Errorf("department name is too long (max 80 characters)")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("department name contains control characters")
		}
	}
	return name, nil
}

func ListDepartments(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		rows, err := store.pool.Query(ctx, `
			SELECT d.id, d.name, d.created_at,
			       (SELECT count(*) FROM users u
			         WHERE u.department_id = d.id AND u.status <> 'removed')
			FROM departments d
			ORDER BY lower(d.name)
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query departments")
			return
		}
		defer rows.Close()

		out := []departmentView{}
		for rows.Next() {
			var d departmentView
			if err := rows.Scan(&d.ID, &d.Name, &d.CreatedAt, &d.UserCount); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan department")
				return
			}
			out = append(out, d)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func CreateDepartment(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		name, err := normalizeDepartmentName(req.Name)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		var d departmentView
		err = store.pool.QueryRow(ctx, `
			INSERT INTO departments (name) VALUES ($1)
			RETURNING id, name, created_at, 0
		`, name).Scan(&d.ID, &d.Name, &d.CreatedAt, &d.UserCount)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				writeError(w, http.StatusConflict, fmt.Sprintf("a department named %q already exists", name))
				return
			}
			writeError(w, http.StatusInternalServerError, "Failed to create department")
			return
		}

		logAudit(ctx, store, adminID, "department.create", "department", d.ID.String(), nil)
		writeJSON(w, http.StatusCreated, d)
	}
}

func UpdateDepartment(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		deptID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid department ID")
			return
		}
		var req struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		name, err := normalizeDepartmentName(req.Name)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		res, err := store.pool.Exec(ctx, `
			UPDATE departments SET name = $1, updated_at = now() WHERE id = $2
		`, name, deptID)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				writeError(w, http.StatusConflict, fmt.Sprintf("a department named %q already exists", name))
				return
			}
			writeError(w, http.StatusInternalServerError, "Failed to update department")
			return
		}
		if res.RowsAffected() == 0 {
			writeError(w, http.StatusNotFound, "Department not found")
			return
		}

		logAudit(ctx, store, adminID, "department.update", "department", deptID.String(), nil)

		var d departmentView
		err = store.pool.QueryRow(ctx, `
			SELECT d.id, d.name, d.created_at,
			       (SELECT count(*) FROM users u
			         WHERE u.department_id = d.id AND u.status <> 'removed')
			FROM departments d WHERE d.id = $1
		`, deptID).Scan(&d.ID, &d.Name, &d.CreatedAt, &d.UserCount)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load department")
			return
		}
		writeJSON(w, http.StatusOK, d)
	}
}

// DeleteDepartment removes the department and unassigns its users (the FK is
// ON DELETE SET NULL); users_cleared reports how many were unassigned.
func DeleteDepartment(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		deptID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid department ID")
			return
		}
		ctx := context.Background()
		adminID := getAdminID(r)

		var usersCleared int
		_ = store.pool.QueryRow(ctx,
			`SELECT count(*) FROM users WHERE department_id = $1`, deptID).Scan(&usersCleared)

		res, err := store.pool.Exec(ctx, `DELETE FROM departments WHERE id = $1`, deptID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete department")
			return
		}
		if res.RowsAffected() == 0 {
			writeError(w, http.StatusNotFound, "Department not found")
			return
		}

		logAudit(ctx, store, adminID, "department.delete", "department", deptID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":        "deleted",
			"users_cleared": usersCleared,
		})
	}
}

// departmentExists validates an optional department id for user create/update.
func departmentExists(ctx context.Context, store *Store, id uuid.UUID) (bool, error) {
	var exists bool
	err := store.pool.QueryRow(ctx, `SELECT true FROM departments WHERE id = $1`, id).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
