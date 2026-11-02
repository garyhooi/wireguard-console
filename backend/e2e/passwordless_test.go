package e2e

// Passwordless (discoverable-credential) passkey sign-in: end-to-end coverage.
//
// These tests boot the real API (TestMain) and drive it exactly like the SPA:
// an enrolled passkey signs in WITHOUT an email or password - the account is
// resolved from the assertion's opaque user handle - while password login keeps
// requiring a second factor. WebAuthn ceremonies are performed by the in-tree
// virtual authenticator (internal/webauthntest), never a browser or hardware.
//
// The file is self-contained: it defines its own seeded fixtures and request
// helpers (pl* prefix) so it does not depend on any other suite's test ordering.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/argon2"

	authwebauthntest "github.com/wireguard-console/backend/internal/webauthntest"
)

const (
	plPassword = "pl-e2e-Passw0rd!"

	// Each test strikes its own client IP: the per-IP login lockout is an
	// in-memory map shared by the whole API process, and the negative cases
	// deliberately record failures against it.
	plIPEnroll        = "203.0.113.40"
	plIPPositive      = "203.0.113.41"
	plIPFallback      = "203.0.113.42"
	plIPNoCookie      = "203.0.113.43"
	plIPUnknownHandle = "203.0.113.44"
	plIPWrongOrigin   = "203.0.113.45"
	plIPReplay        = "203.0.113.46"
	plIPDisabled      = "203.0.113.47"
	plIPLockout       = "203.0.113.48"
	plIPResidentKey   = "203.0.113.49"
)

func plDBURL(t *testing.T) string {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set - skipping e2e")
	}
	return dbURL
}

func plPool(t *testing.T, dbURL string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// plSeedAdmin inserts (idempotently) an admin with a known password hash.
func plSeedAdmin(t *testing.T, dbURL, email, role string) string {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		t.Fatalf("rand salt: %v", err)
	}
	hash := argon2.IDKey([]byte(plPassword), salt, 1<<15, 1, 4, 32)
	passwordHash := hex.EncodeToString(salt) + ":" + hex.EncodeToString(hash)

	var id uuid.UUID
	err = pool.QueryRow(ctx, "SELECT id FROM admins WHERE email = $1", email).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		err = pool.QueryRow(ctx, "INSERT INTO admins (email, password_hash, role, status) VALUES ($1, $2, $3, 'active') RETURNING id",
			email, passwordHash, role).Scan(&id)
	}
	if err != nil {
		t.Fatalf("seed admin %s: %v", email, err)
	}
	return id.String()
}

// plOriginFor derives the browser origin a virtual authenticator must claim for
// the relying party's configured RP ID.
func plOriginFor(rpID string) string {
	if rpID == "localhost" {
		return "http://localhost:8080"
	}
	return "https://" + rpID
}

func plCode(out map[string]interface{}) string {
	code, _ := out["code"].(string)
	return code
}

func plStr(out map[string]interface{}, key string) string {
	value, _ := out[key].(string)
	return value
}

func plBool(out map[string]interface{}, key string) bool {
	value, _ := out[key].(bool)
	return value
}

func plStrings(out map[string]interface{}, key string) []string {
	raw, _ := out[key].([]interface{})
	values := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			values = append(values, s)
		}
	}
	return values
}

func plHasString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func plOptionsMap(t *testing.T, options any) map[string]interface{} {
	t.Helper()
	m, ok := options.(map[string]interface{})
	if !ok {
		t.Fatalf("options are not a JSON object: %T %v", options, options)
	}
	return m
}

// plPasswordLogin performs only the password step and returns its response.
func plPasswordLogin(t *testing.T, act *actor, email, fromIP string) map[string]interface{} {
	t.Helper()
	resp, out := act.doFrom(t, fromIP, "POST", "/api/auth/login", "", map[string]string{
		"email": email, "password": plPassword,
	})
	expectStatus(t, resp, 200, "POST /api/auth/login")
	return out
}

