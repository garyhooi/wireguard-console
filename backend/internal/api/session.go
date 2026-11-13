package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// uuidNil is the zero UUID.
var uuidNil = uuid.Nil

// Typed context keys (unexported) carrying per-request auth state populated
// by AuthMiddleware: resolved admin id, the session's CSRF token, the acting
// admin_sessions row id (for the Active Sessions UI), and the admin's current
// role name plus canonical permission policy.
type adminIDKey struct{}
type csrfTokenKey struct{}
type sessionRowIDKey struct{}
type adminRoleKey struct{}
type adminRoleNameKey struct{}
type adminPermissionsKey struct{}

// Session cookie name. The token value is the same opaque 32-byte hex the
// API used to return in JSON — only the transport changes (HttpOnly cookie
// instead of JS-readable localStorage). Pending-login cookies and their
// lifetime live in mfa_shared.go (wgc_mfa_pending).
const (
	sessionCookieName = "wgc_session"

	sessionLifetime = 24 * time.Hour

	// Idle timeout: a session whose last activity is older than this is
	// rejected even though its absolute expiry has not been reached.
	// Overridable via SESSION_IDLE_MINUTES (0 disables the idle check).
	defaultIdleMinutes = 30
)

// idleTimeout returns the configured session idle timeout. SESSION_IDLE_MINUTES
// unset/empty → default 30m; "0" → no idle limit (absolute expiry only).
func idleTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv("SESSION_IDLE_MINUTES"))
	if raw == "" {
		return defaultIdleMinutes * time.Minute
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Minute
}

// secureCookie decides whether the Secure attribute may be set on cookies.
// The origin sees plain HTTP in Cloudflare "Flexible"/"Automatic SSL" mode
// (WGCONSOLE_TLS=external-proxy) while the browser leg is HTTPS — Caddy
// forwards the original scheme in X-Forwarded-Proto, so trust that in
// addition to a direct TLS connection. Never set Secure over a true plain-
// HTTP origin (dev over the vite proxy) or the cookie would be dropped.
func secureCookie(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// setSessionCookie writes an HttpOnly session cookie. maxAge <= 0 clears it.
func setSessionCookie(w http.ResponseWriter, r *http.Request, name, token string, maxAge int) {
	c := &http.Cookie{
		Name:     name,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   maxAge,
		Secure:   secureCookie(r),
	}
	if maxAge <= 0 {
		c.MaxAge = -1
		c.Value = ""
	}
	http.SetCookie(w, c)
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request, name string) {
	setSessionCookie(w, r, name, "", -1)
}

// readCookieToken returns the raw (unhashed) token stored in the named
// cookie. Pending-MFA login cookies use the same helper (see mfa_shared.go);
// the middleware layers decide which cookie is meaningful.
func readCookieToken(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

func randomCSRFToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// createSession persists a new admin_sessions row for rawToken and returns
// the per-session CSRF token when withCSRF is true (pending-MFA login rows are
// created by createPendingMFASession with pending_kind set and no CSRF token —
// they are single-purpose and consumed before any CSRF applies).
// ip_address is INET: store the bare IP, never the host:port from RemoteAddr.
func createSession(ctx context.Context, store *Store, adminID uuid.UUID, rawToken string, r *http.Request, ttl time.Duration, withCSRF bool) (string, error) {
	ip := r.RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		ip = host
	}
	expiresAt := time.Now().Add(ttl)

	var csrfToken any
	if withCSRF {
		tok, err := randomCSRFToken()
		if err != nil {
			return "", err
		}
		csrfToken = tok
	}

	_, err := store.pool.Exec(ctx, `
		INSERT INTO admin_sessions (admin_id, token_hash, ip_address, user_agent, expires_at, csrf_token)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, adminID, hashToken(rawToken), ip, r.UserAgent(), expiresAt, csrfToken)
	if err != nil {
		return "", err
	}
	if csrfToken == nil {
		return "", nil
	}
	return csrfToken.(string), nil
}

// currentSessionTokenHash returns the hash of the acting session's cookie
// token — used by self-service handlers to keep the acting session alive
// while revoking the admin's other sessions.
func currentSessionTokenHash(r *http.Request) string {
	token := readCookieToken(r, sessionCookieName)
	if token == "" {
		return ""
	}
	return hashToken(token)
}

// revokeAdminSessions deletes every live session row for an admin. Used when
// credentials change (password, MFA factors) or the account is demoted/
// disabled/deleted — the old sessions must stop working immediately.
func revokeAdminSessions(ctx context.Context, store *Store, adminID uuid.UUID) error {
	_, err := store.pool.Exec(ctx,
		`DELETE FROM admin_sessions WHERE admin_id = $1`, adminID)
	return err
}

// revokeAdminSessionsExcept deletes all but the named session (used when the
// actor keeps acting through the current session after a self-service change).
func revokeAdminSessionsExcept(ctx context.Context, store *Store, adminID uuid.UUID, keepTokenHash string) error {
	_, err := store.pool.Exec(ctx, `
		DELETE FROM admin_sessions WHERE admin_id = $1 AND token_hash <> $2
	`, adminID, keepTokenHash)
	return err
}

// SessionView is the Active Sessions UI row: the session's own row id
// (revoke target), device/user-agent label, ip, created/last-seen/expiry.
type SessionView struct {
	ID           uuid.UUID  `json:"id"`
	IPAddress    *string    `json:"ip_address"`
	UserAgent    string     `json:"user_agent"`
	CreatedAt    time.Time  `json:"created_at"`
	LastSeenAt   *time.Time `json:"last_seen_at"`
	ExpiresAt    time.Time  `json:"expires_at"`
	IsCurrent    bool       `json:"is_current"`
	IsPendingMFA bool       `json:"is_pending_mfa"` // 10-min login attempt, not a full session
}

// listAdminSessions returns every live session row for an admin (used by the
// Profile → Active Sessions panel). Live = not past absolute expiry. A row is
// a pending-MFA login attempt when it has a pending_kind (see
// createPendingMFASession); only full sessions carry a CSRF token.
func listAdminSessions(ctx context.Context, store *Store, adminID uuid.UUID, currentHash string) ([]SessionView, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT id, ip_address::text, COALESCE(user_agent, ''), created_at, last_seen_at, expires_at,
		       (token_hash = $2) AS is_current, (pending_kind IS NOT NULL) AS is_pending_mfa
		FROM admin_sessions
		WHERE admin_id = $1 AND expires_at > now()
		ORDER BY created_at DESC
	`, adminID, currentHash)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SessionView{}
	for rows.Next() {
		var s SessionView
		if err := rows.Scan(&s.ID, &s.IPAddress, &s.UserAgent, &s.CreatedAt, &s.LastSeenAt, &s.ExpiresAt, &s.IsCurrent, &s.IsPendingMFA); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// revokeAdminSession deletes one session row, but only if it belongs to the
// given admin. Returns (false, nil) when no such row exists (already gone).
func revokeAdminSession(ctx context.Context, store *Store, adminID, sessionID uuid.UUID) (bool, error) {
	tag, err := store.pool.Exec(ctx, `
		DELETE FROM admin_sessions WHERE id = $1 AND admin_id = $2
	`, sessionID, adminID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}