# AssureCode (Trust-Code 2.0) — Zero-Trust Event-Driven Freelance Escrow

> Version 1.0.0-alpha.0 · Node 20+ / TypeScript · Python 3.11 / FastAPI · React 18 / Vite

AssureCode replaces subjective freelance-platform ratings with measurements a
third party can re-derive: a tamper-evident cryptographic ledger, an ephemeral
zero-trust CI sandbox, dual-layer OWASP auditing, and a deterministic trust
score that gates escrow release.

**This is an academic research artifact, not a production payment system.** Read
[Status & Limitations](#status--limitations) before drawing conclusions from
anything here — several headline components are deliberately unfinished and say
so at runtime.

---

## The pipeline

| Phase | What happens | Where |
|---|---|---|
| 1 | Contract created, requirements embedded, genesis hash `H0` written | `api-gateway`,`ledger-client` |
| 2 | Pushed code audited in an isolated sandbox (AST + dual-layer OWASP + generated tests) | `ci-worker`, `ai-service` |
| 3 | Chat messages checked against the contract as originally hashed | `scope-guard` |
| 4 | Explainable trust score computed from the audit signals | `ai-service` |
| 5 | Oracle evaluates the gate; escrow captured only if it approves | `oracle`, `settlement-worker` |

The money gate has one definition, in `packages/oracle`:
`trustScore >= 85 && criticalVulns === 0`, plus four CI signals (AST,
tests, security, scope) — **six signals in total**. Older documents call this a
"5-signal oracle"; the code is authoritative.

---

## Repository layout

```
AssureCode/
├── apps/
│   ├── web/                  React 18 / Vite front end (4-phase UI, live endpoints only)
│   ├── api-gateway/          Fastify REST + WebSocket gateway, JWT/RBAC, idempotency
│   ├── ci-worker/            Sandboxed audit engine (Babel AST, OWASP, egress guard)
│   ├── ai-service/           FastAPI :8000 — embeddings, matchmaking, RAG, XAI, test-gen
│   ├── scope-guard/          FastAPI :8001 — scope decisions + CUSUM/conformal drift detector
│   ├── settlement-worker/    Advisory-lock single-fire settlement daemon
│   └── webhook-ingest/       GitHub webhook HMAC receiver
│
├── packages/
│   ├── ledger-client/        RFC 8785 canonical JSON, RFC 6962 Merkle, FIPS 204 ML-DSA-87
│   ├── oracle/               The settlement gate — single definition, used by 2 services
│   ├── event-bus/            InMemory / Redis Streams / Kafka + transactional outbox relay
│   ├── razorpay-adapter/     Authorize-then-capture escrow (real HMAC verification)
│   ├── kyc-adapter/          KYC port — FAKE implementation only, see Limitations
│   ├── config/               Zod env schema, pinned-CA Postgres TLS, correlation ids
│   ├── telemetry/            OpenTelemetry tracing + Prometheus metrics
│   └── shared/               Zod schemas & event topic contracts
│
├── infra/
│   ├── docker-compose.yml    Full stack: data plane + 7 services + observability
│   ├── docker/               8 Dockerfiles
│   ├── k8s/                  15 manifests + secrets overlays
│   ├── migrations/postgres/  V001 … V014, forward-only
│   └── observability/        otel-collector, Prometheus, Grafana provisioning
│
├── tools/                    Evaluation, verification and benchmark harnesses
├── scripts/                  e2e runner, web verify harness, k8s validation
└── docs/                     Specification, reports, threat model, retractions
```

---

## Quick start

```bash
cp .env.example .env          # defaults run fully offline on fake adapters
npm install
npm run infra:up              # Postgres, Redis, LocalStack, all services, observability
npm run migrate
```

| Surface | URL |
|---|---|
| Web app | http://localhost:3000 |
| API gateway | http://localhost:4000 |
| Jaeger (traces) | http://localhost:16686 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3001 |

See [RUNBOOK.md](RUNBOOK.md) for operating the stack and [DEMO.md](DEMO.md) for
the click-through walkthrough.

## Tests

```bash
npm test                  # all workspace suites (Node)
npm run test:coverage     # coverage thresholds over the pure-logic packages
npm run test:e2e          # full stack in an isolated compose project
npm run audit             # production dependency gate (see docs/security/)
```

Python suites run per service, from that service's own directory — both declare
a top-level package named `app`, so collecting them together fails:

```bash
cd apps/ai-service  && pytest tests -q     # 78 passed, 5 skipped
cd apps/scope-guard && pytest tests -q     # 29 passed ()
```

---

## Status & Limitations

Measured results, the honest versions, are in
[docs/FINAL_PROJECT_REPORT.md](docs/FINAL_PROJECT_REPORT.md). The load-bearing
caveats:

- **The drift detector runs on a synthetic calibration set.** `/scope/drift`
  answers instead of returning 503, but the residuals it compares against are
  random floats, not measured traffic. Every response carries
  `calibration_is_synthetic: true` and a note saying the delta is not a measured
  false-alarm rate. No real T2 set exists yet.
- **Scope-guard recall is the weak side.** Over 50 live contracts: accuracy
  68%, precision 100%, recall 60%, F1 75% (was 36% / 100% / 20% / 33% before
  the chunker fix and threshold recalibration). It still blocks legitimate
  requests more often than it should; it has never allowed an out-of-scope one
  in this fixture.
- **Matchmaking is closer to a keyword matcher than a semantic one.** P@1 0.750
  on tech-named queries, 0.375 on outcome-only queries (N=1000). The shipped
  weights rank 66th of 231 in the ablation.
- **KYC approves everything.** `packages/kyc-adapter` has one implementation and
  it is `FakeKycAdapter`. No vendor is wired.
- **There is no payout leg.** Settlement *captures* the client's authorised
  payment to the platform. Nothing transfers it onward to the freelancer.
- **Dispute/arbitration is not implemented** and the UI button says so.
- **CI does not deploy.** Images are built and discarded (`push: false`).
- **17 legacy ledger rows** predate canonicalization and cannot be made
  retroactively verifiable — see `npm run ledger:legacy`, which seals rather
  than backfills them.
- **Prompt injection is only partly mitigated.** Finding *suppression* remains
  possible; the static scan layer is the floor that cannot be talked out of a
  finding. See `docs/THREAT_MODEL.md` T5.
- **Real GitHub push auditing is off by default** (`ENABLE_GITHUB_SOURCE_FETCH`)
  and untested against live GitHub. With it off, only `/simulate-push` reaches
  the verification pipeline.
- **Tracing stops at the Python boundary** — `ai-service` and `scope-guard`
  export metrics but no OTel spans.

Retracted claims — do not cite: the QR-NGC paradigm
([docs/NEXTGEN_RESEARCH_PARADIGM.md](docs/NEXTGEN_RESEARCH_PARADIGM.md)), the
AZK-MACP protocol
([docs/NOVEL_RESEARCH_METHODOLOGY.md](docs/NOVEL_RESEARCH_METHODOLOGY.md)), and
every figure in
[docs/RESEARCH_PERFORMANCE_ANALYSIS.md](docs/RESEARCH_PERFORMANCE_ANALYSIS.md),
which are projections rather than measurements and say so themselves. ML-DSA-87
Merkle-root signing is the one claim from that line of work that was retained
and made real.

---

## Documentation

| Document | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Services, data flow, and the decisions behind them |
| [RUNBOOK.md](RUNBOOK.md) | Running, operating and debugging the stack |
| [DEMO.md](DEMO.md) | End-to-end walkthrough |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Trust boundaries, attacker model, mitigations |
| [docs/ASSURECODE_COMPLETE_TECHNICAL_SPECIFICATION.md](docs/ASSURECODE_COMPLETE_TECHNICAL_SPECIFICATION.md) | Authoritative spec — formulas, schema, results |
| [docs/FINAL_PROJECT_REPORT.md](docs/FINAL_PROJECT_REPORT.md) | Measured results and what is not done |
| [docs/ZERO_TRUST_LOOPHOLE_AUDIT.md](docs/ZERO_TRUST_LOOPHOLE_AUDIT.md) | Attack-vector audit |
| [docs/benchmarks/](docs/benchmarks/) | Benchmark and matchmaking reports + raw JSON |
| [docs/architecture_overview.md](docs/architecture_overview.md) | *Historical, superseded* |
