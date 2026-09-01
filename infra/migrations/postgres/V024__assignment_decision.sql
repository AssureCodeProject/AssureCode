-- =============================================================================
-- V024__assignment_decision.sql — explicit freelancer accept/reject step
-- between a client assigning a freelancer and repository provisioning.
--
-- A contract's `status` never actually reaches 'LOCKED' in this codebase
-- (nothing writes it — see V022's comment history); it moves DRAFT -> ACTIVE
-- once settlement-worker's attemptProvisioning completes. Assignment
-- acceptance is therefore tracked as its own per-assignment row rather than
-- as another `contracts.status` value, mirroring how repo_provisioning
-- (V022) tracks a different sub-process the same way: a dedicated table with
-- its own small state machine, referenced by contract_id.
--
-- One contract can go through this more than once (assign -> reject ->
-- reassign -> accept), so unlike repo_provisioning this is NOT keyed on
-- contract_id alone. The partial unique index below is what keeps "at most
-- one open decision per contract" true without a composite PK blocking
-- history from accumulating.
-- =============================================================================

CREATE TABLE IF NOT EXISTS contract_assignments (
    assignment_id      BIGSERIAL   PRIMARY KEY,
    contract_id         TEXT        NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
    freelancer_id        TEXT        NOT NULL REFERENCES users(user_id),
    status               TEXT        NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
    -- The contract's genesis ledger row (H0) at the moment this assignment was
    -- created — what the freelancer is reviewing and, on acceptance, what the
    -- acceptance record is anchored to. Not the *latest* ledger row: H0 is the
    -- one hash that identifies "the contract as originally locked", which is
    -- what an acceptance must refer to regardless of anything appended later.
    locked_ledger_id     BIGINT      NULL REFERENCES merkle_ledger(ledger_id),
    locked_ledger_hash   TEXT        NULL,
    rejection_reason_code TEXT       NULL
                          CHECK (rejection_reason_code IS NULL OR rejection_reason_code IN (
                              'DEADLINE_INFEASIBLE','OUTSIDE_EXPERTISE','COMPENSATION_MISMATCH',
                              'UNAVAILABLE','OTHER'
                          )),
    rejection_reason_text TEXT       NULL,
    assigned_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at            TIMESTAMPTZ NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one PENDING decision per contract at a time. This is the
-- concurrency-safety backstop for /assign: a second assignment attempt while
-- one is still awaiting a decision hits this constraint (23505) rather than
-- silently creating a competing pending row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_assignments_one_pending
    ON contract_assignments(contract_id) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_contract_assignments_contract ON contract_assignments(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_assignments_freelancer ON contract_assignments(freelancer_id);

-- =============================================================================
-- Minimal persisted notification, scoped to one recipient user. Nothing like
-- this existed before this migration — ToastNotification.jsx is an ephemeral,
-- client-local React context with no server backing, and the two existing
-- WebSocket routes are per-contract event taps (chat, audit stream), not a
-- general inbox. This is the smallest table that lets a client see "freelancer
-- accepted/rejected your contract" after the fact, on their own dashboard.
-- =============================================================================
CREATE TABLE IF NOT EXISTS notifications (
    notification_id  BIGSERIAL   PRIMARY KEY,
    user_id           TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    contract_id       TEXT        NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
    type              TEXT        NOT NULL,
    message           TEXT        NOT NULL,
    read_at           TIMESTAMPTZ NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
