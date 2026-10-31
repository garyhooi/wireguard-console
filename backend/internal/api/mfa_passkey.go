package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	authwebauthn "github.com/wireguard-console/backend/internal/auth/webauthn"
)

// Passkey (WebAuthn) endpoints.
//
// This file is a thin HTTP layer over internal/auth/webauthn: the ceremony
// state, challenge binding/claiming and credential mapping live there, while
// the login/enrollment/step-up lifecycle and the shared error envelopes live in
// mfa_shared.go / admin_security.go. Passkey login finishes in the same single
// session-minting chokepoint as TOTP (finishMFALogin), so a passkey can never
// mint a session by itself.
//
// Wire format (contract §3): begin returns the INNER options object the SPA
// hands to navigator.credentials.get/create; finish accepts the raw
// AuthenticationResponseJSON / RegistrationResponseJSON object the browser
// produced. The challenge id is a separate field, never embedded in options.

const (
	// passkeyMaxRequestBytes bounds a browser credential response body.
	passkeyMaxRequestBytes = 1 << 20
)

type passkeyBeginResponse struct {
	ChallengeID      string `json:"challenge_id"`
	Options          any    `json:"options"`
	RPID             string `json:"rp_id"`
	ExpiresInSeconds int    `json:"expires_in_seconds"`
}

type passkeyFinishRequest struct {
	ChallengeID string          `json:"challenge_id"`
	Credential  json.RawMessage `json:"credential"`
	Label       string          `json:"label"`
}

// passkeyFactor is the factor row returned once a passkey is enrolled.
type passkeyFactor struct {
	ID        uuid.UUID `json:"id"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"created_at"`
}

type passkeyFactorAddedResponse struct {
	Status string        `json:"status"`
	Factor passkeyFactor `json:"factor"`
}

// requirePasskeyService writes the contract 409 mfa_unavailable envelope and
// reports false when the deployment cannot host passkeys (IP-only console or
// the feature disabled by configuration).
func requirePasskeyService(w http.ResponseWriter) (*authwebauthn.Service, bool) {
	svc := authwebauthn.Current()
	if svc.Available() {
		return svc, true
	}
	reason := strings.TrimSpace(svc.Reason)
	if reason == "" {
		reason = "Passkeys are not available in this deployment"
	}
	writeMFAError(w, http.StatusConflict, "mfa_unavailable", reason)
	return nil, false
}

// decodePasskeyFinish decodes and validates the shared finish body.
func decodePasskeyFinish(w http.ResponseWriter, r *http.Request) (passkeyFinishRequest, bool) {
	var req passkeyFinishRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, passkeyMaxRequestBytes)).Decode(&req); err != nil {
		writeMFAError(w, http.StatusBadRequest, "mfa_passkey_failed", "Malformed passkey response")
		return req, false
	}
	if strings.TrimSpace(req.ChallengeID) == "" || len(req.Credential) == 0 {
		writeMFAError(w, http.StatusBadRequest, "mfa_passkey_failed", "Malformed passkey response")
		return req, false
	}
	return req, true
}

// passkeyChallengeID parses the ceremony id from a finish request.
func passkeyChallengeID(w http.ResponseWriter, raw string) (uuid.UUID, bool) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		writeMFAError(w, http.StatusBadRequest, "mfa_passkey_failed", "Malformed passkey response")
		return uuid.Nil, false
	}
	return id, true
}

// passkeyBeginResponseFor assembles the begin response (TTL in whole seconds).
func passkeyBeginResponseFor(svc *authwebauthn.Service, options any, challengeID uuid.UUID, expiresAt time.Time) passkeyBeginResponse {
	remaining := int(math.Ceil(time.Until(expiresAt).Seconds()))
	if remaining < 0 {
		remaining = 0
	}
	return passkeyBeginResponse{
		ChallengeID:      challengeID.String(),
		Options:          options,
		RPID:             svc.RPID,
		ExpiresInSeconds: remaining,
	}
}

// passkeyPendingAdminActive re-checks the pending login's admin status; a
// disabled account must not complete a login/enrollment.
func passkeyPendingAdminActive(w http.ResponseWriter, ctx context.Context, store *Store, adminID uuid.UUID) bool {
	status, err := loadPendingAdminStatus(ctx, store, adminID)
	if err != nil {
		writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
		return false
	}
	if status != "active" {
		writeError(w, http.StatusForbidden, "Account is disabled")
		return false
	}
	return true
}

