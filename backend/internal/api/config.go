package api

import (
	"context"
	"encoding/json"
	"net/http"
)

type AppConfig struct {
	OrgName             string `json:"org_name"`
	DefaultDNS          string `json:"default_dns"`
	DefaultAllowedIPs   string `json:"default_allowed_ips"`
	PersistentKeepalive int    `json:"persistent_keepalive"`
	SMTPConfigured      bool   `json:"smtp_configured"`
}

func GetConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()

		var config AppConfig
		err := store.pool.QueryRow(ctx, `
			SELECT org_name, default_dns, default_allowed_ips, persistent_keepalive, smtp_configured
			FROM config
		`).Scan(&config.OrgName, &config.DefaultDNS, &config.DefaultAllowedIPs,
			&config.PersistentKeepalive, &config.SMTPConfigured)

		if err != nil {
			// Return default config if table doesn't exist
			config = AppConfig{
				DefaultDNS:          "10.10.0.1",
				DefaultAllowedIPs:   "0.0.0.0/0",
				PersistentKeepalive: 25,
			}
		}

		writeJSON(w, http.StatusOK, config)
	}
}

func UpdateConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req AppConfig
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		_, err := store.pool.Exec(ctx, `
			INSERT INTO config (org_name, default_dns, default_allowed_ips, persistent_keepalive)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (id) DO UPDATE SET
				org_name = $1, default_dns = $2, default_allowed_ips = $3, persistent_keepalive = $4
		`, req.OrgName, req.DefaultDNS, req.DefaultAllowedIPs, req.PersistentKeepalive)

		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update config")
			return
		}

		logAudit(ctx, store, adminID, "config.update", "config", "", nil)

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}
