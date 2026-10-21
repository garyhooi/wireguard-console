package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/mail"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/db"
	"github.com/wireguard-console/backend/internal/email"
)

func ListUsers(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		// Removed users are soft-deleted rows (history/audit keep their id) and
		// must not leak into pickers such as Domain/IP rule user scope or the
		// Web Activity filter. The VPN Users page asks for them explicitly so
		// its "Removed" tab keeps working.
		includeRemoved := r.URL.Query().Get("include_removed") == "1"
		query := `
			SELECT u.id, u.email, u.full_name, u.status, u.invited_by, u.invited_at,
			       u.activated_at, u.created_at, u.updated_at,
			       u.department_id, COALESCE(d.name, '')
			FROM users u
			LEFT JOIN departments d ON d.id = u.department_id
		`
		if !includeRemoved {
			query += ` WHERE u.status <> 'removed'`
		}
		query += ` ORDER BY u.created_at DESC`

		users := []db.User{}
		rows, err := store.pool.Query(ctx, query)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query users")
			return
		}
		defer rows.Close()

		for rows.Next() {
			var u db.User
			if err := rows.Scan(&u.ID, &u.Email, &u.FullName, &u.Status,
				&u.InvitedBy, &u.InvitedAt, &u.ActivatedAt, &u.CreatedAt, &u.UpdatedAt,
				&u.DepartmentID, &u.DepartmentName); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to scan user")
				return
			}
			users = append(users, u)
		}

		writeJSON(w, http.StatusOK, users)
	}
}

func GetUser(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid user ID")
			return
		}

		ctx := context.Background()

		var u db.User
		err = store.pool.QueryRow(ctx, `
			SELECT u.id, u.email, u.full_name, u.status, u.invited_by, u.invited_at,
			       u.activated_at, u.created_at, u.updated_at,
			       u.department_id, COALESCE(d.name, '')
			FROM users u
			LEFT JOIN departments d ON d.id = u.department_id
			WHERE u.id = $1
		`, userID).Scan(
			&u.ID, &u.Email, &u.FullName, &u.Status, &u.InvitedBy,
			&u.InvitedAt, &u.ActivatedAt, &u.CreatedAt, &u.UpdatedAt,
			&u.DepartmentID, &u.DepartmentName,
		)

		if err != nil {
			writeError(w, http.StatusNotFound, "User not found")
			return
		}

		writeJSON(w, http.StatusOK, u)
	}
}

