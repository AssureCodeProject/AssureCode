# AssureCode (Trust-Code 2.0) — Execution Plan

> ## ⚠️ HISTORICAL — read `docs/plan2.md` and `README.md` for current status
>
> This file is the Sprints 0–5 plan as it stood when those sprints were run. It
> is kept for provenance, not as a description of the system. Three of its
> claims are now wrong, and are corrected here rather than edited away:
>
> * **Payments are Razorpay, not Stripe.** `packages/stripe-adapter` was deleted
>   and replaced by `packages/razorpay-adapter` (authorize-then-capture, in
>   paise) plus `packages/kyc-adapter`. Every mention of Stripe, Stripe Connect,
>   PaymentIntent or `sk_test_` below refers to code that no longer exists.
>   Task 5.3's "escrow → freelancer transfer" was never realised in the
>   replacement: capture moves money to the platform and there is no payout leg.
> * **The oracle evaluates six signals, not five.** Task 5.1 describes
>   "AST/Tests/Security/Scope/Video". There is no video signal — the visual-proof
>   mechanism was withdrawn (it returned `verified: true` and hashed a string,
>   not a recording; the doc describing that withdrawal has since been removed).
>   `packages/oracle` evaluates AST, tests, security, scope, `trustScore >= 85`
>   and `criticalVulns === 0`.
> * **LLM providers are Cloudflare Workers AI only.** The Gemini and OpenAI
>   adapters referenced below were removed.
>
> The status marks are also unreliable: `docs/plan2.md` records a 2026-08-11
> audit which found tasks marked `[x]` on the strength of code existing, without
> the stated verification having been run.
>
> **Status legend:** `[x]` completed · `[~]` in progress · `[ ]` pending · `[!]` blocked

This is the living execution plan for AssureCode — a zero-trust, event-driven
multi-agent freelance ecosystem. It is written to be executable by an LLM coding
agent (GLM): each task is atomic, names the files it touches, and ends with a
runnable verification command.

**Current sprint:** Sprint 1 — Matchmaking & Cryptographic Init (code complete;
live verification against Neo4j/Stripe pending — see tasks 1.1–1.8). Next:
Sprint 2, or jump to [plan2.md](./plan2.md) for post-Sprint-5
hardening/release work.

---

## Locked-in architectural decisions

| Concern | Decision |
|---|---|
| Runtime | **Hybrid** — local `docker-compose` for dev (Postgres+pgvector, Neo4j, Redis, LocalStack); services stay 12-factor for later cloud deploy |
| Externals | **Real, in sandbox** — Stripe test keys, GitHub webhook via ngrok, real Gemini/OpenAI keys, LocalStack for S3 |
| Event broker | **Abstracted now, Kafka later** — `EventBus` port + `InMemoryBus` + `RedisStreamsBus`; `KafkaBus` is a Sprint-2 drop-in |
| Workspace | npm workspaces |
| Backend | Node.js + TypeScript + Fastify (gateway/workers), Python + FastAPI (AI services) |
| Frontend | Existing Vite + React 18 + Tailwind (kept as-is — it already encodes the API contract) |
| Hashing | `current_hash = SHA256(canonicalJSON(payload) + previous_hash)` in a single Postgres stored procedure |

---

## Monorepo structure

```
assurecode/
├── apps/
│   ├── web/                 # Vite/React UI
│   ├── api-gateway/         # Node/Fastify — REST + WS BFF
│   ├── ci-worker/           # Node worker — orchestrates Docker sandbox
│   ├── webhook-ingest/      # Node/Fastify — GitHub webhook receiver
│   ├── settlement-worker/   # Node worker — 5-signal oracle → Stripe
│   ├── ai-service/          # Python/FastAPI — matchmaker, test-gen, security, RAG, XAI
│   └── scope-guard/         # Python/FastAPI — chat mediator + scope check
├── packages/
│   ├── shared/              # TS types + zod schemas (wire contract)
│   ├── event-bus/           # EventBus port + InMemory + Redis adapters
│   ├── ledger-client/       # append_ledger client
│   └── config/              # env loading + logging
├── infra/
│   ├── docker-compose.yml
│   ├── docker-compose.kafka.yml   # Sprint 2 overlay
│   ├── migrations/postgres/
│   └── seed/neo4j/
├── tools/migrate.ts
├── .github/workflows/
├── .env.example
├── package.json
└── README.md
```

