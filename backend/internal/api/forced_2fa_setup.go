package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/wireguard-console/backend/internal/auth"
)

// Forced 2FA enrollment. Password login for an admin without TOTP never mints
// a session: Login() issues only the short-lived pending cookie (the same one
// Verify2FA consumes). These endpoints let that pending login finish
// enrollment, and only a valid authenticator code swaps it for a real session.
//
// The pending cookie is not accepted by AuthMiddleware, so no protected API
// works while enrollment is outstanding.

var errNoPendingSetup = errors.New("missing pending 2FA setup token")

// resolvePendingSetupAdmin maps the pending cookie back to its admin. The row
// lives in admin_sessions with a 10-minute expiry (see Login).
func resolvePendingSetupAdmin(ctx context.Context, store *Store, r *http.Request) (uuid.UUID, string, error) {
	token := readCookieToken(r, pending2FACookieName)
	if token == "" {
		return uuid.Nil, "", errNoPendingSetup
	}
	hash := hashToken(token)
	var adminID uuid.UUID
	err := store.pool.QueryRow(ctx, "SELECT a.id FROM admins a JOIN admin_sessions s ON s.admin_id = a.id WHERE s.token_hash = $1 AND s.expires_at > now()", hash).Scan(&adminID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, hash, errNoPendingSetup
		}
		return uuid.Nil, hash, err
	}
	return adminID, hash, nil
}

// Setup2FAPending generates a TOTP secret for the forced-enrollment flow.
func Setup2FAPending(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		adminID, _, err := resolvePendingSetupAdmin(ctx, store, r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "Missing or expired 2FA setup session - sign in again")
			return
		}

		var enabled bool
		if err := store.pool.QueryRow(ctx, "SELECT totp_enabled FROM admins WHERE id = $1", adminID).Scan(&enabled); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to check 2FA state")
			return
		}
		if enabled {
			writeError(w, http.StatusBadRequest, "2FA is already enabled")
			return
		}

		totp, err := auth.GenerateTOTP()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate TOTP")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"secret":      totp.Secret(),
			"otpauth_url": totp.URL(),
		})
	}
}

// Enable2FAPending verifies the first code, stores the secret + backup codes,
// consumes the pending token, and mints the real session.
func Enable2FAPending(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Secret string `json:"secret"`
			Code   string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID, pendingHash, err := resolvePendingSetupAdmin(ctx, store, r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "Missing or expired 2FA setup session - sign in again")
			return
		}

		var enabled bool
		if err := store.pool.QueryRow(ctx, "SELECT totp_enabled FROM admins WHERE id = $1", adminID).Scan(&enabled); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to check 2FA state")
			return
		}
		if enabled {
			writeError(w, http.StatusBadRequest, "2FA is already enabled")
			return
		}

		if !auth.VerifyTOTP(req.Secret, req.Code) {
			writeError(w, http.StatusBadRequest, "Invalid verification code")
			return
		}

		encryptedSecret, err := auth.EncryptTOTPSecret(ctx, req.Secret)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to encrypt secret")
			return
		}

		backupCodes, err := auth.GenerateBackupCodes(10)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate backup codes")
			return
		}
		codesHash := make([]string, len(backupCodes))
		for i, code := range backupCodes {
			h := sha256.Sum256([]byte(code))
			codesHash[i] = hex.EncodeToString(h[:])
		}

		if _, err := store.pool.Exec(ctx, "UPDATE admins SET totp_secret_encrypted = $1, totp_enabled = true, backup_codes_hash = $2, updated_at = now() WHERE id = $3", encryptedSecret, codesHash, adminID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to enable 2FA")
			return
		}

		// Consume the pending token, then mint the full session.
		store.pool.Exec(ctx, "DELETE FROM admin_sessions WHERE token_hash = $1", pendingHash)

		token, err := generateToken()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate session token")
			return
		}
		csrfToken, err := createSession(ctx, store, adminID, token, r, sessionLifetime, true)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create session")
			return
		}
		setSessionCookie(w, r, sessionCookieName, token, int(sessionLifetime.Seconds()))
		clearSessionCookie(w, r, pending2FACookieName)

		logAudit(ctx, store, adminID, "2fa.enable", "admin", adminID.String(), map[string]interface{}{
			"forced": true,
		})

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"csrf_token":   csrfToken,
			"backup_codes": backupCodes,
			"message":      "2FA enabled. Save these backup codes - they can only be shown once.",
		})
	}
}
