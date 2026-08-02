# AssureCode (Trust-Code 2.0) — Master Specifications & Execution Plan Analysis

## Executive Summary

**AssureCode (Trust-Code 2.0)** is a zero-trust, event-driven multi-agent freelance ecosystem designed to automate and cryptographically secure the entire software freelancing lifecycle—from developer matchmaking to automated escrow settlement.

This document synthesizes and details the complete master specifications and architectural requirements extracted from `ORIGINAL_REQUEST.md`, `plan.md`, and `plan2.md`. It outlines the 5 core functional phases, the 6 post-functional hardening sprints (Sprints 6–11), the complete global technology stack, and the explicit verification criteria governing system readiness.

---

## 1. Core Architecture & The 5 Master Phases

The core functionality of AssureCode spans 5 interconnected, event-driven phases (Sprint 1 through Sprint 5), preceded by Sprint 0 (Walking Skeleton infrastructure).

### Phase 1: AI Matchmaking & Cryptographic Initialization (Sprint 1)
- **Objective**: Match client contract requirements with qualified freelancers using NLP semantic search over a Neo4j skills graph, chunk and store contract specifications into PostgreSQL `pgvector` for downstream scope checking, generate automated LLM test suites stored in S3, initialize the cryptographic Merkle hash chain, and lock client funds in Stripe Escrow.
- **Key Deliverables & Components**:
  - **Neo4j Graph Database**: Graph model storing `Clients`, `Freelancers`, `Skills`, and `Projects` nodes with developer `XAI_Trust_Score` attributes (`infra/seed/neo4j/V001__seed_matchmaking.cypher` + `tools/seed-neo4j.ts`).
  - **FastAPI AI Service (`apps/ai-service`)**: Hexagonal service providing `/embed` (Sentence-BERT `all-MiniLM-L6-v2`), `/match` (weighted cosine similarity + trust score ranking: `0.5*skill + 0.35*trust + 0.15*history`), `/rag/ingest`, and `/generate-tests`.
  - **RAG Contract Chunking**: Paragraph-aware overlapping text chunker (`chunker.py`) inserting vector embeddings into PostgreSQL `rag_embeddings` (`pgvector`).
  - **LLM Test Generator**: Dual Gemini/OpenAI adapter generating Jest/Cypress test bundles uploaded to LocalStack S3 (`ArtifactStore`).
  - **Cryptographic Merkle Ledger Init**: Gateway triggers `append_ledger('CONTRACT_LOCKED')` and `append_ledger('TESTS_GENERATED')` stored procedure in PostgreSQL (`V002__ledger.sql`), forming an immutable SHA-256 hash chain:
    $$\text{current\_hash} = \text{SHA256}(\text{canonicalJSON}(\text{payload}) + \text{previous\_hash})$$
  - **Stripe Escrow Adapter (`packages/stripe-adapter`)**: Supports PaymentIntent creation, capture, cancellation, and HMAC webhook verification (`POST /webhooks/stripe`).

### Phase 2: Zero-Trust CI/CD Verification Engine (Sprint 2)
- **Objective**: Execute untrusted code submissions from GitHub in isolated Docker sidecar sandboxes, evaluate AST code complexity, inject hidden S3 test suites, perform OWASP security analysis via LLM/regex sanitization, and emit aggregated execution telemetry.
- **Key Deliverables & Components**:
  - **Event Broker Overlay**: Abstracted `EventBus` port supporting `InMemoryBus`, `RedisStreamsBus`, and `KafkaBus` overlay (`infra/docker-compose.kafka.yml`).
  - **GitHub Webhook Receiver (`apps/webhook-ingest`)**: Fastify service validating GitHub HMAC SHA-256 signatures before publishing `code.push.received` events.
  - **Ephemeral Sandbox Runner (`apps/ci-worker`)**: Isolated Docker container sidecar orchestrator (`sandbox-runner.ts`) running `npm ci` and `npm test` under strict CPU/RAM/network constraints.
  - **AST Complexity Analyzer**: Code complexity engine using `escomplex` (`ast-analyzer.ts`) calculating cyclomatic complexity and maintainability index, emitting `ci.ast.completed`.
  - **Hidden-Test Injection**: Pulls hidden test suite bundle from S3 using locked contract hash and runs suite inside sandbox, emitting `ci.tests.completed`.
  - **LLM & Regex Security Auditor**: OWASP static analysis scanner (`security-auditor.ts`) detecting vulnerabilities and prompt injection attempts, emitting `security.scan.completed`.
  - **Telemetry Aggregator**: Emits aggregated `audit.completed` event containing full pipeline telemetry.

