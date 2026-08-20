# Demo walkthrough

An end-to-end run of the five-phase pipeline, from login to settlement. Takes
about ten minutes. Everything runs offline on fake payment and KYC adapters —
no credentials required, no money moves.

For the oral-defence framing and expected questions, see
[docs/PRESENTATION_GUIDE.md](docs/PRESENTATION_GUIDE.md). Read
[Honest caveats](#honest-caveats) before demonstrating this to anyone who will
draw conclusions from it.

## Setup

```bash
cp .env.example .env
npm install
npm run infra:up
npm run migrate
python tools/seed-users.py
```

Wait for the gateway to report ready:

```bash
curl localhost:4000/readyz    # {"status":"ready","db":"ok","redis":"ok",...}
```

Open http://localhost:3000.

Keep a second window on Jaeger (http://localhost:16686) — the trace view is the
most convincing part of the demo, because it shows a single correlated trace
crossing the gateway, the event bus, and the workers.

## Accounts

There is no self-signup. All accounts come from the seed script and share the
password `demo1234` (a publicly documented demo credential; the seed script
refuses to run under `NODE_ENV=production` for exactly this reason).

| Role | Email |
|---|---|
| Client | `client@acme.com` |
| Freelancer | `priya@assurecode.io`, `marcus@assurecode.io`, … |

## Phase 1 — Contract and ledger initialisation

1. Log in as `client@acme.com` (`#btn-login-submit`).
2. Fill in the contract requirements and submit (`#btn-initialize-contract`).

**What to point at.** The contract's genesis hash `H0` is now written as the
first `merkle_ledger` row, with `previous_hash = 'GENESIS'`. Every later row
chains from it. This is the anchor that makes phase 3 checkable: the scope guard
judges against the contract *as hashed at lock time*, not as the text reads
later.

Verify it independently:

```sql
SELECT contract_id, previous_hash, current_hash
FROM merkle_ledger WHERE previous_hash = 'GENESIS' ORDER BY created_at DESC LIMIT 1;
```

## Phase 2 — Matchmaking and escrow

3. Review the ranked freelancer list. Ranking is a weighted combination of skill
   similarity, trust score and history (0.50 / 0.35 / 0.15).
4. Assign a freelancer, then fund escrow (`#btn-proceed-escrow`).

**What to point at.** The escrow is a Razorpay order created with
`payment_capture: 0` — authorise now, capture later. That two-phase flow *is* the
escrow: funds are held against the client's instrument and only captured when
the oracle approves. Offline this runs on `FakeRazorpayAdapter`, which verifies
real HMACs rather than returning `true`, so the same signature path is exercised.

**Be honest about the ranking.** P@1 is 0.750 for queries that name a
technology and 0.375 for queries that describe an outcome. Demo with an
outcome-only query at least once — the system is closer to a robust keyword
matcher than a semantic one, and that is a finding, not a bug to hide.

## Phase 3 — Scope guard

5. Open the chat panel and send an in-scope request. It is allowed.
6. Send an out-of-scope request — something plainly outside the contract, e.g.
   asking for a mobile app when the contract is for a REST API. It is blocked,
   with the retrieved contract chunks shown as the reason.

**What to point at.** The decision records `H0`, so it can be replayed later
against the exact contract text it was compared to. A rejected check also blocks
settlement in phase 5 — the scope signal is derived from `scope_checks` on every
read rather than stored, so it cannot disagree with the decisions it summarises.

**Be honest.** Over 50 live contracts this classifier scores accuracy 68%,
precision 100%, recall 60%, F1 75%. It has never allowed an out-of-scope request
in this fixture, but it still blocks about 4 in 10 legitimate ones. Expect the
demo to show a false block if you push it. (Before the chunker fix and the
threshold recalibration it was 36% / 100% / 20% / 33%.)

## Phase 4 — Verification and scoring

7. Trigger a push (`#btn-simulate-push`).
8. Watch the verification dashboard stream results over the WebSocket: AST
   maintainability, generated tests, OWASP scan.
9. Proceed to the trust score (`#btn-proceed-xai`).

**What to point at.** Switch to Jaeger and open the trace. One correlation id
spans the gateway request, the `code.push.received` publish, the `ci-worker`
consume, the calls into `ai-service`, and the `audit.completed` publish. The
consume spans hang off the publish span because W3C trace context travels inside
the event envelope.

**Be honest.** This is `/simulate-push`, not a real repository push. The GitHub
webhook path exists (`apps/webhook-ingest`) but publishes `code.push.received`
without a `code` field, so it cannot produce an audit. The submitted code is
`SIMULATED_PUSH_DEMO_CODE`, a two-line module, paired with a hand-written test
bundle. Say so — a reviewer who discovers it unprompted will discount everything
else.

## Phase 5 — Oracle and settlement

10. Open the settlement view. The oracle verdict shows all six signals and, when
    blocked, the specific blockers.
11. Release funds (`#btn-release-funds`).

**What to point at.** `packages/oracle` is the single definition of the gate —
`trustScore >= 85 && criticalVulns === 0` plus four CI booleans. The gateway
reads it; the settlement worker acts on it; there is no second copy to drift.
It has 28 unit tests at 100% statement coverage.

**Demonstrate the blocked path too.** It is more informative than the happy
path. Send an out-of-scope message before settling, then try to release: the
verdict comes back with `scopePassed: false` and a blocker naming the rejected
count. Settlement is refused.

**Be honest.** "Release" is a Razorpay *capture* — it moves money from the client
to the platform. There is no transfer onward to the freelancer; no payout leg
exists in the codebase. The escrow is not, in the end, released to anyone.

## Optional: prove the ledger is tamper-evident

The strongest demonstrable claim in the system.

```bash
node tools/verify_phase8_live.mjs      # Merkle tree + ML-DSA-87 root signing
```

Then modify a `merkle_ledger` payload directly in Postgres and re-run chain
verification: it reports the break. Roots are signed with FIPS 204 ML-DSA-87,
which is the one claim retained from the withdrawn QR-NGC line of work and made
real.

Note that 17 legacy rows predate the canonicalization migration and report
`unverifiable` rather than being assumed good.

## Honest caveats

Say these out loud rather than waiting to be asked:

- The dispute button is a no-op and is labelled `Submit (no-op)` in the UI.
  Arbitration is not implemented.
- KYC approves everyone unconditionally — `FakeKycAdapter` is the only
  implementation.
- `/drift/status` returns 503. The CUSUM parameters are null and no T2
  calibration set exists, so no false-alarm rate can be reported.
- No comparison against a deployed system and no human study were performed.
- The matchmaking pool and queries were authored in-repo, so the retrieval
  numbers measure the pipeline, not hiring outcomes.

## If something goes wrong

See [RUNBOOK.md](RUNBOOK.md#troubleshooting). The most common demo-day failures
are a stale `EVENT_BUS_TYPE=kafka` in `.env` (events vanish silently) and
`ai-service` being unreachable (test generation returns `stub: true` with a 200).
