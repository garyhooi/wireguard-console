package authz

import (
	"reflect"
	"testing"
)

func TestDefaultPoliciesAreValid(t *testing.T) {
	for slug, policy := range DefaultRoles {
		if slug == "super_admin" {
			if !reflect.DeepEqual(policy, []string{"*"}) {
				t.Fatalf("super_admin policy = %v, want wildcard", policy)
			}
			continue
		}
		if err := Validate(policy, false); err != nil {
			t.Fatalf("%s default policy is invalid: %v", slug, err)
		}
	}
}

func TestCanonicalAddsImpliedReadPermissions(t *testing.T) {
	got, err := Canonical([]string{NetworkManage, DirectoryManage, RulesManage, SystemManage, BackupsManage})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		NetworkView, DirectoryView, RulesView, SystemView, BackupsView,
		NetworkManage, DirectoryManage, RulesManage, SystemManage, BackupsManage,
	} {
		if !contains(got, want) {
			t.Fatalf("canonical policy %v is missing %q", got, want)
		}
	}
}

func TestCanonicalAllowsReservedButRejectsWildcard(t *testing.T) {
	for _, policy := range [][]string{{AdminsView}, {RolesManage}, {SecurityManage}} {
		if _, err := Canonical(policy); err != nil {
			t.Fatalf("Canonical(%v) rejected a grantable sensitive capability: %v", policy, err)
		}
	}
	if _, err := Canonical([]string{"*"}); err == nil {
		t.Fatal("Canonical accepted the super_admin wildcard")
	}
}

func TestCanonicalAdminsManageImpliesView(t *testing.T) {
	got, err := Canonical([]string{AdminsManage})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(got, AdminsView) {
		t.Fatalf("canonical policy %v is missing %q", got, AdminsView)
	}
}

func TestCanonicalRejectsUnknownAndDuplicates(t *testing.T) {
	if _, err := Canonical([]string{"network.read"}); err == nil {
		t.Fatal("unknown permission accepted")
	}
	if _, err := Canonical([]string{NetworkView, NetworkView}); err == nil {
		t.Fatal("duplicate permission accepted")
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Network operator":  "network_operator",
		"  Ops / on-call  ": "ops_on_call",
		"Admin":             "admin",
		"":                  "",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Fatalf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
