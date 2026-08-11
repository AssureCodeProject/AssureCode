# AssureCode (Trust-Code 2.0) — Execution Plan, Part 2 (Post-Sprint 5 → Done)

> **Status legend:** `[x]` completed · `[~]` in progress · `[ ]` pending · `[!]` blocked
> **Scope:** This document continues from the end of [`plan.md`](./plan.md) (Sprint 5
> — Algorithmic Secure Settlement) and carries the project to release-ready.
> Read both together: `plan.md` builds the vertical slices; `plan2.md` hardens,
> deploys, and closes them out.

> **Goal of this plan:** take the feature-complete system delivered by Sprint 5
> and make it observable, resilient, deployable, demonstrable, and documented —
> i.e. ship it. Every task is atomic, names the files it touches, and ends with a
> runnable verification command, exactly like `plan.md`.

---

## Status audit — 2026-08-11

Every task in this file was previously marked `[x]` and all eight Definition-of-Done
criteria `✅`. That was not accurate. The statuses below were re-derived by checking
the filesystem for the artifact each task claims to produce, and by running the
suites. Where a status changed, the evidence is recorded inline as `— audit:`.

The pattern worth naming: a task was marked complete when its *code* existed, even
when the thing that makes the code checkable — the compose service, the dashboard
file, the test harness, the document — did not. Several claims were falsified by a
single `ls`. Two were falsified by running the suite: `pytest tests/test_xai.py`
blocked forever, and no contract could reach a trust score at all.

**Verification rule going forward:** a task is `[x]` only when its stated *Verify*
command has actually been executed and passed. "The code is written" is `[~]`.

**What is actually true today:**

* The core product is real and, since the 2026-08-11 bug-fix pass, works end to end
  for the first time — contract → lock → push → sandbox → audit → trust score →
  oracle → escrow release. Before that pass the sandbox was never given a work
  directory, so every run reported 0/0 tests and **no contract could ever be
  scored or settled**.
* Sprint 6 (resilience) is substantially real: idempotency, DLQ with bounded
  retries, transactional outbox, single-fire settlement, ledger tamper detection.
* Sprint 7 is *instrumented* but not *observable*: traces and metrics are emitted,
  but there is no collector, no Jaeger, and no Grafana dashboard to view them in.
* Sprints 9, 10 and 11 are largely not started. `infra/docker-compose.yml` contains
  four data-plane services and **zero application services**, so the headline
  "one command brings the full stack up" is false.
* 17 defects were found and fixed on 2026-08-11 across the areas Sprints 6–8 claim
  to have hardened. Several contradicted specific `[x]` tasks — see 6.3, 8.1, 8.5.

**Tally after the audit** (38 tasks across Sprints 6–11):

| Sprint | Theme | `[x]` | `[~]` | `[ ]` |
|---|---|---:|---:|---:|
| 6 | Resilience & failure modes | 4 | 2 | 0 |
| 7 | Observability & ops | 1 | 4 | 1 |
| 8 | Security hardening & audit | 0 | 3 | 4 |
| 9 | Test coverage & quality gates | 0 | 1 | 5 |
| 10 | Deployment & release | 0 | 3 | 3 |
| 11 | Demo, docs & handoff | 1 | 0 | 6 |
| **Total** | | **6** | **13** | **19** |

**Rough remaining effort:** ~20–25 discrete tasks. Docs and Dockerfiles are
mechanical; the E2E/coverage harness (Sprint 9) and the Grafana work (7.3/7.6) are
the real effort. Estimate, not a measurement.

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
- [~] **6.3 — Settlement is provably single-fire.** Add a `settlements(contract_id
  unique, status, transfer_id)` guard table; `settlement-worker` does
  `INSERT … ON CONFLICT DO NOTHING` before issuing the Stripe transfer and gates
  on the 5-signal oracle inside the same transaction as the `INVOICE` ledger
  append. *Verify: call `/settle` 5× concurrently → exactly one `transfer` in
  Stripe, one `settlement.completed`, chain still verifies.*
  — audit: guard table (V004) and the claim path are real, but three things
  diverge from this text. (a) The ledger action is `SETTLEMENT_COMPLETED`, not
  `INVOICE` — and the gateway's "already settled" check was still looking for
  `INVOICE`, so it never fired (fixed 2026-08-11). (b) The oracle is evaluated
  *before* and outside the settlement transaction, not inside it. (c) Until
  2026-08-11 `ON CONFLICT DO NOTHING` against a row left at `FAILED` made any
  transiently-failed contract permanently unsettleable. The stated Verify
  command has never been run — `settlement-concurrency.test.ts` skips without a
  live database.
