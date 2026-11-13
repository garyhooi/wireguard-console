package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/wireguard-console/backend/internal/backup"
)

// Serialise dump/verify/upload/restore operations. A backup started while a
// restore is running would otherwise capture a half-replaced database.
var backupOperationMu sync.Mutex

type backupRunOutcome struct {
	Result           backup.BackupResult
	S3Configured     bool
	S3Uploaded       bool
	S3Key            string
	S3Warning        string
	RetentionWarning string
}

func runBackup(ctx context.Context, store *Store) (backupRunOutcome, error) {
	backupOperationMu.Lock()
	defer backupOperationMu.Unlock()

	state, err := loadBackupPassphraseState(ctx, store.pool)
	if err != nil {
		return backupRunOutcome{}, err
	}
	passphrase, err := state.CurrentPassphrase()
	if err != nil {
		return backupRunOutcome{}, err
	}

	s3State, err := loadS3Settings(ctx, store.pool)
	if err != nil {
		return backupRunOutcome{}, err
	}
	var (
		s3Cfg           backup.S3Config
		s3Enabled       = s3State.Enabled
		s3Ready         = false
		s3ConfigWarning string
	)
	if s3Enabled {
		s3Cfg, err = s3State.config()
		if err == nil {
			err = s3Cfg.Validate()
		}
		if err != nil {
			// A bad destination must not stop local backups. Keep the archive,
			// skip remote retention, and report the problem to the actor/log.
			s3ConfigWarning = "S3 destination is enabled but could not be loaded. The backup was kept locally; fix the S3 settings before relying on remote copies."
			log.Printf("S3 backup destination unavailable: %v", err)
		} else {
			s3Ready = true
		}
	}

	schedule, err := loadBackupSchedule(ctx, store.pool)
	if err != nil {
		return backupRunOutcome{}, err
	}

	svc := backup.NewBackupService(backupDataDir())
	result, err := svc.CreateBackup(passphrase)
	if err != nil {
		return backupRunOutcome{}, err
	}
	outcome := backupRunOutcome{
		Result:       result,
		S3Configured: s3Enabled,
	}
	if s3ConfigWarning != "" {
		outcome.S3Warning = s3ConfigWarning
	}

	if !result.Verified {
		// Never leave only an unverified remote copy, and never prune verified
		// history for one. The local archive remains available for inspection.
		if s3Enabled {
			outcome.S3Warning = "Backup was created locally, but was not uploaded to S3 because its automatic restore check failed."
		}
	} else if s3Ready {
		key := s3Cfg.Key(result.Filename)
		if err := s3Cfg.Upload(ctx, result.Path, key); err != nil {
			outcome.S3Warning = "Backup was created locally, but the S3 upload failed. See server logs."
			log.Printf("Backup %s S3 upload failed: %v", result.Filename, err)
		} else {
			outcome.S3Uploaded = true
			outcome.S3Key = key
			if err := svc.MarkS3Uploaded(result.Filename, key); err != nil {
				outcome.S3Warning = "Backup was uploaded to S3, but its local upload metadata could not be recorded."
				log.Printf("Backup %s S3 metadata write failed: %v", result.Filename, err)
			}
		}
	}

	// Do not delete older copies when the newest one could not reach S3: the
	// remote copy may be the only durable one, and retention should wait.
	if schedule.RetentionCount > 0 && result.Verified && (!s3Enabled || outcome.S3Uploaded) {
		if err := applyBackupRetention(ctx, svc, s3State, s3Cfg, schedule.RetentionCount); err != nil {
			outcome.RetentionWarning = "Backup retention could not remove all old backups. See server logs."
			log.Printf("Backup retention failed: %v", err)
		}
	}
	return outcome, nil
}

func applyBackupRetention(ctx context.Context, svc *backup.BackupService, s3State s3SettingsState, s3Cfg backup.S3Config, keep int) error {
	if keep <= 0 {
		return nil
	}
	names, err := svc.ListBackups()
	if err != nil {
		return err
	}
	if len(names) <= keep {
		return nil
	}
	sort.Strings(names)
	for _, name := range names[:len(names)-keep] {
		meta := svc.ReadMetadata(name)
		if s3State.Enabled {
			key := meta.S3Key
			if key == "" {
				key = s3Cfg.Key(name)
			}
			if err := s3Cfg.Delete(ctx, key); err != nil {
				return fmt.Errorf("delete S3 object %s: %w", key, err)
			}
		}
		if err := svc.DeleteBackup(name); err != nil {
			return fmt.Errorf("delete local backup %s: %w", name, err)
		}
	}
	return nil
}

// RunScheduledBackup is called by the background worker. It uses the same
// serialised backup path as a manual create, and updates last-run before doing
// the work so a crash cannot cause a tight retry loop every minute.
func RunScheduledBackup(ctx context.Context, store *Store) error {
	schedule, err := loadBackupSchedule(ctx, store.pool)
	if err != nil {
		return err
	}
	if !backupDue(schedule.LastAutoAt, schedule.IntervalHours, time.Now().UTC()) {
		return nil
	}
	if _, err := store.pool.Exec(ctx, `
		INSERT INTO config (id, backup_last_auto_at) VALUES (1, now())
		ON CONFLICT (id) DO UPDATE SET backup_last_auto_at = now()
	`); err != nil {
		return err
	}

	outcome, err := runBackup(ctx, store)
	if err != nil {
		log.Printf("Automatic backup failed: %v", err)
		logSystemAudit(ctx, store, "backup.auto.failed", "backup", "", map[string]interface{}{"error": err.Error()})
		return err
	}
	log.Printf("Automatic backup created: %s (verified=%v, s3=%v)", outcome.Result.Filename, outcome.Result.Verified, outcome.S3Uploaded)
	logSystemAudit(ctx, store, "backup.auto", "backup", outcome.Result.Filename, map[string]interface{}{
		"verified":         outcome.Result.Verified,
		"encrypted":        outcome.Result.Encrypted,
		"size":             outcome.Result.Size,
		"s3_configured":    outcome.S3Configured,
		"s3_uploaded":      outcome.S3Uploaded,
		"s3_key":           outcome.S3Key,
		"retention_warned": outcome.RetentionWarning != "",
	})
	return nil
}

func backupDue(last *time.Time, intervalHours int, now time.Time) bool {
	if intervalHours <= 0 {
		return false
	}
	if last == nil {
		return true
	}
	return !now.Before(last.Add(time.Duration(intervalHours) * time.Hour))
}

func logSystemAudit(ctx context.Context, store *Store, action, targetType, targetID string, metadata interface{}) {
	metaJSON, _ := json.Marshal(metadata)
	_, _ = store.pool.Exec(ctx, `
		INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id, metadata, ip_address)
		VALUES (NULL, $1, $2, $3, $4, NULL)
	`, action, targetType, targetID, string(metaJSON))
}
