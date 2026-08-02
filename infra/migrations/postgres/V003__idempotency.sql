-- =============================================================================
-- V003__idempotency.sql — Gateway Idempotency Keys Persistence
-- =============================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key           VARCHAR(255) PRIMARY KEY,
    contract_id   VARCHAR(255) NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
    response_json JSONB        NOT NULL,
    status_code   INT          NOT NULL,
    created_at    TIMESTAMPTZ  DEFAULT NOW(),
    expires_at    TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_contract ON idempotency_keys(contract_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);
