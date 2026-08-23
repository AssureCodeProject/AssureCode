# AssureCode — Technical Architecture Specification

> **Zero-Trust, Event-Driven Multi-Agent Freelance Ecosystem**
> Version 1.0.0-alpha.0 — architecture, algorithms, and operations manual

**Scope of this document.** It describes what the code in this repository does.
Where a mechanism is implemented but not yet validated, that is stated. Where a
number is measured, the command that produces it is named. Claims carried in
earlier revisions that are no longer true — a topological braid ledger, a
hyperbolic scope threshold, `< 3ms` matchmaking, Playwright video proof — have
been removed rather than softened, and §8 and §11 record what replaced them.

---

## Table of Contents

1. [Executive Summary & Core Objectives](#1-executive-summary--core-objectives)
2. [Technology Stack & Infrastructure](#2-technology-stack--infrastructure)
3. [The 5-Phase End-to-End Architecture](#3-the-5-phase-end-to-end-architecture)
4. [Mathematical Formulas & Algorithms](#4-mathematical-formulas--algorithms)
5. [Database Architecture & Schema Reference](#5-database-architecture--schema-reference)
6. [OWASP Top 10:2025 Dual-Layer Security Audit Engine](#6-owasp-top-102025-dual-layer-security-audit-engine)
7. [Cloudflare Workers AI & LLM Integration](#7-cloudflare-workers-ai--llm-integration)
8. [Tamper-Evident Ledger & Post-Quantum Signing](#8-tamper-evident-ledger--post-quantum-signing)
9. [Monorepo Directory Sitemap](#9-monorepo-directory-sitemap)
10. [Setup, Verification & Operations Manual](#10-setup-verification--operations-manual)
11. [Measured Results, Status & Known Limitations](#11-measured-results-status--known-limitations)

---

## 1. Executive Summary & Core Objectives

AssureCode replaces subjective freelance-platform ratings with measurements a
third party can re-derive: a tamper-evident cryptographic ledger, an ephemeral
zero-trust CI sandbox, dual-layer OWASP 2025 auditing, and a deterministic
trust score that gates escrow release.

```
   Phase 1           Phase 2           Phase 3           Phase 4        Phase 5
 ┌──────────┐      ┌──────────┐      ┌──────────┐      ┌──────────┐   ┌──────────┐
 │ Contract │ ───► │ Zero     │ ───► │ RAG      │ ───► │ Trust    │──►│ Oracle   │
 │ & Ledger │      │ Trust    │      │ Scope    │      │ Score    │   │ Escrow   │
 │ Init     │      │ CI/CD    │      │ Guard    │      │          │   │ Settle   │
 └──────────┘      └──────────┘      └──────────┘      └──────────┘   └──────────┘
```

### The 4 Architectural Objectives

1. **Contract & Ledger Initialization.** An NLP-driven matchmaking engine pairs
   requirements with talent using Sentence-BERT embeddings, and the agreed
   business logic is locked into a tamper-evident PostgreSQL hash chain with a
   Merkle tree over its leaves.
2. **Zero-Trust CI/CD Verification.** An ephemeral pipeline evaluates untrusted
   code with real AST parsing, hidden-test injection, and LLM security scanning.
3. **Autonomous Scope Mediation.** A RAG mediator retrieves the contract's own
   text and decides each request against it, anchoring every decision to the
   contract's genesis ledger hash $H_0$.
4. **Objective Evaluation & Escrow Settlement.** A deterministic 0–100 trust
   score computed from system telemetry gates a Razorpay escrow capture.

---

## 2. Technology Stack & Infrastructure

```
                               ┌────────────────────────────────┐
                               │   React 18 Web Frontend (Vite) │
                               │   Port 3000                    │
                               └───────────────┬────────────────┘
                                               │ HTTP / WebSockets
                                               ▼
                               ┌────────────────────────────────┐
                               │  Fastify REST API Gateway (TS) │
                               │  Port 4000 | Zod / Idempotency │
                               └───────┬───────────────┬────────┘
                     ┌─────────────────┘               └─────────────────┐
                     ▼                                                   ▼
┌────────────────────────────────────────┐           ┌──────────────────────────────────────┐
│  Python AI Service (FastAPI, :8000)    │           │  Supabase PostgreSQL 17.6            │
│  Python Scope Guard (FastAPI, :8001)   │           │  pgvector 0.8.2 / pgcrypto / ledger   │
└────────────────────┬───────────────────┘           └──────────────────────────────────────┘
                     ▼
┌────────────────────────────────────────┐
│ Cloudflare Workers AI                  │
│ Meta Llama-3.1-8B-Instruct             │
└────────────────────────────────────────┘
```

### 7 Applications

| Path | Role |
|---|---|
| `apps/web` | React 18 + Vite dashboard. No mock data modules; live endpoints only. |
| `apps/api-gateway` | Fastify v4 (TS), Zod DTO validation, LRU + Postgres idempotency. |
| `apps/ai-service` | FastAPI. Sentence-BERT matchmaker, RAG ingest, trust score, LLM ports. |
| `apps/scope-guard` | FastAPI. Retrieval-based scope decisions and the C1 drift detector. |
| `apps/ci-worker` | AST analyzer, OWASP auditor, ephemeral sandbox runner. |
| `apps/settlement-worker` | Advisory-lock single-fire settlement, Razorpay capture. |
| `apps/webhook-ingest` | GitHub `X-Hub-Signature-256` HMAC listener. |

### 7 Packages

`config` (PG pool, TLS pinning, `.env` loading) · `event-bus` (in-memory /
Redis + transactional outbox) · `ledger-client` (RFC 8785 canonicalization,
RFC 6962 Merkle tree, ML-DSA-87 signing) · `oracle` (the single definition of
the settlement gate) · `shared` (Zod schemas, event topics) · `razorpay-adapter`
(authorize-then-capture escrow, in paise) · `kyc-adapter` (KYC port; the only
implementation is a fake) · `telemetry` (OpenTelemetry, Prometheus).

`packages/oracle` exists so the settlement worker and the gateway share one
`evaluate()`. A second copy in the gateway would be a second definition of the
money-releasing gate, free to drift from the one that releases the money.

### Supporting layers

- **Database.** Supabase PostgreSQL 17.6, `pgvector` 0.8.2, `pgcrypto`, HNSW
  index `idx_rag_embeddings_hnsw`. TLS is pinned to the CA bundle at
  `infra/certs/supabase-ca-bundle.crt`; `buildDbConfig()` throws rather than
  downgrading to an unverified connection.
- **Embeddings.** `all-MiniLM-L6-v2`, 384-dimensional, L2-normalized. The
  `FakeEmbedder` (sha256 buckets) exists for offline tests only and is never
  selected as a silent fallback — a missing model is a startup failure.
- **Graph.** Neo4j `(:Freelancer)-[:HAS_SKILL]->(:Skill)`, with bounded driver
  timeouts and an in-memory mirror for degradation.
- **Signing.** NIST FIPS 204 ML-DSA-87 via `dilithium-py`.

---

## 3. The 5-Phase End-to-End Architecture

### Phase 1 — Contract & Ledger Initialization

1. **Requirement upload.** Client submits title, budget, deadline, requirements.
   `POST /api/contracts/initialize` persists the row and returns a contract id.
2. **NLP talent matchmaking.** The AI service embeds the requirements and ranks
   freelancer profiles by the composite score in §4.2. Measured latency and
   retrieval accuracy are in §11 — this is not a sub-millisecond operation.
3. **Automated test-suite generation.** Cloudflare Workers AI generates a hidden
   test bundle; the gateway records its `s3Key` / `s3Url` on the contract.
4. **Ledger genesis.** The agreement is canonicalized (RFC 8785) and locked via
   `append_ledger(contract_id, 'GENESIS', payload_canonical)`.

### Phase 2 — Zero-Trust CI/CD Verification

1. **Developer push** to the contract branch.
2. **HMAC webhook ingestion.** `apps/webhook-ingest` verifies
   `X-Hub-Signature-256` and emits `code.push.received`.
3. **Ephemeral sandbox.** `DockerSandbox` clones the repo at `commitHash`,
   checks it out, and runs it under `--network=none --memory=<limit>m --cpus=1
   --read-only`, with the code and the hidden tests bind-mounted read-only
   (`/workspace:ro`, `/hidden-tests:ro`). A `NodePermissionSandbox` adapter is
   selected when no Docker daemon is available, and `describeThreatModel()`
   reports which guarantees the *active* adapter actually provides.
4. **AST analysis.** Real `@babel/parser` traversal computes cyclomatic
   complexity, Halstead volume, and the SEI maintainability index (§4.3).
5. **Hidden test execution.** `npm test` runs against the mounted bundle. A
   `0/0` result is *indeterminate*, never a pass.
6. **Dual-layer OWASP 2025 audit.** Static rules, then an LLM pass (§6).

*(Playwright "visual proof" was removed. It returned `verified: true` and hashed
a string rather than a recording, and no objective required it.)*

### Phase 3 — Autonomous RAG Scope Mediation

1. **Anchor first.** Resolve $H_0$, the contract's genesis ledger hash. Without
   it there is no contract version to decide against, and the request fails
   rather than proceeding unanchored.
2. **Embed** the incoming message.
3. **Retrieve** the top-$k$ contract chunks by cosine similarity over the HNSW
   index (default $k = 5$).
4. **Decide** from the best retrieved similarity against the calibrated
   threshold (§4.4).
5. **Record** the decision against $H_0$ in `scope_checks`, so it is auditable
   and so the trust score's scope term has a measured input.
6. **Return** the decision with $H_0$ and the retrieved evidence it rests on.

`GET /scope/drift/{contract_id}` additionally runs the cumulative drift detector
of §4.5 over the recorded per-message residuals. It returns **503 when no
calibration set is configured**, which is the current state (§11).

### Phase 4 — Trust Score Engine

1. **Telemetry ingestion.** Reads the latest `audit_results` row. No hardcoded
   telemetry and no default score: absent audit data returns 404/409.
2. **Deterministic weighting** per §4.7, on a 0–100 range.
3. **Per-term justification.** Every term carries its measured input, its
   weight, and a justification string. When a term has no measured input it is
   *excluded* and the remaining weights are renormalised over their own sum, so
   the score is neither inflated nor silently defaulted — and the response says
   which terms were dropped.

### Phase 5 — Oracle Escrow Settlement

1. **Oracle evaluation.** `packages/oracle` requires `trustScore >= 85` **and**
   `criticalVulns === 0`.
2. **Single-fire claim.** Duplicate release is prevented by an atomic claim on
   the `settlements` primary key, not by an advisory lock:

   ```sql
   INSERT INTO settlements (contract_id, status) VALUES ($1, 'PROCESSING')
   ON CONFLICT (contract_id) DO UPDATE SET status = 'PROCESSING', updated_at = NOW()
     WHERE settlements.status = 'FAILED'
   RETURNING contract_id
   ```

   A caller that gets `rowCount !== 1` is not the claimant and returns. The
   `WHERE` clause is what allows a retry after a genuine failure without
   allowing a second concurrent release.

   *Correction:* earlier revisions of this document described
   `pg_advisory_xact_lock` here. That function appears in no `.ts` or `.sql`
   file in the repository. The advisory locks that do exist are **session**
   level — `pg_advisory_lock(hashtext(p_contract_id))` in the ledger stored
   procedures (`V002__ledger.sql`, `V009__canonical_hash_and_merkle.sql`) —
   and they serialise *ledger appends*, not settlement. The claim upsert above
   is sound; the mechanism previously described was not the one implemented.

   Oracle state lives in Postgres (`oracle_state`), not an in-process `Map`.
3. **Razorpay capture.** The order is created with `payment_capture: 0`
   (authorize now, capture later); capture *is* the release. Note that capture
   moves funds from the client to the *platform* — there is no transfer onward
   to the freelancer anywhere in the codebase (see §12, Limitations).
4. **Ledger append** of `SETTLEMENT_COMPLETED`.

---

## 4. Mathematical Formulas & Algorithms

### 4.1 Vector cosine similarity

$$\text{cos}(\mathbf{u}, \mathbf{v}) = \frac{\mathbf{u} \cdot \mathbf{v}}{\lVert\mathbf{u}\rVert_2 \lVert\mathbf{v}\rVert_2}$$

Embeddings are L2-normalized, so the implementation takes the dot product
directly.

### 4.2 Composite freelancer ranking score

$$\text{Score} = w_1 \cdot \text{cos}(\mathbf{u}, \mathbf{v}) + w_2 \cdot \text{TrustScore} + w_3 \cdot \text{CompletionRate}$$

Shipped weights: $w_1 = 0.50$, $w_2 = 0.35$, $w_3 = 0.15$
(`Matchmaker.__init__`). The negative-similarity clamp and the delivery-count
normalization are part of the definition; see `matchmaker.py`.

These weights have been ablated over all 231 settings of the simplex — see §11.
They are not the retrieval optimum, and the reason is recorded there.

### 4.3 Cyclomatic complexity and maintainability index

Complexity is computed as **decision points plus one**:

$$M = 1 + \sum_{n \in \text{AST}} d(n)$$

counting `IfStatement`, `ConditionalExpression`, loop statements, `SwitchCase`
*with a test* (`default:` is fall-through, not a decision), `CatchClause`, and
`LogicalExpression` with `&&` / `||` / `??`. For structured programs this is the
standard decision-point equivalent of $M = E - N + 2P$. **No control-flow graph
is built**, so that form is cited as an equivalence, not as the method.

Halstead volume, from distinct/total operators and operands:

$$V = (N_1 + N_2)\log_2(n_1 + n_2)$$

SEI maintainability index, implemented exactly as published:

$$\text{MI} = \max\left(0, \frac{171 - 5.2\ln V - 0.23 M - 16.2\ln L}{171} \times 100\right)$$

### 4.4 Scope decision threshold (RAG Scope Guard)

A message is in scope when its best retrieved similarity clears a threshold:

$$\text{allowed} \iff \max_{r \in R_c} \text{cos}\big(e(m), r\big) \ge \tau, \qquad \tau = 0.3056$$

$\tau$ is **measured, not chosen**: `tools/calibrate_scope_threshold.py` sweeps
it against `all-MiniLM-L6-v2` over
`infra/calibration/scope_threshold_corpus.json` — 6 contracts across 6 domains,
100 labelled messages — running the **real ingestion and retrieval path**
(`chunk_text` → `RagStore.search(k=5)`) rather than embedding each requirement
in isolation.

The corpus is **split by contract**, not by message: the sweep sees 3 contracts
and the reported figures come from 3 it never saw. Splitting by message would
leak a contract's similarity scale into its own test rows.

The sweep minimises $3 \cdot \text{FN} + \text{FP}$ rather than maximising
accuracy. Erring toward false positives is deliberate — wrongly allowing an
out-of-scope request costs a scope amendment, while wrongly flagging an in-scope
one blocks legitimate work and holds a payment — and the objective now says so.
The exact weight is not load-bearing: every value in $[1.5, 5.0]$ selects the
same $\tau$. Maximising plain accuracy instead selects 0.4029, which blocks 8
legitimate requests on the held-out contracts to avoid 3 amendments.

| | accuracy | precision | recall | F1 |
|---|---|---|---|---|
| calibration contracts (fitted) | 0.808 | 0.722 | 1.000 | 0.839 |
| **held-out contracts** | **0.792** | **0.733** | **0.917** | **0.815** |

The held-out row is the estimate. It is measured against an **in-repo authored**
corpus that is **not dual-annotated**, so it is optimistic and is not the T2 set
(`configs/c1_rules.json`); what it establishes that the previous single-contract
figure could not is a generalisation gap at all.

**Previous revision:** $\tau = 0.2731$, reported as 14/16. Both halves were
wrong. It was fitted on 16 messages from one contract and scored on those same
16 messages, and it was fitted against a retrieval path the product does not
use. Measured behaviour is in §11.

### 4.5 Cumulative scope-drift detection

Per-message thresholding cannot detect incremental scope creep by construction:
every request is a small stretch, and twenty requests later the deliverable has
changed. The detector therefore accumulates.

Per-message residual against the retrieved chunks:

$$s_t = 1 - \max_{r \in R_c} \text{cos}\big(e(m_t), r\big)$$

CUSUM statistic with per-message slack $\kappa$ (Page, 1954):

$$S_t = \max\big(0,\ S_{t-1} + (s_t - \kappa)\big)$$

Conformal $p$-value against $n$ labelled in-scope calibration residuals, and the
test martingale (Vovk, 2003):

$$p_t = \frac{1 + \lvert\{i : s_i \ge s_t\}\rvert}{n+1}, \qquad M_t = \prod_{i \le t} \varepsilon\, p_i^{\,\varepsilon-1}, \qquad \text{alarm when } M_t > 1/\delta$$

By Ville's inequality (1939) this is **anytime-valid**: the false-alarm rate is
bounded by $\delta$ at any stopping time, distribution-free and finite-sample.
The martingale is tracked in log space.

`ConformalDriftDetector` **refuses to construct without calibration residuals**.
A conformal guarantee quoted against an unmeasured distribution is a number with
no referent, and it would be indistinguishable in the response from a real one.
See §11 for what this means today.

Every assessment is appended to the ledger, so a disputed scope decision is
independently verifiable against a specific contract version.

### 4.6 Poincaré hyperbolic distance — a baseline, not the mechanism

$$d_H(\mathbf{u}, \mathbf{v}) = \operatorname{arcosh}\left(1 + 2\frac{\lVert\mathbf{u}-\mathbf{v}\rVert^2}{(1-\lVert\mathbf{u}\rVert^2)(1-\lVert\mathbf{v}\rVert^2)}\right)$$

`app/services/hyperbolic.py` implements this correctly, but **it is not the
scope mechanism, and the thresholds once published for it (8.5, 2.5) do not
work.** On L2-normalized SBERT vectors the distance saturates: identical inputs
give 0.0, a near-duplicate pair (cosine 0.94) gives 11.68, and an unrelated pair
gives 14.52. Both thresholds sit *below* the near-duplicate distance, so every
pair would classify as scope creep.

The module is retained as an evaluation baseline. Its measured failure is a
result, not dead code.

### 4.7 Trust score

$$T = 0.40\,S_{\text{test}} + 0.25\,S_{\text{maint}} + 0.20\,S_{\text{sec}} + 0.15\,S_{\text{scope}} \qquad T \in [0, 100]$$

The weights are asserted to sum to 1.0 at import. $S_{\text{scope}}$ is the
Phase-3 scope term; earlier revisions used a chat-sentiment term, which measured
nothing about the contract.

This is an **interpretable-by-design linear model**, not a post-hoc attribution
method. Each term reports its input, weight, and contribution. Calling a
weighted sum "XAI" overstates it; the defensible claim is that the score is
decomposable and reproducible.

### 4.8 Hash chain and Merkle tree

Each ledger row's hash is computed in PostgreSQL over the **RFC 8785 canonical
JSON** of the payload:

$$H_k = \operatorname{SHA256}\big(C(P_k) \mathbin{\Vert} \texttt{\\n} \mathbin{\Vert} H_{k-1}\big), \qquad H_0 = \texttt{'GENESIS'}$$

where $C(\cdot)$ is JSON Canonicalization Scheme serialization. The canonical
string is stored alongside the JSONB in `payload_canonical`, and a CHECK
constraint enforces `payload_canonical::jsonb = payload`, so the bytes that were
hashed cannot silently diverge from the queryable payload.

`append_ledger` takes the canonical payload as **TEXT**, not JSONB. This matters:
binding a value as JSONB lets PostgreSQL re-render it, which produces different
bytes and therefore a different hash.

The Merkle tree over the ordered leaf hashes follows **RFC 6962** with domain
separation — leaves prefixed `0x00`, internal nodes `0x01` — and promotes odd
nodes rather than duplicating them, which is what avoids CVE-2012-2459.

$$\text{leaf}(d) = \operatorname{SHA256}(\texttt{0x00} \Vert d), \qquad \text{node}(l,r) = \operatorname{SHA256}(\texttt{0x01} \Vert l \Vert r)$$

`buildInclusionProof` / `verifyInclusionProof` are what make the word "Merkle"
accurate; before the tree existed this was a hash chain called a Merkle chain.

### 4.9 OWASP 2025 penalty function

$$S_{\text{sec}} = \max\big(0,\ 100 - 40 N_{\text{critical}} - 20 N_{\text{high}} - 5 N_{\text{total}}\big)$$

Note that $N_{\text{total}}$ includes the critical and high findings already
charged, so a single critical vulnerability costs 45 points, not 40. This is the
published formula and the implemented one; the double-count is documented rather
than silently corrected, because changing it would change every historical score.

---

## 5. Database Architecture & Schema Reference

Twelve tables across migrations `V001`–`V009`.

| Table | Purpose |
|---|---|
| `contracts` | Core contract registry |
| `merkle_ledger` | Tamper-evident hash chain |
| `merkle_roots` | Per-contract Merkle roots and ML-DSA signatures |
| `rag_embeddings` | 384-D HNSW vector store |
| `scope_checks` | Recorded scope decisions (drift detector input) |
| `escrow` | Razorpay escrow payments (amounts in paise) |
| `settlements` | Settlement records |
| `oracle_state` | Durable oracle state (was an in-process Map) |
| `audit_results` | CI telemetry and trust-score inputs |
| `idempotency_keys` | Gateway request reservation |
| `outbox` | Transactional outbox for the event bus |
| `jobs` | Background job queue |

### `contracts`
```sql
CREATE TABLE contracts (
    contract_id          TEXT PRIMARY KEY,
    client_id            TEXT NOT NULL DEFAULT 'anonymous',
    freelancer_id        TEXT NULL,
    title                TEXT NOT NULL,
    requirements         TEXT NOT NULL,
    pdf_raw_text         TEXT NULL,
    budget_cents         INTEGER NOT NULL,
    deadline             DATE NOT NULL,
    status               TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','LOCKED','IN_PROGRESS','COMPLETED','DISPUTED')),
    hidden_tests_s3_key  TEXT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `merkle_ledger`
```sql
CREATE TABLE merkle_ledger (
    ledger_id         BIGSERIAL PRIMARY KEY,
    contract_id       TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
    action_type       TEXT NOT NULL,
    payload           JSONB NOT NULL,
    payload_canonical TEXT NULL,          -- V009: the RFC 8785 bytes that were hashed
    hash_version      SMALLINT NOT NULL DEFAULT 1,
    previous_hash     TEXT NOT NULL DEFAULT 'GENESIS',
    current_hash      TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payload_canonical_matches CHECK (payload_canonical::jsonb = payload)
);

CREATE INDEX idx_merkle_ledger_contract ON merkle_ledger(contract_id, ledger_id);
```

Rows written before V009 carry `hash_version = 1` and no canonical payload.
`verifyChainDetailed()` reports them as **unverifiable** — a state distinct from
both *verified* and *failed*. Counting them as verified would reintroduce the
defect the migration fixed.

### `rag_embeddings`
```sql
CREATE TABLE rag_embeddings (
    id          BIGSERIAL PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
    chunk_idx   INTEGER NOT NULL,
    content     TEXT NOT NULL,
    embedding   vector(384)
);

CREATE INDEX idx_rag_embeddings_hnsw ON rag_embeddings USING hnsw (embedding vector_cosine_ops);
```

---

## 6. OWASP Top 10:2025 Dual-Layer Security Audit Engine

```
┌────────────────────────────────────────────────────────┐
│ Layer 1: Static rule scan (apps/ci-worker)             │
│ • Hardcoded secrets, eval(), SQLi, shell commands      │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Layer 2: Cloudflare Workers AI Llama-3.1-8B            │
│ • SSRF, broken access control, security misconfig      │
│ • LlmUnavailableError -> HTTP 503, never a silent pass  │
└────────────────────────────────────────────────────────┘
```

Per-layer latency is not published here. Earlier revisions quoted `< 5 ms` and
`~200 ms` with no measurement behind either; run
`python tools/verify_owasp_2025_cloudflare.py` for current figures.

### Category mapping

- **A01 Broken Access Control & SSRF** — missing RBAC guards, unvalidated outbound HTTP.
- **A02 Security Misconfiguration** — wildcard CORS (`origin: true`), verbose stack traces.
- **A03 Software Supply Chain Failures** — runtime package installs (`execSync('npm install…')`).
- **A04 Cryptographic Failures** — hardcoded API keys, insecure PRNG (`Math.random()`).
- **A05 Injection** — raw SQL interpolation, `child_process.exec()`.
- **A06 Insecure Design** — unsanitized path traversal.
- **A07 Authentication Failures** — weak sessions, plaintext passwords.
- **A08 Software & Data Integrity Failures** — `eval()`, `new Function()`.
- **A09 Security Logging & Alerting Failures** — state mutations that emit no ledger event.
- **A10 Mishandling of Exceptional Conditions** — empty `catch {}` that fails open.

`tools/verify_owasp_2025_cloudflare.py` imports the shipped scanner rather than
an inline copy, and scores detection against planted flaws **and clean
negatives**. An earlier version counted a category as passed whenever the API
returned HTTP 200, which tests the transport, not the scanner.

---

## 7. Cloudflare Workers AI & LLM Integration

```env
LLM_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID="your_cloudflare_account_id"
CLOUDFLARE_API_TOKEN="your_cloudflare_api_token"
```

- **Adapter**: `CloudflareWorkersAiClient` in `apps/ai-service/app/ports/llm_client.py`
- **Model**: `@cf/meta/llama-3.1-8b-instruct`
- **Endpoint**: `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/meta/llama-3.1-8b-instruct`

Provider failures surface as HTTP 503. There is no permissive fallback anywhere
in this path: a guard that cannot be reached does not return "allowed".

---

## 8. Tamper-Evident Ledger & Post-Quantum Signing

**Threat model — stated, because "tamper-proof" is not a property any database
has.** The ledger is *tamper-evident* against an adversary who can write to the
`merkle_ledger` table but does not hold the ML-DSA private key. Such an
adversary can mutate rows; they cannot produce a chain that re-verifies, nor a
valid signature over the resulting Merkle root. An adversary holding the signing
key is outside the model.

1. **Canonical hashing.** RFC 8785 JSON Canonicalization (§4.8). The
   canonicalizer *throws* on `NaN`, `Infinity`, `undefined`, `BigInt`, and
   `Date` rather than coercing them — every one of those coercions would be a
   hash collision.
2. **Merkle tree.** RFC 6962 with domain separation and promotion (§4.8), plus
   inclusion proofs.
3. **ML-DSA-87 signing.** NIST FIPS 204 via `dilithium-py`: 2592-byte public
   key, 4896-byte private key, 4627-byte signature. Deterministic key derivation
   from a seed, and the context string `assurecode/merkle-root/v1` for domain
   separation. `verify_root` **requires the caller to supply the expected public
   key** — there is no mode that verifies against the key stored next to the
   signature, which would verify nothing.

The predecessors of this section — a Topological Braid-Ledger with Alexander
polynomial invariants ($\det = 22.25$) and a "QR-NGC consensus protocol" — have
been deleted from the codebase and from this document. The Alexander polynomial
has no tamper-detection semantics even when correctly implemented, and the
previous `verify_lattice_signature` used no key material at all: it accepted any
self-consistent signature.

---

## 9. Monorepo Directory Sitemap

```text
AssureCode/
├── apps/
│   ├── ai-service/                  # FastAPI (Port 8000)
│   │   ├── app/routes/              # /embed, /match, /rag, /xai, /security-scan, /test-gen
│   │   ├── app/services/            # chunker, matchmaker, owasp_static, hyperbolic (baseline)
│   │   └── app/ports/               # embedder, rag_store, graph_repo, ledger_anchor,
│   │                                #   scope_log, llm_client
│   ├── api-gateway/                 # Fastify REST + WebSocket BFF (Port 4000)
│   │   ├── src/server.ts            # /initialize, /lock, /escrow, /score, /oracle, /drift, /verify
│   │   └── src/middleware/          # Idempotency (LRU + Postgres)
│   ├── ci-worker/
│   │   ├── src/ast-analyzer.ts      # @babel/parser: McCabe, Halstead, SEI MI
│   │   ├── src/security-auditor.ts  # OWASP 2025 dual-layer
│   │   ├── src/sandbox/             # docker-sandbox, node-permission-sandbox, egress-guard
│   │   └── src/audit-store.ts       # persists audit_results
│   ├── scope-guard/                 # FastAPI (Port 8001)
│   │   └── app/services/drift_detector.py   # CUSUM + conformal test martingale
│   ├── settlement-worker/
│   ├── web/
│   │   └── src/components/          # ContractInitialization, VerificationDashboard,
│   │                                #   XaiTrustScoreView, EscrowSettlementView
│   └── webhook-ingest/
├── packages/
│   ├── config/                      # PG pool, TLS pinning, .env loading
│   ├── event-bus/                   # In-memory / Redis + OutboxRelay
│   ├── ledger-client/
│   │   ├── src/canonical.ts         # RFC 8785
│   │   ├── src/merkle.ts            # RFC 6962
│   │   ├── src/index.ts             # append, verifyChainDetailed, roots, proofs
│   │   └── src/ml_dsa.py            # FIPS 204 ML-DSA-87
│   ├── oracle/                      # The single definition of the settlement gate
│   ├── shared/  razorpay-adapter/  kyc-adapter/  telemetry/
├── configs/
│   └── c1_rules.json                # Pre-registered drift decision rules (frozen PRE_DATA)
├── infra/
│   ├── certs/supabase-ca-bundle.crt
│   └── migrations/postgres/         # V001__init.sql .. V009__canonical_hash_and_merkle.sql
├── tools/
│   ├── eval/matchmaking_eval.py     # N=100/1000 retrieval eval + w1/w2/w3 ablation
│   ├── benchmark.js                 # Live HTTP contract-flow benchmark
│   ├── analyze_benchmark.py         # Generates docs/benchmarks/BENCHMARK_REPORT.md
│   ├── calibrate_scope_threshold.py
│   ├── sign_merkle_root.py
│   ├── verify_owasp_2025_cloudflare.py
│   ├── verify_scope_guard_live.py
│   ├── verify_phase4_live.py        # drift detector
│   ├── verify_phase5_live.mjs       # trust score + oracle
│   └── verify_phase8_live.mjs       # Merkle tree + ML-DSA
├── docs/benchmarks/                 # BENCHMARK_REPORT.md, MATCHMAKING_REPORT.md + raw JSON
└── package.json
```

---

## 10. Setup, Verification & Operations Manual

### Prerequisites
Node.js ≥ 20 · Python ≥ 3.10 · Git · Docker (optional — the sandbox falls back
to the Node-permission adapter and reports the reduced threat model)

### Installation
```bash
git clone https://github.com/Suhaskumard/AssureCode.git
cd AssureCode
npm install
```

### Running services
```bash
npm run dev:gateway     # http://localhost:4000
npm run dev:web         # http://localhost:3000
```

### Test suites
```bash
npm test
cd apps/ai-service   && .venv/Scripts/python -m pytest -q
cd apps/scope-guard  && ../ai-service/.venv/Scripts/python -m pytest -q
python -m pytest packages/ledger-client/test/test_ml_dsa.py -q
```

The scope guard has no virtualenv of its own and is run under ai-service's. It
imports the retrieval and anchoring adapters from `apps/ai-service/app/ports`
so that one implementation of the pgvector query and the genesis-hash lookup
serves both services, and ai-service's venv is where those dependencies are
installed. Note that `npm test` is the entry point for the JS suites, not
`npm test --workspaces`: the latter drops the root script's `--if-present` and
fails on `apps/web`, which has no test script.

### Verification harnesses

```bash
npm run verify
```
Runs the web build check, a reduced matchmaking evaluation, and the contract
benchmark. **`tools/benchmark.js` exits non-zero when the gateway is
unreachable** — it never falls through to simulation.

```bash
python tools/eval/matchmaking_eval.py       # N=100/1000, ablation, writes both reports
python tools/verify_owasp_2025_cloudflare.py
python tools/verify_scope_guard_live.py
python tools/verify_phase4_live.py          # drift detector
node   tools/verify_phase5_live.mjs         # trust score + settlement oracle
node   tools/verify_phase8_live.mjs         # Merkle tree + ML-DSA root signing
node   tools/benchmark.js && python tools/analyze_benchmark.py
```

---

## 11. Measured Results, Status & Known Limitations

Every figure below names the command that produces it. Nothing here is an
estimate.

### Verification status

| Harness | Result |
|---|---|
| `npm test` | 120 passing, 2 skipped, 0 failing |
| `apps/ai-service` pytest | 63 passing |
| `apps/scope-guard` pytest | 29 passing |
| `test_ml_dsa.py` | 18 passing |
| `verify_phase4_live.py` | 18 / 18 |
| `verify_phase5_live.mjs` | 33 / 33 |
| `verify_phase8_live.mjs` | 29 / 29 |

### Matchmaking — `tools/eval/matchmaking_eval.py`

Real `all-MiniLM-L6-v2`, 24 authored queries over 8 domains, synthetic pool.
Full tables in `docs/benchmarks/MATCHMAKING_REPORT.md`.

| N = 1000, shipped weights | P@1 | P@5 | MRR | nDCG@10 |
|---|---|---|---|---|
| queries naming the technology | 0.750 | 0.837 | 0.854 | 0.829 |
| queries describing the outcome only | 0.375 | 0.325 | 0.484 | 0.275 |

The gap between those two rows is the measurement that separates semantic
matching from string overlap, and it is large. The system is closer to a robust
keyword matcher than to a semantic one.

Latency: **84.7 ms warm mean, 108.4 ms p95** at N = 1000. The first query of a
process additionally pays N sequential profile embeds (36.6 s at N = 1000),
because `Matchmaker` caches lazily.

**Weight ablation over all 231 simplex settings:** the shipped
(0.50, 0.35, 0.15) ranks **66 of 231**; the retrieval optimum sits near
$w_1 = 0.95$. Trust and delivery count are properties of the freelancer, not of
the query, so they can only reorder a domain match, never sharpen it. That is an
argument about *retrieval*, not proof the weights are wrong — trust is in the
score deliberately, because the product ranks who should be hired, not who is
most textually similar. What the ablation establishes is that the split has
never been measured against either goal.

### Scope guard — `node tools/benchmark.js`

Over 50 contracts against live services, `--concurrency 1`:

| Metric | Before | After |
|---|---|---|
| Accuracy | 36% | **68%** |
| Precision | 100% | **100%** |
| Recall | 20% | **60%** |
| F1 | 33.33% | **75%** |
| Confusion | TP 8, TN 10, FP 0, FN 32 | TP 24, TN 10, FP 0, FN 16 |

Two changes produced this, and the first mattered more than the threshold:

1. **`chunk_text` was collapsing a contract into one chunk.** It split the
   requirements into units and then greedily packed them back up to
   `target_chars`; a five-requirement contract is ~340 characters, so all five
   became a single blended vector. Retrieval had one candidate, which made
   top-$k$ ranking a no-op, and a message about any one requirement was scored
   against the average of five. It now emits one chunk per semantic unit.
2. **The threshold was re-derived** on the real ingestion path, split by
   contract, against a policy-weighted objective (§4.4).

**16 false negatives remain, and recall is still the weak side.** Some are the
fixture's own labelling — `"Fix the cyclomatic complexity warning in the
database connection handler"` is labelled in-scope against a contract about
login sessions and scores 0.089, which no threshold rescues without destroying
precision. That is a reason to distrust the fixture, not evidence the guard is
fine. The failure direction remains the safer one for a payment system.

### Known limitations

1. **The drift detector is implemented and tested, and wired to a synthetic
   calibration set.** The conformal guarantee needs a labelled in-scope residual
   set from real traffic, which does not exist in this repository. The shipped
   default (`infra/calibration/scope_drift_synthetic_t2.json`, wired through
   compose and the k8s ConfigMap) is **random floats, not measured residuals**;
   it makes the endpoint answerable instead of returning 503 to every caller.
   `SCOPE_DRIFT_CALIBRATION_SYNTHETIC=1` marks it as such, and that flag travels
   into the drift response *and* the ledger record. With the variable unset the
   detector still refuses to construct rather than invent a default.
   **No false-alarm rate is claimed, and none may be derived from this file.**
   Building the real set is `tools/eval/build_t2_calibration.py`, gated on the
   annotator-agreement threshold frozen in `configs/c1_rules.json`.
2. **Legacy ledger rows predate V009** and are reported `unverifiable`, not
   `verified` (17 rows at the last verification run).
3. **Redis was unavailable for the recorded benchmark run.** Latencies come from
   the in-process event bus and understate a deployed configuration.
4. **Concurrency is limited by a single uvicorn worker.** At concurrency 5 the
   gateway's fire-and-forget ingest hits its 10 s timeout under CPU-bound torch.
5. **Single-platform evaluation.** No comparison against a deployed system, and
   no human study of whether flagged messages match user judgement.
6. **The matchmaking pool and queries are both authored here.** The evaluation
   measures whether the pipeline retrieves the domain it was asked for out of a
   synthetic population; it is not evidence about real hiring outcomes, which
   would require logged hiring decisions.
7. **TLS pinning is trust-on-first-use.** The Supabase root CA fingerprint
   should be verified out-of-band against the dashboard.

### What this document does not claim

There is no sign-off asserting that everything herein is implemented, tested,
and empirically verified. Previous revisions carried one. It was not true, and a
blanket assertion is worth less than the per-claim commands above — each of
which can be run.
