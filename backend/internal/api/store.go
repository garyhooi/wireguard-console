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
	authwebauthn "github.com/wireguard-console/backend/internal/auth/webauthn"
	"github.com/wireguard-console/backend/internal/authz"
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
			logf("   Change it in Profile after login, and enroll an MFA factor.")
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

// loginAdminResponse is the compact admin block returned by the password
// step. It deliberately carries no session material: a correct password never
// mints a session on its own.
type loginAdminResponse struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	Role        string    `json:"role"`
	MFAEnabled  bool      `json:"mfa_enabled"`
	TOTPEnabled bool      `json:"totp_enabled"`
	CreatedAt   time.Time `json:"created_at"`
}

// loginResponse is the password step's only output: a pending-MFA state.
// pending_mfa means the admin must prove an enrolled factor; pending_mfa_setup
// means the factor policy is unsatisfied and enrollment must complete first.
// A session (and its CSRF token) is only minted by finishMFALogin.
type loginResponse struct {
	PendingMFA             bool                `json:"pending_mfa,omitempty"`
	PendingMFASetup        bool                `json:"pending_mfa_setup,omitempty"`
	MFAMethods             []string            `json:"mfa_methods,omitempty"`
	SetupMethods           []string            `json:"setup_methods,omitempty"`
	PasskeyAvailable       bool                `json:"passkey_available"`
	PasskeyCount           int                 `json:"passkey_count"`
	RecoveryCodesRemaining int                 `json:"recovery_codes_remaining"`
	RequireMethods         string              `json:"require_methods"`
	Admin                  *loginAdminResponse `json:"admin,omitempty"`
}

