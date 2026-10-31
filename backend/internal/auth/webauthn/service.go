package webauthn

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Ceremony orchestration: the bridge between the go-webauthn library and the
// console's data model.
//
// Begin*For loads the admin's stable user handle + RP-scoped credentials,
// produces the library options (the INNER PublicKeyCredential*Options object
// the SPA hands to navigator.credentials.*), and persists the ceremony
// SessionData bound to the authorizing cookie. Finish*For atomically claims the
// ceremony, parses the client's raw response JSON and validates it with the
// library, then writes the credential/signCounter back.

var (
	// ErrUnavailable is returned when a ceremony cannot be served because the
	// deployment cannot host passkeys (IP-only console, disabled feature).
	ErrUnavailable = errors.New("passkeys are unavailable in this deployment")
	// ErrNoCredentials is returned when an admin has no usable passkey for the
	// current RP ID.
	ErrNoCredentials = errors.New("no passkeys registered")
)

// adminUser adapts the console's admin + webauthn_credentials rows to
// webauthn.User. WebAuthnID is the stable opaque handle from webauthn_users,
// never the admin UUID; name/displayName are the admin email.
type adminUser struct {
	handle      []byte
	name        string
	displayName string
	credentials []wa.Credential
	records     []CredentialRecord
}

func (u *adminUser) WebAuthnID() []byte                   { return u.handle }
func (u *adminUser) WebAuthnName() string                 { return u.name }
func (u *adminUser) WebAuthnDisplayName() string          { return u.displayName }
func (u *adminUser) WebAuthnCredentials() []wa.Credential { return u.credentials }

// requireService returns the process-wide relying party, or ErrUnavailable.
func requireService() (*Service, error) {
	svc := Current()
	if !svc.Available() {
		return nil, ErrUnavailable
	}
	return svc, nil
}

// loadAdminUser loads the WebAuthn user adapter for adminID under rpID.
// With withCredentials it also loads the admin's RP-scoped passkeys (used for
// allowCredentials/excludeCredentials and to locate the asserted credential).
func loadAdminUser(ctx context.Context, pool *pgxpool.Pool, adminID uuid.UUID, rpID string, withCredentials bool) (*adminUser, error) {
	var email string
	err := pool.QueryRow(ctx, `SELECT email FROM admins WHERE id = $1`, adminID).Scan(&email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("admin %s not found: %w", adminID, err)
	}
	if err != nil {
		return nil, err
	}

	handle, err := GetOrCreateUserHandle(ctx, pool, adminID, rpID)
	if err != nil {
		return nil, err
	}

	user := &adminUser{handle: handle, name: email, displayName: email}
	if withCredentials {
		records, err := ListCredentials(ctx, pool, adminID, rpID)
		if err != nil {
			return nil, err
		}
		user.records = records
		user.credentials = make([]wa.Credential, 0, len(records))
		for _, record := range records {
			user.credentials = append(user.credentials, record.Credential)
		}
	}
	return user, nil
}

// beginLoginOptions builds the assertion options + session data for a login or
// step-up ceremony. Step-up REQUIRES user verification (a bare presence tap is
// not proof enough to unlock a sensitive action); a second-factor login only
// prefers it, matching the relying-party configuration.
func beginLoginOptions(svc *Service, user *adminUser, purpose string) (*protocol.CredentialAssertion, *wa.SessionData, error) {
	userVerification := protocol.VerificationPreferred
	if purpose == PurposeStepUp {
		userVerification = protocol.VerificationRequired
	}
	opts := []wa.LoginOption{
		wa.WithUserVerification(userVerification),
	}
	if origin := svc.CeremonyOrigin(); origin != "" {
		opts = append(opts, wa.WithLoginOrigin(origin))
	}
	return svc.WA.BeginLogin(user, opts...)
}

// beginRegistrationOptions builds the credential-creation options + session
// data: attestation none (no MDS integration), UV preferred, resident key
// discouraged (login is username-first), credProps requested so the SPA can
// tell discoverable passkeys apart, and the RP's existing credentials excluded
// so one authenticator is not enrolled twice under the same account.
func beginRegistrationOptions(svc *Service, user *adminUser) (*protocol.CredentialCreation, *wa.SessionData, error) {
	opts := []wa.RegistrationOption{
		wa.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			UserVerification: protocol.VerificationPreferred,
			ResidentKey:      protocol.ResidentKeyRequirementDiscouraged,
		}),
		wa.WithConveyancePreference(protocol.PreferNoAttestation),
		wa.WithExtensions(wa.WithExtensionCredProps()),
	}
	if len(user.credentials) > 0 {
		opts = append(opts, wa.WithExclusions(wa.Credentials(user.credentials).CredentialDescriptors()))
	}
	if origin := svc.CeremonyOrigin(); origin != "" {
		opts = append(opts, wa.WithRegistrationOrigin(origin))
	}
	return svc.WA.BeginRegistration(user, opts...)
}

// finishLoginParsed parses a raw AuthenticationResponseJSON and validates it
// against the persisted ceremony session.
func finishLoginParsed(svc *Service, user *adminUser, session wa.SessionData, body []byte) (*wa.Credential, error) {
	parsed, err := protocol.ParseCredentialRequestResponseBytes(body)
	if err != nil {
		return nil, err
	}
	return svc.WA.ValidateLogin(user, session, parsed)
}

// finishRegistrationParsed parses a raw RegistrationResponseJSON and validates
// it against the persisted ceremony session.
func finishRegistrationParsed(svc *Service, user *adminUser, session wa.SessionData, body []byte) (*wa.Credential, error) {
	parsed, err := protocol.ParseCredentialCreationResponseBytes(body)
	if err != nil {
		return nil, err
	}
	return svc.WA.CreateCredential(user, session, parsed)
}

