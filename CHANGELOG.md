# Changelog

Notable changes to AssureCode. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No version has been tagged yet — `git tag -l` is empty. `v1.0.0` is intended to
be the artifact a paper cites, and is gated on the criteria in
[Unreleased](#unreleased) below.

## [Unreleased]

### Neo4j is a working backend
Previously provisioned everywhere and queried nowhere: a 1–2Gi StatefulSet, a
10Gi PVC, two compose services, a driver dependency and two NetworkPolicy
entries existed for an adapter `get_graph_repo()` never constructed.

- `Neo4jGraphRepo.retrieve_by_embedding` was a stub returning similarity `0.0`
  for every freelancer. Because the matchmaker multiplies that by `w_skill`,
  selecting this backend would have deleted the semantic half of matchmaking
  and collapsed ranking to trust + delivery count — silently. It now queries
  the native vector index.
- **The two backends report similarity on different scales.** pgvector returns
  raw cosine in `[-1, 1]`; a Neo4j cosine index returns `(1 + cos) / 2` in
  `[0, 1]`. Both survive the matchmaker's `max(0.0, …)` clamp, so confusing them
  changes rankings with no error, no log line and no failing test — a silent
  wrong answer in a reported result. `neo4j_score_to_cosine` inverts it, and a
  cross-backend parity test asserts identical top-k ordering *and* similarity
  values across four queries. That test was verified to fail (12 comparison
  errors) when the conversion is removed.
- `tools/seed-neo4j-vectors.py` creates the 384-d cosine index and writes
  embeddings. It **imports** the roster and embedder from `tools/seed-users.py`
  rather than forking them, so the two cannot hold different rosters or embed
  different `profile_text`.
- `GRAPH_BACKEND` selects the backend; Postgres remains the default. Explicit
  rather than inferred from `NEO4J_URI`, which has a default and is set
  everywhere — inferring would have switched the backend for every deployment.
- `infra/k8s/16-seed-neo4j-job.yaml` and a compose `seed-neo4j-vectors` service
  (behind the `neo4j` profile). There was previously no in-cluster Neo4j seed at
  all, so a deployed graph was empty and the adapter degraded to a fixture while
  the cluster reported healthy.
- Pinned `neo4j:5.26-community` in compose and k8s (native vector indexes need
  5.13+; the floating `5-community` tag made that an unstated assumption), and
  bounded the driver to `>=5.26.0,<7.0.0` — the venv had resolved 6.x against
  code written for 5.x.

### Security
- **Prompt-injection defences** for the two routes that put untrusted text in an
  LLM prompt (`apps/ai-service/app/services/prompt_guard.py`, 41 tests). The
  security scan's `{code}` sat inside a markdown ``` fence, so submitted code
  containing ``` closed the fence and everything after it was read as prompt.
  Untrusted text is now fenced with a per-request random sentinel, backtick runs
  are defanged, and a detected attempt is reported as an A05:2025 HIGH finding
  against its line — making the attempt itself evidence. The residual
  *suppression* vector is documented rather than claimed solved.
- **`x-service-token` on `ai-service` and `scope-guard`**
  (`apps/ai-service/app/ports/service_auth.py`, 17 tests). Both previously
  registered every router with no auth dependency; under docker-compose anything
  on the network could invoke the XAI scorer or the security scanner directly.
  The dependency is declared on the FastAPI constructor so later routes are
  protected by default, comparison is `secrets.compare_digest`, probe endpoints
  are exempt, and production raises at import if the token is missing or a
  placeholder. All six gateway call sites and both ci-worker call sites now send
  the header.
- **NetworkPolicies for the observability tier**, including a deliberate refusal
  to grant `ci-worker` collector egress: its policy allows Redis and nothing
  else because it runs untrusted code, and losing its spans is the better trade.

### Added
- `packages/oracle` test suite — 28 tests covering the settlement gate against a
  stub `pg.Pool`: threshold boundary at exactly 85, `null` as "unscored" rather
  than zero, the derived scope signal, pg string-to-number coercion, and that
  `recordAudit`/`recordScore` cannot clobber each other's columns. Previously
  the code path that releases money had no tests at all. 100% statements.
- Coverage gate (`npm run test:coverage`, `vitest.coverage.config.ts`) over the
  pure-logic packages, enforced in CI. `packages/oracle` is pinned at 100%
  statements / 95% branches; the aggregate is pinned just below measured so a
  regression fails rather than an aspiration nobody can meet.
- `KafkaBus` regression tests proving publish cannot silently drop: empty broker
  list rejected at construction, broker failures propagated, envelope keyed by
  correlation id. Plus `eventBusOptionsFromConfig` coverage for the disjoint
  option shapes that stop a memory/redis config falling through to Kafka.
- `apps/ai-service/tests/test_hyperbolic.py` — 21 tests verifying the
  pre-registered Poincaré baseline against closed-form values
  (`d(0,x) = 2 artanh(||x||)`, the `ln 3` anchor) and the metric axioms. The
  implementation is now verified even though the baseline cannot yet be *run*.
- Rate limiting on `api-gateway` (plan2.md task 8.5): 300/min global keyed on
  the authenticated subject falling back to IP, and a separate 10/min per-IP
  bucket on `/auth/login`. Health, readiness and metrics endpoints exempt so
  probes and scrapes are never throttled; disabled under `NODE_ENV=test`.
- Observability collectors in `infra/docker-compose.yml` — OTel Collector,
  Jaeger, Prometheus and Grafana with provisioned datasources
  (`infra/observability/`). The instrumentation in `packages/telemetry` has
  always been real; nothing had ever received its output.
- `ARCHITECTURE.md`, `RUNBOOK.md`, `DEMO.md`, `CHANGELOG.md` and
  `docs/THREAT_MODEL.md` (plan2.md DoD 7). `README.md` was the only document of
  its class.
- `configs/c1_rules.json` gains a non-normative
  `baselines_implementation_status` block recording where each pre-registered
  baseline lives and whether it has been run. The registered `baselines` array
  is unchanged.
- **Prometheus metrics for the Python services** (`app/ports/telemetry.py`, 11
  tests), sharing the `assurecode_*` prefix with the Node tier so a dashboard
  can sum across both. Route labels come from the matched route *template* and
  unmatched paths collapse to `<unmatched>`, so a 404 flood cannot mint one time
  series per URL. Prometheus now scrapes all four instrumented services.
- **`infra/k8s/15-observability.yaml`** — collector, Jaeger, Prometheus and
  Grafana in-cluster, matching the security posture of the rest of `infra/k8s`.
  Without it, `OTEL_EXPORTER_OTLP_ENDPOINT` in the ConfigMap named a Service
  that did not exist.
- **Real GitHub push auditing** (`apps/ci-worker/src/source-fetcher.ts`, 33
  tests), behind `ENABLE_GITHUB_SOURCE_FETCH`. A push webhook carries repository
  coordinates but no file contents, so ci-worker fetches the commit's source
  from the GitHub API — pinned to the reported SHA, never a branch, because
  resolving a branch would let a freelancer push benign code and force-push
  something else once the audit starts. Refuses on a truncated tree rather than
  auditing part of a repository. Untested against live GitHub.
- **Legacy ledger sealing** (`packages/ledger-client/src/legacy-anchor.ts`, 20
  tests; `npm run ledger:legacy`). See below — this is deliberately not a
  backfill.
- Suites for `packages/shared` (25 tests) and `packages/telemetry` (14 tests),
  the last two workspaces with no tests. Both are now in the coverage gate,
  which rises from 45% to 50% statements.

### Changed
- `OTEL_EXPORTER_OTLP_ENDPOINT` now points at the collector across compose and
  the k8s ConfigMap. It previously defaulted to `http://localhost:4317`, which
  inside a container is that container's own loopback — every span was exported
  into a socket nothing was listening on.
- Four previously undeclared environment variables are now in the Zod schema,
  `.env.example` and the k8s ConfigMap: `ALLOWED_ORIGINS`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `SANDBOX_RUNNER`, and the `RATE_LIMIT_*` group.
  Each was read straight off `process.env` by exactly one module, so a typo
  produced a silent default instead of a startup error.
- `README.md` rewritten. The old version gave a stale repository root
  (`C:\Users\hp\AssureCode`), listed a `packages/stripe-adapter` that no longer
  exists, described a "Four-Signal Oracle", and omitted `scope-guard`,
  `webhook-ingest`, `packages/oracle`, `razorpay-adapter`, `kyc-adapter` and
  `infra/` entirely.
- `apps/ai-service/app/services/hyperbolic.py` docstring no longer describes the
  module as part of the "QR-NGC Protocol" (withdrawn — see
  `docs/NEXTGEN_RESEARCH_PARADIGM.md`) or claims "zero hierarchical distortion"
  (never measured). It now documents the projection caveat: L2-normalised
  embeddings all clamp to the same shell near the boundary.
- `apps/ai-service/app/__init__.py` no longer describes the package as a
  "STUB (task 0.1)" whose real implementation "lands across Sprints 1, 2, 3, 4".
- **The 17 legacy ledger rows are sealable, not backfillable.** They were hashed
  with a PostgreSQL expression nothing outside PostgreSQL reproduces, so they
  cannot be made retroactively verifiable. Recomputing their hashes under the
  current formula would make them all "verify" and would destroy the property
  the ledger exists for — recomputation is exactly what rewriting history looks
  like. `npm run ledger:legacy --seal` instead appends a normal, fully
  verifiable entry committing to their hashes, converting "17 rows are
  unverifiable" into "17 rows are not independently verifiable but have been
  immutable since <date>".
- The authoritative spec no longer says Stripe. Six references to
  `stripe-adapter`, `StripeEscrowAdapter` and `capture_method: 'manual'` in
  `docs/ASSURECODE_COMPLETE_TECHNICAL_SPECIFICATION.md` now describe Razorpay,
  and the settlement section states that capture reaches the platform only.
- `docs/plan.md` and `docs/architecture_overview.md` gained correction headers
  for the claims they still carry: Stripe Connect payouts, a "5-signal oracle"
  (it is six, and there is no video signal), and the removed Gemini/OpenAI
  adapters.

### Fixed
- **`apps/scope-guard`'s published image could not start.** `prometheus-client`
  was added to its `dev` extras rather than core dependencies (a script matched
  the `httpx>=` line, which in that file only appears under `dev`), while
  `Dockerfile.scope-guard` installs `.` with no extras and `app/main.py` imports
  it at module load. CI reported green throughout because `container-build` uses
  `push: false` and never ran the image. A `Smoke-Test Image Imports` step now
  runs `python -c "import app.main"` against each built Python image.
- **The `security` job failed on every run and gated nothing.** `npm audit
  --audit-level=high` cannot pass while every remaining production advisory
  needs a major bump (fastify 4→5, OpenTelemetry 0.51→0.221), and no job listed
  it in `needs:`. Replaced with `scripts/audit-check.mjs`, which gates on
  production advisories only, accepts a finding only with a dated entry in
  `docs/security/audit-exceptions.json`, and fails on unaccepted, expired *or*
  stale exceptions. `container-build` now depends on it. All three failure modes
  were verified by deliberately breaking the exceptions file.
- `InMemoryGraphRepo` held 8 freelancers to the seed's 12, with
  `freelancer-chen` named "Chen Wei" (reversed) carrying Python/AI skills that
  belong to `freelancer-alex`, `freelancer-sarah` holding chen's front-end
  skills, and a `freelancer-devon` that exists nowhere else. Since tests default
  to this fixture, `test_match.py`'s assertions had been describing a roster the
  rest of the system left behind — its own comments referenced a
  `freelancer-alex` the fixture did not contain.
- `trust_score_persisted` in `/xai/score` could report `true` for a write that
  reached only an in-process dict. `update_trust_score` is now part of the
  `GraphRepo` Protocol (dropping a `hasattr` guard that reported "not persisted"
  and "no such method" identically), and fallback writes return `false`.
- Skill normalisation in the Neo4j adapter lived only in the Cypher's
  `toLower()`, so a query edit could have silently stopped every skill matching.
  Both query paths now share one record-mapping helper that lowercases in Python
  as well.
- `KafkaBus` no longer silently discards events. The vestigial
  `if (this.producer)` and `if (!this.kafka)` guards — left over from an era
  when `kafkajs` was loaded with `require()` inside this ESM package and the
  resulting `ReferenceError` was swallowed — turned every publish into a no-op
  and every subscribe into a subscription to nothing. Broker failures now
  propagate; the class is typed instead of `any`.
- `infra/seed/neo4j/` is no longer gitignored. The bare `neo4j/` pattern (meant
  for the container data directory) also matched the seed directory, so
  `V001__seed_matchmaking.cypher` was never committed and `npm run seed:neo4j`
  found nothing on a fresh clone.
- `--passWithNoTests` removed from the nine workspaces that have tests. Deleting
  every test in them previously still produced a green `npm test`.

### Removed
- Orphaned `apps/web/src/data/mockEscrowData.js` and `mockXaiData.js` — exported
  but imported by nothing, referenced only in comments describing their removal
  from the components. They were the last source of fabricated financial data
  (a `$2,500.00` vault, `0x…` transaction hashes) in the tree.
- `storage_fallback/`, `apps/ai-service/storage_fallback/` and `.agents/`
  untracked from git (files retained on disk, now gitignored). These were local
  run artifacts and ~390 files of agent scratch directories; one contained an
  LLM response with prompt instructions leaked into it.

### Deferred CI/CD work (deliberately out of scope, recorded so it is not rediscovered)
- **No CD.** Images are still built with `push: false`; there is no registry
  login, no deploy job, no `environment:`, no tag trigger and no release
  workflow. Manifests are validated and never applied.
- **Trivy is soft-failed** (`exit-code: '0'`), so CRITICAL/HIGH container
  findings report but cannot block.
- **No Redis service in the `test` job**, so `packages/event-bus`'s retry/DLQ
  suite — the only coverage of that logic — silently skips in CI.
- **The two `pip install -e` steps are order-dependent**: scope-guard's tests
  pass partly because ai-service is installed first and leaks `httpx` into the
  interpreter. Its `dev` extra now declares `httpx` explicitly, but the steps
  should still be decoupled.
- `k8s-validate` needlessly `needs: container-build`, serialising the pipeline
  behind eight image builds it does not use.
- Ruff skips `scripts/validate-k8s.py` and `packages/ledger-client/**/*.py`.
- No CODEOWNERS, Dependabot/Renovate, or PR template.
- The six accepted audit exceptions expire 2026-10-31 (fast-jwt) and 2026-11-30
  (the rest); the gate fails once they lapse, which is the intended forcing
  function for the fastify 4→5 and OpenTelemetry upgrades.

### Known issues
Unchanged and unresolved — see `README.md` and `docs/THREAT_MODEL.md`:
the drift detector is uncalibrated (`/drift/status` returns 503), the scope
threshold does not generalise (F1 0.33), KYC approves everyone, there is no
payout leg, prompt injection is unmitigated, the Python services are
unauthenticated, and CI builds images without pushing them.

### Criteria for `v1.0.0`
1. `npm test` and `npm run test:e2e` green from a clean clone against the real
   stack, with the coverage gate enforced.
2. `GET /drift/status` returns a real false-alarm rate from a T2 calibration
   set built by two independent annotators.
3. Scope-guard metrics reported on a **held-out** split, alongside every
   baseline named in `configs/c1_rules.json`.
4. The hash chain verifies over a full run with zero `unverifiable` rows.
5. `docker compose up` brings the stack green with the UI reachable and seeded.

---

## History before this changelog

Reconstructed from git; the repository had no changelog until now.

- **2026-08-15** — JWT auth middleware; Razorpay and KYC service infrastructure.
  `packages/stripe-adapter` deleted and replaced by `razorpay-adapter` +
  `kyc-adapter` (India-market pivot to authorize-then-capture escrow in paise).
  Migrations `V011__kyc_compliance_and_enterprise_auth` and
  `V014__razorpay_escrow`.
- **2026-08-13** — `RedisStreamsBus` retry logic and DLQ; infrastructure
  environment for the microservices.
- **2026-08-12** — `ai-service` and `scope-guard`; full Kubernetes orchestration
  and the CI/CD pipeline (`production-ci-cd.yml`).
- **2026-08-11** — EventBus abstraction with InMemory and Redis Streams
  adapters, telemetry and correlation tracing. Also the date of the
  `docs/plan2.md` status audit that reset every task claim to
  verified-or-not-done.
- **2026-08-10** — event-bus package with OpenTelemetry tracing and metrics;
  graph repository; scope-guard build metadata.
- **2026-08-08** — API gateway, contract management, KYC compliance, deployment
  infrastructure; production CI/CD pipeline.
- **2026-08-05** — matchmaking evaluation script with a real embedder at N=100
  and N=1000.
