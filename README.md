# AssureCode (Trust-Code 2.0) — Zero-Trust Event-Driven Multi-Agent Freelance Ecosystem

> **Principal Systems Architect & Lead Project Manager** | Version 1.0.0-alpha.0  
> **Repository Root**: `C:\Users\hp\AssureCode`

---

## 📌 Repository Sitemap & Directory Structure

```
AssureCode/
├── apps/                               # Core Application Services
│   ├── web/                            # React 18 / Vite 4-Phase Frontend (Pure JS/JSX)
│   ├── api-gateway/                    # Fastify REST + WebSocket Gateway & BFF
│   ├── ci-worker/                      # Zero-Trust Ephemeral Docker Sandbox Audit Engine
│   ├── ai-service/                     # Python FastAPI NLP Matchmaker, RAG & Poincaré H^d
│   └── settlement-worker/              # 5-Signal Oracle Single-Fire Settlement Daemon
│
├── packages/                           # Shared Monorepo Packages
│   ├── ledger-client/                  # RFC 8785 canonicalization, RFC 6962 Merkle tree, FIPS 204 ML-DSA-87
│   ├── stripe-adapter/                 # PaymentIntent Escrow Adapter & Webhook Signatures
│   ├── event-bus/                      # Redis Streams EventBus & Transactional Outbox
│   ├── config/                         # Unified Monorepo Configuration & Logger
│   ├── telemetry/                      # OpenTelemetry Tracing & Prometheus Metrics
│   └── shared/                         # Zod Schemas & Event Topic Contracts
│
├── tools/                              # Verification & Benchmarking Test Harnesses
│   ├── eval/matchmaking_eval.py        # Matchmaking retrieval eval, N=100/1000, w1/w2/w3 ablation
│   ├── test-matchmaking.py             # 5-scenario qualitative smoke test (8-profile fixture)
│   ├── benchmark.js                    # Contract-flow benchmark against live HTTP endpoints
│   ├── verify_phase4_live.py           # C1 drift detector, live checks
│   ├── verify_phase5_live.mjs          # Telemetry trust score + settlement oracle, live checks
│   ├── verify_phase8_live.mjs          # Merkle tree + ML-DSA-87 root signing, live checks
│   └── analyze_benchmark.py            # Statistical benchmark report generator
│
├── docs/                               # Technical documentation
│   ├── ASSURECODE_COMPLETE_TECHNICAL_SPECIFICATION.md  # Authoritative spec
│   ├── FINAL_PROJECT_REPORT.md         # Project report with measured results
│   ├── PRESENTATION_GUIDE.md           # Demo script & oral defense answers
│   ├── ZERO_TRUST_LOOPHOLE_AUDIT.md    # Zero-trust security & loophole audit
│   ├── NEXTGEN_RESEARCH_PARADIGM.md    # RETRACTED — QR-NGC withdrawal notice
│   ├── NOVEL_RESEARCH_METHODOLOGY.md   # RETRACTED — AZK-MACP withdrawal notice
│   ├── RESEARCH_PERFORMANCE_ANALYSIS.md # Optimization proposals (projections, not measurements)
│   ├── architecture_overview.md        # Historical snapshot, superseded by the spec
│   └── benchmarks/                     # BENCHMARK_REPORT.md, MATCHMAKING_REPORT.md + raw JSON
│
├── scripts/                            # E2E Automated Build & Compliance Runners
│   └── verify-web.js                   # 4-Tier Web Application Verification Harness
│
└── conductor/                          # Project Plan & Architectural Specifications
    └── plan.md                         # Monorepo Development Plan & Milestone Checklist
```

---

## ⚡ Quick Start & Verification Commands

```bash
# 1. Launch Frontend Web App for Presentation
npm run dev:web
# -> Open http://localhost:5173

# 2. Run 4-Tier E2E Web Application Verification
node scripts/verify-web.js

# 3. Run the matchmaking retrieval evaluation (N=100 and N=1000, real embedder)
python tools/eval/matchmaking_eval.py

# 4. Run the contract-flow benchmark (requires the gateway; exits non-zero if it is down)
node tools/benchmark.js
```

---

## 📚 Key Technical Documentation

- **Technical Specification** (authoritative): [docs/ASSURECODE_COMPLETE_TECHNICAL_SPECIFICATION.md](docs/ASSURECODE_COMPLETE_TECHNICAL_SPECIFICATION.md)
- **Final Project Report**: [docs/FINAL_PROJECT_REPORT.md](docs/FINAL_PROJECT_REPORT.md)
- **Demonstration & Oral Defense Guide**: [docs/PRESENTATION_GUIDE.md](docs/PRESENTATION_GUIDE.md)
- **Benchmark Report** (contract flow, scope accuracy): [docs/benchmarks/BENCHMARK_REPORT.md](docs/benchmarks/BENCHMARK_REPORT.md)
- **Matchmaking Report** (retrieval metrics, weight ablation): [docs/benchmarks/MATCHMAKING_REPORT.md](docs/benchmarks/MATCHMAKING_REPORT.md)
- **Zero-Trust Security Audit**: [docs/ZERO_TRUST_LOOPHOLE_AUDIT.md](docs/ZERO_TRUST_LOOPHOLE_AUDIT.md)
- **Optimization proposals** (projections, *not* measurements): [docs/RESEARCH_PERFORMANCE_ANALYSIS.md](docs/RESEARCH_PERFORMANCE_ANALYSIS.md)
- **Retraction — QR-NGC research paradigm**: [docs/NEXTGEN_RESEARCH_PARADIGM.md](docs/NEXTGEN_RESEARCH_PARADIGM.md)
- **Retraction — AZK-MACP protocol paper**: [docs/NOVEL_RESEARCH_METHODOLOGY.md](docs/NOVEL_RESEARCH_METHODOLOGY.md)
- *Historical, superseded*: [docs/architecture_overview.md](docs/architecture_overview.md)
