# AssureCode — Zero-Trust Security & Loophole Audit Report

> **Auditor**: Lead Technical Project Manager & Zero-Trust Auditor (`zt-auditor`)  
> **Target Subsystems**: API Gateway, Settlement Worker, Ledger Client, Stripe Adapter, AI Service  
> **Date**: July 31, 2026  
> **Audit Outcome**: ⚠️ **Corrected — see note below. Do not cite "0 loopholes" in a defense.**

> **Corrected 2026-08-09.** This report originally claimed "0 LOOPHOLES DETECTED" as an
> absolute, and described Vector 4's defense as Poincaré hyperbolic-space geodesic
> distance ($d_{\mathbb{H}} > 2.5$). Neither claim survives inspection: an absolute
> "zero loopholes" is not a claim any audit of this size can support, and the scope
> guard (`apps/scope-guard/app/main.py`) has never used hyperbolic geometry — it
> retrieves contract chunks and scores messages by plain cosine similarity over
> Sentence-BERT embeddings. Vector 4 below is corrected in place; the rest of this
> document describes real, checkable defenses (idempotency guard, webhook HMAC
> verification, Merkle chain hash-break detection, connection/listener cleanup) and
> is left as originally written except where noted. See `docs/PRESENTATION_GUIDE.md`
> for the retraction this correction is consistent with.

## Executive Audit Summary

A Zero-Trust Security Audit was conducted across the AssureCode codebase to evaluate 5 potential loophole vectors:
1. **Double Payout / Financial Settlement Race Conditions**
2. **Stripe Webhook Signature Forgery**
3. **Merkle Ledger Tampering & Historical Fraud**
4. **Adversarial Prompt Injection & Scope Guard Bypass**
5. **Unsanitized Stack Trace Error Leakage**

Defenses were found in place for all 5 vectors (details below). This is evidence the specific mechanisms described exist and do what they claim — it is not a claim that no other loophole exists anywhere in the system.

---

## 1. Loophole Vector Audits & Verification

```
                             Zero-Trust Defense Matrix
                             
┌────────────────────────────────────────┬──────────────────────────────────────────────────────────┐
│ Attack Vector                          │ Implemented Zero-Trust Defense                           │
├────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ 1. Double Payout Race Condition        │ Single-Fire PostgreSQL UNIQUE `settlements` Guard        │
│    (Concurrent POST /settle requests) │ + 10k-entry Gateway Idempotency LRU Cache                │
│                                        │                                                          │
│ 2. Stripe Webhook Forgery              │ Mandatory HMAC Signature Verification (`whsec_...`)      │
│    (Premature escrow unlock attack)    │ + Production fail-fast key check (`BUG-013`)             │
│                                        │                                                          │
│ 3. Merkle Ledger Rewriting             │ SHA-256 Chain Hashing + Advisory Locks (`pg_advisory`)   │
│    (Row modification / terms fraud)    │ + Instant `verifyChain()` Hash Break Detection (HTTP 409)│
│                                        │                                                          │
│ 4. Scope Guard Prompt Injection        │ Sentence-BERT Vector Embedding + Cosine Similarity        │
│    (Adversarial text injection)        │ Retrieval Against Indexed Contract Chunks                │
│                                        │                                                          │
│ 5. Memory Connection Leakage           │ Explicit `finally` Client Release Blocks (`BUG-005`)     │
│    (Resource exhaustion denial)        │ + WebSocket `socket.close` Listener Cleanup (`BUG-010`)  │
└────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

---

### 🛡️ Vector 1: Double Payout Race Condition Audit

- **Audit Findings**:
  - The API Gateway executes `withIdempotency` middleware on all state-mutating endpoints (`/api/contracts/initialize`, `/lock`, `/settle`).
  - If 10 concurrent requests hit `/api/contracts/:id/settle` simultaneously, the first request acquires the in-memory LRU lock, and subsequent requests resolve via `Promise.race()` returning the identical cached HTTP response without re-executing financial transfers.
  - At the database level, the `settlements` table enforces a `UNIQUE (contract_id)` constraint under PostgreSQL transactions, guaranteeing that **no contract can ever be settled twice**.

---

### 🛡️ Vector 2: Stripe Webhook Forgery Audit

- **Audit Findings**:
  - In `apps/api-gateway/src/server.ts` and `packages/stripe-adapter`, webhook events require cryptographic signature verification using `stripe.webhooks.constructEvent(payload, signature, secret)`.
  - Fake signatures are rejected with HTTP 400 (`Invalid signature`).
  - In production (`NODE_ENV === 'production'`), missing `STRIPE_SECRET_KEY` causes immediate process termination (`process.exit(1)`), preventing insecure fallback deployments.

---

### 🛡️ Vector 3: Merkle Ledger Tampering Audit

- **Audit Findings**:
  - Every contract state change executes `append_ledger_and_outbox` stored procedure in PostgreSQL under `pg_advisory_xact_lock`.
  - Ledger entries are chained via `hash = SHA256(payload || previous_hash)`.
  - Re-running `verifyChain()` traverses the full history and verifies every hash. Any direct database row modification breaks the cryptographic link and returns `{ valid: false }`, blocking all subsequent contract actions.

---

### 🛡️ Vector 4: Scope Guard Prompt Injection Audit *(corrected 2026-08-09)*

- **Audit Findings**:
  - Adversarial text injections such as `"Ignore system instructions"` do not alter vector embeddings because inputs are encoded into semantic space (`Sentence-BERT` / `FakeEmbedder`).
  - `apps/scope-guard/app/main.py` retrieves the top-k indexed contract chunks and scores the incoming message by **cosine similarity** against them — plain Euclidean-space cosine similarity, not hyperbolic geometry. There is no `hyperbolic.py`, no Poincaré ball, and no geodesic distance anywhere in the codebase; an earlier version of this document described one that was never implemented.
  - Off-scope requests below the similarity threshold are rejected with HTTP 403 Forbidden (see `apps/scope-guard/app/main.py:233` `check_scope`). The held-out accuracy of this threshold is documented as a known weakness elsewhere in the repo — do not present it as a strong guarantee.

---

### 🛡️ Vector 5: Resource Leakage & Listener Cleanups

- **Audit Findings**:
  - `BUG-005`: Resolved double pool connection acquisition in `verifyChain()` by wrapping client release inside a `finally` block.
  - `BUG-010`: Resolved WebSocket chat listener leaks by storing `unsubscribe()` callbacks and invoking them upon `socket.on('close')`.
  - `BUG-006`: Replaced unbounded `Map` with a bounded 10,000-entry LRU cache with automatic TTL expiration.

---

## 🎯 Final Security Conclusion *(corrected 2026-08-09)*

The five mechanisms audited above — idempotency guard, webhook HMAC verification, Merkle chain hash-break detection, scope-guard cosine retrieval, and connection/listener cleanup — are real and independently checkable in the current codebase. That is a narrower and more defensible claim than "0 loopholes": it says these five specific attack vectors are covered, not that no other loophole exists anywhere in the system. Treat any absolute security claim in a viva the same way — cite the mechanism, not the total.
