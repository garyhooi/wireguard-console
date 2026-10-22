package api

import (
	"testing"

	"github.com/google/uuid"

	"github.com/wireguard-console/backend/internal/db"
	"github.com/wireguard-console/backend/internal/wgclient"
)

func TestParseRulePeerIDs(t *testing.T) {
	a := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	b := uuid.MustParse("22222222-2222-2222-2222-222222222222")

	got, err := parseRulePeerIDs([]string{b.String(), a.String(), b.String(), " " + a.String() + " "})
	if err != nil {
		t.Fatalf("parseRulePeerIDs: %v", err)
	}
	if len(got) != 2 || got[0] != a || got[1] != b {
		t.Fatalf("parseRulePeerIDs = %v, want de-duplicated+sorted [%s %s]", got, a, b)
	}

	empty, err := parseRulePeerIDs(nil)
	if err != nil {
		t.Fatalf("parseRulePeerIDs(nil): %v", err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("parseRulePeerIDs(nil) = %v, want non-nil empty slice", empty)
	}

	if _, err := parseRulePeerIDs([]string{"not-a-uuid"}); err == nil {
		t.Fatal("parseRulePeerIDs accepted an invalid peer id")
	}
}

func TestParseStoredPeerIDs(t *testing.T) {
	a := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	b := uuid.MustParse("22222222-2222-2222-2222-222222222222")

	cases := []struct {
		name string
		raw  string
		want []uuid.UUID
	}{
		{"empty", "", []uuid.UUID{}},
		{"csv", a.String() + "," + b.String(), []uuid.UUID{a, b}},
		{"whitespace", " " + a.String() + " , " + b.String() + " ", []uuid.UUID{a, b}},
		{"drops garbage", a.String() + ",garbage," + b.String(), []uuid.UUID{a, b}},
	}
	for _, tc := range cases {
		got := parseStoredPeerIDs(tc.raw)
		if len(got) != len(tc.want) {
			t.Fatalf("%s: parseStoredPeerIDs(%q) = %v, want %v", tc.name, tc.raw, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("%s: parseStoredPeerIDs(%q) = %v, want %v", tc.name, tc.raw, got, tc.want)
			}
		}
	}
}

func TestPeerIDStrings(t *testing.T) {
	a := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	got := peerIDStrings([]uuid.UUID{a})
	if len(got) != 1 || got[0] != a.String() {
		t.Fatalf("peerIDStrings = %v, want [%s]", got, a)
	}
	if empty := peerIDStrings(nil); empty == nil || len(empty) != 0 {
		t.Fatalf("peerIDStrings(nil) = %v, want non-nil empty slice", empty)
	}
}

func entrySources(entries []wgclient.IPBlockRule) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.SourceIP)
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestExpandIPBlockRulesPeerScope(t *testing.T) {
	userID := uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	peerA := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	peerB := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	peerV6 := uuid.MustParse("33333333-3333-3333-3333-333333333333")
	unknown := uuid.MustParse("99999999-9999-9999-9999-999999999999")

	peersByUser := map[uuid.UUID][]serverPeer{
		userID: {
			{ID: peerA, IP: "10.8.0.2"},
			{ID: peerB, IP: "10.8.0.3"},
			{ID: peerV6, IP: "fd00::2"},
		},
	}

	userRule := func(cidr string, peerIDs ...uuid.UUID) db.IPBlockRule {
		uid := userID
		return db.IPBlockRule{
			ID:      uuid.New(),
			Scope:   "user",
			UserID:  &uid,
			CIDR:    cidr,
			PeerIDs: peerIDs,
		}
	}

	cases := []struct {
		name       string
		rules      []db.IPBlockRule
		wantSource []string
		wantUnexp  int
	}{
		{
			name:       "empty selection keeps all peers",
			rules:      []db.IPBlockRule{userRule("203.0.113.0/24")},
			wantSource: []string{"10.8.0.2", "10.8.0.3"},
		},
		{
			name:       "subset expands only the selected peer",
			rules:      []db.IPBlockRule{userRule("203.0.113.0/24", peerA)},
			wantSource: []string{"10.8.0.2"},
		},
		{
			name:       "selection order does not matter",
			rules:      []db.IPBlockRule{userRule("203.0.113.0/24", peerB, peerA)},
			wantSource: []string{"10.8.0.2", "10.8.0.3"},
		},
		{
			name:       "unknown (removed) peer id is ignored",
			rules:      []db.IPBlockRule{userRule("203.0.113.0/24", peerA, unknown)},
			wantSource: []string{"10.8.0.2"},
		},
		{
			name:      "only unknown peer ids makes the rule unexpanded",
			rules:     []db.IPBlockRule{userRule("203.0.113.0/24", unknown)},
			wantUnexp: 1,
		},
		{
			name:       "duplicate peer ids are deduplicated",
			rules:      []db.IPBlockRule{userRule("203.0.113.0/24", peerA, peerA)},
			wantSource: []string{"10.8.0.2"},
		},
		{
			name: "same destination with different peer subsets yields one entry per peer",
			rules: []db.IPBlockRule{
				userRule("203.0.113.0/24", peerA),
				userRule("203.0.113.0/24", peerB),
			},
			wantSource: []string{"10.8.0.2", "10.8.0.3"},
		},
		{
			name: "same peer+destination from two rules is deduplicated",
			rules: []db.IPBlockRule{
				userRule("203.0.113.0/24", peerA),
				userRule("203.0.113.0/24", peerA),
			},
			wantSource: []string{"10.8.0.2"},
		},
		{
			name:       "family mismatch for the selected peer leaves the rule unexpanded",
			rules:      []db.IPBlockRule{userRule("2001:db8::/48", peerA)},
			wantSource: []string{},
			wantUnexp:  1,
		},
		{
			name:       "IPv6 destination expands to the selected IPv6 peer",
			rules:      []db.IPBlockRule{userRule("2001:db8::/48", peerV6)},
			wantSource: []string{"fd00::2"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entries, _, unexpanded := expandIPBlockRules(tc.rules, peersByUser, nil, nil, "", "")
			got := entrySources(entries)
			want := tc.wantSource
			if want == nil {
				want = []string{}
			}
			if !equalStrings(got, want) {
				t.Fatalf("sources = %v, want %v", got, want)
			}
			if len(unexpanded) != tc.wantUnexp {
				t.Fatalf("unexpanded = %v, want %d", unexpanded, tc.wantUnexp)
			}
		})
	}
}

// Department/global expansion must keep ignoring peer selection entirely.
func TestExpandIPBlockRulesUnchangedScopes(t *testing.T) {
	deptID := uuid.MustParse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
	peersByDepartment := map[uuid.UUID][]string{
		deptID: {"10.9.0.2", "10.9.0.3"},
	}

	rules := []db.IPBlockRule{
		{ID: uuid.New(), Scope: "department", DepartmentID: &deptID, CIDR: "203.0.113.0/24"},
		{ID: uuid.New(), Scope: "global", CIDR: "198.51.100.0/24"},
	}
	entries, _, unexpanded := expandIPBlockRules(rules, nil, peersByDepartment, nil, "", "")
	got := entrySources(entries)
	want := []string{"", "10.9.0.2", "10.9.0.3"}
	if !equalStrings(got, want) {
		t.Fatalf("sources = %v, want %v", got, want)
	}
	if len(unexpanded) != 0 {
		t.Fatalf("unexpanded = %v, want none", unexpanded)
	}
}