// plBegin starts a passwordless ceremony and checks the begin contract.
func plBegin(t *testing.T, act *actor, fromIP string) (challengeID string, options any, rpID string) {
	t.Helper()
	resp, out := act.doFrom(t, fromIP, "POST", "/api/auth/passkey/options", "", nil)
	if resp.StatusCode == http.StatusConflict && plCode(out) == "mfa_unavailable" {
		t.Skipf("passkeys unavailable in this deployment: %s", plStr(out, "error"))
	}
	expectStatus(t, resp, 200, "POST /api/auth/passkey/options")
	challengeID = plStr(out, "challenge_id")
	options = out["options"]
	rpID = plStr(out, "rp_id")
	if challengeID == "" || options == nil || rpID == "" {
		t.Fatalf("incomplete passwordless begin response: %v", out)
	}
	ck, ok := act.jar["wgc_passkey_login"]
	if !ok || ck.Value == "" || !ck.HttpOnly {
		t.Fatalf("passwordless begin did not set an HttpOnly wgc_passkey_login cookie: %+v", ck)
	}
	return challengeID, options, rpID
}

// plFinish posts a browser credential response to the passwordless finish.
func plFinish(t *testing.T, act *actor, fromIP, challengeID string, credential map[string]any) (int, map[string]interface{}) {
	t.Helper()
	resp, out := act.doFrom(t, fromIP, "POST", "/api/auth/passkey/finish", "", map[string]interface{}{
		"challenge_id": challengeID,
		"credential":   credential,
	})
	return resp.StatusCode, out
}

func plAssertion(t *testing.T, authenticator *authwebauthntest.Authenticator, options any, origin, rpID string, handle []byte) map[string]any {
	t.Helper()
	assertion, err := authenticator.AssertionResponse(options, origin, rpID, handle)
	if err != nil {
		t.Fatalf("AssertionResponse: %v", err)
	}
	return assertion
}

func plUserHandle(t *testing.T, pool *pgxpool.Pool, adminID, rpID string) []byte {
	t.Helper()
	var handle []byte
	if err := pool.QueryRow(context.Background(),
		"SELECT handle FROM webauthn_users WHERE admin_id = $1 AND rp_id = $2",
		adminID, rpID).Scan(&handle); err != nil {
		t.Fatalf("load webauthn user handle: %v", err)
	}
	if len(handle) == 0 {
		t.Fatal("webauthn user handle is empty")
	}
	return handle
}

// plPasskeyFixture is a fully enrolled passkey admin.
type plPasskeyFixture struct {
	actor         *actor
	authenticator *authwebauthntest.Authenticator
	adminID       string
	passkeyID     string
	rpID          string
	origin        string
	handle        []byte
}

