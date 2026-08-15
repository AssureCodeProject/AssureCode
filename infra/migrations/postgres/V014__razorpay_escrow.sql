-- =============================================================================
-- V014__razorpay_escrow.sql — move the escrow tables from Stripe to Razorpay.
--
-- The payment provider changed from Stripe to Razorpay. The escrow *model* did
-- not: money is authorised when the contract is funded, held, and only captured
-- when the settlement oracle approves. What changed is that Razorpay splits
-- that into two identifiers where Stripe used one.
--
-- Stripe's PaymentIntent is a single object that exists from creation through
-- capture, so one column held it. Razorpay has an **order**, created by us
-- before anyone has paid, and a **payment**, created by the customer when they
-- do. The order id exists at funding time; the payment id does not exist until
-- Checkout completes, and it is the payment — not the order — that gets
-- captured. One column cannot hold both, and calling either of them
-- `payment_intent_id` would name a Stripe concept neither one is.
--
-- Three defects in the existing schema are fixed here as well. All three were
-- silent: each failing statement sat inside a try/catch or was swallowed, so
-- the system logged nothing and carried on with wrong state.
--
--   1. payment_events could never be written. apps/api-gateway/src/server.ts
--      inserts a `correlation_id` column that this table never had, and omits
--      `payment_intent_id`, which was NOT NULL with no default. Every insert
--      raised 42703, was caught and logged at error level, and the
--      money-movement audit table stayed permanently empty.
--
--   2. escrow could never be marked failed. apps/settlement-worker sets
--      status = 'FAILED' on a failed payment, but V001's CHECK constraint did
--      not list that value, so the UPDATE raised 23514 inside a try/catch. A
--      failed payment therefore stayed 'PENDING' — and 'PENDING' was what the
--      oracle treated as capturable.
--
--   3. There was no state distinguishing "order created, nobody has paid" from
--      "funds are held". packages/oracle selected escrow rows WHERE status =
--      'PENDING', which under Razorpay's two-phase flow means the oracle would
--      attempt to capture an order no customer ever paid. 'AUTHORIZED' is the
--      state that makes the difference expressible, and the oracle now selects
--      on it.
--
-- Forward-only, and idempotent: every statement is guarded so a re-run is a
-- no-op. tools/migrate.ts runs each file once inside an implicit transaction,
-- but the guards keep this safe against a partially-applied earlier attempt.
-- =============================================================================

-- ── escrow ───────────────────────────────────────────────────────────────
--
-- `payment_intent_id` is the primary key and now holds the Razorpay *order* id,
-- which is the identifier that exists at funding time. RENAME COLUMN has no
-- IF NOT EXISTS form, so it is guarded on the catalog.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'escrow' AND column_name = 'payment_intent_id'
    ) THEN
        ALTER TABLE escrow RENAME COLUMN payment_intent_id TO order_id;
    END IF;
END $$;

-- The payment that pays the order. NULL until the customer completes Checkout,
-- which is precisely the distinction the old single-column schema could not
-- represent. UNIQUE because one payment settles exactly one escrow, and it is
-- how the webhook handler resolves an inbound event back to a contract.
ALTER TABLE escrow ADD COLUMN IF NOT EXISTS payment_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_payment_id
    ON escrow(payment_id) WHERE payment_id IS NOT NULL;

-- Razorpay settles in INR by default and amounts are in the minor unit (paise).
-- `amount_cents` keeps its name — it means minor units and always did; renaming
-- it would touch six query sites for no behavioural gain — and `currency` is
-- what now carries the meaning. Capture requires both, and Razorpay rejects a
-- capture whose currency does not match the authorisation.
ALTER TABLE escrow ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR';

-- When the funds actually became held. Distinct from created_at, which is when
-- we made the order; the gap between them is the customer deciding to pay.
ALTER TABLE escrow ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ;

-- Survives a future provider change without another rename.
ALTER TABLE escrow ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'razorpay';

-- The state machine. 'AUTHORIZED' is new and is the real escrow state — funds
-- held, not taken. 'FAILED' is new and is defect (2). 'CAPTURED' is retained
-- alongside 'RELEASED' because V001 shipped both and existing rows may hold
-- either; the settlement worker writes 'RELEASED'.
--
--   PENDING     order created, nobody has paid
--   AUTHORIZED  funds held on the customer's card  ← the escrow
--   RELEASED    captured by the settlement oracle
--   CAPTURED    legacy synonym of RELEASED from V001
--   REFUNDED    returned to the client
--   FAILED      payment failed; must never be capturable
--
-- V001 declared the CHECK inline, so Postgres named it escrow_status_check.
ALTER TABLE escrow DROP CONSTRAINT IF EXISTS escrow_status_check;

ALTER TABLE escrow
    ADD CONSTRAINT escrow_status_check
    CHECK (status IN ('PENDING', 'AUTHORIZED', 'CAPTURED', 'RELEASED', 'REFUNDED', 'FAILED'));

-- The settlement worker looks escrow up by contract to find what to capture.
CREATE INDEX IF NOT EXISTS idx_escrow_contract_status
    ON escrow(contract_id, status);

-- ── payment_events ───────────────────────────────────────────────────────
--
-- The money-movement audit log, which has never contained a row. Defect (1).

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'payment_events' AND column_name = 'payment_intent_id'
    ) THEN
        ALTER TABLE payment_events RENAME COLUMN payment_intent_id TO order_id;
    END IF;
END $$;

-- An event can arrive before we know the order — a payment.failed webhook for a
-- payment we never recorded, for instance. An audit row that cannot be written
-- is worse than one with a null column, which is exactly the trap the original
-- NOT NULL set.
ALTER TABLE payment_events ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS payment_id     TEXT;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS provider       TEXT NOT NULL DEFAULT 'razorpay';

-- Razorpay's event id, from the `x-razorpay-event-id` header — the body carries
-- no id of its own, unlike Stripe's. This is the webhook idempotency key.
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS provider_event_id TEXT;

-- Razorpay retries webhook deliveries until it gets a 2xx, so the same event
-- arrives more than once as a matter of course. Without this, a redelivered
-- payment.authorized appends a second ledger entry and re-publishes an event
-- the settlement worker has already acted on. Partial, because rows written by
-- the gateway's own routes (not by a webhook) legitimately have no event id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_provider_event
    ON payment_events(provider_event_id) WHERE provider_event_id IS NOT NULL;

-- Reading a contract's payment history in order is the audit access pattern.
CREATE INDEX IF NOT EXISTS idx_payment_events_contract_time
    ON payment_events(contract_id, created_at);
