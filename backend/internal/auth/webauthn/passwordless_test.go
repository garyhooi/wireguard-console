package webauthn

// Unit tests for the passwordless (discoverable credential) login bridge.
//
// They drive the real go-webauthn library and the in-tree virtual
// authenticator, so a pass proves the options/assertion/validation round trip
// (including user-handle resolution and the UV requirement) rather than a mock.

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	authwebauthntest "github.com/wireguard-console/backend/internal/webauthntest"
)

func TestPasswordlessPurposeRegistered(t *testing.T) {
	if !validPurpose(PurposePasswordless) {
		t.Fatal("passwordless is not an accepted ceremony purpose")
	}
}

func TestPasswordlessChallengeRejectsMissingState(t *testing.T) {
	ctx := context.Background()

	if _, _, err := CreatePasswordlessChallenge(ctx, nil, "binding", "", nil); err == nil {
		t.Fatal("expected an error for empty session data")
	}
	if _, _, err := CreatePasswordlessChallenge(ctx, nil, "", "", &wa.SessionData{Challenge: "abc"}); !errors.Is(err, ErrChallengeUnbound) {
		t.Fatalf("missing binding error = %v, want ErrChallengeUnbound", err)
	}
	if _, err := ClaimPasswordlessChallenge(ctx, nil, uuid.New(), ""); !errors.Is(err, ErrChallengeUnbound) {
		t.Fatalf("claim without binding error = %v, want ErrChallengeUnbound", err)
	}
}

func TestBeginDiscoverableLoginOptions(t *testing.T) {
	svc := newTestService(t)

	assertion, session, err := beginDiscoverableLoginOptions(svc)
	if err != nil {
		t.Fatalf("beginDiscoverableLoginOptions: %v", err)
	}
	if len(assertion.Response.AllowedCredentials) != 0 {
		t.Fatalf("discoverable login must not send allowCredentials: %v", assertion.Response.AllowedCredentials)
	}
	if session.UserVerification != protocol.VerificationRequired {
		t.Fatalf("passwordless UV = %q, want required", session.UserVerification)
	}
	if len(session.UserID) != 0 {
		t.Fatalf("passwordless session must not carry a user id: %x", session.UserID)
	}
	if session.Origin != testOrigin {
		t.Fatalf("ceremony origin = %q, want %q", session.Origin, testOrigin)
	}
	if session.Challenge == "" {
		t.Fatal("passwordless session has no challenge")
	}
	if session.Expires.IsZero() {
		t.Fatal("passwordless session has no expiry despite enforced timeouts")
	}
	if assertion.Response.UserVerification != protocol.VerificationRequired {
		t.Fatalf("options UV = %q, want required", assertion.Response.UserVerification)
	}
}

func TestRegistrationRequestsResidentKey(t *testing.T) {
	svc := newTestService(t)

	creation, _, err := beginRegistrationOptions(svc, testAdminUser())
	if err != nil {
		t.Fatalf("beginRegistrationOptions: %v", err)
	}
	selection := creation.Response.AuthenticatorSelection
	if selection.ResidentKey != protocol.ResidentKeyRequirementRequired {
		t.Fatalf("registration residentKey = %q, want required (new passkeys must be discoverable)", selection.ResidentKey)
	}
	if selection.UserVerification != protocol.VerificationPreferred {
		t.Fatalf("registration UV = %q, want preferred", selection.UserVerification)
	}
}

