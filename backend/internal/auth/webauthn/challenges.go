package webauthn

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	wa "github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// One-shot WebAuthn ceremony state (webauthn_challenges, migration 028).
//
// The library's *webauthn.SessionData is persisted VERBATIM as JSONB: it
// records the challenge, RP ID, bound origin, allowed credentials, requested
// UV policy and the exact set of extensions requested at begin. Rebuilding it
// by hand at finish silently drops the extension record and rejects legitimate
// client outputs, so the stored bytes are the source of truth.
//
// Every challenge is bound to exactly one browser credential: the sha256 hex
// of the cookie token that authorized the ceremony (the pending-login cookie
// for login/enrollment, the session cookie for step-up and self-service
// enrollment). The claim is a single atomic UPDATE ... RETURNING, so a
// replayed or cross-browser response can never be validated twice.

const (
	// PurposeLogin is a pending-login second-factor assertion.
	PurposeLogin = "login"
	// PurposeEnroll is a registration ceremony started from a pending
	// enrollment (forced first factor) or from a signed-in profile.
	PurposeEnroll = "enroll"
	// PurposeStepUp is an assertion that unlocks a sensitive action.
	PurposeStepUp = "stepup"
	// PurposePasswordless is a discoverable-credential sign-in: no account is
	// known when the ceremony begins, so the row has admin_id NULL and the
	// account is resolved from the assertion's user handle at finish.
	PurposePasswordless = "passwordless"

	// challengeTTL bounds how long a begun ceremony may be finished. The
	// library's configured ceremony timeout is also five minutes; the
	// effective expiry is the earlier of the two.
	challengeTTL = 5 * time.Minute
	// maxOutstandingChallenges caps live ceremonies per (admin, purpose) so a
	// browser retry loop cannot accumulate unbounded state.
	maxOutstandingChallenges = 3
	// libraryVersion records which library produced session_data, so a future
	// upgrade can reason about (and clean up) older ceremonies.
	libraryVersion = "github.com/go-webauthn/webauthn v0.18.2"
)

var (
	// ErrChallengeNotFound is returned when a challenge is unknown, expired,
	// already consumed, or bound to a different browser credential.
	ErrChallengeNotFound = errors.New("webauthn challenge not found or already used")
	// ErrChallengeUnbound is returned when a caller would create a challenge
	// with no browser binding at all (a programming error: never claimable
	// would be safer, but such rows should not exist).
	ErrChallengeUnbound = errors.New("webauthn challenge requires a session binding")
)

// Challenge is one claimed (or being claimed) ceremony row.
type Challenge struct {
	ID             uuid.UUID
	Purpose        string
	AdminID        uuid.UUID
	SessionBinding string
	RPID           string
	Origin         string
	SessionData    wa.SessionData
	CreatedAt      time.Time
	ExpiresAt      time.Time
}

// challengeHash hashes the ceremony challenge for the unique index. The
// challenge itself is a URL-safe base64 string in SessionData; hashing keeps
// it out of logs/backups in clear form and gives a fixed-width key.
func challengeHash(challenge string) string {
	sum := sha256.Sum256([]byte(challenge))
	return hex.EncodeToString(sum[:])
}

// validPurpose reports whether purpose is one of the allowed ceremony values.
func validPurpose(purpose string) bool {
	switch purpose {
	case PurposeLogin, PurposeEnroll, PurposeStepUp, PurposePasswordless:
		return true
	}
	return false
}

