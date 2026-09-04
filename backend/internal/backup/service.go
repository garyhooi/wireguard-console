package backup

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type BackupService struct {
	dataDir string
}

func NewBackupService(dataDir string) *BackupService {
	return &BackupService{
		dataDir: dataDir,
	}
}

func (s *BackupService) CreateBackup() (string, error) {
	timestamp := time.Now().Format("20060102_150405")
	filename := fmt.Sprintf("wgconsole_backup_%s.sql.gz", timestamp)
	backupPath := filepath.Join(s.dataDir, filename)

	// Get database connection details from environment
	dbUser := os.Getenv("POSTGRES_USER")
	dbPassword := os.Getenv("POSTGRES_PASSWORD")
	dbName := os.Getenv("POSTGRES_DB")
	dbHost := os.Getenv("PGHOST")
	if dbHost == "" {
		dbHost = "localhost"
	}

	if dbUser == "" || dbPassword == "" || dbName == "" {
		return "", fmt.Errorf("database credentials not configured")
	}

	// Run pg_dump
	cmd := exec.Command("pg_dump",
		"-h", dbHost,
		"-U", dbUser,
		"-d", dbName,
		"--format=plain",
		"--no-owner",
		"--no-privileges",
	)

	cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", dbPassword))

	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to run pg_dump: %w", err)
	}

	// Compress with gzip
	gzipCmd := exec.Command("gzip", "-c")
	gzipCmd.Stdin = strings.NewReader(string(output))

	outFile, err := os.Create(backupPath)
	if err != nil {
		return "", fmt.Errorf("failed to create backup file: %w", err)
	}
	defer outFile.Close()

	gzipCmd.Stdout = outFile
	if err := gzipCmd.Run(); err != nil {
		return "", fmt.Errorf("failed to compress backup: %w", err)
	}

	return backupPath, nil
}

func (s *BackupService) RestoreBackup(backupPath string) error {
	dbUser := os.Getenv("POSTGRES_USER")
	dbPassword := os.Getenv("POSTGRES_PASSWORD")
	dbName := os.Getenv("POSTGRES_DB")
	dbHost := os.Getenv("PGHOST")
	if dbHost == "" {
		dbHost = "localhost"
	}

	if dbUser == "" || dbPassword == "" || dbName == "" {
		return fmt.Errorf("database credentials not configured")
	}

	// Decompress the backup and pipe it straight into psql.
	gunzipCmd := exec.Command("gunzip", "-c", backupPath)
	psqlCmd := exec.Command("psql",
		"-h", dbHost,
		"-U", dbUser,
		"-d", dbName,
		"-v", "ON_ERROR_STOP=1",
	)
	psqlCmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", dbPassword))

	pipe, err := gunzipCmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to create pipe: %w", err)
	}
	psqlCmd.Stdin = pipe

	if err := gunzipCmd.Start(); err != nil {
		return fmt.Errorf("failed to start gunzip: %w", err)
	}
	if err := psqlCmd.Run(); err != nil {
		return fmt.Errorf("failed to restore backup: %w", err)
	}
	if err := gunzipCmd.Wait(); err != nil {
		return fmt.Errorf("failed to decompress backup: %w", err)
	}

	return nil
}

// DeleteBackup removes a single backup file by name. The name is treated as a
// base path so callers can never traverse outside the backup directory.
func (s *BackupService) DeleteBackup(filename string) error {
	backupPath := filepath.Join(s.dataDir, filepath.Base(filename))

	// Only ever delete files that live in the backup directory.
	if filepath.Dir(backupPath) != filepath.Clean(s.dataDir) {
		return fmt.Errorf("invalid backup path")
	}

	if _, err := os.Stat(backupPath); err != nil {
		return fmt.Errorf("backup not found: %w", err)
	}

	if err := os.Remove(backupPath); err != nil {
		return fmt.Errorf("failed to delete backup: %w", err)
	}

	return nil
}

func (s *BackupService) ListBackups() ([]string, error) {
	entries, err := os.ReadDir(s.dataDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read backup directory: %w", err)
	}

	var backups []string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".sql.gz") {
			backups = append(backups, entry.Name())
		}
	}

	return backups, nil
}
