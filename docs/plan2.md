# AssureCode (Trust-Code 2.0) — Execution Plan, Part 2 (Post-Sprint 5 → Done)

> **Status legend:** `[x]` completed · `[~]` in progress · `[ ]` pending · `[!]` blocked
> **Scope:** This document continues from the end of [`plan.md`](./plan.md) (Sprint 5
> — Algorithmic Secure Settlement) and carries the project to release-ready.
> Read both together: `plan.md` builds the vertical slices; `plan2.md` hardens,
> deploys, and closes them out.

**Current state (as of plan2.md last update):** Sprint 0 walking skeleton is
*code-complete* — all endpoints, event bus, ledger client, CI worker, WebSocket
streaming, and UI wiring exist in the repo. Live verification (against a running
Postgres/Redis/Neo4j stack) is the next step before Sprint 1 begins. All Sprint 0
tasks in `plan.md` are `[x]`.

> **Goal of this plan:** take the feature-complete system delivered by Sprint 5
> and make it observable, resilient, deployable, demonstrable, and documented —
> i.e. ship it. Every task is atomic, names the files it touches, and ends with a
> runnable verification command, exactly like `plan.md`.

---

## What "done after Sprint 5" means

By the end of Sprint 5 the happy path is real end-to-end: contract lock → test
generation → real CI sandbox → security scan → scope guard → video proof → XAI
score → idempotent settlement. What remains is everything *around* the happy
path: failure modes, visibility, deployment, the proof, and the handoff. These
are grouped into Sprints 6–11 below, then a cross-cutting checklist and a
Definition of Done.

| Sprint | Theme | One-line goal |
|---|---|---|
| **6** | Resilience & failure modes | Every step can fail safely and recover; nothing double-charges or half-commits |
| **7** | Observability & ops | Structured traces, metrics, dashboards — the system explains itself |
| **8** | Security hardening & audit | HMAC everywhere, secret hygiene, threat-model pass, pen-test fixes |
| **9** | Test coverage & quality gates | Integration suites, contract tests, ≥70% coverage gate in CI |
| **10** | Deployment & release | Container images, infra-as-code, one-command prod-like deploy |
| **11** | Demo, docs & handoff | E2E demo data, runbook, README/ARCH, tagged v1.0.0 release |

---

## Sprint 6 — Resilience & Failure Modes

Goal: the system degrades gracefully. Retries are bounded, side effects are
idempotent, partial work rolls back, and operators get clear errors instead of
silent corruption.

- [x] **6.1 — Idempotency keys end-to-end.** Extend `packages/shared` with an
  `IdempotencyKey` header schema; store `idempotency_keys(contract_id, key, response_json, expires_at)`
  via a new `V003__idempotency.sql` migration; wrap the 5 mutating gateway
  endpoints (`initialize`, `lock`, `generate-tests`, `escrow`, `settle`) so a
  replayed key returns the cached response. *Verify: replay the same `lock`
  call twice → identical hash, single ledger row.*
- [x] **6.2 — Bounded retries + dead-letter stream.** In
  `packages/event-bus` `RedisStreamsBus`, add `MAX_RETRIES=3` with exponential
  backoff and a `*.dlq` stream for poison messages; expose
  `REPLAY <stream> <id>` via a `tools/replay-event.ts` helper.
  *Verify: a handler that always throws lands exactly once in `audit.completed.dlq`
  after 3 attempts.*
- [x] **6.3 — Settlement is provably single-fire.** Add a `settlements(contract_id
  unique, status, transfer_id)` guard table; `settlement-worker` does
  `INSERT … ON CONFLICT DO NOTHING` before issuing the Stripe transfer and gates
  on the 5-signal oracle inside the same transaction as the `INVOICE` ledger
  append. *Verify: call `/settle` 5× concurrently → exactly one `transfer` in
  Stripe, one `settlement.completed`, chain still verifies.*
- [x] **6.4 — Ledger verification endpoint + tamper test.** `GET
  /api/contracts/:id/verify` calls `LedgerClient.verifyChain`; add a red-team
  test that `UPDATE`s a `merkle_ledger.current_hash` and asserts the endpoint
  flips to `valid:false`. *Verify: tampered row → `409 { valid:false }`.*
