package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/wireguard-console/backend/internal/auth"
)

// GetMe returns the signed-in admin's own profile plus the session's CSRF
// token (used by the SPA to stamp state-changing requests — the session
// cookie itself is HttpOnly and invisible to JS).
func GetMe(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		var (
			email       string
			role        string
			totpEnabled bool
			status      string
			createdAt   time.Time
		)
		err := store.pool.QueryRow(ctx, `
			SELECT email, role, totp_enabled, status, created_at
			FROM admins WHERE id = $1
		`, adminID).Scan(&email, &role, &totpEnabled, &status, &createdAt)
		if err != nil {
			writeError(w, http.StatusNotFound, "Admin not found")
			return
		}

		csrfToken, _ := r.Context().Value(csrfTokenKey{}).(string)

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"id":           adminID.String(),
			"email":        email,
			"role":         role,
			"totp_enabled": totpEnabled,
			"status":       status,
			"created_at":   createdAt.UTC().Format(time.RFC3339),
			"csrf_token":   csrfToken,
		})
	}
}

// ChangePassword lets an admin rotate their own password.
func ChangePassword(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			CurrentPassword string `json:"current_password"`
			NewPassword     string `json:"new_password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		adminID := getAdminID(r)
		ctx := context.Background()

		var currentHash string
		if err := store.pool.QueryRow(ctx,
			`SELECT password_hash FROM admins WHERE id = $1`, adminID).Scan(&currentHash); err != nil {
			writeError(w, http.StatusNotFound, "Admin not found")
			return
		}
		if !verifyPassword(req.CurrentPassword, currentHash) {
			writeError(w, http.StatusUnauthorized, "Current password is incorrect")
			return
		}
		if err := auth.ValidatePassword(req.NewPassword); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		if _, err := store.pool.Exec(ctx, `
			UPDATE admins SET password_hash = $1, updated_at = now() WHERE id = $2
		`, hashPassword(req.NewPassword), adminID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update password")
			return
		}

		// Credentials changed: kill every other session so a stolen token
		// stops working; the acting session survives (the password was just
		// proven).
		if err := revokeAdminSessionsExcept(ctx, store, adminID, currentSessionTokenHash(r)); err != nil {
			log.Printf("Failed to revoke other sessions after password change: admin_id=%s, err=%v", adminID, err)
		}

		logAudit(ctx, store, adminID, "admin.password_change", "admin", adminID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}

// Disable2FA removes the admin's TOTP enrollment after verifying a code.
func Disable2FA(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
			writeError(w, http.StatusBadRequest, "Code is required")
			return
		}

		adminID := getAdminID(r)
		ctx := context.Background()

		var secretEnc string
		if err := store.pool.QueryRow(ctx,
			`SELECT totp_secret_encrypted FROM admins WHERE id = $1`, adminID).Scan(&secretEnc); err != nil || secretEnc == "" {
			writeError(w, http.StatusBadRequest, "2FA is not enabled")
			return
		}
		secret, err := auth.DecryptTOTPSecret(ctx, secretEnc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to read 2FA secret")
			return
		}
		if !auth.VerifyTOTP(secret, req.Code) {
			writeError(w, http.StatusUnauthorized, "Invalid 2FA code")
			return
		}

		if _, err := store.pool.Exec(ctx, `
			UPDATE admins SET totp_enabled = false, totp_secret_encrypted = NULL, updated_at = now()
			WHERE id = $1
		`, adminID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to disable 2FA")
			return
		}

		// 2FA removal is a credential downgrade: kill every other session so
		// sessions minted under the stronger policy don't outlive it. The
		// acting session survives.
		if err := revokeAdminSessionsExcept(ctx, store, adminID, currentSessionTokenHash(r)); err != nil {
			log.Printf("Failed to revoke other sessions after 2FA disable: admin_id=%s, err=%v", adminID, err)
		}

		logAudit(ctx, store, adminID, "admin.2fa_disable", "admin", adminID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "disabled"})
	}
}

// ListMySessions returns the signed-in admin's live sessions (Profile →
// Active Sessions), each flagged is_current / is_pending_2fa.
func ListMySessions(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		sessions, err := listAdminSessions(ctx, store, adminID, currentSessionTokenHash(r))
		if err != nil {
			log.Printf("Failed to list sessions: admin_id=%s, err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to list sessions")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"sessions": sessions})
	}
}

// RevokeMySession terminates one of the signed-in admin's own sessions.
// The acting session may not revoke itself through this endpoint (that is
// what logout is for); trying to revoke the current session returns 400.
// Revoking a pending-2FA login attempt is allowed — it aborts that sign-in.
func RevokeMySession(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sessionID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid session ID")
			return
		}

		adminID := getAdminID(r)
		ctx := context.Background()

		if sessionID == getSessionRowID(r) {
			writeError(w, http.StatusBadRequest, "Cannot revoke the current session — use Sign out instead")
			return
		}

		removed, err := revokeAdminSession(ctx, store, adminID, sessionID)
		if err != nil {
			log.Printf("Failed to revoke session: admin_id=%s session=%s err=%v", adminID, sessionID, err)
			writeError(w, http.StatusInternalServerError, "Failed to revoke session")
			return
		}
		if !removed {
			writeError(w, http.StatusNotFound, "Session not found")
			return
		}

		logAudit(ctx, store, adminID, "session.revoke", "session", sessionID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
	}
}

// RevokeMyOtherSessions signs out every one of the admin's sessions except
// the current one ("Sign out elsewhere"). Returns the count revoked.
func RevokeMyOtherSessions(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()
		currentHash := currentSessionTokenHash(r)

		var before int
		store.pool.QueryRow(ctx, `
			SELECT count(*) FROM admin_sessions WHERE admin_id = $1 AND expires_at > now() AND token_hash <> $2
		`, adminID, currentHash).Scan(&before)

		if err := revokeAdminSessionsExcept(ctx, store, adminID, currentHash); err != nil {
			log.Printf("Failed to revoke other sessions: admin_id=%s, err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to revoke other sessions")
			return
		}

		logAudit(ctx, store, adminID, "session.revoke_others", "admin", adminID.String(), map[string]int{"revoked": before})
		writeJSON(w, http.StatusOK, map[string]int{"revoked": before})
	}
}
