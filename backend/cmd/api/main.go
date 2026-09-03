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

	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RealIP)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"https://*", "http://*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	store := api.NewStore(conn.Pool())

	// Start background workers
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go worker.NewTrafficWorker(conn.Pool(), 30*time.Second).Start(ctx)
	go worker.NewRollupWorker(conn.Pool()).Start(ctx)

	r.Route("/api", func(r chi.Router) {
		// Public routes
		r.Post("/auth/login", api.Login(store))
		r.Post("/auth/2fa/verify", api.Verify2FA(store))
		r.Post("/auth/logout", api.Logout(store))
		r.Post("/claim", api.ClaimUser(store))

		// Protected routes group
		r.Group(func(r chi.Router) {
			r.Use(api.AuthMiddleware(store))

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
			})

			// User and peer management - admin and super_admin
			r.Group(func(r chi.Router) {
				r.Use(api.RequireRole(store, "admin", "super_admin"))
				r.Get("/users", api.ListUsers(store))
				r.Post("/users", api.CreateUser(store))
				r.Get("/users/{id}", api.GetUser(store))
				r.Patch("/users/{id}", api.UpdateUser(store))
				r.Post("/users/{id}/suspend", api.SuspendUser(store))
				r.Post("/users/{id}/resume", api.ResumeUser(store))

				r.Get("/peers", api.ListPeers(store))
				r.Post("/peers", api.CreatePeer(store))
				r.Get("/peers/{id}", api.GetPeer(store))
				r.Patch("/peers/{id}", api.UpdatePeer(store))
				r.Post("/peers/{id}/suspend", api.SuspendPeer(store))
				r.Post("/peers/{id}/resume", api.ResumePeer(store))
				r.Delete("/peers/{id}", api.DeletePeer(store))
				r.Get("/peers/{id}/config", api.GetPeerConfig(store))

				r.Get("/servers", api.ListServers(store))
				r.Post("/servers", api.CreateServer(store))
				r.Get("/servers/{id}", api.GetServer(store))
				r.Patch("/servers/{id}", api.UpdateServer(store))
				r.Delete("/servers/{id}", api.DeleteServer(store))
				r.Get("/servers/{id}/status", api.GetServerStatus(store))

				r.Get("/domain-rules", api.ListDomainRules(store))
				r.Post("/domain-rules", api.CreateDomainRule(store))
				r.Delete("/domain-rules/{id}", api.DeleteDomainRule(store))

				r.Get("/stats/overview", api.GetStatsOverview(store))
				r.Get("/peers/{id}/traffic", api.GetPeerTraffic(store))
				r.Get("/users/{id}/traffic", api.GetUserTraffic(store))

				r.Get("/audit-logs", api.ListAuditLogs(store))

				r.Get("/config", api.GetConfig(store))
				r.Patch("/config", api.UpdateConfig(store))
				r.Get("/config/smtp", api.GetSMTPConfig(store))
				r.Patch("/config/smtp", api.UpdateSMTPConfig(store))
				r.Post("/config/email/test", api.SendTestEmail(store))

				// Backup endpoints
				r.Post("/backup/create", api.CreateBackup(store))
				r.Post("/backup/restore", api.RestoreBackup(store))
				r.Get("/backup/list", api.ListBackups(store))
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