### Phase 3: Agentic AI Scope Guard (RAG) + Visual Proof (Sprint 3)
- **Objective**: Capture headless E2E visual proof of work via Playwright, establish a real-time WebSocket chat channel, analyze client-freelancer communications against contract RAG embeddings, and automatically intercept/mediate scope creep.
- **Key Deliverables & Components**:
  - **Visual Proof Recording (`video-recorder.ts` in `apps/ci-worker`)**: Runs Playwright E2E browser tests, captures MP4 video artifact, uploads to LocalStack S3, and emits `video.verified`.
  - **Gateway Chat WebSocket Relay**: Fastify WebSocket endpoint (`GET /api/contracts/:id/chat/stream`) relaying messages between client and freelancer.
  - **Scope Guard Service (`apps/scope-guard`)**: Python FastAPI microservice evaluating chat messages via cosine similarity against `rag_embeddings` in PostgreSQL, emitting `scope.checked`.
  - **Automated Scope Intervention**: Gateway `POST /api/contracts/:id/chat` checks scope guard. If off-scope (`allowed=false`), gateway responds with HTTP 403, triggers LLM automated mediation response, and blocks unauthorized scope expansion.

### Phase 4: Telemetry Harvesting & Explainable AI (XAI) (Sprint 4)
- **Objective**: Aggregate code, test, security, and chat metrics into a contract telemetry report, use LLM-as-a-Judge to evaluate developer performance, calculate a weighted XAI Trust Score with natural language justification, and update the Neo4j graph.
- **Key Deliverables & Components**:
  - **Telemetry Aggregator**: Combines commit frequency, AST complexity metrics, unit/integration pass rates, and chat sentiment analysis into a single JSON artifact per contract.
  - **LLM-as-a-Judge (`POST /xai/score` in `apps/ai-service`)**: Evaluates structured telemetry against quality prompts with prompt injection hardening, returning structured JSON `{trustScore, justification}`.
  - **Neo4j Graph Synchronization**: `GraphRepo.update_trust_score` method updating `Freelancer.XAI_Trust_Score` in Neo4j.
  - **Gateway Trust Score API**: Gateway endpoint `GET /api/contracts/:id/score` emitting `xai.scored` over `EventBus`.

### Phase 5: Algorithmic Secure Settlement (Sprint 5)
- **Objective**: Validate contract deliverables using a 5-Signal Oracle, issue an immutable invoice on the Merkle ledger, execute automated Stripe Connect payment transfer from escrow to freelancer, and expose an idempotent settlement API.
- **Key Deliverables & Components**:
  - **5-Signal Oracle Worker (`apps/settlement-worker`)**: Evaluates boolean AND of 5 independent verification signals:
    1. **AST Complexity** (`ci.ast.completed` pass threshold)
    2. **Hidden Unit Tests** (`ci.tests.completed` pass)
    3. **OWASP Security Scan** (`security.scan.completed` zero high/critical)
    4. **Scope Guard Compliance** (`scope.checked` no unmediated scope breaches)
    5. **Playwright Visual Proof** (`video.verified` MP4 present)
    *Rule*: Any single false signal halts settlement; 5/5 true signals permit settlement.
  - **Merkle Ledger Invoice Append**: Executes `append_ledger('INVOICE')` PostgreSQL stored procedure to append invoice metadata to the tamper-evident hash chain.
  - **Stripe Connect Settlement**: Triggers `StripeEscrowAdapter` escrow capture and payout to freelancer's connected Stripe account, emitting `settlement.completed`.
  - **Idempotent Settlement Endpoint**: Fastify endpoint `POST /api/contracts/:id/settle`.

---

## 2. Post-Sprint 5 Hardening & Release Sprints (Sprints 6–11)