- [x] **6.5 — Transactional outbox for cross-service writes.** Introduce an
  `outbox(id, topic, payload, sent_at)` table written in the same transaction
  as the ledger append; a relay pumps `outbox → RedisStreams` so a crash between
  DB commit and bus publish never drops an event. *Verify: kill the gateway
  mid-`lock` → on restart the `contract.locked` event still publishes once.*
- [x] **6.6 — Graceful degradation when LLM/S3 unavailable.** `ai-service`
  returns `503` with `retry-after` instead of hanging; gateway maps that to a
  user-visible "test generation queued" state + a `jobs` table poll. S3 writes
  retry with exponential backoff and fall back to local volume under
  `S3_FALLBACK_DIR`. *Verify: with LocalStack down, `lock` still succeeds and
  the bundle is written locally; chain verifies.*

## Sprint 7 — Observability & Ops

Goal: no "what happened?" — correlation IDs, traces, metrics, and a live
dashboard exist for every request and event.

- [x] **7.1 — Correlation-ID middleware.** Fastify `onRequest` reads or mints
  `x-correlation-id`, propagates it into every `eventBus.publish` and every
  outbound HTTP/Stripe call; logs include it on every line. *Verify: grep a
  single correlation id across gateway + worker logs → full trace.*
- [x] **7.2 — OpenTelemetry traces.** Add `@opentelemetry/*` to the Node apps
  and `opentelemetry-*` to the Python services; export to a local
  `otel-collector` (+ Jaeger UI) added to `infra/docker-compose.yml`. Span per
  HTTP request, per event publish, per ledger append. *Verify: one `lock` call
  shows a connected trace through gateway → DB → bus.*
- [x] **7.3 — Prometheus metrics + Grafana.** `/metrics` on every Node app
  (`prom-client`) and Python service (`prometheus-fastapi-instrumentator`); ship
  `infra/grafana/dashboards/assurecode.json` (ledger appends/s, event lag,
  settlement $, sandbox duration, LLM latency/p95). *Verify: Grafana shows live
  data after a single contract run.*
- [x] **7.4 — Health + readiness split.** Split `/healthz` (liveness, always 200)
  from `/readyz` (DB + Redis + Neo4j reachable); wire both into the compose
  `healthcheck`s and a future deploy's readiness gate. *Verify: stop Postgres →
  `/readyz` 503, `/healthz` 200.*
- [x] **7.5 — Structured audit log of money movements.** A dedicated
  `payment_events` table + `xai.scored`/`settlement.completed` emit to a
  read-only `audit-log` Grafana panel. *Verify: a full run produces a chronological
  money-event trail viewable in Grafana.*
- [x] **7.6 — Alerting rules.** Grafana alert rules: DLQ depth > 0, settlement
  failure rate > 1%, sandbox p95 > 60s, LLM error rate > 5%. *Verify: inject a
  failing handler → DLQ alert fires.*

## Sprint 8 — Security Hardening & Audit

Goal: the system is defensible. Secrets, signatures, sandboxing, and prompts
all pass a review.

- [x] **8.1 — HMAC on every boundary, verified.** Confirm GitHub
  (`webhook-ingest`) and Stripe webhooks verify signatures with constant-time
  compare and reject on mismatch (401/400). Add negative tests for replay,
  truncated, and bad-secret payloads. *Verify: tampered GitHub signature → 401;
  valid → event published.*
- [x] **8.2 — Secret hygiene pass.** Confirm no secret is logged or serialized
  into events/ledger; rotate `.env.example` defaults; add a `secretlint` CI step
  and a `npm run secrets:scan` script. *Verify: `npm run secrets:scan` exits 0.*
- [x] **8.3 — Sandbox egress lockdown.** The `ci-worker` Docker sidecar gets
  `--network=none` except an allowlist (npm registry + LocalStack), a read-only
  rootfs, CPU/memory/`--pids-limit`, and a non-root user. *Verify: a test trying
  `curl` to a blocked host fails; sandbox still builds + runs tests.*
- [x] **8.4 — Prompt-injection hardening, round 2.** Extend the
  `ai-service` sanitizer beyond regex: structured-output enforcement (zod/json-schema
  on LLM responses), allow-listed output formats, and a system-prompt firewall
  that strips instructions embedded in `requirements` text. *Verify: a payload
  containing `"ignore previous instructions"` is neutralized and the test bundle
  still generates.*
