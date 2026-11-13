// Package authz defines the console's fixed capability catalogue and the
// default policies for the built-in roles. Roles are data (admin_roles rows);
// the keys and their grouping live here so the API, middleware and UI agree.
package authz

import (
	"fmt"
	"sort"
	"strings"
)

const (
	MonitoringView = "monitoring.view"
	ActivityView   = "activity.view"
	AuditView      = "audit.view"

	NetworkView    = "network.view"
	NetworkManage  = "network.manage"
	NetworkSecrets = "network.secrets"

	DirectoryView   = "directory.view"
	DirectoryManage = "directory.manage"

	RulesView   = "rules.view"
	RulesManage = "rules.manage"

	SystemView   = "system.view"
	SystemManage = "system.manage"

	BackupsView   = "backups.view"
	BackupsManage = "backups.manage"

	AdminsView   = "admins.view"
	AdminsManage = "admins.manage"
	RolesManage  = "roles.manage"

	SecurityManage = "security.manage"
	AuditManage    = "audit.manage"
	MaintenanceRun = "maintenance.run"
)

// Permission is one selectable capability. Reserved capabilities are only
// available to the super_admin wildcard; custom roles and the editable system
// roles cannot receive them.
type Permission struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Group       string `json:"group"`
	Reserved    bool   `json:"reserved"`
}

// Group is a UI section in the role editor.
type Group struct {
	Key         string       `json:"key"`
	Label       string       `json:"label"`
	Permissions []Permission `json:"permissions"`
}

var permissions = []Permission{
	{Key: MonitoringView, Label: "View monitoring", Description: "Dashboard, statistics, server resources and traffic charts.", Group: "monitoring"},
	{Key: ActivityView, Label: "View web activity", Description: "Per-user browsing history, blocked domains and blocked IP attempts.", Group: "monitoring"},
	{Key: AuditView, Label: "View audit log", Description: "Read admin and system activity records.", Group: "monitoring"},

	{Key: NetworkView, Label: "View network", Description: "See servers, peers and exit nodes.", Group: "network"},
	{Key: NetworkManage, Label: "Manage network", Description: "Add, edit, suspend and remove servers, peers and nodes.", Group: "network"},
	{Key: NetworkSecrets, Label: "Read network secrets", Description: "Download peer configurations and server host setup material.", Group: "network"},

	{Key: DirectoryView, Label: "View directory", Description: "See VPN users and departments.", Group: "directory"},
	{Key: DirectoryManage, Label: "Manage directory", Description: "Invite, edit, suspend and remove VPN users and departments.", Group: "directory"},

	{Key: RulesView, Label: "View security rules", Description: "See domain and IP blocking rules and groups.", Group: "rules"},
	{Key: RulesManage, Label: "Manage security rules", Description: "Create and remove domain and IP blocking rules and groups.", Group: "rules"},

	{Key: SystemView, Label: "View system settings", Description: "See email, templates, timezone, backups and general configuration.", Group: "system"},
	{Key: SystemManage, Label: "Manage system settings", Description: "Change email, templates, timezone and general configuration.", Group: "system"},

	{Key: BackupsView, Label: "View backups", Description: "List saved database backups.", Group: "backups"},
	{Key: BackupsManage, Label: "Manage backups", Description: "Create, download, restore and delete database backups.", Group: "backups"},

	{Key: AdminsView, Label: "View admins", Description: "See admin accounts and their groups.", Group: "access", Reserved: true},
	{Key: AdminsManage, Label: "Manage admins and groups", Description: "Invite, edit, disable and reset admins, manage admin groups and bulk-assign roles.", Group: "access", Reserved: true},
	{Key: RolesManage, Label: "Manage roles", Description: "Create roles, change policies and reset built-in roles.", Group: "access", Reserved: true},

	{Key: SecurityManage, Label: "Manage security policy", Description: "Change MFA requirements, login lockout and step-up policy.", Group: "security", Reserved: true},
	{Key: AuditManage, Label: "Purge audit logs", Description: "Delete audit records outside the retention window.", Group: "maintenance", Reserved: true},
	{Key: MaintenanceRun, Label: "Run maintenance", Description: "Force rule syncs, rotate node tokens and read runtime diagnostics.", Group: "maintenance", Reserved: true},
}

var groups = []Group{
	{Key: "monitoring", Label: "Monitoring"},
	{Key: "network", Label: "Network"},
	{Key: "directory", Label: "Directory"},
	{Key: "rules", Label: "Security rules"},
	{Key: "system", Label: "System"},
	{Key: "backups", Label: "Backups"},
	{Key: "access", Label: "Access control"},
	{Key: "security", Label: "Security policy"},
	{Key: "maintenance", Label: "Maintenance"},
}

