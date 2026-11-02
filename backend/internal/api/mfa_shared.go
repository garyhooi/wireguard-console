package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	authwebauthn "github.com/wireguard-console/backend/internal/auth/webauthn"
)

// MFA core: factor discovery, mandatory-enrollment policy, pending-login state,
// the single session-minting chokepoint, attempt accounting and recovery codes.
//
// Login never mints a session directly: it creates a pending row
// (pending_kind = verify|enroll) and only a handler that proves a factor may
// call finishMFALogin. Keeping that in one place is what makes "password alone
// is never enough" true by construction.

const (
	// New canonical pending cookie; the legacy name is still read for one
	// release so an open tab that redirected during the upgrade can finish.
	mfaPendingCookieName    = "wgc_mfa_pending"
	legacyPendingCookieName = "wgc_pending2fa"
	mfaPendingLife          = 10 * time.Minute
	// Passwordless passkey ceremonies have no pending row (the account is only
	// resolved from the assertion's user handle), so a short-lived cookie binds
	// begin/finish to this browser.
	passkeyLoginCookieName = "wgc_passkey_login"
	passkeyLoginLife       = 5 * time.Minute
	mfaMaxAttempts         = 5
	pendingKindVerify      = "verify"
	pendingKindEnroll      = "enroll"
	mfaMethodPasskey       = "passkey"
	mfaMethodTOTP          = "totp"
	mfaMethodRecoveryCode  = "recovery_code"
	recoveryCodeAlphabet   = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	recoveryCodeLength     = 12
	recoveryCodeCount      = 10
	recoveryCodeHashPrefix = "v2:"
	defaultMFAPolicy       = "any"
)

// MFA policy values stored in config.mfa_require_methods.
const (
	mfaPolicyAny     = "any"
	mfaPolicyTOTP    = "totp"
	mfaPolicyPasskey = "passkey"
	mfaPolicyBoth    = "both"
)

var (
	errNoPendingMFA     = errors.New("missing or expired MFA session")
	errWrongPendingKind = errors.New("wrong pending MFA state")
)

// mfaFactors is the factor inventory used for login decisions and the UI.
type mfaFactors struct {
	TOTPEnabled       bool
	PasskeyCount      int
	RecoveryCodeCount int
}

func (f mfaFactors) Enrolled() bool { return f.TOTPEnabled || f.PasskeyCount > 0 }

// methods lists the factors that are both enrolled and usable in this
// deployment, in display order.
func (f mfaFactors) methods(passkeyAvailable bool) []string {
	methods := []string{}
	if passkeyAvailable && f.PasskeyCount > 0 {
		methods = append(methods, mfaMethodPasskey)
	}
	if f.TOTPEnabled {
		methods = append(methods, mfaMethodTOTP)
	}
	if f.RecoveryCodeCount > 0 {
		methods = append(methods, mfaMethodRecoveryCode)
	}
	return methods
}

// mfaCapability is the deployment/product capability block returned to the SPA.
type mfaCapability struct {
	PasskeyAvailable bool   `json:"passkey_available"`
	PasskeyReason    string `json:"passkey_reason,omitempty"`
	RPID             string `json:"rp_id,omitempty"`
	RequireMethods   string `json:"require_methods"`
}

// mfaSummary is the compact admin-facing factor summary.
type mfaSummary struct {
	Enabled                bool     `json:"mfa_enabled"`
	Methods                []string `json:"mfa_methods"`
	PasskeyCount           int      `json:"passkey_count"`
	RecoveryCodesRemaining int      `json:"recovery_codes_remaining"`
	PasskeyAvailable       bool     `json:"passkey_available"`
}

// mfaStateResponse drives GET /api/auth/mfa/state (pending-cookie login page).
type mfaStateResponse struct {
	PendingKind      string   `json:"pending_kind"`
	MFAMethods       []string `json:"mfa_methods,omitempty"`
	SetupMethods     []string `json:"setup_methods,omitempty"`
	PasskeyAvailable bool     `json:"passkey_available"`
	PasskeyReason    string   `json:"passkey_reason,omitempty"`
	RPID             string   `json:"rp_id,omitempty"`
	PasskeyCount     int      `json:"passkey_count"`
	RecoveryCodes    int      `json:"recovery_codes_remaining"`
	ExpiresInSeconds int      `json:"expires_in_seconds"`
	RequireMethods   string   `json:"require_methods"`
	MFARequired      bool     `json:"mfa_required"`
}

