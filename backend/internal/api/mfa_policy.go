package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	authwebauthn "github.com/wireguard-console/backend/internal/auth/webauthn"
)

// Organization MFA policy (Configuration → Security → MFA).
//
// config.mfa_require_methods decides which factors every admin must have before
// a session is issued. Login enforces it: an admin who does not satisfy the
// stored policy gets pending_mfa_setup and cannot reach any protected API until
// enrollment completes. Passkey-requiring policies degrade to "any" on
// deployments where passkeys are impossible (IP-only consoles) — see
// loadMFAPolicy in mfa_shared.go.

// mfaPolicyValues is the accepted wire vocabulary, in display order.
var mfaPolicyValues = []string{mfaPolicyAny, mfaPolicyTOTP, mfaPolicyPasskey, mfaPolicyBoth}

func validMFAPolicy(value string) bool {
	for _, v := range mfaPolicyValues {
		if value == v {
			return true
		}
	}
	return false
}

// GetMFAPolicyConfig returns the organization MFA policy plus the deployment's
// passkey capability. Readable by every signed-in admin (the Security tab shows
// the active policy).
func GetMFAPolicyConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		svc := authwebauthn.Current()
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"require_methods":   loadMFAPolicy(ctx, store),
			"passkey_available": svc.Available(),
			"passkey_reason":    svc.Reason,
			"rp_id":             svc.RPID,
		})
	}
}

// UpdateMFAPolicyConfig persists the organization MFA policy. super_admin only
// (route-gated) and strict step-up: a policy change can never ride a merely
// recent verification window.
func UpdateMFAPolicyConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			RequireMethods string `json:"require_methods"`
			Code           string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)
		if !verifyActorMFACode(w, r, ctx, store, adminID, req.Code) {
			return
		}

		value := strings.ToLower(strings.TrimSpace(req.RequireMethods))
		if !validMFAPolicy(value) {
			writeMFAError(w, http.StatusBadRequest, "mfa_invalid", "require_methods must be one of: any, totp, passkey, both")
			return
		}

		svc := authwebauthn.Current()
		if (value == mfaPolicyPasskey || value == mfaPolicyBoth) && !svc.Available() {
			writeMFAError(w, http.StatusConflict, "mfa_unavailable",
				"Passkeys are unavailable on this deployment ("+svc.Reason+")")
			return
		}

		if _, err := store.pool.Exec(ctx, `
			INSERT INTO config (id, mfa_require_methods) VALUES (1, $1)
			ON CONFLICT (id) DO UPDATE SET
				mfa_require_methods = EXCLUDED.mfa_require_methods,
				updated_at = now()
		`, value); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save MFA policy")
			return
		}

		logAudit(ctx, store, adminID, "config.update", "config", "", map[string]interface{}{
			"mfa_require_methods": value,
		})

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}
