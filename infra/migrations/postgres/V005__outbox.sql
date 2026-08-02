-- =============================================================================
-- V005__outbox.sql — Transactional Outbox table + Stored Procedure
-- =============================================================================

CREATE TABLE IF NOT EXISTS outbox (
    outbox_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    topic          VARCHAR(255) NOT NULL,
    payload        JSONB       NOT NULL,
    correlation_id VARCHAR(255) NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at        TIMESTAMPTZ NULL
);

-- Partial index for fast relay polling of unsent events
CREATE INDEX IF NOT EXISTS idx_outbox_unsent 
    ON outbox(created_at ASC) 
    WHERE sent_at IS NULL;

-- Atomic transaction helper procedure combining ledger append + outbox insert
CREATE OR REPLACE FUNCTION append_ledger_and_outbox(
    p_contract_id    TEXT,
    p_action_type    TEXT,
    p_ledger_payload JSONB,
    p_topic          TEXT,
    p_event_payload  JSONB,
    p_correlation_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_ledger_row JSONB;
BEGIN
    -- 1. Append to merkle_ledger with advisory lock
    v_ledger_row := append_ledger(p_contract_id, p_action_type, p_ledger_payload);

    -- 2. Stage event in outbox within the EXACT same transaction
    INSERT INTO outbox (topic, payload, correlation_id)
    VALUES (p_topic, p_event_payload, p_correlation_id);

    RETURN v_ledger_row;
END;
$$;