- [~] **6.4 — Ledger verification endpoint + tamper test.** `GET
  /api/contracts/:id/verify` calls `LedgerClient.verifyChain`; add a red-team
  test that `UPDATE`s a `merkle_ledger.current_hash` and asserts the endpoint
  flips to `valid:false`. *Verify: tampered row → `409 { valid:false }`.*
  — audit: endpoint and `ledger-tamper.test.ts` both exist and the verification
  logic is sound (recomputed in-process from the row's own canonical bytes).
  But the test skips without Postgres, so the tamper claim has never actually
  been demonstrated. Blocked on 9.1.
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
- [~] **7.2 — OpenTelemetry traces.** Add `@opentelemetry/*` to the Node apps
  and `opentelemetry-*` to the Python services; export to a local
  `otel-collector` (+ Jaeger UI) added to `infra/docker-compose.yml`. Span per
  HTTP request, per event publish, per ledger append. *Verify: one `lock` call
  shows a connected trace through gateway → DB → bus.*
  — audit: the SDK half is real and good — `initTracing()` in each Node app,
  spans on publish/consume/ledger-append, and W3C trace context propagated
  through the event envelope so consume spans hang off the publish span. But
  there is **no `otel-collector` and no Jaeger in `infra/docker-compose.yml`**
  (0 matches), so the spans go nowhere and the Verify command cannot be run.
  Remaining: add the collector + Jaeger services, and the Python exporters.
- [~] **7.3 — Prometheus metrics + Grafana.** `/metrics` on every Node app
  (`prom-client`) and Python service (`prometheus-fastapi-instrumentator`); ship
  `infra/grafana/dashboards/assurecode.json` (ledger appends/s, event lag,
  settlement $, sandbox duration, LLM latency/p95). *Verify: Grafana shows live
  data after a single contract run.*
  — audit: `/metrics` is live on the Node apps and the metric set is real.
  Missing: `prometheus-fastapi-instrumentator` on the Python services (not in
  either `pyproject.toml`), and **no `infra/grafana/` directory exists at all**,
  so there is no dashboard and no Grafana to show it. Note the metric label
  cardinality bug fixed 2026-08-11: `contract_id` was a label on two metrics,
  which grows the registry without bound.
- [~] **7.4 — Health + readiness split.** Split `/healthz` (liveness, always 200)
  from `/readyz` (DB + Redis + Neo4j reachable); wire both into the compose
  `healthcheck`s and a future deploy's readiness gate. *Verify: stop Postgres →
  `/readyz` 503, `/healthz` 200.*
  — audit: the split is real and `/readyz` genuinely probes Postgres and Redis.
  It does **not** check Neo4j as specified. No app service exists in compose to
  attach a `healthcheck` to (see 10.1).
- [~] **7.5 — Structured audit log of money movements.** A dedicated
  `payment_events` table + `xai.scored`/`settlement.completed` emit to a
  read-only `audit-log` Grafana panel. *Verify: a full run produces a chronological
  money-event trail viewable in Grafana.*
  — audit: the `payment_events` table (V010) exists and the gateway writes
  `escrow.created` to it. The Grafana panel does not exist, so the trail is not
  viewable. Blocked on 7.3.
- [ ] **7.6 — Alerting rules.** Grafana alert rules: DLQ depth > 0, settlement
  failure rate > 1%, sandbox p95 > 60s, LLM error rate > 5%. *Verify: inject a
  failing handler → DLQ alert fires.*
  — audit: not started; no Grafana. The underlying DLQ metric exists (and was
  corrected from a never-decremented Gauge to a Counter on 2026-08-11).

## Sprint 8 — Security Hardening & Audit

Goal: the system is defensible. Secrets, signatures, sandboxing, and prompts
all pass a review.

- [~] **8.1 — HMAC on every boundary, verified.** Confirm GitHub
  (`webhook-ingest`) and Stripe webhooks verify signatures with constant-time
  compare and reject on mismatch (401/400). Add negative tests for replay,
  truncated, and bad-secret payloads. *Verify: tampered GitHub signature → 401;
  valid → event published.*
  — audit: GitHub was correct all along (raw buffer captured by a content-type
  parser, `timingSafeEqual`, 4 tests). **Stripe could never verify a single real
  webhook.** The route declared `config: { rawBody: true }` — an option belonging
  to `fastify-raw-body`, which is not a dependency and was never registered — so
  the handler fell back to `JSON.stringify(request.body)`, HMACing bytes Stripe
  never signed. Every genuine webhook 401'd; it went unnoticed because the fake
  adapter's `mock_` path is what runs in dev. Fixed 2026-08-11 with negative
  tests. Remaining: replay (timestamp-tolerance) and truncated-payload tests.
- [ ] **8.2 — Secret hygiene pass.** Confirm no secret is logged or serialized
  into events/ledger; rotate `.env.example` defaults; add a `secretlint` CI step
  and a `npm run secrets:scan` script. *Verify: `npm run secrets:scan` exits 0.*
  — audit: not started. No `secretlint`, no `secrets:scan` script, no CI step.
  `.env.example` does exist. The no-secrets-in-ledger property is plausible but
  unaudited.
- [~] **8.3 — Sandbox egress lockdown.** The `ci-worker` Docker sidecar gets
  `--network=none` except an allowlist (npm registry + LocalStack), a read-only
  rootfs, CPU/memory/`--pids-limit`, and a non-root user. *Verify: a test trying
  `curl` to a blocked host fails; sandbox still builds + runs tests.*
  — audit: the strongest-evidenced item in this file. `--network=none`,
  `--read-only`, `--memory`, `--cpus` are all applied, and the Node-permission
  adapter is backed by 11 executed negative tests that each demonstrate one
  escape route staying closed. Missing from the spec: `--pids-limit` and a
  non-root user.
- [ ] **8.4 — Prompt-injection hardening, round 2.** Extend the
  `ai-service` sanitizer beyond regex: structured-output enforcement (zod/json-schema
  on LLM responses), allow-listed output formats, and a system-prompt firewall
  that strips instructions embedded in `requirements` text. *Verify: a payload
  containing `"ignore previous instructions"` is neutralized and the test bundle
  still generates.*
  — audit: not started. No sanitizer or output-schema enforcement anywhere in
  `apps/ai-service/app/`. Note this is not merely theoretical: LLM output is
  written to disk as a test bundle and, since 2026-08-11, is *executed* inside
  the CI sandbox. The sandbox is the containment boundary, which makes 8.3 the
  control actually carrying this risk today.
- [~] **8.5 — Rate limiting + authn.** `@fastify/rate-limit` on the gateway
  (per-IP + per-contract); add a minimal auth layer (signed session or API key)
  before any non-`/healthz` route. *Verify: 100 rapid calls → 429; missing key → 401.*
  — audit: authn is real (JWT bearer + `x-service-token`, argon2id passwords,
  allow-listed public paths). **Rate limiting does not exist** — no
  `@fastify/rate-limit` dependency or usage, so the 429 half of the Verify
  cannot pass. Separately: RBAC/KYC guards were written but attached to no
  route, so any authenticated user could KYC-verify any account and a freelancer
  could lock contracts and trigger settlement (fixed 2026-08-11).
- [ ] **8.6 — Dependency + container scan.** `npm audit --omit=dev` in CI;
  `trivy` scan of built images; fail build on `HIGH`/`CRITICAL`. *Verify: clean
  `trivy` report on the gateway image.*
  — audit: not started. No `trivy`, `npm audit`, or `snyk` step in
  `.github/workflows/production-ci-cd.yml`.
- [ ] **8.7 — Threat-model walkthrough + fixes.** Document the threat model
  (`docs/THREAT_MODEL.md`): STRIDE per service; close any findings; link each fix
  to a task here. *Verify: doc merged with no open `HIGH` items.*
  — audit: `docs/THREAT_MODEL.md` does not exist. Partial raw material lives in
  `docs/ZERO_TRUST_LOOPHOLE_AUDIT.md` and in each sandbox adapter's
  `describeThreatModel()`, which states what it does *not* enforce.

## Sprint 9 — Test Coverage & Quality Gates

Goal: CI is the source of truth for "is this releasable", not a developer's
laptop.

> **Sprint 9 is the critical path.** 16 of 146 JS/TS tests and the entire
> gateway integration surface skip without a live stack, which is why 6.3, 6.4
> and the golden path have never been demonstrated. Everything in Sprint 9
> unblocks a claim made elsewhere in this file.

- [ ] **9.1 — Integration test harness against real services.** `infra/docker-compose.test.yml`
  spins Postgres + Redis + Neo4j + LocalStack; a `test:e2e` npm script brings it
  up, migrates, runs Vitest/pytest, tears down. *Verify: `npm run test:e2e`
  green from clean clone.*
  — audit: not started. No `infra/docker-compose.test.yml`, no `test:e2e`
  script. This is the blocker for 6.3, 6.4, 9.3 and DoD #3.
- [ ] **9.2 — Contract tests for the event bus.** A shared suite
  (`packages/event-bus/test/contract.spec.ts`) runs against `InMemoryBus`,
  `RedisStreamsBus`, and (if Kafka present) `KafkaBus` to prove identical
  ordering/delivery semantics. *Verify: all three adapters pass the same suite.*
  — audit: not started; `contract.spec.ts` does not exist. `event-bus.test.ts`
  covers `InMemoryBus` only, so the three adapters have never been shown to
  agree — and they demonstrably do not: `RedisStreamsBus` implements retries
  and a DLQ, `KafkaBus` implements neither.
- [~] **9.3 — Golden-path E2E test.** A single Vitest test that exercises the
  whole pipeline via the gateway API: initialize → lock → simulate-push → wait
  for `audit.completed` → settle → assert chain verifies + one transfer.
  *Verify: the test passes against the real stack.*
  — audit: `tools/test_e2e_project_flow.js` exists and drives the flow, but it
  is a standalone script rather than a Vitest test, is not wired into any npm
  script, and needs a live stack. Until the 2026-08-11 fixes this path could not
  have passed in any case — the trust-score step always returned 409.
- [ ] **9.4 — Coverage gate at 70%.** `c8`/`vitest --coverage` (Node) and
  `pytest-cov` (Python); CI fails below the threshold on changed packages.
  *Verify: drop a package's coverage to 65% → CI red.*
  — audit: not started. No coverage configuration or CI gate.
- [ ] **9.5 — Load soak.** A `k6` script (`tools/load/soak.js`) drives 50
  concurrent contract runs for 5 min; capture p95 ledger-append and settlement
  latency into `docs/PERFORMANCE.md`. *Verify: no 5xx; p95 within budget.*
  — audit: not started; neither file exists. `tools/benchmark.js` covers some of
  this ground at much lower concurrency.
- [ ] **9.6 — Chaos test.** Kill `ci-worker` and `settlement-worker` mid-run;
  assert the outbox + DLQ let the system recover and complete without duplicates.
  *Verify: contract still settles exactly once after worker restart.*
  — audit: not started. Depends on 9.1 and on app services existing in compose
  (10.1) — there is currently no containerised worker to kill.

## Sprint 10 — Deployment & Release

Goal: one command takes the system from git to a prod-like environment.

- [~] **10.1 — Containerize every service.** Add `Dockerfile` per app
  (multi-stage Node, slim Python); the frontend builds static assets served by
  nginx. Update `infra/docker-compose.yml` to build the app services instead of
  stubs. *Verify: `docker compose up --build` brings the full stack healthy.*
  — audit: 4 of 7 Dockerfiles exist (`gateway`, `ai-service`, `scope-guard`,
  `web`). Missing: `ci-worker`, `settlement-worker`, `webhook-ingest`. More
  importantly `infra/docker-compose.yml` is 101 lines containing **only
  postgres, neo4j, redis and localstack — no application services at all**, so
  `docker compose up --build` starts four databases and nothing else. This is
  the single largest gap in the file and falsifies DoD #2.
- [ ] **10.2 — Infra-as-code for the data plane.** Parameterize compose via
  `.env` for a prod-like profile (`docker-compose.prod.yml` overlay: replicas,
  resource limits, restart policies, logging driver). *Verify: prod overlay
  boots and passes `/readyz`.*
  — audit: not started; no prod overlay. Some Kubernetes manifests exist in
  `infra/k8s/` (namespace, configmap, api-gateway, ingress) — partial coverage
  of a different deployment target than this task specifies.
- [~] **10.3 — Migration + seed on boot.** App containers run `npm run migrate`
  and the Neo4j seed as an init container/entrypoint step; idempotent so
  redeploys are safe. *Verify: fresh DB → boot → schema + seed present.*
  — audit: `tools/migrate.ts` and `tools/seed-users.py` exist, are idempotent,
  and CI runs both. They are **not** wired as a container init step, because
  there are no app containers (10.1).
- [~] **10.4 — Config & secret management.** Document the prod secret strategy
  (Docker secrets / env injection); remove all defaults from prod config; fail
  fast on missing required vars. *Verify: boot without `STRIPE_SECRET_KEY` in
  prod → clear startup error.*
  — audit: fail-fast is real and good — the gateway exits on a missing
  `STRIPE_SECRET_KEY`, on default `JWT_SECRET`/`SERVICE_TOKEN`, and on any user
  row carrying the known demo password hash, all under `NODE_ENV=production`.
  The secret-management *strategy document* does not exist.
- [ ] **10.5 — Release CI pipeline.** `.github/workflows/release.yml`: on tag
  `v*`, build images, push to registry, run `test:e2e` against the deployed
  images, publish artifacts. *Verify: a `v1.0.0-rc.1` tag produces runnable
  images + green pipeline.*
  — audit: not started. Only `production-ci-cd.yml` exists (build, migrate,
  seed, test — no release stage).
- [ ] **10.6 — Rollback + blue-green notes.** Add a `docs/RELEASE.md` covering
  safe rollback (ledger is append-only, so redeploy is always safe) and a
  blue-green path for the gateway. *Verify: dry-run rollback documented and
  executable.*
  — audit: not started; `docs/RELEASE.md` does not exist.

## Sprint 11 — Demo, Docs & Handoff

Goal: anyone can run, understand, and extend AssureCode from the repo alone.

- [ ] **11.1 — Seeded demo dataset.** `infra/seed/demo/` with 2 clients, 3
  freelancers, a locked contract, and a passing repo fixture so `infra:up` →
  web UI shows a finished contract without manual entry. *Verify: fresh clone,
  `infra:up`, open UI → demo contract + score visible.*
  — audit: `infra/seed/` does not exist. `tools/seed-users.py` seeds 3 clients
  and 8 freelancers (and, since 2026-08-11, marks demo clients KYC-VERIFIED so
  the now-enforced compliance gate does not block the walkthrough), but there is
  no locked contract or repo fixture, so the UI still starts empty.
- [x] **11.2 — README rewrite.** Replace the one-liner `README.md` with: what it
  is, architecture diagram, quickstart (`cp .env.example .env && npm i &&
  docker compose -f infra/docker-compose.yml up -d && npm run dev:web && npm run dev:gateway`),
  screenshots/GIF of the full flow, and links to
  `plan.md`/`plan2.md`. *Verify: a new contributor follows README start-to-finish
  without help.*
  — audit: genuinely done and substantial (sitemap, quickstart, doc index). Two
  corrections owed: the repository root path is stale (`C:\Users\hp\AssureCode`),
  and there are no screenshots/GIF.
- [ ] **11.3 — ARCHITECTURE.md.** The big picture: service map, event flow
  diagram (Mermaid), data model, the 5-signal oracle, and the hash-chain
  invariant with the exact `append_ledger` formula. *Verify: diagram renders in
  GitHub; formula matches `V002__ledger.sql`.*
  — audit: does not exist at either `ARCHITECTURE.md` or `docs/ARCHITECTURE.md`.
  `docs/architecture_overview.md` exists but the README marks it superseded.
- [ ] **11.4 — RUNBOOK.md.** Common ops: how to replay a DLQ event, how to
  manually settle, how to verify/repair a chain, how to rotate keys, how to
  read the Grafana dashboards. *Verify: each runbook step is runnable as written.*
  — audit: does not exist. `tools/replay-event.ts` exists, so the DLQ-replay
  step has a real command to document.
- [ ] **11.5 — End-to-end demo script.** `docs/DEMO.md`: click-by-click + curl
  script that drives the full happy path and one failure path (scope blocked),
  suitable for a live walkthrough. *Verify: run the script cold → full demo
  completes in <5 min.*
  — audit: `docs/DEMO.md` does not exist. `docs/PRESENTATION_GUIDE.md` covers
  adjacent ground.
- [ ] **11.6 — Clean repo & CHANGELOG.** Remove any stray build artifacts;
  add `CHANGELOG.md`; confirm `.gitignore` is complete;
  finalize `plan.md`/`plan2.md` statuses. *Verify: `git status` clean after
  build; no secrets tracked.*
  — audit: `CHANGELOG.md` does not exist. `git status` is not clean after a
  build — generated test bundles land in
  `apps/ai-service/storage_fallback/contracts/` untracked. This status audit is
  the "finalize plan2.md statuses" half.
- [ ] **11.7 — Tag v1.0.0.** After 11.1–11.6 pass, cut the release tag and
  publish. *Verify: release pipeline green; images pull and run.*
  — audit: `git tag -l` is empty. No tag has ever been cut.


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

All eight were marked ✅. None is currently true. Re-derived 2026-08-11.

1. ❌ `plan.md` Sprints 0–5 and `plan2.md` Sprints 6–11 are all `[x]`.
   → Sprints 6–11 now stand at 6 `[x]`, 13 `[~]`, 19 `[ ]` of 38 tasks.
2. ❌ One command (`docker compose -f infra/docker-compose.yml up --build`) brings the full stack green,
   seeded with demo data, UI reachable at `http://localhost:3000`, all `/readyz` endpoints 200.
   → Compose contains no application services; this starts four databases. See 10.1.
3. ❌ `npm run test:e2e` passes the golden-path + scope-blocked path against the
   real stack from a clean clone.
   → No such script and no test harness. See 9.1/9.3.
4. ❌ Coverage gate (≥70%) and secret/container scans are green in CI.
   → None of the three exists. See 8.2, 8.6, 9.4.
5. ⚠️ The hash chain verifies after a full run, and the tamper test proves it
   detects modification.
   → The implementation is sound and verifies in-process from each row's own
   canonical bytes rather than asking the database to vouch for itself. But the
   tamper test skips without Postgres, so this has never been *demonstrated*.
   Closest to true of the eight; needs 9.1 only.
6. ❌ A replayed `/settle` produces exactly one Stripe transfer (idempotency
   proven under concurrency).
   → Never demonstrated (test skips without a database), and until 2026-08-11 a
   replay could not even reach settlement — the oracle blocked every contract
   for want of a trust score.
7. ❌ `README.md`, `ARCHITECTURE.md`, `RUNBOOK.md`, `DEMO.md`, and
   `CHANGELOG.md` are merged and accurate.
   → Only `README.md` exists. The other four have never been written.
8. ❌ Tag `v1.0.0` is cut, release pipeline is green, and images run in a
   prod-like profile.
   → No tag, no release pipeline, no prod profile.

### Suggested order

1. **9.1** — the test harness. It is the blocker for 6.3, 6.4, 9.3, 9.6 and DoD
   #3/#5/#6; five existing claims become demonstrable the moment it lands.
2. **10.1** — app services in compose. Unblocks DoD #2, 9.6, and the
   `healthcheck` half of 7.4.
3. **7.2/7.3** — collector, Jaeger, Grafana. Turns emitted telemetry into
   observable telemetry and unblocks 7.5/7.6.
4. **8.2/8.5/8.6** — rate limiting and the scan steps; small, self-contained.
5. **Sprint 11 docs** — mechanical, and best written last when the above is true.

### Known functional gaps (not tracked by any task above)

- **The GitHub webhook path cannot produce an audit.** `webhook-ingest` publishes
  `code.push.received` without a `code` field, so `processCodePush` correctly
  refuses. Only the gateway's `/simulate-push` reaches the pipeline. Closing it
  means cloning `repoUrl` at `commitHash` in the workspace builder.
- **The KYC modal is dead code.** `KycVerificationModal.jsx` is built but is not
  exported from `components/ui/index.js` and is mounted nowhere, so there is no
  in-app route to verification. Demo clients are seeded `VERIFIED` to compensate.
- **`packages/oracle` evaluates 6 signals, not the "5-signal oracle"** this plan
  and the README both reference. Worth reconciling the naming before 11.3.

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
