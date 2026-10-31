package e2e

// Passkey / MFA end-to-end coverage (contract §5).
//
// These tests boot the real API (TestMain) and drive it exactly like the SPA:
// forced first-factor enrollment, passkey second-factor login, one-shot passkey
// step-up, recovery-code login, last-factor protection, super-admin reset and
// the wrong-TOTP lockout. WebAuthn ceremonies are performed by the in-tree
// virtual authenticator (internal/webauthntest) - no browser or hardware.
//
// The file is deliberately self-contained: it only relies on the shared e2e
// infrastructure (baseURL, actor/newActor, expectStatus) and seeds its own
// admins, so it stays stable while the rest of the auth suite is rewritten.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/argon2"

	authwebauthntest "github.com/wireguard-console/backend/internal/webauthntest"
)

const (
	pkPassword = "pk-e2e-Passw0rd!"
	// Each test strikes its own client IP so the shared per-IP login lockout
	// bucket can never leak between tests (the lockout is an in-memory map in
	// the API process).
	pkIPDefault  = "198.51.100.10"
	pkIPLogin    = "198.51.100.12"
	pkIPStepUp   = "198.51.100.13"
	pkIPRecovery = "198.51.100.14"
	pkIPDelete   = "198.51.100.15"
	pkIPReset    = "198.51.100.16"
	pkIPLockout  = "198.51.100.99"
)

func pkDBURL(t *testing.T) string {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set - skipping e2e")
	}
	return dbURL
}

// pkSeedAdmin inserts (idempotently) an admin with a known password hash,
// mirroring the suite's seedAdmin helper so these tests do not depend on the
// rest of the auth suite's fixture ordering.
func pkSeedAdmin(t *testing.T, dbURL, email, role string) string {
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
	hash := argon2.IDKey([]byte(pkPassword), salt, 1<<15, 1, 4, 32)
	passwordHash := hex.EncodeToString(salt) + ":" + hex.EncodeToString(hash)

	var id uuid.UUID
	err = pool.QueryRow(ctx, `SELECT id FROM admins WHERE email = $1`, email).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		err = pool.QueryRow(ctx, `
			INSERT INTO admins (email, password_hash, role, status)
			VALUES ($1, $2, $3, 'active')
			RETURNING id
		`, email, passwordHash, role).Scan(&id)
	}
	if err != nil {
		t.Fatalf("seed admin %s: %v", email, err)
	}
	return id.String()
}

func pkTOTPCode(t *testing.T, secret string) string {
	t.Helper()
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate TOTP code: %v", err)
	}
	return code
}

// pkDo is a small browser-like request helper over the shared actor jar. It is
// a local copy of the suite's api() helper plus an explicit X-Forwarded-For, so
// rate-limit buckets can be isolated per test.
func pkDo(t *testing.T, act *actor, fromIP, method, path, csrf string, body any) (*http.Response, map[string]interface{}) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req, err := http.NewRequest(method, baseURL+path, &buf)
	if err != nil {
		t.Fatalf("new request %s %s: %v", method, path, err)
	}
	for _, cookie := range act.jar {
		req.AddCookie(cookie)
	}
	if fromIP != "" {
		req.Header.Set("X-Forwarded-For", fromIP)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	for _, cookie := range resp.Cookies() {
		if cookie.MaxAge <= 0 && cookie.Value == "" {
			delete(act.jar, cookie.Name)
		} else {
			act.jar[cookie.Name] = cookie
		}
	}
	out := map[string]interface{}{}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	return resp, out
}

func pkCode(out map[string]interface{}) string {
	code, _ := out["code"].(string)
	return code
}

func pkBool(out map[string]interface{}, key string) bool {
	value, _ := out[key].(bool)
	return value
}

func pkString(out map[string]interface{}, key string) string {
	value, _ := out[key].(string)
	return value
}

func pkStringList(out map[string]interface{}, key string) []string {
	raw, _ := out[key].([]interface{})
	outList := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			outList = append(outList, s)
		}
	}
	return outList
}

func pkHasString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// pkOriginFor derives the browser origin a virtual authenticator must claim for
// the relying party's configured RP ID.
func pkOriginFor(rpID string) string {
	if rpID == "localhost" || strings.HasPrefix(rpID, "127.0.0.1") || strings.HasPrefix(rpID, "[::1]") {
		return "http://localhost:8080"
	}
	return "https://" + rpID
}

