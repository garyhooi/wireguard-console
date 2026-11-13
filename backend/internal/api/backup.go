package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wireguard-console/backend/internal/backup"
	"github.com/wireguard-console/backend/internal/db"
)

// restoreAndUpgrade restores a backup file and then re-runs the (idempotent)
// migrations. A backup can predate the running binary — most importantly the
// pre-MFA dumps have no pending_kind / webauthn_* schema — so the live process
// must upgrade the restored database before serving another request.
func restoreAndUpgrade(svc *backup.BackupService, store *Store, backupPath string, passphrases []string) error {
	if err := svc.RestoreBackup(backupPath, passphrases); err != nil {
		return err
	}
	if err := db.RunMigrationsFor(store.pool); err != nil {
		return fmt.Errorf("restored database but failed to apply migrations: %w", err)
	}
	return nil
}

// backupDataDir returns the directory backups live in (env override, else
// the container default).
func backupDataDir() string {
	if d := os.Getenv("BACKUP_DIR"); d != "" {
		return d
	}
	return "/var/backups/wgconsole"
}

// backupRestorePassphrases loads stored passphrases only when the archive is
// actually encrypted. A plain backup must remain restorable even if the
// encryption setting is broken or its key cannot be decrypted.
func backupRestorePassphrases(ctx context.Context, store *Store, backupPath string) ([]string, error) {
	encrypted, err := backup.IsEncryptedFile(backupPath)
	if err != nil {
		return nil, err
	}
	if !encrypted {
		return nil, nil
	}
	state, err := loadBackupPassphraseState(ctx, store.pool)
	if err != nil {
		return nil, err
	}
	return state.RestorePassphrases()
}

func CreateBackup(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		state, err := loadBackupPassphraseState(ctx, store.pool)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load backup encryption setting")
			return
		}
		passphrase, err := state.CurrentPassphrase()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		svc := backup.NewBackupService(backupDataDir())
		result, err := svc.CreateBackup(passphrase)
		if err != nil {
			log.Printf("Failed to create backup: %v", err)
			writeError(w, http.StatusInternalServerError, "Failed to create backup")
			return
		}

		logAudit(ctx, store, adminID, "backup.create", "backup", result.Filename, map[string]interface{}{
			"encrypted": result.Encrypted,
			"verified":  result.Verified,
			"size":      result.Size,
		})

		resp := map[string]interface{}{
			"status":    "created",
			"filepath":  result.Path,
			"filename":  result.Filename,
			"encrypted": result.Encrypted,
			"verified":  result.Verified,
			"size":      result.Size,
		}
		if result.VerificationErr != nil {
			log.Printf("Backup %s created but verification failed: %v", result.Filename, result.VerificationErr)
			resp["verification_warning"] = "Backup was created, but the automatic restore check failed. See server logs before relying on it."
		}
		writeJSON(w, http.StatusOK, resp)
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
// admin must confirm with their own MFA code (passed as a query/body field),
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
		if !verifyActorMFA(w, r, ctx, store, adminID, req.Code) {
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

		contentType := "application/gzip"
		if strings.HasSuffix(name, ".enc") {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
		_, _ = io.Copy(w, f)
	}
}

// RestoreBackup replaces the current database with a stored backup file and
// upgrades the restored schema to the running binary's migrations. The acting
// admin must confirm with their own MFA code.
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
		if !verifyActorMFA(w, r, ctx, store, adminID, req.Code) {
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

		passphrases, err := backupRestorePassphrases(ctx, store, backupPath)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		svc := backup.NewBackupService(backupDataDir())
		if err := restoreAndUpgrade(svc, store, backupPath, passphrases); err != nil {
			log.Printf("Failed to restore backup: %v", err)
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
// their own MFA code (multipart form field "code").
func RestoreBackupUpload(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		adminID := getAdminID(r)
		ctx := context.Background()

		if err := r.ParseMultipartForm(64 << 20); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid upload (max 64MB)")
			return
		}
		code := r.FormValue("code")
		if !verifyActorMFA(w, r, ctx, store, adminID, code) {
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "file is required")
			return
		}
		defer file.Close()

		// The uploaded file must look like a console backup. Accept both the
		// legacy plain gzip archive and the passphrase-encrypted variant.
		uploadName := backupDownloadName(header.Filename)
		if uploadName == "" || (!strings.HasSuffix(uploadName, ".sql.gz") && !strings.HasSuffix(uploadName, ".sql.gz.enc")) {
			writeError(w, http.StatusBadRequest, "Uploaded file must be a .sql.gz or .sql.gz.enc backup")
			return
		}
		// Prefix with a timestamp to avoid clobbering an existing file with
		// the same name.
		finalName := fmt.Sprintf("%s_%s", time.Now().Format("20060102_150405"), uploadName)
		dstPath := filepath.Join(backupDataDir(), finalName)

		dst, err := os.OpenFile(dstPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
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

		passphrases, err := backupRestorePassphrases(ctx, store, dstPath)
		if err != nil {
			os.Remove(dstPath)
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		svc := backup.NewBackupService(backupDataDir())
		if err := restoreAndUpgrade(svc, store, dstPath, passphrases); err != nil {
			log.Printf("Failed to restore uploaded backup: %v", err)
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
		if !verifyActorMFA(w, r, ctx, store, adminID, req.Code) {
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

		details := make(map[string]backup.Metadata, len(backups))
		for _, name := range backups {
			details[name] = svc.ReadMetadata(name)
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"backups":                   backups,
			"details":                   details,
			"backup_passphrase_enabled": backupPassphraseEnabled(store),
		})
	}
}
