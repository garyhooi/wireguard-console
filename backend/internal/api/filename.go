package api

import "strings"

// maxConfigFileNameBase caps the slug portion of a client config download
// filename. WireGuard clients use the imported filename as the tunnel name,
// so the slug is kept short enough to stay portable across platforms.
const maxConfigFileNameBase = 64

// configFileName derives the download filename for a WireGuard client config
// from a human-readable peer or server name.
//
// WireGuard clients derive the tunnel name from the imported filename, and
// spaces or special characters break the import in some clients (notably the
// Windows app). Downloads therefore use a lowercase ASCII slug - "AI Agent"
// becomes "ai-agent.conf" - while the peer's display name in the database and
// UI is left untouched.
//
// The slug is built by trimming surrounding whitespace, lowercasing ASCII
// letters, and keeping ASCII a-z and 0-9 while every run of any other
// character collapses to a single '-'. Lowercasing is deliberately ASCII-only
// (not strings.ToLower, whose Unicode simple case mapping can differ from the
// frontend's full case mapping) so the Go and TypeScript helpers produce byte
// identical filenames. Leading and trailing '-' are trimmed, the base is
// capped at 64 characters (trimming a trailing '-' again if the cut lands on
// one), and an empty result falls back to "wireguard". ".conf" is appended last.
func configFileName(name string) string {
	name = strings.TrimSpace(name)

	var b strings.Builder
	b.Grow(len(name))
	lastDash := false
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
			lastDash = false
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + ('a' - 'A'))
			lastDash = false
		case r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}

	slug := strings.Trim(b.String(), "-")
	if len(slug) > maxConfigFileNameBase {
		slug = slug[:maxConfigFileNameBase]
	}
	slug = strings.TrimRight(slug, "-")
	if slug == "" {
		slug = "wireguard"
	}
	return slug + ".conf"
}