// MFAPasskeyLoginBegin starts the passkey second factor for a pending password
// login. Only that pending admin's RP-scoped credentials are offered.
func MFAPasskeyLoginBegin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		svc, ok := requirePasskeyService(w)
		if !ok {
			return
		}
		ctx := context.Background()

		adminID, tokenHash, _, _, err := resolvePendingMFA(ctx, store, r, pendingKindVerify)
		if err != nil {
			writePendingMFAError(w, err)
			return
		}
		if !passkeyPendingAdminActive(w, ctx, store, adminID) {
			return
		}

		factors, err := loadMFAFactors(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		if factors.PasskeyCount == 0 {
			writeMFAError(w, http.StatusBadRequest, "mfa_no_passkeys", "No passkeys are registered for this account")
			return
		}

		options, challengeID, expiresAt, err := authwebauthn.BeginLoginFor(ctx, store.pool, adminID, authwebauthn.PurposeLogin, tokenHash)
		if err != nil {
			if errors.Is(err, authwebauthn.ErrNoCredentials) {
				writeMFAError(w, http.StatusBadRequest, "mfa_no_passkeys", "No passkeys are registered for this account")
				return
			}
			log.Printf("Failed to begin passkey login: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to start passkey verification")
			return
		}
		writeJSON(w, http.StatusOK, passkeyBeginResponseFor(svc, options, challengeID, expiresAt))
	}
}

// MFAPasskeyLoginFinish validates the assertion and mints the session through
// finishMFALogin - the ONLY session-minting path after a password login.
func MFAPasskeyLoginFinish(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requirePasskeyService(w); !ok {
			return
		}
		ctx := context.Background()

		adminID, tokenHash, _, _, err := resolvePendingMFA(ctx, store, r, pendingKindVerify)
		if err != nil {
			writePendingMFAError(w, err)
			return
		}
		if !passkeyPendingAdminActive(w, ctx, store, adminID) {
			return
		}

		req, ok := decodePasskeyFinish(w, r)
		if !ok {
			return
		}
		challengeID, ok := passkeyChallengeID(w, req.ChallengeID)
		if !ok {
			return
		}

		if _, err := authwebauthn.FinishLoginFor(ctx, store.pool, adminID, authwebauthn.PurposeLogin, tokenHash, challengeID, req.Credential); err != nil {
			log.Printf("Passkey login rejected: admin_id=%s err=%v", adminID, err)
			_, retryAfter, recErr := recordMFAFailure(ctx, store, r, tokenHash)
			if recErr != nil {
				if errors.Is(recErr, errNoPendingMFA) {
					writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
					return
				}
				writeError(w, http.StatusInternalServerError, "Failed to record MFA attempt")
				return
			}
			if retryAfter > 0 {
				writeMFAErrorLocked(w, "mfa_locked", "Too many failed attempts - try again later", retryAfter)
				return
			}
			writeMFAError(w, http.StatusBadRequest, "mfa_passkey_failed", "Passkey verification failed")
			return
		}

		csrfToken, err := finishMFALogin(ctx, store, w, r, adminID, tokenHash, mfaMethodPasskey)
		if errors.Is(err, errNoPendingMFA) {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}
		if err != nil {
			log.Printf("Failed to finish passkey login: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to complete sign-in")
			return
		}
		respondMFALoginSuccess(ctx, store, w, adminID, csrfToken)
	}
}

// MFAEnrollPasskeyBegin starts forced (pending) passkey enrollment.
func MFAEnrollPasskeyBegin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		svc, ok := requirePasskeyService(w)
		if !ok {
			return
		}
		ctx := context.Background()

		adminID, tokenHash, _, _, err := resolvePendingMFA(ctx, store, r, pendingKindEnroll)
		if err != nil {
			writePendingMFAError(w, err)
			return
		}
		if !passkeyPendingAdminActive(w, ctx, store, adminID) {
			return
		}

		options, challengeID, expiresAt, err := authwebauthn.BeginRegistrationFor(ctx, store.pool, adminID, tokenHash)
		if err != nil {
			log.Printf("Failed to begin passkey enrollment: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to start passkey setup")
			return
		}
		writeJSON(w, http.StatusOK, passkeyBeginResponseFor(svc, options, challengeID, expiresAt))
	}
}

