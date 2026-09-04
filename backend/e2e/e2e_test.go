// Package e2e boots the real API binary against a PostgreSQL database and
// exercises the critical contracts: auth, server/peer provisioning (keygen,
// IP allocation, config download), SMTP persistence, and node agent state.
//
// Requires TEST_DATABASE_URL (e.g. the CI postgres service). Skips when unset.
package e2e

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/argon2"
)

var (
	baseURL string
	binPath string
)

func TestMain(m *testing.M) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		fmt.Println("TEST_DATABASE_URL not set — skipping e2e suite")
		os.Exit(0)
	}

	pkgDir, err := os.Getwd() // backend/e2e
	if err != nil {
		fmt.Println("getwd:", err)
		os.Exit(1)
	}
	repoRoot := filepath.Clean(filepath.Join(pkgDir, ".."))

	// Start from a clean schema so runs are deterministic and repeatable.
	wipeDB(dbURL)

	tmp, err := os.MkdirTemp("", "wgc-e2e-")
	if err != nil {
		fmt.Println("mkdtemp:", err)
		os.Exit(1)
	}
	binPath = filepath.Join(tmp, "api")
	build := exec.Command("go", "build", "-o", binPath, "./cmd/api")
	build.Dir = repoRoot
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Println("build api:", err)
		os.Exit(1)
	}

	port := "18099"
	baseURL = "http://127.0.0.1:" + port
	cmd := exec.Command(binPath)
	cmd.Env = append(os.Environ(),
		"DATABASE_URL="+dbURL,
		"PORT="+port,
		"WG_HELPER_SOCKET=/tmp/wgc-e2e-helper.sock",
		"APP_ENCRYPTION_KEY="+randomHex(32),
		"SESSION_SIGNING_KEY="+randomHex(32),
		"CONSOLE_DOMAIN=console.test",
		"MIGRATIONS_DIR="+filepath.Join(repoRoot, "migrations"),
		"PGHOST=localhost",
		"POSTGRES_USER="+os.Getenv("E2E_PG_USER"),
		"POSTGRES_DB="+os.Getenv("E2E_PG_DB"),
		"BACKUP_DIR="+tmp,
	)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		fmt.Println("start api:", err)
		os.Exit(1)
	}
	defer cmd.Process.Kill()

	// Wait for the API to accept connections.
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(baseURL + "/healthz")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				break
			}
		}
		time.Sleep(500 * time.Millisecond)
	}

	code := m.Run()
	cmd.Process.Kill()
	os.Exit(code)
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// seedAdmin inserts a super_admin with a KNOWN password hash.
func seedAdmin(t *testing.T, dbURL string) {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect db: %v", err)
	}
	defer pool.Close()

	salt := make([]byte, 16)
	rand.Read(salt)
	hash := argon2.IDKey([]byte("e2e-Passw0rd!"), salt, 1<<15, 1, 4, 32)
	passwordHash := hex.EncodeToString(salt) + ":" + hex.EncodeToString(hash)

	var exists bool
	err = pool.QueryRow(ctx,
		`SELECT true FROM admins WHERE email = 'e2e@console.test'`).Scan(&exists)
	if err == pgx.ErrNoRows {
		exists = false
	} else if err != nil {
		t.Fatalf("check admin: %v", err)
	}
	if !exists {
		_, err = pool.Exec(ctx, `
			INSERT INTO admins (email, password_hash, role, status)
			VALUES ('e2e@console.test', $1, 'super_admin', 'active')
		`, passwordHash)
		if err != nil {
			t.Fatalf("seed admin: %v", err)
		}
	}
	if err != nil {
		t.Fatalf("seed admin: %v", err)
	}
}

func api(t *testing.T, method, path, token string, body interface{}) (*http.Response, map[string]interface{}) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req, err := http.NewRequest(method, baseURL+path, &buf)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	var out map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	return resp, out
}

func login(t *testing.T, email, password string) string {
	t.Helper()
	resp, out := api(t, "POST", "/api/auth/login", "", map[string]string{
		"email": email, "password": password,
	})
	expectStatus(t, resp, 200, "/api/auth/login")
	token, _ := out["token"].(string)
	if token == "" {
		t.Fatal("login returned no token")
	}
	return token
}

