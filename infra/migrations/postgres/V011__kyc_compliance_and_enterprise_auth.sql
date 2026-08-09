-- =============================================================================
-- V011__kyc_compliance_and_enterprise_auth.sql — Enterprise Auth, RBAC & KYC Compliance
-- =============================================================================

-- Add MFA & KYC status tracking to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (kyc_status IN ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'));

-- ── KYC & Identity Verification ─────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_verifications (
    verification_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    id_type                TEXT        NOT NULL CHECK (id_type IN ('PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID')),
    id_status              TEXT        NOT NULL DEFAULT 'PENDING' CHECK (id_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    document_hash          TEXT        NOT NULL,
    aml_sanctions_checked  BOOLEAN     NOT NULL DEFAULT FALSE,
    verified_at            TIMESTAMPTZ NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc_verifications(user_id);

-- ── Enterprise Sessions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
    session_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL,
    user_agent  TEXT        NULL,
    ip_address  TEXT        NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);

-- ── Federated OAuth2 / OIDC Providers ───────────────────────────
CREATE TABLE IF NOT EXISTS auth_providers (
    provider_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    provider_type    TEXT        NOT NULL CHECK (provider_type IN ('GOOGLE', 'GITHUB', 'SAML', 'OIDC')),
    provider_user_id TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_provider_user UNIQUE (provider_type, provider_user_id)
);

-- ── Multi-Factor Authentication (MFA) ───────────────────────────
CREATE TABLE IF NOT EXISTS mfa_credentials (
    credential_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    mfa_type      TEXT        NOT NULL DEFAULT 'TOTP',
    secret_key    TEXT        NOT NULL,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Security Audit Logs ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_audit_logs (
    log_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    TEXT        NULL,
    action     TEXT        NOT NULL,
    resource   TEXT        NOT NULL,
    ip_address TEXT        NULL,
    status     TEXT        NOT NULL DEFAULT 'SUCCESS',
    timestamp  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_audit_user ON security_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_time ON security_audit_logs(timestamp ASC);