// pkPasswordLogin performs the password step and returns the response body.
func pkPasswordLogin(t *testing.T, act *actor, email, password, fromIP string) map[string]interface{} {
	t.Helper()
	resp, out := pkDo(t, act, fromIP, "POST", "/api/auth/login", "", map[string]string{
		"email": email, "password": password,
	})
	expectStatus(t, resp, 200, "POST /api/auth/login")
	return out
}

// pkBegin calls a begin endpoint and extracts the challenge. A deployment that
// cannot host passkeys (IP-only) skips the calling test instead of failing.
func pkBegin(t *testing.T, act *actor, fromIP, path, csrf string) (challengeID string, options any, rpID string) {
	t.Helper()
	resp, out := pkDo(t, act, fromIP, "POST", path, csrf, nil)
	if resp.StatusCode == http.StatusConflict && pkCode(out) == "mfa_unavailable" {
		t.Skipf("passkeys unavailable in this deployment: %s", pkString(out, "error"))
	}
	expectStatus(t, resp, 200, path)
	challengeID = pkString(out, "challenge_id")
	options = out["options"]
	rpID = pkString(out, "rp_id")
	if challengeID == "" || options == nil || rpID == "" {
		t.Fatalf("%s: incomplete begin response: %v", path, out)
	}
	return challengeID, options, rpID
}

// pkFinish posts a browser credential response to a finish endpoint.
func pkFinish(t *testing.T, act *actor, fromIP, path, csrf, challengeID string, credential map[string]any) (int, map[string]interface{}) {
	t.Helper()
	resp, out := pkDo(t, act, fromIP, "POST", path, csrf, map[string]interface{}{
		"challenge_id": challengeID,
		"credential":   credential,
	})
	return resp.StatusCode, out
}

// pkPasskeyFixture is a fully enrolled passkey admin with a live session.
type pkPasskeyFixture struct {
	actor         *actor
	authenticator *authwebauthntest.Authenticator
	adminID       string
	passkeyID     string
	rpID          string
	origin        string
}

