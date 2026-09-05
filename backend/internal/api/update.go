package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ConsoleVersion returns the version this console was deployed with. install.sh
// stamps APP_VERSION into .env from the repo's VERSION file on every run, and
// the compose api service forwards it to the container. Unset (e.g. a manual
// setup or an install before this feature) reads as "dev".
func ConsoleVersion() string {
	if v := strings.TrimSpace(os.Getenv("APP_VERSION")); v != "" {
		return v
	}
	return "dev"
}

// GitHub release payload subset — enough for the console's "is there a newer
// release?" check. The fetch happens server-side so no GitHub token, no
// cross-origin API call and no CSP change are needed in the browser; the SPA
// only ever talks to the same-origin backend.
type githubRelease struct {
	TagName    string    `json:"tag_name"`
	HtmlURL    string    `json:"html_url"`
	Published  time.Time `json:"published_at"`
	Prerelease bool      `json:"prerelease"`
}

type updateCheck struct {
	Current      string     `json:"current"`               // console version running now
	Latest       string     `json:"latest"`                // newest release tag ("" when the check failed)
	LatestURL    string     `json:"latest_url"`            // GitHub releases page of the newest release
	PublishedAt  *time.Time `json:"published_at"`          // newest release publish time, if known
	Outdated     bool       `json:"outdated"`              // latest is newer than current (semver compare)
	Update       bool       `json:"update"`                // outdated AND current is not "dev"
	CheckError   string     `json:"check_error,omitempty"` // transient fetch problem, "" when ok
	CheckedAt    time.Time  `json:"checked_at"`            // when this result was produced
	InstallCmd   string     `json:"install_cmd"`           // the canonical update one-liner (display only)
	ReleasesURL  string     `json:"releases_url"`          // full releases list page on GitHub
	BackupFirst  bool       `json:"backup_first"`          // the update path requires a backup before it runs
	BackupMethod string     `json:"backup_method"`         // how to back up (Backups page), informational
}

// ---- cached GitHub lookup -------------------------------------------------
//
// GitHub's unauth rate limit (60 req/h per origin IP) would be exhausted by a
// browser polling the API, so the latest-release response is cached for
// UPDATE_CACHE_MINUTES (default 60) minutes. Several admins checking at once
// share one lookup via the in-flight mutex.

const githubReleasesAPI = "https://api.github.com/repos/garyhooi/wireguard-console/releases/latest"

var (
	updateMu       sync.Mutex
	updateInflight = make(chan struct{}, 1) // serializes concurrent lookups
	updateCache    *githubRelease
	updateCachedAt time.Time
)

// fetchLatestRelease returns the newest *published* release (the /latest
// endpoint skips prereleases). Network/HTTP failures bubble up so the caller
// can report them instead of guessing.
func fetchLatestRelease() (*githubRelease, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest(http.MethodGet, githubReleasesAPI, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "wireguard-console/"+ConsoleVersion())

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github returned HTTP %d", resp.StatusCode)
	}

	var rel githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, fmt.Errorf("bad github response: %w", err)
	}
	if rel.TagName == "" {
		return nil, fmt.Errorf("github response has no tag_name")
	}
	return &rel, nil
}

// latestRelease returns the cached lookup, refreshing it when the cache is
// older than the TTL (UPDATE_CACHE_MINUTES, default 60, 0 disables the cache).
// Concurrent callers share one in-flight fetch instead of stampeding GitHub.
func latestRelease() (*githubRelease, error) {
	cacheTTL := time.Duration(envMinutes("UPDATE_CACHE_MINUTES", 60)) * time.Minute

	updateMu.Lock()
	if updateCache != nil && (cacheTTL <= 0 || time.Since(updateCachedAt) < cacheTTL) {
		rel := updateCache
		updateMu.Unlock()
		return rel, nil
	}
	updateMu.Unlock()

	ch := updateInflight
	ch <- struct{}{} // serialize; only the first caller performs the fetch
	defer func() { <-ch }()

	updateMu.Lock()
	if updateCache != nil && (cacheTTL <= 0 || time.Since(updateCachedAt) < cacheTTL) {
		rel := updateCache
		updateMu.Unlock()
		return rel, nil
	}
	updateMu.Unlock()

	rel, err := fetchLatestRelease()
	if err == nil {
		updateMu.Lock()
		updateCache = rel
		updateCachedAt = time.Now()
		updateMu.Unlock()
	}
	return rel, err
}

