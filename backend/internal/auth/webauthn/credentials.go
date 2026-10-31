package webauthn

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Persistence mapping between the go-webauthn library's Credential record and
// the webauthn_credentials table (migration 028).
//
// The library's storage contract is exact: attestation and extensions are
// persisted as opaque JSON so future library versions can re-verify the
// credential, and the RAW protocol.AuthenticatorFlags octet is stored in the
// flags SMALLINT. The booleans (user_present, backup_eligible, ...) are
// derived copies for the UI/audit queries only; the raw octet is what the
// library needs restored via webauthn.NewCredentialFlags. Losing that octet
// breaks the backup-eligible consistency check performed on every login.

const (
	// userHandleBytes is the size of the opaque WebAuthn user handle. It is a
	// random 32-byte value, never the admin UUID, and stays stable per
	// (rp_id, admin_id) for the account's lifetime.
	userHandleBytes = 32
	// maxCredentialLabel bounds the user-supplied passkey label.
	maxCredentialLabel = 64
)

var (
	// ErrCredentialExists is returned when the same authenticator is enrolled
	// twice for the same RP ID (unique (rp_id, credential_id)).
	ErrCredentialExists = errors.New("passkey already registered")
	// ErrCredentialNotFound is returned by lookups/updates that matched no row.
	ErrCredentialNotFound = errors.New("passkey not found")
)

// CredentialRecord is a stored passkey: the library credential plus the row
// identity and UI metadata the console needs.
type CredentialRecord struct {
	ID         uuid.UUID
	AdminID    uuid.UUID
	RPID       string
	Credential wa.Credential
	Label      string
	CreatedAt  time.Time
	LastUsedAt *time.Time
}

// credentialColumns is the flat representation of one webauthn_credentials
// row. Keeping the mapping in a struct (rather than only in SQL scan calls)
// makes the round trip unit-testable without a database.
type credentialColumns struct {
	ID                uuid.UUID
	AdminID           uuid.UUID
	RPID              string
	CredentialID      []byte
	PublicKey         []byte
	AAGUID            []byte
	SignCount         int64
	CloneWarning      bool
	Attachment        string
	Transports        string
	Flags             int16
	UserPresent       bool
	UserVerified      bool
	BackupEligible    bool
	BackupState       bool
	AttestationType   string
	AttestationFormat string
	Attestation       []byte
	Extensions        []byte
	Label             string
	CreatedAt         time.Time
	LastUsedAt        *time.Time
}

const credentialSelectColumns = "id, admin_id, rp_id, credential_id, public_key, aaguid, sign_count, clone_warning, attachment, transports, flags, user_present, user_verified, backup_eligible, backup_state, attestation_type, attestation_format, attestation, extensions, label, created_at, last_used_at"

// scanner is the subset of pgx.Row/pgx.Rows used by the mapping.
type scanner interface {
	Scan(dest ...any) error
}

// newCredentialColumns projects a freshly validated library credential into
// its column values. The row ID and created_at are assigned by the database;
// callers that need them use InsertCredential.
func newCredentialColumns(id, adminID uuid.UUID, rpID string, cred *wa.Credential, label string) (credentialColumns, error) {
	if cred == nil {
		return credentialColumns{}, errors.New("nil credential")
	}
	attestation, err := json.Marshal(cred.Attestation)
	if err != nil {
		return credentialColumns{}, fmt.Errorf("marshal attestation: %w", err)
	}
	extensions, err := json.Marshal(cred.Extensions)
	if err != nil {
		return credentialColumns{}, fmt.Errorf("marshal extensions: %w", err)
	}

	transports := make([]string, len(cred.Transport))
	for i, transport := range cred.Transport {
		transports[i] = string(transport)
	}

	columns := credentialColumns{
		ID:                id,
		AdminID:           adminID,
		RPID:              rpID,
		CredentialID:      append([]byte(nil), cred.ID...),
		PublicKey:         append([]byte(nil), cred.PublicKey...),
		AAGUID:            append([]byte(nil), cred.Authenticator.AAGUID...),
		SignCount:         int64(cred.Authenticator.SignCount),
		CloneWarning:      cred.Authenticator.CloneWarning,
		Attachment:        string(cred.Authenticator.Attachment),
		Transports:        strings.Join(transports, ","),
		Flags:             int16(cred.Flags.ProtocolValue()),
		UserPresent:       cred.Flags.UserPresent,
		UserVerified:      cred.Flags.UserVerified,
		BackupEligible:    cred.Flags.BackupEligible,
		BackupState:       cred.Flags.BackupState,
		AttestationType:   cred.AttestationType,
		AttestationFormat: cred.AttestationFormat,
		Attestation:       attestation,
		Extensions:        extensions,
		Label:             NormalizeLabel(label),
	}
	return columns, nil
}

