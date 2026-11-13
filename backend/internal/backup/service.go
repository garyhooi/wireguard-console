package backup

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type BackupService struct {
	dataDir string
}

type BackupResult struct {
	Filename        string
	Path            string
	Encrypted       bool
	Verified        bool
	Size            int64
	VerificationErr error
}

// Metadata is the non-secret sidecar kept next to a backup. It lets the UI
// show whether an archive is encrypted, whether its restore was verified, and
// its size without opening the archive on every list request.
type Metadata struct {
	Encrypted     bool   `json:"encrypted"`
	Verified      bool   `json:"verified"`
	VerifiedKnown bool   `json:"verified_known"`
	VerifiedAt    string `json:"verified_at,omitempty"`
	Size          int64  `json:"size"`
}

type dbConfig struct {
	user     string
	password string
	name     string
	host     string
}

func (c dbConfig) env() []string {
	env := os.Environ()
	out := make([]string, 0, len(env)+1)
	for _, item := range env {
		if !strings.HasPrefix(item, "PGPASSWORD=") {
			out = append(out, item)
		}
	}
	return append(out, "PGPASSWORD="+c.password)
}

func (c dbConfig) psql(database string, args ...string) *exec.Cmd {
	base := []string{"-h", c.host, "-U", c.user, "-d", database, "-v", "ON_ERROR_STOP=1"}
	return exec.Command("psql", append(base, args...)...)
}

func loadDBConfig() (dbConfig, error) {
	c := dbConfig{
		user:     os.Getenv("POSTGRES_USER"),
		password: os.Getenv("POSTGRES_PASSWORD"),
		name:     os.Getenv("POSTGRES_DB"),
		host:     os.Getenv("PGHOST"),
	}
	if c.host == "" {
		c.host = "localhost"
	}
	if c.user == "" || c.password == "" || c.name == "" {
		return c, fmt.Errorf("database credentials not configured")
	}
	return c, nil
}

func NewBackupService(dataDir string) *BackupService {
	return &BackupService{dataDir: dataDir}
}

func (s *BackupService) nextBackupName(encrypted bool) string {
	base := fmt.Sprintf("wgconsole_backup_%s", time.Now().UTC().Format("20060102_150405"))
	suffix := ".sql.gz"
	if encrypted {
		suffix += ".enc"
	}
	name := base + suffix
	for i := 1; ; i++ {
		if _, err := os.Stat(filepath.Join(s.dataDir, name)); os.IsNotExist(err) {
			return name
		}
		name = fmt.Sprintf("%s_%d%s", base, i, suffix)
	}
}

// CreateBackup streams pg_dump through gzip (and passphrase encryption when
// configured), then immediately restores it into a throwaway database to prove
// the archive is usable. A verification failure is reported in the result but
// does not discard the backup; the caller should surface a warning.
func (s *BackupService) CreateBackup(passphrase string) (BackupResult, error) {
	cfg, err := loadDBConfig()
	if err != nil {
		return BackupResult{}, err
	}

	encrypted := passphrase != ""
	filename := s.nextBackupName(encrypted)
	backupPath := filepath.Join(s.dataDir, filename)
	f, err := os.OpenFile(backupPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return BackupResult{}, fmt.Errorf("failed to create backup file: %w", err)
	}

	var stderr bytes.Buffer
	cmd := exec.Command("pg_dump",
		"-h", cfg.host,
		"-U", cfg.user,
		"-d", cfg.name,
		"--format=plain",
		"--no-owner",
		"--no-privileges",
	)
	cmd.Env = cfg.env()
	cmd.Stderr = &stderr

	var (
		enc *encryptWriter
		gz  *gzip.Writer
	)
	sink := io.Writer(f)
	if encrypted {
		enc, err = newEncryptWriter(f, passphrase)
		if err != nil {
			f.Close()
			os.Remove(backupPath)
			return BackupResult{}, err
		}
		sink = enc
	}
	gz = gzip.NewWriter(sink)
	cmd.Stdout = gz

	runErr := cmd.Run()
	closeErr := gz.Close()
	if enc != nil {
		if e := enc.Close(); e != nil && closeErr == nil {
			closeErr = e
		}
	}
	if e := f.Close(); e != nil && closeErr == nil {
		closeErr = e
	}
	if runErr != nil {
		os.Remove(backupPath)
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			return BackupResult{}, fmt.Errorf("failed to run pg_dump: %w", runErr)
		}
		return BackupResult{}, fmt.Errorf("failed to run pg_dump: %w: %s", runErr, msg)
	}
	if closeErr != nil {
		os.Remove(backupPath)
		return BackupResult{}, fmt.Errorf("failed to finalise backup: %w", closeErr)
	}

	info, err := os.Stat(backupPath)
	if err != nil {
		os.Remove(backupPath)
		return BackupResult{}, fmt.Errorf("failed to stat backup: %w", err)
	}
	result := BackupResult{
		Filename:  filename,
		Path:      backupPath,
		Encrypted: encrypted,
		Size:      info.Size(),
	}

	passphrases := []string(nil)
	if encrypted {
		passphrases = []string{passphrase}
	}
	if err := s.VerifyBackup(backupPath, passphrases); err != nil {
		result.VerificationErr = err
		log.Printf("Backup verification failed (%s): %v", filename, err)
	} else {
		result.Verified = true
	}

	meta := Metadata{
		Encrypted:     encrypted,
		Verified:      result.Verified,
		VerifiedKnown: true,
		Size:          result.Size,
	}
	if result.Verified {
		meta.VerifiedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if err := s.writeMetadata(filename, meta); err != nil {
		log.Printf("Failed to write backup metadata (%s): %v", filename, err)
	}
	return result, nil
}