// plEnrollPasskeyAdmin creates an admin and completes forced first-factor
// enrollment with a passkey (a passkey-only account).
func plEnrollPasskeyAdmin(t *testing.T, dbURL, email string) *plPasskeyFixture {
	t.Helper()
	adminID := plSeedAdmin(t, dbURL, email, "super_admin")

	act := newActor()
	login := plPasswordLogin(t, act, email, plIPEnroll)
	if !plBool(login, "pending_mfa_setup") {
		t.Fatalf("fresh admin login did not return pending_mfa_setup: %v", login)
	}

	resp, begin := act.doFrom(t, plIPEnroll, "POST", "/api/auth/mfa/enroll/passkey/begin", "", nil)
	if resp.StatusCode == http.StatusConflict && plCode(begin) == "mfa_unavailable" {
		t.Skipf("passkeys unavailable in this deployment: %s", plStr(begin, "error"))
	}
	expectStatus(t, resp, 200, "POST /api/auth/mfa/enroll/passkey/begin")
	challengeID := plStr(begin, "challenge_id")
	options := begin["options"]
	rpID := plStr(begin, "rp_id")
	if challengeID == "" || options == nil || rpID == "" {
		t.Fatalf("incomplete enrollment begin response: %v", begin)
	}
	origin := plOriginFor(rpID)

	authenticator, err := authwebauthntest.New()
	if err != nil {
		t.Fatalf("virtual authenticator: %v", err)
	}
	registration, err := authenticator.RegistrationResponse(options, origin, rpID)
	if err != nil {
		t.Fatalf("RegistrationResponse: %v", err)
	}
	resp, finish := act.doFrom(t, plIPEnroll, "POST", "/api/auth/mfa/enroll/passkey/finish", "", map[string]interface{}{
		"challenge_id": challengeID,
		"credential":   registration,
	})
	expectStatus(t, resp, 200, "POST /api/auth/mfa/enroll/passkey/finish")
	factor, _ := finish["factor"].(map[string]interface{})
	passkeyID := plStr(factor, "id")
	if _, err := uuid.Parse(passkeyID); err != nil {
		t.Fatalf("enrollment returned no usable factor id: %v", finish["factor"])
	}

	resp, complete := act.doFrom(t, plIPEnroll, "POST", "/api/auth/mfa/enroll/complete", "", nil)
	expectStatus(t, resp, 200, "POST /api/auth/mfa/enroll/complete")
	csrf := plStr(complete, "csrf_token")
	if csrf == "" {
		t.Fatal("enroll/complete returned no csrf_token")
	}
	act.csrf = csrf
	if _, ok := act.jar["wgc_session"]; !ok {
		t.Fatal("enroll/complete did not set the session cookie")
	}

	pool := plPool(t, dbURL)
	handle := plUserHandle(t, pool, adminID, rpID)
	return &plPasskeyFixture{
		actor:         act,
		authenticator: authenticator,
		adminID:       adminID,
		passkeyID:     passkeyID,
		rpID:          rpID,
		origin:        origin,
		handle:        handle,
	}
}

// plLogout signs the fixture's actor out and verifies the session is gone.
func plLogout(t *testing.T, act *actor, fromIP string) {
	t.Helper()
	resp, _ := act.doFrom(t, fromIP, "POST", "/api/auth/logout", act.csrf, nil)
	expectStatus(t, resp, 200, "POST /api/auth/logout")
	if _, ok := act.jar["wgc_session"]; ok {
		t.Fatal("logout did not clear the session cookie")
	}
	act.csrf = ""
	resp, _ = act.doFrom(t, fromIP, "GET", "/api/admins/me", "", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET /api/admins/me after logout = %d, want 401", resp.StatusCode)
	}
}