As detailed in `ORIGINAL_REQUEST.md` and `plan2.md`, Sprints 6 through 11 focus on enterprise resilience, observability, security hardening, quality gates, automated deployment, and release documentation.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Sprint 6: Resilience                               │
│ Idempotency Keys (Postgres) · DLQ (Redis) · Single-Fire Settlement          │
│ Ledger Verification API · Outbox Pattern · LLM/S3 Fallback                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Sprint 7: Observability                             │
│ Correlation ID Middleware · OpenTelemetry · Prometheus & Grafana            │
│ Health/Readiness Split · Financial Audit Trail · Alerting Rules             │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Sprint 8: Security Hardening                          │
│ HMAC Verification · Secret Hygiene Scan · Sandbox Egress Lockdown           │
│ Prompt Injection Firewall · Rate Limiting & Auth · Threat Model             │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Sprint 9: Test & Quality Gates                         │
│ Docker Test Harness (`npm run test:e2e`) · Bus Contract Tests               │
│ Golden Path E2E · Coverage Gate (≥70%) · Load Soak & Chaos Tests            │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Sprint 10: Deployment & Release                       │
│ Multi-stage Dockerfiles · Prod Compose Overlay · Auto-Migration & Seed       │
│ Config Fail-Fast · Release CI Pipeline · Rollback Strategy                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Sprint 11: Demo & Documentation                       │
│ Seeded Demo Data · Complete README · ARCHITECTURE.md & RUNBOOK.md           │
│ DEMO.md Script · Tag v1.0.0 Release                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Summary of Hardening Deliverables (Sprints 6–11):
- **Sprint 6 (Resilience & Failure Modes)**:
  - `6.1`: `V003__idempotency.sql` storing `idempotency_keys` table to cache and replay mutating gateway requests (`initialize`, `lock`, `generate-tests`, `escrow`, `settle`).
  - `6.2`: `RedisStreamsBus` exponential backoff retries (`MAX_RETRIES=3`), dead-letter streams (`*.dlq`), and `tools/replay-event.ts` utility.
  - `6.3`: `settlements` guard table (`contract_id UNIQUE`) enforcing transactional single-fire Stripe payout gating.
  - `6.4`: `GET /api/contracts/:id/verify` endpoint validating SHA-256 ledger integrity; returns HTTP 409 (`{ valid: false }`) on tampered rows.
  - `6.5`: `outbox` table pattern ensuring atomic DB-commit and Redis event publishing.
  - `6.6`: Graceful service fallbacks (LLM 503 retry-after handling, LocalStack/S3 local volume fallback `S3_FALLBACK_DIR`).
- **Sprint 7 (Observability & Operations)**:
  - `7.1`: Correlation ID middleware (`x-correlation-id`) tracing requests end-to-end across Node, Python, Redis, and Docker logs.
  - `7.2`: OpenTelemetry integration with local `otel-collector` and Jaeger UI.
  - `7.3`: Prometheus `/metrics` endpoints (`prom-client`, `prometheus-fastapi-instrumentator`) and Grafana dashboard (`infra/grafana/dashboards/assurecode.json`).
  - `7.4`: Split `/healthz` (liveness) and `/readyz` (readiness check for Postgres, Redis, Neo4j).
  - `7.5`: `payment_events` table for structured financial audit logging.
  - `7.6`: Automated Grafana alerting rules (DLQ depth, settlement failure rate, sandbox p95).
- **Sprint 8 (Security Hardening & Audit)**:
  - `8.1`: Constant-time HMAC SHA-256 verification on GitHub and Stripe webhook endpoints.
  - `8.2`: Secret sanitation scan script (`npm run secrets:scan`) and secretlint CI step.
  - `8.3`: Container sandbox egress lockdown (`--network=none` except allowlist, read-only rootfs, resource constraints).
  - `8.4`: Prompt injection firewall (structured JSON schema enforcement, input stripping).
  - `8.5`: `@fastify/rate-limit` rate limiting and Fastify authn layer.
  - `8.6`: `npm audit` and `trivy` container security scanning.
  - `8.7`: Complete threat model documentation (`docs/THREAT_MODEL.md`).
- **Sprint 9 (Test Coverage & Quality Gates)**:
  - `9.1`: Integration test harness (`infra/docker-compose.test.yml`, `npm run test:e2e`).
  - `9.2`: Cross-adapter event bus contract testing (`packages/event-bus/test/contract.spec.ts`).
  - `9.3`: Full pipeline golden-path E2E test.
  - `9.4`: Mandatory test coverage gate (≥70% code coverage across Node and Python packages).
  - `9.5`: Load soak testing script (`tools/load/soak.js` using `k6` for 50 concurrent runs).
  - `9.6`: Chaos engineering test verifying worker recovery via outbox and DLQ.