// CreateChallenge persists a begun ceremony and returns its row id and expiry.
// Stale (consumed/expired) rows and surplus live ceremonies for the same
// (admin, purpose) are pruned first, keeping at most maxOutstandingChallenges.
func CreateChallenge(ctx context.Context, pool *pgxpool.Pool, purpose string, adminID uuid.UUID, sessionBinding, origin string, session *wa.SessionData) (uuid.UUID, time.Time, error) {
	if !validPurpose(purpose) {
		return uuid.Nil, time.Time{}, fmt.Errorf("invalid challenge purpose %q", purpose)
	}
	if session == nil || session.Challenge == "" {
		return uuid.Nil, time.Time{}, errors.New("challenge session data is empty")
	}
	if sessionBinding == "" {
		return uuid.Nil, time.Time{}, ErrChallengeUnbound
	}

	sessionJSON, err := json.Marshal(session)
	if err != nil {
		return uuid.Nil, time.Time{}, fmt.Errorf("marshal session data: %w", err)
	}

	expiresAt := time.Now().Add(challengeTTL)
	if !session.Expires.IsZero() && session.Expires.Before(expiresAt) {
		expiresAt = session.Expires
	}
	rpID := session.GetRelyingPartyID(Current().RPID)
	if origin == "" {
		origin = session.Origin
	}

	// Prune stale rows, then cap outstanding ceremonies. Best effort: a
	// cleanup failure must not block a login, the TTL still bounds the rows.
	//
	// The prune is scoped to THIS RP ID on purpose: the TOTP enrollment flow
	// stores its pending secret in a purpose='enroll' row (rp_id = ''), and a
	// forced-enrollment user may bounce between the TOTP and passkey offers.
	// Without the scope, beginning several passkey ceremonies could evict the
	// TOTP ceremony the user is about to finish.
	_, _ = pool.Exec(ctx, `
		DELETE FROM webauthn_challenges
		WHERE admin_id = $1 AND purpose = $2 AND rp_id = $3
		  AND (consumed_at IS NOT NULL OR expires_at <= now())
	`, adminID, purpose, rpID)
	_, _ = pool.Exec(ctx, `
		DELETE FROM webauthn_challenges
		WHERE admin_id = $1 AND purpose = $2 AND rp_id = $3
		  AND consumed_at IS NULL AND expires_at > now()
		  AND id NOT IN (
			SELECT id FROM webauthn_challenges
			WHERE admin_id = $1 AND purpose = $2 AND rp_id = $3
			  AND consumed_at IS NULL AND expires_at > now()
			ORDER BY created_at DESC
			LIMIT $4
		  )
	`, adminID, purpose, rpID, maxOutstandingChallenges)

	var id uuid.UUID
	err = pool.QueryRow(ctx, `
		INSERT INTO webauthn_challenges (
			purpose, admin_id, session_binding, rp_id, origin,
			challenge_hash, session_data, lib_version, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id
	`, purpose, adminID, sessionBinding, rpID, origin,
		challengeHash(session.Challenge), sessionJSON, libraryVersion, expiresAt,
	).Scan(&id)
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	return id, expiresAt, nil
}

// ClaimChallenge atomically consumes a ceremony row. The exact WHERE clause is
// the security boundary: id + owner + browser binding + purpose must all match
// the row, it must not have been consumed before, and it must not be expired.
// A replay, a moved cookie between browsers/logins, or a challenge used for a
// different ceremony purpose therefore updates zero rows.
func ClaimChallenge(ctx context.Context, pool *pgxpool.Pool, id, adminID uuid.UUID, sessionBinding, purpose string) (Challenge, error) {
	var (
		challenge   Challenge
		sessionJSON []byte
	)
	err := pool.QueryRow(ctx, `
		UPDATE webauthn_challenges
		SET consumed_at = now()
		WHERE id = $1 AND admin_id = $2 AND session_binding = $3 AND purpose = $4
		  AND consumed_at IS NULL AND expires_at > now()
		RETURNING purpose, admin_id, session_binding, rp_id, origin, session_data, created_at, expires_at
	`, id, adminID, sessionBinding, purpose).Scan(
		&challenge.Purpose, &challenge.AdminID, &challenge.SessionBinding,
		&challenge.RPID, &challenge.Origin, &sessionJSON,
		&challenge.CreatedAt, &challenge.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Challenge{}, ErrChallengeNotFound
	}
	if err != nil {
		return Challenge{}, err
	}
	challenge.ID = id
	if err := json.Unmarshal(sessionJSON, &challenge.SessionData); err != nil {
		return Challenge{}, fmt.Errorf("decode session data: %w", err)
	}
	return challenge, nil
}

