package webauthn

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	authwebauthntest "github.com/wireguard-console/backend/internal/webauthntest"
)

// Unit tests for the ceremony bridge + credential mapping. They use the real
// go-webauthn library and the in-tree virtual authenticator, so a passing test
// proves the options/session-validation/storage round trip, not a mock.

const (
	testRPID   = "vpn.example.com"
	testOrigin = "https://vpn.example.com"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	timeout := wa.TimeoutConfig{Enforce: true, Timeout: 5 * time.Minute, TimeoutUVD: 5 * time.Minute}
	waSvc, err := wa.New(&wa.Config{
		RPID:                  testRPID,
		RPDisplayName:         "WireGuard Console",
		RPOrigins:             []string{testOrigin},
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			UserVerification: protocol.VerificationPreferred,
			ResidentKey:      protocol.ResidentKeyRequirementDiscouraged,
		},
		Timeouts: wa.TimeoutsConfig{Registration: timeout, Login: timeout},
	})
	if err != nil {
		t.Fatalf("webauthn.New: %v", err)
	}
	svc := &Service{
		Enabled:       true,
		Reason:        "ok",
		RPID:          testRPID,
		RPDisplayName: "WireGuard Console",
		Origins:       []string{testOrigin},
		WA:            waSvc,
	}
	previous := current
	current = svc
	t.Cleanup(func() { current = previous })
	return svc
}

func testAdminUser() *adminUser {
	handle := make([]byte, 32)
	for i := range handle {
		handle[i] = byte(i + 1)
	}
	return &adminUser{handle: handle, name: "admin@example.com", displayName: "admin@example.com"}
}

// enrollTestPasskey runs a full registration ceremony and returns the validated
// credential.
func enrollTestPasskey(t *testing.T, svc *Service, user *adminUser, authenticator *authwebauthntest.Authenticator) *wa.Credential {
	t.Helper()
	creation, session, err := beginRegistrationOptions(svc, user)
	if err != nil {
		t.Fatalf("beginRegistrationOptions: %v", err)
	}
	response, err := authenticator.RegistrationResponse(&creation.Response, testOrigin, testRPID)
	if err != nil {
		t.Fatalf("RegistrationResponse: %v", err)
	}
	body, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal registration response: %v", err)
	}
	credential, err := finishRegistrationParsed(svc, user, *session, body)
	if err != nil {
		t.Fatalf("finishRegistrationParsed: %v", err)
	}
	return credential
}

func TestAdminUserImplementsUser(t *testing.T) {
	var _ wa.User = (*adminUser)(nil)
}

