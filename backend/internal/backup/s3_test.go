package backup

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestS3ConfigKeyAndValidation(t *testing.T) {
	cfg := S3Config{
		Region:   "us-east-1",
		Bucket:   "backups",
		Prefix:   "/wireguard-console/backups/",
		Endpoint: "https://s3.example.com",
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	if got, want := cfg.Key("wgconsole_backup_20260101_000000.sql.gz.enc"), "wireguard-console/backups/wgconsole_backup_20260101_000000.sql.gz.enc"; got != want {
		t.Fatalf("Key() = %q, want %q", got, want)
	}

	cases := []S3Config{
		{Region: "us-east-1", Bucket: ""},
		{Region: "us-east-1", Bucket: "bad/bucket"},
		{Region: "us-east-1", Bucket: "backups", Endpoint: "s3.example.com"},
		{Region: "us-east-1", Bucket: "backups", Endpoint: "https://user:pass@s3.example.com"},
		{Region: "us-east-1", Bucket: "backups", AccessKeyID: "only-key"},
		{Region: "us-east-1", Bucket: "backups", Prefix: "../escape"},
	}
	for _, c := range cases {
		if err := c.Validate(); err == nil {
			t.Fatalf("invalid config accepted: %+v", c)
		}
	}
}

func TestMarkS3UploadedMetadata(t *testing.T) {
	dir := t.TempDir()
	svc := NewBackupService(dir)
	name := "wgconsole_backup_20260101_000000.sql.gz"
	if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := svc.writeMetadata(name, Metadata{Encrypted: false, Verified: true, VerifiedKnown: true, Size: 1}); err != nil {
		t.Fatal(err)
	}
	if err := svc.MarkS3Uploaded(name, "prefix/"+name); err != nil {
		t.Fatal(err)
	}
	meta := svc.ReadMetadata(name)
	if !meta.S3Uploaded || meta.S3Key != "prefix/"+name {
		t.Fatalf("metadata = %+v", meta)
	}
}

func TestS3TestAndUploadWithFakeEndpoint(t *testing.T) {
	var (
		mu      sync.Mutex
		objects = map[string][]byte{}
	)
	const bucket = "backups"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/"+bucket)
		key = strings.TrimPrefix(key, "/")
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodHead:
			if strings.TrimPrefix(r.URL.Path, "/") == bucket {
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			objects[key] = body
			w.Header().Set("ETag", fmt.Sprintf("%q", fmt.Sprintf("%d", len(body))))
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			body, ok := objects[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(body)
		case http.MethodDelete:
			delete(objects, key)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()

	cfg := S3Config{
		Endpoint:        server.URL,
		Region:          "us-east-1",
		Bucket:          bucket,
		Prefix:          "wireguard-console/backups",
		AccessKeyID:     "test-access",
		SecretAccessKey: "test-secret",
		ForcePathStyle:  true,
	}
	if err := cfg.Test(context.Background()); err != nil {
		t.Fatalf("S3 permission test: %v", err)
	}
	path := filepath.Join(t.TempDir(), "backup.sql.gz")
	payload := []byte("backup bytes")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	key := cfg.Key("backup.sql.gz")
	if err := cfg.Upload(context.Background(), path, key); err != nil {
		t.Fatalf("S3 upload: %v", err)
	}
	mu.Lock()
	got, ok := objects[key]
	mu.Unlock()
	if !ok || string(got) != string(payload) {
		t.Fatalf("uploaded object = %q, present=%v", got, ok)
	}
	if err := cfg.Delete(context.Background(), key); err != nil {
		t.Fatalf("S3 delete: %v", err)
	}
	mu.Lock()
	_, ok = objects[key]
	mu.Unlock()
	if ok {
		t.Fatal("S3 object still present after delete")
	}
}
