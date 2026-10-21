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

	// Trusted-link expiry (invite / peer claim links, invited admin
	// temporary credentials). Default 72h, 1h–30 days.
	defaultInviteExpiryHours = 72
	minInviteExpiryHours     = 1
	maxInviteExpiryHours     = 720
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

type invitePolicy struct {
	VPNInvite   time.Duration
	PeerClaim   time.Duration
	AdminInvite time.Duration
}

func defaultInvitePolicy() invitePolicy {
	d := defaultInviteExpiryHours * time.Hour
	return invitePolicy{VPNInvite: d, PeerClaim: d, AdminInvite: d}
}

// loadInvitePolicy reads the trusted-link expiry policy, clamping anything
// outside the supported range back to the default.
func loadInvitePolicy(ctx context.Context, pool *pgxpool.Pool) invitePolicy {
	policy := defaultInvitePolicy()
	var vpnHours, peerHours, adminHours int
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(vpn_invite_expiry_hours, 72),
		       COALESCE(peer_claim_expiry_hours, 72),
		       COALESCE(admin_invite_expiry_hours, 72)
		FROM config WHERE id = 1
	`).Scan(&vpnHours, &peerHours, &adminHours)
	if err != nil {
		return policy
	}
	if vpnHours >= minInviteExpiryHours && vpnHours <= maxInviteExpiryHours {
		policy.VPNInvite = time.Duration(vpnHours) * time.Hour
	}
	if peerHours >= minInviteExpiryHours && peerHours <= maxInviteExpiryHours {
		policy.PeerClaim = time.Duration(peerHours) * time.Hour
	}
	if adminHours >= minInviteExpiryHours && adminHours <= maxInviteExpiryHours {
		policy.AdminInvite = time.Duration(adminHours) * time.Hour
	}
	return policy
}

type securityConfigResponse struct {
	LoginMaxAttempts           int `json:"login_max_attempts"`
	LoginIPLockoutSeconds      int `json:"login_ip_lockout_seconds"`
	LoginAccountLockoutSeconds int `json:"login_account_lockout_seconds"`
	VPNInviteExpiryHours       int `json:"vpn_invite_expiry_hours"`
	PeerClaimExpiryHours       int `json:"peer_claim_expiry_hours"`
	AdminInviteExpiryHours     int `json:"admin_invite_expiry_hours"`
	// Code authorizes the change (write paths only); never returned.
	Code string `json:"code,omitempty"`
}

// GetSecurityConfig returns the current login-lockout policy. Readable by any
// signed-in admin so the Security tab can show the active policy.
func GetSecurityConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		policy := loadLoginPolicy(ctx, store.pool)
		invites := loadInvitePolicy(ctx, store.pool)
		writeJSON(w, http.StatusOK, securityConfigResponse{
			LoginMaxAttempts:           policy.MaxAttempts,
			LoginIPLockoutSeconds:      int(policy.IPLockout.Seconds()),
			LoginAccountLockoutSeconds: int(policy.AccountLockout.Seconds()),
			VPNInviteExpiryHours:       int(invites.VPNInvite.Hours()),
			PeerClaimExpiryHours:       int(invites.PeerClaim.Hours()),
			AdminInviteExpiryHours:     int(invites.AdminInvite.Hours()),
		})
	}
}

// UpdateSecurityConfig persists the security policy. super_admin only
// (route-gated) and strict 2FA: the acting admin must enter a fresh
// authenticator code even when a step-up grace window is configured.
func UpdateSecurityConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req securityConfigResponse
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)
		if !verifyActor2FACode(w, r, ctx, store, adminID, req.Code) {
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
		if req.VPNInviteExpiryHours < minInviteExpiryHours || req.VPNInviteExpiryHours > maxInviteExpiryHours {
			writeError(w, http.StatusBadRequest, "vpn_invite_expiry_hours must be between 1 and 720")
			return
		}
		if req.PeerClaimExpiryHours < minInviteExpiryHours || req.PeerClaimExpiryHours > maxInviteExpiryHours {
			writeError(w, http.StatusBadRequest, "peer_claim_expiry_hours must be between 1 and 720")
			return
		}
		if req.AdminInviteExpiryHours < minInviteExpiryHours || req.AdminInviteExpiryHours > maxInviteExpiryHours {
			writeError(w, http.StatusBadRequest, "admin_invite_expiry_hours must be between 1 and 720")
			return
		}

		if _, err := store.pool.Exec(ctx, `
			INSERT INTO config (id, login_max_attempts, login_ip_lockout_seconds,
			                   login_account_lockout_seconds, vpn_invite_expiry_hours,
			                   peer_claim_expiry_hours, admin_invite_expiry_hours)
			VALUES (1, $1, $2, $3, $4, $5, $6)
			ON CONFLICT (id) DO UPDATE SET
				login_max_attempts = EXCLUDED.login_max_attempts,
				login_ip_lockout_seconds = EXCLUDED.login_ip_lockout_seconds,
				login_account_lockout_seconds = EXCLUDED.login_account_lockout_seconds,
				vpn_invite_expiry_hours = EXCLUDED.vpn_invite_expiry_hours,
				peer_claim_expiry_hours = EXCLUDED.peer_claim_expiry_hours,
				admin_invite_expiry_hours = EXCLUDED.admin_invite_expiry_hours,
				updated_at = now()
		`, req.LoginMaxAttempts, req.LoginIPLockoutSeconds, req.LoginAccountLockoutSeconds,
			req.VPNInviteExpiryHours, req.PeerClaimExpiryHours, req.AdminInviteExpiryHours); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save security policy")
			return
		}

		logAudit(ctx, store, adminID, "config.update", "config", "", map[string]interface{}{
			"login_max_attempts":            req.LoginMaxAttempts,
			"login_ip_lockout_seconds":      req.LoginIPLockoutSeconds,
			"login_account_lockout_seconds": req.LoginAccountLockoutSeconds,
			"vpn_invite_expiry_hours":       req.VPNInviteExpiryHours,
			"peer_claim_expiry_hours":       req.PeerClaimExpiryHours,
			"admin_invite_expiry_hours":     req.AdminInviteExpiryHours,
		})

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}
