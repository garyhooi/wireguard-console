package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/wireguard-console/backend/internal/auth"
)

// Step-up verification for sensitive actions.
//
// Every privileged handler calls one of these with the actor's supplied code
// (or an empty code when the SPA already completed an explicit passkey
// step-up). The accepted proof is, in order:
//
//  1. authenticator-app TOTP code
//  2. one single-use recovery code (consumed on use)
//  3. a passkey step-up stamp on the acting session (step_up_method='passkey'
//     and step_up_fresh_until > now()), consumed by the gated action
//
// verifyActorMFA also honours the configured "step-up grace" window
// (Configuration → Security): after one successful code the same session is
// trusted for a few minutes without re-prompting. verifyActorMFACode is the
// STRICT variant: no grace window, so security-policy changes always require a
// fresh proof (a passkey ceremony counts as fresh and is still accepted once).

// stepUpRequest is the shared body shape of step-up-gated actions.
type stepUpRequest struct {
	Code string `json:"code"`
}

// verifyActorMFA confirms the acting admin's own MFA factor before a sensitive
// action. When the session carries a fresh passkey step-up stamp the empty code
// is accepted (and the stamp consumed); otherwise the configured grace window
// is honoured, then an explicit code is required.
func verifyActorMFA(w http.ResponseWriter, r *http.Request, ctx context.Context, store *Store, actorID uuid.UUID, code string) bool {
	sessionHash := currentSessionTokenHash(r)

	if strings.TrimSpace(code) == "" {
		if consumePasskeyStepUp(ctx, store, sessionHash) {
			return true
		}
		if sessionHash != "" {
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
		}
		writeMFAError(w, http.StatusBadRequest, "mfa_required", "A verification code is required for this action")
		return false
	}

	return checkActorMFACode(w, r, ctx, store, actorID, code)
}

// verifyActorMFACode is the STRICT variant: it never accepts the step-up grace
// window. A fresh passkey step-up ceremony (one-shot stamp) is still accepted —
// it is stronger than a typed code, not weaker. Security-policy changes use
// this so a policy can never be altered by a merely-recently-verified session.
func verifyActorMFACode(w http.ResponseWriter, r *http.Request, ctx context.Context, store *Store, actorID uuid.UUID, code string) bool {
	if strings.TrimSpace(code) == "" {
		if consumePasskeyStepUp(ctx, store, currentSessionTokenHash(r)) {
			return true
		}
		writeMFAError(w, http.StatusBadRequest, "mfa_required", "A verification code is required for this action")
		return false
	}
	return checkActorMFACode(w, r, ctx, store, actorID, code)
}

// checkActorMFACode validates a supplied authenticator / recovery code, then
// falls back to a pending passkey step-up stamp.
func checkActorMFACode(w http.ResponseWriter, r *http.Request, ctx context.Context, store *Store, actorID uuid.UUID, code string) bool {
	sessionHash := currentSessionTokenHash(r)
	trimmed := strings.TrimSpace(code)

	var (
		secretEnc string
		totpOn    bool
	)
	err := store.pool.QueryRow(ctx, `
		SELECT COALESCE(totp_secret_encrypted, ''), totp_enabled FROM admins WHERE id = $1
	`, actorID).Scan(&secretEnc, &totpOn)
	if err != nil {
		writeMFAError(w, http.StatusForbidden, "mfa_no_factor", "Your account has no MFA factor enrolled")
		return false
	}

	// 1. Authenticator-app code.
	if totpOn && secretEnc != "" && trimmed != "" {
		secret, err := auth.DecryptTOTPSecret(ctx, secretEnc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to read MFA secret")
			return false
		}
		if auth.VerifyTOTP(secret, trimmed) {
			stampStepUp(ctx, store, sessionHash)
			return true
		}
	}

	// 2. Single-use recovery code.
	if trimmed != "" {
		ok, err := consumeRecoveryCode(ctx, store, actorID, trimmed)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to verify MFA code")
			return false
		}
		if ok {
			stampStepUp(ctx, store, sessionHash)
			return true
		}
	}

	// 3. A passkey ceremony the SPA ran just before retrying this action.
	if consumePasskeyStepUp(ctx, store, sessionHash) {
		return true
	}

	writeMFAError(w, http.StatusUnauthorized, "mfa_invalid", "Invalid verification code")
	return false
}