func CreateUser(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Email        string     `json:"email"`
			FullName     string     `json:"full_name"`
			DepartmentID *uuid.UUID `json:"department_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

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

		invitedBy := adminID
		now := time.Now()
		invitedAt := now

		// Emails are reusable after removal: a removed row with this email is
		// revived in place (no duplicate rows, no ambiguous lookups).
		var (
			existingID string
			curStatus  string
		)
		err := store.pool.QueryRow(ctx,
			`SELECT id::text, status FROM users WHERE email = $1`, req.Email).Scan(&existingID, &curStatus)
		switch {
		case err == nil && curStatus == "removed":
			// Revive the old row.
			if _, err := store.pool.Exec(ctx, `
				UPDATE users SET full_name = $2, department_id = $3, status = 'invited', updated_at = now()
				WHERE id = $1
			`, existingID, req.FullName, req.DepartmentID); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to revive user")
				return
			}
		case err == nil:
			writeError(w, http.StatusConflict, "A user with this email already exists")
			return
		case err == pgx.ErrNoRows:
			if _, err := store.pool.Exec(ctx, `
				INSERT INTO users (email, full_name, status, invited_by, invited_at, department_id)
				VALUES ($1, $2, 'invited', $3, $4, $5)
			`, req.Email, req.FullName, invitedBy, invitedAt, req.DepartmentID); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to create user")
				return
			}
		default:
			writeError(w, http.StatusInternalServerError, "Failed to create user")
			return
		}

		// Generate invite token + queue the claim email (fresh link; lifetime
		// configured in Configuration → Security, default 72h).
		inviteLink, inviteHours, err := issueUserInvite(ctx, store.pool, req.Email, req.FullName)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create invite")
			return
		}

		logAudit(ctx, store, adminID, "user.create", "user", "", nil)

		// Always return the invite link: without configured SMTP the email
		// is never delivered, and even with SMTP the admin may want to
		// share it directly (or if the mail worker is still catching up).
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"status":           "created",
			"invite_link":      inviteLink,
			"expires_in_hours": inviteHours,
		})
	}
}

// issueUserInvite mints a fresh claim invite for the user and queues the
// invite email (best-effort — SMTP may not be configured yet; the mail
// worker keeps the job until it is). Returns the public claim link and its
// lifetime in hours so the admin can share it manually when delivery fails.
// The lifetime is configured in Configuration → Security (default 72h).
func issueUserInvite(ctx context.Context, pool *pgxpool.Pool, to, fullName string) (string, int, error) {
	policy := loadInvitePolicy(ctx, pool)
	token, err := generateToken()
	if err != nil {
		return "", 0, err
	}
	tokenHash := hashToken(token)
	expiresAt := time.Now().Add(policy.VPNInvite)

	_, err = pool.Exec(ctx, `
		INSERT INTO invites (user_id, token_hash, expires_at)
		VALUES ((SELECT id FROM users WHERE email = $1), $2, $3)
	`, to, tokenHash, expiresAt)
	if err != nil {
		return "", 0, err
	}

	// Enqueue email job. CONSOLE_DOMAIN may be a domain or a public IP;
	// tolerate a scheme already being present, and always emit https.
	domain := strings.TrimPrefix(strings.TrimPrefix(os.Getenv("CONSOLE_DOMAIN"), "https://"), "http://")
	inviteLink := "https://" + domain + "/claim/" + token
	subject, body := loadEmailTemplate(ctx, pool, "user_invite",
		"You've been invited to join WireGuard Console", "Hello {{full_name}}, click {{invite_link}} to claim your account.")
	subject = renderTemplate(subject, map[string]string{"full_name": fullName})
	body = renderTemplate(body, map[string]string{"full_name": fullName, "invite_link": inviteLink})
	queue := email.NewQueue(pool, nil)
	if err := queue.EnqueueRenderedEmail(ctx, to, subject, body); err != nil {
		log.Printf("Failed to enqueue invite email: %v", err)
	}

	return inviteLink, int(policy.VPNInvite.Hours()), nil
}

// ResendUserInvite re-issues the claim email for a user who has not claimed
// yet (status 'invited'). An SMTP failure on the original send, a lost
// email, or an expired invite link can all be fixed by resending — a fresh
// 72h link is minted each time and the old ones stay valid until they
// expire. Users who already claimed (active/suspended) get a conflict: they
// no longer need a claim link.
func ResendUserInvite(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid user ID")
			return
		}
		ctx := context.Background()
		adminID := getAdminID(r)

		var to, fullName string
		if err := store.pool.QueryRow(ctx, `
			SELECT email, COALESCE(full_name, '') FROM users
			WHERE id = $1 AND status = 'invited'
		`, userID).Scan(&to, &fullName); err != nil {
			writeError(w, http.StatusConflict, "Only users with a pending invitation can be re-invited")
			return
		}

		inviteLink, inviteHours, err := issueUserInvite(ctx, store.pool, to, fullName)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create invite")
			return
		}

		logAudit(ctx, store, adminID, "user.invite.resend", "user", userID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":           "resent",
			"invite_link":      inviteLink,
			"expires_in_hours": inviteHours,
		})
	}
}

// DeleteUser revokes any pending invite and marks the user and their
// peers removed (soft delete).
func DeleteUser(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid user ID")
			return
		}
		ctx := context.Background()
		adminID := getAdminID(r)

		if _, err := store.pool.Exec(ctx, `DELETE FROM invites WHERE user_id = $1`, userID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to revoke invitation")
			return
		}
		if _, err := store.pool.Exec(ctx, `UPDATE users SET status = 'removed', updated_at = now() WHERE id = $1`, userID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to remove user")
			return
		}
		if _, err := store.pool.Exec(ctx, `UPDATE peers SET status = 'removed', removed_at = now() WHERE user_id = $1 AND status != 'removed'`, userID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to remove user peers")
			return
		}

		logAudit(ctx, store, adminID, "user.delete", "user", userID.String(), nil)

		resyncServersOfUser(ctx, store, userID)
		RequestDomainRuleSync(store)

		writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
	}
}

// UpdateUser edits a VPN user's display name and/or department. Department is
// sent as a raw JSON field so an explicit null clears it (JSON null and an
// absent field are different intents for a nullable column).
func UpdateUser(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid user ID")
			return
		}
		var req struct {
			FullName     *string         `json:"full_name"`
			Email        *string         `json:"email"`
			DepartmentID json.RawMessage `json:"department_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if req.FullName == nil && req.Email == nil && len(req.DepartmentID) == 0 {
			writeError(w, http.StatusBadRequest, "Nothing to update")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		var exists bool
		if err := store.pool.QueryRow(ctx, `SELECT true FROM users WHERE id = $1`, userID).Scan(&exists); err != nil {
			writeError(w, http.StatusNotFound, "User not found")
			return
		}

		// Email is the user's identity for invites/emails: validate it, store it
		// lowercased, and reject collisions (removed users keep their row, so
		// their address stays reserved — re-inviting it revives that row instead).
		if req.Email != nil {
			email := strings.ToLower(strings.TrimSpace(*req.Email))
			if email == "" {
				writeError(w, http.StatusBadRequest, "Email is required")
				return
			}
			if addr, err := mail.ParseAddress(email); err != nil || addr.Address != email {
				writeError(w, http.StatusBadRequest, "Invalid email address")
				return
			}
			var taken bool
			err := store.pool.QueryRow(ctx,
				`SELECT true FROM users WHERE lower(email) = $1 AND id <> $2`, email, userID).Scan(&taken)
			if err == nil {
				writeError(w, http.StatusConflict, "Another user already uses this email")
				return
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusInternalServerError, "Failed to check email")
				return
			}
			if _, err := store.pool.Exec(ctx, `
				UPDATE users SET email = $1, updated_at = now() WHERE id = $2
			`, email, userID); err != nil {
				var pgErr *pgconn.PgError
				if errors.As(err, &pgErr) && pgErr.Code == "23505" {
					writeError(w, http.StatusConflict, "Another user already uses this email")
					return
				}
				writeError(w, http.StatusInternalServerError, "Failed to update email")
				return
			}
		}

		if req.FullName != nil {
			name := strings.TrimSpace(*req.FullName)
			if _, err := store.pool.Exec(ctx, `
				UPDATE users SET full_name = $1, updated_at = now() WHERE id = $2
			`, name, userID); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to update user")
				return
			}
		}

		if len(req.DepartmentID) > 0 {
			var deptID *uuid.UUID
			if string(req.DepartmentID) != "null" {
				var id uuid.UUID
				if err := json.Unmarshal(req.DepartmentID, &id); err != nil {
					writeError(w, http.StatusBadRequest, "Invalid department ID")
					return
				}
				ok, err := departmentExists(ctx, store, id)
				if err != nil {
					writeError(w, http.StatusInternalServerError, "Failed to check department")
					return
				}
				if !ok {
					writeError(w, http.StatusBadRequest, "Department not found")
					return
				}
				deptID = &id
			}
			if _, err := store.pool.Exec(ctx, `
				UPDATE users SET department_id = $1, updated_at = now() WHERE id = $2
			`, deptID, userID); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to update user department")
				return
			}
		}

		logAudit(ctx, store, adminID, "user.update", "user", userID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}

