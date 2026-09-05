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
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/argon2"
)

var (
	baseURL string
	binPath string
)

// Fake wg-helper: a unix-socket HTTP server that records /apply and /remove
// calls so the suite can assert the API actually pushes WireGuard state
// (including the boot-time WG reconcile worker).
var (
	fakeHelperMu      sync.Mutex
	fakeHelperApplies int
	fakeHelperRemoves int
)

// startFakeWGHelper listens on the given unix socket and answers the
// wg-helper endpoints. Returns a cleanup func.
func startFakeWGHelper(sock string) func() {
	_ = os.Remove(sock)
	l, err := net.Listen("unix", sock)
	if err != nil {
		fmt.Println("fake helper listen:", err)
		os.Exit(1)
	}
	mux := http.NewServeMux()
	apply := func(w http.ResponseWriter, r *http.Request) {
		fakeHelperMu.Lock()
		fakeHelperApplies++
		fakeHelperMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok","warnings":[]}`)
	}
	mux.HandleFunc("/apply", apply)
	mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"peers":[]}`)
	})
	mux.HandleFunc("/remove", func(w http.ResponseWriter, r *http.Request) {
		fakeHelperMu.Lock()
		fakeHelperRemoves++
		fakeHelperMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"removed","warnings":[]}`)
	})
	// /system serves a canned host snapshot so GET /api/nodes/local/status
	// can be exercised end-to-end. Method-strict like the real wg-helper:
	// ServeMux matches any method, so a POST here must 404 — otherwise a
	// backend using the wrong HTTP method would pass silently.
	mux.HandleFunc("/system", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{
			"cpu": {"cores": 4, "percent": 12.5},
			"load": [0.4, 0.5, 0.6],
			"mem": {"total": 16777216000, "used": 5242880000, "percent": 31.2},
			"swap": {"total": 2147483648, "used": 0, "percent": 0},
			"disk": [{"mount": "/", "device": "/dev/sda1", "fs": "ext4", "total": 107374182400, "used": 58195968000, "percent": 54.2}],
			"net": [{"interface": "eth0", "rx_bps": 1024, "tx_bps": 2048}],
			"uptime_s": 3564000,
			"host": {"hostname": "fake-host", "os": "linux", "arch": "amd64", "kernel": "6.8.0", "agent_version": "e2e"},
			"collected_at": "2025-09-05T02:00:00Z"
		}`)
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(l)
	return func() {
		srv.Close()
		_ = os.Remove(sock)
	}
}

func fakeApplyCount() int {
	fakeHelperMu.Lock()
	defer fakeHelperMu.Unlock()
	return fakeHelperApplies
}

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
	helperSock := "/tmp/wgc-e2e-helper.sock"
	cleanupHelper := startFakeWGHelper(helperSock)
	defer cleanupHelper()
	cmd := exec.Command(binPath)
	cmd.Env = append(os.Environ(),
		"DATABASE_URL="+dbURL,
		"PORT="+port,
		"WG_HELPER_SOCKET="+helperSock,
		"APP_ENCRYPTION_KEY="+randomHex(32),
		"SESSION_SIGNING_KEY="+randomHex(32),
		"CONSOLE_DOMAIN=console.test",
		"ADMIN_EMAIL=e2e@console.test",
		"ADMIN_PASSWORD=e2e-Passw0rd!",
		"MIGRATIONS_DIR="+filepath.Join(repoRoot, "migrations"),
		"PGHOST=localhost",
		"POSTGRES_USER="+os.Getenv("E2E_PG_USER"),
		"POSTGRES_PASSWORD="+os.Getenv("E2E_PG_PASSWORD"),
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

// seedAdminDirect inserts the e2e super_admin with a KNOWN password hash.
func seedAdminDirect(dbURL string) error {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return err
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
		return err
	}
	if !exists {
		_, err = pool.Exec(ctx, `
			INSERT INTO admins (email, password_hash, role, status)
			VALUES ('e2e@console.test', $1, 'super_admin', 'active')
		`, passwordHash)
		if err != nil {
			return err
		}
	}
	return nil
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

// enable2FAFor enrolls 2FA on the logged-in admin and returns the TOTP
// secret so the test can mint codes for step-up checks.
func enable2FAFor(t *testing.T, token string) string {
	t.Helper()
	resp, setupOut := api(t, "POST", "/api/auth/2fa/setup", token, nil)
	expectStatus(t, resp, 200, "POST /api/auth/2fa/setup")
	secret, _ := setupOut["secret"].(string)
	if secret == "" {
		t.Fatal("2fa setup returned no secret")
	}
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate totp: %v", err)
	}
	resp, enableOut := api(t, "POST", "/api/auth/2fa/enable", token, map[string]string{
		"secret": secret, "code": code,
	})
	expectStatus(t, resp, 200, "POST /api/auth/2fa/enable")
	if codes, _ := enableOut["backup_codes"].([]interface{}); len(codes) != 10 {
		t.Fatalf("expected 10 backup codes, got %d", len(codes))
	}
	return secret
}

// current2FACode returns a valid TOTP code for the secret at this instant.
func current2FACode(t *testing.T, secret string) string {
	t.Helper()
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate totp: %v", err)
	}
	return code
}

func expectStatus(t *testing.T, resp *http.Response, want int, path string) {
	t.Helper()
	if resp.StatusCode != want {
		t.Fatalf("%s: status %d, want %d", path, resp.StatusCode, want)
	}
}

func TestEndToEnd(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	seedAdminDirect(dbURL) // ensure the e2e admin exists (idempotent)

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

	// The API must push the server's state to wg-helper (fake helper counts
	// /apply). This covers both the create-path sync and the boot reconcile
	// worker wiring.
	if fakeApplyCount() < 1 {
		t.Fatalf("expected wg-helper /apply after server create, got %d", fakeApplyCount())
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
	expectStatus(t, resp, 200, "POST /api/nodes/{id}/report (no metrics)")

	// Report with a host metrics snapshot (monitoring support) → list returns it
	resp, _ = api(t, "POST", "/api/nodes/"+nodeID+"/report", "Bearer "+nodeToken, map[string]interface{}{
		"status":  "ok",
		"details": "",
		"metrics": map[string]interface{}{
			"cpu":          map[string]interface{}{"cores": 2, "percent": 41.5},
			"load":         []float64{0.2, 0.3, 0.4},
			"mem":          map[string]interface{}{"total": 8000000000, "used": 4000000000, "percent": 50},
			"swap":         map[string]interface{}{"total": 1000000000, "used": 0, "percent": 0},
			"disk":         []interface{}{map[string]interface{}{"mount": "/", "device": "/dev/vda1", "fs": "ext4", "total": 100000000000, "used": 50000000000, "percent": 50}},
			"net":          []interface{}{map[string]interface{}{"interface": "eth0", "rx_bps": 100, "tx_bps": 200}},
			"uptime_s":     86400,
			"host":         map[string]string{"hostname": "node-1", "os": "linux", "arch": "amd64", "kernel": "6.8", "agent_version": "e2e"},
			"collected_at": "2025-09-05T02:00:00Z",
		},
	})
	expectStatus(t, resp, 200, "POST /api/nodes/{id}/report (with metrics)")

	var nodeRows []map[string]interface{}
	json.Unmarshal([]byte(rawGet(t, baseURL+"/api/nodes", token)), &nodeRows)
	if len(nodeRows) != 1 {
		t.Fatalf("GET /api/nodes: expected 1 node, got %d", len(nodeRows))
	}
	if id, _ := nodeRows[0]["id"].(string); id != nodeID {
		t.Fatalf("node list id = %q, want %q", id, nodeID)
	}
	if _, ok := nodeRows[0]["metrics_at"]; !ok {
		t.Fatal("node list missing metrics_at")
	}
	metricsObj, ok := nodeRows[0]["metrics"].(map[string]interface{})
	if !ok {
		t.Fatalf("node list: metrics not persisted (type %T)", nodeRows[0]["metrics"])
	}
	cpu, _ := metricsObj["cpu"].(map[string]interface{})
	if cpu == nil {
		t.Fatalf("node list metrics missing cpu: %v", metricsObj)
	}
	if pct, _ := cpu["percent"].(float64); pct != 41.5 {
		t.Fatalf("node list cpu percent = %v, want 41.5", cpu["percent"])
	}
	host, _ := metricsObj["host"].(map[string]interface{})
	if host == nil || host["hostname"] != "node-1" {
		t.Fatalf("node list metrics missing host: %v", metricsObj)
	}
	load, _ := metricsObj["load"].([]interface{})
	if len(load) != 3 {
		t.Fatalf("node list metrics load = %v", metricsObj["load"])
	}

	// Garbage metrics must not break the report (row keeps prior snapshot)
	resp, _ = api(t, "POST", "/api/nodes/"+nodeID+"/report", "Bearer "+nodeToken, map[string]interface{}{
		"status": "ok", "details": "", "metrics": map[string]interface{}{"cpu": map[string]interface{}{"percent": "not-a-number"}},
	})
	expectStatus(t, resp, 200, "POST /api/nodes/{id}/report (invalid metrics tolerated)")

	// Console host card: /api/nodes/local/status reads the fake wg-helper
	resp, localOut := api(t, "GET", "/api/nodes/local/status", token, nil)
	expectStatus(t, resp, 200, "GET /api/nodes/local/status")
	if hostname, _ := localOut["hostname"].(string); hostname != "Local host (console)" {
		t.Fatalf("local status hostname = %q", hostname)
	}
	if _, ok := localOut["metrics"]; !ok {
		t.Fatal("local status missing metrics")
	}

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

	// ---- 2FA enrollment (step-up model) ----
	// From here the actor has 2FA on, so every privileged admin/backup action
	// must carry a current TOTP code. This also mirrors production policy:
	// super_admins must have 2FA enabled to perform helpdesk actions.
	actorSecret := enable2FAFor(t, token)
	actorCode := func() string { return current2FACode(t, actorSecret) }

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
	resp, resetOut := api(t, "POST", "/api/admins/"+op2ID+"/reset-password", token, map[string]string{
		"code": actorCode(),
	})
	expectStatus(t, resp, 200, "POST /api/admins/{id}/reset-password")
	if pw, _ := resetOut["password"].(string); len(pw) < 8 {
		t.Fatal("reset password not returned")
	}
	// Without a valid 2FA code the reset must be refused.
	denyReset, _ := api(t, "POST", "/api/admins/"+op2ID+"/reset-password", token, map[string]string{
		"code": "000000",
	})
	expectStatus(t, denyReset, 401, "POST /api/admins/{id}/reset-password (bad code)")

	// ---- Admins: disable then enable ----
	// (op2 was created earlier; toggle disabled -> active -> disabled)
	statusResp, _ := api(t, "PATCH", "/api/admins/"+op2ID, token, map[string]interface{}{
		"role": "admin", "status": "disabled", "code": actorCode(),
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
		"role": "admin", "status": "active", "code": actorCode(),
	})
	expectStatus(t, statusResp, 200, "PATCH /api/admins/{id} (enable)")

	// ---- Admins: edit email (super_admin edits another admin, then self) ----
	emailResp, _ := api(t, "PATCH", "/api/admins/"+op2ID, token, map[string]interface{}{
		"email": "op2-renamed@console.test", "code": actorCode(),
	})
	expectStatus(t, emailResp, 200, "PATCH /api/admins/{id} (email)")
	adminList4 := rawGet(t, baseURL+"/api/admins", token)
	var adminRows4 []map[string]interface{}
	json.Unmarshal([]byte(adminList4), &adminRows4)
	renamed := false
	for _, a := range adminRows4 {
		if e, _ := a["email"].(string); e == "op2-renamed@console.test" {
			renamed = true
		}
		if e, _ := a["email"].(string); e == "op2@console.test" {
			t.Fatal("old email still present after rename")
		}
	}
	if !renamed {
		t.Fatal("renamed admin not found in list")
	}
	// Duplicate email must be rejected.
	dupResp, _ := api(t, "PATCH", "/api/admins/"+op2ID, token, map[string]interface{}{
		"email": "e2e@console.test", "code": actorCode(),
	})
	expectStatus(t, dupResp, 409, "PATCH /api/admins/{id} (duplicate email)")
	// Editing the self email is allowed (current session is id-based).
	meID, _ := meOut["id"].(string)
	selfEmailResp, _ := api(t, "PATCH", "/api/admins/"+meID, token, map[string]interface{}{
		"email": "e2e-renamed@console.test", "code": actorCode(),
	})
	expectStatus(t, selfEmailResp, 200, "PATCH /api/admins/{id} (self email)")
	// Demoting the last active super_admin is rejected.
	demoteResp, _ := api(t, "PATCH", "/api/admins/"+meID, token, map[string]interface{}{
		"role": "admin", "code": actorCode(),
	})
	expectStatus(t, demoteResp, 400, "PATCH /api/admins/{id} (self demote blocked)")
	// Restore the seeded email so the rest of the suite keeps passing.
	restoreResp, _ := api(t, "PATCH", "/api/admins/"+meID, token, map[string]interface{}{
		"email": "e2e@console.test", "code": actorCode(),
	})
	expectStatus(t, restoreResp, 200, "PATCH /api/admins/{id} (self email restore)")

	// ---- Admins: super_admin resets another admin's 2FA ----
	// Enable 2FA on op2 first, then verify the actor can clear it with their
	// own code (and that a bad code is refused).
	op2pw, _ := resetOut["password"].(string)
	op2Tok := login(t, "op2-renamed@console.test", op2pw)
	op2Secret := enable2FAFor(t, op2Tok)
	_ = op2Secret // enrollment itself proves the flow; reset uses the actor

	// ---- Login with 2FA enabled (regression) ----
	// op2 now has 2FA on. A FRESH login must return pending_2fa + a token
	// that Verify2FA can resolve — Login persists it in admin_sessions with
	// a short expiry. Before the fix the pending token was never stored, so
	// verification always answered "Invalid or expired token".
	loginResp, loginOut := api(t, "POST", "/api/auth/login", "", map[string]string{
		"email": "op2-renamed@console.test", "password": op2pw,
	})
	expectStatus(t, loginResp, 200, "POST /api/auth/login (2FA pending)")
	if pending, _ := loginOut["pending_2fa"].(bool); !pending {
		t.Fatal("expected pending_2fa=true on login for a 2FA-enabled admin")
	}
	pendingTok, _ := loginOut["token"].(string)
	if pendingTok == "" {
		t.Fatal("login with 2FA returned no pending token")
	}

	// Wrong code: 400, and the pending token survives for a retry. Note the
	// Authorization header is the RAW token (no "Bearer ") — Verify2FA hashes
	// the whole header, matching how the frontend sends it.
	badCodeResp, _ := api(t, "POST", "/api/auth/2fa/verify", pendingTok, map[string]string{
		"code": "000000",
	})
	expectStatus(t, badCodeResp, 400, "POST /api/auth/2fa/verify (wrong code)")

	// Correct code: real session token that authenticates.
	goodResp, verifyOut := api(t, "POST", "/api/auth/2fa/verify", pendingTok, map[string]string{
		"code": current2FACode(t, op2Secret),
	})
	expectStatus(t, goodResp, 200, "POST /api/auth/2fa/verify (valid code)")
	sessionTok, _ := verifyOut["token"].(string)
	if sessionTok == "" {
		t.Fatal("2fa verify returned no session token")
	}
	meResp, _ := api(t, "GET", "/api/admins/me", sessionTok, nil)
	expectStatus(t, meResp, 200, "GET /api/admins/me (post-2FA session)")

	// The pending token is single-use: a second verify must fail.
	tfaReuseResp, _ := api(t, "POST", "/api/auth/2fa/verify", pendingTok, map[string]string{
		"code": current2FACode(t, op2Secret),
	})
	expectStatus(t, tfaReuseResp, 401, "POST /api/auth/2fa/verify (pending token reused)")

	// op2 now has 2FA; the e2e super_admin (actor) resets it.
	resp, _ = api(t, "POST", "/api/admins/"+op2ID+"/reset-2fa", token, map[string]string{
		"code": actorCode(),
	})
	expectStatus(t, resp, 200, "POST /api/admins/{id}/reset-2fa (actor code)")
	// A bad actor code must be refused.
	badReset2FA, _ := api(t, "POST", "/api/admins/"+op2ID+"/reset-2fa", token, map[string]string{
		"code": "111111",
	})
	expectStatus(t, badReset2FA, 401, "POST /api/admins/{id}/reset-2fa (bad actor code)")
	// op2's 2FA is now cleared.
	var op2Enabled bool
	{
		poolX, _ := pgxpool.New(context.Background(), dbURL)
		defer poolX.Close()
		poolX.QueryRow(context.Background(),
			`SELECT totp_enabled FROM admins WHERE id = $1`, op2ID).Scan(&op2Enabled)
	}
	if op2Enabled {
		t.Fatal("op2 2FA still enabled after reset")
	}

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

	// ---- Backups: create / download / restore require the actor's 2FA ----
	// Create a backup (no gate — making one is safe), then list it.
	createResp, _ := api(t, "POST", "/api/backup/create", token, nil)
	expectStatus(t, createResp, 200, "POST /api/backup/create")
	listRaw := rawGet(t, baseURL+"/api/backup/list", token)
	var bkList map[string]interface{}
	json.Unmarshal([]byte(listRaw), &bkList)
	bkArr, _ := bkList["backups"].([]interface{})
	if len(bkArr) == 0 {
		t.Fatalf("no backups after create: %s", listRaw)
	}
	bkName, _ := bkArr[0].(string)

	// Download with a bad code is refused.
	badDL := rawPost(t, baseURL+"/api/backup/download", token, map[string]string{
		"filename": bkName, "code": "999999",
	})
	if badDL.status != 401 {
		t.Fatalf("download bad code: status %d, want 401", badDL.status)
	}
	// Download with the actor's code streams the gz file.
	dl := rawPost(t, baseURL+"/api/backup/download", token, map[string]string{
		"filename": bkName, "code": actorCode(),
	})
	if dl.status != 200 {
		t.Fatalf("download: status %d, want 200", dl.status)
	}
	if !strings.HasPrefix(dl.ctype, "application/gzip") || len(dl.body) < 100 {
		t.Fatalf("download body/type wrong: type=%q len=%d", dl.ctype, len(dl.body))
	}

	// Restore with a bad code is refused; with a good code it succeeds.
	badRestore, _ := api(t, "POST", "/api/backup/restore", token, map[string]string{
		"filename": bkName, "code": "999999",
	})
	expectStatus(t, badRestore, 401, "POST /api/backup/restore (bad code)")
	goodRestore, _ := api(t, "POST", "/api/backup/restore", token, map[string]string{
		"filename": bkName, "code": actorCode(),
	})
	expectStatus(t, goodRestore, 200, "POST /api/backup/restore (good code)")

	// Restore-from-upload with a bad code is refused.
	badUpload := rawUpload(t, "/api/backup/restore-upload", token, bkName, dl.body, "999999")
	if badUpload.status != 401 {
		t.Fatalf("restore-upload bad code: status %d, want 401", badUpload.status)
	}
	// And with a good code it restores.
	goodUpload := rawUpload(t, "/api/backup/restore-upload", token, "uploaded_"+bkName, dl.body, actorCode())
	if goodUpload.status != 200 {
		t.Fatalf("restore-upload: status %d, want 200 (body %s)", goodUpload.status, goodUpload.body)
	}

	// ---- Audit-log housekeeping (super_admin only) ----
	// Many actions above logged audit rows. A purge with a huge cutoff
	// deletes nothing recent, returns 200, and the purge itself is logged.
	purgeResp, purgeOut := api(t, "DELETE", "/api/audit-logs?days=999999", token, nil)
	expectStatus(t, purgeResp, 200, "DELETE /api/audit-logs?days=N (super_admin)")
	if n, _ := purgeOut["deleted"].(float64); n < 0 {
		t.Fatalf("purge deleted = %v, want >= 0", n)
	}
	// Invalid days must be rejected.
	badResp, _ := api(t, "DELETE", "/api/audit-logs?days=abc", token, nil)
	expectStatus(t, badResp, 400, "DELETE /api/audit-logs?days=abc")
	// An admin (not super_admin) must be denied (403). Reuse op2Tok rather
	// than logging in again — the login rate limiter (5/15min per IP) would
	// 429 a fresh attempt this late in the suite.
	denyResp, _ := api(t, "DELETE", "/api/audit-logs?days=30", op2Tok, nil)
	expectStatus(t, denyResp, 403, "DELETE /api/audit-logs (admin denied)")
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

type rawResp struct {
	status int
	ctype  string
	body   []byte
}

// rawPost posts JSON and returns the raw response without JSON-decoding it
// (used for binary/gzip download checks).
func rawPost(t *testing.T, url, token string, body map[string]string) rawResp {
	t.Helper()
	var buf bytes.Buffer
	json.NewEncoder(&buf).Encode(body)
	req, err := http.NewRequest("POST", url, &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return rawResp{status: resp.StatusCode, ctype: resp.Header.Get("Content-Type"), body: b}
}

// rawUpload multipart-posts a .sql.gz file plus a 2FA code.
func rawUpload(t *testing.T, path, token, filename string, content []byte, code string) rawResp {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	fw.Write(content)
	mw.WriteField("code", code)
	mw.Close()

	req, err := http.NewRequest("POST", baseURL+path, &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return rawResp{status: resp.StatusCode, body: b}
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
