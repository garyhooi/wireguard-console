package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/wireguard-console/backend/internal/api"
	authwebauthn "github.com/wireguard-console/backend/internal/auth/webauthn"
	"github.com/wireguard-console/backend/internal/authz"
	"github.com/wireguard-console/backend/internal/db"
	"github.com/wireguard-console/backend/internal/worker"
)

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL environment variable is required")
	}

	wgHelperSocket := os.Getenv("WG_HELPER_SOCKET")
	if wgHelperSocket == "" {
		log.Fatal("WG_HELPER_SOCKET environment variable is required")
	}

	conn, err := db.New(databaseURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer conn.Close()

	if err := db.RunMigrations(conn); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	// Fresh installs get their first super_admin automatically (env
	// ADMIN_EMAIL/ADMIN_PASSWORD, else random credentials printed once).
	if err := api.BootstrapAdmin(conn.Pool(), log.Printf); err != nil {
		log.Fatalf("Failed to bootstrap admin: %v", err)
	}

	// Passkeys are capability-gated at boot: the WebAuthn relying-party ID and
	// origins derive from CONSOLE_DOMAIN (or WEBAUTHN_* overrides). An IP-only
	// deployment cannot have passkeys — the service disables itself and logs
	// why, and authenticator-app MFA keeps working. A bad configuration never
	// blocks startup.
	authwebauthn.InitFromEnv()

	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RealIP)

	// The SPA and the API are same-origin behind one Caddy in every TLS
	// mode; the session credential travels as a cookie, so no cross-origin
	// request needs to be served. Pin the CORS allow-list to the configured
	// console origin only — a wildcard allow-list with credentials would
	// let any origin ride the cookie jar.
	consoleOrigin := os.Getenv("CONSOLE_ORIGIN")
	if consoleOrigin == "" {
		if d := os.Getenv("CONSOLE_DOMAIN"); d != "" {
			consoleOrigin = "https://" + d
		}
	}
	if consoleOrigin != "" {
		r.Use(cors.Handler(cors.Options{
			AllowedOrigins:   []string{consoleOrigin},
			AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
			AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
			ExposedHeaders:   []string{"Link"},
			AllowCredentials: true,
			MaxAge:           300,
		}))
	}

	store := api.NewStore(conn.Pool())

	// Start background workers
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go worker.NewTrafficWorker(conn.Pool(), 30*time.Second).Start(ctx)
	go worker.NewRollupWorker(conn.Pool()).Start(ctx)
	go worker.NewMailWorker(conn.Pool()).Start(ctx)
	// Reconcile DB rules into AdGuard periodically so rules can't silently
	// drift (AGH re-provision, manual AGH edits, partial failed syncs).
	// 60s backstop: catches failed event-driven syncs, AdGuard restarts and
	// rule/peer changes within a minute instead of five.
	go worker.NewDomainRuleWorker(conn.Pool(), time.Minute).Start(ctx)
	// Re-apply locally-managed WireGuard interfaces after host reboots (the
	// kernel interface + NAT are lost on reboot; wg-helper is passive in
	// local mode, so this worker restores them — fast at boot, then slow).
	go worker.NewWGReconcileWorker(conn.Pool(), 2*time.Minute).Start(ctx)
	// Import AdGuard Home's DNS query log into browsing_records so the Web
	// Activity page and domain statistics have data (see worker/browse.go).
	go worker.NewBrowseWorker(conn.Pool()).Start(ctx)
	// Sample the IP-block nftables rule counters so blocked-IP attempts show
	// up in Statistics and Web Activity (they never hit DNS, so the AdGuard
	// query-log importer cannot see them).
	go worker.NewIPBlockHitWorker(conn.Pool(), 30*time.Second).Start(ctx)
	// Remove expired admin_sessions rows (absolute-expiry backstop; idle-
	// expired rows are deleted inline on next use).
	go worker.NewSessionPurgeWorker(conn.Pool(), time.Hour).Start(ctx)

	// Repush persisted domain-block rules into AdGuard Home. A server reset /
	// redeploy provisions AdGuard with a clean config (empty user_rules), so
	// rules survive in PostgreSQL but would be silently lost from AdGuard
	// until the next rule create/delete re-triggers a sync. Best-effort: a
	// misconfigured/unreachable AdGuard logs here but never blocks startup.
	// Retry briefly because the API container has no depends_on on AdGuard, so
	// AGH may still be starting up when this runs.
	for attempt := 1; ; attempt++ {
		n, err := api.SyncDomainRulesToAdGuard(store)
		if err == nil {
			log.Printf("Synced %d domain rule(s) to AdGuard on startup", n)
			break
		}
		if attempt >= 3 {
			log.Printf("Failed to sync domain rules to AdGuard on startup (rules remain in DB but will re-sync later): %v", err)
			break
		}
		log.Printf("AdGuard not ready for domain-rule sync (attempt %d/3): %v", attempt, err)
		time.Sleep(5 * time.Second)
	}

	// Liveness probe (used by the container healthcheck — succeeds whatever
	// the auth state is).
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})

	r.Route("/api", func(r chi.Router) {
		// Public routes
		r.Get("/nodes/{id}/state", api.GetNodeState(store))
		r.Post("/nodes/{id}/report", api.ReportNodeState(store))
		r.Post("/auth/login", api.Login(store))
		// Per-IP lockout state so the login page can resume its countdown
		// after a refresh (no session exists yet while locked out).
		r.Get("/auth/lockout-status", api.LoginLockoutStatus(store))
		// Passwordless passkey sign-in: no password step at all. The account is
		// resolved from the discoverable credential's user handle at finish, and
		// the ceremony is bound to a short-lived HttpOnly cookie. Password login
		// remains the fallback and still requires a second factor.
		r.Get("/auth/passkey/status", api.PasskeyStatus(store))
		r.Post("/auth/passkey/options", api.PasskeyPasswordlessBegin(store))
		r.Post("/auth/passkey/finish", api.PasskeyPasswordlessFinish(store))
		// MFA challenge (pending cookie only — these never mint a session
		// without a proven factor; see mfa_shared.go finishMFALogin).
		r.Get("/auth/mfa/state", api.MFAState(store))
		r.Post("/auth/mfa/totp", api.MFATOTPVerify(store))
		r.Post("/auth/mfa/recovery-code", api.MFARecoveryCodeVerify(store))
		r.Post("/auth/mfa/passkey/begin", api.MFAPasskeyLoginBegin(store))
		r.Post("/auth/mfa/passkey/finish", api.MFAPasskeyLoginFinish(store))
		// Forced enrollment for accounts with no (or too few) factors.
		r.Post("/auth/mfa/enroll/totp/begin", api.MFAEnrollTOTPBegin(store))
		r.Post("/auth/mfa/enroll/totp/finish", api.MFAEnrollTOTPFinish(store))
		r.Post("/auth/mfa/enroll/passkey/begin", api.MFAEnrollPasskeyBegin(store))
		r.Post("/auth/mfa/enroll/passkey/finish", api.MFAEnrollPasskeyFinish(store))
		r.Post("/auth/mfa/enroll/complete", api.MFAEnrollComplete(store))
		r.Post("/auth/logout", api.Logout(store))
		r.Post("/claim", api.ClaimUser(store))
		r.Get("/claim/{token}/status", api.GetClaimLinkStatus(store))
		r.Get("/peer-config/{token}", api.GetPeerConfigByToken(store))

		// Protected routes group
		r.Group(func(r chi.Router) {
			r.Use(api.AuthMiddleware(store))
			// Session cookie auth rides along automatically on same-site
			// requests, so every state-changing authed call must also carry
			// the per-session CSRF token (see RequireCSRF). Reads pass
			// through untouched.
			r.Use(api.RequireCSRF(store))

			// Any authenticated admin: self-service, release check and the two
			// policy reads used by every page (timezone + step-up grace).
			r.Get("/update/check", api.UpdateCheckHandler(store))
			r.Get("/admins/me", api.GetMe(store))
			r.Post("/admins/me/password", api.ChangePassword(store))
			r.Get("/admins/me/sessions", api.ListMySessions(store))
			r.Delete("/admins/me/sessions/{id}", api.RevokeMySession(store))
			r.Post("/admins/me/sessions/revoke-others", api.RevokeMyOtherSessions(store))
			r.Get("/admins/me/mfa", api.GetMyMFA(store))
			r.Post("/admins/me/mfa/totp/begin", api.AddTOTPBegin(store))
			r.Post("/admins/me/mfa/totp/finish", api.AddTOTPFinish(store))
			r.Post("/admins/me/mfa/totp/remove", api.AddTOTPRemove(store))
			r.Post("/admins/me/mfa/passkeys/begin", api.AddPasskeyBegin(store))
			r.Post("/admins/me/mfa/passkeys/finish", api.AddPasskeyFinish(store))
			r.Patch("/admins/me/mfa/passkeys/{id}", api.UpdatePasskey(store))
			r.Delete("/admins/me/mfa/passkeys/{id}", api.DeletePasskey(store))
			r.Post("/admins/me/mfa/recovery-codes/regenerate", api.RegenerateRecoveryCodes(store))
			r.Post("/auth/mfa/stepup/passkey/begin", api.PasskeyStepUpBegin(store))
			r.Post("/auth/mfa/stepup/passkey/finish", api.PasskeyStepUpFinish(store))
			r.Get("/config/timezone", api.GetTimezoneConfig(store))
			r.Get("/config/step-up", api.GetStepUpConfig(store))

			// Access control. Sensitive capabilities are grantable to custom
			// roles, so the page/tab itself is gated by the route permissions.
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.AdminsView))
				r.Get("/admins", api.ListAdmins(store))
				r.Get("/admins/{id}", api.GetAdmin(store))
				r.Get("/admin-groups", api.ListAdminGroups(store))
				r.Get("/admin-groups/{id}", api.GetAdminGroup(store))
			})
			r.Group(func(r chi.Router) {
				// A role manager needs the role catalogue even if they do not
				// have admins.view (and therefore cannot see the admins list).
				r.Use(api.RequirePermission(authz.AdminsView, authz.RolesManage))
				r.Get("/admin-roles", api.ListAdminRoles(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.AdminsManage))
				r.Post("/admins", api.InviteAdmin(store))
				r.Patch("/admins/{id}", api.UpdateAdmin(store))
				r.Delete("/admins/{id}", api.DeleteAdmin(store))
				r.Post("/admins/{id}/reset-password", api.ResetAdminPassword(store))
				r.Post("/admins/{id}/reset-mfa", api.ResetAdminMFA(store))
				r.Post("/admin-groups", api.CreateAdminGroup(store))
				r.Patch("/admin-groups/{id}", api.UpdateAdminGroup(store))
				r.Delete("/admin-groups/{id}", api.DeleteAdminGroup(store))
				r.Patch("/admin-groups/{id}/members", api.SetAdminGroupMembers(store))
				r.Post("/admin-groups/{id}/assign-role", api.AssignAdminGroupRole(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.RolesManage))
				r.Post("/admin-roles", api.CreateAdminRole(store))
				r.Patch("/admin-roles/{slug}", api.UpdateAdminRole(store))
				r.Delete("/admin-roles/{slug}", api.DeleteAdminRole(store))
			})

			// Monitoring and web activity.
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.MonitoringView))
				r.Get("/stats/overview", api.GetStatsOverview(store))
				r.Get("/stats/traffic", api.GetTrafficStats(store))
				r.Get("/stats/usage", api.GetTrafficUsage(store))
				r.Get("/peers/{id}/traffic", api.GetPeerTraffic(store))
				r.Get("/users/{id}/traffic", api.GetUserTraffic(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.ActivityView))
				r.Get("/web-activity", api.ListWebActivity(store))
				r.Get("/web-activity/summary", api.GetWebActivitySummary(store))
				r.Get("/web-activity/top-domains", api.GetTopDomains(store))
				r.Get("/web-activity/ip-blocked", api.IPBlockedActivity(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.AuditView))
				r.Get("/audit-logs", api.ListAuditLogs(store))
			})

			// Network.
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.NetworkView))
				r.Get("/servers", api.ListServers(store))
				r.Get("/servers/{id}", api.GetServer(store))
				r.Get("/servers/{id}/status", api.GetServerStatus(store))
				r.Get("/peers", api.ListPeers(store))
				r.Get("/peers/{id}", api.GetPeer(store))
				r.Get("/nodes", api.ListNodes(store))
				r.Get("/nodes/local/status", api.GetLocalNodeStatus(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.NetworkManage))
				r.Post("/servers", api.CreateServer(store))
				r.Patch("/servers/{id}", api.UpdateServer(store))
				r.Delete("/servers/{id}", api.DeleteServer(store))
				r.Post("/peers", api.CreatePeer(store))
				r.Patch("/peers/{id}", api.UpdatePeer(store))
				r.Post("/peers/{id}/suspend", api.SuspendPeer(store))
				r.Post("/peers/{id}/resume", api.ResumePeer(store))
				r.Delete("/peers/{id}", api.DeletePeer(store))
				r.Post("/nodes", api.CreateNode(store))
				r.Delete("/nodes/{id}", api.DeleteNode(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.NetworkSecrets))
				r.Get("/peers/{id}/config", api.GetPeerConfig(store))
				r.Post("/peers/{id}/config-link", api.CreatePeerAccessLink(store))
				r.Post("/peers/{id}/resend-config-email", api.ResendPeerConfigEmail(store))
				r.Post("/servers/{id}/host-config", api.GetServerHostConfig(store))
			})

			// Directory.
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.DirectoryView))
				r.Get("/users", api.ListUsers(store))
				r.Get("/users/{id}", api.GetUser(store))
				r.Get("/departments", api.ListDepartments(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.DirectoryManage))
				r.Post("/users", api.CreateUser(store))
				r.Patch("/users/{id}", api.UpdateUser(store))
				r.Post("/users/{id}/suspend", api.SuspendUser(store))
				r.Post("/users/{id}/resume", api.ResumeUser(store))
				r.Delete("/users/{id}", api.DeleteUser(store))
				r.Post("/users/{id}/resend-invite", api.ResendUserInvite(store))
				r.Post("/departments", api.CreateDepartment(store))
				r.Patch("/departments/{id}", api.UpdateDepartment(store))
				r.Delete("/departments/{id}", api.DeleteDepartment(store))
			})

			// Security rules.
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.RulesView))
				r.Get("/domain-rules", api.ListDomainRules(store))
				r.Get("/domain-rules/status", api.DomainRuleSyncStatus(store))
				r.Get("/domain-rules/check", api.CheckDomainRule(store))
				r.Get("/domain-groups", api.ListDomainGroups(store))
				r.Get("/ip-rules", api.ListIPRules(store))
				r.Get("/ip-rules/status", api.IPRuleStatus(store))
				r.Get("/ip-groups", api.ListIPGroups(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.RulesManage))
				r.Post("/domain-rules", api.CreateDomainRule(store))
				r.Delete("/domain-rules/{id}", api.DeleteDomainRule(store))
				r.Post("/domain-groups", api.CreateDomainGroup(store))
				r.Patch("/domain-groups/{id}", api.UpdateDomainGroup(store))
				r.Delete("/domain-groups/{id}", api.DeleteDomainGroup(store))
				r.Post("/ip-rules", api.CreateIPRule(store))
				r.Delete("/ip-rules/{id}", api.DeleteIPRule(store))
				r.Post("/ip-groups", api.CreateIPGroup(store))
				r.Patch("/ip-groups/{id}", api.UpdateIPGroup(store))
				r.Delete("/ip-groups/{id}", api.DeleteIPGroup(store))
			})

			// System configuration and backups.
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.SystemView))
				r.Get("/config", api.GetConfig(store))
				r.Get("/config/smtp", api.GetSMTPConfig(store))
				r.Get("/config/email-templates", api.ListEmailTemplates(store))
				r.Get("/config/mfa", api.GetMFAPolicyConfig(store))
				r.Get("/config/security", api.GetSecurityConfig(store))
				r.Get("/config/backup-passphrase", api.GetBackupPassphraseConfig(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.SystemManage))
				r.Patch("/config", api.UpdateConfig(store))
				r.Patch("/config/smtp", api.UpdateSMTPConfig(store))
				r.Patch("/config/timezone", api.UpdateTimezoneConfig(store))
				r.Patch("/config/email-templates/{key}", api.UpdateEmailTemplate(store))
				r.Post("/config/email/test", api.SendTestEmail(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.BackupsView))
				r.Get("/backup/list", api.ListBackups(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.BackupsManage))
				r.Post("/backup/create", api.CreateBackup(store))
				r.Post("/backup/restore", api.RestoreBackup(store))
				r.Post("/backup/download", api.DownloadBackup(store))
				r.Post("/backup/restore-upload", api.RestoreBackupUpload(store))
				r.Post("/backup/delete", api.DeleteBackup(store))
			})

			// Sensitive security/maintenance actions (grantable to custom roles).
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.SecurityManage))
				r.Patch("/config/mfa", api.UpdateMFAPolicyConfig(store))
				r.Patch("/config/step-up", api.UpdateStepUpConfig(store))
				r.Patch("/config/security", api.UpdateSecurityConfig(store))
				r.Patch("/config/backup-passphrase", api.UpdateBackupPassphraseConfig(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.AuditManage))
				r.Delete("/audit-logs", api.PurgeAuditLogs(store))
				r.Delete("/web-activity", api.PurgeWebActivity(store))
			})
			r.Group(func(r chi.Router) {
				r.Use(api.RequirePermission(authz.MaintenanceRun))
				r.Get("/debug/runtime", api.RuntimeStats(store))
				r.Post("/domain-rules/sync", api.ResyncDomainRules(store))
				r.Post("/ip-rules/sync", api.ResyncIPRules(store))
				r.Post("/nodes/{id}/rotate-token", api.RotateNodeToken(store))
			})
		})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("API server starting on :%s", port)

	// Start HTTP server in background
	server := &http.Server{
		Addr:              fmt.Sprintf(":%s", port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	// Loopback-only pprof listener (goroutine/heap dumps during leak triage).
	// Enabled by PPROF_ADDR (compose sets 127.0.0.1:6060); never published.
	if addr := strings.TrimSpace(os.Getenv("PPROF_ADDR")); addr != "" {
		go func() {
			log.Printf("pprof/debug listener on %s", addr)
			if err := http.ListenAndServe(addr, nil); err != nil {
				log.Printf("pprof listener stopped: %v", err)
			}
		}()
	}

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")
	cancel()

	ctx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server shutdown failed: %v", err)
	}
}
