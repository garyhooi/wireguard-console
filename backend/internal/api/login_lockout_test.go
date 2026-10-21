package api

import (
	"testing"
	"time"
)

const (
	testLockoutThreshold = 3
	testLockoutDuration  = 60 * time.Second
)

func TestLoginLockoutTracker(t *testing.T) {
	tracker := &loginLockoutTracker{entries: map[string]*loginLockoutEntry{}}
	ip := "203.0.113.42"
	now := time.Now()

	if d := tracker.remaining(ip, now); d != 0 {
		t.Fatalf("fresh IP should not be locked, got %v", d)
	}
	if d := tracker.recordFailure(ip, now, testLockoutThreshold, testLockoutDuration); d != 0 {
		t.Fatalf("first failure must not lock, got %v", d)
	}
	if d := tracker.recordFailure(ip, now.Add(time.Second), testLockoutThreshold, testLockoutDuration); d != 0 {
		t.Fatalf("second failure must not lock, got %v", d)
	}
	if d := tracker.recordFailure(ip, now.Add(2*time.Second), testLockoutThreshold, testLockoutDuration); d != testLockoutDuration {
		t.Fatalf("third failure should lock for %v, got %v", testLockoutDuration, d)
	}

	// The third failure happened at now+2s, so the lock ends at now+62s.
	remaining := tracker.remaining(ip, now.Add(10*time.Second))
	if remaining < 51*time.Second || remaining > 53*time.Second {
		t.Fatalf("remaining after 10s = %v, want ~52s", remaining)
	}
	if seconds := lockoutSeconds(remaining); seconds < 51 || seconds > 53 {
		t.Fatalf("lockoutSeconds = %d, want 51-53", seconds)
	}

	if d := tracker.remaining(ip, now.Add(testLockoutDuration+3*time.Second)); d != 0 {
		t.Fatalf("lock should expire, got %v", d)
	}
	t2 := now.Add(testLockoutDuration + time.Minute)
	tracker.recordFailure(ip, t2, testLockoutThreshold, testLockoutDuration)
	if d := tracker.recordFailure(ip, t2.Add(time.Second), testLockoutThreshold, testLockoutDuration); d != 0 {
		t.Fatalf("post-expiry burst must not lock early, got %v", d)
	}

	tracker.reset(ip)
	tracker.recordFailure(ip, t2, testLockoutThreshold, testLockoutDuration)
	tracker.recordFailure(ip, t2.Add(time.Second), testLockoutThreshold, testLockoutDuration)
	tracker.reset(ip)
	tracker.recordFailure(ip, t2.Add(2*time.Second), testLockoutThreshold, testLockoutDuration)
	if d := tracker.remaining(ip, t2.Add(3*time.Second)); d != 0 {
		t.Fatalf("reset should clear failures, got lock %v", d)
	}
}

// The admin-configurable policy must be honoured: a higher attempt count and a
// shorter window behave differently from the defaults.
func TestLoginLockoutTrackerUsesConfiguredPolicy(t *testing.T) {
	tracker := &loginLockoutTracker{entries: map[string]*loginLockoutEntry{}}
	ip := "198.51.100.9"
	now := time.Now()
	const (
		threshold = 5
		duration  = 15 * time.Second
	)

	for i := 0; i < threshold-1; i++ {
		if d := tracker.recordFailure(ip, now.Add(time.Duration(i)*time.Second), threshold, duration); d != 0 {
			t.Fatalf("failure %d must not lock, got %v", i+1, d)
		}
	}
	if d := tracker.recordFailure(ip, now.Add(4*time.Second), threshold, duration); d != duration {
		t.Fatalf("configured threshold should lock for %v, got %v", duration, d)
	}
	if remaining := tracker.remaining(ip, now.Add(6*time.Second)); remaining > 14*time.Second {
		t.Fatalf("configured duration not applied, remaining %v", remaining)
	}
	// A second IP with the default policy is unaffected by the first one.
	defaultRemaining := tracker.remaining("192.0.2.1", now)
	if defaultRemaining != 0 {
		t.Fatalf("other IP should not be locked, got %v", defaultRemaining)
	}
}
