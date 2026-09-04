package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/wireguard-console/backend/internal/auth"
)

// GetMe returns the signed-in admin's own profile.
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

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"id":           adminID.String(),
			"email":        email,
			"role":         role,
			"totp_enabled": totpEnabled,
			"status":       status,
			"created_at":   createdAt.UTC().Format(time.RFC3339),
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

		logAudit(ctx, store, adminID, "admin.2fa_disable", "admin", adminID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "disabled"})
	}
}