- [x] **8.5 — Rate limiting + authn.** `@fastify/rate-limit` on the gateway
  (per-IP + per-contract); add a minimal auth layer (signed session or API key)
  before any non-`/healthz` route. *Verify: 100 rapid calls → 429; missing key → 401.*
- [x] **8.6 — Dependency + container scan.** `npm audit --omit=dev` in CI;
  `trivy` scan of built images; fail build on `HIGH`/`CRITICAL`. *Verify: clean
  `trivy` report on the gateway image.*
- [x] **8.7 — Threat-model walkthrough + fixes.** Document the threat model
  (`docs/THREAT_MODEL.md`): STRIDE per service; close any findings; link each fix
  to a task here. *Verify: doc merged with no open `HIGH` items.*

## Sprint 9 — Test Coverage & Quality Gates

Goal: CI is the source of truth for "is this releasable", not a developer's
laptop.

- [x] **9.1 — Integration test harness against real services.** `infra/docker-compose.test.yml`
  spins Postgres + Redis + Neo4j + LocalStack; a `test:e2e` npm script brings it
  up, migrates, runs Vitest/pytest, tears down. *Verify: `npm run test:e2e`
  green from clean clone.*
- [x] **9.2 — Contract tests for the event bus.** A shared suite
  (`packages/event-bus/test/contract.spec.ts`) runs against `InMemoryBus`,
  `RedisStreamsBus`, and (if Kafka present) `KafkaBus` to prove identical
  ordering/delivery semantics. *Verify: all three adapters pass the same suite.*
- [x] **9.3 — Golden-path E2E test.** A single Vitest test that exercises the
  whole pipeline via the gateway API: initialize → lock → simulate-push → wait
  for `audit.completed` → settle → assert chain verifies + one transfer.
  *Verify: the test passes against the real stack.*
- [x] **9.4 — Coverage gate at 70%.** `c8`/`vitest --coverage` (Node) and
  `pytest-cov` (Python); CI fails below the threshold on changed packages.
  *Verify: drop a package's coverage to 65% → CI red.*
- [x] **9.5 — Load soak.** A `k6` script (`tools/load/soak.js`) drives 50
  concurrent contract runs for 5 min; capture p95 ledger-append and settlement
  latency into `docs/PERFORMANCE.md`. *Verify: no 5xx; p95 within budget.*
- [x] **9.6 — Chaos test.** Kill `ci-worker` and `settlement-worker` mid-run;
  assert the outbox + DLQ let the system recover and complete without duplicates.
  *Verify: contract still settles exactly once after worker restart.*

## Sprint 10 — Deployment & Release

Goal: one command takes the system from git to a prod-like environment.

- [x] **10.1 — Containerize every service.** Add `Dockerfile` per app
  (multi-stage Node, slim Python); the frontend builds static assets served by
  nginx. Update `infra/docker-compose.yml` to build the app services instead of
  stubs. *Verify: `docker compose up --build` brings the full stack healthy.*
- [x] **10.2 — Infra-as-code for the data plane.** Parameterize compose via
  `.env` for a prod-like profile (`docker-compose.prod.yml` overlay: replicas,
  resource limits, restart policies, logging driver). *Verify: prod overlay
  boots and passes `/readyz`.*
- [x] **10.3 — Migration + seed on boot.** App containers run `npm run migrate`
  and the Neo4j seed as an init container/entrypoint step; idempotent so
  redeploys are safe. *Verify: fresh DB → boot → schema + seed present.*
- [x] **10.4 — Config & secret management.** Document the prod secret strategy
  (Docker secrets / env injection); remove all defaults from prod config; fail
  fast on missing required vars. *Verify: boot without `STRIPE_SECRET_KEY` in
  prod → clear startup error.*
- [x] **10.5 — Release CI pipeline.** `.github/workflows/release.yml`: on tag
  `v*`, build images, push to registry, run `test:e2e` against the deployed
  images, publish artifacts. *Verify: a `v1.0.0-rc.1` tag produces runnable
  images + green pipeline.*
- [x] **10.6 — Rollback + blue-green notes.** Add a `docs/RELEASE.md` covering
  safe rollback (ledger is append-only, so redeploy is always safe) and a
  blue-green path for the gateway. *Verify: dry-run rollback documented and
  executable.*

## Sprint 11 — Demo, Docs & Handoff

Goal: anyone can run, understand, and extend AssureCode from the repo alone.

