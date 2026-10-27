package api

import (
	"strings"
	"testing"
)

// The idempotency key is optional and untrusted: it must be trimmed before it
// is stored/looked up (so " abc " and "abc" replay the same peer) and bounded
// (an unbounded key would bloat the unique index and every replay lookup).
func TestNormalizePeerCreateRequestID(t *testing.T) {
	if id, ok := normalizePeerCreateRequestID(""); !ok || id != "" {
		t.Fatalf("empty request_id = (%q, %v), want (\"\", true)", id, ok)
	}
	if id, ok := normalizePeerCreateRequestID("  abc-123  "); !ok || id != "abc-123" {
		t.Fatalf("untrimmed request_id = (%q, %v), want (\"abc-123\", true)", id, ok)
	}
	if id, ok := normalizePeerCreateRequestID(strings.Repeat("x", 128)); !ok || len(id) != 128 {
		t.Fatalf("128-char request_id rejected (len=%d, ok=%v)", len(id), ok)
	}
	if _, ok := normalizePeerCreateRequestID(strings.Repeat("x", 129)); ok {
		t.Fatal("129-char request_id must be rejected")
	}
}
