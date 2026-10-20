package api

import (
	"net/http"
	"os"
	"runtime"
	"time"
)

// processStartedAt is used to expose uptime in the debug counters.
var processStartedAt = time.Now()

// RuntimeStats exposes live Go runtime counters used to triage memory /
// goroutine / file-descriptor growth on a long-running console. It is a
// super_admin-only route (see cmd/api/main.go): goroutine and fd counts are
// the quickest way to spot a leak in production without a profiler.
//
//	GET /api/debug/runtime
//
// For deep dumps, the api container also serves net/http/pprof on the
// loopback-only PPROF_ADDR (127.0.0.1:6060 by default), reachable via
// docker exec (never published on the host).
func RuntimeStats(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)

		resp := map[string]interface{}{
			"goroutines":        runtime.NumGoroutine(),
			"heap_alloc_bytes":  m.HeapAlloc,
			"heap_inuse_bytes":  m.HeapInuse,
			"heap_objects":      m.HeapObjects,
			"stack_inuse_bytes": m.StackInuse,
			"sys_bytes":         m.Sys,
			"num_gc":            m.NumGC,
			"uptime_seconds":    int64(time.Since(processStartedAt).Seconds()),
		}
		if fds, err := countOpenFDs(); err == nil {
			resp["open_fds"] = fds
		}
		resp["gomaxprocs"] = runtime.GOMAXPROCS(0)
		writeJSON(w, http.StatusOK, resp)
	}
}

// countOpenFDs returns the number of entries in this process's fd table
// (/proc/self/fd on Linux, /dev/fd on BSD/macOS). The directory fd itself is
// included, which is fine for trend monitoring.
func countOpenFDs() (int, error) {
	for _, dir := range []string{"/proc/self/fd", "/dev/fd"} {
		entries, err := os.ReadDir(dir)
		if err == nil {
			return len(entries), nil
		}
	}
	return 0, os.ErrNotExist
}
