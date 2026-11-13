package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wireguard-console/backend/internal/authz"
)

func TestRequirePermissionWildcardAndAny(t *testing.T) {
	cases := []struct {
		name    string
		granted []string
		need    []string
		want    int
	}{
		{"wildcard", []string{"*"}, []string{authz.NetworkView}, http.StatusOK},
		{"exact", []string{authz.NetworkView}, []string{authz.NetworkView}, http.StatusOK},
		{"any-of", []string{authz.DirectoryView}, []string{authz.NetworkView, authz.DirectoryView}, http.StatusOK},
		{"missing", []string{authz.DirectoryView}, []string{authz.NetworkManage}, http.StatusForbidden},
		{"empty", nil, []string{authz.MonitoringView}, http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := RequirePermission(tc.need...)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))
			req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
			ctx := contextWithPermissions(req, tc.granted)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req.WithContext(ctx))
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func contextWithPermissions(r *http.Request, permissions []string) context.Context {
	return context.WithValue(r.Context(), adminPermissionsKey{}, permissions)
}