// loadMFAFactors reads an admin's usable factor inventory. Passkeys registered
// under a different RP ID (e.g. after a console-domain change) are excluded:
// they cannot complete a ceremony for the current RP ID.
func loadMFAFactors(ctx context.Context, store *Store, adminID uuid.UUID) (mfaFactors, error) {
	var f mfaFactors
	var codes []string

	svc := authwebauthn.Current()
	if svc.Available() {
		err := store.pool.QueryRow(ctx, `
			SELECT a.totp_enabled,
			       COALESCE(a.backup_codes_hash, '{}'::text[]),
			       (SELECT count(*) FROM webauthn_credentials c
			         WHERE c.admin_id = a.id AND c.rp_id = $2)
			FROM admins a WHERE a.id = $1
		`, adminID, svc.RPID).Scan(&f.TOTPEnabled, &codes, &f.PasskeyCount)
		if err != nil {
			return f, err
		}
	} else {
		err := store.pool.QueryRow(ctx, `
			SELECT totp_enabled, COALESCE(backup_codes_hash, '{}'::text[])
			FROM admins WHERE id = $1
		`, adminID).Scan(&f.TOTPEnabled, &codes)
		if err != nil {
			return f, err
		}
	}
	f.RecoveryCodeCount = len(codes)
	return f, nil
}

// loadMFAPolicy returns the organisation factor policy. A policy that requires
// passkeys is degraded to "any" on deployments where passkeys are impossible
// (IP-only consoles): a stored policy must never make login impossible.
func loadMFAPolicy(ctx context.Context, store *Store) string {
	policy := defaultMFAPolicy
	var raw string
	if err := store.pool.QueryRow(ctx, `SELECT COALESCE(mfa_require_methods, 'any') FROM config WHERE id = 1`).Scan(&raw); err == nil {
		policy = strings.ToLower(strings.TrimSpace(raw))
	}
	switch policy {
	case mfaPolicyAny, mfaPolicyTOTP, mfaPolicyPasskey, mfaPolicyBoth:
	default:
		policy = defaultMFAPolicy
	}
	if (policy == mfaPolicyPasskey || policy == mfaPolicyBoth) && !authwebauthn.Current().Available() {
		return defaultMFAPolicy
	}
	return policy
}

// policySatisfied reports whether the factor inventory meets the policy.
func policySatisfied(policy string, f mfaFactors, passkeyAvailable bool) bool {
	switch policy {
	case mfaPolicyTOTP:
		return f.TOTPEnabled
	case mfaPolicyPasskey:
		return passkeyAvailable && f.PasskeyCount > 0
	case mfaPolicyBoth:
		return passkeyAvailable && f.TOTPEnabled && f.PasskeyCount > 0
	default:
		return f.Enrolled() && (f.TOTPEnabled || (passkeyAvailable && f.PasskeyCount > 0))
	}
}

// missingMethodsForPolicy lists the factors still required for enrollment.
func missingMethodsForPolicy(policy string, f mfaFactors, passkeyAvailable bool) []string {
	missing := []string{}
	switch policy {
	case mfaPolicyTOTP:
		if !f.TOTPEnabled {
			missing = append(missing, mfaMethodTOTP)
		}
	case mfaPolicyPasskey:
		if passkeyAvailable && f.PasskeyCount == 0 {
			missing = append(missing, mfaMethodPasskey)
		}
	case mfaPolicyBoth:
		if !f.TOTPEnabled {
			missing = append(missing, mfaMethodTOTP)
		}
		if passkeyAvailable && f.PasskeyCount == 0 {
			missing = append(missing, mfaMethodPasskey)
		}
	default:
		if !f.TOTPEnabled && f.PasskeyCount == 0 {
			missing = append(missing, mfaMethodTOTP)
			if passkeyAvailable {
				missing = append(missing, mfaMethodPasskey)
			}
		}
	}
	return missing
}

