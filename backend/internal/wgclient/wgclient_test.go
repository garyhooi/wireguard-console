package wgclient

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

const statsResponse = `{"peers":[{"public_key":"abc","receive_bytes":1,"transmit_bytes":2,"last_handshake_at":"2026-01-01T00:00:00Z"}]}`

// openFDs counts this process's open file descriptors, or -1 where the fd
// table is not readable (then the fd assertion is skipped).
func openFDs() int {
	for _, dir := range []string{"/proc/self/fd", "/dev/fd"} {
		if entries, err := os.ReadDir(dir); err == nil {
			return len(entries)
		}
	}
	return -1
}

// waitForGoroutines waits (briefly) for the goroutine count to settle at or
// below want, returning the last observed count.
func waitForGoroutines(want int) int {
	deadline := time.Now().Add(3 * time.Second)
	n := runtime.NumGoroutine()
	for n > want && time.Now().Before(deadline) {
		time.Sleep(25 * time.Millisecond)
		runtime.GC()
		n = runtime.NumGoroutine()
	}
	return n
}

// TestHelperCallsDoNotLeakConnections is the regression test for the v1.0.15
// memory leak: request() used to create a fresh http.Client/Transport per
// call with IdleConnTimeout unset, so every wg-helper call permanently leaked
// the idle unix-socket connection, two goroutines and the transport buffers
// (the wg-helper server side leaked its conn.serve goroutine + fd too).
//
// With keep-alive disabled and one shared client, a burst of calls must leave
// the goroutine and fd counts flat.
func TestHelperCallsDoNotLeakConnections(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "wg-helper.sock")

	listener, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(statsResponse + "\n"))
	})}
	go func() { _ = srv.Serve(listener) }()
	t.Cleanup(func() { _ = srv.Close() })

	// In the api container WG_HELPER_SOCKET is the socket FILE path (the
	// wg-helper container uses the same variable for the directory).
	t.Setenv("WG_HELPER_SOCKET", sock)

	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	beforeGoroutines := runtime.NumGoroutine()
	beforeFDs := openFDs()

	const calls = 50
	for i := 0; i < calls; i++ {
		if _, err := Stats("wg0"); err != nil {
			t.Fatalf("Stats call %d: %v", i, err)
		}
	}

	runtime.GC()
	afterGoroutines := waitForGoroutines(beforeGoroutines + 2)
	if afterGoroutines > beforeGoroutines+2 {
		t.Fatalf("goroutines grew from %d to %d after %d helper calls (leaked connections)",
			beforeGoroutines, afterGoroutines, calls)
	}
	if beforeFDs >= 0 {
		if afterFDs := openFDs(); afterFDs > beforeFDs+2 {
			t.Fatalf("open fds grew from %d to %d after %d helper calls (leaked connections)",
				beforeFDs, afterFDs, calls)
		}
	}
}
