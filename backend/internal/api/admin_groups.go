package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type adminGroupRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type adminGroup struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	MemberCount int       `json:"member_count"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type adminGroupMember struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	RoleName string `json:"role_name"`
	Status   string `json:"status"`
}

func loadAdminGroups(ctx context.Context, store *Store, adminIDs []uuid.UUID) (map[uuid.UUID][]adminGroupRef, error) {
	out := make(map[uuid.UUID][]adminGroupRef)
	if len(adminIDs) == 0 {
		return out, nil
	}
	rows, err := store.pool.Query(ctx, `
		SELECT m.admin_id, g.id, g.name
		FROM admin_group_members m
		JOIN admin_groups g ON g.id = m.group_id
		WHERE m.admin_id = ANY($1)
		ORDER BY lower(g.name)
	`, adminIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			adminID uuid.UUID
			group   adminGroupRef
			gid     uuid.UUID
		)
		if err := rows.Scan(&adminID, &gid, &group.Name); err != nil {
			return nil, err
		}
		group.ID = gid.String()
		out[adminID] = append(out[adminID], group)
	}
	return out, rows.Err()
}

func ListAdminGroups(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		rows, err := store.pool.Query(ctx, `
			SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
			       (SELECT count(*) FROM admin_group_members m WHERE m.group_id = g.id)
			FROM admin_groups g
			ORDER BY lower(g.name)
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load admin groups")
			return
		}
		defer rows.Close()
		groups := []adminGroup{}
		for rows.Next() {
			var g adminGroup
			var gid uuid.UUID
			if err := rows.Scan(&gid, &g.Name, &g.Description, &g.CreatedAt, &g.UpdatedAt, &g.MemberCount); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to read admin groups")
				return
			}
			g.ID = gid.String()
			groups = append(groups, g)
		}
		if err := rows.Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to read admin groups")
			return
		}
		writeJSON(w, http.StatusOK, groups)
	}
}

func groupNameAvailable(ctx context.Context, store *Store, name, exceptID string) (bool, error) {
	var one int
	err := store.pool.QueryRow(ctx, `
		SELECT 1 FROM admin_groups
		WHERE lower(name) = lower($1) AND id::text <> $2
	`, name, exceptID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	return false, err
}

func CreateAdminGroup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		name := strings.TrimSpace(req.Name)
		if name == "" || len(name) > 80 {
			writeError(w, http.StatusBadRequest, "Group name must be between 1 and 80 characters")
			return
		}
		if len(req.Description) > 300 {
			writeError(w, http.StatusBadRequest, "Group description must be at most 300 characters")
			return
		}
		ctx := context.Background()
		available, err := groupNameAvailable(ctx, store, name, "")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to check group name")
			return
		}
		if !available {
			writeError(w, http.StatusConflict, "An admin group with that name already exists")
			return
		}
		var id uuid.UUID
		if err := store.pool.QueryRow(ctx, `
			INSERT INTO admin_groups (name, description) VALUES ($1, $2) RETURNING id
		`, name, strings.TrimSpace(req.Description)).Scan(&id); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create admin group")
			return
		}
		logAudit(ctx, store, getAdminID(r), "admin_group.create", "admin_group", id.String(), map[string]string{"name": name})
		g, err := loadAdminGroup(ctx, store, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Group created but could not be read")
			return
		}
		writeJSON(w, http.StatusCreated, g)
	}
}

func loadAdminGroup(ctx context.Context, store *Store, id uuid.UUID) (adminGroup, error) {
	var g adminGroup
	var gid uuid.UUID
	err := store.pool.QueryRow(ctx, `
		SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
		       (SELECT count(*) FROM admin_group_members m WHERE m.group_id = g.id)
		FROM admin_groups g WHERE g.id = $1
	`, id).Scan(&gid, &g.Name, &g.Description, &g.CreatedAt, &g.UpdatedAt, &g.MemberCount)
	g.ID = gid.String()
	return g, err
}