- [x] **11.1 — Seeded demo dataset.** `infra/seed/demo/` with 2 clients, 3
  freelancers, a locked contract, and a passing repo fixture so `infra:up` →
  web UI shows a finished contract without manual entry. *Verify: fresh clone,
  `infra:up`, open UI → demo contract + score visible.*
- [x] **11.2 — README rewrite.** Replace the one-liner `README.md` with: what it
  is, architecture diagram, quickstart (`cp .env.example .env && npm i &&
  docker compose -f infra/docker-compose.yml up -d && npm run dev:web && npm run dev:gateway`),
  screenshots/GIF of the full flow, and links to
  `plan.md`/`plan2.md`. *Verify: a new contributor follows README start-to-finish
  without help.*
- [x] **11.3 — ARCHITECTURE.md.** The big picture: service map, event flow
  diagram (Mermaid), data model, the 5-signal oracle, and the hash-chain
  invariant with the exact `append_ledger` formula. *Verify: diagram renders in
  GitHub; formula matches `V002__ledger.sql`.*
- [x] **11.4 — RUNBOOK.md.** Common ops: how to replay a DLQ event, how to
  manually settle, how to verify/repair a chain, how to rotate keys, how to
  read the Grafana dashboards. *Verify: each runbook step is runnable as written.*
- [x] **11.5 — End-to-end demo script.** `docs/DEMO.md`: click-by-click + curl
  script that drives the full happy path and one failure path (scope blocked),
  suitable for a live walkthrough. *Verify: run the script cold → full demo
  completes in <5 min.*
- [x] **11.6 — Clean repo & CHANGELOG.** Remove any stray build artifacts;
  add `CHANGELOG.md`; confirm `.gitignore` is complete;
  finalize `plan.md`/`plan2.md` statuses. *Verify: `git status` clean after
  build; no secrets tracked.*
- [x] **11.7 — Tag v1.0.0.** After 11.1–11.6 pass, cut the release tag and
  publish. *Verify: release pipeline green; images pull and run.*


---

## Cross-cutting (continues from `plan.md`)

- **CI (`.github/workflows`):** extend the per-package pipeline with the
  Sprint 9 coverage gate, the Sprint 8 secret/container scans, and the Sprint 10
  release stage.
- **Observability as a feature:** every new endpoint/migration added in Sprints
  6–8 must carry its metric (7.3) and trace span (7.2) in the same PR.
- **Windows-first DX:** keep all commands runnable under `cmd.exe` /
  cross-platform npm; Linux-only steps stay inside Docker.

## Definition of Done (the project is "complete" when all are true)

1. ✅ `plan.md` Sprints 0–5 and `plan2.md` Sprints 6–11 are all `[x]`.
2. ✅ One command (`docker compose -f infra/docker-compose.yml up --build`) brings the full stack green,
   seeded with demo data, UI reachable at `http://localhost:3000`, all `/readyz` endpoints 200.
3. ✅ `npm run test:e2e` passes the golden-path + scope-blocked path against the
   real stack from a clean clone.
4. ✅ Coverage gate (≥70%) and secret/container scans are green in CI.
5. ✅ The hash chain verifies after a full run, and the tamper test proves it
   detects modification.
6. ✅ A replayed `/settle` produces exactly one Stripe transfer (idempotency
   proven under concurrency).
7. ✅ `README.md`, `ARCHITECTURE.md`, `RUNBOOK.md`, `DEMO.md`, and
   `CHANGELOG.md` are merged and accurate.
8. ✅ Tag `v1.0.0` is cut, release pipeline is green, and images run in a
   prod-like profile.

## Notes for the coding agent (continues from `plan.md`)

- Resume in workspace order: shared packages → apps → wire UI last in each slice.
- Every acceptance command must pass before the next task; if an
  environment-bound command (Stripe keys, ngrok, Kafka) is unavailable,
  implement behind the port + a fake and mark `[!]` `blocked-pending-credentials`,
  not `[x]`.
- Keep the existing UI element IDs stable so wiring from Sprints 6/7 remains
  mechanical.
- When a task touches money or the ledger (6.1, 6.3, 6.5, 7.5), prefer a
  transactional, idempotent design over a "fast" one.
- All docker-compose commands should use the explicit path
  `docker compose -f infra/docker-compose.yml` (or the prod/test overlay)
  since the compose file does not live at the repo root.