func envMinutes(name string, def int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return def
	}
	return n
}

// ---------------------------------------------------------------------------

// parseVersion splits a release tag/version ("v1.0.0", "1.2.3-beta.1") into
// comparable numeric segments plus a prerelease flag (any "-" suffix such as
// -beta.1 or -rc2, which sorts below the bare release). Build metadata after
// "+" is ignored. Returns ok=false when the string is not a plausible version
// at all (then callers treat it as "unknown" rather than inventing an order).
func parseVersion(s string) (nums []int, prerelease bool, ok bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexByte(s, '+'); i >= 0 { // build metadata: drop
		s = s[:i]
	}
	if i := strings.IndexByte(s, '-'); i >= 0 { // pre-release: drop, flag it
		s = s[:i]
		prerelease = true
	}
	if s == "" {
		return nil, false, false
	}
	parts := strings.Split(s, ".")
	nums = make([]int, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			return nil, false, false
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false, false
		}
		nums = append(nums, n)
	}
	return nums, prerelease, true
}

// compareVersions returns -1/0/1 for a<b / a==b / a>b, treating missing
// segments as 0 ("1.2" == "1.2.0") and a prerelease as lower than the bare
// release ("1.2.3-beta.1" < "1.2.3"). ok=false when either side failed to
// parse.
func compareVersions(a, b string) (int, bool) {
	as, apre, ok := parseVersion(a)
	if !ok {
		return 0, false
	}
	bs, bpre, ok := parseVersion(b)
	if !ok {
		return 0, false
	}
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		var av, bv int
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		if av < bv {
			return -1, true
		}
		if av > bv {
			return 1, true
		}
	}
	// Same numeric segments: a prerelease sorts below the bare release.
	switch {
	case apre && !bpre:
		return -1, true
	case !apre && bpre:
		return 1, true
	}
	return 0, true
}

// isOutdated reports whether latest is strictly newer than current. A "dev"
// build never counts as outdated on its own (no version to compare), and an
// unparseable latest (a tag that isn't semver-ish) is treated as not outdated.
func isOutdated(current, latest string) bool {
	cmp, ok := compareVersions(current, latest)
	return ok && cmp < 0
}

// UpdateCheckHandler serves the console's version/update status:
//
//	GET /api/update/check
//
// Response fields (all JSON):
//
//	current      — APP_VERSION as stamped by install.sh ("dev" when unset)
//	latest       — newest GitHub release tag ("" if the lookup failed)
//	latest_url   — URL of that release
//	outdated     — latest > current (pure version comparison)
//	update       — outdated && current is a real version (not "dev")
//	check_error  — why the lookup failed, when it did
//	install_cmd  — the canonical one-liner admins run on the server to update
//	backup_first — updating replaces the running stack, so back up first
//
// A failed GitHub lookup is NOT an error response: the console still shows its
// current version and surfaces check_error for a manual retry later.
func UpdateCheckHandler(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		current := ConsoleVersion()
		ctx := context.Background()
		adminID := getAdminID(r)

		rel, err := latestRelease()
		now := time.Now()

		out := updateCheck{
			Current:      current,
			CheckedAt:    now,
			InstallCmd:   "curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/install.sh | sudo bash",
			ReleasesURL:  "https://github.com/garyhooi/wireguard-console/releases",
			BackupFirst:  true,
			BackupMethod: "Backups page → New backup (or the download button for an off-server copy)",
		}
		if err != nil {
			out.CheckError = err.Error()
		} else {
			out.Latest = rel.TagName
			out.LatestURL = rel.HtmlURL
			out.PublishedAt = &rel.Published
			out.Outdated = isOutdated(current, rel.TagName)
			out.Update = out.Outdated && current != "dev"
		}

		logAudit(ctx, store, adminID, "update.check", "update", out.Latest, map[string]interface{}{
			"current":  out.Current,
			"latest":   out.Latest,
			"outdated": out.Outdated,
			"error":    out.CheckError,
		})

		writeJSON(w, http.StatusOK, out)
	}
}
