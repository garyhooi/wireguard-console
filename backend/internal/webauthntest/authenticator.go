// Package webauthntest provides a small, dependency-free virtual WebAuthn
// authenticator for tests and the e2e suite.
//
// It implements just enough of the client + authenticator side of a WebAuthn
// ceremony to exercise a real relying-party server: ES256 (P-256) key pair,
// "none" attestation with a well-formed attested credential data block,
// ECDSA-DER assertions over authenticatorData || SHA-256(clientDataJSON), and
// the credProps client extension output when the relying party requests it.
//
// The package deliberately imports only crypto/*, encoding/*,
// fxamacker/cbor and go-webauthn/protocol: it must never import the API
// package or the console's storage layer (no import cycles, usable from both
// unit tests and backend/e2e).
package webauthntest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/fxamacker/cbor/v2"
	"github.com/go-webauthn/webauthn/protocol"
)

var b64 = base64.RawURLEncoding

// Authenticator is a software authenticator holding exactly one credential.
//
// UserVerified / BackupEligible / BackupState control the authenticator-data
// flags reported by both ceremonies, so tests can model a platform passkey
// (UV set) or a bare security key (UV clear). SignCount is advanced by every
// assertion to keep the relying party's clone detection honest.
type Authenticator struct {
	// CredentialID is the opaque credential id reported to the relying party.
	CredentialID []byte
	// AAGUID is the authenticator model identifier (zero by default).
	AAGUID [16]byte
	// UserVerified controls the UV flag in the authenticator data.
	UserVerified bool
	// BackupEligible controls the BE flag (synced passkey).
	BackupEligible bool
	// BackupState controls the BS flag. It must never be set while
	// BackupEligible is clear.
	BackupState bool
	// SignCount is the last signature counter value reported.
	SignCount uint32

	mu         sync.Mutex
	privateKey *ecdsa.PrivateKey
}

// New creates a virtual authenticator with a fresh P-256 key pair, a random
// 32-byte credential id, and user verification enabled (the common platform
// passkey).
func New() (*Authenticator, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("webauthntest: generate key: %w", err)
	}
	credentialID := make([]byte, 32)
	if _, err := rand.Read(credentialID); err != nil {
		return nil, fmt.Errorf("webauthntest: generate credential id: %w", err)
	}
	return &Authenticator{
		CredentialID: credentialID,
		UserVerified: true,
		privateKey:   key,
	}, nil
}

// parsedOptions is the small subset of PublicKeyCredentialCreationOptions /
// PublicKeyCredentialRequestOptions the virtual authenticator needs.
type parsedOptions struct {
	Challenge string `json:"challenge"`
	RP        struct {
		ID string `json:"id"`
	} `json:"rp"`
	Extensions struct {
		CredProps bool `json:"credProps"`
	} `json:"extensions"`
}

func parseOptions(options any) (parsedOptions, error) {
	if options == nil {
		return parsedOptions{}, errors.New("webauthntest: options are required")
	}
	raw, err := json.Marshal(options)
	if err != nil {
		return parsedOptions{}, fmt.Errorf("webauthntest: marshal options: %w", err)
	}
	var parsed parsedOptions
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return parsedOptions{}, fmt.Errorf("webauthntest: decode options: %w", err)
	}
	if parsed.Challenge == "" {
		return parsedOptions{}, errors.New("webauthntest: options contain no challenge")
	}
	return parsed, nil
}

// clientDataJSON builds the CollectedClientData the browser would produce.
func clientDataJSON(typ, challenge, origin string) ([]byte, error) {
	payload, err := json.Marshal(map[string]any{
		"type":        typ,
		"challenge":   challenge,
		"origin":      origin,
		"crossOrigin": false,
	})
	if err != nil {
		return nil, fmt.Errorf("webauthntest: marshal client data: %w", err)
	}
	return payload, nil
}

