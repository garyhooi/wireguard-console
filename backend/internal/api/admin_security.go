package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/wireguard-console/backend/internal/auth"
)

// verifyActor2FA confirms the signed-in admin's own second factor before a
// sensitive action (resetting another admin's 2FA/password, changing an
// admin's email/role, downloading or restoring a backup, editing/deleting
// servers and nodes, re-issuing node join commands).
//
// The acting admin must have 2FA enrolled: these operations are exactly the
// ones that should be impossible to perform from a stolen session cookie
// alone. A TOTP code is accepted; a stored backup code is accepted once and
// then consumed. On failure it writes the error response and returns false.
//
// Step-up grace (Configuration → Security): when the console has a positive
// step_up_minutes window and THIS session already passed a code inside that
// window, an empty code is accepted without re-prompting — the verified
// timestamp is stamped on the admin_sessions row on every successful code,
// so the grace never leaks across sessions or logins. Window 0 (default)
// disables the grace: every action asks for a code.
func verifyActor2FA(w http.ResponseWriter, r *http.Request, ctx context.Context, store *Store, actorID uuid.UUID, code string) bool {
	sessionHash := currentSessionTokenHash(r)

	// Already verified this session inside the grace window → allow without
	// a code (the admin just proved possession of the authenticator).
	if code == "" && sessionHash != "" {
		minutes := loadStepUpMinutes(ctx, store.pool)
		if minutes > 0 {
			var verifiedAt *time.Time
			_ = store.pool.QueryRow(ctx, `
				SELECT step_up_verified_at FROM admin_sessions
				WHERE token_hash = $1 AND expires_at > now()
			`, sessionHash).Scan(&verifiedAt)
			if verifiedAt != nil && time.Since(*verifiedAt) <= time.Duration(minutes)*time.Minute {
				return true
			}
		}
		writeError(w, http.StatusBadRequest, "A 2FA code is required for this action")
		return false
	}

	var secretEnc string
	var enabled bool
	err := store.pool.QueryRow(ctx,
		`SELECT totp_secret_encrypted, totp_enabled FROM admins WHERE id = $1`, actorID).
		Scan(&secretEnc, &enabled)
	if err != nil || !enabled || secretEnc == "" {
		writeError(w, http.StatusForbidden, "Your account must have 2FA enabled to perform this action")
		return false
	}

	secret, err := auth.DecryptTOTPSecret(ctx, secretEnc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to read 2FA secret")
		return false
	}

	// Accept a normal authenticator code first.
	if auth.VerifyTOTP(secret, code) {
		stampStepUp(ctx, store, sessionHash)
		return true
	}

	// Fall back to one-time backup codes (each is consumed on use).
	var codesHash []string
	if err := store.pool.QueryRow(ctx,
		`SELECT backup_codes_hash FROM admins WHERE id = $1`, actorID).Scan(&codesHash); err == nil {
		sum := sha256.Sum256([]byte(code))
		encoded := hex.EncodeToString(sum[:])
		for i, stored := range codesHash {
			if stored == encoded {
				// Consume the used code so it can never be replayed.
				remaining := append(append([]string{}, codesHash[:i]...), codesHash[i+1:]...)
				var next interface{}
				if len(remaining) > 0 {
					next = remaining
				}
				_, _ = store.pool.Exec(ctx,
					`UPDATE admins SET backup_codes_hash = $1 WHERE id = $2`,
					next, actorID)
				stampStepUp(ctx, store, sessionHash)
				return true
			}
		}
	}

	writeError(w, http.StatusUnauthorized, "Invalid 2FA code")
	return false
}

// stampStepUp records that the acting session just passed a step-up 2FA
// verification, starting (or extending) its grace window. Best-effort: a
// missing session hash (no cookie) simply means no grace is granted.
func stampStepUp(ctx context.Context, store *Store, sessionHash string) {
	if sessionHash == "" {
		return
	}
	_, _ = store.pool.Exec(ctx, `
		UPDATE admin_sessions SET step_up_verified_at = now()
		WHERE token_hash = $1 AND expires_at > now()
	`, sessionHash)
}

type stepUpRequest struct {
	Code string `json:"code"`
}

// ResetAdmin2FA clears another admin's 2FA enrollment so that admin can
// re-enroll from their Profile. The acting super_admin must confirm with
// their own 2FA code. The target's sessions are left alone; their next
// login proceeds without a 2FA prompt.
func ResetAdmin2FA(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid admin ID")
			return
		}

		var req stepUpRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		actorID := getAdminID(r)

		if !verifyActor2FA(w, r, ctx, store, actorID, req.Code) {
			return
		}

		// Do not allow resetting your own 2FA through this path — use the
		// profile's Disable 2FA flow (which proves current possession of the
		// secret) or enroll again. A super admin resetting their own 2FA via
		// this endpoint would defeat the point of the step-up check.
		if targetID == actorID {
			writeError(w, http.StatusBadRequest, "Reset your own 2FA from Profile instead")
			return
		}

		var exists bool
		if err := store.pool.QueryRow(ctx,
			`SELECT true FROM admins WHERE id = $1`, targetID).Scan(&exists); err != nil {
			writeError(w, http.StatusNotFound, "Admin not found")
			return
		}

		if _, err := store.pool.Exec(ctx, `
			UPDATE admins
			SET totp_enabled = false, totp_secret_encrypted = NULL, backup_codes_hash = NULL,
			    updated_at = now()
			WHERE id = $1
		`, targetID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to reset 2FA")
			return
		}

		logAudit(ctx, store, actorID, "admin.reset_2fa", "admin", targetID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "2fa reset"})
	}
}
