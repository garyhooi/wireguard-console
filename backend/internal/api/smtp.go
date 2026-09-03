package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/wireguard-console/backend/internal/email"
)

func GetSMTPConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var config struct {
			Host       string `json:"host"`
			Port       int    `json:"port"`
			Username   string `json:"username"`
			From       string `json:"from"`
			Configured bool   `json:"configured"`
		}

		host := r.URL.Query().Get("host")
		username := r.URL.Query().Get("username")
		from := r.URL.Query().Get("from")

		if host != "" {
			config.Host = host
			config.Port = 587
			config.Username = username
			config.From = from
			config.Configured = host != ""
		}

		writeJSON(w, http.StatusOK, config)
	}
}

func UpdateSMTPConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Host     string `json:"host"`
			Port     int    `json:"port"`
			Username string `json:"username"`
			Password string `json:"password"`
			From     string `json:"from"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		// Store SMTP config in config table (simplified for v1)
		_, err := store.pool.Exec(ctx, `
			INSERT INTO config (smtp_host, smtp_port, smtp_username, smtp_from)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (id) DO UPDATE SET
				smtp_host = $1, smtp_port = $2, smtp_username = $3, smtp_from = $4
		`, req.Host, req.Port, req.Username, req.From)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update SMTP config")
			return
		}

		logAudit(ctx, store, adminID, "config.update", "config", "", nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}

func SendTestEmail(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			To string `json:"to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		// TODO: Initialize email service with stored config
		service, err := email.NewService()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "SMTP not configured")
			return
		}

		queue := email.NewQueue(store.pool, service)
		if err := queue.EnqueueTestEmail(ctx, req.To); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to enqueue test email")
			return
		}

		logAudit(ctx, store, adminID, "email.test", "config", "", nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "test_email_queued"})
	}
}