// authenticatorData assembles the authenticator data structure:
// rpIdHash || flags || signCount || attestedCredentialData (registration only).
func authenticatorData(rpID string, flags protocol.AuthenticatorFlags, signCount uint32, attestedCredentialData []byte) []byte {
	rpIDHash := sha256.Sum256([]byte(rpID))
	out := make([]byte, 0, 37+len(attestedCredentialData))
	out = append(out, rpIDHash[:]...)
	out = append(out, byte(flags))
	var counter [4]byte
	binary.BigEndian.PutUint32(counter[:], signCount)
	out = append(out, counter[:]...)
	out = append(out, attestedCredentialData...)
	return out
}

// cosePublicKey encodes the credential public key as a COSE_Key (EC2, ES256,
// P-256). Coordinates are fixed-width 32-byte big-endian per the COSE spec.
func (a *Authenticator) cosePublicKey() ([]byte, error) {
	if a.privateKey == nil {
		return nil, errors.New("webauthntest: authenticator has no key")
	}
	x := make([]byte, 32)
	y := make([]byte, 32)
	a.privateKey.PublicKey.X.FillBytes(x)
	a.privateKey.PublicKey.Y.FillBytes(y)
	key := map[int]any{
		1:  2,  // kty: EC2
		3:  -7, // alg: ES256
		-1: 1,  // crv: P-256
		-2: x,
		-3: y,
	}
	encoded, err := cbor.Marshal(key)
	if err != nil {
		return nil, fmt.Errorf("webauthntest: marshal COSE key: %w", err)
	}
	return encoded, nil
}

// attestedCredentialData builds the AAGUID || credIdLen || credId || COSE key
// block appended to registration authenticator data.
func (a *Authenticator) attestedCredentialData() ([]byte, error) {
	if len(a.CredentialID) == 0 || len(a.CredentialID) > 1023 {
		return nil, fmt.Errorf("webauthntest: credential id length %d is invalid", len(a.CredentialID))
	}
	cose, err := a.cosePublicKey()
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(a.AAGUID)+2+len(a.CredentialID)+len(cose))
	out = append(out, a.AAGUID[:]...)
	var idLength [2]byte
	binary.BigEndian.PutUint16(idLength[:], uint16(len(a.CredentialID)))
	out = append(out, idLength[:]...)
	out = append(out, a.CredentialID...)
	out = append(out, cose...)
	return out, nil
}

// RegistrationResponse builds a RegistrationResponseJSON for the given begin
// options (a *protocol.PublicKeyCredentialCreationOptions, its JSON form, or
// any decoded inner-options object). origin and rpID must match the relying
// party's configured values.
func (a *Authenticator) RegistrationResponse(options any, origin, rpID string) (map[string]any, error) {
	return a.registrationResponse(options, origin, rpID, "")
}

// RegistrationResponseWithChallenge is RegistrationResponse with an overridden
// challenge, for negative tests (wrong/replayed challenge).
func (a *Authenticator) RegistrationResponseWithChallenge(options any, origin, rpID, challenge string) (map[string]any, error) {
	return a.registrationResponse(options, origin, rpID, challenge)
}

func (a *Authenticator) registrationResponse(options any, origin, rpID, challengeOverride string) (map[string]any, error) {
	parsed, err := parseOptions(options)
	if err != nil {
		return nil, err
	}
	challenge := parsed.Challenge
	if challengeOverride != "" {
		challenge = challengeOverride
	}

	flags := protocol.FlagUserPresent | protocol.FlagAttestedCredentialData
	if a.UserVerified {
		flags |= protocol.FlagUserVerified
	}
	if a.BackupEligible {
		flags |= protocol.FlagBackupEligible
	}
	if a.BackupState {
		flags |= protocol.FlagBackupState
	}

	attested, err := a.attestedCredentialData()
	if err != nil {
		return nil, err
	}
	authData := authenticatorData(rpID, flags, 0, attested)

	clientData, err := clientDataJSON("webauthn.create", challenge, origin)
	if err != nil {
		return nil, err
	}

	attestationObject, err := cbor.Marshal(struct {
		Format   string         `cbor:"fmt"`
		AttStmt  map[string]any `cbor:"attStmt"`
		AuthData []byte         `cbor:"authData"`
	}{
		Format:   "none",
		AttStmt:  map[string]any{},
		AuthData: authData,
	})
	if err != nil {
		return nil, fmt.Errorf("webauthntest: marshal attestation object: %w", err)
	}

	clientExtensions := map[string]any{}
	if parsed.Extensions.CredProps {
		clientExtensions["credProps"] = map[string]any{"rk": false}
	}

	encodedID := b64.EncodeToString(a.CredentialID)
	return map[string]any{
		"id":    encodedID,
		"rawId": encodedID,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(clientData),
			"attestationObject": b64.EncodeToString(attestationObject),
			"transports":        []string{"internal"},
		},
		"clientExtensionResults": clientExtensions,
	}, nil
}