// passkeyStepUpValidity is how long a completed passkey step-up ceremony may be
// redeemed for exactly one gated action.
const passkeyStepUpValidity = 90 * time.Second

// stampPasskeyStepUp records that the acting session just completed a passkey
// step-up ceremony. The stamp is single-use: the next gated action consumes it
// (see consumePasskeyStepUp). Used by the passkey step-up finish endpoint.
func stampPasskeyStepUp(ctx context.Context, store *Store, sessionHash string) error {
	if sessionHash == "" {
		return errors.New("missing session cookie")
	}
	tag, err := store.pool.Exec(ctx, `
		UPDATE admin_sessions
		SET step_up_method = 'passkey',
		    step_up_fresh_until = now() + make_interval(secs => $2)
		WHERE token_hash = $1 AND expires_at > now()
	`, sessionHash, int(passkeyStepUpValidity.Seconds()))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("session not found")
	}
	return nil
}

// consumePasskeyStepUp atomically redeems (and clears) a fresh passkey step-up
// stamp. Returns false when there is no unexpired stamp.
func consumePasskeyStepUp(ctx context.Context, store *Store, sessionHash string) bool {
	if sessionHash == "" {
		return false
	}
	var id uuid.UUID
	err := store.pool.QueryRow(ctx, `
		UPDATE admin_sessions
		SET step_up_method = NULL, step_up_fresh_until = NULL
		WHERE token_hash = $1 AND expires_at > now()
		  AND step_up_method = 'passkey' AND step_up_fresh_until > now()
		RETURNING id
	`, sessionHash).Scan(&id)
	return err == nil
}

// stampStepUp records that the acting session just passed a code-based step-up
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

// ResetAdminMFA clears another admin's entire MFA enrollment (TOTP secret,
// recovery codes, passkeys and pending WebAuthn ceremonies) so that admin can
// re-enroll from scratch, and revokes their sessions so nothing issued under
// the old factors survives. The acting super_admin must confirm with their own
// factor (step-up).
func ResetAdminMFA(store *Store) http.HandlerFunc {
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

		if !verifyActorMFA(w, r, ctx, store, actorID, req.Code) {
			return
		}

		// Do not allow resetting your own factors through this path — Profile
		// manages your own MFA (and proves possession of the current factor).
		if targetID == actorID {
			writeError(w, http.StatusBadRequest, "Reset your own MFA from Profile instead")
			return
		}

		var exists bool
		if err := store.pool.QueryRow(ctx,
			`SELECT true FROM admins WHERE id = $1`, targetID).Scan(&exists); err != nil {
			writeError(w, http.StatusNotFound, "Admin not found")
			return
		}

		tx, err := store.pool.Begin(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to reset MFA")
			return
		}
		defer tx.Rollback(ctx)

		statements := []string{
			`DELETE FROM admin_sessions WHERE admin_id = $1`,
			`DELETE FROM webauthn_challenges WHERE admin_id = $1`,
			`DELETE FROM webauthn_credentials WHERE admin_id = $1`,
			`DELETE FROM webauthn_users WHERE admin_id = $1`,
			`UPDATE admins
			 SET totp_enabled = false, totp_secret_encrypted = NULL, backup_codes_hash = NULL, updated_at = now()
			 WHERE id = $1`,
		}
		for _, stmt := range statements {
			if _, err := tx.Exec(ctx, stmt, targetID); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to reset MFA")
				return
			}
		}
		if err := tx.Commit(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to reset MFA")
			return
		}

		logAudit(ctx, store, actorID, "mfa.reset", "admin", targetID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "mfa reset"})
	}
}
