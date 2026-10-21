package api

import (
	"testing"
	"time"
)

func TestLoginLockoutTracker(t *testing.T) {
	tracker := &loginLockoutTracker{entries: map[string]*loginLockoutEntry{}}
	ip := "203.0.113.42"
	now := time.Now()

	if d := tracker.remaining(ip, now); d != 0 {
		t.Fatalf("fresh IP should not be locked, got %v", d)
	}
	if d := tracker.recordFailure(ip, now); d != 0 {
		t.Fatalf("first failure must not lock, got %v", d)
	}
	if d := tracker.recordFailure(ip, now.Add(time.Second)); d != 0 {
		t.Fatalf("second failure must not lock, got %v", d)
	}
	if d := tracker.recordFailure(ip, now.Add(2*time.Second)); d != loginLockoutDuration {
		t.Fatalf("third failure should lock for %v, got %v", loginLockoutDuration, d)
	}

	// The third failure happened at now+2s, so the lock ends at now+62s.
	remaining := tracker.remaining(ip, now.Add(10*time.Second))
	if remaining < 51*time.Second || remaining > 53*time.Second {
		t.Fatalf("remaining after 10s = %v, want ~52s", remaining)
	}
	if seconds := lockoutSeconds(remaining); seconds < 51 || seconds > 53 {
		t.Fatalf("lockoutSeconds = %d, want 51-53", seconds)
	}

	if d := tracker.remaining(ip, now.Add(loginLockoutDuration+3*time.Second)); d != 0 {
		t.Fatalf("lock should expire, got %v", d)
	}
	t2 := now.Add(loginLockoutDuration + time.Minute)
	tracker.recordFailure(ip, t2)
	if d := tracker.recordFailure(ip, t2.Add(time.Second)); d != 0 {
		t.Fatalf("post-expiry burst must not lock early, got %v", d)
	}

	tracker.reset(ip)
	tracker.recordFailure(ip, t2)
	tracker.recordFailure(ip, t2.Add(time.Second))
	tracker.reset(ip)
	tracker.recordFailure(ip, t2.Add(2*time.Second))
	if d := tracker.remaining(ip, t2.Add(3*time.Second)); d != 0 {
		t.Fatalf("reset should clear failures, got lock %v", d)
	}
}