func TestPasswordlessSignIn(t *testing.T) {
	dbURL := plDBURL(t)
	pool := plPool(t, dbURL)
	fixture := plEnrollPasskeyAdmin(t, dbURL, "pw-signin@console.test")

	// Enrolled passkey -> logout: the browser now has no session at all.
	plLogout(t, fixture.actor, plIPPositive)
	act := fixture.actor

	// Capability probe (public, no per-user information).
	resp, status := act.doFrom(t, plIPPositive, "GET", "/api/auth/passkey/status", "", nil)
	expectStatus(t, resp, 200, "GET /api/auth/passkey/status")
	if !plBool(status, "passkey_available") {
		t.Skipf("passkeys unavailable in this deployment: %s", plStr(status, "passkey_reason"))
	}

	// Begin: no allowCredentials, UV required, browser-bound ceremony cookie.
	challengeID, options, rpID := plBegin(t, act, plIPPositive)
	if rpID != fixture.rpID {
		t.Fatalf("begin rp_id = %q, want %q", rpID, fixture.rpID)
	}
	optionFields := plOptionsMap(t, options)
	if _, present := optionFields["allowCredentials"]; present {
		t.Fatalf("passwordless options must not carry allowCredentials: %v", optionFields["allowCredentials"])
	}
	if uv, _ := optionFields["userVerification"].(string); uv != "required" {
		t.Fatalf("passwordless userVerification = %q, want required", uv)
	}

	// Assert with the stored discoverable user handle (what a passkey picker
	// returns to the browser) and finish.
	assertion := plAssertion(t, fixture.authenticator, options, fixture.origin, rpID, fixture.handle)
	statusCode, out := plFinish(t, act, plIPPositive, challengeID, assertion)
	if statusCode != 200 {
		t.Fatalf("passwordless finish = %d %v, want 200", statusCode, out)
	}
	csrf := plStr(out, "csrf_token")
	if csrf == "" {
		t.Fatalf("passwordless finish returned no csrf_token: %v", out)
	}
	if _, ok := act.jar["wgc_session"]; !ok {
		t.Fatal("passwordless finish did not set the session cookie")
	}
	if _, ok := act.jar["wgc_passkey_login"]; ok {
		t.Fatal("passwordless finish did not clear the ceremony cookie")
	}
	if admin, _ := out["admin"].(map[string]interface{}); plStr(admin, "email") != "pw-signin@console.test" {
		t.Fatalf("passwordless finish admin block = %v", out["admin"])
	}

	// The minted session must work on a protected route.
	resp, me := act.doFrom(t, plIPPositive, "GET", "/api/admins/me", csrf, nil)
	expectStatus(t, resp, 200, "GET /api/admins/me (passwordless)")
	if plStr(me, "email") != "pw-signin@console.test" {
		t.Fatalf("/api/admins/me email = %q", plStr(me, "email"))
	}

	// The audit trail must record the passwordless method.
	var metadata []byte
	if err := pool.QueryRow(context.Background(),
		"SELECT metadata FROM audit_logs WHERE actor_admin_id = $1 AND action = 'mfa.login_passkey' ORDER BY created_at DESC LIMIT 1",
		fixture.adminID).Scan(&metadata); err != nil {
		t.Fatalf("load mfa.login_passkey audit row: %v", err)
	}
	var meta map[string]interface{}
	if err := json.Unmarshal(metadata, &meta); err != nil {
		t.Fatalf("decode audit metadata: %v", err)
	}
	if passwordless, _ := meta["passwordless"].(bool); !passwordless {
		t.Fatalf("audit metadata passwordless = %v, want true (%v)", meta["passwordless"], meta)
	}
	if method, _ := meta["method"].(string); method != "passkey" {
		t.Fatalf("audit metadata method = %v, want passkey", meta["method"])
	}
}

func TestPasswordlessPasswordLoginStillRequiresMFA(t *testing.T) {
	dbURL := plDBURL(t)
	_ = plEnrollPasskeyAdmin(t, dbURL, "pw-fallback@console.test")

	// A correct password alone must never mint a session, even for an account
	// that also has a discoverable passkey.
	act := newActor()
	login := plPasswordLogin(t, act, "pw-fallback@console.test", plIPFallback)
	if !plBool(login, "pending_mfa") {
		t.Fatalf("password login did not return pending_mfa: %v", login)
	}
	if _, ok := act.jar["wgc_session"]; ok {
		t.Fatal("the password step minted a session before the second factor")
	}
	if _, ok := act.jar["wgc_passkey_login"]; ok {
		t.Fatal("the password step must not start a passwordless ceremony")
	}
	if !plHasString(plStrings(login, "mfa_methods"), "passkey") {
		t.Fatalf("mfa_methods does not offer the enrolled passkey: %v", login["mfa_methods"])
	}

	// The pending session is not a session: protected routes stay closed.
	resp, _ := act.doFrom(t, plIPFallback, "GET", "/api/admins/me", "", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET /api/admins/me with a pending login = %d, want 401", resp.StatusCode)
	}
}

