package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Step-up 2FA grace window (Configuration → Security, super_admin only).
//
// loadStepUpMinutes returns how many minutes after one successful step-up
// 2FA verification an admin's same session is trusted for the other
// sensitive actions without re-entering a code. 0 (default) = disabled:
// every sensitive action asks for a code.

func loadStepUpMinutes(ctx context.Context, pool *pgxpool.Pool) int {
	var minutes int
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(step_up_minutes, 0) FROM config WHERE id = 1
	`).Scan(&minutes)
	if err != nil {
		return 0
	}
	if minutes < 0 {
		return 0
	}
	return minutes
}

// GetStepUpConfig returns the configured 2FA step-up grace window.
// Readable by every signed-in admin (the SPA shows the current policy).
func GetStepUpConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		writeJSON(w, http.StatusOK, map[string]int{
			"step_up_minutes": loadStepUpMinutes(ctx, store.pool),
		})
	}
}

// UpdateStepUpConfig persists the 2FA step-up grace window (minutes).
// super_admin only (route-gated): a security policy setting. 0 disables the
// grace — every sensitive action asks for the actor's code again.
func UpdateStepUpConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			StepUpMinutes int `json:"step_up_minutes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if req.StepUpMinutes < 0 || req.StepUpMinutes > 1440 {
			writeError(w, http.StatusBadRequest, "step_up_minutes must be between 0 and 1440 (0 = ask every time)")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		if _, err := store.pool.Exec(ctx, `
			INSERT INTO config (id, step_up_minutes) VALUES (1, $1)
			ON CONFLICT (id) DO UPDATE SET
				step_up_minutes = EXCLUDED.step_up_minutes, updated_at = now()
		`, req.StepUpMinutes); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save 2FA step-up window")
			return
		}

		logAudit(ctx, store, adminID, "config.update", "config", "", map[string]interface{}{
			"step_up_minutes": req.StepUpMinutes,
		})

		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}
