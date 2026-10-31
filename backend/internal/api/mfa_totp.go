package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/wireguard-console/backend/internal/auth"
	authwebauthn "github.com/wireguard-console/backend/internal/auth/webauthn"
)

// MFA TOTP + recovery-code flows.
//
// Everything here is deliberately thin over mfa_shared.go: factor discovery,
// the policy decision, pending-login state, error envelopes and the single
// session-minting chokepoint (finishMFALogin) live there, so no handler in this
// file can grant a session without proving a factor.
//
// Pending secrets are server-generated and never trusted from the client: the
// password step creates a pending admin_sessions row, the TOTP enrollment
// begin stores the AES-GCM-encrypted secret in webauthn_challenges bound to
// that pending row's token hash, and finish reads it back from there.

const (
	// Enrollment/add-factor secrets live in webauthn_challenges while the
	// ceremony is open. 'enroll' is the only suitable purpose in the frozen
	// schema; the session_binding column carries the pending-login hash (or
	// the acting session hash for authenticated adds) and the unique
	// challenge_hash namespaces our rows away from passkey ceremonies.
	totpChallengePurpose    = "enroll"
	totpEnrollBindingPrefix = "totp-enroll:"
	totpAddBindingPrefix    = "totp-add:"
	totpChallengeTTL        = 10 * time.Minute
)

var errNoTOTPChallenge = errors.New("missing or expired TOTP enrollment challenge")

// totpChallengeData is the session_data JSON stored for a pending TOTP secret.
type totpChallengeData struct {
	SecretEncrypted string `json:"secret_encrypted"`
}

// totpChallengeHash namespaces a TOTP challenge row for one binding.
func totpChallengeHash(prefix, binding string, adminID uuid.UUID) string {
	return hashToken("wgc-" + prefix + ":" + adminID.String() + ":" + binding)
}

// storeTOTPChallenge persists (or refreshes) the encrypted pending secret for
// an enrollment, bound to a pending-login hash or an acting session hash.
func storeTOTPChallenge(ctx context.Context, store *Store, adminID uuid.UUID, prefix, binding, secretEncrypted string) error {
	data, err := json.Marshal(totpChallengeData{SecretEncrypted: secretEncrypted})
	if err != nil {
		return err
	}
	_, err = store.pool.Exec(ctx, `
		INSERT INTO webauthn_challenges
			(purpose, admin_id, session_binding, rp_id, origin, challenge_hash, session_data, lib_version, expires_at)
		VALUES ($1, $2, $3, '', '', $4, $5, 'totp', $6)
		ON CONFLICT (challenge_hash) DO UPDATE SET
			session_data = EXCLUDED.session_data,
			created_at   = now(),
			expires_at   = EXCLUDED.expires_at,
			consumed_at  = NULL
	`, totpChallengePurpose, adminID, binding, totpChallengeHash(prefix, binding, adminID), data, time.Now().Add(totpChallengeTTL))
	return err
}

// readTOTPChallengeSecret returns the decrypted pending secret for a binding.
func readTOTPChallengeSecret(ctx context.Context, store *Store, adminID uuid.UUID, prefix, binding string) (string, error) {
	var raw []byte
	err := store.pool.QueryRow(ctx, `
		SELECT session_data FROM webauthn_challenges
		WHERE challenge_hash = $1 AND admin_id = $2 AND purpose = $3
		  AND consumed_at IS NULL AND expires_at > now()
	`, totpChallengeHash(prefix, binding, adminID), adminID, totpChallengePurpose).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errNoTOTPChallenge
	}
	if err != nil {
		return "", err
	}
	var data totpChallengeData
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", err
	}
	if data.SecretEncrypted == "" {
		return "", errNoTOTPChallenge
	}
	secret, err := auth.DecryptTOTPSecret(ctx, data.SecretEncrypted)
	if err != nil {
		return "", err
	}
	return secret, nil
}

// loadPendingAdminStatus resolves an admin's status for a pending login.
func loadPendingAdminStatus(ctx context.Context, store *Store, adminID uuid.UUID) (string, error) {
	var status string
	if err := store.pool.QueryRow(ctx, `SELECT status FROM admins WHERE id = $1`, adminID).Scan(&status); err != nil {
		return "", err
	}
	return status, nil
}

// mfaLoginAdminBlock is the admin payload returned once a login is complete.
type mfaLoginAdminBlock struct {
	ID    uuid.UUID  `json:"id"`
	Email string     `json:"email"`
	Role  string     `json:"role"`
	MFA   mfaSummary `json:"mfa"`
}

