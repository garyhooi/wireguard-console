package backup

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func writeArchive(t *testing.T, dir string, payload []byte, passphrase string) string {
	t.Helper()
	path := filepath.Join(dir, "backup.sql.gz")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	var sink io.Writer = f
	var enc *encryptWriter
	if passphrase != "" {
		enc, err = newEncryptWriter(f, passphrase)
		if err != nil {
			t.Fatal(err)
		}
		sink = enc
	}
	gz := gzip.NewWriter(sink)
	if _, err := gz.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if enc != nil {
		if err := enc.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func readAll(t *testing.T, path string, passphrases []string) ([]byte, error) {
	t.Helper()
	reader, err := OpenBackupSQL(path, passphrases)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

func TestEncryptedBackupRoundTrip(t *testing.T) {
	dir := t.TempDir()
	payload := bytes.Repeat([]byte("pg_dump data line\n"), 90_000) // > one 1 MiB chunk
	path := writeArchive(t, dir, payload, "correct horse battery staple")
	encrypted, err := IsEncryptedFile(path)
	if err != nil || !encrypted {
		t.Fatalf("IsEncryptedFile = %v, %v; want true", encrypted, err)
	}
	got, err := readAll(t, path, []string{"correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("decrypted payload differs: got %d bytes, want %d", len(got), len(payload))
	}
}

func TestEncryptedBackupWrongPassphrase(t *testing.T) {
	dir := t.TempDir()
	path := writeArchive(t, dir, []byte("secret sql"), "correct horse battery staple")
	if _, err := readAll(t, path, []string{"wrong passphrase"}); !errors.Is(err, ErrIncorrectPassphrase) {
		t.Fatalf("wrong passphrase error = %v, want ErrIncorrectPassphrase", err)
	}
	if _, err := readAll(t, path, nil); !errors.Is(err, ErrIncorrectPassphrase) {
		t.Fatalf("missing passphrase error = %v, want ErrIncorrectPassphrase", err)
	}
}

func TestEncryptedBackupDetectsTampering(t *testing.T) {
	dir := t.TempDir()
	path := writeArchive(t, dir, []byte("secret sql"), "correct horse battery staple")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)-1] ^= 0xff
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readAll(t, path, []string{"correct horse battery staple"}); err == nil {
		t.Fatal("tampered archive decrypted successfully")
	}
}

func TestPlainBackupRoundTrip(t *testing.T) {
	dir := t.TempDir()
	payload := []byte("plain sql")
	path := writeArchive(t, dir, payload, "")
	encrypted, err := IsEncryptedFile(path)
	if err != nil || encrypted {
		t.Fatalf("IsEncryptedFile = %v, %v; want false", encrypted, err)
	}
	got, err := readAll(t, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("plain payload differs: got %q, want %q", got, payload)
	}
}
