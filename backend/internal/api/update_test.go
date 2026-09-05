package api

import "testing"

func TestParseVersion(t *testing.T) {
	cases := []struct {
		in   string
		want []int
		pre  bool
		ok   bool
	}{
		{"1.0.0", []int{1, 0, 0}, false, true},
		{"v1.0.0", []int{1, 0, 0}, false, true},
		{"v1.2.3-beta.1", []int{1, 2, 3}, true, true},
		{"1.2.3-rc2", []int{1, 2, 3}, true, true},
		{"1.2.3+build.7", []int{1, 2, 3}, false, true},
		{"v2", []int{2}, false, true},
		{"1.2", []int{1, 2}, false, true},
		{"", nil, false, false},
		{"dev", nil, false, false},
		{"latest", nil, false, false},
		{"1.2.x", nil, false, false},
	}
	for _, c := range cases {
		got, pre, ok := parseVersion(c.in)
		if ok != c.ok {
			t.Errorf("parseVersion(%q) ok=%v, want %v", c.in, ok, c.ok)
			continue
		}
		if pre != c.pre {
			t.Errorf("parseVersion(%q) prerelease=%v, want %v", c.in, pre, c.pre)
			continue
		}
		if ok {
			if len(got) != len(c.want) {
				t.Errorf("parseVersion(%q) = %v, want %v", c.in, got, c.want)
				continue
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Errorf("parseVersion(%q) = %v, want %v", c.in, got, c.want)
					break
				}
			}
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"v1.0.0", "1.0.0", 0},
		{"1.0.0", "1.0.1", -1},
		{"1.0.1", "1.0.0", 1},
		{"1.2", "1.2.0", 0}, // missing segments count as 0
		{"1.9.0", "1.10.0", -1},
		{"2.0.0", "1.99.99", 1},
		{"1.2.3-beta.1", "1.2.3", -1}, // prerelease < release (suffix dropped → equal major.minor.patch)
		{"0.9.9", "1.0.0", -1},
	}
	for _, c := range cases {
		got, ok := compareVersions(c.a, c.b)
		if !ok {
			t.Errorf("compareVersions(%q, %q): parse failed", c.a, c.b)
			continue
		}
		if got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestIsOutdated(t *testing.T) {
	cases := []struct {
		current, latest string
		want            bool
	}{
		{"1.0.0", "1.0.1", true},
		{"1.0.1", "1.0.0", false},
		{"1.0.0", "1.0.0", false},
		{"dev", "9.9.9", false}, // dev has no comparable version
		{"1.0.0", "dev", false}, // unparseable latest is never "newer"
		{"1.0.0", "", false},
	}
	for _, c := range cases {
		if got := isOutdated(c.current, c.latest); got != c.want {
			t.Errorf("isOutdated(%q, %q) = %v, want %v", c.current, c.latest, got, c.want)
		}
	}
}