// respondMFALoginSuccess writes the post-factor login response: the session's
// CSRF token plus the admin's identity and factor summary.
func respondMFALoginSuccess(ctx context.Context, store *Store, w http.ResponseWriter, adminID uuid.UUID, csrfToken string) {
	var (
		email string
		role  string
	)
	if err := store.pool.QueryRow(ctx, `SELECT email, role FROM admins WHERE id = $1`, adminID).Scan(&email, &role); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to load admin")
		return
	}
	summary, err := loadMFASummary(ctx, store, adminID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"csrf_token": csrfToken,
		"admin": mfaLoginAdminBlock{
			ID:    adminID,
			Email: email,
			Role:  role,
			MFA:   summary,
		},
	})
}

// writeMFAFailureResult maps a failed factor attempt to the contract response:
// 429 with retry_after_seconds when the lockout policy says so, else 400.
func writeMFAFailureResult(w http.ResponseWriter, retryAfter int) {
	if retryAfter > 0 {
		writeMFAErrorLocked(w, "mfa_locked", "Too many attempts - try again later", retryAfter)
		return
	}
	writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "That code is not valid")
}

// MFAState reports the pending login's state to the login page. Pending cookie
// only — no session, no CSRF.
func MFAState(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		adminID, _, expiresAt, kind, err := resolvePendingMFA(ctx, store, r, "")
		if errors.Is(err, errNoPendingMFA) {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		status, err := loadPendingAdminStatus(ctx, store, adminID)
		if err != nil {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if status != "active" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}

		state, err := buildMFAState(ctx, store, adminID, kind, expiresAt)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		writeJSON(w, http.StatusOK, state)
	}
}

// MFATOTPVerify completes a pending login with an authenticator-app code.
func MFATOTPVerify(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "That code is not valid")
			return
		}

		ctx := context.Background()
		adminID, tokenHash, _, _, err := resolvePendingMFA(ctx, store, r, pendingKindVerify)
		if err != nil {
			writePendingMFAError(w, err)
			return
		}

		var (
			status    string
			totpOn    bool
			secretEnc string
		)
		if err := store.pool.QueryRow(ctx, `
			SELECT status, totp_enabled, COALESCE(totp_secret_encrypted, '')
			FROM admins WHERE id = $1
		`, adminID).Scan(&status, &totpOn, &secretEnc); err != nil {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if status != "active" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}
		if !totpOn || secretEnc == "" {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "That code is not valid")
			return
		}

		secret, err := auth.DecryptTOTPSecret(ctx, secretEnc)
		if err != nil {
			log.Printf("Failed to decrypt TOTP secret: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to verify code")
			return
		}

		if !auth.VerifyTOTP(secret, req.Code) {
			_, retryAfter, recErr := recordMFAFailure(ctx, store, r, tokenHash)
			if recErr != nil {
				if errors.Is(recErr, errNoPendingMFA) {
					writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
					return
				}
				writeError(w, http.StatusInternalServerError, "Failed to record MFA attempt")
				return
			}
			writeMFAFailureResult(w, retryAfter)
			return
		}

		csrfToken, err := finishMFALogin(ctx, store, w, r, adminID, tokenHash, mfaMethodTOTP)
		if errors.Is(err, errNoPendingMFA) {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if err != nil {
			log.Printf("Failed to finish MFA login: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to complete sign-in")
			return
		}
		respondMFALoginSuccess(ctx, store, w, adminID, csrfToken)
	}
}

// MFARecoveryCodeVerify completes a pending login with a single-use recovery
// code (also accepted for step-up on sensitive actions, see admin_security.go).
func MFARecoveryCodeVerify(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "That code is not valid")
			return
		}

		ctx := context.Background()
		adminID, tokenHash, _, _, err := resolvePendingMFA(ctx, store, r, pendingKindVerify)
		if err != nil {
			writePendingMFAError(w, err)
			return
		}

		status, err := loadPendingAdminStatus(ctx, store, adminID)
		if err != nil {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if status != "active" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}

		ok, err := consumeRecoveryCode(ctx, store, adminID, req.Code)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to verify code")
			return
		}
		if !ok {
			_, retryAfter, recErr := recordMFAFailure(ctx, store, r, tokenHash)
			if recErr != nil {
				if errors.Is(recErr, errNoPendingMFA) {
					writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
					return
				}
				writeError(w, http.StatusInternalServerError, "Failed to record MFA attempt")
				return
			}
			writeMFAFailureResult(w, retryAfter)
			return
		}

		csrfToken, err := finishMFALogin(ctx, store, w, r, adminID, tokenHash, mfaMethodRecoveryCode)
		if errors.Is(err, errNoPendingMFA) {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if err != nil {
			log.Printf("Failed to finish MFA login: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to complete sign-in")
			return
		}
		respondMFALoginSuccess(ctx, store, w, adminID, csrfToken)
	}
}

