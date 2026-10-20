package api

import "testing"

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

func TestDiffRuleSets(t *testing.T) {
	missing, unexpected := diffRuleSets(
		[]string{"||a.com^", "||b.com^", "||a.com^"},
		[]string{"||b.com^", "||c.com^"},
	)
	if missing != 1 || unexpected != 1 {
		t.Fatalf("diffRuleSets = missing %d, unexpected %d; want 1, 1", missing, unexpected)
	}
}
