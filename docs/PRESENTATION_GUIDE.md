# AssureCode — Demonstration & Oral Defense Guide

> **Project**: AssureCode — Zero-Trust, Event-Driven Multi-Agent Freelance Ecosystem
> **Contents**: launch steps, a 4-phase demo script, and answers you can defend under
> follow-up questioning.

**Read this first.** An earlier version of this guide scripted you to claim a
Topological Braid-Ledger with $O(1)$ Alexander-Conway invariants, Poincaré
hyperbolic scope distance, and video proof recording. **None of those exist in
the codebase**, and two of them never worked even when they did. Saying any of
it in a viva puts you one "show me that file" away from a hole you cannot climb
out of.

Everything below is something you can open the terminal and demonstrate. Where a
result is weak, the honest framing is given — a weak result you can explain is
worth more than a strong one you cannot.

---

## 1. Launching the application

```bash
npm run dev:gateway     # http://localhost:4000  — start this first
npm run dev:web         # http://localhost:3000
```

The web app talks to live endpoints. There are no mock data modules any more, so
**if the gateway is down the UI will show an error state rather than a green
dashboard.** That is deliberate — demonstrate it once if you have time, because
"it fails visibly" is a design claim you can defend.

Services the full demo wants running:

```bash
cd apps/ai-service  && .venv/Scripts/python -m uvicorn app.main:app --port 8000
cd apps/scope-guard && python -m uvicorn app.main:app --port 8001
```

---

## 2. The 4-phase demonstration script

```
[ PHASE 01: INIT ] -> [ PHASE 02: VERIFICATION ] -> [ PHASE 03: TRUST SCORE ] -> [ PHASE 04: ESCROW ]
```

### Phase 1 — Contract Initialization

**What to say:**
> "Phase 1 is contract creation and cryptographic anchoring. After you submit
> requirements, the matchmaker ranks real freelancer profiles in Postgres — a
> composite of skill-embedding cosine similarity, trust score, and delivery
> history, 0.50/0.35/0.15 weighted — and you pick who gets the contract from
> the ranked cards, each showing its own score breakdown and matched skills.
> That's the screen that shows the NLP doing something, not just a claim about
> it. An LLM generates a hidden test bundle, and the agreement is canonicalized
> under RFC 8785 and written into a tamper-evident hash chain. The canonical
> bytes that get hashed are stored next to the payload, with a database
> constraint forcing them to agree — so
> the thing we hashed cannot drift from the thing you can query."

**What to click:**
1. Enter: title `Fintech Dashboard Rebuild`, requirements
   `Build a React TypeScript dashboard with Node.js Fastify backend and PostgreSQL database.`,
   budget `$2,500.00`, deadline `2026-12-31`.
2. Click **Lock Contract**.
3. Point out the ledger hash banner. Say: *"That is SHA-256 over the RFC 8785
   canonical JSON concatenated with the previous hash. It's a hash chain with a
   Merkle tree built over the leaves — RFC 6962, the Certificate Transparency
   construction."*

**If asked "why RFC 8785?"** — because two serializations of the same object
hash differently. Key order, unicode escaping, and number formatting all have to
be pinned or verification fails on data nobody tampered with.

### Phase 2 — Verification Dashboard

**What to say:**
> "Phase 2 is the zero-trust CI pipeline. A GitHub push is intercepted by HMAC
> signature check, the repository is cloned at that commit into an ephemeral
> Docker container with no network interface at all, and the hidden tests are
> bind-mounted read-only so the developer never sees them. We measure three
> things: test outcome, AST complexity, and OWASP findings."

**What to click:** Simulate the push and watch the pipeline steppers.

**Three details worth pointing at:**
- **AST**: real `@babel/parser` traversal — cyclomatic complexity, Halstead
  volume, and the SEI maintainability index. Not regex.
- **`0/0` is indeterminate, not a pass.** If the hidden tests don't run, the
  contract does not proceed. This is a deliberate design decision.
