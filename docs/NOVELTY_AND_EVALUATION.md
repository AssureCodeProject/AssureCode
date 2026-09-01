# AssureCode: A Zero-Trust, Event-Driven Escrow Architecture with Recomputable Trust Scoring — Novelty and Evaluation

*Internal technical report. Companion to [ARCHITECTURE.md](../ARCHITECTURE.md), [RUNBOOK.md](../RUNBOOK.md), and [README.md](../README.md); all cited figures trace to those documents or to source under `packages/` and `apps/`.*

## Abstract

Freelance platforms conventionally settle disputes with a rating: a number produced by one party about another that a third party cannot re-derive. AssureCode replaces the rating with a chain of measurements — a cryptographically hashed contract, sandboxed execution of the submitted code pinned to a specific commit, a closed-form trust score computed from that execution's telemetry, and a post-quantum-signed ledger — such that an auditor who did not observe the transaction can verify the outcome from evidence alone. This report states the system's specific novelty contributions against named comparator systems, together with the test evidence and field measurements that support each claim. Consistent with the project's own architectural invariant — "no telemetry, no number" — every figure below is either a formula in shipped code or a measured result already reported in the project's documentation; none is a projection.

## I. Problem Statement

A rating is an opinion, not a measurement: it cannot be recomputed by a party who did not witness the original interaction, and it gives no account of *why* a given score was produced. AssureCode is built around a single requirement — **a third party who did not observe the transaction must be able to check the outcome** — and each architectural decision in the system exists to satisfy that requirement for one stage of a freelance contract's life cycle: what the contract said when it was locked, what code was actually submitted, what an automated audit found, and whether a deterministic gate approved fund release.

## II. System Overview

AssureCode is a seven-service, event-driven system: `api-gateway` (Fastify, JWT/RBAC) is the synchronous entry point for the browser; `ci-worker`, `settlement-worker`, and `webhook-ingest` are pure event consumers with no inbound browser-facing API, which keeps the gateway a thin request/response surface while audit and settlement proceed on their own schedule. `ai-service` and `scope-guard` (FastAPI) provide, respectively, embeddings/matchmaking/explainable scoring and scope-drift detection. Coordination runs over an event bus (Redis Streams by default, Kafka available as an alternative topology) fed by a transactional outbox, so a state change and its event are written atomically and cannot diverge.

| Phase | What happens | Owning service(s) |
|---|---|---|
| 1. Initialization | Contract requirements are embedded and hashed; the genesis ledger row `H0` is written | `api-gateway`, `ledger-client` |
| 2. Verification | Pushed code is executed in an isolated sandbox pinned to the webhook-reported commit SHA; AST maintainability, generated tests, and dual-layer OWASP scanning run | `ci-worker`, `ai-service` |
| 3. Scope | Chat messages are checked against the contract *as originally hashed* (`H0`), not as it reads today | `scope-guard` |
| 4. Scoring | An explainable trust score is computed from the audit signals, automatically, without a human keeping a dashboard tab open | `ai-service`, `settlement-worker` |
| 5. Settlement | A single-definition oracle evaluates a six-signal gate; escrow is captured only on approval | `packages/oracle`, `settlement-worker` |
| 6. Sealing | The contract's event history is Merkle-rooted and the root is signed with a post-quantum signature | `settlement-worker`, `ai-service` |

## III. Novelty Contributions

Each claim below names its closest comparator system explicitly, scoped narrowly to what is verifiable in this codebase — none claims to have invented the underlying primitive (sandboxed execution, PQC signatures, RAG) in general, only its specific application here.

**N1 — Code execution, not judgment, as the payment-release primitive.** AssureCode gates settlement on the deterministic outcome of actually *executing* the freelancer's code, sandboxed, pinned to the exact commit SHA reported by the webhook — never a mutable branch, which closes a force-push swap attack. This differs structurally from the two closest comparators: GenLayer's freelance-escrow design uses LLM "AI validators" that read a submitted URL and vote by consensus (judgment, not execution), while TessPay verifies agent-transaction legitimacy via TEE attestation rather than code output. *Claim:* the first gig-economy escrow system to use real, sandboxed code execution — not model judgment or hardware attestation — as the payment-release primitive.