- **Sprint 10 (Deployment & Release)**:
  - `10.1`: Multi-stage Dockerfiles for all Node and Python services, nginx web server.
  - `10.2`: Production Compose overlay (`docker-compose.prod.yml`).
  - `10.3`: Automated idempotent database migration and Neo4j graph seeding on startup.
  - `10.4`: Strict environment variable fail-fast startup checks.
  - `10.5`: GitHub Actions release pipeline (`.github/workflows/release.yml`).
  - `10.6`: Rollback documentation (`docs/RELEASE.md`).
- **Sprint 11 (Demo, Docs & Release Handoff)**:
  - `11.1`: Seeded demo dataset (`infra/seed/demo/`).
  - `11.2`: Comprehensive `README.md` with architecture diagrams and quickstart commands.
  - `11.3`: Technical architecture documentation (`ARCHITECTURE.md`).
  - `11.4`: Operational runbook (`RUNBOOK.md`).
  - `11.5`: End-to-end demo script (`docs/DEMO.md`).
  - `11.6`: Repository cleanup and `CHANGELOG.md`.
  - `11.7`: Production tag `v1.0.0`.

---

## 3. Global Technology Stack Specifications

The table below maps the required technology stack to its architectural role and repository location:

| Component Category | Technology | Usage / Implementation Details | Repository Path |
|---|---|---|---|
| **Gateway & REST/WS** | Node.js (v20+), TypeScript, Fastify | API Gateway BFF, WebSockets streaming, Rate limiting, HMAC validation | `apps/api-gateway`, `apps/webhook-ingest` |
| **Worker Microservices** | Node.js, TypeScript | Sandbox execution orchestrator, 5-Signal Oracle settlement engine | `apps/ci-worker`, `apps/settlement-worker` |
| **AI / ML Microservices** | Python 3.10+, FastAPI | NLP matchmaking, Sentence-BERT embedding, RAG storage, Scope Guard, XAI scoring | `apps/ai-service`, `apps/scope-guard` |
| **Event Broker** | Redis Streams / Apache Kafka | Asynchronous event bus (`RedisStreamsBus`, `KafkaBus`), DLQ poison queues | `packages/event-bus`, `infra/docker-compose.kafka.yml` |
| **In-Memory Cache & Bus** | Redis (Alpine) | Event broker backing store, idempotency cache, pub/sub relay | `infra/docker-compose.yml` |
| **Relational & Vector DB** | PostgreSQL 16 + `pgvector` | Merkle SHA-256 hash ledger, contract metadata, vector embeddings (`rag_embeddings`), idempotency keys, outbox | `infra/migrations/postgres/`, `packages/ledger-client` |
| **Graph Database** | Neo4j 5 Community | Client-Freelancer-Skill network graph, storing `XAI_Trust_Score` | `infra/seed/neo4j/`, `apps/ai-service` |
| **Headless E2E Browser** | Playwright | Recording headless E2E test execution to MP4 video artifact for visual proof | `apps/ci-worker/src/video-recorder.ts` |
| **NLP Embedding Model** | Sentinel-BERT / Sentence-BERT | `all-MiniLM-L6-v2` (384-dimensional vector embeddings, L2 normalized) | `apps/ai-service/app/services/embedder.py` |
| **Agentic LLMs** | Gemini API / OpenAI API | Automated Jest/Cypress test generation, prompt sanitization, Chat scope mediation, LLM-as-a-Judge trust scoring | `apps/ai-service`, `apps/scope-guard` |
| **Payment Gateway** | Stripe Connect API | PaymentIntent creation, escrow holding, webhook verification, automated freelancer payouts | `packages/stripe-adapter`, `apps/api-gateway` |
| **Container & Storage Infra** | Docker, Docker Compose, LocalStack S3 | Multi-container stack, isolated code execution sandboxes, S3 artifact store | `infra/docker-compose.yml`, `apps/ci-worker` |
| **Observability & Ops** | OpenTelemetry, Prometheus, Grafana, Jaeger | Structured JSON logs, trace propagation (`x-correlation-id`), `/metrics` scraping, dashboard & alerts | `infra/grafana/`, `@opentelemetry/*`, `prom-client` |