func validateAdminGroupIDs(ctx context.Context, store *Store, rawIDs []string) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(rawIDs))
	for _, raw := range rawIDs {
		id, err := parseUUID(raw)
		if err != nil {
			return nil, errors.New("invalid admin group ID")
		}
		ids = append(ids, id)
	}
	if len(ids) > 0 {
		var count int
		if err := store.pool.QueryRow(ctx, `SELECT count(*) FROM admin_groups WHERE id = ANY($1)`, ids).Scan(&count); err != nil {
			return nil, err
		}
		if count != len(ids) {
			return nil, errors.New("one or more admin groups do not exist")
		}
	}
	return ids, nil
}

// replaceAdminGroupMemberships is used by admin invite/update. A nil slice
// means "leave memberships alone"; an empty non-nil slice clears them.
func replaceAdminGroupMemberships(ctx context.Context, store *Store, adminID uuid.UUID, rawIDs []string) error {
	ids, err := validateAdminGroupIDs(ctx, store, rawIDs)
	if err != nil {
		return err
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM admin_group_members WHERE admin_id = $1`, adminID); err != nil {
		return err
	}
	for _, groupID := range ids {
		if _, err := tx.Exec(ctx, `INSERT INTO admin_group_members (group_id, admin_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, groupID, adminID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func UpdateAdminGroup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin group ID")
			return
		}
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		name := strings.TrimSpace(req.Name)
		if name == "" || len(name) > 80 {
			writeError(w, http.StatusBadRequest, "Group name must be between 1 and 80 characters")
			return
		}
		if len(req.Description) > 300 {
			writeError(w, http.StatusBadRequest, "Group description must be at most 300 characters")
			return
		}
		ctx := context.Background()
		available, err := groupNameAvailable(ctx, store, name, id.String())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to check group name")
			return
		}
		if !available {
			writeError(w, http.StatusConflict, "An admin group with that name already exists")
			return
		}
		res, err := store.pool.Exec(ctx, `
			UPDATE admin_groups SET name = $1, description = $2, updated_at = now() WHERE id = $3
		`, name, strings.TrimSpace(req.Description), id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update admin group")
			return
		}
		if res.RowsAffected() == 0 {
			writeError(w, http.StatusNotFound, "Admin group not found")
			return
		}
		logAudit(ctx, store, getAdminID(r), "admin_group.update", "admin_group", id.String(), map[string]string{"name": name})
		g, err := loadAdminGroup(ctx, store, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Group updated but could not be read")
			return
		}
		writeJSON(w, http.StatusOK, g)
	}
}

func DeleteAdminGroup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin group ID")
			return
		}
		ctx := context.Background()
		res, err := store.pool.Exec(ctx, `DELETE FROM admin_groups WHERE id = $1`, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete admin group")
			return
		}
		if res.RowsAffected() == 0 {
			writeError(w, http.StatusNotFound, "Admin group not found")
			return
		}
		logAudit(ctx, store, getAdminID(r), "admin_group.delete", "admin_group", id.String(), nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	}
}

func GetAdminGroup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin group ID")
			return
		}
		ctx := context.Background()
		g, err := loadAdminGroup(ctx, store, id)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Admin group not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load admin group")
			return
		}
		rows, err := store.pool.Query(ctx, `
			SELECT a.id, a.email, a.role, COALESCE(r.name, a.role), a.status
			FROM admin_group_members m
			JOIN admins a ON a.id = m.admin_id
			LEFT JOIN admin_roles r ON r.slug = a.role
			WHERE m.group_id = $1
			ORDER BY lower(a.email)
		`, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load group members")
			return
		}
		defer rows.Close()
		members := []adminGroupMember{}
		for rows.Next() {
			var m adminGroupMember
			var aid uuid.UUID
			if err := rows.Scan(&aid, &m.Email, &m.Role, &m.RoleName, &m.Status); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to read group members")
				return
			}
			m.ID = aid.String()
			members = append(members, m)
		}
		if err := rows.Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to read group members")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"group": g, "members": members})
	}
}

