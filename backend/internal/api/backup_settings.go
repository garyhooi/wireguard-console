package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/auth"
	"github.com/wireguard-console/backend/internal/backup"
)

type s3SettingsState struct {
	Enabled         bool
	Endpoint        string
	Region          string
	Bucket          string
	Prefix          string
	AccessKeyID     string
	SecretKeyEnc    string
	SessionTokenEnc string
	ForcePathStyle  bool
}

type s3SettingsResponse struct {
	Enabled         bool   `json:"enabled"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	Prefix          string `json:"prefix"`
	AccessKeyID     string `json:"access_key_id"`
	SecretSet       bool   `json:"secret_set"`
	SessionTokenSet bool   `json:"session_token_set"`
	ForcePathStyle  bool   `json:"force_path_style"`
}

type backupScheduleState struct {
	IntervalHours  int        `json:"interval_hours"`
	RetentionCount int        `json:"retention_count"`
	LastAutoAt     *time.Time `json:"last_auto_at,omitempty"`
}

func loadS3Settings(ctx context.Context, pool *pgxpool.Pool) (s3SettingsState, error) {
	var s s3SettingsState
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(s3_enabled, FALSE),
		       COALESCE(s3_endpoint, ''),
		       COALESCE(s3_region, 'us-east-1'),
		       COALESCE(s3_bucket, ''),
		       COALESCE(s3_prefix, 'wireguard-console/backups'),
		       COALESCE(s3_access_key_id, ''),
		       COALESCE(s3_secret_key_enc, ''),
		       COALESCE(s3_session_token_enc, ''),
		       COALESCE(s3_force_path_style, FALSE)
		FROM config WHERE id = 1
	`).Scan(&s.Enabled, &s.Endpoint, &s.Region, &s.Bucket, &s.Prefix, &s.AccessKeyID, &s.SecretKeyEnc, &s.SessionTokenEnc, &s.ForcePathStyle)
	if errors.Is(err, pgx.ErrNoRows) {
		return s3SettingsState{Region: "us-east-1", Prefix: "wireguard-console/backups"}, nil
	}
	return s, err
}

func loadBackupSchedule(ctx context.Context, pool *pgxpool.Pool) (backupScheduleState, error) {
	var s backupScheduleState
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(backup_interval_hours, 0),
		       COALESCE(backup_retention_count, 0),
		       backup_last_auto_at
		FROM config WHERE id = 1
	`).Scan(&s.IntervalHours, &s.RetentionCount, &s.LastAutoAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, nil
	}
	return s, err
}

func decryptOptionalSecret(encrypted string) (string, error) {
	if encrypted == "" {
		return "", nil
	}
	svc, err := auth.NewEncryptionService()
	if err != nil {
		return "", fmt.Errorf("encryption is not configured: %w", err)
	}
	plain, err := svc.Decrypt(encrypted)
	if err != nil {
		return "", fmt.Errorf("stored S3 credential could not be decrypted: %w", err)
	}
	return plain, nil
}

func encryptOptionalSecret(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	svc, err := auth.NewEncryptionService()
	if err != nil {
		return "", fmt.Errorf("encryption is not configured: %w", err)
	}
	return svc.Encrypt(value)
}

func (s s3SettingsState) config() (backup.S3Config, error) {
	secret, err := decryptOptionalSecret(s.SecretKeyEnc)
	if err != nil {
		return backup.S3Config{}, err
	}
	token, err := decryptOptionalSecret(s.SessionTokenEnc)
	if err != nil {
		return backup.S3Config{}, err
	}
	return backup.S3Config{
		Endpoint:        s.Endpoint,
		Region:          s.Region,
		Bucket:          s.Bucket,
		Prefix:          s.Prefix,
		AccessKeyID:     s.AccessKeyID,
		SecretAccessKey: secret,
		SessionToken:    token,
		ForcePathStyle:  s.ForcePathStyle,
	}, nil
}

func (s s3SettingsState) response() s3SettingsResponse {
	return s3SettingsResponse{
		Enabled:         s.Enabled,
		Endpoint:        s.Endpoint,
		Region:          s.Region,
		Bucket:          s.Bucket,
		Prefix:          s.Prefix,
		AccessKeyID:     s.AccessKeyID,
		SecretSet:       s.SecretKeyEnc != "",
		SessionTokenSet: s.SessionTokenEnc != "",
		ForcePathStyle:  s.ForcePathStyle,
	}
}

type s3SettingsRequest struct {
	Enabled         bool   `json:"enabled"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	Prefix          string `json:"prefix"`
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	SessionToken    string `json:"session_token"`
	ForcePathStyle  bool   `json:"force_path_style"`
}

