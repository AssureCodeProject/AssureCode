-- =============================================================================
-- V008__oracle_state.sql — Phase 5: durable oracle state and scope decision log
--
-- Two tables, both filling gaps that made Objective 4 unverifiable:
--
--   oracle_state  The settlement worker held its four oracle signals in a
--                 process-local `Map`. Every signal was lost on restart, and
--                 with more than one worker each replica saw a different subset
--                 of events — so whether a contract settled depended on which
--                 process happened to receive which message. Oracle state is
--                 contract state, not process state.
--
--   scope_checks  Scope decisions were computed, returned, and then discarded.
--                 The trust score's fourth term needs a real adherence figure,
--                 and a scope decision that leaves no record cannot support
--                 Objective 3's auditability claim either.
-- =============================================================================

CREATE TABLE IF NOT EXISTS oracle_state (
    contract_id     TEXT         PRIMARY KEY REFERENCES contracts(contract_id) ON DELETE CASCADE,

    -- Three of the four signals are set by the audit event that establishes
    -- them. The fourth, scope, is deliberately NOT stored here: it is derived
    -- from scope_checks at evaluation time.
    --
    -- The old in-memory oracle set `scopePassed = true` on any allowed message
    -- and never cleared it, so a contract with one in-scope message and fifty
    -- rejected ones satisfied the scope signal permanently. Deriving the signal
    -- from the decision log means it cannot drift from the decisions it claims
    -- to summarise, and it cannot be latched open by a single early message.
    ast_passed      BOOLEAN      NOT NULL DEFAULT FALSE,
    tests_passed    BOOLEAN      NOT NULL DEFAULT FALSE,
    security_passed BOOLEAN      NOT NULL DEFAULT FALSE,

    -- Objective 4's gate is `trust_score >= 85 AND critical_vulns = 0`. Both are
    -- NULL until an XAI_SCORED event arrives; NULL means "not yet scored", which
    -- is distinct from "scored zero" and must never be read as a passing value.
    trust_score     NUMERIC(5,2) NULL CHECK (trust_score IS NULL OR (trust_score >= 0 AND trust_score <= 100)),
    critical_vulns  INTEGER      NULL CHECK (critical_vulns IS NULL OR critical_vulns >= 0),
    scored_at       TIMESTAMPTZ  NULL,

    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scope_checks (
    check_id     BIGSERIAL   PRIMARY KEY,
    contract_id  TEXT        NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
    sender       TEXT        NOT NULL,
    message      TEXT        NOT NULL,
    allowed      BOOLEAN     NOT NULL,

    -- The similarity and the threshold it was compared against are stored
    -- together on purpose. The threshold is configuration and can change; a
    -- stored decision whose threshold is not recorded alongside it cannot be
    -- re-derived later, which makes the audit trail unfalsifiable.
    similarity   REAL        NOT NULL,
    threshold    REAL        NOT NULL,

    -- The contract version the decision was made against (Objective 3).
    genesis_hash CHAR(64)    NOT NULL,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scope_checks_contract ON scope_checks(contract_id, created_at DESC);