**N1-Addendum — Platform-owned, not freelancer-declared, code identity (added 2026-08-31).** N1's SHA-pinning guarantee is only as strong as the binding between "the repository being audited" and "the repository the contract is actually about." Prior to the most recent commits, that binding was a freelancer-supplied `owner/repo` string — nothing prevented linking an unrelated, clean repository. The current implementation (`apps/settlement-worker/src/github-provisioner-client.ts`, triggered on the `CONTRACT_LOCKED` event) has AssureCode's own GitHub organization create the repository, add the freelancer only as a push-access outside collaborator (never an owner), and attach the audit webhook itself — idempotently, with GitHub's "already exists" responses (422/409) treated as reconciliation rather than failure, plus a reconciler sweep for crash recovery. Authenticated OAuth linking with signed state (`apps/api-gateway/src/routes/auth.ts`) further closes a cross-account swap: a session can no longer silently attach another account's GitHub identity. This is presented as a strengthening of N1's threat model, not an independent claim, since no comparison against GenLayer/TessPay on this specific property has been verified.

**N2 — A fixed, publicly recomputable formula in place of both black-box scores and subjective votes.** The trust score is $T = 0.40\,S_{\text{test}} + 0.25\,S_{\text{maint}} + 0.20\,S_{\text{sec}} + 0.15\,S_{\text{scope}}$ (`packages/oracle/src/index.ts`), a closed-form linear function of measured CI telemetry with $T \in [0,100]$, gated at $T \ge 85 \wedge \text{criticalVulns} = 0$ — six signals in total (four CI booleans plus the two threshold conditions). Any party holding the raw telemetry can recompute the identical number, a property neither an opaque ML trust score nor an AI-validator vote (GenLayer) nor DAO-arbitration voting (existing Ethereum freelance-escrow designs) provides. `packages/oracle` exists as an isolated package specifically so the gateway and the settlement worker cannot hold two independently drifting definitions of the gate that releases money. *Claim:* a verifiable, third-party-recomputable trust score for gig work, distinct from both black-box and consensus-vote trust models.