- **Sandbox honesty**: if Docker isn't running, a Node-permission adapter is
  selected instead and `describeThreatModel()` reports the *reduced* guarantees.
  The system never claims isolation it isn't providing.

### Phase 3 — Trust Score

**What to say:**
> "The trust score is a deterministic weighted sum on 0–100, computed from
> telemetry the pipeline actually measured — 40% test outcome, 25%
> maintainability, 20% security, 15% scope compliance. Every term reports its
> input, its weight, and its contribution, so the number is reproducible by
> hand."

**What to click:** point to the gauge and the term breakdown.

**The strongest thing you can say here:**
> "If a term has no measured input, we don't default it. The term is *excluded*
> and the remaining weights are renormalised over their own sum, and the
> response tells you which terms were dropped. An earlier version returned a
> hardcoded 0.92 for every contract — that's the defect this design exists to
> prevent."

**Call it what it is.** If asked whether this is XAI: *"It's an
interpretable-by-design linear model. It's decomposable and reproducible, but
it's a weighted sum, not a post-hoc attribution method like SHAP. Calling it XAI
would be overstating it."* Examiners reward this.

### Phase 4 — Escrow Settlement

**What to say:**
> "Funds release requires two conditions: trust score at least 85, and zero
> critical vulnerabilities. That gate is defined once, in `packages/oracle`, and
> imported by both the settlement worker and the gateway — because a second copy
> in the gateway would be a second definition of the rule that releases money,
> free to drift from the one that actually releases it."

**What to click:** show the vault, the oracle signals, then release.

**On double payment:** `pg_advisory_xact_lock` inside the settlement
transaction, plus idempotency keys at the gateway. Stripe uses
`capture_method: 'manual'`, so the capture *is* the release — there is no
separate transfer to double-fire.

**The dispute drawer is labelled `[NOT IMPLEMENTED]`.** Leave it that way. If
asked, say it's future work — do not demo it as though it arbitrates.

---

## 3. Oral defense — questions and defensible answers

| Question | Answer |
|---|---|
| **How do you prove the ledger hasn't been tampered with?** | "Each row's hash is SHA-256 over the RFC 8785 canonical payload concatenated with the previous hash, computed in PostgreSQL. `verifyChainDetailed()` recomputes the chain in JavaScript and reports verified, failed, or *unverifiable* separately. On top of the chain there's an RFC 6962 Merkle tree with inclusion proofs, and the root is signed with ML-DSA-87. It is **tamper-evident**, not tamper-proof — against an adversary who can write to the table but doesn't hold the signing key. Someone with the key is outside our threat model." |
| **Why "unverifiable" as a third state?** | "17 rows predate the canonicalization migration and have no canonical payload stored, so we cannot recompute their hash. Reporting them as verified would be a lie; reporting them as tampered would be a false alarm. They get their own category." |
| **How does the scope guard work?** | "We resolve the contract's genesis ledger hash first — no anchor, no decision. Then we embed the message, retrieve the top-5 contract chunks from a pgvector HNSW index by cosine similarity, and compare the best match against a calibrated threshold of 0.3056. The decision is recorded against that genesis hash so it's auditable." |
| **Where did 0.3056 come from?** | "A sweep in `tools/calibrate_scope_threshold.py` over a 6-contract, 100-message corpus, run through the real ingestion and retrieval path. The corpus is **split by contract**, so the reported numbers come from three contracts the sweep never saw: 0.792 accuracy, 0.917 recall. The sweep minimises `3*FN + FP` rather than accuracy, because blocking legitimate work holds a payment while allowing scope creep costs an amendment. On the live 50-contract benchmark: 68% accuracy, 100% precision, 60% recall — up from 36% / 100% / 20%. The corpus is authored in-repo and not dual-annotated, so treat the held-out figures as optimistic." |
| **Isn't that a bad result?** | "Yes. It's the honest one. The failure direction is the safer one for a payment system — a false block costs a scope amendment, a false allow releases uncontracted work — but it's still a failure. Fixing it needs a larger labelled set, not a tuned constant." |
| **How do you prevent double payouts?** | "Idempotency keys at the gateway with an LRU plus a Postgres table, and `pg_advisory_xact_lock` inside the settlement transaction. There's a concurrency test that fires five simultaneous requests with the same key and asserts exactly one ledger entry." |
| **Why is matchmaking not sub-millisecond?** | "It embeds text with a real transformer. 84.7 ms warm mean over 1000 candidates, 108 ms p95. An earlier benchmark reported under 3 ms because it used a hash-bucket embedder with no semantics — that number measured nothing." |
| **How good is the matchmaking?** | "P@5 of 0.837 when the client names the technologies; 0.325 when they describe the outcome in plain language. That gap is the real finding: the system is closer to a robust keyword matcher than a semantic one." |
| **Why 0.50 / 0.35 / 0.15 for the ranking weights?** | "They were chosen, not derived — and I ablated all 231 settings on the simplex to find out what they cost. They rank 66th of 231 on retrieval; the optimum is near 0.95 on the skill term. But that measures *retrieval*, and trust is in the score on purpose, because we rank who should be hired rather than who's most textually similar. The honest statement is that the split has never been measured against either goal." |
| **What's the drift detector?** | "Per-message thresholding can't catch incremental scope creep by construction — each request is a 2% stretch. So we accumulate: a CUSUM statistic over per-message residuals, plus a conformal test martingale that gives an anytime-valid false-alarm bound by Ville's inequality." |
| **Does it work?** | "The mechanism is implemented and has 19 passing tests including a 1000-sequence false-alarm check. But it is **not calibrated** — the conformal guarantee needs a labelled in-scope residual set that this repository doesn't have. So the endpoint returns 503 rather than substituting a default, and any test calibration is flagged synthetic all the way into the ledger record. I'm not claiming a false-alarm rate." |