func TestDiscoverableAssertionValidation(t *testing.T) {
	svc := newTestService(t)
	user := testAdminUser()
	authenticator, err := authwebauthntest.New()
	if err != nil {
		t.Fatalf("virtual authenticator: %v", err)
	}
	credential := enrollTestPasskey(t, svc, user, authenticator)
	user.credentials = []wa.Credential{*credential}

	// resolveByHandle models the production DiscoverableUserHandler: the
	// assertion's opaque user handle is the only account identifier available.
	resolveByHandle := func(rawID, userHandle []byte) (wa.User, error) {
		if bytes.Equal(userHandle, user.handle) {
			return user, nil
		}
		return nil, errors.New("unknown credential")
	}

	// newCeremony begins a discoverable ceremony and returns its session plus a
	// virtual-authenticator assertion for it.
	newCeremony := func(t *testing.T) (wa.SessionData, map[string]any) {
		t.Helper()
		assertion, session, err := beginDiscoverableLoginOptions(svc)
		if err != nil {
			t.Fatalf("beginDiscoverableLoginOptions: %v", err)
		}
		response, err := authenticator.AssertionResponse(&assertion.Response, testOrigin, testRPID, user.handle)
		if err != nil {
			t.Fatalf("AssertionResponse: %v", err)
		}
		return *session, response
	}

	t.Run("resolves the admin by user handle", func(t *testing.T) {
		session, response := newCeremony(t)
		validatedUser, validated, err := validateDiscoverableAssertion(svc, session, mustJSON(t, response), resolveByHandle)
		if err != nil {
			t.Fatalf("validateDiscoverableAssertion: %v", err)
		}
		if validatedUser != user {
			t.Fatalf("validated user = %p, want the handler's user %p", validatedUser, user)
		}
		if !bytes.Equal(validated.ID, authenticator.CredentialID) {
			t.Fatalf("validated credential id = %x, want %x", validated.ID, authenticator.CredentialID)
		}
		if validated.Authenticator.SignCount != 1 {
			t.Fatalf("sign count = %d, want 1", validated.Authenticator.SignCount)
		}
	})

	t.Run("unknown user handle is rejected", func(t *testing.T) {
		assertion, session, err := beginDiscoverableLoginOptions(svc)
		if err != nil {
			t.Fatalf("beginDiscoverableLoginOptions: %v", err)
		}
		unknownHandle := make([]byte, 32)
		unknownHandle[0] = 0xff
		response, err := authenticator.AssertionResponse(&assertion.Response, testOrigin, testRPID, unknownHandle)
		if err != nil {
			t.Fatalf("AssertionResponse: %v", err)
		}
		if _, _, err := validateDiscoverableAssertion(svc, *session, mustJSON(t, response), resolveByHandle); err == nil {
			t.Fatal("an assertion with an unknown user handle was accepted")
		}
	})

	t.Run("blank user handle is rejected", func(t *testing.T) {
		assertion, session, err := beginDiscoverableLoginOptions(svc)
		if err != nil {
			t.Fatalf("beginDiscoverableLoginOptions: %v", err)
		}
		response, err := authenticator.AssertionResponse(&assertion.Response, testOrigin, testRPID, nil)
		if err != nil {
			t.Fatalf("AssertionResponse: %v", err)
		}
		if _, _, err := validateDiscoverableAssertion(svc, *session, mustJSON(t, response), resolveByHandle); err == nil {
			t.Fatal("an assertion without a user handle was accepted")
		}
	})

	t.Run("wrong challenge is rejected", func(t *testing.T) {
		assertion, session, err := beginDiscoverableLoginOptions(svc)
		if err != nil {
			t.Fatalf("beginDiscoverableLoginOptions: %v", err)
		}
		response, err := authenticator.AssertionResponseWithChallenge(&assertion.Response, testOrigin, testRPID, user.handle,
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
		if err != nil {
			t.Fatalf("AssertionResponseWithChallenge: %v", err)
		}
		if _, _, err := validateDiscoverableAssertion(svc, *session, mustJSON(t, response), resolveByHandle); err == nil {
			t.Fatal("an assertion for a different challenge was accepted")
		}
	})

	t.Run("wrong origin is rejected", func(t *testing.T) {
		assertion, session, err := beginDiscoverableLoginOptions(svc)
		if err != nil {
			t.Fatalf("beginDiscoverableLoginOptions: %v", err)
		}
		response, err := authenticator.AssertionResponse(&assertion.Response, "https://evil.example.com", testRPID, user.handle)
		if err != nil {
			t.Fatalf("AssertionResponse: %v", err)
		}
		if _, _, err := validateDiscoverableAssertion(svc, *session, mustJSON(t, response), resolveByHandle); err == nil {
			t.Fatal("an assertion collected at another origin was accepted")
		}
	})

	t.Run("bad signature is rejected", func(t *testing.T) {
		assertion, session, err := beginDiscoverableLoginOptions(svc)
		if err != nil {
			t.Fatalf("beginDiscoverableLoginOptions: %v", err)
		}
		response, err := authenticator.AssertionResponseBadSignature(&assertion.Response, testOrigin, testRPID, user.handle)
		if err != nil {
			t.Fatalf("AssertionResponseBadSignature: %v", err)
		}
		if _, _, err := validateDiscoverableAssertion(svc, *session, mustJSON(t, response), resolveByHandle); err == nil {
			t.Fatal("an assertion with a bad signature was accepted")
		}
	})

	t.Run("user verification is required", func(t *testing.T) {
		assertion, session, err := beginDiscoverableLoginOptions(svc)
		if err != nil {
			t.Fatalf("beginDiscoverableLoginOptions: %v", err)
		}
		authenticator.UserVerified = false
		defer func() { authenticator.UserVerified = true }()
		response, err := authenticator.AssertionResponse(&assertion.Response, testOrigin, testRPID, user.handle)
		if err != nil {
			t.Fatalf("AssertionResponse: %v", err)
		}
		if _, _, err := validateDiscoverableAssertion(svc, *session, mustJSON(t, response), resolveByHandle); err == nil {
			t.Fatal("a presence-only assertion was accepted for passwordless sign-in")
		}
	})

	t.Run("credential not owned by the resolved admin is rejected", func(t *testing.T) {
		assertion, session, err := beginDiscoverableLoginOptions(svc)
		if err != nil {
			t.Fatalf("beginDiscoverableLoginOptions: %v", err)
		}
		other, err := authwebauthntest.New()
		if err != nil {
			t.Fatalf("virtual authenticator: %v", err)
		}
		response, err := other.AssertionResponse(&assertion.Response, testOrigin, testRPID, user.handle)
		if err != nil {
			t.Fatalf("AssertionResponse: %v", err)
		}
		if _, _, err := validateDiscoverableAssertion(svc, *session, mustJSON(t, response), resolveByHandle); err == nil {
			t.Fatal("a credential the resolved admin does not own was accepted")
		}
	})
}