**N3 — Structural refusal to fabricate a measurement.** "No telemetry, no number" is enforced architecturally, not by convention: a missing `oracle_state` row is not a permissive default (every signal is treated as false and the score as null, blocking settlement with a stated reason), `GET /scope/drift/{contract_id}` returns HTTP 503 rather than inventing a false-alarm rate when no real calibration set exists, and the frontend renders a visually distinct "not a reading" state rather than any plausible-looking digit. Related philosophy exists in adjacent AI-agent-evaluation tooling (Zephr's "no fabricated scores" evidence model); this applies the same principle to a financial release gate specifically. *Claim:* the first application of this integrity-by-construction principle to an automated, escrow-releasing payment gate, evidenced identically in both the API contract and the UI.

**N4 — Post-quantum-signed, independently verifiable settlement ledger.** Each settlement seals a Merkle root (RFC 6962, domain-separated leaf/interior hashing, odd-node promotion rather than duplication to avoid CVE-2012-2459) over the canonicalized (RFC 8785 JCS) event history, and signs it with ML-DSA-87 (NIST FIPS 204) via `dilithium-py`. `verify_root` requires the caller to supply the expected public key out-of-band — there is no mode that verifies a signature against a key stored beside it, which would verify nothing. The threat model is stated plainly: tamper-*evident*, not tamper-*proof*, against an adversary who can write to `merkle_ledger` but does not hold the private key. PQC-signed audit trails are an active general research area; this applies the technique specifically to gig-work payment settlement. *Claim:* the first application of a post-quantum-signed, independently verifiable audit ledger to a freelance-payment settlement system — a narrow, domain-specific claim, not a claim of inventing PQC-signed logs.

**N5 — Scope adherence as a quantified, weighted term in the release formula.** A RAG-based scope guard (`apps/scope-guard`) retrieves the locked contract's requirement chunks and scores each client–freelancer chat message against them at a measured, calibrated threshold $\tau = 0.3056$ (swept by `tools/calibrate_scope_threshold.py` to minimize $3\cdot\text{FN} + \text{FP}$, since a false *allow* costs more than a false block in a payment system). Every decision is anchored to $H_0$ — the contract as originally hashed, not as its text reads today — and the guard refuses outright if $H_0$ cannot be resolved rather than degrading into a free-floating similarity check. The resulting decision feeds $S_{\text{scope}}$, one of N2's four weighted terms, directly. *Claim:* the first system to fold automated, RAG-based scope-adherence detection into a quantified payment-release formula, rather than leaving it a manual dispute question — the human/DAO-arbitration model used elsewhere.

## IV. Formal Definitions

| Quantity | Formula | Rationale |
|---|---|---|
| Trust score $T$ | $T = 0.40S_{\text{test}} + 0.25S_{\text{maint}} + 0.20S_{\text{sec}} + 0.15S_{\text{scope}}$ | Interpretable-by-design linear model; a term with no measured input is excluded and the rest renormalized, never defaulted |
| Settlement gate | $T \ge 85 \wedge \text{criticalVulns} = 0$ | Single definition in `packages/oracle`, read by both settlement-worker (acts) and gateway (reports) |
| Maintainability index | $\text{MI} = \max\!\big(0, \tfrac{171 - 5.2\ln V - 0.23M - 16.2\ln L}{171}\times100\big)$ | Published formula, implemented from a real Babel AST traversal |
| OWASP penalty $S_{\text{sec}}$ | $S_{\text{sec}} = \max(0,\ 100 - 40N_{\text{crit}} - 20N_{\text{high}} - 5N_{\text{total}})$ | $N_{\text{total}}$ includes critical/high already charged (documented, not silently "corrected," since fixing it would change every historical score) |
| Scope decision | $\text{allowed} \iff \max_{r\in R_c}\cos(e(m),r) \ge \tau,\ \tau=0.3056$ | Threshold measured against real ingest/retrieve data, not chosen |
| Cumulative drift (CUSUM) | $S_t = \max(0, S_{t-1} + (s_t - \kappa))$, alarm when martingale $M_t > 1/\delta$ | Anytime-valid, distribution-free false-alarm bound (Page 1954; Vovk 2003; Ville 1939) — refuses to run without real calibration residuals |
| Matchmaking score | $0.50\cos(\mathbf u,\mathbf v) + 0.35\,\text{TrustScore} + 0.15\,\text{CompletionRate}$ | Ranks *who should be hired*, not *who is most textually similar*; ablated over all 231 simplex weight settings |
| Ledger hash chain | $H_k = \text{SHA256}(C(P_k)\,\|\,\texttt{\\n}\,\|\,H_{k-1})$, $H_0=\texttt{GENESIS}$ | $C(\cdot)$ is RFC 8785 canonical JSON; canonicalization is required for a hash any third party can re-derive |

## V. Test Cases and Evaluation Methodology

**Test inventory.** The suite spans four layers, summarized in Table 1: TypeScript unit/integration tests colocated with each package and app under `test/`, Python service tests under `apps/{ai-service,scope-guard}/tests`, and one full-stack end-to-end suite. Python suites are run from each service's own directory (`cd apps/ai-service && pytest tests -q`, `cd apps/scope-guard && pytest tests -q`) because both declare a top-level `app` package and collecting them together resolves one service's imports against the other's.

**Table 1 — Test inventory by layer.**

| Layer | Approx. count | Representative concern |
|---|---|---|
| Package unit (`packages/*/test`) | 8 files | Canonicalization, Merkle construction, root signatures, oracle gate logic, outbox relay, secrets validation, KYC port |
| App integration (`apps/*/test`) | ~20 files | Idempotency under concurrency, ledger tamper-evidence, RBAC, OAuth linking, repo-provisioning reconciliation, settlement crash-recovery, Razorpay webhook verification, AST analysis, sandbox isolation |
| Python service (`apps/ai-service`, `apps/scope-guard`) | 23 files, 223 passed / 20 skipped (ai-service), 29 passed (scope-guard) | Embeddings, RAG, XAI narrative, security-scan, drift detector, Neo4j/pgvector cross-backend parity |
| Full-stack E2E | 1 suite (`test/golden-path.e2e.test.ts`), isolated compose project | End-to-end contract-to-settlement path against real infrastructure |

**Representative test cases, each defending a specific claim above:**

- *Ledger tamper-evidence* (`apps/api-gateway/test/ledger-tamper.test.ts`) — asserts a mutated row fails chain re-verification, directly evidencing N4's tamper-evident (not tamper-proof) threat model.
- *Idempotency under concurrency* (`apps/api-gateway/test/idempotency-concurrency.test.ts`) — asserts two racing requests reserve the same key exactly once, protecting the correctness of the N2 gate under replica scale-out.
- *Settlement crash-recovery* (`apps/settlement-worker/test/settlement-crash-recovery.test.ts`) — asserts oracle state stored with the contract (not a module-level `Map`) survives a worker restart between audit and settlement, defending N2/N3's "null must block" invariant.
- *Cross-backend ranking parity* (`apps/ai-service/tests/test_graph_repo_neo4j.py::TestCrossBackendParity`) — asserts Postgres+pgvector and Neo4j return identical top-k rankings and similarity values once `neo4j_score_to_cosine` corrects the differing similarity scales; skips loudly rather than silently passing when Neo4j is unreachable.
- *GitHub OAuth linking* (`apps/api-gateway/test/github-oauth.test.ts`) and *repo-provisioning reconciliation* (`apps/settlement-worker/test/repo-provisioning-reconcile.test.ts`) — directly evidence the N1-Addendum: signed-state validation against a linked user id, and idempotent recovery from a partial provisioning attempt (repo created, DB write lost).

**Coverage-gate methodology.** `npm run test:coverage` (`vitest.coverage.config.ts`) is deliberately scoped to the pure-logic `packages/*` rather than the full workspace: most app-level suites use `describe.skipIf(!PG_UP)` / `!REDIS_UP` against live infrastructure, so including them would make the coverage number a function of whether Postgres/Redis happened to be running rather than of the code — precisely the kind of environment-dependent green result this project's own "no fabricated number" ethic (N3) exists to prevent. Integration-level coverage is instead asserted by the isolated `npm run test:e2e` run, which brings up its own compose project and does not skip.

**Field-measured results (Table 2)** — distinguished explicitly from the drift detector's *synthetic* calibration set, which every API response using it labels `calibration_is_synthetic: true` per N3:

| Metric | Result | Source |
|---|---|---|
| Scope-guard accuracy / precision / recall / F1 (50 live contracts) | 68% / 100% / 60% / 75% | README Status & Limitations (was 36%/100%/20%/33% before a chunker fix and threshold recalibration) |
| Matchmaking P@1, tech-named queries (N=1000) | 0.750 | `docs/benchmarks/MATCHMAKING_REPORT.md` |
| Matchmaking P@1, outcome-only queries (N=1000) | 0.375 | `docs/benchmarks/MATCHMAKING_REPORT.md` |
| Shipped matchmaking weight rank vs. full ablation | 66th of 231 | `docs/benchmarks/`; expected, since trust/completion-rate reorder rather than sharpen a domain match |
| ai-service test suite | 223 passed, 20 skipped | `README.md` |
| scope-guard test suite | 29 passed | `README.md` |

## VI. Threats to Validity and Known Limitations

Consistent with N3's own standard, the following are stated rather than left implicit. **Scope-guard recall (60%) is the weakest measured metric**: the system still blocks more legitimate requests than it should, though it has never allowed an out-of-scope one in the 50-contract fixture. **The drift detector's calibration set is synthetic**; no real T2 false-alarm-rate measurement exists yet, and every affected response says so. **KYC has one implementation, `FakeKycAdapter`**; no vendor is wired, so N1–N5's guarantees do not extend to identity verification. **The payout leg is proven only in RazorpayX test-mode**, end-to-end with a verified signed webhook; live credentials remain gated on the project owner's business KYC. **Dispute/arbitration is not implemented.** **Tracing stops at the Python service boundary** — `ai-service` and `scope-guard` export Prometheus metrics but no OpenTelemetry spans, so a trace crossing into them ends there. **Neo4j is selectable and verified for ranking parity but structurally unjustified today**: the matchmaker performs no graph traversal, so it buys nothing measurable over pgvector+HNSW. **The rate limiter is per-process**, so its effective ceiling scales with replica count rather than being a true global bound. None of these limitations bear on the six novelty claims stated in §III, which concern the settlement-release path specifically; they are recorded here so the scope of "verified" is not overstated.

## VII. Conclusion

AssureCode's contribution is not any single primitive — sandboxed execution, linear scoring, post-quantum signatures, and RAG-based scope checking each exist elsewhere — but their specific composition into one deterministic, third-party-recomputable path from "code was pushed" to "money moved," with an architectural refusal to report a number it cannot measure. The evaluation in this report is confined to what the shipped test suite and field measurements actually demonstrate today; extending recall on scope-guard, replacing the synthetic drift calibration set with measured traffic, and completing the KYC and dispute-arbitration paths remain the identified next steps toward closing the gap between this system as a research artifact and as a production payment platform.