// writePendingMFAError maps a pending-resolution failure to the contract
// envelope. A wrong pending kind (e.g. verifying while enrollment is required)
// is reported as "no pending verify state" so the SPA re-reads the state.
func writePendingMFAError(w http.ResponseWriter, err error) {
	if errors.Is(err, errNoPendingMFA) || errors.Is(err, errWrongPendingKind) {
		writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
		return
	}
	writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
}

// MFAEnrollTOTPBegin starts mandatory (pending) TOTP enrollment: the secret is
// generated server-side and kept encrypted, bound to the pending login.
func MFAEnrollTOTPBegin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		adminID, tokenHash, _, _, err := resolvePendingMFA(ctx, store, r, pendingKindEnroll)
		if err != nil {
			writePendingMFAError(w, err)
			return
		}
		status, err := loadPendingAdminStatus(ctx, store, adminID)
		if err != nil {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if status != "active" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}

		var totpOn bool
		if err := store.pool.QueryRow(ctx, `SELECT totp_enabled FROM admins WHERE id = $1`, adminID).Scan(&totpOn); err != nil {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if totpOn {
			writeMFAError(w, http.StatusBadRequest, "mfa_already_enabled", "An authenticator app is already enabled")
			return
		}

		totpKey, err := auth.GenerateTOTP()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate authenticator secret")
			return
		}
		secretEncrypted, err := auth.EncryptTOTPSecret(ctx, totpKey.Secret())
		if err != nil {
			log.Printf("Failed to encrypt pending TOTP secret: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to generate authenticator secret")
			return
		}
		if err := storeTOTPChallenge(ctx, store, adminID, totpEnrollBindingPrefix, tokenHash, secretEncrypted); err != nil {
			log.Printf("Failed to store TOTP enrollment challenge: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to start authenticator setup")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"secret":      totpKey.Secret(),
			"otpauth_url": totpKey.URL(),
		})
	}
}

// MFAEnrollTOTPFinish verifies the first code against the server-stored
// pending secret and enables TOTP. It mints NO session: the pending login
// continues and is completed by MFAEnrollComplete.
func MFAEnrollTOTPFinish(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "That code is not valid")
			return
		}

		ctx := context.Background()
		adminID, tokenHash, _, _, err := resolvePendingMFA(ctx, store, r, pendingKindEnroll)
		if err != nil {
			writePendingMFAError(w, err)
			return
		}
		status, err := loadPendingAdminStatus(ctx, store, adminID)
		if err != nil {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if status != "active" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}

		secret, err := readTOTPChallengeSecret(ctx, store, adminID, totpEnrollBindingPrefix, tokenHash)
		if errors.Is(err, errNoTOTPChallenge) {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "Authenticator setup expired - restart the setup")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to verify code")
			return
		}
		if !auth.VerifyTOTP(secret, req.Code) {
			_, retryAfter, recErr := recordMFAFailure(ctx, store, r, tokenHash)
			if recErr != nil {
				if errors.Is(recErr, errNoPendingMFA) {
					writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
					return
				}
				writeError(w, http.StatusInternalServerError, "Failed to record MFA attempt")
				return
			}
			writeMFAFailureResult(w, retryAfter)
			return
		}

		encrypted, err := auth.EncryptTOTPSecret(ctx, secret)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to store authenticator secret")
			return
		}
		if _, err := store.pool.Exec(ctx, `
			UPDATE admins SET totp_secret_encrypted = $1, totp_enabled = true, updated_at = now()
			WHERE id = $2
		`, encrypted, adminID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to enable authenticator app")
			return
		}

		logAudit(ctx, store, adminID, "mfa.totp_enroll", "admin", adminID.String(), map[string]interface{}{
			"forced": true,
		})
		writeJSON(w, http.StatusOK, map[string]string{"status": "factor_added"})
	}
}

