package e2e

// Admin email change resets bound passkeys (contract /tmp/wgc-email/CONTRACT.md).
//
// Passkeys are bound to the account identity, so changing an admin's email
// invalidates them. The API must force the changer to confirm that explicitly
// (409 passkeys_will_reset + passkey_count) BEFORE any step-up proof is
// consumed, then atomically change the email and delete the target's WebAuthn
// state while leaving TOTP / recovery codes untouched.
//
// These tests reuse the self-contained fixtures from mfa_passkey_test.go
// (pkSeedAdmin, pkSetupTOTPAdmin, pkEnrollPasskeyAdmin, pkDo, pkPasswordLogin,
// pkTOTPCode, ...) and the shared actor/newActor/rawGet infrastructure.

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	authwebauthntest "github.com/wireguard-console/backend/internal/webauthntest"
)

// IPs for these tests only: the per-IP login lockout is an in-memory map in the
// API process, so each test cashes its own bucket.
const (
	emIPDefault = "198.51.100.30"
	emIPOldMail = "198.51.100.31"
	emIPNewMail = "198.51.100.32"
	emIPStepUp  = "198.51.100.33"
	emIPSelf    = "198.51.100.34"
)

// emPool opens the test database for direct assertions and registers cleanup
// that removes this file's fixtures. The shared e2e suite runs TestEndToEnd
// (which asserts absolute admin counts on a freshly wiped DB) after the files
// sorting before e2e_test.go, so every admin seeded here -- all emails start
// with "email-" -- must be gone by then. audit_logs.actor_admin_id references
// admins(id) without ON DELETE, so those rows go first.
func emPool(t *testing.T, dbURL string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close) // registered first -> runs last
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := pool.Exec(ctx,
			"DELETE FROM audit_logs WHERE actor_admin_id IN (SELECT id FROM admins WHERE email LIKE 'email-%')"); err != nil {
			t.Logf("cleanup audit_logs: %v", err)
		}
		if _, err := pool.Exec(ctx, "DELETE FROM admins WHERE email LIKE 'email-%'"); err != nil {
			t.Logf("cleanup admins: %v", err)
		}
	})
	return pool
}

func emCount(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count query %q: %v", query, err)
	}
	return n
}

func emString(t *testing.T, pool *pgxpool.Pool, query string, args ...any) string {
	t.Helper()
	var value string
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&value); err != nil {
		t.Fatalf("string query %q: %v", query, err)
	}
	return value
}

func emInt(out map[string]interface{}, key string) int {
	value, _ := out[key].(float64)
	return int(value)
}

// emAdminPayload finds one row of GET /api/admins (which exposes passkey_count).
func emAdminPayload(t *testing.T, acting *actor, adminID string) map[string]interface{} {
	t.Helper()
	var rows []map[string]interface{}
	if err := json.Unmarshal([]byte(rawGet(t, baseURL+"/api/admins", acting)), &rows); err != nil {
		t.Fatalf("GET /api/admins: %v", err)
	}
	for _, row := range rows {
		if id, _ := row["id"].(string); id == adminID {
			return row
		}
	}
	t.Fatalf("admin %s not found in GET /api/admins", adminID)
	return nil
}

// emAssertNoResetState checks the WebAuthn inventory and reset audit for a target.
func emAssertNoResetState(t *testing.T, pool *pgxpool.Pool, targetID string) {
	t.Helper()
	if n := emCount(t, pool, "SELECT count(*) FROM webauthn_credentials WHERE admin_id = $1", targetID); n != 1 {
		t.Fatalf("credentials = %d, want 1", n)
	}
	if n := emCount(t, pool, "SELECT count(*) FROM webauthn_users WHERE admin_id = $1", targetID); n != 1 {
		t.Fatalf("webauthn_users = %d, want 1", n)
	}
	if n := emCount(t, pool, "SELECT count(*) FROM audit_logs WHERE action = 'admin.passkeys_reset' AND target_id = $1", targetID); n != 0 {
		t.Fatalf("passkeys_reset audit rows = %d, want 0", n)
	}
}

