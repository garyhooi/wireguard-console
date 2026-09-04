package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/wireguard-console/backend/internal/backup"
)

func CreateBackup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		dataDir := os.Getenv("BACKUP_DIR")
		if dataDir == "" {
			dataDir = "/var/backups/wgconsole"
		}

		svc := backup.NewBackupService(dataDir)
		backupPath, err := svc.CreateBackup()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create backup")
			return
		}

		logAudit(ctx, store, adminID, "backup.create", "backup", backupPath, nil)

		writeJSON(w, http.StatusOK, map[string]string{
			"status":   "created",
			"filepath": backupPath,
		})
	}
}

func RestoreBackup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		dataDir := os.Getenv("BACKUP_DIR")
		if dataDir == "" {
			dataDir = "/var/backups/wgconsole"
		}

		var req struct {
			Filename string `json:"filename"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Filename == "" {
			writeError(w, http.StatusBadRequest, "filename is required")
			return
		}

		// Guard against path traversal — only files inside the backup dir.
		backupPath := filepath.Join(dataDir, filepath.Base(req.Filename))
		if _, err := os.Stat(backupPath); err != nil {
			writeError(w, http.StatusNotFound, "Backup not found")
			return
		}

		svc := backup.NewBackupService(dataDir)
		if err := svc.RestoreBackup(backupPath); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to restore backup")
			return
		}

		logAudit(ctx, store, adminID, "backup.restore", "backup", backupPath, nil)

		writeJSON(w, http.StatusOK, map[string]string{
			"status":   "restored",
			"filepath": backupPath,
		})
	}
}

func DeleteBackup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		dataDir := os.Getenv("BACKUP_DIR")
		if dataDir == "" {
			dataDir = "/var/backups/wgconsole"
		}

		var req struct {
			Filename string `json:"filename"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Filename == "" {
			writeError(w, http.StatusBadRequest, "filename is required")
			return
		}

		svc := backup.NewBackupService(dataDir)
		if err := svc.DeleteBackup(req.Filename); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete backup")
			return
		}

		logAudit(ctx, store, adminID, "backup.delete", "backup", req.Filename, nil)

		writeJSON(w, http.StatusOK, map[string]string{
			"status":   "deleted",
			"filename": req.Filename,
		})
	}
}

func ListBackups(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dataDir := os.Getenv("BACKUP_DIR")
		if dataDir == "" {
			dataDir = "/var/backups/wgconsole"
		}

		svc := backup.NewBackupService(dataDir)
		backups, err := svc.ListBackups()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to list backups")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"backups": backups,
		})
	}
}