func normalizeS3Request(req s3SettingsRequest, current s3SettingsState) (s3SettingsState, error) {
	state := current
	state.Enabled = req.Enabled
	state.Endpoint = strings.TrimSpace(req.Endpoint)
	if state.Endpoint != "" && !strings.Contains(state.Endpoint, "://") {
		state.Endpoint = "https://" + state.Endpoint
	}
	if state.Endpoint != "" {
		u, err := url.Parse(state.Endpoint)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return state, fmt.Errorf("S3 endpoint must be a valid http(s) URL")
		}
		if u.User != nil {
			return state, fmt.Errorf("S3 endpoint must not include credentials in the URL")
		}
		state.Endpoint = strings.TrimRight(state.Endpoint, "/")
	}
	state.Region = strings.TrimSpace(req.Region)
	if state.Region == "" {
		state.Region = "us-east-1"
	}
	state.Bucket = strings.TrimSpace(req.Bucket)
	state.Prefix = strings.Trim(strings.TrimSpace(req.Prefix), "/")
	if state.Prefix == "" {
		state.Prefix = "wireguard-console/backups"
	}
	for _, part := range strings.Split(state.Prefix, "/") {
		if part == "." || part == ".." {
			return state, fmt.Errorf("S3 prefix cannot contain . or .. segments")
		}
	}
	previousAccessKeyID := current.AccessKeyID
	state.AccessKeyID = strings.TrimSpace(req.AccessKeyID)
	state.ForcePathStyle = req.ForcePathStyle

	// An empty access key means "use the container's AWS credential chain";
	// clear any previously stored static secret in that case.
	if state.AccessKeyID == "" {
		if req.SecretAccessKey != "" || req.SessionToken != "" {
			return state, fmt.Errorf("S3 access key ID is required when a secret or session token is provided")
		}
		state.SecretKeyEnc = ""
		state.SessionTokenEnc = ""
	} else if req.SecretAccessKey == "" && previousAccessKeyID != "" && previousAccessKeyID != state.AccessKeyID {
		return state, fmt.Errorf("enter the secret access key for the new access key ID")
	} else if req.SecretAccessKey != "" {
		enc, err := encryptOptionalSecret(req.SecretAccessKey)
		if err != nil {
			return state, err
		}
		state.SecretKeyEnc = enc
		if req.SessionToken != "" {
			tokenEnc, err := encryptOptionalSecret(req.SessionToken)
			if err != nil {
				return state, err
			}
			state.SessionTokenEnc = tokenEnc
		} else {
			state.SessionTokenEnc = ""
		}
	} else if state.SecretKeyEnc == "" {
		return state, fmt.Errorf("S3 secret access key is required unless the container provides AWS credentials")
	} else if req.SessionToken != "" {
		tokenEnc, err := encryptOptionalSecret(req.SessionToken)
		if err != nil {
			return state, err
		}
		state.SessionTokenEnc = tokenEnc
	}

	cfg, err := state.config()
	if err != nil {
		return state, err
	}
	if state.Enabled {
		if err := cfg.Validate(); err != nil {
			return state, err
		}
	}
	return state, nil
}