func Login(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clientIP := getClientIP(r)
		// The only brute-force gate is the per-IP lockout: 3 wrong passwords
		// lock that IP for 60s. (An older in-memory 5-attempts/15-minutes
		// limiter used to sit here too; it counted successful logins, could
		// not be reset, and reported a misleading 60s — removed.)
		if remaining := ipLoginLockout.remaining(clientIP, time.Now()); remaining > 0 {
			respondLocked(w, lockoutSeconds(remaining))
			return
		}

		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()

		// Configured lockout policy (Configuration → Security); defaults are
		// 3 attempts / 60s IP window / 60s account window.
		policy := loadLoginPolicy(ctx, store.pool)

		var admin db.Admin
		err := store.pool.QueryRow(ctx, `
			SELECT id, email, password_hash, role, totp_enabled, status, failed_login_count, locked_until, last_login_at, invite_expires_at, created_at, updated_at
			FROM admins
			WHERE email = $1
		`, req.Email).Scan(
			&admin.ID, &admin.Email, &admin.PasswordHash, &admin.Role,
			&admin.TOTPEnabled, &admin.Status, &admin.FailedLoginCount,
			&admin.LockedUntil, &admin.LastLoginAt, &admin.InviteExpiresAt, &admin.CreatedAt, &admin.UpdatedAt,
		)

		if err != nil {
			// Unknown email is a failed credential attempt too (same timing /
			// lockout semantics as a wrong password).
			if locked := ipLoginLockout.recordFailure(clientIP, time.Now(), policy.MaxAttempts, policy.IPLockout); locked > 0 {
				respondLocked(w, lockoutSeconds(locked))
				return
			}
			writeJSON(w, http.StatusUnauthorized, loginResponse{})
			return
		}

		if admin.Status == "disabled" {
			writeError(w, http.StatusForbidden, "Account is disabled")
			return
		}

		// Account-level lockout: 3 wrong passwords lock the ACCOUNT for 60s as
		// well as the IP, so changing network does not bypass the brake. It is
		// intentionally short (60s) — unlike the old 15-minute account lock.
		if admin.LockedUntil != nil {
			if remaining := time.Until(*admin.LockedUntil); remaining > 0 {
				respondLocked(w, lockoutSeconds(remaining))
				return
			}
			// Expired lock (e.g. legacy DB row): clear it lazily.
			store.pool.Exec(ctx, `
				UPDATE admins SET failed_login_count = 0, locked_until = NULL WHERE id = $1
			`, admin.ID)
			admin.FailedLoginCount = 0
			admin.LockedUntil = nil
		}

		if !verifyPassword(req.Password, admin.PasswordHash) {
			log.Printf("Password verification failed for admin: %s", admin.Email)

			// The configured number of wrong passwords locks BOTH the IP
			// (fresh guesses) and the account (guesses hopping between IPs).
			admin.FailedLoginCount++
			var accountLock time.Duration
			if admin.FailedLoginCount >= policy.MaxAttempts {
				until := time.Now().Add(policy.AccountLockout)
				admin.LockedUntil = &until
				admin.FailedLoginCount = 0
				accountLock = policy.AccountLockout
			}
			store.pool.Exec(ctx, `
				UPDATE admins SET failed_login_count = $1, locked_until = $2, updated_at = now() WHERE id = $3
			`, admin.FailedLoginCount, admin.LockedUntil, admin.ID)

			ipLock := ipLoginLockout.recordFailure(clientIP, time.Now(), policy.MaxAttempts, policy.IPLockout)
			if accountLock > 0 || ipLock > 0 {
				locked := accountLock
				if ipLock > locked {
					locked = ipLock
				}
				respondLocked(w, lockoutSeconds(locked))
				return
			}
			writeJSON(w, http.StatusUnauthorized, loginResponse{})
			return
		}

		// Successful credentials clear this IP's wrong-password counter.
		ipLoginLockout.reset(clientIP)

		// An invited admin's temporary credentials expire after the window
		// configured in Configuration → Security.
		if admin.InviteExpiresAt != nil && time.Now().After(*admin.InviteExpiresAt) {
			writeError(w, http.StatusForbidden, "This admin invitation has expired — ask a super admin to resend your credentials")
			return
		}

		admin.FailedLoginCount = 0
		admin.LockedUntil = nil
		admin.InviteExpiresAt = nil // invitation accepted
		now := time.Now()
		admin.LastLoginAt = &now
		store.pool.Exec(ctx, `
			UPDATE admins 
			SET failed_login_count = 0, locked_until = NULL, invite_expires_at = NULL, last_login_at = $1, updated_at = now()
			WHERE id = $2
		`, now, admin.ID)

		// Password accepted — but this is NOT a login. The password step only
		// records a short-lived pending state; a proven factor (or completed
		// mandatory enrollment) is the single path to a session, through
		// finishMFALogin (see mfa_shared.go). This is what keeps "password
		// alone is never enough" true by construction.
		factors, err := loadMFAFactors(ctx, store, admin.ID)
		if err != nil {
			log.Printf("Failed to load MFA factors: admin_id=%s, err=%v", admin.ID, err)
			writeError(w, http.StatusInternalServerError, "Failed to load MFA state")
			return
		}
		requireMethods := loadMFAPolicy(ctx, store)
		svc := authwebauthn.Current()

		kind := pendingKindVerify
		if !policySatisfied(requireMethods, factors, svc.Available()) {
			kind = pendingKindEnroll
		}

		rawToken, _, err := createPendingMFASession(ctx, store, admin.ID, r, kind)
		if err != nil {
			log.Printf("Failed to create pending MFA session: admin_id=%s, err=%v", admin.ID, err)
			writeError(w, http.StatusInternalServerError, "Failed to start MFA verification")
			return
		}
		setPendingMFACookie(w, r, rawToken)

		resp := loginResponse{
			PasskeyAvailable:       svc.Available(),
			PasskeyCount:           factors.PasskeyCount,
			RecoveryCodesRemaining: factors.RecoveryCodeCount,
			RequireMethods:         requireMethods,
			Admin: &loginAdminResponse{
				ID:          admin.ID,
				Email:       admin.Email,
				Role:        admin.Role,
				MFAEnabled:  factors.Enrolled(),
				TOTPEnabled: factors.TOTPEnabled,
				CreatedAt:   admin.CreatedAt,
			},
		}
		if kind == pendingKindEnroll {
			resp.PendingMFASetup = true
			resp.SetupMethods = missingMethodsForPolicy(requireMethods, factors, svc.Available())
		} else {
			resp.PendingMFA = true
			resp.MFAMethods = factors.methods(svc.Available())
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// Logout revokes the session server-side (delete the row) and clears the
// cookie. Idempotent: with no/expired session it still returns 200 after
// clearing — the UI always lands on a logged-out state.
func Logout(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		if token := readCookieToken(r, sessionCookieName); token != "" {
			store.pool.Exec(ctx, `
				DELETE FROM admin_sessions WHERE token_hash = $1
			`, hashToken(token))
		}

		// Signing out also abandons any half-finished MFA login bound to this
		// browser, so a shared machine cannot leave a resolvable pending row.
		if token := readPendingMFAToken(r); token != "" {
			store.pool.Exec(ctx, `
				DELETE FROM admin_sessions WHERE token_hash = $1 AND pending_kind IS NOT NULL
			`, hashToken(token))
		}

		clearSessionCookie(w, r, sessionCookieName)
		clearPendingMFACookies(w, r)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// AuthMiddleware authenticates a request from the HttpOnly session cookie.
// It resolves the admin, loads the session's CSRF token + row id, enforces
// the idle timeout, and writes last_seen_at throttled (at most once a minute
// per session) so the Active Sessions panel shows real activity without
// hammering the DB per request.
//
// The query is also the pending-login hard gate: a row without a CSRF token or
// with a pending_kind belongs to a half-finished MFA login and is NOT a
// session. Requiring both conditions to be NULL means a pending cookie can
// never reach a protected handler, whatever else changes.
func AuthMiddleware(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := readCookieToken(r, sessionCookieName)
			if token == "" {
				writeError(w, http.StatusUnauthorized, "Missing authorization token")
				return
			}

			ctx := context.Background()

			var (
				adminID     uuid.UUID
				csrfToken   string
				sessionID   uuid.UUID
				lastSeen    *time.Time
				role        string
				roleName    string
				permissions []string
			)
			err := store.pool.QueryRow(ctx, `
				SELECT s.admin_id, s.csrf_token, s.id, s.last_seen_at,
				       a.role, COALESCE(r.name, a.role),
				       COALESCE(r.permissions, ARRAY[]::text[])
				FROM admin_sessions s
				JOIN admins a ON a.id = s.admin_id
				LEFT JOIN admin_roles r ON r.slug = a.role
				WHERE s.token_hash = $1 AND s.expires_at > now()
				  AND s.csrf_token IS NOT NULL AND s.pending_kind IS NULL
			`, hashToken(token)).Scan(&adminID, &csrfToken, &sessionID, &lastSeen, &role, &roleName, &permissions)

			if err != nil {
				writeError(w, http.StatusUnauthorized, "Invalid or expired session")
				return
			}
			if permissions == nil {
				permissions = []string{}
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
			ctx = context.WithValue(ctx, sessionRowIDKey{}, sessionID)
			ctx = context.WithValue(ctx, adminRoleKey{}, role)
			ctx = context.WithValue(ctx, adminRoleNameKey{}, roleName)
			ctx = context.WithValue(ctx, adminPermissionsKey{}, permissions)
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
// (unauthenticated) routes are not mounted behind this middleware. The
// cookie rides along on every same-site request, so every state-changing
// authed call must prove it came from the SPA via the per-session token.
func RequireCSRF(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}

			csrfToken, _ := r.Context().Value(csrfTokenKey{}).(string)
			if csrfToken == "" {
				writeMFAError(w, http.StatusForbidden, "csrf_failed", "CSRF validation failed")
				return
			}
			provided := r.Header.Get("X-CSRF-Token")
			if provided == "" || provided != csrfToken {
				writeMFAError(w, http.StatusForbidden, "csrf_failed", "CSRF validation failed")
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

func getAdminRole(r *http.Request) string {
	role, _ := r.Context().Value(adminRoleKey{}).(string)
	return role
}

func getAdminRoleName(r *http.Request) string {
	name, _ := r.Context().Value(adminRoleNameKey{}).(string)
	return name
}

func getAdminPermissions(r *http.Request) []string {
	permissions, _ := r.Context().Value(adminPermissionsKey{}).([]string)
	return permissions
}

func adminCan(r *http.Request, permission string) bool {
	return authz.Has(getAdminPermissions(r), permission)
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
	lastSweep   time.Time
}

func newRateLimiter(window time.Duration, maxAttempts int) *rateLimiter {
	return &rateLimiter{
		attempts:    make(map[string][]time.Time),
		window:      window,
		maxAttempts: maxAttempts,
		lastSweep:   time.Now(),
	}
}

// sweepLocked drops every key whose attempts have all aged out of the window.
// Without it a key per unique source IP (every login attempt, including bot
// scans of the public login endpoint) stays in the map forever.
func (rl *rateLimiter) sweepLocked(cutoff time.Time) {
	for key, times := range rl.attempts {
		valid := times[:0]
		for _, t := range times {
			if t.After(cutoff) {
				valid = append(valid, t)
			}
		}
		if len(valid) == 0 {
			delete(rl.attempts, key)
			continue
		}
		rl.attempts[key] = valid
	}
}

func (rl *rateLimiter) isLimited(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	// Periodically evict idle keys; per-key trimming alone leaves the map
	// growing with every IP that only ever tried once.
	if now.Sub(rl.lastSweep) >= rl.window {
		rl.sweepLocked(cutoff)
		rl.lastSweep = now
	}

	var valid []time.Time
	for _, t := range rl.attempts[key] {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	if len(valid) == 0 {
		delete(rl.attempts, key)
	} else {
		rl.attempts[key] = valid
	}

	if len(valid) >= rl.maxAttempts {
		return true
	}

	rl.attempts[key] = append(rl.attempts[key], now)
	return false
}

// RequirePermission allows the request when the acting admin has any one of
// the supplied capabilities. Super admins hold "*" and therefore pass every
// check. The permission map is loaded once by AuthMiddleware.
func RequirePermission(permissions ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			granted := getAdminPermissions(r)
			for _, needed := range permissions {
				if authz.Has(granted, needed) {
					next.ServeHTTP(w, r)
					return
				}
			}
			writeError(w, http.StatusForbidden, "Insufficient permissions")
		})
	}
}

// RequireRole is kept for a small number of super-admin break-glass paths.
// Prefer RequirePermission for ordinary capability checks.
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
