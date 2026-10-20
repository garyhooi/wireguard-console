package api

import (
	"strings"
	"testing"
)

func TestNormalizeDomain(t *testing.T) {
	valid := []struct{ in, want string }{
		{"youtube.com", "youtube.com"},
		{"YouTube.com", "youtube.com"},
		{" www.youtube.com ", "youtube.com"},
		{"https://www.youtube.com/watch?v=abc", "youtube.com"},
		{"http://youtube.com/path", "youtube.com"},
		{"youtube.com/path", "youtube.com"},
		{"youtube.com:443", "youtube.com"},
		{"youtube.com.", "youtube.com"},
		{"münchen.de", "xn--mnchen-3ya.de"},
		{"a.b.c.example.co.uk", "a.b.c.example.co.uk"},
	}
	for _, c := range valid {
		got, err := normalizeDomain(c.in)
		if err != nil {
			t.Errorf("normalizeDomain(%q): unexpected error: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("normalizeDomain(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	invalid := []string{
		"", " ", "*", "*.youtube.com", "https://", "1.2.3.4",
		"a..b", "youtube.com,google.com", "bad_domain.com", "-bad.com", "bad-.com",
	}
	for _, in := range invalid {
		if _, err := normalizeDomain(in); err == nil {
			t.Errorf("normalizeDomain(%q): expected an error", in)
		}
	}
}

func TestNormalizeGroupName(t *testing.T) {
	if got, err := normalizeGroupName("  YouTube  "); err != nil || got != "YouTube" {
		t.Fatalf("normalizeGroupName trim = %q, %v; want YouTube, nil", got, err)
	}
	if _, err := normalizeGroupName("   "); err == nil {
		t.Error("blank group name should be rejected")
	}
	if _, err := normalizeGroupName(strings.Repeat("a", 65)); err == nil {
		t.Error("over-long group name should be rejected")
	}
	if _, err := normalizeGroupName("bad\nname"); err == nil {
		t.Error("control characters in group name should be rejected")
	}
}

func TestNormalizeDomainList(t *testing.T) {
	got, err := normalizeDomainList([]string{
		"youtube.com, googlevideo.com\nwww.ytimg.com",
		"https://youtube.com/watch?v=x",
		"YOUTUBE.COM",
	})
	if err != nil {
		t.Fatalf("normalizeDomainList: %v", err)
	}
	want := []string{"youtube.com", "googlevideo.com", "ytimg.com"}
	if len(got) != len(want) {
		t.Fatalf("normalizeDomainList = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("normalizeDomainList = %v, want %v", got, want)
		}
	}
	if _, err := normalizeDomainList(nil); err == nil {
		t.Error("empty domain list should be rejected")
	}
	if _, err := normalizeDomainList([]string{"ok.com", "*.bad.com"}); err == nil {
		t.Error("invalid domain in list should be rejected")
	}
}

func TestDiffRuleSets(t *testing.T) {
	missing, unexpected := diffRuleSets(
		[]string{"||a.com^", "||b.com^", "||a.com^"},
		[]string{"||b.com^", "||c.com^"},
	)
	if missing != 1 || unexpected != 1 {
		t.Fatalf("diffRuleSets = missing %d, unexpected %d; want 1, 1", missing, unexpected)
	}
}