// MFAEnrollComplete finishes a mandatory-enrollment login: it validates the
// organization policy, makes sure recovery codes exist, and only then mints
// the real session through finishMFALogin.
func MFAEnrollComplete(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		adminID, tokenHash, _, _, err := resolvePendingMFA(ctx, store, r, pendingKindEnroll)
		if err != nil {
			writePendingMFAError(w, err)
			return
		}

		status, err := loadPendingAdminStatus(ctx, store, adminID)
		if err != nil {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if status != "active" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}

		factors, err := loadMFAFactors(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		policy := loadMFAPolicy(ctx, store)
		svc := authwebauthn.Current()
		if !policySatisfied(policy, factors, svc.Available()) {
			missing := missingMethodsForPolicy(policy, factors, svc.Available())
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"error":           "Your account does not meet the MFA policy yet",
				"code":            "mfa_policy_violation",
				"missing_methods": missing,
			})
			return
		}

		recoveryCodes, generated, err := ensureRecoveryCodes(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to prepare recovery codes")
			return
		}

		csrfToken, err := finishMFALogin(ctx, store, w, r, adminID, tokenHash, "enroll")
		if errors.Is(err, errNoPendingMFA) {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if err != nil {
			log.Printf("Failed to finish MFA enrollment login: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to complete sign-in")
			return
		}

		var (
			email string
			role  string
		)
		if err := store.pool.QueryRow(ctx, `SELECT email, role FROM admins WHERE id = $1`, adminID).Scan(&email, &role); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load admin")
			return
		}
		summary, err := loadMFASummary(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		resp := map[string]interface{}{
			"csrf_token": csrfToken,
			"admin": mfaLoginAdminBlock{
				ID: adminID, Email: email, Role: role, MFA: summary,
			},
		}
		if generated {
			resp["recovery_codes"] = recoveryCodes
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// mfaFactorView is one row of the self-service factor list.
type mfaFactorView struct {
	ID             string     `json:"id"`
	Type           string     `json:"type"`
	Label          string     `json:"label"`
	CreatedAt      time.Time  `json:"created_at"`
	LastUsedAt     *time.Time `json:"last_used_at,omitempty"`
	Attachment     string     `json:"attachment,omitempty"`
	BackupEligible bool       `json:"backup_eligible,omitempty"`
	Usable         bool       `json:"usable"`
}

// GetMyMFA returns the signed-in admin's own factor inventory for the Profile
// page (MFA panel): usable methods, policy, recovery-code count and one row
// per factor.
func GetMyMFA(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		adminID := getAdminID(r)

		factors, err := loadMFAFactors(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		summary, err := loadMFASummary(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		svc := authwebauthn.Current()

		// TOTP has no enrolment timestamp column; updated_at is the best
		// available approximation (enrolling/removing a factor touches it).
		var adminUpdatedAt time.Time
		_ = store.pool.QueryRow(ctx, `SELECT updated_at FROM admins WHERE id = $1`, adminID).Scan(&adminUpdatedAt)

		views := make([]mfaFactorView, 0, 1+factors.PasskeyCount)
		if factors.TOTPEnabled {
			views = append(views, mfaFactorView{
				ID:        "totp",
				Type:      mfaMethodTOTP,
				Label:     "Authenticator app",
				CreatedAt: adminUpdatedAt,
				Usable:    true,
			})
		}

		rows, err := store.pool.Query(ctx, `
			SELECT id, label, created_at, last_used_at, attachment, backup_eligible, (rp_id = $2)
			FROM webauthn_credentials
			WHERE admin_id = $1
			ORDER BY created_at ASC
		`, adminID, svc.RPID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load passkeys")
			return
		}
		defer rows.Close()
		for rows.Next() {
			var (
				id        uuid.UUID
				label     string
				createdAt time.Time
				lastUsed  *time.Time
				attach    string
				backup    bool
				usable    bool
			)
			if err := rows.Scan(&id, &label, &createdAt, &lastUsed, &attach, &backup, &usable); err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to load passkeys")
				return
			}
			if label == "" {
				label = "Passkey"
			}
			views = append(views, mfaFactorView{
				ID:             id.String(),
				Type:           mfaMethodPasskey,
				Label:          label,
				CreatedAt:      createdAt,
				LastUsedAt:     lastUsed,
				Attachment:     attach,
				BackupEligible: backup,
				Usable:         usable,
			})
		}
		if err := rows.Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load passkeys")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"mfa_enabled":              summary.Enabled,
			"methods":                  summary.Methods,
			"passkey_available":        summary.PasskeyAvailable,
			"passkey_reason":           svc.Reason,
			"rp_id":                    svc.RPID,
			"require_methods":          loadMFAPolicy(ctx, store),
			"recovery_codes_remaining": factors.RecoveryCodeCount,
			"factors":                  views,
			"totp_enabled":             factors.TOTPEnabled,
		})
	}
}