---

## 4. Verification Criteria & Quality Acceptance Matrix

Every sprint in `plan.md` and `plan2.md` defines concrete verification criteria. The master project acceptance is governed by the following criteria matrix:

| Sprint / Feature | Specific Verification Command / Condition | Success Criteria |
|---|---|---|
| **Sprint 0: Skeleton** | `npm run build:web` | Monorepo builds cleanly (1935+ modules in ~5s) |
| **Sprint 1: Phase 1** | `pytest` in `apps/ai-service`, `vitest` in `packages/stripe-adapter` | 26+ Python tests pass; 9 Stripe adapter tests pass; `append_ledger` creates valid chain |
| **Sprint 2: Phase 2** | `npm test` in `apps/webhook-ingest` & `apps/ci-worker` | GitHub HMAC verification rejects tampered requests (HTTP 401); sandbox executes isolated tests |
| **Sprint 3: Phase 3** | `pytest` in `apps/scope-guard`, Playwright test execution | `video.verified` emitted with MP4 S3 URL; off-scope chat message returns HTTP 403 with LLM mediation text |
| **Sprint 4: Phase 4** | `POST /xai/score` in `apps/ai-service` | JSON output matches schema (`{trustScore, justification}`); Neo4j graph updates `Freelancer.XAI_Trust_Score` |
| **Sprint 5: Phase 5** | `POST /api/contracts/:id/settle` | 5-Signal Oracle verifies all 5 signals; `INVOICE` ledger row created; Stripe transfer executes cleanly |
| **Sprint 6: Resilience** | Replaying `POST /lock` or `/settle` twice with same `Idempotency-Key` | Identical cached JSON returned; single ledger append; concurrent `/settle` produces exactly 1 Stripe payout |
| **Sprint 6: Ledger Audit**| `GET /api/contracts/:id/verify` on tampered row | Returns HTTP 409 (`{ valid: false }`); untampered chain returns HTTP 200 (`{ valid: true }`) |
| **Sprint 7: Observability**| `grep` single correlation ID across gateway & worker logs | Complete execution trace visible across microservices; Prometheus `/metrics` and Grafana active |
| **Sprint 8: Security** | `npm run secrets:scan` & `trivy` container scan | Zero tracked secrets; zero HIGH/CRITICAL vulnerabilities in container images |
| **Sprint 9: Testing** | `npm run test:e2e` & coverage check | E2E integration pipeline green; overall code coverage ≥70% |
| **Sprint 10: Deploy** | `docker compose -f infra/docker-compose.yml up --build` | Entire multi-container stack boots healthy; `/readyz` endpoints return HTTP 200 |
| **Sprint 11: Release** | Fresh clone + setup script | Demo contract renders in Web UI out of the box; `v1.0.0` release tag validated |

---

## 5. Master Definition of Done (DoD)

The AssureCode system is classified as complete and production-ready when all 8 core DoD requirements are met:

1. **Sprint Status**: All tasks across Sprint 0 to Sprint 5 (`plan.md`) and Sprint 6 to Sprint 11 (`plan2.md`) are completed (`[x]`).
2. **One-Command Bootstrap**: `docker compose -f infra/docker-compose.yml up --build` successfully builds and launches the entire stack, pre-seeded with demo data, accessible at `http://localhost:3000` with all `/readyz` endpoints returning 200 OK.
3. **E2E Integration Test Suite**: `npm run test:e2e` passes both the golden path and scope-blocked path against the live stack from a clean clone.
4. **Quality & Security Gates**: Code coverage is ≥70% across Node.js and Python modules; `secretlint` and container scans return clean reports.
5. **Cryptographic Integrity**: The PostgreSQL Merkle ledger hash chain verifies end-to-end, and the automated tamper test confirms immediate detection (HTTP 409) upon modification of any historical block.
6. **Single-Fire Idempotent Payouts**: Concurrent settlement requests execute exactly one Stripe transfer and one `settlement.completed` event.
7. **Documentation Complete**: `README.md`, `ARCHITECTURE.md`, `RUNBOOK.md`, `DEMO.md`, `THREAT_MODEL.md`, and `CHANGELOG.md` are comprehensive, accurate, and merged.
8. **Tagged Release**: Version tag `v1.0.0` is tagged, release CI pipeline passes, and multi-container images deploy cleanly under production profile settings.
