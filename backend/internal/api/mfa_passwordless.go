package api

// Passwordless ("Sign in with a passkey") endpoints.
//
// This is a THIRD login transport, next to password+second-factor and
// recovery codes: a discoverable credential is selected in the browser's own
// account picker, so the request never carries an email. The account is only
// resolved at finish from the assertion's opaque user handle.
//
// Security model:
//   - begin stores a one-shot challenge row with a NULL admin_id and binds it
//     to a short-lived HttpOnly cookie (hash stored in session_binding), so a
//     leaked challenge id alone cannot complete an assertion in another browser;
//   - finish claims that row atomically (single use, 5-minute TTL) and lets the
//     go-webauthn library verify the assertion - RP ID hash, origin, challenge,
//     UV (REQUIRED), credential ownership and signature;
//   - failures feed the shared per-IP login lockout and always answer a generic
//     401, so unknown handles and disabled accounts are indistinguishable;
//   - only a fully validated assertion reaches mintLoginSession, the single
//     session-minting chokepoint. Password login is unchanged and still requires
//     a second factor.

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	authwebauthn "github.com/wireguard-console/backend/internal/auth/webauthn"
)

// passkeyStatusResponse is the public deployment-capability probe. It never
// carries per-user information: the SPA only needs to know whether the button
// can be shown at all.
type passkeyStatusResponse struct {
	PasskeyAvailable bool   `json:"passkey_available"`
	PasskeyReason    string `json:"passkey_reason,omitempty"`
}

// PasskeyStatus reports whether this deployment can host passkey ceremonies.
// It answers 200 even when unavailable so the SPA can simply hide the button
// (the reason is advisory diagnostics).
func PasskeyStatus(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		svc := authwebauthn.Current()
		resp := passkeyStatusResponse{PasskeyAvailable: svc.Available()}
		if !resp.PasskeyAvailable {
			resp.PasskeyReason = svc.Reason
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// PasskeyPasswordlessBegin starts a discoverable-credential assertion. There is
// no account in the request: the options deliberately carry no
// allowCredentials, and the browser shows its own passkey picker.
func PasskeyPasswordlessBegin(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		svc, ok := requirePasskeyService(w)
		if !ok {
			return
		}
		ctx := context.Background()

		// A locked-out source may not even start a new ceremony.
		if remaining := ipLoginLockout.remaining(getClientIP(r), time.Now()); remaining > 0 {
			respondLocked(w, lockoutSeconds(remaining))
			return
		}

		token, err := generateToken()
		if err != nil {
			log.Printf("Failed to generate passwordless ceremony token: %v", err)
			writeError(w, http.StatusInternalServerError, "Failed to start passkey sign-in")
			return
		}

		options, challengeID, expiresAt, err := authwebauthn.BeginDiscoverableLoginFor(ctx, store.pool, hashToken(token))
		if err != nil {
			log.Printf("Failed to begin passwordless passkey sign-in: err=%v", err)
			writeError(w, http.StatusInternalServerError, "Failed to start passkey sign-in")
			return
		}

		setPasskeyLoginCookie(w, r, token)
		writeJSON(w, http.StatusOK, passkeyBeginResponseFor(svc, options, challengeID, expiresAt))
	}
}

// PasskeyPasswordlessFinish validates a discoverable assertion and, only then,
// mints the session through the single chokepoint.
func PasskeyPasswordlessFinish(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requirePasskeyService(w); !ok {
			return
		}
		ctx := context.Background()

		// The ceremony cookie is what ties the assertion to this browser. Its
		// hash is the challenge's session_binding.
		token := readPasskeyLoginToken(r)
		if token == "" {
			writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - start again")
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

		adminID, _, err := authwebauthn.FinishDiscoverableLoginFor(ctx, store.pool, hashToken(token), challengeID, req.Credential)
		if err != nil {
			if errors.Is(err, authwebauthn.ErrChallengeNotFound) {
				// Unknown, expired, consumed or bound to another browser: this
				// ceremony is dead, start over.
				writeMFAError(w, http.StatusUnauthorized, "mfa_no_pending", "Your sign-in session expired - start again")
				return
			}

			// Validation failure (unknown/disabled account, impossible
			// credential, wrong origin/challenge/UV/signature). Log the detail
			// server-side and answer generically so nothing is enumerable.
			log.Printf("Passwordless passkey sign-in rejected: err=%v", err)
			policy := loadLoginPolicy(ctx, store.pool)
			locked := ipLoginLockout.recordFailure(getClientIP(r), time.Now(), policy.MaxAttempts, policy.IPLockout)
			if locked > 0 {
				writeMFAErrorLocked(w, "mfa_locked", "Too many failed attempts - try again later", lockoutSeconds(locked))
				return
			}
			writeMFAError(w, http.StatusUnauthorized, "mfa_invalid", "That passkey could not be verified. Use your password instead or try again.")
			return
		}

		csrfToken, err := mintLoginSession(ctx, store, w, r, adminID, "mfa.login_passkey", map[string]interface{}{
			"method":       "passkey",
			"passwordless": true,
		})
		if err != nil {
			log.Printf("Failed to mint passwordless passkey session: admin_id=%s err=%v", adminID, err)
			writeError(w, http.StatusInternalServerError, "Failed to complete sign-in")
			return
		}
		respondMFALoginSuccess(ctx, store, w, adminID, csrfToken)
	}
}