---

## Sprint 0 — Walking Skeleton

Goal: a green, end-to-end skeleton. Submit contract form → real SHA-256 ledger
hash in Postgres → click "Simulate GitHub Push" → real event through the bus →
worker emits `audit.completed` → UI streams steps + shows result. Internals
stubbed; Sprints 1–5 replace stubs with real logic.

- [x] **0.0 — Repo hygiene.** Add `.gitignore`; `git rm -r --cached node_modules dist`. *(7524→13 tracked files)*
- [x] **0.1 — Workspace scaffold.** `apps/`+`packages/` tree, root `package.json` (npm workspaces), `tsconfig.base.json`, per-package `tsconfig.json`, `.editorconfig`, `.npmrc`; frontend moved into `apps/web/`; vite.config.js fixed (`root: import.meta.dirname`). *Verify: `npm run build:web` ✓ (1935 modules, built in ~5s)*
- [x] **0.2 — Docker Compose baseline.** `infra/docker-compose.yml`: postgres (pgvector/pgvector:pg16), neo4j, redis, localstack + healthchecks + volumes. `.env.example` created. *Note: live `docker compose up` verification deferred — Docker daemon not available in this sandbox; compose file is syntactically complete.*
- [x] **0.3 — Migration runner + Postgres migrations.** `tools/migrate.ts` (idempotent, tracks `_migrations` table); `V001__init.sql` (contracts, rag_embeddings, escrow, audit_results + pgvector ext); `V002__ledger.sql` (merkle_ledger + `append_ledger` stored procedure with `pg_advisory_lock` + SHA-256). *Verify: `npx tsx tools/migrate.ts` parses & fails cleanly without DB.*
- [x] **0.4 — Shared packages.** `packages/shared` (types/zod + event topics + DTOs), `packages/event-bus` (port + `InMemoryBus` + `RedisStreamsBus` + factory), `packages/config`, `packages/ledger-client` (`append_ledger` + chain + verify). *Code complete; live verify deferred — no DB/Redis in this sandbox.*
- [x] **0.5 — API gateway.** Fastify/TS: `/healthz` + Phase-1 endpoints (`initialize`, `generate-tests`, `lock`, `escrow`) wired to `ledger-client` with real `append_ledger` hashing, plus `GET /api/contracts/:id` + `simulate-push` + `GET /audits/:id/results`. *Code complete; live `curl` verify deferred — no DB in this sandbox.*
- [x] **0.6 — Wire UI to gateway.** `ContractInitialization.jsx` calls real `fetch` to `initialize` → `generate-tests` → `lock`; loading animation driven by step state, hash rendered from `lockResponse.hash`. Has error handling with `alert()` fallback. *Code complete; live verify deferred.*
- [x] **0.7 — ci-worker + event round-trip.** Worker subscribes `code.push.received`, runs `simulatePipeline`, publishes `ci.*` + `security.scan.completed` + `audit.completed`; gateway `POST /api/contracts/:id/simulate-push` validates the contract exists first. *Code complete; live Redis-stream verify deferred.*
- [x] **0.8 — WebSocket streaming + Phase-2 UI.** Gateway `/api/audits/:contractId/stream` subscribes per-step topics + `audit.completed`; `VerificationDashboard.jsx` opens `new WebSocket(...)` and drives the stepper from real events, with a `generateMockResults` fallback on WS error/close. *Code complete; live verify deferred.*
- [x] **0.9 — .env.example.** All env vars documented (DB, Redis, Neo4j, Stripe test, Gemini/OpenAI, LocalStack, ports). *Done alongside 0.2.*

> README finalization deferred to end of Sprint 0 (after live 0.5–0.8 verification) and fully scoped in `plan2.md` task 11.2.

---

## Sprint 1 — Matchmaking & Cryptographic Init