// VerifyBackup restores the archive into a temporary database on the same
// PostgreSQL server and drops it afterwards. This proves the SQL is valid and
// the archive decrypts completely, not merely that a gzip stream has a valid
// checksum.
func (s *BackupService) VerifyBackup(backupPath string, passphrases []string) error {
	cfg, err := loadDBConfig()
	if err != nil {
		return err
	}
	reader, err := OpenBackupSQL(backupPath, passphrases)
	if err != nil {
		return err
	}
	defer reader.Close()

	dbName, err := verifyDBName()
	if err != nil {
		return err
	}
	create := cfg.psql("postgres", "-c", "CREATE DATABASE "+dbName)
	create.Env = cfg.env()
	if out, err := create.CombinedOutput(); err != nil {
		return fmt.Errorf("could not create verification database: %w: %s", err, strings.TrimSpace(string(out)))
	}
	defer func() {
		drop := cfg.psql("postgres", "-c", "DROP DATABASE IF EXISTS "+dbName)
		drop.Env = cfg.env()
		if out, err := drop.CombinedOutput(); err != nil {
			log.Printf("Failed to drop backup verification database %s: %v: %s", dbName, err, strings.TrimSpace(string(out)))
		}
	}()

	restore := cfg.psql(dbName)
	restore.Env = cfg.env()
	restore.Stdin = reader
	if out, err := restore.CombinedOutput(); err != nil {
		return fmt.Errorf("restore verification failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s *BackupService) RestoreBackup(backupPath string, passphrases []string) error {
	cfg, err := loadDBConfig()
	if err != nil {
		return err
	}

	// Open and authenticate the archive before touching the live schema. A
	// wrong passphrase or corrupt file must never wipe the current database.
	sqlReader, err := OpenBackupSQL(backupPath, passphrases)
	if err != nil {
		return err
	}
	defer sqlReader.Close()

	dropCmd := cfg.psql(cfg.name, "-c", `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;`)
	dropCmd.Env = cfg.env()
	if out, err := dropCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to reset schema before restore: %w: %s", err, strings.TrimSpace(string(out)))
	}

	psqlCmd := cfg.psql(cfg.name)
	psqlCmd.Env = cfg.env()
	psqlCmd.Stdin = sqlReader
	if out, err := psqlCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to restore backup: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s *BackupService) DeleteBackup(filename string) error {
	backupPath := filepath.Join(s.dataDir, filepath.Base(filename))
	if filepath.Dir(backupPath) != filepath.Clean(s.dataDir) {
		return fmt.Errorf("invalid backup path")
	}
	if _, err := os.Stat(backupPath); err != nil {
		return fmt.Errorf("backup not found: %w", err)
	}
	if err := os.Remove(backupPath); err != nil {
		return fmt.Errorf("failed to delete backup: %w", err)
	}
	_ = os.Remove(backupPath + ".meta.json")
	return nil
}

func (s *BackupService) ListBackups() ([]string, error) {
	entries, err := os.ReadDir(s.dataDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read backup directory: %w", err)
	}
	backups := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".sql.gz") || strings.HasSuffix(name, ".sql.gz.enc") {
			backups = append(backups, name)
		}
	}
	return backups, nil
}

func metadataPath(dataDir, filename string) string {
	return filepath.Join(dataDir, filepath.Base(filename)+".meta.json")
}

func (s *BackupService) writeMetadata(filename string, meta Metadata) error {
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return os.WriteFile(metadataPath(s.dataDir, filename), data, 0o600)
}

// ReadMetadata returns sidecar data when present. Older backups have no
// sidecar; their encrypted state is inferred from the extension and their
// verification state is reported as unknown.
func (s *BackupService) ReadMetadata(filename string) Metadata {
	meta := Metadata{
		Encrypted:     strings.HasSuffix(filename, ".enc"),
		VerifiedKnown: false,
	}
	path := filepath.Join(s.dataDir, filepath.Base(filename))
	if info, err := os.Stat(path); err == nil {
		meta.Size = info.Size()
	}
	data, err := os.ReadFile(metadataPath(s.dataDir, filename))
	if err != nil {
		return meta
	}
	var stored Metadata
	if err := json.Unmarshal(data, &stored); err != nil {
		return meta
	}
	if stored.Size == 0 {
		stored.Size = meta.Size
	}
	stored.VerifiedKnown = true
	return stored
}

func verifyDBName() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate verification database name: %w", err)
	}
	return "wgc_verify_" + hex.EncodeToString(b), nil
}
