package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/email"
)

func GetSMTPConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		cfg := email.LoadConfig(ctx, store.pool)

		// The password never leaves the server; just flag whether one is set.
		passwordSet := cfg.Password != ""

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"host":         cfg.Host,
			"port":         cfg.Port,
			"username":     cfg.Username,
			"from":         cfg.From,
			"configured":   cfg.Host != "",
			"password_set": passwordSet,
		})
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
		if req.Host == "" {
			writeError(w, http.StatusBadRequest, "SMTP host is required")
			return
		}
		if req.Port == 0 {
			req.Port = 587
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		// Encrypt the password at rest; an empty password in the request
		// preserves the stored one.
		var passwordEnc string
		if req.Password != "" {
			encSvc, err := auth.NewEncryptionService()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Encryption is not configured")
				return
			}
			enc, err := encSvc.Encrypt(req.Password)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to encrypt SMTP password")
				return
			}
			passwordEnc = enc
		}

		if passwordEnc != "" {
			_, err := store.pool.Exec(ctx, `
				INSERT INTO config (id, smtp_host, smtp_port, smtp_username, smtp_password_enc, smtp_from)
				VALUES (1, $1, $2, $3, $4, $5)
				ON CONFLICT (id) DO UPDATE SET
					smtp_host = $1, smtp_port = $2, smtp_username = $3,
					smtp_password_enc = $4, smtp_from = $5, updated_at = now()
			`, req.Host, req.Port, req.Username, passwordEnc, req.From)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to save SMTP config")
				return
			}
		} else {
			_, err := store.pool.Exec(ctx, `
				INSERT INTO config (id, smtp_host, smtp_port, smtp_username, smtp_from)
				VALUES (1, $1, $2, $3, $5)
				ON CONFLICT (id) DO UPDATE SET
					smtp_host = $1, smtp_port = $2, smtp_username = $3,
					smtp_from = $5, updated_at = now()
			`, req.Host, req.Port, req.Username, req.From)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to save SMTP config")
				return
			}
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
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.To == "" {
			writeError(w, http.StatusBadRequest, "recipient is required")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		cfg := email.LoadConfig(ctx, store.pool)
		if cfg.Host == "" {
			writeError(w, http.StatusBadRequest, "SMTP is not configured — save SMTP settings first")
			return
		}

		service := email.NewServiceWithConfig(cfg)
		if err := service.SendTestEmail(req.To); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to send test email: "+err.Error())
			return
		}

		logAudit(ctx, store, adminID, "email.test", "config", "", nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
	}
}
