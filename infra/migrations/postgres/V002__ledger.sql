-- =============================================================================
-- V002__ledger.sql — Merkle ledger table + append_ledger stored procedure
--
-- The stored procedure is the single source of truth for SHA-256 hashing.
-- Both Node and Python services call this to append entries, guaranteeing
-- chain consistency even with concurrent writers.
--
-- Hash formula:
--   current_hash = SHA256(encode(to_jsonb(payload) || previous_hash::text, 'UTF8'))
--
-- The payload JSONB has its keys sorted (pg sorts keys in to_jsonb output),
-- ensuring deterministic hashing.
-- =============================================================================

-- ── Merkle Ledger ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merkle_ledger (
    ledger_id    BIGSERIAL   PRIMARY KEY,
    contract_id  TEXT        NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
    action_type  TEXT        NOT NULL,
    payload      JSONB       NOT NULL,
    previous_hash TEXT       NOT NULL DEFAULT 'GENESIS',
    current_hash  TEXT       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merkle_ledger_contract
    ON merkle_ledger(contract_id, ledger_id);

-- ── append_ledger stored procedure ──────────────────────────────
-- Arguments:
--   p_contract_id  TEXT   — FK to contracts
--   p_action_type  TEXT   — e.g. GENESIS, CONTRACT_LOCKED, CODE_PUSH, AUDIT_PASSED, INVOICE
--   p_payload      JSONB  — the structured data being anchored
--
-- Returns: the newly inserted row as a JSON object.
--
-- Concurrency: Uses pg_advisory_lock to serialise appends per contract,
-- preventing hash-chain forks under concurrent writes.
-- =============================================================================
CREATE OR REPLACE FUNCTION append_ledger(
    p_contract_id TEXT,
    p_action_type TEXT,
    p_payload     JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_previous_hash TEXT;
    v_current_hash  TEXT;
    v_row           merkle_ledger;
BEGIN
    -- Serialise concurrent appends for the same contract
    PERFORM pg_advisory_lock(hashtext(p_contract_id));

    -- Get the current tail hash for this contract
    SELECT current_hash INTO v_previous_hash
      FROM merkle_ledger
     WHERE contract_id = p_contract_id
     ORDER BY ledger_id DESC
     LIMIT 1;

    -- If no rows exist, start the chain with 'GENESIS'
    IF v_previous_hash IS NULL THEN
        v_previous_hash := 'GENESIS';
    END IF;

    -- Compute deterministic SHA-256:
    --   payload is serialised as sorted-key JSONB, concatenated with previous_hash
    v_current_hash := encode(
        sha256(
            convert_to(
                (SELECT to_jsonb(p_payload) || to_jsonb(v_previous_hash))::text,
                'UTF8'
            )
        ),
        'hex'
    );

    -- Insert the new ledger row
    INSERT INTO merkle_ledger (contract_id, action_type, payload, previous_hash, current_hash)
    VALUES (p_contract_id, p_action_type, p_payload, v_previous_hash, v_current_hash)
    RETURNING * INTO v_row;

    -- Release the advisory lock
    PERFORM pg_advisory_unlock(hashtext(p_contract_id));

    -- Return the row as JSONB for the caller
    RETURN to_jsonb(v_row);
END;
$$;