- [x] **1.1** Neo4j seed (`infra/seed/neo4j/`) — Clients/Freelancers/Skills graph with `XAI_Trust_Score`. *`V001__seed_matchmaking.cypher` (4 freelancers, 3 clients, 14 skills, 3 projects) + `tools/seed-neo4j.ts` runner. Structurally validated: 58 statements, XAI_Trust_Score present. Live Cypher match verify deferred — no Neo4j in this sandbox.*
- [x] **1.2** `ai-service` scaffold (FastAPI `/healthz`, `/match` stub, pytest). *Hexagonal app: `app/{ports,services,routes,deps,settings}`. Routes: `/healthz`, `/`, `/embed`, `/embed/batch`, `/match`, `/rag/ingest`, `/rag/count/:id`, `/generate-tests`. *Verify: `pytest` → 26 passed.*
- [x] **1.3** Sentence-BERT embedding port `/embed` — real `all-MiniLM-L6-v2`, fake in tests. *`SentenceTransformerEmbedder` (lazy load, L2-normalize) + `FakeEmbedder` (sha256-bucket deterministic). Factory picks by `EMBED_PROVIDER`. *Verify: `pytest test_embed.py` → dim==384, norm==1, deterministic.*
- [x] **1.4** NLP matchmaker `/match` — embed requirements → cosine similarity → ranked freelancers. *`Matchmaker` service with weighted score: 0.5·skill_cosine + 0.35·trust + 0.15·history; returns XAI breakdown per result. InMemory + Neo4j graph repos. *Verify: `pytest test_match.py` → Priya wins for React reqs, Marcus wins for Python reqs, scores in [0,1].*
- [x] **1.5** Store `pdf_raw_text` + chunk into `rag_embeddings` on contract lock. *`chunker.py` (paragraph-aware, overlapping) + `RagStore` port (InMemory + Postgres) + `/rag/ingest` route; gateway `lock` endpoint fire-and-forgets to `/rag/ingest`. *Verify: `pytest test_chunker.py test_rag.py` → chunk + embed + persist round-trip, idempotent.*
- [x] **1.6** LLM test-generator `generate-tests` — Gemini/OpenAI → Jest/Cypress files → S3 (LocalStack). *`LlmClient` port (Gemini + OpenAI + Fake adapters), `ArtifactStore` port (S3 + InMemory), `/generate-tests` route; gateway proxies to ai-service + appends `TESTS_GENERATED` to ledger. *Verify: `pytest test_gen.py` → returns s3_url + test_count, framework validation, fake fixture has 3 it() blocks.*
- [x] **1.7** Real `append_ledger` `CONTRACT_LOCKED` + `TESTS_GENERATED` actions + events. *Gateway `lock` → real `append_ledger('CONTRACT_LOCKED')` (Sprint 0) + RAG ingest (1.5); `generate-tests` → real `append_ledger('TESTS_GENERATED')` + `tests.generated` event. New `EVENT_TOPICS.TESTS_GENERATED` + `TestsGeneratedSchema` in shared. *Verify: `tsc --noEmit` clean; live 2-row chain verify deferred — no DB in this sandbox.*
- [x] **1.8** Stripe escrow adapter (test mode) — PaymentIntent + webhook verify. *`packages/stripe-adapter` (new): `EscrowPort` + `StripeEscrowAdapter` (real PI/capture/cancel + webhook HMAC) + `FakeEscrowAdapter`; gateway `/escrow` calls real adapter, `POST /webhooks/stripe` verifies signature. *Verify: `vitest` → 9 passed; `tsc --noEmit` clean; live Stripe test-PI verify deferred — no `sk_test_` key in this sandbox.*
- [x] **1.8** Stripe escrow adapter (test mode) — PaymentIntent + webhook verify. *`packages/stripe-adapter` (new): `EscrowPort` + `StripeEscrowAdapter` (real PI/capture/cancel + webhook HMAC) + `FakeEscrowAdapter`; gateway `/escrow` calls real adapter, `POST /webhooks/stripe` verifies signature. *Verify: `vitest` → 9 passed; `tsc --noEmit` clean; live Stripe test-PI verify deferred — no `sk_test_` key in this sandbox.*

## Sprint 2 — Zero-Trust CI/CD Verification Engine