// AddTOTPBegin starts adding an authenticator app to an already signed-in
// admin (Profile → MFA). When the admin already has a factor, this is a
// step-up-gated action so a stolen session cannot silently enroll a new one.
func AddTOTPBegin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req) // body is optional (no factor yet)

		ctx := context.Background()
		adminID := getAdminID(r)

		factors, err := loadMFAFactors(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		if factors.TOTPEnabled {
			writeMFAError(w, http.StatusBadRequest, "mfa_already_enabled", "An authenticator app is already enabled")
			return
		}
		if factors.Enrolled() {
			if !verifyActorMFA(w, r, ctx, store, adminID, req.Code) {
				return
			}
		}

		totpKey, err := auth.GenerateTOTP()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate authenticator secret")
			return
		}
		secretEncrypted, err := auth.EncryptTOTPSecret(ctx, totpKey.Secret())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate authenticator secret")
			return
		}
		binding := currentSessionTokenHash(r)
		if binding == "" {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if err := storeTOTPChallenge(ctx, store, adminID, totpAddBindingPrefix, binding, secretEncrypted); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to start authenticator setup")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"secret":      totpKey.Secret(),
			"otpauth_url": totpKey.URL(),
		})
	}
}

// AddTOTPFinish confirms the new authenticator secret and enables TOTP.
func AddTOTPFinish(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "That code is not valid")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)
		binding := currentSessionTokenHash(r)

		secret, err := readTOTPChallengeSecret(ctx, store, adminID, totpAddBindingPrefix, binding)
		if errors.Is(err, errNoTOTPChallenge) {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "Authenticator setup expired - restart the setup")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to verify code")
			return
		}
		if !auth.VerifyTOTP(secret, req.Code) {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "That code is not valid")
			return
		}

		encrypted, err := auth.EncryptTOTPSecret(ctx, secret)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to store authenticator secret")
			return
		}
		if _, err := store.pool.Exec(ctx, `
			UPDATE admins SET totp_secret_encrypted = $1, totp_enabled = true, updated_at = now()
			WHERE id = $2
		`, encrypted, adminID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to enable authenticator app")
			return
		}

		// A new factor raises the account's security posture: retire sessions
		// minted before it, keeping the acting one that just proved the secret.
		if err := revokeAdminSessionsExcept(ctx, store, adminID, binding); err != nil {
			log.Printf("Failed to revoke other sessions after TOTP add: admin_id=%s err=%v", adminID, err)
		}
		logAudit(ctx, store, adminID, "mfa.totp_add", "admin", adminID.String(), nil)

		factors, err := loadMFAFactors(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":                   "factor_added",
			"recovery_codes_remaining": factors.RecoveryCodeCount,
		})
	}
}

// AddTOTPRemove removes the admin's authenticator app after a strict step-up.
// The last remaining factor may not be removed: an admin must always keep at
// least one way to sign in.
func AddTOTPRemove(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "That code is not valid")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		if !verifyActorMFACode(w, r, ctx, store, adminID, req.Code) {
			return
		}

		factors, err := loadMFAFactors(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		if !factors.TOTPEnabled {
			writeMFAError(w, http.StatusBadRequest, "mfa_no_factor", "An authenticator app is not enabled")
			return
		}
		if factors.PasskeyCount == 0 {
			writeMFAError(w, http.StatusConflict, "mfa_last_factor", "This is your last MFA factor - add another one before removing it")
			return
		}

		if _, err := store.pool.Exec(ctx, `
			UPDATE admins
			SET totp_enabled = false, totp_secret_encrypted = NULL, backup_codes_hash = NULL, updated_at = now()
			WHERE id = $1
		`, adminID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to remove authenticator app")
			return
		}

		if err := revokeAdminSessionsExcept(ctx, store, adminID, currentSessionTokenHash(r)); err != nil {
			log.Printf("Failed to revoke other sessions after TOTP remove: admin_id=%s err=%v", adminID, err)
		}
		logAudit(ctx, store, adminID, "mfa.totp_remove", "admin", adminID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
	}
}

// RegenerateRecoveryCodes replaces the admin's single-use recovery codes with a
// fresh set (shown once). Strict step-up: no grace window is accepted.
func RegenerateRecoveryCodes(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "That code is not valid")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		if !verifyActorMFACode(w, r, ctx, store, adminID, req.Code) {
			return
		}

		codes := make([]string, recoveryCodeCount)
		hashes := make([]string, recoveryCodeCount)
		for i := 0; i < recoveryCodeCount; i++ {
			code, err := generateRecoveryCode()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to generate recovery codes")
				return
			}
			codes[i] = code
			hashes[i] = recoveryCodeHash(adminID, code)
		}
		if _, err := store.pool.Exec(ctx, `
			UPDATE admins SET backup_codes_hash = $1, updated_at = now() WHERE id = $2
		`, hashes, adminID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save recovery codes")
			return
		}

		logAudit(ctx, store, adminID, "mfa.recovery_regenerate", "admin", adminID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]interface{}{"recovery_codes": codes})
	}
}
