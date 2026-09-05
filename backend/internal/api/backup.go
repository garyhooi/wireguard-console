package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wireguard-console/backend/internal/backup"
)

// backupDataDir returns the directory backups live in (env override, else
// the container default).
func backupDataDir() string {
	if d := os.Getenv("BACKUP_DIR"); d != "" {
		return d
	}
	return "/var/backups/wgconsole"
}

func CreateBackup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		svc := backup.NewBackupService(backupDataDir())
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

// backupDownloadName normalises an uploaded filename into a safe backup file
// name inside the backup dir (base name only, no path separators).
func backupDownloadName(filename string) string {
	filename = filepath.Base(strings.TrimSpace(filename))
	if filename == "." || filename == "" {
		return ""
	}
	return filename
}

// DownloadBackup streams a stored backup to the admin's browser. The acting
// admin must confirm with their own 2FA code (passed as a query/body field),
// because backups contain the full database (secrets, encrypted keys).
func DownloadBackup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		var req struct {
			Filename string `json:"filename"`
			Code     string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if req.Filename == "" {
			writeError(w, http.StatusBadRequest, "filename is required")
			return
		}
		if !verifyActor2FA(w, ctx, store, adminID, req.Code) {
			return
		}

		name := backupDownloadName(req.Filename)
		if name == "" {
			writeError(w, http.StatusBadRequest, "invalid filename")
			return
		}
		backupPath := filepath.Join(backupDataDir(), name)
		f, err := os.Open(backupPath)
		if err != nil {
			writeError(w, http.StatusNotFound, "Backup not found")
			return
		}
		defer f.Close()

		logAudit(ctx, store, adminID, "backup.download", "backup", name, nil)

		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
		_, _ = io.Copy(w, f)
	}
}

// RestoreBackup replaces the current database with a stored backup file.
// The acting admin must confirm with their own 2FA code.
func RestoreBackup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		var req struct {
			Filename string `json:"filename"`
			Code     string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Filename == "" {
			writeError(w, http.StatusBadRequest, "filename is required")
			return
		}
		if !verifyActor2FA(w, ctx, store, adminID, req.Code) {
			return
		}

		// Guard against path traversal — only files inside the backup dir.
		name := backupDownloadName(req.Filename)
		if name == "" {
			writeError(w, http.StatusBadRequest, "invalid filename")
			return
		}
		backupPath := filepath.Join(backupDataDir(), name)
		if _, err := os.Stat(backupPath); err != nil {
			writeError(w, http.StatusNotFound, "Backup not found")
			return
		}

		svc := backup.NewBackupService(backupDataDir())
		if err := svc.RestoreBackup(backupPath); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to restore backup")
			return
		}

		logAudit(ctx, store, adminID, "backup.restore", "backup", name, nil)

		writeJSON(w, http.StatusOK, map[string]string{
			"status":   "restored",
			"filepath": name,
		})
	}
}

// RestoreBackupUpload accepts a .sql.gz file uploaded by the admin, saves it
// into the backup dir, and restores it. The acting admin must confirm with
// their own 2FA code (multipart form field "code").
func RestoreBackupUpload(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		if err := r.ParseMultipartForm(64 << 20); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid upload (max 64MB)")
			return
		}
		code := r.FormValue("code")
		if !verifyActor2FA(w, ctx, store, adminID, code) {
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "file is required")
			return
		}
		defer file.Close()

		// The uploaded file must look like a console backup. Keep the base
		// name but ensure it ends with .sql.gz so restores can never point
		// at an arbitrary file type.
		uploadName := backupDownloadName(header.Filename)
		if uploadName == "" || !strings.HasSuffix(uploadName, ".sql.gz") {
			writeError(w, http.StatusBadRequest, "Uploaded file must be a .sql.gz backup")
			return
		}
		// Prefix with a timestamp to avoid clobbering an existing file with
		// the same name.
		finalName := fmt.Sprintf("%s_%s", time.Now().Format("20060102_150405"), uploadName)
		dstPath := filepath.Join(backupDataDir(), finalName)

		dst, err := os.Create(dstPath)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save upload")
			return
		}
		if _, err := io.Copy(dst, file); err != nil {
			dst.Close()
			os.Remove(dstPath)
			writeError(w, http.StatusInternalServerError, "Failed to save upload")
			return
		}
		dst.Close()

		svc := backup.NewBackupService(backupDataDir())
		if err := svc.RestoreBackup(dstPath); err != nil {
			os.Remove(dstPath)
			writeError(w, http.StatusInternalServerError, "Failed to restore uploaded backup")
			return
		}

		logAudit(ctx, store, adminID, "backup.restore_upload", "backup", finalName, nil)

		writeJSON(w, http.StatusOK, map[string]string{
			"status":   "restored",
			"filepath": finalName,
		})
	}
}

func DeleteBackup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		var req struct {
			Filename string `json:"filename"`
			Code     string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Filename == "" {
			writeError(w, http.StatusBadRequest, "filename is required")
			return
		}
		if !verifyActor2FA(w, ctx, store, adminID, req.Code) {
			return
		}

		svc := backup.NewBackupService(backupDataDir())
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
		svc := backup.NewBackupService(backupDataDir())
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