// AssertionResponse builds an AuthenticationResponseJSON for the given begin
// options. userHandle may be nil (the common username-first second-factor
// case); pass the relying party's user handle bytes to model a discoverable
// assertion.
func (a *Authenticator) AssertionResponse(options any, origin, rpID string, userHandle []byte) (map[string]any, error) {
	return a.assertionResponse(options, origin, rpID, userHandle, "", false)
}

// AssertionResponseWithChallenge is AssertionResponse with an overridden
// challenge, for negative tests.
func (a *Authenticator) AssertionResponseWithChallenge(options any, origin, rpID string, userHandle []byte, challenge string) (map[string]any, error) {
	return a.assertionResponse(options, origin, rpID, userHandle, challenge, false)
}

// AssertionResponseBadSignature produces a structurally valid assertion signed
// with a key that does not match the registered credential, for negative
// tests.
func (a *Authenticator) AssertionResponseBadSignature(options any, origin, rpID string, userHandle []byte) (map[string]any, error) {
	return a.assertionResponse(options, origin, rpID, userHandle, "", true)
}

func (a *Authenticator) assertionResponse(options any, origin, rpID string, userHandle []byte, challengeOverride string, badSignature bool) (map[string]any, error) {
	parsed, err := parseOptions(options)
	if err != nil {
		return nil, err
	}
	if a.privateKey == nil {
		return nil, errors.New("webauthntest: authenticator has no key")
	}
	challenge := parsed.Challenge
	if challengeOverride != "" {
		challenge = challengeOverride
	}

	a.mu.Lock()
	a.SignCount++
	signCount := a.SignCount
	a.mu.Unlock()

	flags := protocol.FlagUserPresent
	if a.UserVerified {
		flags |= protocol.FlagUserVerified
	}
	if a.BackupEligible {
		flags |= protocol.FlagBackupEligible
	}
	if a.BackupState {
		flags |= protocol.FlagBackupState
	}

	authData := authenticatorData(rpID, flags, signCount, nil)
	clientData, err := clientDataJSON("webauthn.get", challenge, origin)
	if err != nil {
		return nil, err
	}

	key := a.privateKey
	if badSignature {
		key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("webauthntest: generate bad-signature key: %w", err)
		}
	}

	clientDataHash := sha256.Sum256(clientData)
	message := make([]byte, 0, len(authData)+len(clientDataHash))
	message = append(message, authData...)
	message = append(message, clientDataHash[:]...)
	digest := sha256.Sum256(message)

	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		return nil, fmt.Errorf("webauthntest: sign assertion: %w", err)
	}

	response := map[string]any{
		"clientDataJSON":    b64.EncodeToString(clientData),
		"authenticatorData": b64.EncodeToString(authData),
		"signature":         b64.EncodeToString(signature),
	}
	if len(userHandle) > 0 {
		response["userHandle"] = b64.EncodeToString(userHandle)
	}

	encodedID := b64.EncodeToString(a.CredentialID)
	return map[string]any{
		"id":                     encodedID,
		"rawId":                  encodedID,
		"type":                   "public-key",
		"response":               response,
		"clientExtensionResults": map[string]any{},
	}, nil
}
