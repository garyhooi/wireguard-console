package worker

import "testing"

func TestCleanHost(t *testing.T) {
	cases := []struct{ in, want string }{
		{"www.Example.com.", "www.example.com"},
		{"EXAMPLE.COM", "example.com"},
		{"  api.github.com ", "api.github.com"},
		{"example.com.", "example.com"},
		{"", ""},
	}
	for _, c := range cases {
		if got := cleanHost(c.in); got != c.want {
			t.Errorf("cleanHost(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRegistrableDomain(t *testing.T) {
	cases := []struct{ in, want string }{
		{"www.youtube.com", "youtube.com"},
		{"youtube.com", "youtube.com"},
		{"m.youtube.com", "youtube.com"},
		{"news.bbc.co.uk", "bbc.co.uk"}, // multi-part ccTLD suffix
		// Private suffixes: each github.io / blogspot.com subdomain is its own
		// registrable domain (different users are different sites).
		{"blog.github.io", "blog.github.io"},
		{"a.b.blogspot.com", "b.blogspot.com"},
		{"localhost", "localhost"},
		{"foo.internal", "foo.internal"},
		{"", ""},
	}
	for _, c := range cases {
		if got := registrableDomain(c.in); got != c.want {
			t.Errorf("registrableDomain(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeIP(t *testing.T) {
	cases := []struct{ in, want string }{
		{"10.8.0.2", "10.8.0.2"},
		{"10.8.0.2/24", "10.8.0.2/24"}, // not a pure IP — returned as-is
		{"::ffff:10.8.0.2", "10.8.0.2"},
		{"2001:db8::1", "2001:db8::1"},
	}
	for _, c := range cases {
		if got := normalizeIP(c.in); got != c.want {
			t.Errorf("normalizeIP(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