// record rebuilds the library credential from a stored row. The flags octet
// MUST be restored through webauthn.NewCredentialFlags so the library sees the
// exact protocol flags (including backup eligibility) that the authenticator
// reported at registration.
func (c credentialColumns) record() (CredentialRecord, error) {
	credential := wa.Credential{
		ID:                append([]byte(nil), c.CredentialID...),
		PublicKey:         append([]byte(nil), c.PublicKey...),
		AttestationType:   c.AttestationType,
		AttestationFormat: c.AttestationFormat,
		Transport:         parseTransports(c.Transports),
		Flags:             wa.NewCredentialFlags(protocol.AuthenticatorFlags(uint8(c.Flags))),
		Authenticator: wa.Authenticator{
			AAGUID:       append([]byte(nil), c.AAGUID...),
			SignCount:    uint32(c.SignCount),
			CloneWarning: c.CloneWarning,
			Attachment:   protocol.AuthenticatorAttachment(c.Attachment),
		},
	}
	if len(c.Attestation) > 0 {
		if err := json.Unmarshal(c.Attestation, &credential.Attestation); err != nil {
			return CredentialRecord{}, fmt.Errorf("decode attestation: %w", err)
		}
	}
	if len(c.Extensions) > 0 {
		if err := json.Unmarshal(c.Extensions, &credential.Extensions); err != nil {
			return CredentialRecord{}, fmt.Errorf("decode extensions: %w", err)
		}
	}
	return CredentialRecord{
		ID:         c.ID,
		AdminID:    c.AdminID,
		RPID:       c.RPID,
		Credential: credential,
		Label:      c.Label,
		CreatedAt:  c.CreatedAt,
		LastUsedAt: c.LastUsedAt,
	}, nil
}

func scanCredentialColumns(row scanner) (credentialColumns, error) {
	var c credentialColumns
	err := row.Scan(
		&c.ID, &c.AdminID, &c.RPID, &c.CredentialID, &c.PublicKey, &c.AAGUID,
		&c.SignCount, &c.CloneWarning, &c.Attachment, &c.Transports, &c.Flags,
		&c.UserPresent, &c.UserVerified, &c.BackupEligible, &c.BackupState,
		&c.AttestationType, &c.AttestationFormat, &c.Attestation, &c.Extensions,
		&c.Label, &c.CreatedAt, &c.LastUsedAt,
	)
	return c, err
}

func parseTransports(raw string) []protocol.AuthenticatorTransport {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]protocol.AuthenticatorTransport, 0, len(parts))
	for _, part := range parts {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, protocol.AuthenticatorTransport(p))
		}
	}
	return out
}

