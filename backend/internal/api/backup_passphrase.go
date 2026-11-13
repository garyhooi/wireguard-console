package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/auth"
)

const (
	minBackupPassphraseRunes   = 12
	maxBackupPassphraseRunes   = 256
	maxBackupPassphraseHistory = 10
)

type backupPassphraseState struct {
	Enabled    bool
	CurrentEnc string
	History    []string
}

func loadBackupPassphraseState(ctx context.Context, pool *pgxpool.Pool) (backupPassphraseState, error) {
	var state backupPassphraseState
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(backup_passphrase_enabled, FALSE),
		       COALESCE(backup_passphrase_enc, ''),
		       COALESCE(backup_passphrase_history_enc, '{}')
		FROM config WHERE id = 1
	`).Scan(&state.Enabled, &state.CurrentEnc, &state.History)
	if errors.Is(err, pgx.ErrNoRows) {
		return backupPassphraseState{History: []string{}}, nil
	}
	if err != nil {
		return state, err
	}
	if state.History == nil {
		state.History = []string{}
	}
	return state, nil
}

func decryptBackupPassphrase(encrypted string) (string, error) {
	if encrypted == "" {
		return "", nil
	}
	svc, err := auth.NewEncryptionService()
	if err != nil {
		return "", fmt.Errorf("encryption is not configured: %w", err)
	}
	plain, err := svc.Decrypt(encrypted)
	if err != nil {
		return "", fmt.Errorf("stored backup passphrase could not be decrypted: %w", err)
	}
	return plain, nil
}

// CurrentPassphrase returns the passphrase that new backups must use. It is
// empty when backup encryption is disabled.
func (s backupPassphraseState) CurrentPassphrase() (string, error) {
	if !s.Enabled {
		return "", nil
	}
	if s.CurrentEnc == "" {
		return "", errors.New("backup encryption is enabled but no passphrase is stored")
	}
	return decryptBackupPassphrase(s.CurrentEnc)
}

// RestorePassphrases returns the current passphrase followed by retained
// historical passphrases, so a backup made before a passphrase change can
// still be restored. The list is deduplicated.
func (s backupPassphraseState) RestorePassphrases() ([]string, error) {
	candidates := make([]string, 0, len(s.History)+1)
	if s.CurrentEnc != "" {
		candidates = append(candidates, s.CurrentEnc)
	}
	candidates = append(candidates, s.History...)
	out := make([]string, 0, len(candidates))
	var firstErr error
	for _, encrypted := range candidates {
		if encrypted == "" {
			continue
		}
		plain, err := decryptBackupPassphrase(encrypted)
		if err != nil {
			// One unreadable historical entry must not block a backup that
			// the current (or another retained) passphrase can open.
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		seen := false
		for _, existing := range out {
			if existing == plain {
				seen = true
				break
			}
		}
		if !seen {
			out = append(out, plain)
		}
	}
	if len(out) == 0 && firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}

func pushBackupPassphraseHistory(history []string, encrypted string) []string {
	if encrypted == "" {
		return history
	}
	out := make([]string, 0, len(history)+1)
	out = append(out, encrypted)
	for _, item := range history {
		if item == "" || item == encrypted {
			continue
		}
		dup := false
		for _, existing := range out {
			if existing == item {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, item)
		}
	}
	if len(out) > maxBackupPassphraseHistory {
		out = out[:maxBackupPassphraseHistory]
	}
	return out
}

func backupPassphraseEnabled(store *Store) bool {
	state, err := loadBackupPassphraseState(context.Background(), store.pool)
	return err == nil && state.Enabled && state.CurrentEnc != ""
}

func GetBackupPassphraseConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		state, err := loadBackupPassphraseState(context.Background(), store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load backup encryption setting")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"enabled":       state.Enabled,
			"configured":    state.CurrentEnc != "",
			"history_count": len(state.History),
		})
	}
}

// UpdateBackupPassphraseConfig sets/clears the backup passphrase. Security
// policy changes use the strict MFA variant, so a grace window never applies.
func UpdateBackupPassphraseConfig(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Enabled    bool   `json:"enabled"`
			Passphrase string `json:"passphrase"`
			Code       string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		ctx := context.Background()
		adminID := getAdminID(r)
		if !verifyActorMFACode(w, r, ctx, store, adminID, req.Code) {
			return
		}

		state, err := loadBackupPassphraseState(ctx, store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load backup encryption setting")
			return
		}

		passphrase := req.Passphrase
		newEnc := ""
		changed := false
		if strings.TrimSpace(passphrase) != "" {
			if !req.Enabled {
				writeError(w, http.StatusBadRequest, "Enable backup encryption before setting a passphrase")
				return
			}
			count := utf8.RuneCountInString(passphrase)
			if count < minBackupPassphraseRunes {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("Backup passphrase must be at least %d characters", minBackupPassphraseRunes))
				return
			}
			if count > maxBackupPassphraseRunes {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("Backup passphrase must be at most %d characters", maxBackupPassphraseRunes))
				return
			}
			// Re-saving the same passphrase must not rotate the retained
			// history (encryption is randomised, so the ciphertext differs
			// even for identical plaintext).
			if state.CurrentEnc != "" {
				if current, err := decryptBackupPassphrase(state.CurrentEnc); err == nil && current == passphrase {
					newEnc = state.CurrentEnc
				}
			}
			if newEnc == "" {
				encSvc, err := auth.NewEncryptionService()
				if err != nil {
					writeError(w, http.StatusInternalServerError, "Encryption is not configured")
					return
				}
				newEnc, err = encSvc.Encrypt(passphrase)
				if err != nil {
					writeError(w, http.StatusInternalServerError, "Failed to protect backup passphrase")
					return
				}
				changed = newEnc != state.CurrentEnc
			}
		}

		if req.Enabled && state.CurrentEnc == "" && newEnc == "" {
			writeError(w, http.StatusBadRequest, "A backup passphrase is required when encryption is enabled")
			return
		}

		currentEnc := state.CurrentEnc
		history := state.History
		if newEnc != "" {
			if currentEnc != "" && currentEnc != newEnc {
				history = pushBackupPassphraseHistory(history, currentEnc)
			}
			currentEnc = newEnc
		}
		if !req.Enabled {
			if currentEnc != "" {
				history = pushBackupPassphraseHistory(history, currentEnc)
				currentEnc = ""
				changed = true
			}
		}

		if _, err := store.pool.Exec(ctx, `
			INSERT INTO config (id, backup_passphrase_enc, backup_passphrase_enabled, backup_passphrase_history_enc)
			VALUES (1, $1, $2, $3)
			ON CONFLICT (id) DO UPDATE SET
				backup_passphrase_enc = EXCLUDED.backup_passphrase_enc,
				backup_passphrase_enabled = EXCLUDED.backup_passphrase_enabled,
				backup_passphrase_history_enc = EXCLUDED.backup_passphrase_history_enc,
				updated_at = now()
		`, currentEnc, req.Enabled && currentEnc != "", history); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save backup encryption setting")
			return
		}

		logAudit(ctx, store, adminID, "backup.passphrase.update", "config", "", map[string]interface{}{
			"enabled":       req.Enabled && currentEnc != "",
			"changed":       changed,
			"history_count": len(history),
		})

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":        "updated",
			"enabled":       req.Enabled && currentEnc != "",
			"configured":    currentEnc != "",
			"history_count": len(history),
		})
	}
}
