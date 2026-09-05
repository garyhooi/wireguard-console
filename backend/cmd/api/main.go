package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/wireguard-console/backend/internal/api"
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
	go worker.NewDomainRuleWorker(conn.Pool(), 5*time.Minute).Start(ctx)
	// Re-apply locally-managed WireGuard interfaces after host reboots (the
	// kernel interface + NAT are lost on reboot; wg-helper is passive in
	// local mode, so this worker restores them — fast at boot, then slow).
	go worker.NewWGReconcileWorker(conn.Pool(), 2*time.Minute).Start(ctx)
	// Import AdGuard Home's DNS query log into browsing_records so the Web
	// Activity page and domain statistics have data (see worker/browse.go).
	go worker.NewBrowseWorker(conn.Pool()).Start(ctx)
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
		r.Post("/auth/2fa/verify", api.Verify2FA(store))
		r.Post("/auth/logout", api.Logout(store))
		r.Post("/claim", api.ClaimUser(store))
		r.Get("/peer-config/{token}", api.GetPeerConfigByToken(store))

		// Protected routes group
		r.Group(func(r chi.Router) {
			r.Use(api.AuthMiddleware(store))
			// Session cookie auth rides along automatically on same-site
			// requests, so every state-changing authed call must also carry
			// the per-session CSRF token (see RequireCSRF). Reads pass
			// through untouched.
			r.Use(api.RequireCSRF(store))

			// Version + update check (any authenticated admin): compares the
			// console's APP_VERSION against the newest GitHub release and
			// serves the update one-liner. GET-only — no CSRF needed.
			r.Get("/update/check", api.UpdateCheckHandler(store))

			r.Post("/auth/2fa/setup", api.Setup2FA(store))
			r.Post("/auth/2fa/enable", api.Enable2FA(store))

			// Admin management - super_admin only
			r.Group(func(r chi.Router) {
				r.Use(api.RequireRole(store, "super_admin"))
				r.Get("/admins", api.ListAdmins(store))
				r.Post("/admins", api.InviteAdmin(store))
				r.Get("/admins/{id}", api.GetAdmin(store))
				r.Patch("/admins/{id}", api.UpdateAdmin(store))
				r.Delete("/admins/{id}", api.DeleteAdmin(store))
				r.Post("/admins/{id}/reset-password", api.ResetAdminPassword(store))
				// Super-admin helpdesk: clear another admin's 2FA so they
				// can re-enroll (requires the acting admin's own 2FA code).
				r.Post("/admins/{id}/reset-2fa", api.ResetAdmin2FA(store))
				// Audit-log housekeeping — super_admin only.
				r.Delete("/audit-logs", api.PurgeAuditLogs(store))
				// Web-activity housekeeping — super_admin only (raw browsing
				// records grow with peer traffic; nightly auto-purge keeps the
				// retention window, this allows an immediate manual cleanup).
				r.Delete("/web-activity", api.PurgeWebActivity(store))
			})

			// User and peer management - admin and super_admin
			r.Group(func(r chi.Router) {
				r.Use(api.RequireRole(store, "admin", "super_admin"))
				r.Get("/users", api.ListUsers(store))
				r.Post("/users", api.CreateUser(store))
				r.Get("/users/{id}", api.GetUser(store))
				r.Patch("/users/{id}", api.UpdateUser(store))
				r.Post("/users/{id}/suspend", api.SuspendUser(store))
				r.Delete("/users/{id}", api.DeleteUser(store))
				r.Post("/users/{id}/resume", api.ResumeUser(store))
				// Re-issue the claim email when the original send failed
				// (SMTP error) or the user lost/expired their invite link.
				r.Post("/users/{id}/resend-invite", api.ResendUserInvite(store))

				r.Get("/peers", api.ListPeers(store))
				r.Post("/peers", api.CreatePeer(store))
				r.Get("/peers/{id}", api.GetPeer(store))
				r.Patch("/peers/{id}", api.UpdatePeer(store))
				r.Post("/peers/{id}/suspend", api.SuspendPeer(store))
				r.Post("/peers/{id}/resume", api.ResumePeer(store))
				r.Delete("/peers/{id}", api.DeletePeer(store))
				r.Get("/peers/{id}/config", api.GetPeerConfig(store))
				r.Post("/peers/{id}/config-link", api.CreatePeerAccessLink(store))
				// Re-email the config link when the original send hit an
				// SMTP error or the user never received it.
				r.Post("/peers/{id}/resend-config-email", api.ResendPeerConfigEmail(store))

				r.Get("/servers", api.ListServers(store))
				r.Post("/servers", api.CreateServer(store))
				r.Get("/servers/{id}", api.GetServer(store))
				r.Patch("/servers/{id}", api.UpdateServer(store))
				r.Delete("/servers/{id}", api.DeleteServer(store))
				r.Get("/servers/{id}/status", api.GetServerStatus(store))
				r.Get("/servers/{id}/host-config", api.GetServerHostConfig(store))

				// Node management (admin session auth)
				r.Get("/admins/me", api.GetMe(store))
				r.Post("/admins/me/password", api.ChangePassword(store))
				r.Get("/admins/me/sessions", api.ListMySessions(store))
				r.Delete("/admins/me/sessions/{id}", api.RevokeMySession(store))
				r.Post("/admins/me/sessions/revoke-others", api.RevokeMyOtherSessions(store))
				r.Post("/auth/2fa/disable", api.Disable2FA(store))
				r.Get("/config/email-templates", api.ListEmailTemplates(store))
				r.Patch("/config/email-templates/{key}", api.UpdateEmailTemplate(store))
				r.Get("/nodes", api.ListNodes(store))
				r.Post("/nodes", api.CreateNode(store))
				r.Get("/nodes/local/status", api.GetLocalNodeStatus(store))
				r.Delete("/nodes/{id}", api.DeleteNode(store))

				r.Get("/domain-rules", api.ListDomainRules(store))
				r.Post("/domain-rules", api.CreateDomainRule(store))
				r.Delete("/domain-rules/{id}", api.DeleteDomainRule(store))
				r.Get("/domain-rules/status", api.DomainRuleSyncStatus(store))

				// Web activity (per-peer DNS browsing history). Records are
				// imported from AdGuard Home by the browse worker.
				r.Get("/web-activity", api.ListWebActivity(store))
				r.Get("/web-activity/summary", api.GetWebActivitySummary(store))
				r.Get("/web-activity/top-domains", api.GetTopDomains(store))

				r.Get("/stats/overview", api.GetStatsOverview(store))
				r.Get("/stats/traffic", api.GetTrafficStats(store))
				r.Get("/stats/usage", api.GetTrafficUsage(store))
				r.Get("/peers/{id}/traffic", api.GetPeerTraffic(store))
				r.Get("/users/{id}/traffic", api.GetUserTraffic(store))

				r.Get("/audit-logs", api.ListAuditLogs(store))

				r.Get("/config", api.GetConfig(store))
				r.Patch("/config", api.UpdateConfig(store))
				r.Get("/config/smtp", api.GetSMTPConfig(store))
				r.Patch("/config/smtp", api.UpdateSMTPConfig(store))
				r.Get("/config/timezone", api.GetTimezoneConfig(store))
				r.Patch("/config/timezone", api.UpdateTimezoneConfig(store))
				r.Post("/config/email/test", api.SendTestEmail(store))

				// Backup endpoints (download/restore/delete require the
				// acting admin's own 2FA code — see each handler).
				r.Post("/backup/create", api.CreateBackup(store))
				r.Post("/backup/restore", api.RestoreBackup(store))
				r.Get("/backup/list", api.ListBackups(store))
				r.Post("/backup/download", api.DownloadBackup(store))
				r.Post("/backup/restore-upload", api.RestoreBackupUpload(store))
				r.Post("/backup/delete", api.DeleteBackup(store))
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
		Addr:    fmt.Sprintf(":%s", port),
		Handler: r,
	}

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

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
