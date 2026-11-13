package api

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wireguard-console/backend/internal/backup"
)

func TestApplyBackupRetentionLocal(t *testing.T) {
	dir := t.TempDir()
	svc := backup.NewBackupService(dir)
	for _, name := range []string{
		"wgconsole_backup_20260101_000000.sql.gz",
		"wgconsole_backup_20260102_000000.sql.gz",
		"wgconsole_backup_20260103_000000.sql.gz",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := applyBackupRetention(context.Background(), svc, s3SettingsState{}, backup.S3Config{}, 1); err != nil {
		t.Fatal(err)
	}
	names, err := svc.ListBackups()
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "wgconsole_backup_20260103_000000.sql.gz" {
		t.Fatalf("remaining backups = %v, want newest only", names)
	}
}
func TestBackupDue(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	if backupDue(nil, 0, now) {
		t.Fatal("disabled schedule reported due")
	}
	if !backupDue(nil, 24, now) {
		t.Fatal("first run was not due")
	}
	recent := now.Add(-23 * time.Hour)
	if backupDue(&recent, 24, now) {
		t.Fatal("schedule ran before its interval")
	}
	old := now.Add(-25 * time.Hour)
	if !backupDue(&old, 24, now) {
		t.Fatal("schedule was not due after its interval")
	}
}