func saveS3Settings(ctx context.Context, store *Store, state s3SettingsState) error {
	_, err := store.pool.Exec(ctx, `
		INSERT INTO config (id, s3_enabled, s3_endpoint, s3_region, s3_bucket, s3_prefix,
		                    s3_access_key_id, s3_secret_key_enc, s3_session_token_enc, s3_force_path_style)
		VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (id) DO UPDATE SET
			s3_enabled = EXCLUDED.s3_enabled,
			s3_endpoint = EXCLUDED.s3_endpoint,
			s3_region = EXCLUDED.s3_region,
			s3_bucket = EXCLUDED.s3_bucket,
			s3_prefix = EXCLUDED.s3_prefix,
			s3_access_key_id = EXCLUDED.s3_access_key_id,
			s3_secret_key_enc = EXCLUDED.s3_secret_key_enc,
			s3_session_token_enc = EXCLUDED.s3_session_token_enc,
			s3_force_path_style = EXCLUDED.s3_force_path_style,
			updated_at = now()
	`, state.Enabled, state.Endpoint, state.Region, state.Bucket, state.Prefix,
		state.AccessKeyID, state.SecretKeyEnc, state.SessionTokenEnc, state.ForcePathStyle)
	return err
}

func GetBackupSettings(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := context.Background()
		s3, err := loadS3Settings(ctx, store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load backup settings")
			return
		}
		schedule, err := loadBackupSchedule(ctx, store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load backup schedule")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"s3":       s3.response(),
			"schedule": schedule,
		})
	}
}

func UpdateS3Settings(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req s3SettingsRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		ctx := context.Background()
		current, err := loadS3Settings(ctx, store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load backup settings")
			return
		}
		state, err := normalizeS3Request(req, current)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := saveS3Settings(ctx, store, state); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save S3 settings")
			return
		}
		logAudit(ctx, store, getAdminID(r), "backup.s3.update", "config", "", map[string]interface{}{
			"enabled":  state.Enabled,
			"endpoint": state.Endpoint,
			"bucket":   state.Bucket,
			"prefix":   state.Prefix,
		})
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status": "updated",
			"s3":     state.response(),
		})
	}
}

func TestS3Settings(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req s3SettingsRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		current, err := loadS3Settings(ctx, store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load backup settings")
			return
		}
		state, err := normalizeS3Request(req, current)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		cfg, err := state.config()
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := cfg.Test(ctx); err != nil {
			writeError(w, http.StatusBadGateway, "S3 connection test failed: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func UpdateBackupSchedule(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			IntervalHours  int `json:"interval_hours"`
			RetentionCount int `json:"retention_count"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if req.IntervalHours < 0 || req.IntervalHours > 720 {
			writeError(w, http.StatusBadRequest, "Backup interval must be between 0 and 720 hours")
			return
		}
		if req.RetentionCount < 0 || req.RetentionCount > 100 {
			writeError(w, http.StatusBadRequest, "Retention count must be between 0 and 100")
			return
		}
		ctx := context.Background()
		if _, err := store.pool.Exec(ctx, `
			INSERT INTO config (id, backup_interval_hours, backup_retention_count)
			VALUES (1, $1, $2)
			ON CONFLICT (id) DO UPDATE SET
				backup_interval_hours = EXCLUDED.backup_interval_hours,
				backup_retention_count = EXCLUDED.backup_retention_count,
				updated_at = now()
		`, req.IntervalHours, req.RetentionCount); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save backup schedule")
			return
		}
		logAudit(ctx, store, getAdminID(r), "backup.schedule.update", "config", "", map[string]interface{}{
			"interval_hours":  req.IntervalHours,
			"retention_count": req.RetentionCount,
		})
		schedule, err := loadBackupSchedule(ctx, store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Schedule saved but could not be read")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":   "updated",
			"schedule": schedule,
		})
	}
}
