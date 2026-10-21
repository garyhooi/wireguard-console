package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Login lockout policy (Configuration → Security, super_admin editable).
//
// Wrong passwords lock both the source IP and the account for a short window.
// This file is the single place that reads the policy: the login handler and
// the security-config API both go through loadLoginPolicy, so defaults apply
// consistently when the columns/row are absent.
const (
	defaultLoginMaxAttempts    = 3
	defaultLoginLockoutSeconds = 60

	minLoginMaxAttempts    = 1
	maxLoginMaxAttempts    = 20
	minLoginLockoutSeconds = 5
	maxLoginLockoutSeconds = 3600
)

type loginPolicy struct {
	MaxAttempts    int
	IPLockout      time.Duration
	AccountLockout time.Duration
}

func defaultLoginPolicy() loginPolicy {
	d := defaultLoginLockoutSeconds * time.Second
	return loginPolicy{MaxAttempts: defaultLoginMaxAttempts, IPLockout: d, AccountLockout: d}
}

// loadLoginPolicy reads the configured lockout policy, clamping anything
// outside the supported range back to the default.
func loadLoginPolicy(ctx context.Context, pool *pgxpool.Pool) loginPolicy {
	policy := defaultLoginPolicy()

	var attempts, ipSeconds, accountSeconds int
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(login_max_attempts, 3),
		       COALESCE(login_ip_lockout_seconds, 60),
		       COALESCE(login_account_lockout_seconds, 60)
		FROM config WHERE id = 1
	`).Scan(&attempts, &ipSeconds, &accountSeconds)
	if err != nil {
		return policy
	}
	if attempts >= minLoginMaxAttempts && attempts <= maxLoginMaxAttempts {
		policy.MaxAttempts = attempts
	}
	if ipSeconds >= minLoginLockoutSeconds && ipSeconds <= maxLoginLockoutSeconds {
		policy.IPLockout = time.Duration(ipSeconds) * time.Second
	}
	if accountSeconds >= minLoginLockoutSeconds && accountSeconds <= maxLoginLockoutSeconds {
		policy.AccountLockout = time.Duration(accountSeconds) * time.Second
	}
	return policy
}

type securityConfigResponse struct {
	LoginMaxAttempts           int `json:"login_max_attempts"`
	LoginIPLockoutSeconds      int `json:"login_ip_lockout_seconds"`
	LoginAccountLockoutSeconds int `json:"login_account_lockout_seconds"`
}

// GetSecurityConfig returns the current login-lockout policy. Readable by any
// signed-in admin so the Security tab can show the active policy.
func GetSecurityConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		policy := loadLoginPolicy(context.Background(), store.pool)
		writeJSON(w, http.StatusOK, securityConfigResponse{
			LoginMaxAttempts:           policy.MaxAttempts,
			LoginIPLockoutSeconds:      int(policy.IPLockout.Seconds()),
			LoginAccountLockoutSeconds: int(policy.AccountLockout.Seconds()),
		})
	}
}

// UpdateSecurityConfig persists the login-lockout policy. super_admin only
// (route-gated): a security policy setting.
func UpdateSecurityConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req securityConfigResponse
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if req.LoginMaxAttempts < minLoginMaxAttempts || req.LoginMaxAttempts > maxLoginMaxAttempts {
			writeError(w, http.StatusBadRequest, "login_max_attempts must be between 1 and 20")
			return
		}
		if req.LoginIPLockoutSeconds < minLoginLockoutSeconds || req.LoginIPLockoutSeconds > maxLoginLockoutSeconds {
			writeError(w, http.StatusBadRequest, "login_ip_lockout_seconds must be between 5 and 3600")
			return
		}
		if req.LoginAccountLockoutSeconds < minLoginLockoutSeconds || req.LoginAccountLockoutSeconds > maxLoginLockoutSeconds {
			writeError(w, http.StatusBadRequest, "login_account_lockout_seconds must be between 5 and 3600")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		if _, err := store.pool.Exec(ctx, `
			INSERT INTO config (id, login_max_attempts, login_ip_lockout_seconds, login_account_lockout_seconds)
			VALUES (1, $1, $2, $3)
			ON CONFLICT (id) DO UPDATE SET
				login_max_attempts = EXCLUDED.login_max_attempts,
				login_ip_lockout_seconds = EXCLUDED.login_ip_lockout_seconds,
				login_account_lockout_seconds = EXCLUDED.login_account_lockout_seconds,
				updated_at = now()
		`, req.LoginMaxAttempts, req.LoginIPLockoutSeconds, req.LoginAccountLockoutSeconds); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save login lockout policy")
			return
		}

		logAudit(ctx, store, adminID, "config.update", "config", "", map[string]interface{}{
			"login_max_attempts":            req.LoginMaxAttempts,
			"login_ip_lockout_seconds":      req.LoginIPLockoutSeconds,
			"login_account_lockout_seconds": req.LoginAccountLockoutSeconds,
		})

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}