// MFAEnrollPasskeyFinish persists the new passkey. It mints NO session: the
// pending enrollment continues and is completed by MFAEnrollComplete.
func MFAEnrollPasskeyFinish(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requirePasskeyService(w); !ok {
			return
		}
		ctx := context.Background()

		adminID, tokenHash, _, _, err := resolvePendingMFA(ctx, store, r, pendingKindEnroll)
		if err != nil {
			writePendingMFAError(w, err)
			return
		}
		if !passkeyPendingAdminActive(w, ctx, store, adminID) {
			return
		}

		req, ok := decodePasskeyFinish(w, r)
		if !ok {
			return
		}
		challengeID, ok := passkeyChallengeID(w, req.ChallengeID)
		if !ok {
			return
		}

		record, err := authwebauthn.FinishRegistrationFor(ctx, store.pool, adminID, tokenHash, challengeID, req.Credential, req.Label)
		if err != nil {
			if errors.Is(err, authwebauthn.ErrCredentialExists) {
				writeMFAError(w, http.StatusConflict, "mfa_passkey_failed", "This passkey is already registered")
				return
			}
			log.Printf("Passkey enrollment rejected: admin_id=%s err=%v", adminID, err)
			writeMFAError(w, http.StatusBadRequest, "mfa_passkey_failed", "Passkey setup failed")
			return
		}

		logAudit(ctx, store, adminID, "mfa.passkey_enroll", "admin", adminID.String(), map[string]interface{}{
			"forced":        true,
			"credential_id": record.ID.String(),
		})
		writeJSON(w, http.StatusOK, passkeyFactorAddedResponse{
			Status: "factor_added",
			Factor: passkeyFactor{ID: record.ID, Label: record.Label, CreatedAt: record.CreatedAt},
		})
	}
}

// AddPasskeyBegin starts adding a passkey to an already signed-in admin
// (Profile -> MFA). The actor must prove an existing factor (a typed TOTP /
// recovery code, or a just-completed passkey step-up which verifies the empty
// code once).
func AddPasskeyBegin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		svc, ok := requirePasskeyService(w)
		if !ok {
			return
		}

		var req struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, passkeyMaxRequestBytes)).Decode(&req) // body is optional

		ctx := context.Background()
		adminID := getAdminID(r)

		if !verifyActorMFA(w, r, ctx, store, adminID, req.Code) {
			return
		}

		binding := currentSessionTokenHash(r)
		if binding == "" {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}

		options, challengeID, expiresAt, err := authwebauthn.BeginRegistrationFor(ctx, store.pool, adminID, binding)
		if err != nil {
			log.Printf("Failed to begin passkey add: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to start passkey setup")
			return
		}
		writeJSON(w, http.StatusOK, passkeyBeginResponseFor(svc, options, challengeID, expiresAt))
	}
}

// AddPasskeyFinish persists a passkey added from a signed-in session.
func AddPasskeyFinish(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requirePasskeyService(w); !ok {
			return
		}
		ctx := context.Background()
		adminID := getAdminID(r)
		binding := currentSessionTokenHash(r)
		if binding == "" {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}

		req, ok := decodePasskeyFinish(w, r)
		if !ok {
			return
		}
		challengeID, ok := passkeyChallengeID(w, req.ChallengeID)
		if !ok {
			return
		}

		record, err := authwebauthn.FinishRegistrationFor(ctx, store.pool, adminID, binding, challengeID, req.Credential, req.Label)
		if err != nil {
			if errors.Is(err, authwebauthn.ErrCredentialExists) {
				writeMFAError(w, http.StatusConflict, "mfa_passkey_failed", "This passkey is already registered")
				return
			}
			log.Printf("Passkey add rejected: admin_id=%s err=%v", adminID, err)
			writeMFAError(w, http.StatusBadRequest, "mfa_passkey_failed", "Passkey setup failed")
			return
		}

		logAudit(ctx, store, adminID, "mfa.passkey_add", "admin", adminID.String(), map[string]interface{}{
			"credential_id": record.ID.String(),
		})
		writeJSON(w, http.StatusOK, passkeyFactorAddedResponse{
			Status: "factor_added",
			Factor: passkeyFactor{ID: record.ID, Label: record.Label, CreatedAt: record.CreatedAt},
		})
	}
}

