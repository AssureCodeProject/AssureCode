-- =============================================================================
-- V019__payout_retry_cap.sql — bounded payout retries
--
-- reconcilePendingPayouts() (apps/settlement-worker/src/worker.ts) retried a
-- failed payout identically every 5 minutes forever, with no way to tell a
-- transient failure (RazorpayX momentarily unreachable) from a permanent one
-- (a malformed beneficiary account, an account-level block) — Pending
-- Works.md flagged this explicitly as an open product decision. This adds a
-- counter and a terminal state distinct from plain 'FAILED' so the
-- reconciler's sweep query can stop picking a row up once it has exhausted
-- its retries, without touching the capture leg's unrelated 'PROCESSING'
-- meaning (see V018's header for why payout state stays separate from
-- settlements.status).
-- =============================================================================

ALTER TABLE settlements ADD COLUMN IF NOT EXISTS payout_attempts INT NOT NULL DEFAULT 0;

ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_payout_status_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_payout_status_check
    CHECK (payout_status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'FAILED_TERMINAL'));

-- FAILED_TERMINAL is deliberately excluded from the reconciler's sweep index —
-- it means "stop retrying automatically", so it must not be cheap to scan for
-- alongside the rows that are still meant to be retried.