func SetAdminGroupMembers(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin group ID")
			return
		}
		var req struct {
			AdminIDs []string `json:"admin_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		ids := make([]uuid.UUID, 0, len(req.AdminIDs))
		for _, raw := range req.AdminIDs {
			aid, err := parseUUID(raw)
			if err != nil {
				writeError(w, http.StatusBadRequest, "Invalid admin ID in group membership")
				return
			}
			ids = append(ids, aid)
		}
		ctx := context.Background()
		if _, err := loadAdminGroup(ctx, store, id); errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Admin group not found")
			return
		} else if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load admin group")
			return
		}
		if len(ids) > 0 {
			var count int
			if err := store.pool.QueryRow(ctx, `SELECT count(*) FROM admins WHERE id = ANY($1)`, ids).Scan(&count); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to verify admins")
				return
			}
			if count != len(ids) {
				writeError(w, http.StatusBadRequest, "One or more admins do not exist")
				return
			}
		}
		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update group members")
			return
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `DELETE FROM admin_group_members WHERE group_id = $1`, id); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update group members")
			return
		}
		for _, aid := range ids {
			if _, err := tx.Exec(ctx, `INSERT INTO admin_group_members (group_id, admin_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, aid); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to update group members")
				return
			}
		}
		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update group members")
			return
		}
		logAudit(ctx, store, getAdminID(r), "admin_group.members", "admin_group", id.String(), map[string]interface{}{"count": len(ids)})
		g, err := loadAdminGroup(ctx, store, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Group updated but could not be read")
			return
		}
		writeJSON(w, http.StatusOK, g)
	}
}

func AssignAdminGroupRole(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin group ID")
			return
		}
		var req struct {
			Role string `json:"role"`
			Code string `json:"code"`
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
		exists, err := roleExists(ctx, store, req.Role)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to check role")
			return
		}
		if !exists {
			writeError(w, http.StatusBadRequest, "Unknown role")
			return
		}
		g, err := loadAdminGroup(ctx, store, id)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Admin group not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load admin group")
			return
		}

		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to assign role")
			return
		}
		defer tx.Rollback(ctx)
		rows, err := tx.Query(ctx, `
			SELECT a.id, a.role, a.status
			FROM admin_group_members m
			JOIN admins a ON a.id = m.admin_id
			WHERE m.group_id = $1
			FOR UPDATE
		`, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load group admins")
			return
		}
		type row struct {
			id     uuid.UUID
			role   string
			status string
		}
		var members []row
		for rows.Next() {
			var m row
			if err := rows.Scan(&m.id, &m.role, &m.status); err != nil {
				rows.Close()
				writeError(w, http.StatusInternalServerError, "Failed to read group admins")
				return
			}
			members = append(members, m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to read group admins")
			return
		}
		if len(members) == 0 {
			writeError(w, http.StatusBadRequest, "This group has no admins")
			return
		}

		ids := make([]uuid.UUID, 0, len(members))
		for _, m := range members {
			ids = append(ids, m.id)
		}

		// If the group contains the last active super_admin, a bulk demotion
		// would lock everyone out of access control.
		if req.Role != "super_admin" {
			var inGroupSuper int
			for _, m := range members {
				if m.role == "super_admin" && m.status == "active" {
					inGroupSuper++
				}
			}
			if inGroupSuper > 0 {
				var outside int
				if err := tx.QueryRow(ctx, `
					SELECT count(*) FROM admins
					WHERE role = 'super_admin' AND status = 'active' AND id <> ALL($1)
				`, ids).Scan(&outside); err != nil {
					writeError(w, http.StatusInternalServerError, "Failed to check super_admin count")
					return
				}
				if outside == 0 {
					writeError(w, http.StatusBadRequest, "Cannot demote the last active super_admin")
					return
				}
			}
		}

		if _, err := tx.Exec(ctx, `
			UPDATE admins SET role = $1, updated_at = now()
			WHERE id = ANY($2)
		`, req.Role, ids); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to assign role")
			return
		}
		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to assign role")
			return
		}

		for _, m := range members {
			if m.id == actorID {
				continue
			}
			if err := revokeAdminSessions(ctx, store, m.id); err != nil {
				log.Printf("Failed to revoke sessions after group role assignment: admin_id=%s, err=%v", m.id, err)
			}
		}
		logAudit(ctx, store, actorID, "admin_group.assign_role", "admin_group", id.String(), map[string]interface{}{
			"group": g.Name, "role": req.Role, "count": len(members),
		})
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": "updated", "updated": len(members)})
	}
}