// UpdatePasskey renames one of the acting admin's passkeys.
func UpdatePasskey(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid passkey ID")
			return
		}
		var req struct {
			Label string `json:"label"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, passkeyMaxRequestBytes)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)
		label := authwebauthn.NormalizeLabel(req.Label)

		tag, err := store.pool.Exec(ctx, `
			UPDATE webauthn_credentials SET label = $1 WHERE id = $2 AND admin_id = $3
		`, label, id, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update passkey")
			return
		}
		if tag.RowsAffected() == 0 {
			writeError(w, http.StatusNotFound, "Passkey not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}

// DeletePasskey removes one of the acting admin's passkeys. The last remaining
// factor can never be removed (it would lock the admin out); the strict step-up
// variant is used so removing an authentication credential always requires a
// fresh proof. Removing a passkey retires the admin's other sessions and clears
// any step-up stamp, since the credential material changed.
func DeletePasskey(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := parseUUID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid passkey ID")
			return
		}
		var req struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, passkeyMaxRequestBytes)).Decode(&req) // strict step-up reports a missing code

		ctx := context.Background()
		adminID := getAdminID(r)

		record, err := authwebauthn.GetCredential(ctx, store.pool, adminID, id)
		if errors.Is(err, authwebauthn.ErrCredentialNotFound) {
			writeError(w, http.StatusNotFound, "Passkey not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load passkey")
			return
		}

		factors, err := loadMFAFactors(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		svc := authwebauthn.Current()
		usablePasskeys := factors.PasskeyCount
		if !svc.Available() || record.RPID != svc.RPID {
			// This row is not one of the usable factor(s) counted above.
			usablePasskeys++
		}
		if !factors.TOTPEnabled && usablePasskeys <= 1 {
			writeMFAError(w, http.StatusConflict, "mfa_last_factor", "This is your last MFA factor - add another one before removing it")
			return
		}

		if !verifyActorMFACode(w, r, ctx, store, adminID, req.Code) {
			return
		}

		deleted, err := authwebauthn.DeleteCredential(ctx, store.pool, adminID, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to remove passkey")
			return
		}
		if !deleted {
			writeError(w, http.StatusNotFound, "Passkey not found")
			return
		}

		if err := revokeAdminSessionsExcept(ctx, store, adminID, currentSessionTokenHash(r)); err != nil {
			log.Printf("Failed to revoke other sessions after passkey removal: admin_id=%s err=%v", adminID, err)
		}
		// A removed credential invalidates any step-up proof obtained with it.
		_, _ = store.pool.Exec(ctx, `
			UPDATE admin_sessions
			SET step_up_method = NULL, step_up_verified_at = NULL, step_up_fresh_until = NULL
			WHERE admin_id = $1
		`, adminID)

		logAudit(ctx, store, adminID, "mfa.passkey_remove", "admin", adminID.String(), map[string]interface{}{
			"credential_id": id.String(),
		})
		writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
	}
}

// PasskeyStepUpBegin starts an explicit passkey step-up ceremony for the acting
// session: user verification is REQUIRED by the ceremony options.
func PasskeyStepUpBegin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		svc, ok := requirePasskeyService(w)
		if !ok {
			return
		}
		ctx := context.Background()
		adminID := getAdminID(r)

		factors, err := loadMFAFactors(ctx, store, adminID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		if factors.PasskeyCount == 0 {
			writeMFAError(w, http.StatusBadRequest, "mfa_no_passkeys", "No passkeys are registered for this account")
			return
		}

		binding := currentSessionTokenHash(r)
		if binding == "" {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}

		options, challengeID, expiresAt, err := authwebauthn.BeginLoginFor(ctx, store.pool, adminID, authwebauthn.PurposeStepUp, binding)
		if err != nil {
			if errors.Is(err, authwebauthn.ErrNoCredentials) {
				writeMFAError(w, http.StatusBadRequest, "mfa_no_passkeys", "No passkeys are registered for this account")
				return
			}
			log.Printf("Failed to begin passkey step-up: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to start passkey verification")
			return
		}
		writeJSON(w, http.StatusOK, passkeyBeginResponseFor(svc, options, challengeID, expiresAt))
	}
}

// PasskeyStepUpFinish verifies the assertion (UV required) and stamps the
// acting session as freshly step-up verified. The gated action is then allowed
// once with an empty code (see verifyActorMFA / consumePasskeyStepUp).
func PasskeyStepUpFinish(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requirePasskeyService(w); !ok {
			return
		}
		ctx := context.Background()
		adminID := getAdminID(r)
		binding := currentSessionTokenHash(r)
		if binding == "" {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - sign in again")
			return
		}

		req, ok := decodePasskeyFinish(w, r)
		if !ok {
			return
		}
		challengeID, ok := passkeyChallengeID(w, req.ChallengeID)
		if !ok {
			return
		}

		if _, err := authwebauthn.FinishLoginFor(ctx, store.pool, adminID, authwebauthn.PurposeStepUp, binding, challengeID, req.Credential); err != nil {
			log.Printf("Passkey step-up rejected: admin_id=%s err=%v", adminID, err)
			writeMFAError(w, http.StatusBadRequest, "mfa_passkey_failed", "Passkey verification failed")
			return
		}

		if err := stampPasskeyStepUp(ctx, store, binding); err != nil {
			log.Printf("Failed to stamp passkey step-up: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to record passkey verification")
			return
		}

		logAudit(ctx, store, adminID, "mfa.passkey_stepup", "admin", adminID.String(), nil)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":            "verified",
			"valid_for_seconds": int(passkeyStepUpValidity.Seconds()),
		})
	}
}
