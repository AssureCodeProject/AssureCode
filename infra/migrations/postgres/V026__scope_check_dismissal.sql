-- =============================================================================
-- V026__scope_check_dismissal.sql — audited override for a spurious scope
-- rejection.
--
-- The settlement gate (packages/oracle/src/index.ts, OracleStore.evaluate())
-- is deliberately zero-tolerance: one rejected scope_checks row blocks a
-- contract's settlement forever, with no expiry, and that strictness is
-- intentional (see V008's own comment on the old latch-open bug this
-- replaced). But the table has no way to say "this particular row was wrong"
-- -- a row written by a misdirected test call, a scope-guard threshold that
-- was later found miscalibrated, or a decision a human reviewer overturns on
-- appeal has no path back except editing scope_checks by hand, which leaves
-- no record that anything was overridden or why.
--
-- `dismissed` is additive and defaults to FALSE, so every existing row's
-- effect on the gate and on the XAI adherence ratio is unchanged until an
-- admin explicitly dismisses one.
-- =============================================================================

ALTER TABLE scope_checks ADD COLUMN IF NOT EXISTS dismissed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE scope_checks ADD COLUMN IF NOT EXISTS dismissed_by TEXT NULL;
ALTER TABLE scope_checks ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ NULL;
ALTER TABLE scope_checks ADD COLUMN IF NOT EXISTS dismiss_reason TEXT NULL;

ALTER TABLE scope_checks ADD CONSTRAINT scope_checks_dismissal_consistent CHECK (
    (dismissed = FALSE AND dismissed_by IS NULL AND dismissed_at IS NULL AND dismiss_reason IS NULL)
    OR
    (dismissed = TRUE AND dismissed_by IS NOT NULL AND dismissed_at IS NOT NULL AND dismiss_reason IS NOT NULL)
);