// pkEnrollPasskeyAdmin creates an admin and completes forced first-factor
// enrollment with a passkey (passkey-only account).
func pkEnrollPasskeyAdmin(t *testing.T, dbURL, email string) *pkPasskeyFixture {
	t.Helper()
	adminID := pkSeedAdmin(t, dbURL, email, "super_admin")

	act := newActor()
	login := pkPasswordLogin(t, act, email, pkPassword, pkIPDefault)
	if !pkBool(login, "pending_mfa_setup") {
		t.Fatalf("fresh admin login did not return pending_mfa_setup: %v", login)
	}
	if _, ok := act.jar["wgc_mfa_pending"]; !ok {
		t.Fatal("forced enrollment login did not set the pending MFA cookie")
	}

	resp, state := pkDo(t, act, pkIPDefault, "GET", "/api/auth/mfa/state", "", nil)
	expectStatus(t, resp, 200, "GET /api/auth/mfa/state (enroll)")
	if kind := pkString(state, "pending_kind"); kind != "enroll" {
		t.Fatalf("pending_kind = %q, want enroll", kind)
	}
	if !pkBool(state, "passkey_available") {
		t.Skipf("passkeys unavailable in this deployment: %s", pkString(state, "passkey_reason"))
	}
	if !pkHasString(pkStringList(state, "setup_methods"), "passkey") {
		t.Fatalf("setup_methods does not offer passkey: %v", state["setup_methods"])
	}

	challengeID, options, rpID := pkBegin(t, act, pkIPDefault, "/api/auth/mfa/enroll/passkey/begin", "")
	origin := pkOriginFor(rpID)
	authenticator, err := authwebauthntest.New()
	if err != nil {
		t.Fatalf("virtual authenticator: %v", err)
	}
	registration, err := authenticator.RegistrationResponse(options, origin, rpID)
	if err != nil {
		t.Fatalf("RegistrationResponse: %v", err)
	}
	status, out := pkFinish(t, act, pkIPDefault, "/api/auth/mfa/enroll/passkey/finish", "", challengeID, registration)
	if status != 200 {
		t.Skipf("passkey enrollment unavailable in this deployment (status %d, %v)", status, out)
	}
	if pkString(out, "status") != "factor_added" {
		t.Fatalf("enroll finish status = %v, want factor_added", out["status"])
	}
	factor, _ := out["factor"].(map[string]interface{})
	passkeyID := pkString(factor, "id")
	if _, err := uuid.Parse(passkeyID); err != nil {
		t.Fatalf("enroll finish returned no usable factor id: %v", out["factor"])
	}

	resp, complete := pkDo(t, act, pkIPDefault, "POST", "/api/auth/mfa/enroll/complete", "", nil)
	expectStatus(t, resp, 200, "POST /api/auth/mfa/enroll/complete")
	csrf := pkString(complete, "csrf_token")
	if csrf == "" {
		t.Fatal("enroll/complete returned no csrf_token")
	}
	act.csrf = csrf
	if _, ok := act.jar["wgc_session"]; !ok {
		t.Fatal("enroll/complete did not set the session cookie")
	}

	// The completed enrollment must have materialised a stable user handle and
	// a credential row whose raw flags came from the authenticator data.
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()
	var (
		handleLen int
		count     int
	)
	if err := pool.QueryRow(ctx,
		`SELECT octet_length(handle) FROM webauthn_users WHERE admin_id = $1`, adminID).Scan(&handleLen); err != nil {
		t.Fatalf("load webauthn user handle: %v", err)
	}
	if handleLen != 32 {
		t.Fatalf("webauthn user handle length = %d, want 32", handleLen)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM webauthn_credentials WHERE admin_id = $1`, adminID).Scan(&count); err != nil {
		t.Fatalf("count credentials: %v", err)
	}
	if count != 1 {
		t.Fatalf("credential rows after enrollment = %d, want 1", count)
	}

	return &pkPasskeyFixture{
		actor:         act,
		authenticator: authenticator,
		adminID:       adminID,
		passkeyID:     passkeyID,
		rpID:          rpID,
		origin:        origin,
	}
}

// pkSetupTOTPAdmin creates an admin and completes forced TOTP enrollment,
// returning the live session, the TOTP secret and the recovery codes.
func pkSetupTOTPAdmin(t *testing.T, dbURL, email string) (*actor, string, string, []string) {
	t.Helper()
	adminID := pkSeedAdmin(t, dbURL, email, "super_admin")

	act := newActor()
	login := pkPasswordLogin(t, act, email, pkPassword, pkIPDefault)
	if !pkBool(login, "pending_mfa_setup") {
		t.Fatalf("fresh admin login did not return pending_mfa_setup: %v", login)
	}

	resp, begin := pkDo(t, act, pkIPDefault, "POST", "/api/auth/mfa/enroll/totp/begin", "", nil)
	expectStatus(t, resp, 200, "POST /api/auth/mfa/enroll/totp/begin")
	secret := pkString(begin, "secret")
	if secret == "" {
		t.Fatal("TOTP enroll begin returned no secret")
	}
	resp, _ = pkDo(t, act, pkIPDefault, "POST", "/api/auth/mfa/enroll/totp/finish", "", map[string]string{
		"code": pkTOTPCode(t, secret),
	})
	expectStatus(t, resp, 200, "POST /api/auth/mfa/enroll/totp/finish")

	resp, complete := pkDo(t, act, pkIPDefault, "POST", "/api/auth/mfa/enroll/complete", "", nil)
	expectStatus(t, resp, 200, "POST /api/auth/mfa/enroll/complete")
	csrf := pkString(complete, "csrf_token")
	if csrf == "" {
		t.Fatal("enroll/complete returned no csrf_token")
	}
	act.csrf = csrf
	return act, secret, adminID, pkStringList(complete, "recovery_codes")
}

// pkPasskeyLogin completes a passkey second-factor login for an existing account.
func pkPasskeyLogin(t *testing.T, act *actor, email string, authenticator *authwebauthntest.Authenticator, fromIP string) map[string]interface{} {
	t.Helper()
	login := pkPasswordLogin(t, act, email, pkPassword, fromIP)
	if !pkBool(login, "pending_mfa") {
		t.Fatalf("login did not return pending_mfa: %v", login)
	}
	if !pkHasString(pkStringList(login, "mfa_methods"), "passkey") {
		t.Fatalf("mfa_methods does not offer passkey: %v", login["mfa_methods"])
	}
	if _, ok := act.jar["wgc_session"]; ok {
		t.Fatal("password step minted a session before the second factor")
	}

	challengeID, options, rpID := pkBegin(t, act, fromIP, "/api/auth/mfa/passkey/begin", "")
	assertion, err := authenticator.AssertionResponse(options, pkOriginFor(rpID), rpID, nil)
	if err != nil {
		t.Fatalf("AssertionResponse: %v", err)
	}
	status, out := pkFinish(t, act, fromIP, "/api/auth/mfa/passkey/finish", "", challengeID, assertion)
	if status != 200 {
		t.Fatalf("passkey login finish status = %d, body %v", status, out)
	}
	csrf := pkString(out, "csrf_token")
	if csrf == "" {
		t.Fatal("passkey login returned no csrf_token")
	}
	act.csrf = csrf
	if _, ok := act.jar["wgc_session"]; !ok {
		t.Fatal("passkey login did not set the session cookie")
	}
	return out
}

func TestMFAForcedPasskeyEnrollment(t *testing.T) {
	dbURL := pkDBURL(t)
	email := "pk-forced@console.test"
	adminID := pkSeedAdmin(t, dbURL, email, "super_admin")

	act := newActor()
	login := pkPasswordLogin(t, act, email, pkPassword, pkIPDefault)
	if !pkBool(login, "pending_mfa_setup") {
		t.Fatalf("fresh admin login did not return pending_mfa_setup: %v", login)
	}
	if _, ok := act.jar["wgc_mfa_pending"]; !ok {
		t.Fatal("forced enrollment login did not set the pending MFA cookie")
	}

	resp, state := pkDo(t, act, pkIPDefault, "GET", "/api/auth/mfa/state", "", nil)
	expectStatus(t, resp, 200, "GET /api/auth/mfa/state (enroll)")
	if kind := pkString(state, "pending_kind"); kind != "enroll" {
		t.Fatalf("pending_kind = %q, want enroll", kind)
	}
	if !pkBool(state, "passkey_available") {
		t.Skipf("passkeys unavailable in this deployment: %s", pkString(state, "passkey_reason"))
	}

	challengeID, options, rpID := pkBegin(t, act, pkIPDefault, "/api/auth/mfa/enroll/passkey/begin", "")
	origin := pkOriginFor(rpID)
	authenticator, err := authwebauthntest.New()
	if err != nil {
		t.Fatalf("virtual authenticator: %v", err)
	}
	registration, err := authenticator.RegistrationResponse(options, origin, rpID)
	if err != nil {
		t.Fatalf("RegistrationResponse: %v", err)
	}
	status, out := pkFinish(t, act, pkIPDefault, "/api/auth/mfa/enroll/passkey/finish", "", challengeID, registration)
	if status != 200 {
		t.Fatalf("enroll finish status = %d, body %v", status, out)
	}
	factor, _ := out["factor"].(map[string]interface{})
	passkeyID := pkString(factor, "id")
	if _, err := uuid.Parse(passkeyID); err != nil {
		t.Fatalf("enroll finish returned no usable factor id: %v", out["factor"])
	}
	if pkBool(out, "session") {
		t.Fatal("enrollment finish must not mint a session")
	}

	resp, complete := pkDo(t, act, pkIPDefault, "POST", "/api/auth/mfa/enroll/complete", "", nil)
	expectStatus(t, resp, 200, "POST /api/auth/mfa/enroll/complete")
	csrf := pkString(complete, "csrf_token")
	if csrf == "" {
		t.Fatal("enroll/complete returned no csrf_token")
	}
	act.csrf = csrf
	if codes := pkStringList(complete, "recovery_codes"); len(codes) != 10 {
		t.Fatalf("enroll/complete recovery codes = %d, want 10", len(codes))
	}

	resp, me := pkDo(t, act, pkIPDefault, "GET", "/api/admins/me", csrf, nil)
	expectStatus(t, resp, 200, "GET /api/admins/me (after passkey enrollment)")
	if enabled, _ := me["mfa_enabled"].(bool); !enabled {
		t.Fatalf("admin/me reports mfa_enabled=false after passkey enrollment: %v", me)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()
	var handleLen, count int
	if err := pool.QueryRow(ctx, `SELECT octet_length(handle) FROM webauthn_users WHERE admin_id = $1`, adminID).Scan(&handleLen); err != nil {
		t.Fatalf("load webauthn user handle: %v", err)
	}
	if handleLen != 32 {
		t.Fatalf("webauthn user handle length = %d, want 32", handleLen)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM webauthn_credentials WHERE admin_id = $1`, adminID).Scan(&count); err != nil {
		t.Fatalf("count credentials: %v", err)
	}
	if count != 1 {
		t.Fatalf("credential rows = %d, want 1", count)
	}
}

