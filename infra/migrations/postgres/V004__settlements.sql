-- =============================================================================
-- V004__settlements.sql — Single-Fire Settlement Guard Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS settlements (
    contract_id VARCHAR(255) PRIMARY KEY REFERENCES contracts(contract_id) ON DELETE CASCADE,
    status      VARCHAR(50)  NOT NULL,
    transfer_id VARCHAR(255) NULL,
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  DEFAULT NOW()
);