// BeginLoginFor begins a login (pending verify) or step-up assertion for
// adminID. It returns the INNER PublicKeyCredentialRequestOptions, the
// challenge row id and its expiry.
func BeginLoginFor(ctx context.Context, pool *pgxpool.Pool, adminID uuid.UUID, purpose, sessionBinding string) (*protocol.PublicKeyCredentialRequestOptions, uuid.UUID, time.Time, error) {
	if purpose != PurposeLogin && purpose != PurposeStepUp {
		return nil, uuid.Nil, time.Time{}, fmt.Errorf("invalid login purpose %q", purpose)
	}
	svc, err := requireService()
	if err != nil {
		return nil, uuid.Nil, time.Time{}, err
	}
	user, err := loadAdminUser(ctx, pool, adminID, svc.RPID, true)
	if err != nil {
		return nil, uuid.Nil, time.Time{}, err
	}
	if len(user.credentials) == 0 {
		return nil, uuid.Nil, time.Time{}, ErrNoCredentials
	}

	assertion, session, err := beginLoginOptions(svc, user, purpose)
	if err != nil {
		return nil, uuid.Nil, time.Time{}, err
	}
	challengeID, expiresAt, err := CreateChallenge(ctx, pool, purpose, adminID, sessionBinding, svc.CeremonyOrigin(), session)
	if err != nil {
		return nil, uuid.Nil, time.Time{}, err
	}
	return &assertion.Response, challengeID, expiresAt, nil
}

// BeginRegistrationFor begins a passkey registration ceremony for adminID
// (forced enrollment or self-service add). It returns the INNER
// PublicKeyCredentialCreationOptions, the challenge row id and its expiry.
func BeginRegistrationFor(ctx context.Context, pool *pgxpool.Pool, adminID uuid.UUID, sessionBinding string) (*protocol.PublicKeyCredentialCreationOptions, uuid.UUID, time.Time, error) {
	svc, err := requireService()
	if err != nil {
		return nil, uuid.Nil, time.Time{}, err
	}
	user, err := loadAdminUser(ctx, pool, adminID, svc.RPID, true)
	if err != nil {
		return nil, uuid.Nil, time.Time{}, err
	}
	creation, session, err := beginRegistrationOptions(svc, user)
	if err != nil {
		return nil, uuid.Nil, time.Time{}, err
	}
	challengeID, expiresAt, err := CreateChallenge(ctx, pool, PurposeEnroll, adminID, sessionBinding, svc.CeremonyOrigin(), session)
	if err != nil {
		return nil, uuid.Nil, time.Time{}, err
	}
	return &creation.Response, challengeID, expiresAt, nil
}

// FinishLoginFor claims a login/step-up ceremony, validates the raw
// AuthenticationResponseJSON, and updates the credential record (signCount,
// clone warning, flags, last_used_at). It returns the asserted credential row.
func FinishLoginFor(ctx context.Context, pool *pgxpool.Pool, adminID uuid.UUID, purpose, sessionBinding string, challengeID uuid.UUID, body []byte) (CredentialRecord, error) {
	svc, err := requireService()
	if err != nil {
		return CredentialRecord{}, err
	}
	if purpose != PurposeLogin && purpose != PurposeStepUp {
		return CredentialRecord{}, fmt.Errorf("invalid login purpose %q", purpose)
	}

	challenge, err := ClaimChallenge(ctx, pool, challengeID, adminID, sessionBinding, purpose)
	if err != nil {
		return CredentialRecord{}, err
	}
	if challenge.RPID != "" && challenge.RPID != svc.RPID {
		return CredentialRecord{}, fmt.Errorf("challenge was begun for RP ID %q", challenge.RPID)
	}

	user, err := loadAdminUser(ctx, pool, adminID, svc.RPID, true)
	if err != nil {
		return CredentialRecord{}, err
	}
	validated, err := finishLoginParsed(svc, user, challenge.SessionData, body)
	if err != nil {
		return CredentialRecord{}, err
	}

	record := CredentialRecord{}
	found := false
	for _, candidate := range user.records {
		if bytes.Equal(candidate.Credential.ID, validated.ID) {
			record = candidate
			found = true
			break
		}
	}
	if !found {
		return CredentialRecord{}, errors.New("validated credential is not stored for this admin")
	}
	record.Credential = *validated
	if err := SaveAfterLogin(ctx, pool, record); err != nil {
		return CredentialRecord{}, err
	}
	return record, nil
}

// FinishRegistrationFor claims an enrollment ceremony, validates the raw
// RegistrationResponseJSON, and persists the new passkey.
func FinishRegistrationFor(ctx context.Context, pool *pgxpool.Pool, adminID uuid.UUID, sessionBinding string, challengeID uuid.UUID, body []byte, label string) (CredentialRecord, error) {
	svc, err := requireService()
	if err != nil {
		return CredentialRecord{}, err
	}

	challenge, err := ClaimChallenge(ctx, pool, challengeID, adminID, sessionBinding, PurposeEnroll)
	if err != nil {
		return CredentialRecord{}, err
	}
	if challenge.RPID != "" && challenge.RPID != svc.RPID {
		return CredentialRecord{}, fmt.Errorf("challenge was begun for RP ID %q", challenge.RPID)
	}

	user, err := loadAdminUser(ctx, pool, adminID, svc.RPID, true)
	if err != nil {
		return CredentialRecord{}, err
	}
	validated, err := finishRegistrationParsed(svc, user, challenge.SessionData, body)
	if err != nil {
		return CredentialRecord{}, err
	}
	return InsertCredential(ctx, pool, adminID, svc.RPID, validated, label)
}
