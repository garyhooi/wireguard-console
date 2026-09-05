package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/db"
	"github.com/wireguard-console/backend/internal/email"
)

func ListUsers(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		users := []db.User{}
		rows, err := store.pool.Query(ctx, `
			SELECT id, email, full_name, status, invited_by, invited_at, activated_at, created_at, updated_at
			FROM users
			ORDER BY created_at DESC
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to query users")
			return
		}
		defer rows.Close()

		for rows.Next() {
			var u db.User
			if err := rows.Scan(&u.ID, &u.Email, &u.FullName, &u.Status,
				&u.InvitedBy, &u.InvitedAt, &u.ActivatedAt, &u.CreatedAt, &u.UpdatedAt); err != nil {
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
			SELECT id, email, full_name, status, invited_by, invited_at, activated_at, created_at, updated_at
			FROM users
			WHERE id = $1
		`, userID).Scan(
			&u.ID, &u.Email, &u.FullName, &u.Status, &u.InvitedBy,
			&u.InvitedAt, &u.ActivatedAt, &u.CreatedAt, &u.UpdatedAt,
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
			Email    string `json:"email"`
			FullName string `json:"full_name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

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
				UPDATE users SET full_name = $2, status = 'invited', updated_at = now()
				WHERE id = $1
			`, existingID, req.FullName); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to revive user")
				return
			}
		case err == nil:
			writeError(w, http.StatusConflict, "A user with this email already exists")
			return
		case err == pgx.ErrNoRows:
			if _, err := store.pool.Exec(ctx, `
				INSERT INTO users (email, full_name, status, invited_by, invited_at)
				VALUES ($1, $2, 'invited', $3, $4)
			`, req.Email, req.FullName, invitedBy, invitedAt); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to create user")
				return
			}
		default:
			writeError(w, http.StatusInternalServerError, "Failed to create user")
			return
		}

		// Generate invite token + queue the claim email (fresh 72h link).
		inviteLink, err := issueUserInvite(ctx, store.pool, req.Email, req.FullName)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create invite")
			return
		}

		logAudit(ctx, store, adminID, "user.create", "user", "", nil)

		// Always return the invite link: without configured SMTP the email
		// is never delivered, and even with SMTP the admin may want to
		// share it directly (or if the mail worker is still catching up).
		writeJSON(w, http.StatusCreated, map[string]string{
			"status":      "created",
			"invite_link": inviteLink,
		})
	}
}

// issueUserInvite mints a fresh claim invite for the user and queues the
// invite email (best-effort — SMTP may not be configured yet; the mail
// worker keeps the job until it is). Returns the public claim link so the
// admin can share it manually when delivery fails.
func issueUserInvite(ctx context.Context, pool *pgxpool.Pool, to, fullName string) (string, error) {
	token, err := generateToken()
	if err != nil {
		return "", err
	}
	tokenHash := hashToken(token)
	expiresAt := time.Now().Add(72 * time.Hour)

	_, err = pool.Exec(ctx, `
		INSERT INTO invites (user_id, token_hash, expires_at)
		VALUES ((SELECT id FROM users WHERE email = $1), $2, $3)
	`, to, tokenHash, expiresAt)
	if err != nil {
		return "", err
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

	return inviteLink, nil
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

		inviteLink, err := issueUserInvite(ctx, store.pool, to, fullName)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create invite")
			return
		}

		logAudit(ctx, store, adminID, "user.invite.resend", "user", userID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{
			"status":      "resent",
			"invite_link": inviteLink,
		})
	}
}

func UpdateUser(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid user ID")
			return
		}

		var req struct {
			FullName string `json:"full_name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		_, err = store.pool.Exec(ctx, `
			UPDATE users SET full_name = $1, updated_at = now() WHERE id = $2
		`, req.FullName, userID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update user")
			return
		}

		logAudit(ctx, store, adminID, "user.update", "user", userID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
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

		writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
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
