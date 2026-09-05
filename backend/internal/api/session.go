package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
)

// uuidNil is the zero UUID.
var uuidNil = uuid.Nil

// Typed context keys (unexported) carrying per-request auth state populated
// by AuthMiddleware: resolved admin id, the session's CSRF token, and
// whether the request authenticated via the (transition-only) header.
type adminIDKey struct{}
type csrfTokenKey struct{}
type viaHeaderKey struct{}

// Session cookie names. The token value is the same opaque 32-byte hex the
// API used to return in JSON — only the transport changes (HttpOnly cookie
// instead of JS-readable localStorage).
const (
	sessionCookieName    = "wgc_session"
	pending2FACookieName = "wgc_pending2fa"

	sessionLifetime = 24 * time.Hour
	pending2FALife  = 10 * time.Minute

	// Legacy transition: accept the old Authorization header too while the
	// cookie-only frontend rolls out (AUTH_ACCEPT_HEADER=1). Remove after
	// cutover — never rely on the header as the long-term transport.
	envAcceptLegacyHeader = "AUTH_ACCEPT_HEADER"
)

// acceptLegacyHeader reports whether the Authorization-header transport is
// still honored during the localStorage→cookie migration window.
func acceptLegacyHeader() bool {
	return os.Getenv(envAcceptLegacyHeader) == "1"
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

// readSessionToken returns the raw (unhashed) session token from the cookie
// jar. The pending-2FA cookie is tried when present so the verify step can
// consume it; the middleware layers decide which is meaningful.
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
// the per-session CSRF token when withCSRF is true (pending-2FA tokens get
// none — they are single-purpose and consumed before any CSRF applies).
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

// currentSessionTokenHash returns the hash of the acting session's token —
// from the cookie, or the legacy Authorization header during the transition —
// used by self-service handlers to keep the acting session alive while
// revoking the admin's other sessions.
func currentSessionTokenHash(r *http.Request) string {
	token := readCookieToken(r, sessionCookieName)
	if token == "" && acceptLegacyHeader() {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if token == "" {
		return ""
	}
	return hashToken(token)
}

// revokeAdminSessions deletes every live session row for an admin. Used when
// credentials change (password, 2FA) or the account is demoted/disabled/
// deleted — the old sessions must stop working immediately.
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