// currentMFACapability builds the capability block.
func currentMFACapability(ctx context.Context, store *Store) mfaCapability {
	svc := authwebauthn.Current()
	return mfaCapability{
		PasskeyAvailable: svc.Available(),
		PasskeyReason:    svc.Reason,
		RPID:             svc.RPID,
		RequireMethods:   loadMFAPolicy(ctx, store),
	}
}

// loadMFASummary builds the compact factor summary embedded in admin payloads.
func loadMFASummary(ctx context.Context, store *Store, adminID uuid.UUID) (mfaSummary, error) {
	f, err := loadMFAFactors(ctx, store, adminID)
	if err != nil {
		return mfaSummary{}, err
	}
	svc := authwebauthn.Current()
	return mfaSummary{
		Enabled:                f.Enrolled() && (f.TOTPEnabled || (svc.Available() && f.PasskeyCount > 0)),
		Methods:                f.methods(svc.Available()),
		PasskeyCount:           f.PasskeyCount,
		RecoveryCodesRemaining: f.RecoveryCodeCount,
		PasskeyAvailable:       svc.Available(),
	}, nil
}

// ---- pending login state -------------------------------------------------

// createPendingMFASession persists a short-lived pending login row and returns
// the raw cookie token plus its hash.
func createPendingMFASession(ctx context.Context, store *Store, adminID uuid.UUID, r *http.Request, kind string) (string, string, error) {
	raw, err := generateToken()
	if err != nil {
		return "", "", err
	}
	hash := hashToken(raw)
	expiresAt := time.Now().Add(mfaPendingLife)
	_, err = store.pool.Exec(ctx, `
		INSERT INTO admin_sessions (admin_id, token_hash, ip_address, user_agent, expires_at, pending_kind)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, adminID, hash, getClientIP(r), r.UserAgent(), expiresAt, kind)
	if err != nil {
		return "", "", err
	}
	return raw, hash, nil
}

func readPendingMFAToken(r *http.Request) string {
	if token := readCookieToken(r, mfaPendingCookieName); token != "" {
		return token
	}
	return readCookieToken(r, legacyPendingCookieName)
}

func setPendingMFACookie(w http.ResponseWriter, r *http.Request, raw string) {
	setSessionCookie(w, r, mfaPendingCookieName, raw, int(mfaPendingLife.Seconds()))
}

func clearPendingMFACookies(w http.ResponseWriter, r *http.Request) {
	clearSessionCookie(w, r, mfaPendingCookieName)
	clearSessionCookie(w, r, legacyPendingCookieName)
}

// Passwordless passkey ceremonies: the begin response sets this cookie and the
// finish request must present it, so a leaked challenge id alone cannot
// complete an assertion in another browser.
func setPasskeyLoginCookie(w http.ResponseWriter, r *http.Request, raw string) {
	setSessionCookie(w, r, passkeyLoginCookieName, raw, int(passkeyLoginLife.Seconds()))
}

func readPasskeyLoginToken(r *http.Request) string {
	return readCookieToken(r, passkeyLoginCookieName)
}

func clearPasskeyLoginCookie(w http.ResponseWriter, r *http.Request) {
	clearSessionCookie(w, r, passkeyLoginCookieName)
}

// resolvePendingMFA maps the pending cookie to its admin. wantKind may be
// empty ("any pending state") or verify/enroll to require an exact state.
func resolvePendingMFA(ctx context.Context, store *Store, r *http.Request, wantKind string) (uuid.UUID, string, time.Time, string, error) {
	token := readPendingMFAToken(r)
	if token == "" {
		return uuid.Nil, "", time.Time{}, "", errNoPendingMFA
	}
	hash := hashToken(token)

	var (
		adminID   uuid.UUID
		kind      string
		expiresAt time.Time
	)
	err := store.pool.QueryRow(ctx, `
		SELECT admin_id, pending_kind, expires_at
		FROM admin_sessions
		WHERE token_hash = $1 AND expires_at > now() AND pending_kind IS NOT NULL
	`, hash).Scan(&adminID, &kind, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, "", time.Time{}, "", errNoPendingMFA
	}
	if err != nil {
		return uuid.Nil, "", time.Time{}, "", err
	}
	if wantKind != "" && kind != wantKind {
		return uuid.Nil, "", time.Time{}, kind, errWrongPendingKind
	}
	return adminID, hash, expiresAt, kind, nil
}

// buildMFAState assembles the pending-login state response.
func buildMFAState(ctx context.Context, store *Store, adminID uuid.UUID, kind string, expiresAt time.Time) (mfaStateResponse, error) {
	f, err := loadMFAFactors(ctx, store, adminID)
	if err != nil {
		return mfaStateResponse{}, err
	}
	svc := authwebauthn.Current()
	policy := loadMFAPolicy(ctx, store)
	remaining := int(math.Ceil(time.Until(expiresAt).Seconds()))
	if remaining < 0 {
		remaining = 0
	}
	resp := mfaStateResponse{
		PendingKind:      kind,
		SetupMethods:     missingMethodsForPolicy(policy, f, svc.Available()),
		PasskeyAvailable: svc.Available(),
		PasskeyReason:    svc.Reason,
		RPID:             svc.RPID,
		PasskeyCount:     f.PasskeyCount,
		RecoveryCodes:    f.RecoveryCodeCount,
		ExpiresInSeconds: remaining,
		RequireMethods:   policy,
		MFARequired:      true,
	}
	if kind == pendingKindVerify {
		resp.MFAMethods = f.methods(svc.Available())
	}
	return resp, nil
}

// ---- session minting chokepoint ------------------------------------------

// finishMFALogin consumes the pending row and mints the full session. Every
// factor path (TOTP, passkey, recovery code, forced enrollment) ends here.
func finishMFALogin(ctx context.Context, store *Store, w http.ResponseWriter, r *http.Request, adminID uuid.UUID, pendingHash, method string) (string, error) {
	tag, err := store.pool.Exec(ctx, `
		DELETE FROM admin_sessions WHERE token_hash = $1 AND pending_kind IS NOT NULL
	`, pendingHash)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		return "", errNoPendingMFA
	}

	clearPendingMFACookies(w, r)

	// Pending-bound ceremonies are spent with the login.
	_, _ = store.pool.Exec(ctx, `
		DELETE FROM webauthn_challenges WHERE admin_id = $1 AND purpose IN ('login','enroll')
	`, adminID)

	return mintLoginSession(ctx, store, w, r, adminID, "mfa.login_"+method, map[string]interface{}{
		"method": method,
	})
}

// mintLoginSession is the ONE place that turns a completed authentication into
// a real session. Callers must already have proven a factor (MFA challenge,
// completed enrollment, or a passwordless passkey assertion in this browser).
func mintLoginSession(ctx context.Context, store *Store, w http.ResponseWriter, r *http.Request, adminID uuid.UUID, auditAction string, metadata map[string]interface{}) (string, error) {
	token, err := generateToken()
	if err != nil {
		return "", err
	}
	csrfToken, err := createSession(ctx, store, adminID, token, r, sessionLifetime, true)
	if err != nil {
		return "", err
	}
	setSessionCookie(w, r, sessionCookieName, token, int(sessionLifetime.Seconds()))
	clearPendingMFACookies(w, r)
	clearPasskeyLoginCookie(w, r)

	// A completed login resets the password-failure brake for this IP.
	ipLoginLockout.reset(getClientIP(r))

	logAudit(ctx, store, adminID, auditAction, "admin", adminID.String(), metadata)
	return csrfToken, nil
}

// recordMFAFailure bumps the per-pending attempt counter, applies the shared
// IP/account lockout policy and invalidates the pending row after too many
// wrong factors. Returns the retry delay in seconds when the caller should
// answer 429.
func recordMFAFailure(ctx context.Context, store *Store, r *http.Request, pendingHash string) (int, int, error) {
	var attempts int
	err := store.pool.QueryRow(ctx, `
		UPDATE admin_sessions SET mfa_attempts = mfa_attempts + 1
		WHERE token_hash = $1 AND pending_kind IS NOT NULL
		RETURNING mfa_attempts
	`, pendingHash).Scan(&attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, errNoPendingMFA
	}
	if err != nil {
		return 0, 0, err
	}

	policy := loadLoginPolicy(ctx, store.pool)
	locked := ipLoginLockout.recordFailure(getClientIP(r), time.Now(), policy.MaxAttempts, policy.IPLockout)
	retryAfter := int(math.Ceil(locked.Seconds()))

	if attempts >= mfaMaxAttempts {
		_, _ = store.pool.Exec(ctx, `DELETE FROM admin_sessions WHERE token_hash = $1`, pendingHash)
		if retryAfter < 60 {
			retryAfter = 60
		}
	}
	return attempts, retryAfter, nil
}

// ---- error helpers -------------------------------------------------------

// writeMFAError writes the standard error envelope plus a machine-readable code
// so the SPA can branch on "code" instead of matching message substrings.
func writeMFAError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}

func writeMFAErrorLocked(w http.ResponseWriter, code, message string, retryAfter int) {
	writeJSON(w, http.StatusTooManyRequests, map[string]interface{}{
		"error":               message,
		"code":                code,
		"retry_after_seconds": retryAfter,
	})
}

// ---- recovery codes ------------------------------------------------------

func normalizeRecoveryCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// generateRecoveryCode returns a 12-char code (60 bits) from an unambiguous
// alphabet. The SPA renders it grouped (XXXX-XXXX-XXXX); storage uses the
// normalized form.
func generateRecoveryCode() (string, error) {
	buf := make([]byte, recoveryCodeLength)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, recoveryCodeLength)
	for i, b := range buf {
		out[i] = recoveryCodeAlphabet[int(b)%len(recoveryCodeAlphabet)]
	}
	return string(out), nil
}

func recoveryCodeHash(adminID uuid.UUID, code string) string {
	sum := sha256.Sum256(append(adminID[:], []byte(normalizeRecoveryCode(code))...))
	return recoveryCodeHashPrefix + hex.EncodeToString(sum[:])
}

// legacyRecoveryCodeHash reproduces the pre-MFA scheme (bare sha256 of the
// 8-char lowercase hex code) so already-issued codes keep working once.
func legacyRecoveryCodeHash(code string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(normalizeRecoveryCode(code))))
	return hex.EncodeToString(sum[:])
}

func ensureRecoveryCodes(ctx context.Context, store *Store, adminID uuid.UUID) ([]string, bool, error) {
	var existing []string
	if err := store.pool.QueryRow(ctx, `SELECT COALESCE(backup_codes_hash, '{}'::text[]) FROM admins WHERE id = $1`, adminID).Scan(&existing); err != nil {
		return nil, false, err
	}
	if len(existing) > 0 {
		return nil, false, nil
	}

	codes := make([]string, recoveryCodeCount)
	hashes := make([]string, recoveryCodeCount)
	for i := 0; i < recoveryCodeCount; i++ {
		code, err := generateRecoveryCode()
		if err != nil {
			return nil, false, err
		}
		codes[i] = code
		hashes[i] = recoveryCodeHash(adminID, code)
	}

	tag, err := store.pool.Exec(ctx, `
		UPDATE admins SET backup_codes_hash = $1, updated_at = now()
		WHERE id = $2 AND (backup_codes_hash IS NULL OR array_length(backup_codes_hash, 1) IS NULL)
	`, hashes, adminID)
	if err != nil {
		return nil, false, err
	}
	if tag.RowsAffected() == 0 {
		return nil, false, nil
	}
	return codes, true, nil
}

// consumeRecoveryCode verifies and atomically removes one recovery code.
func consumeRecoveryCode(ctx context.Context, store *Store, adminID uuid.UUID, code string) (bool, error) {
	normalized := normalizeRecoveryCode(code)
	if normalized == "" {
		return false, nil
	}
	var hashes []string
	if err := store.pool.QueryRow(ctx, `SELECT COALESCE(backup_codes_hash, '{}'::text[]) FROM admins WHERE id = $1`, adminID).Scan(&hashes); err != nil {
		return false, err
	}

	salted := recoveryCodeHash(adminID, normalized)
	legacy := legacyRecoveryCodeHash(normalized)
	var match string
	for _, stored := range hashes {
		if constantTimeStringEqual(stored, salted) || constantTimeStringEqual(stored, legacy) {
			match = stored
			break
		}
	}
	if match == "" {
		return false, nil
	}

	tag, err := store.pool.Exec(ctx, `
		UPDATE admins SET backup_codes_hash = array_remove(backup_codes_hash, $1), updated_at = now()
		WHERE id = $2 AND $1 = ANY(backup_codes_hash)
	`, match, adminID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// constantTimeStringEqual avoids handing timing side channels to code checks.
func constantTimeStringEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
