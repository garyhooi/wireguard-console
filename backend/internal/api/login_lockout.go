package api

import (
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Per-IP login lockout: too many wrong passwords from one source lock that
// source out for a short, fixed window. This is separate from the per-admin
// failed-login lock (5 tries / 15 min) because it protects the endpoint from
// credential stuffing without punishing an admin whose account is attacked
// from elsewhere. Tracked in memory: a process restart clears it, which is
// fine for a 60s anti-guessing brake.
const (
	loginLockoutThreshold = 3                // wrong passwords before the IP is locked
	loginLockoutDuration  = 60 * time.Second // how long the IP stays locked
	loginLockoutIdleTTL   = 15 * time.Minute // forget idle IPs entirely
)

type loginLockoutEntry struct {
	failures    int
	lockedUntil time.Time
	lastSeen    time.Time
}

type loginLockoutTracker struct {
	mu        sync.Mutex
	entries   map[string]*loginLockoutEntry
	lastSweep time.Time
}

var ipLoginLockout = &loginLockoutTracker{entries: map[string]*loginLockoutEntry{}}

func (t *loginLockoutTracker) sweepLocked(now time.Time) {
	if now.Sub(t.lastSweep) < loginLockoutIdleTTL {
		return
	}
	for ip, e := range t.entries {
		if now.Sub(e.lastSeen) > loginLockoutIdleTTL && !now.Before(e.lockedUntil) {
			delete(t.entries, ip)
		}
	}
	t.lastSweep = now
}

// remaining reports how long the IP is still locked out for (0 = not locked).
func (t *loginLockoutTracker) remaining(ip string, now time.Time) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()

	e := t.entries[ip]
	if e == nil {
		return 0
	}
	if now.Before(e.lockedUntil) {
		return e.lockedUntil.Sub(now)
	}
	// Lock expired (or was never set): clear the counter so the next burst
	// starts fresh.
	if !e.lockedUntil.IsZero() {
		e.lockedUntil = time.Time{}
		e.failures = 0
	}
	if now.Sub(e.lastSeen) > loginLockoutIdleTTL {
		delete(t.entries, ip)
	}
	return 0
}

// recordFailure counts one wrong password for the IP. When the threshold is
// reached it starts the lockout and returns its duration; otherwise 0.
func (t *loginLockoutTracker) recordFailure(ip string, now time.Time) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.sweepLocked(now)

	e := t.entries[ip]
	if e == nil {
		e = &loginLockoutEntry{}
		t.entries[ip] = e
	}
	if now.Sub(e.lastSeen) > loginLockoutIdleTTL && !now.Before(e.lockedUntil) {
		e.failures = 0
	}
	e.failures++
	e.lastSeen = now

	if e.failures >= loginLockoutThreshold {
		e.lockedUntil = now.Add(loginLockoutDuration)
		e.failures = 0
		return loginLockoutDuration
	}
	return 0
}

// reset clears an IP's failure state after a successful login.
func (t *loginLockoutTracker) reset(ip string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, ip)
}

func lockoutSeconds(d time.Duration) int {
	return int(math.Ceil(d.Seconds()))
}

// respondLocked writes the 429 used both for an active lockout and for the
// failure that triggers it. retry_after_seconds drives the UI countdown.
func respondLocked(w http.ResponseWriter, seconds int) {
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	writeJSON(w, http.StatusTooManyRequests, map[string]interface{}{
		"error":               "Too many failed login attempts. Try again later.",
		"retry_after_seconds": seconds,
	})
}

// LoginLockoutStatus lets the login page resume a countdown after a refresh
// (the lock lives server-side per IP, so the browser has no other way to know).
func LoginLockoutStatus() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		remaining := ipLoginLockout.remaining(getClientIP(r), time.Now())
		seconds := lockoutSeconds(remaining)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"locked":              seconds > 0,
			"retry_after_seconds": seconds,
		})
	}
}