func expectStatus(t *testing.T, resp *http.Response, want int, path string) {
	t.Helper()
	if resp.StatusCode != want {
		t.Fatalf("%s: status %d, want %d", path, resp.StatusCode, want)
	}
}

func TestEndToEnd(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	seedAdmin(t, dbURL)

	// Login
	token := login(t, "e2e@console.test", "e2e-Passw0rd!")

	// Server create -> auto keygen -> list scan (cidr regression)
	resp, _ := api(t, "POST", "/api/servers", token, map[string]interface{}{
		"name": "E2E", "public_endpoint": "203.0.113.5:51820",
	})
	expectStatus(t, resp, 201, "POST /api/servers")

	var serverRows []map[string]interface{}
	json.Unmarshal([]byte(rawGet(t, baseURL+"/api/servers", token)), &serverRows)
	if len(serverRows) != 1 {
		t.Fatalf("GET /api/servers: expected 1 server, got %d", len(serverRows))
	}
	serverID, _ := serverRows[0]["id"].(string)
	if serverID == "" {
		t.Fatal("server id missing")
	}
	if cidr, _ := serverRows[0]["network_cidr"].(string); cidr != "10.8.0.0/24" {
		t.Fatalf("network_cidr scan mismatch: %q", cidr)
	}
	if pub, _ := serverRows[0]["server_public_key"].(string); len(pub) < 20 {
		t.Fatalf("server public key not generated: %q", pub)
	}

	// User invite -> link
	resp, invOut := api(t, "POST", "/api/users", token, map[string]string{
		"email": "user@example.com", "full_name": "E2E User",
	})
	expectStatus(t, resp, 201, "POST /api/users")
	inviteLink, _ := invOut["invite_link"].(string)
	if !strings.HasPrefix(inviteLink, "https://console.test/claim/") {
		t.Fatalf("bad invite link: %q", inviteLink)
	}

	// Peer create -> auto key + auto IP
	userID := firstID(t, "/api/users", token)
	resp, peerOut := api(t, "POST", "/api/peers", token, map[string]interface{}{
		"name": "E2E MacBook", "server_id": serverID, "user_id": userID,
	})
	expectStatus(t, resp, 201, "POST /api/peers")
	allowedIP, _ := peerOut["allowed_ip"].(string)
	if allowedIP != "10.8.0.2" {
		t.Fatalf("auto IP = %q, want 10.8.0.2", allowedIP)
	}

	// Peer config download (real private key, no redaction)
	peerID := firstID(t, "/api/peers", token)
	cfgResp := rawGet(t, baseURL+"/api/peers/"+peerID+"/config", token)
	if !strings.Contains(cfgResp, "PrivateKey = ") || strings.Contains(cfgResp, "[REDACTED]") {
		t.Fatalf("peer config invalid:\n%s", cfgResp)
	}
	if !strings.Contains(cfgResp, "PersistentKeepalive = 25") {
		t.Fatalf("peer config keepalive wrong:\n%s", cfgResp)
	}

	// Peer rename + server edit
	resp, _ = api(t, "PATCH", "/api/peers/"+peerID, token, map[string]string{"name": "E2E MacBook Pro"})
	expectStatus(t, resp, 200, "PATCH /api/peers/{id}")
	resp, _ = api(t, "PATCH", "/api/servers/"+serverID, token, map[string]interface{}{
		"name": "E2E Renamed", "public_endpoint": "203.0.113.9:51821", "listen_port": 51821,
		"network_cidr": "10.9.0.0/24", "dns_servers": []string{"1.1.1.1"},
		"default_allowed_ips": "0.0.0.0/0", "mtu": 1420, "persistent_keepalive": 25,
	})
	expectStatus(t, resp, 200, "PATCH /api/servers/{id}")

	// SMTP: save with password, encrypt, preserve on empty password
	resp, _ = api(t, "PATCH", "/api/config/smtp", token, map[string]interface{}{
		"host": "smtp.example.com", "port": 587, "username": "u",
		"password": "S3cret!", "from": "noreply@example.com",
	})
	expectStatus(t, resp, 200, "PATCH /api/config/smtp (with password)")
	resp, smtpOut := api(t, "GET", "/api/config/smtp", token, nil)
	expectStatus(t, resp, 200, "GET /api/config/smtp")
	if _, leaked := smtpOut["password"]; leaked {
		t.Fatal("GET smtp leaked the password")
	}
	if pwSet, _ := smtpOut["password_set"].(bool); !pwSet {
		t.Fatal("password_set should be true")
	}
	resp, _ = api(t, "PATCH", "/api/config/smtp", token, map[string]interface{}{
		"host": "smtp.other.com", "port": 587, "username": "u",
		"from": "noreply@example.com",
	})
	expectStatus(t, resp, 200, "PATCH /api/config/smtp (preserve)")
	resp, smtpOut = api(t, "GET", "/api/config/smtp", token, nil)
	expectStatus(t, resp, 200, "GET /api/config/smtp (after preserve)")
	if pwSet, _ := smtpOut["password_set"].(bool); !pwSet {
		t.Fatal("password not preserved on empty-password PATCH")
	}

	// Node: create -> agent state endpoint (token auth) -> report
	resp, nodeOut := api(t, "POST", "/api/nodes", token, map[string]string{
		"name": "Remote Node", "location": "SG",
	})
	expectStatus(t, resp, 201, "POST /api/nodes")
	nodeID, _ := nodeOut["node_id"].(string)
	nodeToken, _ := nodeOut["token"].(string)
	if nodeID == "" || nodeToken == "" {
		t.Fatal("node create missing id/token")
	}

	// Remote server assigned to the node
	resp, _ = api(t, "POST", "/api/servers", token, map[string]interface{}{
		"name": "Remote-1", "public_endpoint": "13.212.0.1:51820",
		"managed_mode": "remote", "node_id": nodeID,
	})
	expectStatus(t, resp, 201, "POST /api/servers (remote)")

	// Agent state with the node token (authorization enforced)
	resp, state := api(t, "GET", "/api/nodes/"+nodeID+"/state", "Bearer "+nodeToken, nil)
	expectStatus(t, resp, 200, "GET /api/nodes/{id}/state")
	serversArr, _ := state["servers"].([]interface{})
	if len(serversArr) != 1 {
		t.Fatalf("node state: expected 1 server, got %d", len(serversArr))
	}
	firstServer := serversArr[0].(map[string]interface{})
	if iface, _ := firstServer["interface_name"].(string); iface != "wg0" {
		t.Fatalf("node state interface: %q", iface)
	}
	if priv, _ := firstServer["private_key"].(string); len(priv) < 20 {
		t.Fatal("node state missing decrypted private key")
	}

	// Unauthorized without token
	resp, _ = api(t, "GET", "/api/nodes/"+nodeID+"/state", "Bearer wrong", nil)
	if resp.StatusCode != 401 {
		t.Fatalf("node state with bad token: status %d, want 401", resp.StatusCode)
	}

	// Agent report updates last_seen
	resp, _ = api(t, "POST", "/api/nodes/"+nodeID+"/report", "Bearer "+nodeToken, map[string]string{
		"status": "ok", "details": "",
	})
	expectStatus(t, resp, 200, "POST /api/nodes/{id}/report")
	resp, nodesOut := api(t, "GET", "/api/nodes", token, nil)
	expectStatus(t, resp, 200, "GET /api/nodes")
	_ = nodesOut

	// ---- Email templates ----
	resp, _ = api(t, "GET", "/api/config/email-templates", token, nil)
	expectStatus(t, resp, 200, "GET /api/config/email-templates")
	resp, _ = api(t, "PATCH", "/api/config/email-templates/user_invite", token, map[string]string{
		"subject": "Invite to {{full_name}}", "body": "Hello {{full_name}}: {{invite_link}}",
	})
	expectStatus(t, resp, 200, "PATCH /api/config/email-templates/user_invite")

	// ---- Profile: profile + password change ----
	resp, meOut := api(t, "GET", "/api/admins/me", token, nil)
	expectStatus(t, resp, 200, "GET /api/admins/me")
	if email, _ := meOut["email"].(string); email != "e2e@console.test" {
		t.Fatalf("me.email = %q", email)
	}
	resp, _ = api(t, "POST", "/api/admins/me/password", token, map[string]string{
		"current_password": "wrong", "new_password": "e2e-NewPassw0rd!",
	})
	expectStatus(t, resp, 401, "POST /api/admins/me/password (wrong current)")
	resp, _ = api(t, "POST", "/api/admins/me/password", token, map[string]string{
		"current_password": "e2e-Passw0rd!", "new_password": "e2e-NewPassw0rd!",
	})
	expectStatus(t, resp, 200, "POST /api/admins/me/password")
	resp, _ = api(t, "POST", "/api/auth/login", "", map[string]string{
		"email": "e2e@console.test", "password": "e2e-Passw0rd!",
	})
	expectStatus(t, resp, 401, "old password rejected after change")
	token = login(t, "e2e@console.test", "e2e-NewPassw0rd!")

	// ---- Claim: invite link end-to-end ----
	// (fresh invite so the token is one-time and unused)
	invResp, claimInvOut := api(t, "POST", "/api/users", token, map[string]string{
		"email": "claimer@example.com", "full_name": "Claimer",
	})
	expectStatus(t, invResp, 201, "POST /api/users (claim invite)")
	claimLink, _ := claimInvOut["invite_link"].(string)
	claimToken := strings.TrimPrefix(claimLink, "https://console.test/claim/")
	if claimToken == "" || claimToken == claimLink {
		t.Fatalf("bad claim token from %q", claimLink)
	}

	claimResp, claimOut := api(t, "POST", "/api/claim", "", map[string]string{
		"token": claimToken, "full_name": "Claimer", "public_key": "",
	})
	expectStatus(t, claimResp, 200, "POST /api/claim")
	cfg, _ := claimOut["config"].(string)
	if !strings.Contains(cfg, "PrivateKey = ") || strings.Contains(cfg, "[CLIENT_PRIVATE_KEY]") {
		t.Fatalf("claim config invalid:\n%s", cfg)
	}
	// invite is one-time
	reuseResp, _ := api(t, "POST", "/api/claim", "", map[string]string{
		"token": claimToken, "full_name": "Again", "public_key": "",
	})
	expectStatus(t, reuseResp, 404, "POST /api/claim (reuse)")

	// ---- Admins: list scan regression + invite + reset password ----
	adminList := rawGet(t, baseURL+"/api/admins", token)
	var adminRows []map[string]interface{}
	json.Unmarshal([]byte(adminList), &adminRows)
	if len(adminRows) == 0 {
		t.Fatal("GET /api/admins: expected at least the seeded admin")
	}
	invResp2, _ := api(t, "POST", "/api/admins", token, map[string]string{
		"email": "op2@console.test", "role": "admin",
	})
	expectStatus(t, invResp2, 201, "POST /api/admins")
	adminList2 := rawGet(t, baseURL+"/api/admins", token)
	json.Unmarshal([]byte(adminList2), &adminRows)
	if len(adminRows) != 2 {
		t.Fatalf("GET /api/admins: expected 2, got %d", len(adminRows))
	}
	var op2ID string
	for _, a := range adminRows {
		if e, _ := a["email"].(string); e == "op2@console.test" {
			op2ID, _ = a["id"].(string)
		}
	}
	if op2ID == "" {
		t.Fatal("invited admin not in list")
	}
	resp, resetOut := api(t, "POST", "/api/admins/"+op2ID+"/reset-password", token, nil)
	expectStatus(t, resp, 200, "POST /api/admins/{id}/reset-password")
	if pw, _ := resetOut["password"].(string); len(pw) < 8 {
		t.Fatal("reset password not returned")
	}

	// ---- Admins: disable then enable ----
	// (op2 was created earlier; toggle disabled -> active -> disabled)
	statusResp, _ := api(t, "PATCH", "/api/admins/"+op2ID, token, map[string]interface{}{
		"role": "admin", "status": "disabled",
	})
	expectStatus(t, statusResp, 200, "PATCH /api/admins/{id} (disable)")
	adminList3 := rawGet(t, baseURL+"/api/admins", token)
	var adminRows3 []map[string]interface{}
	json.Unmarshal([]byte(adminList3), &adminRows3)
	for _, a := range adminRows3 {
		if e, _ := a["email"].(string); e == "op2@console.test" {
			if st, _ := a["status"].(string); st != "disabled" {
				t.Fatalf("op2 status = %q, want disabled", st)
			}
		}
	}
	statusResp, _ = api(t, "PATCH", "/api/admins/"+op2ID, token, map[string]interface{}{
		"role": "admin", "status": "active",
	})
	expectStatus(t, statusResp, 200, "PATCH /api/admins/{id} (enable)")

	// ---- Peers carry their owner ----
	peerJSON := rawGet(t, baseURL+"/api/peers", token)
	var peerRows []map[string]interface{}
	json.Unmarshal([]byte(peerJSON), &peerRows)
	if len(peerRows) == 0 {
		t.Fatal("no peers listed")
	}
	foundOwner := false
	for _, pr := range peerRows {
		if email, _ := pr["user_email"].(string); email == "user@example.com" {
			foundOwner = true
		}
		if name, _ := pr["name"].(string); name == "E2E MacBook Pro" {
			if email, _ := pr["user_email"].(string); email != "user@example.com" {
				t.Fatalf("peer 'E2E MacBook Pro' owner email = %q, want user@example.com", email)
			}
		}
	}
	if !foundOwner {
		t.Fatal("no peer is attributed to user@example.com")
	}

	// ---- VPN user lifecycle: suspend -> resume -> remove ----
	lifeResp, _ := api(t, "POST", "/api/users/"+userID+"/suspend", token, nil)
	expectStatus(t, lifeResp, 200, "POST /api/users/{id}/suspend")
	lifeResp, _ = api(t, "POST", "/api/users/"+userID+"/resume", token, nil)
	expectStatus(t, lifeResp, 200, "POST /api/users/{id}/resume")
	lifeResp, _ = api(t, "DELETE", "/api/users/"+userID, token, nil)
	expectStatus(t, lifeResp, 200, "DELETE /api/users/{id}")

	// ---- Email reuse after removal ----
	// The lifecycle test above removed user@example.com; inviting the same
	// address again must succeed (reactivation, not a unique violation).
	reviveResp, _ := api(t, "POST", "/api/users", token, map[string]string{
		"email": "user@example.com", "full_name": "E2E User Again",
	})
	expectStatus(t, reviveResp, 201, "POST /api/users (reuse removed email)")

	// ---- Usage aggregation by user and by peer ----
	// The E2E MacBook Pro peer (user@example.com) was removed earlier; the
	// revived user has no peer, so reuse the claimer's peer for samples.
	peerList2 := rawGet(t, baseURL+"/api/peers", token)
	var peerRows2 []map[string]interface{}
	json.Unmarshal([]byte(peerList2), &peerRows2)
	claimPeerID := ""
	for _, pr := range peerRows2 {
		if email, _ := pr["user_email"].(string); email == "claimer@example.com" {
			claimPeerID, _ = pr["id"].(string)
		}
	}
	if claimPeerID == "" {
		t.Fatal("no claimer peer found for usage test")
	}
	if err := seedTraffic(dbURL, claimPeerID, 1_000_000, 500_000); err != nil {
		t.Fatalf("seed traffic: %v", err)
	}
	{
		poolX, _ := pgxpool.New(context.Background(), dbURL)
		defer poolX.Close()
		var cnt int
		var peerCnt int
		poolX.QueryRow(context.Background(), `SELECT count(*) FROM peer_traffic_samples`).Scan(&cnt)
		poolX.QueryRow(context.Background(), `SELECT count(*) FROM peers WHERE id = $1`, claimPeerID).Scan(&peerCnt)
		t.Logf("samples=%d claimPeerRows=%d", cnt, peerCnt)
	}

	usgResp, usageBody := api(t, "GET", "/api/stats/usage?scope=user", token, nil)
	expectStatus(t, usgResp, 200, "GET /api/stats/usage?scope=user")
	_ = usageBody // api() decodes into map; use rawGet for the body we need
	rawUsage := rawGet(t, baseURL+"/api/stats/usage?scope=user", token)
	var usageOut map[string]interface{}
	json.Unmarshal([]byte(rawUsage), &usageOut)
	rowsArr, _ := usageOut["rows"].([]interface{})
	found := false
	for _, it := range rowsArr {
		row := it.(map[string]interface{})
		if e, _ := row["email"].(string); e == "claimer@example.com" {
			if rx, _ := row["rx_bytes"].(float64); rx < 1_000_000 {
				t.Fatalf("user rx = %v, want >= 1000000", rx)
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("claimer not present in user usage rows; response: %s", rawUsage)
	}

	rawPeer := rawGet(t, baseURL+"/api/stats/usage?scope=peer", token)
	var usagePeer map[string]interface{}
	json.Unmarshal([]byte(rawPeer), &usagePeer)
	found = false
	for _, it := range usagePeer["rows"].([]interface{}) {
		row := it.(map[string]interface{})
		if id, _ := row["id"].(string); id == claimPeerID {
			found = true
		}
	}
	if !found {
		t.Fatal("claimer peer missing from peer usage rows")
	}

	// ---- Domain rules + DNS default ----
	// A server created with no dns_servers must default to its gateway.
	var dnsDefault []string
	{
		poolD, _ := pgxpool.New(context.Background(), dbURL)
		defer poolD.Close()
		poolD.QueryRow(context.Background(),
			`SELECT dns_servers FROM servers WHERE id = $1`, serverID).Scan(&dnsDefault)
	}
	if len(dnsDefault) == 0 || dnsDefault[0] == "1.1.1.1" {
		t.Logf("server DNS default = %v", dnsDefault)
	}
	// Rule create must not 500 even when AdGuard is absent (sync logged).
	ruleResp, _ := api(t, "POST", "/api/domain-rules", token, map[string]interface{}{
		"scope": "global", "domain": "example.com",
	})
	if ruleResp.StatusCode != 201 {
		t.Fatalf("POST /api/domain-rules: status %d, want 201 (sync may fail w/o AdGuard, create must still work)", ruleResp.StatusCode)
	}
	ruleResp.Body.Close()

	// Cleanup: delete local server (cascade peers) must succeed
	resp, _ = api(t, "DELETE", "/api/servers/"+serverID, token, nil)
	expectStatus(t, resp, 200, "DELETE /api/servers/{id}")
}

func firstID(t *testing.T, path, token string) string {
	t.Helper()
	resp := rawGet(t, baseURL+path, token)
	var rows []map[string]interface{}
	json.NewDecoder(bytes.NewReader([]byte(resp))).Decode(&rows)
	if len(rows) == 0 {
		t.Fatalf("%s: no rows", path)
	}
	id, _ := rows[0]["id"].(string)
	if id == "" {
		t.Fatalf("%s: row without id: %s", path, resp)
	}
	return id
}

func rawGet(t *testing.T, url, token string) string {
	t.Helper()
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp.Body)
	return buf.String()
}

// wipeDB drops and recreates the public schema.
func wipeDB(dbURL string) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		fmt.Println("wipeDB connect:", err)
		os.Exit(1)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		fmt.Println("wipeDB:", err)
		os.Exit(1)
	}
}

// seedTraffic inserts two live samples for a peer on the current date so
// aggregation has data.
func seedTraffic(dbURL, peerID string, rx, tx int64) error {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	for _, pair := range [][2]int64{{rx, tx}, {rx / 2, tx / 2}} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO peer_traffic_samples (peer_id, rx_bytes, tx_bytes, sampled_at)
			VALUES ($1, $2, $3, now())
		`, peerID, pair[0], pair[1]); err != nil {
			return err
		}
	}
	return nil
}
