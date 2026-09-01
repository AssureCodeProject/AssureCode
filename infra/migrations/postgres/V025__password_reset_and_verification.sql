-- =============================================================================
-- V025__password_reset_and_verification.sql — email verification, password
-- reset, and password-change-timestamp support.
--
-- Password hashing itself (argon2id via @node-rs/argon2) is already correct
-- and untouched by this migration; this only adds what was previously
-- missing entirely: a record of whether/when an email was verified, when a
-- password was last voluntarily changed, and single-use tokens for both the
-- email-verification and password-reset flows.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ NULL;

-- Canonicalize existing emails (trim + lowercase) before any new code starts
-- relying on that being the row's actual stored form. Idempotent and,
-- against this project's seeded data, a no-op -- every seeded email is
-- already lowercase. If this ever throws a unique-violation, two existing
-- rows differ only by case/whitespace and must be reconciled by hand before
-- this migration can apply; that is a real data problem to fix, not
-- something this migration should paper over automatically.
UPDATE users SET email = LOWER(TRIM(email)) WHERE email <> LOWER(TRIM(email));

-- One row per issued token, for either flow. A `type` discriminator on a
-- single table rather than two near-identical tables mirrors how
-- security_audit_logs already carries several kinds of event under one
-- shape (an `action` column) rather than a table per action.
--
-- token_hash is the PRIMARY KEY and stores sha256(raw token), never the raw
-- token itself -- exactly the same idiom user_sessions.token_hash already
-- uses for session tokens (V011). The raw token exists only in the email
-- sent to the user and in the URL the browser briefly holds; a leaked
-- database dump reveals nothing usable.
CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT        PRIMARY KEY,
    user_id    TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    type       TEXT        NOT NULL CHECK (type IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET')),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backs both "does this user already have a live token of this type"
-- (forgot-password invalidates a prior unused one before issuing a new one)
-- and any future cleanup sweep of expired/used rows.
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_type ON auth_tokens(user_id, type, used_at);