// CreatePasswordlessChallenge persists a begun discoverable-credential sign-in
// ceremony. Unlike CreateChallenge there is no admin yet, so admin_id is NULL
// and ownership can only be proven at finish by the assertion's user handle.
// The row is still bound to the beginning browser by session_binding, which is
// the only thing that makes the challenge claimable.
func CreatePasswordlessChallenge(ctx context.Context, pool *pgxpool.Pool, sessionBinding, origin string, session *wa.SessionData) (uuid.UUID, time.Time, error) {
	if session == nil || session.Challenge == "" {
		return uuid.Nil, time.Time{}, errors.New("challenge session data is empty")
	}
	if sessionBinding == "" {
		return uuid.Nil, time.Time{}, ErrChallengeUnbound
	}

	sessionJSON, err := json.Marshal(session)
	if err != nil {
		return uuid.Nil, time.Time{}, fmt.Errorf("marshal session data: %w", err)
	}

	expiresAt := time.Now().Add(challengeTTL)
	if !session.Expires.IsZero() && session.Expires.Before(expiresAt) {
		expiresAt = session.Expires
	}
	rpID := session.GetRelyingPartyID(Current().RPID)
	if origin == "" {
		origin = session.Origin
	}

	// Best-effort cleanup of finished/expired passwordless rows for this RP.
	// They have no owner to scope by, so the TTL and this prune are what keep
	// the table bounded. A cleanup failure must not block a sign-in attempt.
	_, _ = pool.Exec(ctx, `
		DELETE FROM webauthn_challenges
		WHERE purpose = $1 AND rp_id = $2 AND admin_id IS NULL
		  AND (consumed_at IS NOT NULL OR expires_at <= now())
	`, PurposePasswordless, rpID)

	var id uuid.UUID
	err = pool.QueryRow(ctx, `
		INSERT INTO webauthn_challenges (
			purpose, admin_id, session_binding, rp_id, origin,
			challenge_hash, session_data, lib_version, expires_at
		) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id
	`, PurposePasswordless, sessionBinding, rpID, origin,
		challengeHash(session.Challenge), sessionJSON, libraryVersion, expiresAt,
	).Scan(&id)
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	return id, expiresAt, nil
}

// ClaimPasswordlessChallenge atomically consumes a begun passwordless ceremony.
// The WHERE clause is the security boundary: the row id, the beginning
// browser's binding and the passwordless purpose must all match, and the
// ceremony must still be live. It deliberately has no admin filter because the
// account is only known after the assertion has been validated.
func ClaimPasswordlessChallenge(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID, sessionBinding string) (Challenge, error) {
	if sessionBinding == "" {
		return Challenge{}, ErrChallengeUnbound
	}

	var (
		challenge   Challenge
		sessionJSON []byte
	)
	err := pool.QueryRow(ctx, `
		UPDATE webauthn_challenges
		SET consumed_at = now()
		WHERE id = $1 AND session_binding = $2 AND purpose = $3
		  AND consumed_at IS NULL AND expires_at > now()
		RETURNING purpose, COALESCE(admin_id, '00000000-0000-0000-0000-000000000000'::uuid),
		          session_binding, rp_id, origin, session_data, created_at, expires_at
	`, id, sessionBinding, PurposePasswordless).Scan(
		&challenge.Purpose, &challenge.AdminID, &challenge.SessionBinding,
		&challenge.RPID, &challenge.Origin, &sessionJSON,
		&challenge.CreatedAt, &challenge.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Challenge{}, ErrChallengeNotFound
	}
	if err != nil {
		return Challenge{}, err
	}
	challenge.ID = id
	if err := json.Unmarshal(sessionJSON, &challenge.SessionData); err != nil {
		return Challenge{}, fmt.Errorf("decode session data: %w", err)
	}
	return challenge, nil
}