**If asked about the braid ledger, hyperbolic distance, or the video proof** —
they were in earlier documentation and have been removed. The honest answer:

> "Those were in an earlier design and I removed them. The Alexander polynomial
> has no tamper-detection semantics even when implemented correctly. The
> hyperbolic distance is still in the repo as `hyperbolic.py`, but as a
> *baseline* — on L2-normalized sentence embeddings it saturates, so a
> near-duplicate pair at cosine 0.94 sits at distance 11.68 while an unrelated
> pair is at 14.52, and both published thresholds fall below the near-duplicate.
> Every pair would classify as scope creep. That measured failure is why the
> system uses cosine retrieval instead."

That answer is stronger than the claim it replaces. It shows you measured
something, found it didn't work, and said so.

---

## 4. Deliverables to mention

| Command | What it demonstrates |
|---|---|
| `npm test` | 120 passing, 2 skipped, 0 failing |
| `python tools/eval/matchmaking_eval.py` | Matchmaking at N=100/1000 + the weight ablation |
| `node tools/benchmark.js` | Live contract flow. **Exits non-zero if the gateway is down** — never simulates |
| `python tools/verify_phase4_live.py` | Drift detector, 18/18 |
| `node tools/verify_phase5_live.mjs` | Trust score + settlement oracle, 33/33 |
| `node tools/verify_phase8_live.mjs` | Merkle tree + ML-DSA-87 signing, 29/29 |
| `python tools/verify_owasp_2025_cloudflare.py` | OWASP detection against planted flaws *and clean negatives* |

**Reports**: `docs/ASSURECODE_COMPLETE_TECHNICAL_SPECIFICATION.md`,
`docs/benchmarks/BENCHMARK_REPORT.md`, `docs/benchmarks/MATCHMAKING_REPORT.md`.

---

## 5. The one thing to lead with

If you get a single sentence to frame the project, use this one:

> "Every number in this repository is produced by a command you can run, and
> where the result is bad I've left it in the report and explained why."

Then show them the 36% scope accuracy yourself, before they find it. A project
that reports its own weak results reads as engineering. One that hides them
reads as a demo — and examiners have seen a lot of demos.