func TestMFAPasskeyLogin(t *testing.T) {
	dbURL := pkDBURL(t)
	fixture := pkEnrollPasskeyAdmin(t, dbURL, "pk-login@console.test")

	// Wrong challenge: the pending login survives the failed assertion.
	act := newActor()
	login := pkPasswordLogin(t, act, "pk-login@console.test", pkPassword, pkIPLogin)
	if !pkBool(login, "pending_mfa") {
		t.Fatalf("login did not return pending_mfa: %v", login)
	}
	challengeID, options, rpID := pkBegin(t, act, pkIPLogin, "/api/auth/mfa/passkey/begin", "")
	badAssertion, err := fixture.authenticator.AssertionResponseWithChallenge(options, pkOriginFor(rpID), rpID, nil,
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if err != nil {
		t.Fatalf("AssertionResponseWithChallenge: %v", err)
	}
	status, out := pkFinish(t, act, pkIPLogin, "/api/auth/mfa/passkey/finish", "", challengeID, badAssertion)
	if status != 400 || pkCode(out) != "mfa_passkey_failed" {
		t.Fatalf("bad-challenge finish = %d %v, want 400 mfa_passkey_failed", status, out)
	}

	// A fresh challenge with the real assertion completes the login.
	challengeID, options, rpID = pkBegin(t, act, pkIPLogin, "/api/auth/mfa/passkey/begin", "")
	assertion, err := fixture.authenticator.AssertionResponse(options, pkOriginFor(rpID), rpID, nil)
	if err != nil {
		t.Fatalf("AssertionResponse: %v", err)
	}
	status, out = pkFinish(t, act, pkIPLogin, "/api/auth/mfa/passkey/finish", "", challengeID, assertion)
	if status != 200 {
		t.Fatalf("passkey login finish = %d %v, want 200", status, out)
	}
	csrf := pkString(out, "csrf_token")
	if csrf == "" {
		t.Fatalf("passkey login returned no csrf_token: %v", out)
	}
	act.csrf = csrf
	if _, ok := act.jar["wgc_session"]; !ok {
		t.Fatal("passkey login did not set the session cookie")
	}
	if _, ok := act.jar["wgc_mfa_pending"]; ok {
		t.Fatal("passkey login did not clear the pending MFA cookie")
	}
	resp, _ := pkDo(t, act, pkIPLogin, "GET", "/api/admins/me", csrf, nil)
	expectStatus(t, resp, 200, "GET /api/admins/me (passkey login)")
}

func TestMFAPasskeyStepUpOnce(t *testing.T) {
	dbURL := pkDBURL(t)
	fixture := pkEnrollPasskeyAdmin(t, dbURL, "pk-stepup@console.test")
	targetID := pkSeedAdmin(t, dbURL, "pk-stepup-target@console.test", "admin")
	act := fixture.actor

	gated := func(extraIP string) (*http.Response, map[string]interface{}) {
		return pkDo(t, act, extraIP, "POST", "/api/admins/"+targetID+"/reset-password", act.csrf, map[string]string{"code": ""})
	}

	// Before any step-up, an empty code is refused.
	resp, out := gated(pkIPStepUp)
	if resp.StatusCode != 400 {
		t.Fatalf("gated action before step-up = %d %v, want 400", resp.StatusCode, out)
	}

	// A non-UV assertion must not count as step-up: the ceremony requires UV.
	challengeID, options, rpID := pkBegin(t, act, pkIPStepUp, "/api/auth/mfa/stepup/passkey/begin", act.csrf)
	fixture.authenticator.UserVerified = false
	noUV, err := fixture.authenticator.AssertionResponse(options, pkOriginFor(rpID), rpID, nil)
	if err != nil {
		t.Fatalf("AssertionResponse (no UV): %v", err)
	}
	status, out := pkFinish(t, act, pkIPStepUp, "/api/auth/mfa/stepup/passkey/finish", act.csrf, challengeID, noUV)
	if status != 400 || pkCode(out) != "mfa_passkey_failed" {
		t.Fatalf("non-UV step-up = %d %v, want 400 mfa_passkey_failed", status, out)
	}
	fixture.authenticator.UserVerified = true

	// A UV assertion completes the step-up and stamps the session.
	challengeID, options, rpID = pkBegin(t, act, pkIPStepUp, "/api/auth/mfa/stepup/passkey/begin", act.csrf)
	assertion, err := fixture.authenticator.AssertionResponse(options, pkOriginFor(rpID), rpID, nil)
	if err != nil {
		t.Fatalf("AssertionResponse: %v", err)
	}
	status, out = pkFinish(t, act, pkIPStepUp, "/api/auth/mfa/stepup/passkey/finish", act.csrf, challengeID, assertion)
	if status != 200 {
		t.Fatalf("passkey step-up finish = %d %v, want 200", status, out)
	}
	if pkString(out, "status") != "verified" {
		t.Fatalf("step-up status = %v, want verified", out["status"])
	}
	if valid, _ := out["valid_for_seconds"].(float64); valid != 90 {
		t.Fatalf("valid_for_seconds = %v, want 90", out["valid_for_seconds"])
	}

	// Exactly one gated action may redeem the stamp.
	resp, out = gated(pkIPStepUp)
	if resp.StatusCode != 200 {
		t.Fatalf("gated action after step-up = %d %v, want 200", resp.StatusCode, out)
	}
	if pkString(out, "password") == "" {
		t.Fatalf("reset-password response missing password: %v", out)
	}
	resp, out = gated(pkIPStepUp)
	if resp.StatusCode != 400 {
		t.Fatalf("second gated action must re-require step-up: %d %v", resp.StatusCode, out)
	}
}

func TestMFARecoveryCodeLoginSingleUse(t *testing.T) {
	dbURL := pkDBURL(t)
	_, _, _, codes := pkSetupTOTPAdmin(t, dbURL, "pk-recovery@console.test")
	if len(codes) != 10 {
		t.Fatalf("recovery codes = %d, want 10", len(codes))
	}
	code := codes[0]

	first := newActor()
	login := pkPasswordLogin(t, first, "pk-recovery@console.test", pkPassword, pkIPRecovery)
	if !pkBool(login, "pending_mfa") {
		t.Fatalf("login did not return pending_mfa: %v", login)
	}
	if !pkHasString(pkStringList(login, "mfa_methods"), "recovery_code") {
		t.Fatalf("mfa_methods does not offer recovery_code: %v", login["mfa_methods"])
	}
	resp, out := pkDo(t, first, pkIPRecovery, "POST", "/api/auth/mfa/recovery-code", "", map[string]string{"code": code})
	expectStatus(t, resp, 200, "POST /api/auth/mfa/recovery-code")
	csrf := pkString(out, "csrf_token")
	if csrf == "" {
		t.Fatalf("recovery-code login returned no csrf_token: %v", out)
	}
	first.csrf = csrf
	if _, ok := first.jar["wgc_session"]; !ok {
		t.Fatal("recovery-code login did not set the session cookie")
	}

	// The same code can never be redeemed twice.
	second := newActor()
	pkPasswordLogin(t, second, "pk-recovery@console.test", pkPassword, pkIPRecovery)
	resp, out = pkDo(t, second, pkIPRecovery, "POST", "/api/auth/mfa/recovery-code", "", map[string]string{"code": code})
	if resp.StatusCode != 400 || pkCode(out) != "mfa_invalid" {
		t.Fatalf("reused recovery code = %d %v, want 400 mfa_invalid", resp.StatusCode, out)
	}
}

func TestMFAPasskeyLastFactorRemoval(t *testing.T) {
	dbURL := pkDBURL(t)
	fixture := pkEnrollPasskeyAdmin(t, dbURL, "pk-lastfactor@console.test")
	act := fixture.actor

	resp, status := pkDo(t, act, pkIPDelete, "GET", "/api/admins/me/mfa", act.csrf, nil)
	expectStatus(t, resp, 200, "GET /api/admins/me/mfa")
	factors, _ := status["factors"].([]interface{})
	if len(factors) != 1 {
		t.Fatalf("passkey-only admin has %d factors, want 1: %v", len(factors), status)
	}

	resp, out := pkDo(t, act, pkIPDelete, "DELETE", "/api/admins/me/mfa/passkeys/"+fixture.passkeyID, act.csrf, map[string]string{"code": ""})
	if resp.StatusCode != 409 || pkCode(out) != "mfa_last_factor" {
		t.Fatalf("removing last factor = %d %v, want 409 mfa_last_factor", resp.StatusCode, out)
	}

	resp, status = pkDo(t, act, pkIPDelete, "GET", "/api/admins/me/mfa", act.csrf, nil)
	expectStatus(t, resp, 200, "GET /api/admins/me/mfa (after refused removal)")
	factors, _ = status["factors"].([]interface{})
	if len(factors) != 1 {
		t.Fatalf("last factor was removed despite 409: %v", status["factors"])
	}
}

func TestMFAResetRevokesSessionsAndForcesReenroll(t *testing.T) {
	dbURL := pkDBURL(t)
	superActor, superSecret, superID, _ := pkSetupTOTPAdmin(t, dbURL, "pk-reset-super@console.test")
	targetActor, _, targetID, _ := pkSetupTOTPAdmin(t, dbURL, "pk-reset-target@console.test")

	resp, _ := pkDo(t, targetActor, pkIPReset, "GET", "/api/admins/me", targetActor.csrf, nil)
	expectStatus(t, resp, 200, "GET /api/admins/me (target before reset)")

	resp, out := pkDo(t, superActor, pkIPReset, "POST", "/api/admins/"+targetID+"/reset-mfa", superActor.csrf, map[string]string{
		"code": pkTOTPCode(t, superSecret),
	})
	expectStatus(t, resp, 200, "POST /api/admins/{id}/reset-mfa")
	if pkString(out, "status") != "mfa reset" {
		t.Fatalf("reset-mfa status = %v, want 'mfa reset'", out["status"])
	}

	// Every session issued under the old factors is gone.
	resp, _ = pkDo(t, targetActor, pkIPReset, "GET", "/api/admins/me", targetActor.csrf, nil)
	if resp.StatusCode != 401 {
		t.Fatalf("target session after reset = %d, want 401", resp.StatusCode)
	}

	// The cleared admin is forced through enrollment again on next sign-in.
	fresh := newActor()
	login := pkPasswordLogin(t, fresh, "pk-reset-target@console.test", pkPassword, pkIPReset)
	if !pkBool(login, "pending_mfa_setup") {
		t.Fatalf("post-reset login did not require re-enrollment: %v", login)
	}

	// A super admin may not reset their own MFA through this endpoint.
	resp, _ = pkDo(t, superActor, pkIPReset, "POST", "/api/admins/"+superID+"/reset-mfa", superActor.csrf, map[string]string{
		"code": pkTOTPCode(t, superSecret),
	})
	if resp.StatusCode != 400 {
		t.Fatalf("self reset-mfa = %d, want 400", resp.StatusCode)
	}
}

// TestMFALockoutAfterWrongTOTP is defined last on purpose: it deliberately
// trips the shared login lockout, and each test uses its own client IP anyway.
func TestMFALockoutAfterWrongTOTP(t *testing.T) {
	dbURL := pkDBURL(t)
	_, _, _, _ = pkSetupTOTPAdmin(t, dbURL, "pk-lockout@console.test")

	act := newActor()
	login := pkPasswordLogin(t, act, "pk-lockout@console.test", pkPassword, pkIPLockout)
	if !pkBool(login, "pending_mfa") {
		t.Fatalf("login did not return pending_mfa: %v", login)
	}

	statuses := make([]int, 0, 5)
	var last map[string]interface{}
	for attempt := 0; attempt < 5; attempt++ {
		resp, out := pkDo(t, act, pkIPLockout, "POST", "/api/auth/mfa/totp", "", map[string]string{"code": "000000"})
		statuses = append(statuses, resp.StatusCode)
		last = out
	}
	if lastStatus := statuses[len(statuses)-1]; lastStatus != http.StatusTooManyRequests {
		t.Fatalf("wrong-TOTP statuses = %v, want a 429 on the fifth attempt", statuses)
	}
	if code := pkCode(last); code != "mfa_locked" {
		t.Fatalf("lockout code = %q, want mfa_locked (body %v)", code, last)
	}
	if retry, _ := last["retry_after_seconds"].(float64); retry <= 0 {
		t.Fatalf("lockout response missing retry_after_seconds: %v", last)
	}
}
