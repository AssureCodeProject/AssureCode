-- =============================================================================
-- V018__payout_leg.sql — payout account persistence + settlement payout state
--
-- Everything up to this migration only moves money IN: a client's payment is
-- captured into AssureCode's own Razorpay account and settlements.status
-- becomes 'COMPLETED' — but no freelancer has ever actually been paid.
-- POST /api/kyc/connect-onboarding already gets back a real payout account id
-- from the KYC adapter and throws it away; this adds somewhere to put it.
--
-- payout_status/payout_id/payout_failure_reason are deliberately new,
-- separate columns rather than repurposing settlements.status/transfer_id —
-- those already mean "the capture happened" and reconcileAbandonedSettlements
-- (apps/settlement-worker/src/worker.ts) queries status='PROCESSING'
-- specifically to mean "crashed mid-capture". A payout has its own,
-- independent lifecycle and must not collide with that query.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_account_id TEXT NULL;

ALTER TABLE settlements ADD COLUMN IF NOT EXISTS payout_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (payout_status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'));
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS payout_id VARCHAR(255) NULL;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS payout_failure_reason TEXT NULL;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS payout_updated_at TIMESTAMPTZ NULL;

-- Backs the reconciler's sweep query (settlements WHERE payout_status IN
-- ('PENDING','FAILED')) — most rows will be 'COMPLETED' once the payout leg
-- is in steady-state, so a partial index keeps that scan cheap.
CREATE INDEX IF NOT EXISTS idx_settlements_payout_pending
    ON settlements(payout_status) WHERE payout_status IN ('PENDING', 'FAILED');