// DefaultRoles is the initial policy for the three built-in roles. They are
// seeded only when a role does not exist; later edits are never overwritten.
var DefaultRoles = map[string][]string{
	"super_admin": {"*"},
	"admin": {
		MonitoringView, ActivityView, AuditView,
		NetworkView, NetworkManage, NetworkSecrets,
		DirectoryView, DirectoryManage,
		RulesView, RulesManage,
		SystemView, SystemManage,
		BackupsView, BackupsManage,
	},
	"auditor": {
		MonitoringView, ActivityView, AuditView,
		NetworkView, DirectoryView, RulesView, SystemView, BackupsView,
	},
}

var byKey = func() map[string]Permission {
	m := make(map[string]Permission, len(permissions))
	for _, p := range permissions {
		m[p.Key] = p
	}
	return m
}()

var order = func() map[string]int {
	m := make(map[string]int, len(permissions))
	for i, p := range permissions {
		m[p.Key] = i
	}
	return m
}()

var reserved = func() map[string]bool {
	m := map[string]bool{}
	for _, p := range permissions {
		if p.Reserved {
			m[p.Key] = true
		}
	}
	return m
}()

// PermissionByKey returns the catalogue entry for key.
func PermissionByKey(key string) (Permission, bool) {
	p, ok := byKey[key]
	return p, ok
}

// IsReserved reports whether key is a super-admin-only capability.
func IsReserved(key string) bool { return reserved[key] }

// All returns a copy of the permission catalogue in display order.
func All() []Permission {
	out := make([]Permission, len(permissions))
	copy(out, permissions)
	return out
}

// Groups returns the grouped catalogue for the role editor.
func Groups() []Group {
	out := make([]Group, 0, len(groups))
	for _, g := range groups {
		item := Group{Key: g.Key, Label: g.Label}
		for _, p := range permissions {
			if p.Group == g.Key {
				item.Permissions = append(item.Permissions, p)
			}
		}
		out = append(out, item)
	}
	return out
}

// DefaultPolicy returns a copy of the seeded policy for a built-in role.
func DefaultPolicy(slug string) []string {
	p := DefaultRoles[slug]
	out := make([]string, len(p))
	copy(out, p)
	return out
}

// Has reports whether granted contains need. "*" grants everything.
func Has(granted []string, need string) bool {
	for _, p := range granted {
		if p == "*" || p == need {
			return true
		}
	}
	return false
}

// HasAny reports whether at least one required permission is granted.
func HasAny(granted []string, needed ...string) bool {
	for _, n := range needed {
		if Has(granted, n) {
			return true
		}
	}
	return false
}

// Validate checks a policy for syntax and catalogue membership. For a
// non-super role, reserved keys and "*" are rejected.
func Validate(policy []string, allowReserved bool) error {
	seen := map[string]bool{}
	for _, key := range policy {
		if key == "*" {
			if !allowReserved {
				return fmt.Errorf("wildcard permission is reserved for super_admin")
			}
			continue
		}
		p, ok := byKey[key]
		if !ok {
			return fmt.Errorf("unknown permission %q", key)
		}
		if p.Reserved && !allowReserved {
			return fmt.Errorf("permission %q is reserved for super_admin", key)
		}
		if seen[key] {
			return fmt.Errorf("duplicate permission %q", key)
		}
		seen[key] = true
	}
	return nil
}

// implied expresses capabilities that only make sense with their read
// counterpart. Keeping them together prevents an editable role from granting
// "manage" while hiding the page that hosts the action.
var implied = map[string][]string{
	NetworkManage:   {NetworkView},
	NetworkSecrets:  {NetworkView},
	DirectoryManage: {DirectoryView},
	RulesManage:     {RulesView},
	SystemManage:    {SystemView},
	BackupsManage:   {BackupsView},
	AuditManage:     {AuditView},
	SecurityManage:  {SystemView},
	MaintenanceRun:  {SystemView},
}

// Canonical de-duplicates, validates, adds implied read capabilities and
// orders a policy for storage.
func Canonical(policy []string) ([]string, error) {
	if err := Validate(policy, false); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(policy))
	add := func(key string) {
		if key == "" || seen[key] {
			return
		}
		seen[key] = true
		out = append(out, key)
	}
	for _, p := range policy {
		add(p)
	}
	for _, p := range policy {
		for _, extra := range implied[p] {
			add(extra)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return order[out[i]] < order[out[j]] })
	return out, nil
}

// Slugify turns a role/group display name into a safe stable slug.
func Slugify(name string) string {
	var b strings.Builder
	lastUnderscore := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastUnderscore = false
		case r == ' ' || r == '-' || r == '_' || r == '.':
			if b.Len() > 0 && !lastUnderscore {
				b.WriteByte('_')
				lastUnderscore = true
			}
		}
	}
	return strings.Trim(b.String(), "_")
}
