package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type EmailTemplate struct {
	Key       string `json:"key"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	UpdatedAt string `json:"updated_at"`
}

// renderTemplate substitutes {{var}} placeholders.
func renderTemplate(text string, vars map[string]string) string {
	for k, v := range vars {
		text = strings.ReplaceAll(text, "{{"+k+"}}", v)
	}
	return text
}

// loadEmailTemplate fetches a template by key, falling back to a plain
// placeholder-based default if the row is missing (e.g. pre-migration DBs).
func loadEmailTemplate(ctx context.Context, pool *pgxpool.Pool, key, defaultSubject, defaultBody string) (string, string) {
	var subject, body string
	err := pool.QueryRow(ctx,
		`SELECT subject, body FROM email_templates WHERE key = $1`, key).Scan(&subject, &body)
	if err != nil {
		return defaultSubject, defaultBody
	}
	return subject, body
}

func ListEmailTemplates(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		rows, err := store.pool.Query(ctx, `
			SELECT key, subject, body, updated_at FROM email_templates ORDER BY key
		`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to list templates")
			return
		}
		defer rows.Close()

		templates := []EmailTemplate{}
		for rows.Next() {
			var t EmailTemplate
			var updated time.Time
			if err := rows.Scan(&t.Key, &t.Subject, &t.Body, &updated); err != nil {
				continue
			}
			t.UpdatedAt = updated.UTC().Format(time.RFC3339)
			templates = append(templates, t)
		}
		writeJSON(w, http.StatusOK, templates)
	}
}

func UpdateEmailTemplate(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.PathValue("key")
		if key == "" {
			writeError(w, http.StatusBadRequest, "Template key is required")
			return
		}
		var req struct {
			Subject string `json:"subject"`
			Body    string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if req.Subject == "" || req.Body == "" {
			writeError(w, http.StatusBadRequest, "subject and body are required")
			return
		}

		ctx := context.Background()
		adminID := getAdminID(r)

		if _, err := store.pool.Exec(ctx, `
			INSERT INTO email_templates (key, subject, body, updated_at)
			VALUES ($1, $2, $3, now())
			ON CONFLICT (key) DO UPDATE SET subject = $2, body = $3, updated_at = now()
		`, key, req.Subject, req.Body); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save template")
			return
		}

		logAudit(ctx, store, adminID, "email_template.update", "email_template", key, nil)
		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}