// ListCredentials returns every passkey an admin registered under this RP ID.
// Credentials bound to another RP ID (an old console domain) are deliberately
// excluded: they cannot complete a ceremony for the current RP.
func ListCredentials(ctx context.Context, pool *pgxpool.Pool, adminID uuid.UUID, rpID string) ([]CredentialRecord, error) {
	rows, err := pool.Query(ctx, "SELECT "+credentialSelectColumns+
		" FROM webauthn_credentials WHERE admin_id = $1 AND rp_id = $2 ORDER BY created_at ASC", adminID, rpID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []CredentialRecord{}
	for rows.Next() {
		columns, err := scanCredentialColumns(rows)
		if err != nil {
			return nil, err
		}
		rec, err := columns.record()
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// GetCredential loads one admin-owned passkey row by its console ID.
func GetCredential(ctx context.Context, pool *pgxpool.Pool, adminID, id uuid.UUID) (CredentialRecord, error) {
	columns, err := scanCredentialColumns(pool.QueryRow(ctx, "SELECT "+credentialSelectColumns+
		" FROM webauthn_credentials WHERE id = $1 AND admin_id = $2", id, adminID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CredentialRecord{}, ErrCredentialNotFound
	}
	if err != nil {
		return CredentialRecord{}, err
	}
	return columns.record()
}

// InsertCredential persists a validated registration. It returns
// ErrCredentialExists when the authenticator is already registered for the RP.
func InsertCredential(ctx context.Context, pool *pgxpool.Pool, adminID uuid.UUID, rpID string, cred *wa.Credential, label string) (CredentialRecord, error) {
	columns, err := newCredentialColumns(uuid.Nil, adminID, rpID, cred, label)
	if err != nil {
		return CredentialRecord{}, err
	}

	row := pool.QueryRow(ctx, `
		INSERT INTO webauthn_credentials (
			admin_id, rp_id, credential_id, public_key, aaguid, sign_count,
			clone_warning, attachment, transports, flags, user_present,
			user_verified, backup_eligible, backup_state, attestation_type,
			attestation_format, attestation, extensions, label
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
			$15, $16, $17, $18, $19
		)
		RETURNING id, created_at
	`,
		columns.AdminID, columns.RPID, columns.CredentialID, columns.PublicKey,
		nullableBytes(columns.AAGUID), columns.SignCount, columns.CloneWarning,
		columns.Attachment, columns.Transports, columns.Flags, columns.UserPresent,
		columns.UserVerified, columns.BackupEligible, columns.BackupState,
		columns.AttestationType, columns.AttestationFormat, columns.Attestation,
		columns.Extensions, columns.Label,
	)
	if err := row.Scan(&columns.ID, &columns.CreatedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return CredentialRecord{}, ErrCredentialExists
		}
		return CredentialRecord{}, err
	}
	return columns.record()
}

// SaveAfterLogin writes back the sign counter, clone warning and flags after a
// successful assertion (spec §7.2 step 17 and the credential-record update),
// and stamps last_used_at for the UI.
func SaveAfterLogin(ctx context.Context, pool *pgxpool.Pool, rec CredentialRecord) error {
	cred := rec.Credential
	columns, err := newCredentialColumns(rec.ID, rec.AdminID, rec.RPID, &cred, rec.Label)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `
		UPDATE webauthn_credentials
		SET sign_count = $1, clone_warning = $2, flags = $3, user_present = $4,
		    user_verified = $5, backup_eligible = $6, backup_state = $7,
		    last_used_at = now()
		WHERE id = $8 AND admin_id = $9
	`, columns.SignCount, columns.CloneWarning, columns.Flags, columns.UserPresent,
		columns.UserVerified, columns.BackupEligible, columns.BackupState,
		rec.ID, rec.AdminID)
	return err
}

// DeleteCredential removes one admin-owned passkey. It reports whether a row
// was deleted.
func DeleteCredential(ctx context.Context, pool *pgxpool.Pool, adminID, id uuid.UUID) (bool, error) {
	tag, err := pool.Exec(ctx,
		"DELETE FROM webauthn_credentials WHERE id = $1 AND admin_id = $2", id, adminID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// GetOrCreateUserHandle returns the stable opaque WebAuthn user handle for
// (rp_id, admin_id), creating it with 32 crypto/rand bytes on first use. The
// handle is what discoverable credentials resolve to and must never change for
// the account's lifetime under an RP ID.
func GetOrCreateUserHandle(ctx context.Context, pool *pgxpool.Pool, adminID uuid.UUID, rpID string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		handle := make([]byte, userHandleBytes)
		if _, err := rand.Read(handle); err != nil {
			return nil, err
		}
		var stored []byte
		err := pool.QueryRow(ctx, `
			INSERT INTO webauthn_users (admin_id, rp_id, handle)
			VALUES ($1, $2, $3)
			ON CONFLICT (rp_id, admin_id) DO UPDATE SET admin_id = EXCLUDED.admin_id
			RETURNING handle
		`, adminID, rpID, handle).Scan(&stored)
		if err == nil {
			if len(stored) > 0 {
				return stored, nil
			}
			lastErr = errors.New("empty webauthn user handle")
			continue
		}
		// A (rp_id, handle) collision is astronomically unlikely but retrying
		// keeps the helper total; any other error is real.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			lastErr = err
			continue
		}
		return nil, err
	}
	return nil, fmt.Errorf("create webauthn user handle: %w", lastErr)
}

func nullableBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

// NormalizeLabel trims and bounds a user-supplied passkey label. An empty
// label is valid and rendered as a generic "Passkey" by the SPA.
func NormalizeLabel(label string) string {
	trimmed := strings.TrimSpace(label)
	runes := []rune(trimmed)
	if len(runes) > maxCredentialLabel {
		trimmed = string(runes[:maxCredentialLabel])
	}
	return trimmed
}
