-- Passwordless passkey sign-in.
--
-- A passwordless ceremony starts before any account is known: the browser's
-- account picker selects a discoverable credential, and the account is only
-- resolved from the returned user handle at finish time. Such a challenge row
-- therefore has no admin_id yet (it is claimed by id + ceremony-cookie binding
-- and resolved during validation), and it needs its own purpose.
--
-- Idempotent like every migration: the runner executes all files on each boot.

ALTER TABLE webauthn_challenges ALTER COLUMN admin_id DROP NOT NULL;

-- The original table was created with an inline CHECK constraint whose
-- generated name is webauthn_challenges_purpose_check. Drop and re-add it with
-- the extended value set; the DO block makes a re-run a no-op even if the
-- constraint is already the extended one.
DO $$
BEGIN
    ALTER TABLE webauthn_challenges DROP CONSTRAINT IF EXISTS webauthn_challenges_purpose_check;
    ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_purpose_check
        CHECK (purpose IN ('login', 'enroll', 'stepup', 'passwordless'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