// TestAdminEmailPasskeyResetRequiresConfirmation is case 1: the 409 fires before
// the step-up check, writes nothing and leaves the passkey intact.
func TestAdminEmailPasskeyResetRequiresConfirmation(t *testing.T) {
	dbURL := pkDBURL(t)
	pool := emPool(t, dbURL)

	acting, actingSecret, _, _ := pkSetupTOTPAdmin(t, dbURL, "email-reset-409-actor@console.test")
	fixture := pkEnrollPasskeyAdmin(t, dbURL, "email-reset-409-target@console.test")
	targetID := fixture.adminID
	const oldEmail = "email-reset-409-target@console.test"
	const newEmail = "email-reset-409-target-new@console.test"

	resp, out := pkDo(t, acting, emIPDefault, "PATCH", "/api/admins/"+targetID, acting.csrf, map[string]interface{}{
		"email": newEmail,
		// Deliberately no step-up proof: the confirmation gate must answer
		// first, otherwise the caller would burn its one-shot passkey stamp on
		// a request that cannot proceed.
		"code": "",
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("unconfirmed email change on passkey admin = %d %v, want 409", resp.StatusCode, out)
	}
	if code := pkCode(out); code != "passkeys_will_reset" {
		t.Fatalf("409 code = %q, want passkeys_will_reset", code)
	}
	if n := emInt(out, "passkey_count"); n < 1 {
		t.Fatalf("409 passkey_count = %v, want >= 1", out["passkey_count"])
	}

	// No writes: email unchanged, passkey rows untouched, no reset audit row.
	if got := emString(t, pool, "SELECT email FROM admins WHERE id = $1", targetID); got != oldEmail {
		t.Fatalf("email changed despite 409: %q", got)
	}
	emAssertNoResetState(t, pool, targetID)

	// The acting admin's TOTP code is still usable for the confirmed retry
	// (proof was not consumed by the 409).
	resp, out = pkDo(t, acting, emIPDefault, "PATCH", "/api/admins/"+targetID, acting.csrf, map[string]interface{}{
		"email": newEmail, "code": pkTOTPCode(t, actingSecret), "reset_passkeys": true,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("confirmed retry = %d %v, want 200", resp.StatusCode, out)
	}
}

// TestAdminEmailPasskeyResetConfirmed is cases 2 + 4: a confirmed reset changes
// the email, deletes the target's WebAuthn rows, audits the reset, and the new
// identity forces fresh enrollment while the old email no longer signs in.
func TestAdminEmailPasskeyResetConfirmed(t *testing.T) {
	dbURL := pkDBURL(t)
	pool := emPool(t, dbURL)

	acting, actingSecret, _, _ := pkSetupTOTPAdmin(t, dbURL, "email-reset-confirm-actor@console.test")
	fixture := pkEnrollPasskeyAdmin(t, dbURL, "email-reset-confirm-target@console.test")
	targetID := fixture.adminID
	const oldEmail = "email-reset-confirm-target@console.test"
	const newEmail = "email-reset-confirm-target-new@console.test"

	resp, out := pkDo(t, acting, emIPDefault, "PATCH", "/api/admins/"+targetID, acting.csrf, map[string]interface{}{
		"email": newEmail, "code": pkTOTPCode(t, actingSecret), "reset_passkeys": true,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("confirmed email change = %d %v, want 200", resp.StatusCode, out)
	}
	if pkString(out, "status") != "updated" {
		t.Fatalf("status = %v, want updated", out["status"])
	}
	if !pkBool(out, "passkeys_reset") {
		t.Fatalf("passkeys_reset = %v, want true", out["passkeys_reset"])
	}
	if n := emInt(out, "passkey_count"); n != 1 {
		t.Fatalf("response passkey_count = %v, want 1", out["passkey_count"])
	}

	if got := emString(t, pool, "SELECT email FROM admins WHERE id = $1", targetID); got != newEmail {
		t.Fatalf("email = %q, want %q", got, newEmail)
	}
	for _, table := range []string{"webauthn_credentials", "webauthn_users", "webauthn_challenges"} {
		if n := emCount(t, pool, "SELECT count(*) FROM "+table+" WHERE admin_id = $1", targetID); n != 0 {
			t.Fatalf("%s rows after reset = %d, want 0", table, n)
		}
	}

	// The reset is audited with its reason and count.
	var reason string
	var count int
	if err := pool.QueryRow(context.Background(),
		"SELECT COALESCE(metadata->>'reason', ''), COALESCE((metadata->>'count')::int, 0) FROM audit_logs WHERE action = 'admin.passkeys_reset' AND target_id = $1 ORDER BY created_at DESC LIMIT 1",
		targetID).Scan(&reason, &count); err != nil {
		t.Fatalf("load admin.passkeys_reset audit row: %v", err)
	}
	if reason != "email_change" || count != 1 {
		t.Fatalf("passkeys_reset audit = reason %q count %d, want email_change/1", reason, count)
	}

	// The admins payload reflects the cleared passkey inventory.
	row := emAdminPayload(t, acting, targetID)
	if n := emInt(row, "passkey_count"); n != 0 {
		t.Fatalf("GET /api/admins passkey_count = %v, want 0", row["passkey_count"])
	}

	// The target's old session was revoked by the admin update.
	resp, _ = pkDo(t, fixture.actor, emIPDefault, "GET", "/api/admins/me", "", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("target session after reset = %d, want 401", resp.StatusCode)
	}

	// Old email no longer resolves to an account; the new email answers the
	// password step with forced enrollment (the passkey was the only factor).
	oldResp, _ := pkDo(t, newActor(), emIPOldMail, "POST", "/api/auth/login", "", map[string]string{
		"email": oldEmail, "password": pkPassword,
	})
	if oldResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("login with old email = %d, want 401", oldResp.StatusCode)
	}
	login := pkPasswordLogin(t, newActor(), newEmail, pkPassword, emIPNewMail)
	if !pkBool(login, "pending_mfa_setup") {
		t.Fatalf("login with new email = %v, want pending_mfa_setup", login)
	}
}

// TestAdminEmailPasskeyResetPreservesTOTP is case 3: TOTP secrets and recovery
// codes are identity-independent and must survive the passkey reset.
func TestAdminEmailPasskeyResetPreservesTOTP(t *testing.T) {
	dbURL := pkDBURL(t)
	pool := emPool(t, dbURL)

	acting, actingSecret, _, _ := pkSetupTOTPAdmin(t, dbURL, "email-reset-totp-actor@console.test")
	targetAct, targetSecret, targetID, _ := pkSetupTOTPAdmin(t, dbURL, "email-reset-totp-target@console.test")

	// Give the target a real passkey too (TOTP step-up authorizes the add).
	resp, beginOut := pkDo(t, targetAct, emIPDefault, "POST", "/api/admins/me/mfa/passkeys/begin", targetAct.csrf, map[string]string{
		"code": pkTOTPCode(t, targetSecret),
	})
	expectStatus(t, resp, 200, "POST /api/admins/me/mfa/passkeys/begin")
	challengeID := pkString(beginOut, "challenge_id")
	options := beginOut["options"]
	rpID := pkString(beginOut, "rp_id")
	if challengeID == "" || options == nil || rpID == "" {
		t.Fatalf("add-passkey begin incomplete: %v", beginOut)
	}
	authenticator, err := authwebauthntest.New()
	if err != nil {
		t.Fatalf("virtual authenticator: %v", err)
	}
	registration, err := authenticator.RegistrationResponse(options, pkOriginFor(rpID), rpID)
	if err != nil {
		t.Fatalf("RegistrationResponse: %v", err)
	}
	resp, finishOut := pkDo(t, targetAct, emIPDefault, "POST", "/api/admins/me/mfa/passkeys/finish", targetAct.csrf, map[string]interface{}{
		"challenge_id": challengeID,
		"credential":   registration,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("add-passkey finish = %d %v, want 200", resp.StatusCode, finishOut)
	}
	if n := emCount(t, pool, "SELECT count(*) FROM webauthn_credentials WHERE admin_id = $1", targetID); n != 1 {
		t.Fatalf("credentials after add = %d, want 1", n)
	}
	// TOTP enrollment generated recovery codes; both must survive the reset.
	if n := emCount(t, pool, "SELECT COALESCE(array_length(backup_codes_hash, 1), 0) FROM admins WHERE id = $1", targetID); n != 10 {
		t.Fatalf("recovery codes before reset = %d, want 10", n)
	}

	resp, out := pkDo(t, acting, emIPDefault, "PATCH", "/api/admins/"+targetID, acting.csrf, map[string]interface{}{
		"email": "email-reset-totp-target-new@console.test", "code": pkTOTPCode(t, actingSecret), "reset_passkeys": true,
	})
	if resp.StatusCode != http.StatusOK || !pkBool(out, "passkeys_reset") {
		t.Fatalf("confirmed email change = %d %v, want 200 + passkeys_reset", resp.StatusCode, out)
	}

	// TOTP + recovery codes untouched, passkeys gone.
	var totpEnabled bool
	if err := pool.QueryRow(context.Background(), "SELECT totp_enabled FROM admins WHERE id = $1", targetID).Scan(&totpEnabled); err != nil {
		t.Fatalf("load totp_enabled: %v", err)
	}
	if !totpEnabled {
		t.Fatal("TOTP was disabled by the passkey reset")
	}
	if n := emCount(t, pool, "SELECT COALESCE(array_length(backup_codes_hash, 1), 0) FROM admins WHERE id = $1", targetID); n != 10 {
		t.Fatalf("recovery codes after reset = %d, want 10 (must be preserved)", n)
	}
	if n := emCount(t, pool, "SELECT count(*) FROM webauthn_credentials WHERE admin_id = $1", targetID); n != 0 {
		t.Fatalf("credentials after reset = %d, want 0", n)
	}
	row := emAdminPayload(t, acting, targetID)
	if !pkBool(row, "totp_enabled") {
		t.Fatalf("GET /api/admins totp_enabled = %v, want true", row["totp_enabled"])
	}
	if n := emInt(row, "passkey_count"); n != 0 {
		t.Fatalf("GET /api/admins passkey_count = %v, want 0", row["passkey_count"])
	}
	if methods := pkStringList(row, "mfa_methods"); !pkHasString(methods, "totp") {
		t.Fatalf("mfa_methods = %v, want totp preserved", methods)
	}
}

// TestAdminEmailChangeWithoutPasskeys is case 5: the legacy path is unchanged and
// never returns the reset fields when there is nothing to reset.
func TestAdminEmailChangeWithoutPasskeys(t *testing.T) {
	dbURL := pkDBURL(t)
	pool := emPool(t, dbURL)

	acting, actingSecret, _, _ := pkSetupTOTPAdmin(t, dbURL, "email-plain-actor@console.test")
	targetID := pkSeedAdmin(t, dbURL, "email-plain-target@console.test", "admin")
	const newEmail = "email-plain-target-new@console.test"

	resp, out := pkDo(t, acting, emIPDefault, "PATCH", "/api/admins/"+targetID, acting.csrf, map[string]interface{}{
		"email": newEmail, "code": pkTOTPCode(t, actingSecret),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("plain email change = %d %v, want 200", resp.StatusCode, out)
	}
	if pkString(out, "status") != "updated" {
		t.Fatalf("status = %v, want updated", out["status"])
	}
	if _, has := out["passkeys_reset"]; has {
		t.Fatalf("plain email change returned passkeys_reset: %v", out)
	}
	if got := emString(t, pool, "SELECT email FROM admins WHERE id = $1", targetID); got != newEmail {
		t.Fatalf("email = %q, want %q", got, newEmail)
	}
}

// TestAdminEmailPasskeyResetFlagNoOpWhenEmailUnchanged is case 6: the flag only
// applies to an actual email change.
func TestAdminEmailPasskeyResetFlagNoOpWhenEmailUnchanged(t *testing.T) {
	dbURL := pkDBURL(t)
	pool := emPool(t, dbURL)

	acting, actingSecret, _, _ := pkSetupTOTPAdmin(t, dbURL, "email-noop-actor@console.test")
	fixture := pkEnrollPasskeyAdmin(t, dbURL, "email-noop-target@console.test")
	targetID := fixture.adminID
	const email = "email-noop-target@console.test"

	resp, out := pkDo(t, acting, emIPDefault, "PATCH", "/api/admins/"+targetID, acting.csrf, map[string]interface{}{
		"email": email, "code": pkTOTPCode(t, actingSecret), "reset_passkeys": true,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unchanged-email PATCH = %d %v, want 200", resp.StatusCode, out)
	}
	if _, has := out["passkeys_reset"]; has {
		t.Fatalf("unchanged email returned passkeys_reset: %v", out)
	}
	if n := emCount(t, pool, "SELECT count(*) FROM webauthn_credentials WHERE admin_id = $1", targetID); n != 1 {
		t.Fatalf("credentials after unchanged-email PATCH = %d, want 1", n)
	}
	if n := emCount(t, pool, "SELECT count(*) FROM webauthn_users WHERE admin_id = $1", targetID); n != 1 {
		t.Fatalf("webauthn_users after unchanged-email PATCH = %d, want 1", n)
	}
}

// TestAdminEmailSelfPasskeyReset: the same rules apply when an admin edits
// their own email; the reset deletes their passkeys and the acting session
// survives.
func TestAdminEmailSelfPasskeyReset(t *testing.T) {
	dbURL := pkDBURL(t)
	pool := emPool(t, dbURL)

	fixture := pkEnrollPasskeyAdmin(t, dbURL, "email-self@console.test")
	selfID := fixture.adminID
	act := fixture.actor
	const oldEmail = "email-self@console.test"
	const newEmail = "email-self-new@console.test"

	// Unconfirmed self edit is refused before any step-up is consumed.
	resp, out := pkDo(t, act, emIPSelf, "PATCH", "/api/admins/"+selfID, act.csrf, map[string]interface{}{
		"email": newEmail, "code": "",
	})
	if resp.StatusCode != http.StatusConflict || pkCode(out) != "passkeys_will_reset" {
		t.Fatalf("unconfirmed self email change = %d %v, want 409 passkeys_will_reset", resp.StatusCode, out)
	}
	if got := emString(t, pool, "SELECT email FROM admins WHERE id = $1", selfID); got != oldEmail {
		t.Fatalf("email changed despite 409: %q", got)
	}

	// Complete a passkey step-up (passkey-only account, so no typed code is
	// possible) and retry with the confirmation flag and the one-shot stamp.
	resp, beginOut := pkDo(t, act, emIPStepUp, "POST", "/api/auth/mfa/stepup/passkey/begin", act.csrf, nil)
	expectStatus(t, resp, 200, "POST /api/auth/mfa/stepup/passkey/begin")
	challengeID := pkString(beginOut, "challenge_id")
	options := beginOut["options"]
	rpID := pkString(beginOut, "rp_id")
	assertion, err := fixture.authenticator.AssertionResponse(options, pkOriginFor(rpID), rpID, nil)
	if err != nil {
		t.Fatalf("AssertionResponse: %v", err)
	}
	resp, stepOut := pkDo(t, act, emIPStepUp, "POST", "/api/auth/mfa/stepup/passkey/finish", act.csrf, map[string]interface{}{
		"challenge_id": challengeID,
		"credential":   assertion,
	})
	expectStatus(t, resp, 200, "POST /api/auth/mfa/stepup/passkey/finish")
	if pkString(stepOut, "status") != "verified" {
		t.Fatalf("step-up status = %v, want verified", stepOut["status"])
	}

	resp, out = pkDo(t, act, emIPSelf, "PATCH", "/api/admins/"+selfID, act.csrf, map[string]interface{}{
		"email": newEmail, "code": "", "reset_passkeys": true,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("confirmed self email change = %d %v, want 200", resp.StatusCode, out)
	}
	if !pkBool(out, "passkeys_reset") || emInt(out, "passkey_count") != 1 {
		t.Fatalf("confirmed self email change body = %v, want passkeys_reset/1", out)
	}

	if got := emString(t, pool, "SELECT email FROM admins WHERE id = $1", selfID); got != newEmail {
		t.Fatalf("self email = %q, want %q", got, newEmail)
	}
	if n := emCount(t, pool, "SELECT count(*) FROM webauthn_credentials WHERE admin_id = $1", selfID); n != 0 {
		t.Fatalf("credentials after self reset = %d, want 0", n)
	}
	// The acting (current) session survives a self edit.
	resp, _ = pkDo(t, act, emIPSelf, "GET", "/api/admins/me", "", nil)
	expectStatus(t, resp, 200, "GET /api/admins/me after self reset")

	// The account now has no factor: next password login forces enrollment.
	login := pkPasswordLogin(t, newActor(), newEmail, pkPassword, emIPNewMail)
	if !pkBool(login, "pending_mfa_setup") {
		t.Fatalf("login after self reset = %v, want pending_mfa_setup", login)
	}
}