func TestPasswordlessRegistrationRequestsResidentKey(t *testing.T) {
	dbURL := plDBURL(t)
	_ = plSeedAdmin(t, dbURL, "pw-residentkey@console.test", "super_admin")

	act := newActor()
	login := plPasswordLogin(t, act, "pw-residentkey@console.test", plIPResidentKey)
	if !plBool(login, "pending_mfa_setup") {
		t.Fatalf("fresh admin login did not return pending_mfa_setup: %v", login)
	}

	resp, begin := act.doFrom(t, plIPResidentKey, "POST", "/api/auth/mfa/enroll/passkey/begin", "", nil)
	if resp.StatusCode == http.StatusConflict && plCode(begin) == "mfa_unavailable" {
		t.Skipf("passkeys unavailable in this deployment: %s", plStr(begin, "error"))
	}
	expectStatus(t, resp, 200, "POST /api/auth/mfa/enroll/passkey/begin")

	optionFields := plOptionsMap(t, begin["options"])
	selection, _ := optionFields["authenticatorSelection"].(map[string]interface{})
	if selection == nil {
		t.Fatalf("registration options have no authenticatorSelection: %v", optionFields)
	}
	if residentKey, _ := selection["residentKey"].(string); residentKey != "required" {
		t.Fatalf("registration residentKey = %q, want required (new passkeys must be discoverable)", residentKey)
	}
	if uv, _ := selection["userVerification"].(string); uv != "preferred" {
		t.Fatalf("registration userVerification = %q, want preferred", uv)
	}
}

func TestPasswordlessRejectsInvalidCeremonies(t *testing.T) {
	dbURL := plDBURL(t)
	pool := plPool(t, dbURL)
	fixture := plEnrollPasskeyAdmin(t, dbURL, "pw-invalid@console.test")
	act := fixture.actor
	// Start from a signed-out browser: nothing below may mint a session.
	plLogout(t, act, plIPNoCookie)

	unknownHandleMessage := ""

	t.Run("finish without the ceremony cookie", func(t *testing.T) {
		fresh := newActor()
		resp, out := fresh.doFrom(t, plIPNoCookie, "POST", "/api/auth/passkey/finish", "", map[string]interface{}{
			"challenge_id": uuid.NewString(),
			"credential":   map[string]interface{}{"id": "AAAA", "type": "public-key"},
		})
		if resp.StatusCode != http.StatusUnauthorized || plCode(out) != "mfa_no_pending" {
			t.Fatalf("finish without cookie = %d %v, want 401 mfa_no_pending", resp.StatusCode, out)
		}
		if _, ok := fresh.jar["wgc_session"]; ok {
			t.Fatal("a cookie-less finish minted a session")
		}
	})

	t.Run("unknown credential user handle", func(t *testing.T) {
		challengeID, options, rpID := plBegin(t, act, plIPUnknownHandle)
		unknown := make([]byte, 32)
		unknown[0] = 0x42
		assertion := plAssertion(t, fixture.authenticator, options, fixture.origin, rpID, unknown)
		status, out := plFinish(t, act, plIPUnknownHandle, challengeID, assertion)
		if status != http.StatusUnauthorized || plCode(out) != "mfa_invalid" {
			t.Fatalf("unknown-handle finish = %d %v, want 401 mfa_invalid", status, out)
		}
		unknownHandleMessage = plStr(out, "error")
	})

	t.Run("wrong origin", func(t *testing.T) {
		challengeID, options, rpID := plBegin(t, act, plIPWrongOrigin)
		assertion := plAssertion(t, fixture.authenticator, options, "https://evil.example.com", rpID, fixture.handle)
		status, out := plFinish(t, act, plIPWrongOrigin, challengeID, assertion)
		if status != http.StatusUnauthorized || plCode(out) != "mfa_invalid" {
			t.Fatalf("wrong-origin finish = %d %v, want 401 mfa_invalid", status, out)
		}
	})

	t.Run("replayed challenge", func(t *testing.T) {
		challengeID, options, rpID := plBegin(t, act, plIPReplay)
		// Consume the ceremony with a deliberately failing assertion: the
		// challenge is single-use even when the attempt is rejected.
		bad := plAssertion(t, fixture.authenticator, options, "https://evil.example.com", rpID, fixture.handle)
		status, out := plFinish(t, act, plIPReplay, challengeID, bad)
		if status != http.StatusUnauthorized || plCode(out) != "mfa_invalid" {
			t.Fatalf("bad-origin attempt = %d %v, want 401 mfa_invalid", status, out)
		}
		// A correct assertion for the same (now consumed) challenge must fail.
		good := plAssertion(t, fixture.authenticator, options, fixture.origin, rpID, fixture.handle)
		status, out = plFinish(t, act, plIPReplay, challengeID, good)
		if status != http.StatusUnauthorized || plCode(out) != "mfa_no_pending" {
			t.Fatalf("replayed challenge = %d %v, want 401 mfa_no_pending", status, out)
		}
		if _, ok := act.jar["wgc_session"]; ok {
			t.Fatal("a replayed challenge minted a session")
		}
	})

	t.Run("disabled account", func(t *testing.T) {
		ctx := context.Background()
		if _, err := pool.Exec(ctx, "UPDATE admins SET status = 'disabled' WHERE id = $1", fixture.adminID); err != nil {
			t.Fatalf("disable admin: %v", err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), "UPDATE admins SET status = 'active' WHERE id = $1", fixture.adminID)
		})

		challengeID, options, rpID := plBegin(t, act, plIPDisabled)
		assertion := plAssertion(t, fixture.authenticator, options, fixture.origin, rpID, fixture.handle)
		status, out := plFinish(t, act, plIPDisabled, challengeID, assertion)
		if status != http.StatusUnauthorized || plCode(out) != "mfa_invalid" {
			t.Fatalf("disabled-account finish = %d %v, want 401 mfa_invalid", status, out)
		}
		// No enumeration: the disabled account answers exactly like an unknown
		// handle.
		if unknownHandleMessage != "" && plStr(out, "error") != unknownHandleMessage {
			t.Fatalf("disabled-account error %q differs from unknown-handle error %q",
				plStr(out, "error"), unknownHandleMessage)
		}
		if _, ok := act.jar["wgc_session"]; ok {
			t.Fatal("a disabled account minted a session")
		}
	})
}

