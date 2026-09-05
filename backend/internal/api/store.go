package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/db"
	"golang.org/x/crypto/argon2"
)

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func hashPassword(password string) string {
	salt := make([]byte, 16)
	rand.Read(salt)

	hash := argon2.IDKey(
		[]byte(password),
		salt,
		1<<15, 1, 4,
		32,
	)

	return hex.EncodeToString(salt) + ":" + hex.EncodeToString(hash)
}

func verifyPassword(password, hash string) bool {
	parts := strings.Split(hash, ":")
	if len(parts) != 2 {
		return false
	}

	salt, err := hex.DecodeString(parts[0])
	if err != nil {
		return false
	}

	hashBytes, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}

	computedHash := argon2.IDKey(
		[]byte(password),
		salt,
		1<<15, 1, 4,
		uint32(len(hashBytes)),
	)

	return subtleConstantTimeCompare(hashBytes, computedHash)
}

func subtleConstantTimeCompare(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// BootstrapAdmin creates the first super_admin on a fresh database.
// Called once at startup after migrations. If no admin exists at all, it
// inserts one with the credentials from env (ADMIN_EMAIL/ADMIN_PASSWORD)
// or a randomly generated password when unset (printed to logs once).
// Idempotent: never touches an existing admin set.
func BootstrapAdmin(pool *pgxpool.Pool, logf func(format string, a ...interface{})) error {
	ctx := context.Background()
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM admins`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil // admins already exist — never reseed
	}

	email := os.Getenv("ADMIN_EMAIL")
	password := os.Getenv("ADMIN_PASSWORD")
	if email == "" {
		email = "admin@company.com"
	}
	generated := false
	if password == "" {
		password = randomPassword(16)
		generated = true
	}
	if len(password) < 12 {
		password = password + randomPassword(12) // meet the strength rule
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO admins (email, password_hash, role, status)
		VALUES ($1, $2, 'super_admin', 'active')
	`, email, hashPassword(password)); err != nil {
		return err
	}

	if logf != nil {
		if generated {
			logf("==================================================================")
			logf(" First admin auto-created (fresh install).")
			logf("   Email:    %s", email)
			logf("   Password: %s", password)
			logf("   Change it in Profile after login, and enroll 2FA.")
			logf("   (Set ADMIN_EMAIL / ADMIN_PASSWORD to pre-choose credentials.)")
			logf("==================================================================")
		} else {
			logf("First admin auto-created from env: %s (password from ADMIN_PASSWORD)", email)
		}
	}
	return nil
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type verify2FARequest struct {
	Code string `json:"code"`
}

type setup2FARequest struct {
	Code string `json:"code"`
}

type enable2FARequest struct {
	Code string `json:"code"`
}

type adminResponse struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	Role        string    `json:"role"`
	TOTPEnabled bool      `json:"totp_enabled"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}

// Session tokens normally travel only as HttpOnly cookies; the JSON carries
// just the CSRF token. During the localStorage→cookie transition
// (AUTH_ACCEPT_HEADER=1) the raw token is ALSO returned in JSON so an old
// frontend bundle (deployed a minute before the new API during a rolling
// rebuild) can keep authenticating via the legacy Authorization header.
type sessionResponse struct {
	Token     string `json:"token,omitempty"`
	CSRFToken string `json:"csrf_token,omitempty"`
}

type loginResponse struct {
	Token      string         `json:"token,omitempty"`
	CSRFToken  string         `json:"csrf_token,omitempty"`
	Pending2FA bool           `json:"pending_2fa,omitempty"`
	Admin      *adminResponse `json:"admin,omitempty"`
}

func Login(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clientIP := getClientIP(r)
		if loginRateLimiter.isLimited(clientIP) {
			writeError(w, http.StatusTooManyRequests, "Too many login attempts. Please try again later.")
			return
		}

		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()

		var admin db.Admin
		err := store.pool.QueryRow(ctx, `
			SELECT id, email, password_hash, role, totp_enabled, status, failed_login_count, locked_until, last_login_at, created_at, updated_at
			FROM admins
			WHERE email = $1
		`, req.Email).Scan(
			&admin.ID, &admin.Email, &admin.PasswordHash, &admin.Role,
			&admin.TOTPEnabled, &admin.Status, &admin.FailedLoginCount,
			&admin.LockedUntil, &admin.LastLoginAt, &admin.CreatedAt, &admin.UpdatedAt,
		)

		if err != nil {
			writeJSON(w, http.StatusUnauthorized, loginResponse{})
			return
		}

		if admin.Status == "disabled" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}

		if admin.LockedUntil != nil && time.Now().Before(*admin.LockedUntil) {
			writeError(w, http.StatusTooManyRequests, "Account is temporarily locked")
			return
		}

		if !verifyPassword(req.Password, admin.PasswordHash) {
			log.Printf("Password verification failed for admin: %s", admin.Email)
			admin.FailedLoginCount++
			if admin.FailedLoginCount >= 5 {
				lockUntil := time.Now().Add(15 * time.Minute)
				admin.LockedUntil = &lockUntil
				admin.FailedLoginCount = 0
			}
			store.pool.Exec(ctx, `
				UPDATE admins 
				SET failed_login_count = $1, locked_until = $2, updated_at = now()
				WHERE id = $3
			`, admin.FailedLoginCount, admin.LockedUntil, admin.ID)

			writeJSON(w, http.StatusUnauthorized, loginResponse{})
			return
		}

		admin.FailedLoginCount = 0
		admin.LockedUntil = nil
		now := time.Now()
		admin.LastLoginAt = &now
		store.pool.Exec(ctx, `
			UPDATE admins 
			SET failed_login_count = 0, locked_until = NULL, last_login_at = $1, updated_at = now()
			WHERE id = $2
		`, now, admin.ID)

		resp := loginResponse{
			Admin: &adminResponse{
				ID:          admin.ID,
				Email:       admin.Email,
				Role:        admin.Role,
				TOTPEnabled: admin.TOTPEnabled,
				Status:      admin.Status,
				CreatedAt:   admin.CreatedAt,
			},
		}

		if admin.TOTPEnabled {
			token, err := generateToken()
			if err != nil {
				log.Printf("Failed to generate 2FA token: %v", err)
				writeError(w, http.StatusInternalServerError, "Failed to generate token")
				return
			}

			// The pending token is persisted as a short-lived session row so
			// Verify2FA can resolve it back to this admin. It is NOT yet a
			// usable session: Verify2FA checks TOTP and only then swaps it
			// for a full 24h session. Keep it short (10 min) so an
			// abandoned login attempt expires on its own. Transported as an
			// HttpOnly cookie (wgc_pending2fa) — never visible to JS.
			if _, err := createSession(ctx, store, admin.ID, token, r, pending2FALife, false); err != nil {
				log.Printf("Failed to create pending 2FA session: admin_id=%s, err=%v", admin.ID, err)
				writeError(w, http.StatusInternalServerError, "Failed to start 2FA verification")
				return
			}
			setSessionCookie(w, r, pending2FACookieName, token, int(pending2FALife.Seconds()))
			if acceptLegacyHeader() {
				resp.Token = token
			}

			resp.Pending2FA = true
			writeJSON(w, http.StatusOK, resp)
			return
		}

		// Full 24h session. The raw token travels as an HttpOnly cookie; the
		// per-session CSRF token returns in JSON so the SPA can echo it on
		// state-changing requests (the cookie itself is invisible to JS).
		token, err := generateToken()
		if err != nil {
			log.Printf("Failed to generate session token: %v", err)
			writeError(w, http.StatusInternalServerError, "Failed to generate token")
			return
		}

		csrfToken, err := createSession(ctx, store, admin.ID, token, r, sessionLifetime, true)
		if err != nil {
			log.Printf("Failed to create session: admin_id=%s, err=%v", admin.ID, err)
			writeError(w, http.StatusInternalServerError, "Failed to create session")
			return
		}
		setSessionCookie(w, r, sessionCookieName, token, int(sessionLifetime.Seconds()))
		if acceptLegacyHeader() {
			resp.Token = token
		}

		resp.CSRFToken = csrfToken
		writeJSON(w, http.StatusOK, resp)
	}
}

func Verify2FA(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req verify2FARequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		token := readCookieToken(r, pending2FACookieName)
		// Transition: accept the pending token via the legacy header too so
		// an old frontend tab can still finish a 2FA login mid-deploy.
		if token == "" && acceptLegacyHeader() {
			token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
		if token == "" {
			writeError(w, http.StatusUnauthorized, "Missing authorization token")
			return
		}
		pendingHash := hashToken(token)

		ctx := context.Background()

		// Resolve the pending token to its admin. It lives in admin_sessions
		// with a short expiry (see Login). Consume it on ANY terminal outcome
		// (success, wrong code, account disabled) so a pending token can
		// never be replayed or verified twice.
		var admin db.Admin
		err := store.pool.QueryRow(ctx, `
			SELECT id, email, password_hash, role, totp_enabled, status, totp_secret_encrypted
			FROM admins
			WHERE id = (SELECT admin_id FROM admin_sessions WHERE token_hash = $1 AND expires_at > now())
		`, pendingHash).Scan(
			&admin.ID, &admin.Email, &admin.PasswordHash, &admin.Role,
			&admin.TOTPEnabled, &admin.Status, &admin.TOTPSecretEncrypted,
		)

		if err != nil {
			writeError(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}

		if !admin.TOTPEnabled {
			writeError(w, http.StatusBadRequest, "2FA is not enabled for this account")
			return
		}
		if admin.Status != "active" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}

		decryptedSecret, err := auth.DecryptTOTPSecret(ctx, admin.TOTPSecretEncrypted)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to decrypt TOTP secret")
			return
		}

		if !auth.VerifyTOTP(decryptedSecret, req.Code) {
			// Wrong code: keep the pending row so the user can retry with
			// the same login (the login rate limiter guards brute force).
			// The 10-minute expiry still bounds the window.
			writeError(w, http.StatusBadRequest, "Invalid verification code")
			return
		}

		// Code accepted — this pending login attempt is spent; swap it for
		// a real session. Deleting first means a concurrent double-submit
		// can't mint two sessions from one pending token.
		store.pool.Exec(ctx, `DELETE FROM admin_sessions WHERE token_hash = $1`, pendingHash)

		sessionToken, err := generateToken()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to generate token")
			return
		}

		csrfToken, err := createSession(ctx, store, admin.ID, sessionToken, r, sessionLifetime, true)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create session")
			return
		}

		setSessionCookie(w, r, sessionCookieName, sessionToken, int(sessionLifetime.Seconds()))
		clearSessionCookie(w, r, pending2FACookieName)

		resp := sessionResponse{CSRFToken: csrfToken}
		if acceptLegacyHeader() {
			resp.Token = sessionToken
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// Logout revokes the session server-side (delete the row) and clears the
// cookie. Idempotent: with no/expired session it still returns 200 after
// clearing — the UI always lands on a logged-out state.
func Logout(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := readCookieToken(r, sessionCookieName)
		if token == "" && acceptLegacyHeader() {
			token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}

		if token != "" {
			store.pool.Exec(context.Background(), `
				DELETE FROM admin_sessions WHERE token_hash = $1
			`, hashToken(token))
		}

		clearSessionCookie(w, r, sessionCookieName)
		clearSessionCookie(w, r, pending2FACookieName)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// AuthMiddleware authenticates a request from the session cookie (primary)
// or, during the localStorage→cookie transition only, the legacy
// Authorization header (AUTH_ACCEPT_HEADER=1). It resolves the admin, loads
// the session's CSRF token + row id, enforces the idle timeout, and writes
// last_seen_at throttled (at most once a minute per session) so the Active
// Sessions panel shows real activity without hammering the DB per request.
func AuthMiddleware(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := readCookieToken(r, sessionCookieName)
			viaHeader := false
			if token == "" && acceptLegacyHeader() {
				token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
				viaHeader = token != ""
			}
			if token == "" {
				writeError(w, http.StatusUnauthorized, "Missing authorization token")
				return
			}

			ctx := context.Background()

			var (
				adminID   uuid.UUID
				csrfToken string
				sessionID uuid.UUID
				lastSeen  *time.Time
			)
			err := store.pool.QueryRow(ctx, `
				SELECT s.admin_id, s.csrf_token, s.id, s.last_seen_at
				FROM admin_sessions s
				WHERE s.token_hash = $1 AND s.expires_at > now()
			`, hashToken(token)).Scan(&adminID, &csrfToken, &sessionID, &lastSeen)

			if err != nil {
				writeError(w, http.StatusUnauthorized, "Invalid or expired session")
				return
			}

			// Idle timeout: reject sessions that have been inactive for
			// longer than the configured window (default 30 min; 0 disables).
			if timeout := idleTimeout(); timeout > 0 {
				if lastSeen != nil && time.Since(*lastSeen) > timeout {
					// Idle-expired: drop the row so a retry with the same
					// cookie gets a clean 401, and clear the cookie so the
					// browser stops replaying it.
					store.pool.Exec(ctx, `DELETE FROM admin_sessions WHERE id = $1`, sessionID)
					clearSessionCookie(w, r, sessionCookieName)
					writeError(w, http.StatusUnauthorized, "Session timed out due to inactivity")
					return
				}
			}

			// Throttled last_seen_at write (≤1/min). A null last_seen_at
			// (pre-Phase-B rows) always counts as fresh and gets stamped.
			if lastSeen == nil || time.Since(*lastSeen) >= time.Minute {
				store.pool.Exec(ctx, `
					UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1
				`, sessionID)
			}

			ctx = context.WithValue(ctx, adminIDKey{}, adminID)
			ctx = context.WithValue(ctx, csrfTokenKey{}, csrfToken)
			ctx = context.WithValue(ctx, viaHeaderKey{}, viaHeader)
			ctx = context.WithValue(ctx, sessionRowIDKey{}, sessionID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// getSessionRowID returns the acting session's admin_sessions row id.
func getSessionRowID(r *http.Request) uuid.UUID {
	id, _ := r.Context().Value(sessionRowIDKey{}).(uuid.UUID)
	return id
}

// RequireCSRF rejects state-changing requests that do not carry the session's
// CSRF token. It must run AFTER AuthMiddleware (needs the resolved session).
// GET/HEAD/OPTIONS are never state-changing and skip the check; public
// (unauthenticated) routes are not mounted behind this middleware.
//
// A request authenticated via the legacy Authorization header (transition
// only, AUTH_ACCEPT_HEADER=1) skips the check: cross-site attackers cannot
// attach that header to a same-origin fetch, so the cookie auto-attach
// attack CSRF defends against does not apply to the header transport.
// Once the transition ends the header transport disappears and every
// authenticated state-changing request is cookie+CSRF.
func RequireCSRF(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}

			// Transition exemption: header-authed legacy clients.
			if viaHeader, _ := r.Context().Value(viaHeaderKey{}).(bool); viaHeader && acceptLegacyHeader() {
				next.ServeHTTP(w, r)
				return
			}

			csrfToken, _ := r.Context().Value(csrfTokenKey{}).(string)
			if csrfToken == "" {
				writeError(w, http.StatusForbidden, "CSRF validation failed")
				return
			}
			provided := r.Header.Get("X-CSRF-Token")
			if provided == "" || provided != csrfToken {
				writeError(w, http.StatusForbidden, "CSRF validation failed")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func getAdminID(r *http.Request) uuid.UUID {
	adminID, _ := r.Context().Value(adminIDKey{}).(uuid.UUID)
	return adminID
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func parseUUID(s string) (uuid.UUID, error) {
	return uuid.Parse(s)
}

func getClientIP(r *http.Request) string {
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded != "" {
		return strings.Split(forwarded, ",")[0]
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

func logAudit(ctx context.Context, store *Store, adminID uuid.UUID, action, targetType, targetID string, metadata interface{}) {
	metaJSON, _ := json.Marshal(metadata)
	store.pool.Exec(ctx, `
		INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id, metadata, ip_address)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, adminID, action, targetType, targetID, string(metaJSON), nil)
}

