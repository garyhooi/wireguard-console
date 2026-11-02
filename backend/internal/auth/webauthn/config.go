// Package webauthn owns the WebAuthn relying-party configuration and helpers
// that bridge the go-webauthn library and the console's data model.
//
// The relying-party ID and allowed origins are DERIVED from the console's own
// configuration (CONSOLE_DOMAIN / CONSOLE_ORIGIN) and never from request
// headers: the API sits behind Caddy and optionally Cloudflare, so only the
// configured value is trustworthy, and it is the browser-visible origin that
// WebAuthn clients validate against.
package webauthn

import (
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
)

const (
	defaultDisplayName = "WireGuard Console"
	ceremonyTimeout    = 5 * time.Minute
)

// Service is the process-wide WebAuthn relying party. A disabled Service is a
// normal deployment state (IP-only consoles cannot have passkeys); callers
// must check Available() and fall back to authenticator-app MFA.
type Service struct {
	Enabled       bool
	Reason        string
	RPID          string
	RPDisplayName string
	Origins       []string
	WA            *wa.WebAuthn
}

var current = &Service{Reason: "WebAuthn not initialised"}

// Current returns the process-wide service. It is never nil.
func Current() *Service { return current }

// Available reports whether passkey ceremonies can be served.
func (s *Service) Available() bool {
	return s != nil && s.Enabled && s.WA != nil
}

// CeremonyOrigin returns the single origin to bind a ceremony to when the
// deployment has exactly one (production always does). Empty means "accept any
// configured origin".
func (s *Service) CeremonyOrigin() string {
	if !s.Available() || len(s.Origins) != 1 {
		return ""
	}
	return s.Origins[0]
}

// InitFromEnv derives the RP configuration and makes it current. It never
// fails: a bad configuration disables passkeys (logged once) and leaves
// authenticator-app MFA fully usable.
func InitFromEnv() *Service {
	svc := derive()
	current = svc
	if svc.Available() {
		log.Printf("passkeys: enabled (RP ID %q, origins %v)", svc.RPID, svc.Origins)
	} else {
		log.Printf("passkeys: unavailable (%s) - authenticator-app MFA remains available", svc.Reason)
	}
	return svc
}

func derive() *Service {
	display := strings.TrimSpace(os.Getenv("WEBAUTHN_RP_DISPLAY_NAME"))
	if display == "" {
		display = defaultDisplayName
	}

	switch strings.ToLower(strings.TrimSpace(os.Getenv("MFA_PASSKEY_ENABLED"))) {
	case "false", "0", "no", "off":
		return &Service{Reason: "disabled by MFA_PASSKEY_ENABLED"}
	}

	rpID := strings.TrimSpace(os.Getenv("WEBAUTHN_RP_ID"))
	origins := splitCSV(os.Getenv("WEBAUTHN_RP_ORIGINS"))
	domain := strings.TrimSpace(os.Getenv("CONSOLE_DOMAIN"))

	if rpID == "" && len(origins) == 0 {
		switch {
		case domain == "":
			// Local development: go run ./cmd/api + bun run dev.
			rpID = "localhost"
			origins = []string{"http://localhost:5173", "http://localhost:8080", "http://localhost"}
		case net.ParseIP(domain) != nil:
			return &Service{Reason: "IP-only deployment - the WebAuthn relying-party ID must be a domain, not an IP address"}
		default:
			rpID = domain
			origins = []string{"https://" + domain}
			if o := strings.TrimSpace(os.Getenv("CONSOLE_ORIGIN")); o != "" && originCoversRPID(o, rpID) {
				origins = append(origins, o)
			}
		}
	}

	if rpID == "" || len(origins) == 0 {
		return &Service{Reason: "incomplete WEBAUTHN_RP_ID / WEBAUTHN_RP_ORIGINS configuration"}
	}
	if err := protocol.ValidateRPID(rpID); err != nil {
		return &Service{Reason: fmt.Sprintf("invalid WEBAUTHN_RP_ID: %v", err)}
	}
	for _, origin := range origins {
		if err := validateOrigin(origin, rpID); err != nil {
			return &Service{Reason: err.Error()}
		}
	}

	timeout := wa.TimeoutConfig{Enforce: true, Timeout: ceremonyTimeout, TimeoutUVD: ceremonyTimeout}
	w, err := wa.New(&wa.Config{
		RPID:          rpID,
		RPDisplayName: display,
		RPOrigins:     origins,
		// Self-hosted console: do not ask for attestation (no MDS integration).
		// Resident keys are REQUIRED so a passkey can sign in without a password
		// (discoverable credential + account picker); user verification is
		// preferred at sign-in and required for step-up.
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			UserVerification: protocol.VerificationPreferred,
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
		},
		Timeouts: wa.TimeoutsConfig{Registration: timeout, Login: timeout},
	})
	if err != nil {
		return &Service{Reason: fmt.Sprintf("webauthn.New: %v", err)}
	}

	return &Service{
		Enabled:       true,
		Reason:        "ok",
		RPID:          rpID,
		RPDisplayName: display,
		Origins:       origins,
		WA:            w,
	}
}

func validateOrigin(origin, rpID string) error {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("invalid WebAuthn origin %q", origin)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLocalhost(u.Hostname()) {
			return fmt.Errorf("insecure WebAuthn origin %q (only localhost may use http://)", origin)
		}
	default:
		return fmt.Errorf("unsupported WebAuthn origin scheme %q", u.Scheme)
	}
	if !originCoversRPID(origin, rpID) {
		return fmt.Errorf("WebAuthn origin %q is not covered by RP ID %q", origin, rpID)
	}
	return nil
}

func originCoversRPID(origin, rpID string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	rp := strings.ToLower(strings.TrimSuffix(rpID, "."))
	return host == rp || strings.HasSuffix(host, "."+rp)
}

func isLocalhost(host string) bool {
	h := strings.ToLower(host)
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

func splitCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