func TestPasswordlessLockoutAfterFailures(t *testing.T) {
	dbURL := plDBURL(t)
	pool := plPool(t, dbURL)
	fixture := plEnrollPasskeyAdmin(t, dbURL, "pw-lockout@console.test")
	act := fixture.actor

	var maxAttempts int
	if err := pool.QueryRow(context.Background(),
		"SELECT COALESCE(login_max_attempts, 3) FROM config WHERE id = 1").Scan(&maxAttempts); err != nil || maxAttempts < 1 {
		maxAttempts = 3
	}

	var last map[string]interface{}
	lastStatus := 0
	for attempt := 0; attempt < maxAttempts; attempt++ {
		challengeID, options, rpID := plBegin(t, act, plIPLockout)
		assertion := plAssertion(t, fixture.authenticator, options, "https://evil.example.com", rpID, fixture.handle)
		lastStatus, last = plFinish(t, act, plIPLockout, challengeID, assertion)
	}
	if lastStatus != http.StatusTooManyRequests {
		t.Fatalf("status after %d passwordless failures = %d, want 429", maxAttempts, lastStatus)
	}
	if plCode(last) != "mfa_locked" {
		t.Fatalf("lockout code = %q, want mfa_locked (body %v)", plCode(last), last)
	}
	if retry, _ := last["retry_after_seconds"].(float64); retry <= 0 {
		t.Fatalf("lockout response missing retry_after_seconds: %v", last)
	}

	// A locked-out source cannot even begin a new ceremony.
	resp, out := act.doFrom(t, plIPLockout, "POST", "/api/auth/passkey/options", "", nil)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("options from a locked-out IP = %d %v, want 429", resp.StatusCode, out)
	}
	if retry, _ := out["retry_after_seconds"].(float64); retry <= 0 {
		t.Fatalf("locked-out begin response missing retry_after_seconds: %v", out)
	}
}