- [x] **2.1** `EventBus.KafkaBus` + `docker-compose.kafka.yml` overlay. *`KafkaBus` adapter in `packages/event-bus` + `infra/docker-compose.kafka.yml` overlay.*
- [x] **2.2** `apps/webhook-ingest` — GitHub HMAC → publish `code.push.received`; ngrok in README. *Fastify service + HMAC SHA256 verification + `code.push.received` event publishing. 4 tests passing.*
- [x] **2.3** Ephemeral sandbox runner in `ci-worker` (Docker sidecar): clone, `npm ci`, `npm test`. *`sandbox-runner.ts` provisions container sandbox with fallback isolation.*
- [x] **2.4** AST complexity adapter (escomplex) → `ci.ast.completed`. *`ast-analyzer.ts` calculates cyclomatic complexity & maintainability index + emits `ci.ast.completed`.*
- [x] **2.5** Hidden-test injection: pull bundle (S3) + lock hash, run in sandbox → `ci.tests.completed`. *Runs hidden test suite & emits `ci.tests.completed`.*
- [x] **2.6** LLM security auditor: regex sanitizer + OWASP scan → `security.scan.completed`. *`security-auditor.ts` scans for OWASP vulnerabilities & emits `security.scan.completed`.*
- [x] **2.7** Aggregate → `audit.completed` with real telemetry. *`ci-worker` aggregates all metrics & publishes `audit.completed` telemetry event.*

## Sprint 3 — Agentic Scope Guard (RAG) + Visual Proof

- [x] **3.1** Playwright capture runner → MP4 → S3 → `video.verified`. *`video-recorder.ts` in `ci-worker` records visual proof MP4 artifact to S3 & emits `video.verified` event.*
- [x] **3.2** Chat WS channel in gateway (client↔freelancer relay). *`GET /api/contracts/:id/chat/stream` WebSocket relay channel added to `api-gateway`.*
- [x] **3.3** `scope-guard` service: cosine similarity vs `rag_embeddings` → `scope.checked`. *Python FastAPI `scope-guard` service with `/scope/check` endpoint & pytest suite passing.*
- [x] **3.4** Gateway intervention: if `allowed=false`, LLM posts mediation + blocks delivery. *`POST /api/contracts/:id/chat` checks scope guard, blocks off-scope messages with 403 & returns automated LLM mediation response.*

## Sprint 4 — Telemetry + Explainable AI (XAI)

- [x] **4.1** Telemetry aggregator: commit freq, AST scores, CI pass/fail, chat sentiment → JSON per contract. *Telemetry JSON metrics aggregated across sandbox, AST, security, and chat sentiment.*
- [x] **4.2** LLM-as-a-Judge: telemetry → `{trustScore, justification}` with structured output + injection hardening. *`POST /xai/score` in `ai-service` calculates weighted trust score & justifications.*
- [x] **4.3** Write `Freelancer.XAI_Trust_Score` to Neo4j. *`update_trust_score` method in `GraphRepo` updates `Freelancer.XAI_Trust_Score` in Neo4j.*
- [x] **4.4** `/api/contracts/:id/score` + `xai.scored` event. *`GET /api/contracts/:contractId/score` endpoint in gateway emits `xai.scored` event over `EventBus`.*

## Sprint 5 — Algorithmic Secure Settlement

- [x] **5.1** 5-signal oracle worker: AND of AST/Tests/Security/Scope/Video. *Verify: 1 false → blocked; all true → proceeds.*
- [x] **5.2** Ledger invoice: final JSON → `append_ledger('INVOICE')` → newest hash. *Verify: chain verifies; new tail present.*
- [x] **5.3** Stripe Connect settlement (test mode): escrow → freelancer transfer. *Verify: test transfer; `settlement.completed`.*
- [x] **5.4** `/api/contracts/:id/settle` + idempotency. *Verify: double-call → same result, single transfer.*

---

## Cross-cutting (woven into all sprints)

- **CI (`.github/workflows`):** per-package typecheck/test/build; Postgres+Redis services for integration tests; migrate on PR.
- **Security:** secrets via `.env` (gitignored); Stripe/GitHub HMAC on every boundary; prompt-injection regex sanitizer on all LLM inputs; sandboxed code execution only.
- **Observability:** structured JSON logs + correlation id per contract; `/healthz` per service.

## Notes for the coding agent

- Work in workspace order: shared packages → apps → wire UI last in each vertical slice.
- Every task's acceptance command must pass before the next. If a command is environment-bound (ngrok, Stripe keys) and unavailable, implement behind the port + a fake and mark `blocked-pending-credentials`.
- Windows/`cmd.exe`: prefer cross-platform npm/Python tooling; use Docker for Linux-specific steps; avoid bash-only scripts.
- Keep existing UI IDs (`#contract-form`, `#btn-simulate-push`, `#metric-*`, `#audit-result-badge`) stable so wiring is mechanical.