func SuspendUser(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid user ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to begin transaction")
			return
		}
		defer tx.Rollback(ctx)

		now := time.Now()
		_, err = tx.Exec(ctx, `
			UPDATE users SET status = 'suspended', updated_at = now() WHERE id = $1
		`, userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to suspend user")
			return
		}

		_, err = tx.Exec(ctx, `
			UPDATE peers SET status = 'suspended', suspended_at = $1 
			WHERE user_id = $2 AND status = 'active'
		`, now, userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to suspend user peers")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to commit transaction")
			return
		}

		logAudit(ctx, store, adminID, "user.suspend", "user", userID.String(), nil)

		// Drop the user's peers from the kernel interfaces immediately.
		resyncServersOfUser(ctx, store, userID)
		RequestDomainRuleSync(store)

		writeJSON(w, http.StatusOK, map[string]string{"status": "suspended"})
	}
}

func ResumeUser(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid user ID")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to begin transaction")
			return
		}
		defer tx.Rollback(ctx)

		_, err = tx.Exec(ctx, `
			UPDATE users SET status = 'active', updated_at = now() WHERE id = $1
		`, userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to resume user")
			return
		}

		_, err = tx.Exec(ctx, `
			UPDATE peers SET status = 'active', suspended_at = NULL 
			WHERE user_id = $1 AND status = 'suspended'
		`, userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to resume user peers")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to commit transaction")
			return
		}

		logAudit(ctx, store, adminID, "user.resume", "user", userID.String(), nil)

		// Re-add the user's peers to the kernel interfaces.
		resyncServersOfUser(ctx, store, userID)
		RequestDomainRuleSync(store)

		writeJSON(w, http.StatusOK, map[string]string{"status": "resumed"})
	}
}

// resyncServersOfUser pushes every server the user has peers on to
// wg-helper, so peer status changes (suspend/resume/remove) take effect
// on the kernel interfaces immediately.
func resyncServersOfUser(ctx context.Context, store *Store, userID uuid.UUID) {
	rows, err := store.pool.Query(ctx, `
		SELECT DISTINCT server_id FROM peers WHERE user_id = $1
	`, userID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var serverID uuid.UUID
		if err := rows.Scan(&serverID); err == nil {
			syncServerLogged(ctx, store.pool, serverID)
		}
	}
}