func TestRegistrationAndLoginRoundTrip(t *testing.T) {
	svc := newTestService(t)
	user := testAdminUser()
	authenticator, err := authwebauthntest.New()
	if err != nil {
		t.Fatalf("virtual authenticator: %v", err)
	}

	creation, session, err := beginRegistrationOptions(svc, user)
	if err != nil {
		t.Fatalf("beginRegistrationOptions: %v", err)
	}
	if !containsString(session.Extensions.Requested, protocol.ExtensionCredProps) {
		t.Fatalf("registration session does not record the requested credProps extension: %v", session.Extensions.Requested)
	}
	if session.Expires.IsZero() {
		t.Fatal("registration session has no expiry despite enforced timeouts")
	}
	if creation.Response.AuthenticatorSelection.UserVerification != protocol.VerificationPreferred {
		t.Fatalf("UV preference = %q, want preferred", creation.Response.AuthenticatorSelection.UserVerification)
	}
	if creation.Response.Attestation != protocol.PreferNoAttestation {
		t.Fatalf("attestation = %q, want none", creation.Response.Attestation)
	}

	// Persisting SessionData as JSON and reading it back MUST be lossless:
	// the finish step re-validates the exact requested extensions.
	sessionJSON, err := json.Marshal(session)
	if err != nil {
		t.Fatalf("marshal session: %v", err)
	}
	var restored wa.SessionData
	if err := json.Unmarshal(sessionJSON, &restored); err != nil {
		t.Fatalf("unmarshal session: %v", err)
	}
	if !containsString(restored.Extensions.Requested, protocol.ExtensionCredProps) {
		t.Fatalf("restored session lost the requested extensions: %v", restored.Extensions.Requested)
	}
	if restored.Challenge != session.Challenge || restored.GetRelyingPartyID("") != testRPID {
		t.Fatalf("restored session mismatch: %+v", restored)
	}

	registrationResponse, err := authenticator.RegistrationResponse(&creation.Response, testOrigin, testRPID)
	if err != nil {
		t.Fatalf("RegistrationResponse: %v", err)
	}
	registrationBody, err := json.Marshal(registrationResponse)
	if err != nil {
		t.Fatalf("marshal registration response: %v", err)
	}
	credential, err := finishRegistrationParsed(svc, user, restored, registrationBody)
	if err != nil {
		t.Fatalf("finishRegistrationParsed with persisted session: %v", err)
	}
	if !bytes.Equal(credential.ID, authenticator.CredentialID) {
		t.Fatalf("credential id mismatch: got %x want %x", credential.ID, authenticator.CredentialID)
	}
	if !credential.Flags.UserPresent || !credential.Flags.UserVerified {
		t.Fatalf("registration flags lost UP/UV: %+v", credential.Flags)
	}
	if credential.Flags.ProtocolValue()&protocol.FlagAttestedCredentialData == 0 {
		t.Fatalf("registration flags lost the AT bit: %#x", credential.Flags.ProtocolValue())
	}
	if credential.Extensions.RK == nil {
		t.Fatal("credProps extension result not persisted on the credential")
	}

	user.credentials = []wa.Credential{*credential}

	assertion, loginSession, err := beginLoginOptions(svc, user, PurposeLogin)
	if err != nil {
		t.Fatalf("beginLoginOptions: %v", err)
	}
	if loginSession.UserVerification != protocol.VerificationPreferred {
		t.Fatalf("login UV = %q, want preferred", loginSession.UserVerification)
	}
	if len(loginSession.AllowedCredentialIDs) != 1 {
		t.Fatalf("login allowed credentials = %d, want 1", len(loginSession.AllowedCredentialIDs))
	}

	assertionResponse, err := authenticator.AssertionResponse(&assertion.Response, testOrigin, testRPID, user.handle)
	if err != nil {
		t.Fatalf("AssertionResponse: %v", err)
	}
	assertionBody, err := json.Marshal(assertionResponse)
	if err != nil {
		t.Fatalf("marshal assertion: %v", err)
	}
	validated, err := finishLoginParsed(svc, user, *loginSession, assertionBody)
	if err != nil {
		t.Fatalf("finishLoginParsed: %v", err)
	}
	if validated.Authenticator.SignCount != 1 {
		t.Fatalf("sign count after login = %d, want 1", validated.Authenticator.SignCount)
	}
	if validated.Authenticator.CloneWarning {
		t.Fatal("clone warning set on a fresh credential")
	}

	// Negative: wrong challenge, wrong origin, invalid signature.
	wrongChallenge, err := authenticator.AssertionResponseWithChallenge(&assertion.Response, testOrigin, testRPID, user.handle, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if err != nil {
		t.Fatalf("AssertionResponseWithChallenge: %v", err)
	}
	if _, err := finishLoginParsed(svc, user, *loginSession, mustJSON(t, wrongChallenge)); err == nil {
		t.Fatal("expected a challenge-mismatch error")
	}

	wrongOrigin, err := authenticator.AssertionResponse(&assertion.Response, "https://evil.example.com", testRPID, user.handle)
	if err != nil {
		t.Fatalf("AssertionResponse (wrong origin): %v", err)
	}
	if _, err := finishLoginParsed(svc, user, *loginSession, mustJSON(t, wrongOrigin)); err == nil {
		t.Fatal("expected an origin-mismatch error")
	}

	badSignature, err := authenticator.AssertionResponseBadSignature(&assertion.Response, testOrigin, testRPID, user.handle)
	if err != nil {
		t.Fatalf("AssertionResponseBadSignature: %v", err)
	}
	if _, err := finishLoginParsed(svc, user, *loginSession, mustJSON(t, badSignature)); err == nil {
		t.Fatal("expected a signature error")
	}

	// A response whose user handle does not match the ceremony user is refused.
	otherHandle := make([]byte, 32)
	otherHandle[0] = 0xff
	mismatchedHandle, err := authenticator.AssertionResponse(&assertion.Response, testOrigin, testRPID, otherHandle)
	if err != nil {
		t.Fatalf("AssertionResponse (handle): %v", err)
	}
	if _, err := finishLoginParsed(svc, user, *loginSession, mustJSON(t, mismatchedHandle)); err == nil {
		t.Fatal("expected a user-handle mismatch error")
	}
}

func TestStepUpRequiresUserVerification(t *testing.T) {
	svc := newTestService(t)
	user := testAdminUser()
	authenticator, err := authwebauthntest.New()
	if err != nil {
		t.Fatalf("virtual authenticator: %v", err)
	}
	credential := enrollTestPasskey(t, svc, user, authenticator)
	user.credentials = []wa.Credential{*credential}

	assertion, session, err := beginLoginOptions(svc, user, PurposeStepUp)
	if err != nil {
		t.Fatalf("beginLoginOptions(stepup): %v", err)
	}
	if session.UserVerification != protocol.VerificationRequired {
		t.Fatalf("step-up UV = %q, want required", session.UserVerification)
	}

	// A presence-only assertion must not unlock a step-up action.
	authenticator.UserVerified = false
	noUV, err := authenticator.AssertionResponse(&assertion.Response, testOrigin, testRPID, user.handle)
	if err != nil {
		t.Fatalf("AssertionResponse (no UV): %v", err)
	}
	if _, err := finishLoginParsed(svc, user, *session, mustJSON(t, noUV)); err == nil {
		t.Fatal("step-up accepted an assertion without user verification")
	}

	// The same authenticator with UV succeeds.
	authenticator.UserVerified = true
	withUV, err := authenticator.AssertionResponse(&assertion.Response, testOrigin, testRPID, user.handle)
	if err != nil {
		t.Fatalf("AssertionResponse (UV): %v", err)
	}
	if _, err := finishLoginParsed(svc, user, *session, mustJSON(t, withUV)); err != nil {
		t.Fatalf("step-up with UV rejected: %v", err)
	}
}

func TestCredentialRowRoundTrip(t *testing.T) {
	adminID := uuid.New()
	credentialID := uuid.New()
	extensionValue := false
	transport := []protocol.AuthenticatorTransport{protocol.Internal, protocol.Hybrid}
	flags := protocol.FlagUserPresent | protocol.FlagUserVerified | protocol.FlagBackupEligible |
		protocol.FlagBackupState | protocol.FlagAttestedCredentialData
	aaguid := make([]byte, 16)
	for i := range aaguid {
		aaguid[i] = byte(i)
	}
	credential := wa.Credential{
		ID:                []byte{0x01, 0x02, 0x03, 0x04},
		PublicKey:         []byte{0xde, 0xad, 0xbe, 0xef},
		AttestationType:   "none",
		AttestationFormat: "none",
		Transport:         transport,
		Flags:             wa.NewCredentialFlags(flags),
		Authenticator: wa.Authenticator{
			AAGUID:       aaguid,
			SignCount:    42,
			CloneWarning: true,
			Attachment:   protocol.CrossPlatform,
		},
		Attestation: wa.CredentialAttestation{
			ClientDataJSON:     []byte(`{"type":"webauthn.create"}`),
			ClientDataHash:     []byte{1, 2, 3},
			AuthenticatorData:  []byte{4, 5, 6},
			PublicKeyAlgorithm: -7,
			Object:             []byte{7, 8, 9},
		},
		Extensions: wa.CredentialExtensions{RK: &extensionValue},
	}

	columns, err := newCredentialColumns(credentialID, adminID, testRPID, &credential, "  My laptop key  ")
	if err != nil {
		t.Fatalf("newCredentialColumns: %v", err)
	}
	if columns.Flags != int16(flags) {
		t.Fatalf("raw flags column = %#x, want %#x", columns.Flags, int16(flags))
	}
	if columns.Label != "My laptop key" {
		t.Fatalf("label = %q, want trimmed", columns.Label)
	}
	if columns.Transports != "internal,hybrid" {
		t.Fatalf("transports = %q", columns.Transports)
	}

	record, err := columns.record()
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if record.ID != credentialID || record.AdminID != adminID || record.RPID != testRPID {
		t.Fatalf("row identity lost: %+v", record)
	}
	restored := record.Credential
	if restored.Flags.ProtocolValue() != flags {
		t.Fatalf("restored flags octet = %#x, want %#x", restored.Flags.ProtocolValue(), flags)
	}
	if !restored.Flags.UserPresent || !restored.Flags.UserVerified || !restored.Flags.BackupEligible || !restored.Flags.BackupState {
		t.Fatalf("restored boolean flags incomplete: %+v", restored.Flags)
	}
	if restored.Authenticator.SignCount != 42 || !restored.Authenticator.CloneWarning {
		t.Fatalf("authenticator state lost: %+v", restored.Authenticator)
	}
	if restored.Authenticator.Attachment != protocol.CrossPlatform {
		t.Fatalf("attachment lost: %q", restored.Authenticator.Attachment)
	}
	if !bytes.Equal(restored.Authenticator.AAGUID, aaguid) {
		t.Fatalf("AAGUID lost: %x", restored.Authenticator.AAGUID)
	}
	if len(restored.Transport) != 2 || restored.Transport[0] != protocol.Internal || restored.Transport[1] != protocol.Hybrid {
		t.Fatalf("transports lost: %v", restored.Transport)
	}
	if !bytes.Equal(restored.Attestation.ClientDataJSON, credential.Attestation.ClientDataJSON) ||
		!bytes.Equal(restored.Attestation.Object, credential.Attestation.Object) ||
		!bytes.Equal(restored.Attestation.ClientDataHash, credential.Attestation.ClientDataHash) ||
		restored.Attestation.PublicKeyAlgorithm != -7 {
		t.Fatalf("attestation lost: %+v", restored.Attestation)
	}
	if restored.Extensions.RK == nil || *restored.Extensions.RK {
		t.Fatalf("extensions lost: %+v", restored.Extensions)
	}

	// A credential without extension results/attestation decodes cleanly too.
	minimal := wa.Credential{ID: []byte{9}, PublicKey: []byte{8}, Flags: wa.NewCredentialFlags(protocol.FlagUserPresent)}
	minimalColumns, err := newCredentialColumns(uuid.New(), adminID, testRPID, &minimal, "")
	if err != nil {
		t.Fatalf("newCredentialColumns(minimal): %v", err)
	}
	if _, err := minimalColumns.record(); err != nil {
		t.Fatalf("record(minimal): %v", err)
	}
}

func TestSessionDataRoundTripKeepsBeginState(t *testing.T) {
	session := wa.SessionData{
		Challenge:            "Y2hhbGxlbmdlLWJ5dGVzLWZvci10ZXN0aW5n",
		RelyingPartyID:       testRPID,
		Origin:               testOrigin,
		UserID:               testAdminUser().handle,
		AllowedCredentialIDs: [][]byte{{1, 2, 3}},
		Expires:              time.Now().Add(5 * time.Minute).Truncate(time.Millisecond),
		UserVerification:     protocol.VerificationRequired,
		Extensions:           protocol.SessionExtensions{Requested: []string{protocol.ExtensionCredProps}},
	}
	raw, err := json.Marshal(session)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var restored wa.SessionData
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if restored.Challenge != session.Challenge ||
		restored.RelyingPartyID != testRPID ||
		restored.Origin != testOrigin ||
		!bytes.Equal(restored.UserID, session.UserID) ||
		restored.UserVerification != protocol.VerificationRequired ||
		!containsString(restored.Extensions.Requested, protocol.ExtensionCredProps) ||
		!restored.Expires.Equal(session.Expires) {
		t.Fatalf("session round trip mismatch: %+v", restored)
	}
}

func TestNormalizeLabel(t *testing.T) {
	if got := NormalizeLabel("   "); got != "" {
		t.Fatalf("blank label = %q, want empty", got)
	}
	if got := NormalizeLabel("  Work key "); got != "Work key" {
		t.Fatalf("label = %q, want trimmed", got)
	}
	long := strings.Repeat("ä", maxCredentialLabel+20)
	if got := NormalizeLabel(long); len([]rune(got)) != maxCredentialLabel {
		t.Fatalf("long label rune length = %d, want %d", len([]rune(got)), maxCredentialLabel)
	}
}

func TestChallengeHash(t *testing.T) {
	first := challengeHash("challenge-one")
	second := challengeHash("challenge-two")
	if first == second || len(first) != 64 {
		t.Fatalf("challenge hashes not distinct 64-char hex: %q %q", first, second)
	}
	if challengeHash("challenge-one") != first {
		t.Fatal("challenge hash is not deterministic")
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return encoded
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
