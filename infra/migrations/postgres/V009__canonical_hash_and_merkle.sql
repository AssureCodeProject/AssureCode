-- =============================================================================
-- V009__canonical_hash_and_merkle.sql — Phase 8
--
-- Two problems, one migration, because the second depends on the first.
--
-- 1. THE CHAIN HASH WAS NOT REPRODUCIBLE
--
--    V002 hashed `(to_jsonb(payload) || to_jsonb(previous_hash))::text`. The
--    comment above it said this concatenates the payload text with the previous
--    hash. Measured against live PostgreSQL 17.6, it does not: `jsonb || jsonb`
--    where the left side is an object and the right a scalar promotes the
--    object into a one-element array. The hashed string was
--
--        [{"a": 1, "b": 2}, "GENESIS"]
--
--    The TypeScript client hashed `JSON.stringify(payload) + previous_hash`:
--
--        {"b":2,"a":1}GENESIS
--
--    Different structure, different key order, different separators. The two
--    could never agree, so `verifyChain`'s JavaScript path would have reported
--    tampering on every honest chain. It never did — because the SQL path
--    re-derived the hash with the *same* broken expression and so always agreed
--    with itself, making it incapable of detecting a wrong hash at all. A
--    verifier that compares a value against itself is not a verifier.
--
--    The fix is to stop having two serializers. The caller now supplies the
--    canonical bytes (RFC 8785, see packages/ledger-client/src/canonical.ts),
--    the database hashes exactly those bytes, and both are stored. PostgreSQL
--    is never asked to re-serialize the payload, so there is nothing left to
--    disagree about.
--
--    This is not a matter of the database trusting the client with the hash:
--    the client supplies the *message*, which is its own data, and the database
--    still computes the hash and controls the chain linkage. A client cannot
--    choose a hash, only what it is anchoring — which is exactly its privilege.
--
-- 2. THERE WAS NO MERKLE TREE
--
--    The table is named merkle_ledger and the specification claims a Merkle
--    hash chain. What existed was a hash chain, which is a different structure
--    with a different property: it detects tampering, but proving one entry's
--    membership requires replaying every entry. merkle_roots below records a
--    real RFC 6962 tree over each contract's leaves, so a single entry can be
--    proved against a signed root without disclosing the rest of the contract.
--
-- LEGACY ROWS
--
--    The 17 rows written before this migration were hashed with the old
--    expression. They are marked hash_version = 1 and are NOT retroactively
--    verifiable: nothing can recompute them from the JavaScript side, which is
--    the defect being fixed. verifyChain refuses to certify them rather than
--    reporting a pass it cannot justify. They are kept rather than deleted so
--    the history is not silently rewritten.
-- =============================================================================

-- ── Chain rows carry their canonical bytes and a formula version ────────────

ALTER TABLE merkle_ledger
    ADD COLUMN IF NOT EXISTS payload_canonical TEXT NULL,
    ADD COLUMN IF NOT EXISTS hash_version      SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN merkle_ledger.payload_canonical IS
    'The exact RFC 8785 bytes that were hashed. NULL only for pre-V009 rows.';
COMMENT ON COLUMN merkle_ledger.hash_version IS
    '1 = pre-V009 (not reproducible, see V009 header). 2 = canonical bytes.';

-- Divergence between the canonical text and the stored jsonb is made
-- impossible here rather than checked in application code, because an
-- application check can be bypassed by anything else holding a connection.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'merkle_ledger_canonical_matches_payload'
    ) THEN
        ALTER TABLE merkle_ledger
            ADD CONSTRAINT merkle_ledger_canonical_matches_payload
            CHECK (payload_canonical IS NULL OR payload_canonical::jsonb = payload);
    END IF;
END $$;

-- ── Merkle roots ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS merkle_roots (
    contract_id  TEXT        PRIMARY KEY REFERENCES contracts(contract_id) ON DELETE CASCADE,

    root_hash    CHAR(64)    NOT NULL,
    -- The tree covers leaves 1..leaf_count in ledger_id order. Storing both the
    -- count and the highest id means a root can be checked against the chain it
    -- claims to summarise without recomputing it.
    leaf_count   INTEGER     NOT NULL CHECK (leaf_count >= 0),
    max_ledger_id BIGINT     NULL,

    -- FIPS 204 ML-DSA-87 over the root. NULL until signed; a NULL signature is
    -- an unsigned root, never a valid one.
    signature      BYTEA     NULL,
    public_key     BYTEA     NULL,
    signed_at      TIMESTAMPTZ NULL,
    signature_alg  TEXT      NULL,

    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── append_ledger, v2 ───────────────────────────────────────────────────────

-- The old three-argument (TEXT, TEXT, JSONB) form is dropped rather than left
-- in place. Leaving it would mean the broken hash formula remained one
-- overload-resolution away, and a caller that passed jsonb would silently get
-- unverifiable rows again.
DROP FUNCTION IF EXISTS append_ledger(TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION append_ledger(
    p_contract_id       TEXT,
    p_action_type       TEXT,
    p_payload_canonical TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_previous_hash TEXT;
    v_current_hash  TEXT;
    v_row           merkle_ledger;
BEGIN
    IF p_payload_canonical IS NULL OR p_payload_canonical = '' THEN
        RAISE EXCEPTION 'append_ledger requires canonical payload bytes, got NULL or empty';
    END IF;

    PERFORM pg_advisory_lock(hashtext(p_contract_id));

    SELECT current_hash INTO v_previous_hash
      FROM merkle_ledger
     WHERE contract_id = p_contract_id
     ORDER BY ledger_id DESC
     LIMIT 1;

    IF v_previous_hash IS NULL THEN
        v_previous_hash := 'GENESIS';
    END IF;

    -- SHA256( canonical_payload || LF || previous_hash ).
    --
    -- The line feed is a separator, not decoration. Without a delimiter the
    -- pair (payload, prev) is ambiguous: a payload ending in text that looks
    -- like the start of a hash produces the same byte string as a different
    -- payload with a different previous hash. LF cannot occur unescaped inside
    -- RFC 8785 output — the serializer escapes it as \n inside strings and
    -- emits no whitespace between tokens — so the split point is unambiguous.
    v_current_hash := encode(
        sha256(convert_to(p_payload_canonical || E'\n' || v_previous_hash, 'UTF8')),
        'hex'
    );

    INSERT INTO merkle_ledger (
        contract_id, action_type, payload, payload_canonical,
        previous_hash, current_hash, hash_version
    )
    VALUES (
        p_contract_id, p_action_type, p_payload_canonical::jsonb, p_payload_canonical,
        v_previous_hash, v_current_hash, 2
    )
    RETURNING * INTO v_row;

    PERFORM pg_advisory_unlock(hashtext(p_contract_id));

    RETURN to_jsonb(v_row);
END;
$$;

-- ── append_ledger_and_outbox, matching signature ────────────────────────────

DROP FUNCTION IF EXISTS append_ledger_and_outbox(TEXT, TEXT, JSONB, TEXT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION append_ledger_and_outbox(
    p_contract_id       TEXT,
    p_action_type       TEXT,
    p_ledger_canonical  TEXT,
    p_topic             TEXT,
    p_event_payload     JSONB,
    p_correlation_id    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_ledger_row JSONB;
BEGIN
    v_ledger_row := append_ledger(p_contract_id, p_action_type, p_ledger_canonical);

    INSERT INTO outbox (topic, payload, correlation_id)
    VALUES (p_topic, p_event_payload, p_correlation_id);

    RETURN v_ledger_row;
END;
$$;
