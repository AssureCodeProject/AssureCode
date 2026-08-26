-- =============================================================================
-- V017__github_oauth.sql — token storage for freelancer GitHub OAuth login
--
-- auth_providers (V011) already models "which external identity is this user"
-- but has nowhere to hold the access token that identity's provider issued —
-- it was scaffolding for federated *login*, not for the platform later acting
-- on the user's behalf (listing their repos, registering a webhook). Adding
-- that here rather than a new table: one row per (user, provider) already
-- exists and is exactly the right granularity for one token per connection.
--
-- pgp_sym_encrypt/_decrypt (pgcrypto) rather than a new dependency or an
-- external KMS: it is bundled with Postgres, needs only an app-held symmetric
-- key (GITHUB_TOKEN_ENCRYPTION_KEY), and every other secret in this project
-- already lives as a deploy-time config value the same way that key will.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE auth_providers
    ADD COLUMN IF NOT EXISTS access_token_encrypted BYTEA NULL,
    ADD COLUMN IF NOT EXISTS token_scopes TEXT NULL,
    ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ NOT NULL DEFAULT now();
