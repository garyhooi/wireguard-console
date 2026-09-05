package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Console-wide timezone preference (Configuration → Timezone), stored on the
// single-row config table. Empty string means "unset": the frontend then
// follows each viewer's browser timezone, and the traffic chart keeps its
// UTC hour buckets (legacy behavior).

// loadTimezone returns the configured IANA timezone name, or "" when unset
// or when the value is missing (old databases mid-upgrade fall back to "").
func loadTimezone(ctx context.Context, pool *pgxpool.Pool) string {
	var tz string
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(timezone, '') FROM config WHERE id = 1
	`).Scan(&tz)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(tz)
}

// validTimezone reports whether name is a valid IANA time zone. The empty
// string is valid — it means "follow the viewer's browser".
func validTimezone(name string) bool {
	if name == "" {
		return true
	}
	_, err := time.LoadLocation(name)
	return err == nil
}

// GetTimezoneConfig returns the console timezone. Readable by every signed-in
// admin: the SPA resolves it before rendering any timestamp. When unset the
// value is "" and the frontend falls back to the viewer's browser zone.
func GetTimezoneConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		writeJSON(w, http.StatusOK, map[string]string{
			"timezone": loadTimezone(ctx, store.pool),
		})
	}
}

// UpdateTimezoneConfig persists the console timezone (admin/super_admin
// only, like the rest of Configuration). An empty value resets to browser
// timezone.
func UpdateTimezoneConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Timezone string `json:"timezone"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		req.Timezone = strings.TrimSpace(req.Timezone)
		if !validTimezone(req.Timezone) {
			writeError(w, http.StatusBadRequest,
				"Unknown time zone — use an IANA name such as Asia/Kuala_Lumpur, or empty to follow each viewer's browser")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		if _, err := store.pool.Exec(ctx, `
			INSERT INTO config (id, timezone) VALUES (1, $1)
			ON CONFLICT (id) DO UPDATE SET
				timezone = EXCLUDED.timezone, updated_at = now()
		`, req.Timezone); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save timezone")
			return
		}

		logAudit(ctx, store, adminID, "config.update", "config", "", map[string]string{
			"timezone": req.Timezone,
		})

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}