type rateLimiter struct {
	mu          sync.Mutex
	attempts    map[string][]time.Time
	window      time.Duration
	maxAttempts int
}

func newRateLimiter(window time.Duration, maxAttempts int) *rateLimiter {
	return &rateLimiter{
		attempts:    make(map[string][]time.Time),
		window:      window,
		maxAttempts: maxAttempts,
	}
}

func (rl *rateLimiter) isLimited(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	var valid []time.Time
	for _, t := range rl.attempts[key] {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}

	rl.attempts[key] = valid

	if len(valid) >= rl.maxAttempts {
		return true
	}

	rl.attempts[key] = append(rl.attempts[key], now)
	return false
}

var loginRateLimiter = newRateLimiter(15*time.Minute, 5)

func Setup2FA(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)

		ctx := context.Background()

		var totpEnabled bool
		store.pool.QueryRow(ctx, `SELECT totp_enabled FROM admins WHERE id = $1`, adminID).Scan(&totpEnabled)

		if totpEnabled {
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

func Enable2FA(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Secret string `json:"secret"`
			Code   string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		adminID := getAdminID(r)
		ctx := context.Background()

		var totpEnabled bool
		store.pool.QueryRow(ctx, `SELECT totp_enabled FROM admins WHERE id = $1`, adminID).Scan(&totpEnabled)

		if totpEnabled {
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

		_, err = store.pool.Exec(ctx, `
			UPDATE admins 
			SET totp_secret_encrypted = $1, totp_enabled = true, backup_codes_hash = $2, updated_at = now()
			WHERE id = $3
		`, encryptedSecret, codesHash, adminID)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to enable 2FA")
			return
		}

		// 2FA enrollment upgrades the account's security posture: retire
		// sessions minted under the weaker policy, keeping only the acting
		// one (which just proved possession of the new secret).
		if err := revokeAdminSessionsExcept(ctx, store, adminID, currentSessionTokenHash(r)); err != nil {
			log.Printf("Failed to revoke other sessions after 2FA enable: admin_id=%s, err=%v", adminID, err)
		}

		logAudit(ctx, store, adminID, "2fa.enable", "admin", adminID.String(), nil)

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"backup_codes": backupCodes,
			"message":      "2FA enabled. Save these backup codes - they can only be shown once.",
		})
	}
}

func RequireRole(store *Store, roles ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			adminID := getAdminID(r)
			ctx := context.Background()

			var role string
			err := store.pool.QueryRow(ctx, `SELECT role FROM admins WHERE id = $1`, adminID).Scan(&role)
			if err != nil {
				writeError(w, http.StatusForbidden, "Access denied")
				return
			}

			for _, allowed := range roles {
				if role == allowed {
					next.ServeHTTP(w, r)
					return
				}
			}

			writeError(w, http.StatusForbidden, "Insufficient permissions")
		})
	}
}
