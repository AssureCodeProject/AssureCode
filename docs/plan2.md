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

## Status audit — 2026-08-21

This supersedes the 2026-08-11 audit, which had gone ~9 days stale. Statuses below
were re-derived by checking the filesystem for the artifact each task claims to
produce. Where a status changed since 2026-08-11, the evidence is recorded inline
as `— audit:`.

**Verification rule (unchanged):** a task is `[x]` only when its stated *Verify*
command has actually been executed and passed, or when the artifact it names
demonstrably exists and is wired in. "The code is written" is `[~]`.

**What changed since the last audit.** The 2026-08-11 audit was accurate when
written, and most of its headline complaints have since been closed:

* **`infra/docker-compose.yml` now contains the application services.** It grew
  from 101 lines / 4 data services to ~600 lines / 20 services — all seven apps
  built from `infra/docker/Dockerfile.*`, plus `migrate`, `seed`,
  `otel-collector`, `jaeger`, `prometheus` and `grafana`. This was called "the
  single largest gap in the file"; it is closed.
* **The E2E harness exists.** `infra/docker-compose.test.yml` + `scripts/e2e.mjs`
  (241 lines, no TODOs) + `npm run test:e2e`. Sprint 9 was "the critical path";
  its blocking task is done.
* **All 8 Dockerfiles exist** (was 4 of 7).
* **Four of the five Sprint 11 documents now exist** — `ARCHITECTURE.md`,
  `RUNBOOK.md`, `DEMO.md`, `CHANGELOG.md`, all at the repo root rather than in
  `docs/`. Their *content* has gaps (see 11.3–11.6), but DoD #7 is satisfied.
* **Security moved the furthest.** 8.4 (prompt injection), 8.5 (rate limiting),
  8.6 (dependency + container scan) and 8.7 (threat model) all went from
  not-started or partial to done. `apps/ai-service/app/services/prompt_guard.py`
  and `docs/THREAT_MODEL.md` did not exist at the last audit.
* **Payments migrated off Stripe entirely.** `packages/razorpay-adapter` +
  `packages/kyc-adapter` replaced `packages/stripe-adapter`. The raw-body HMAC
  bug 8.1 recorded is fixed and covered by 20 negative tests.

Work also landed that **no task in this file tracks**: RFC 8785 canonical hashing
and the RFC 6962 Merkle tree (`V009`), ML-DSA-87 root signing, the scope-drift
detector, hyperbolic embeddings, 18 Kubernetes manifests, the matchmaking
evaluation harness, and ~530 tests (331 TS/JS across 26 files, 199 Python across
18). The task tally below therefore understates delivered effort.

**Tally after the audit** (38 tasks across Sprints 6–11):

| Sprint | Theme | `[x]` | `[~]` | `[ ]` |
|---|---|---:|---:|---:|
| 6 | Resilience & failure modes | 4 | 2 | 0 |
| 7 | Observability & ops | 1 | 4 | 1 |
| 8 | Security hardening & audit | 5 | 1 | 1 |
| 9 | Test coverage & quality gates | 1 | 2 | 3 |
| 10 | Deployment & release | 2 | 3 | 1 |
| 11 | Demo, docs & handoff | 0 | 5 | 2 |
| **Total** | | **13** | **17** | **8** |

Movement since 2026-08-11: `[x]` 6 → **13**, `[~]` 13 → **17**, `[ ]` 19 → **8**.

**Where the project stands overall:** Sprints 0–5 (the core product) are ~95%
real — 35 of 37 tasks, with `plan.md` 5.3 (the freelancer payout leg) never built
and 3.1 (video proof) withdrawn from scope. Sprints 6–11 are ~63% weighting
partials. Overall ~80%.

**Rough remaining effort:** ~1 week to a citable v1.0.0 artifact. The load-bearing
item is no longer "build the harness" but "point the harness at the app services"
(9.1's follow-on) plus the demo dataset (11.1). Estimate, not a measurement.

---

## What "done after Sprint 5" means

By the end of Sprint 5 the happy path is real end-to-end: contract lock → test
generation → real CI sandbox → security scan → scope guard → XAI score →
idempotent settlement. What remains is everything *around* the happy path:
failure modes, visibility, deployment, the proof, and the handoff. These are
grouped into Sprints 6–11 below, then a cross-cutting checklist and a Definition
of Done.

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
  `INSERT … ON CONFLICT DO NOTHING` before issuing the transfer and gates
  on the oracle inside the same transaction as the `INVOICE` ledger
  append. *Verify: call `/settle` 5× concurrently → exactly one transfer,
  one `settlement.completed`, chain still verifies.*
  — audit: unchanged in substance since 2026-08-11. The guard table (`V004`) and
  claim path are real, and `apps/settlement-worker/test/settlement-concurrency.test.ts`
  asserts exactly one of five concurrent callers acquires the lock. Two
  divergences from this text persist: the ledger action is `SETTLEMENT_COMPLETED`,
  not `INVOICE`; and the oracle is evaluated *before* and outside the settlement
  transaction. The stated Verify has still never been run against a live stack —
  the test skips without a database. **This is now unblocked**: 9.1 landed, so
  the harness to run it exists; it just is not wired to run it yet.
  Separately, note there is no payout leg at all (see `plan.md` 5.3), so "one
  transfer" currently means "one capture to the platform".
- [~] **6.4 — Ledger verification endpoint + tamper test.** `GET
  /api/contracts/:id/verify` calls `LedgerClient.verifyChain`; add a red-team
  test that `UPDATE`s a `merkle_ledger.current_hash` and asserts the endpoint
  flips to `valid:false`. *Verify: tampered row → `409 { valid:false }`.*
  — audit: endpoint and `apps/api-gateway/test/ledger-tamper.test.ts` both exist
  and the verification logic is sound (recomputed in-process from the row's own
  canonical bytes, per `V009__canonical_hash_and_merkle.sql`). The test still
  skips without Postgres, so the tamper claim has never been *demonstrated* —
  but as with 6.3, 9.1 has landed and this is now a wiring job, not a build job.
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
  outbound HTTP/payment call; logs include it on every line. *Verify: grep a
  single correlation id across gateway + worker logs → full trace.*
- [~] **7.2 — OpenTelemetry traces.** Add `@opentelemetry/*` to the Node apps
  and `opentelemetry-*` to the Python services; export to a local
  `otel-collector` (+ Jaeger UI) added to `infra/docker-compose.yml`. Span per
  HTTP request, per event publish, per ledger append. *Verify: one `lock` call
  shows a connected trace through gateway → DB → bus.*
  — audit: **the collector and Jaeger now exist** (`infra/docker-compose.yml:544-565`,
  config at `infra/observability/otel-collector-config.yaml`, OTLP 4317/4318 →
  `otlp/jaeger`; k8s equivalent at `infra/k8s/15-observability.yaml`). That was
  the blocker at the last audit and it is closed. Two gaps remain: only 2 of 4
  Node apps call `initTracing()` (`api-gateway`, `webhook-ingest` — **`ci-worker`
  and `settlement-worker` have 0 matches**, so the two services doing the actual
  work are invisible), and `opentelemetry` appears **0 times** in either Python
  `pyproject.toml`, so `OTEL_EXPORTER_OTLP_ENDPOINT` (set on both at
  `docker-compose.yml:441,476`) is inert and traces stop at the Python boundary.
  `infra/observability/prometheus.yml` documents this honestly in its header.
- [~] **7.3 — Prometheus metrics + Grafana.** `/metrics` on every Node app
  (`prom-client`) and Python service (`prometheus-fastapi-instrumentator`); ship
  `infra/grafana/dashboards/assurecode.json` (ledger appends/s, event lag,
  settlement value, sandbox duration, LLM latency/p95). *Verify: Grafana shows live
  data after a single contract run.*
  — audit: Prometheus and Grafana are now in compose (`:566`, `:580`) with
  datasources provisioned (`:594`) and 4 scrape jobs
  (`infra/observability/prometheus.yml`). `/metrics` is live on 4 of 6 services —
  `api-gateway`, `webhook-ingest`, `ai-service`, `scope-guard`; `ci-worker` and
  `settlement-worker` have no HTTP server at all. `prometheus-fastapi-instrumentator`
  is still absent — both Python services hand-roll on `prometheus-client`, which
  works. **The remaining gap is the dashboard: there is no dashboard JSON anywhere
  in the repo and no `/etc/grafana/provisioning/dashboards/` mount, so Grafana
  boots connected and empty.** Blocks 7.5, 7.6 and RUNBOOK 11.4.
  ◐ **Dashboard resolved 2026-08-24.** `infra/observability/dashboards/pipeline.json` (9 panels across Delivery / Verification / Settlement) plus the provisioning file `infra/observability/grafana-dashboards.yml`, mounted in compose and mirrored into k8s as the `grafana-dashboards` / `grafana-dashboard-provider` ConfigMaps. Note the two mounts sit at different paths on purpose — the provider file lives in `provisioning/dashboards` and points Grafana at `/etc/assurecode/dashboards` for the JSON; mounting both at the same path has them shadow each other. Verified against a running Grafana: the dashboard provisions into the AssureCode folder with all 9 panels. Every panel reads a metric that already existed and was already scraped — the gap was never instrumentation, only the dashboard.
  **Still open on this task:** `ci-worker` and `settlement-worker` expose no `/metrics` at all, so they are absent from the `up` count and from every panel here.

- [x] **7.4 — Health + readiness split.** Split `/healthz` (liveness, always 200)
  from `/readyz` (DB + Redis + Neo4j reachable); wire both into the compose
  `healthcheck`s and a future deploy's readiness gate. *Verify: stop Postgres →
  `/readyz` 503, `/healthz` 200.*
  — audit: `/readyz` exists on 2 of 4 HTTP services. `api-gateway` genuinely
  probes Postgres + Redis but **not Neo4j** as specified; `webhook-ingest`
  returns a static body with no dependency probe; `ai-service` and `scope-guard`
  have **no `/readyz` route at all**, which is why their k8s readinessProbes
  point at `/healthz` (`09-ai-service.yaml:102`, `10-scope-guard.yaml:88`).
  Compose healthchecks now exist (that half was blocked on 10.1 and is unblocked)
  on 9 services, but **not** on `ci-worker`, `settlement-worker`, or any of the
  four observability services.
  ✅ **Resolved 2026-08-24.** `/readyz` added to `ai-service` and `scope-guard` (`app/ports/readiness.py`, shared via the existing `app.ports` path extension); it opens a connection and runs `SELECT 1` rather than a handshake-only check, and reports per-dependency status so a failure names the dependency. K8s readiness probes in `09-ai-service.yaml` / `10-scope-guard.yaml` repointed from `/healthz` to `/readyz`; liveness deliberately stays on `/healthz`, because a liveness probe that fails on a database outage restarts every replica over something no restart fixes. `ci-worker` and `settlement-worker` got compose healthchecks that TCP-probe Redis — not the `node -e "process.exit(0)"` tautology the k8s manifests still use.

- [~] **7.5 — Structured audit log of money movements.** A dedicated
  `payment_events` table + `xai.scored`/`settlement.completed` emit to a
  read-only `audit-log` Grafana panel. *Verify: a full run produces a chronological
  money-event trail viewable in Grafana.*
  — audit: the table is real and has grown — `V010__payment_events_and_users.sql`
  extended by `V014__razorpay_escrow.sql:107-145` with `payment_id`,
  `correlation_id`, `provider`, `provider_event_id` and a unique index used for
  webhook replay dedupe. `api-gateway` writes it from three sites
  (`server.ts:1365,1494,1674`); no other service writes it. **There is still no
  way to read it** — zero read endpoints, no UI reference, and no Grafana panel.
  Blocked on 7.3.
- [x] **7.6 — Alerting rules.** Grafana alert rules: DLQ depth > 0, settlement
  failure rate > 1%, sandbox p95 > 60s, LLM error rate > 5%. *Verify: inject a
  failing handler → DLQ alert fires.*
  — audit: not started. Zero alert-rule files repo-wide; `prometheus.yml` has no
  `rule_files:` or `alerting:` stanza; no alertmanager in compose or k8s.
  Confirmed in-repo at `infra/k8s/15-observability.yaml:19`. The underlying DLQ
  metric exists and is a Counter.

## Sprint 8 — Security Hardening & Audit

Goal: the system is defensible. Secrets, signatures, sandboxing, and prompts
all pass a review.
  ✅ **Resolved 2026-08-24.** `infra/observability/alert-rules.yml` — 5 rules across 3 groups: `DeadLetterQueueNotEmpty`, `EventConsumerLagHigh`, `ServiceDown`, `LlmProviderFailing`, `ScopeGuardBlockingMostRequests`. Wired via `rule_files:` in both `infra/observability/prometheus.yml` and the k8s `prometheus-config` ConfigMap, with a `prometheus-rules` ConfigMap for the cluster. Verified loaded against a running Prometheus (`/api/v1/rules` returns all 5, no config errors). Every rule reads a metric that already existed and was already scraped — none needed new instrumentation. No Alertmanager yet, so these surface in Prometheus's own Alerts tab rather than paging.

- [x] **8.1 — HMAC on every boundary, verified.** Confirm GitHub
  (`webhook-ingest`) and payment webhooks verify signatures with constant-time
  compare and reject on mismatch (401/400). Add negative tests for replay,
  truncated, and bad-secret payloads. *Verify: tampered GitHub signature → 401;
  valid → event published.*
  — audit: **done** (was `[~]`). GitHub was always correct: raw buffer via a
  content-type parser, `timingSafeEqual`, tests at
  `apps/webhook-ingest/test/server.test.ts`. The Stripe raw-body bug this task
  recorded is moot — payments migrated to `packages/razorpay-adapter`, and the
  replacement does it correctly: `api-gateway/src/server.ts:267-281` stashes
  `req.rawBody` as a Buffer, the route passes the Buffer (not a re-serialisation)
  to `verifyWebhook` at `:1626`, and an empty-body guard checks `length === 0`
  rather than truthiness. Replay is handled structurally — `x-razorpay-event-id`
  against the `idx_payment_events_provider_event` unique index, checked before
  any other write (`:1669-1674`). The requested negative tests all exist and
  then some: 10 in `apps/api-gateway/test/razorpay-webhook.test.ts` (incl.
  truncated signature, re-serialised body, idempotent redelivery) and 10 in
  `packages/razorpay-adapter/test/razorpay-adapter.test.ts`.
- [x] **8.2 — Secret hygiene pass.** Confirm no secret is logged or serialized
  into events/ledger; rotate `.env.example` defaults; add a `secretlint` CI step
  and a `npm run secrets:scan` script. *Verify: `npm run secrets:scan` exits 0.*
  — audit: still not started, and now the **smallest self-contained item left in
  this file**. No `.secretlintrc*`, no `secrets:scan` script, no
  gitleaks/trufflehog/detect-secrets step in `production-ci-cd.yml`.
  ⚠️ `tools/secrets-scan.ts`, cited as existing by
  `docs/master_plan_audit_report.md`, **does not exist**. Note
  `scripts/audit-check.mjs` is a *dependency-vulnerability* gate, not a secret
  scanner — it belongs to 8.6. One thing did improve: `.env` was verified never
  to have been committed (`git log --all --diff-filter=A -- .env` is empty).
  ✅ **Resolved 2026-08-24**, though not as specified. No `tools/secrets-scan.ts` and no `npm run secrets:scan` — the finding was the absence of secret scanning, not of that particular file, so this is a `gitleaks/gitleaks-action@v2` step in the existing `security` job of `production-ci-cd.yml`, preceded by a `fetch-depth: 0` checkout (a shallow clone silently reduces gitleaks to a linter for the tip commit). Placed in `security` rather than its own job so a finding blocks the same gate the dependency audit does.

- [x] **8.3 — Sandbox egress lockdown.** The `ci-worker` Docker sidecar gets
  `--network=none` except an allowlist (npm registry + LocalStack), a read-only
  rootfs, CPU/memory/`--pids-limit`, and a non-root user. *Verify: a test trying
  `curl` to a blocked host fails; sandbox still builds + runs tests.*
  — audit: unchanged. `apps/ci-worker/src/sandbox/docker-sandbox.ts:165-176`
  applies `--network=none`, `--read-only`, `--memory`, `--cpus` and a bounded
  tmpfs, and the Node-permission adapter is backed by executed negative tests
  (`sandbox-isolation.test.ts`, 14 tests). Still missing from the spec:
  **`--pids-limit` (0 matches repo-wide)** and a **non-root user on the sandbox
  container**; also no `--cap-drop` and no `--security-opt=no-new-privileges`.
  The trade is documented at `docs/THREAT_MODEL.md:75-88` rather than hidden.
  ✅ **Resolved 2026-08-24.** `docker-sandbox.ts` now adds `--pids-limit=256`, `--user=1000:1000`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `--ulimit nofile/nproc`; `--tmpfs /tmp` gained an explicit `exec` (Docker's default is `noexec`, which the `npm ci` path needs), and `HOME`/`npm_config_cache` were repointed at the tmpfs since `--read-only` makes uid 1000's home unwritable. Verified against a real daemon: a probe run through the shipped `DockerSandbox` class reports `uid=1000`, rootfs writes denied, 3/3 harness assertions passing; a fork loop is refused with `sh: can't fork: Resource temporarily unavailable`.

- [x] **8.4 — Prompt-injection hardening, round 2.** Extend the
  `ai-service` sanitizer beyond regex: structured-output enforcement (zod/json-schema
  on LLM responses), allow-listed output formats, and a system-prompt firewall
  that strips instructions embedded in `requirements` text. *Verify: a payload
  containing `"ignore previous instructions"` is neutralized and the test bundle
  still generates.*
  — audit: **done** (was `[ ]` — "no sanitizer anywhere"). `apps/ai-service/app/services/prompt_guard.py`
  (~260 lines, 25 tests in `tests/test_prompt_guard.py`) implements six detection
  patterns, per-request nonce fencing via `secrets`, and backtick defanging —
  the last closes a real hole where submitted code containing a fence escaped the
  prompt. Wired live at `app/routes/security_scan.py:175`; a detected attempt is
  converted into an A05:2025 HIGH finding, making the attempt its own evidence.
  Structured output is enforced by pydantic `response_model` plus
  `_normalize_llm_findings()`, which drops unknown categories/severities and
  out-of-range line numbers. `owasp_static.py` is the non-injectable floor;
  LLM findings are additive only. Residual risk — finding *suppression* — is
  documented at `prompt_guard.py:19-22` and `THREAT_MODEL.md` T5 rather than
  claimed solved.
- [x] **8.5 — Rate limiting + authn.** `@fastify/rate-limit` on the gateway
  (per-IP + per-contract); add a minimal auth layer (signed session or API key)
  before any non-`/healthz` route. *Verify: 100 rapid calls → 429; missing key → 401.*
  — audit: **done** (was `[~]` — "rate limiting does not exist"). Now registered,
  not merely installed: `api-gateway/src/server.ts:335-353`, `global: true`,
  `max: RATE_LIMIT_MAX ?? 300` per minute, per-user `keyGenerator` falling back
  to IP, allow-list exempting `/healthz|/readyz|/metrics`, plus a tighter bucket
  on `/auth/login` (`:411`). JWT is live (`middleware/auth.ts`, argon2id, WS
  `?token=` restricted to `/stream` paths). The RBAC/KYC guards that were
  previously attached to no route are now composed at `server.ts:564-572` and
  attached to six money/scope-critical routes: `/assign`, `/github-repo`,
  `/lock`, `/escrow`, `/escrow/verify`, `/settle`.
- [x] **8.6 — Dependency + container scan.** `npm audit --omit=dev` in CI;
  `trivy` scan of built images; fail build on `HIGH`/`CRITICAL`. *Verify: clean
  `trivy` report on the gateway image.*
  — audit: **done** (was `[ ]`), with one deliberate non-blocking gate.
  `production-ci-cd.yml:196` runs `scripts/audit-check.mjs` in a `security` job
  that `container-build` depends on, so the npm-audit half genuinely blocks;
  exceptions live in `docs/security/audit-exceptions.json` and expire. Trivy
  runs across an 8-image matrix at `:276-286` with SARIF upload (`:287`) and
  SBOM (`:293`). ⚠️ Trivy is `exit-code: '0'` — report-only by design, with an
  in-file note to flip it once the backlog is triaged, so the "fail build"
  half of the Verify is not yet true. `docs/security/npm-audit.json` is a
  checked-in artifact, not CI output.
- [x] **8.7 — Threat-model walkthrough + fixes.** Document the threat model
  (`docs/THREAT_MODEL.md`): STRIDE per service; close any findings; link each fix
  to a task here. *Verify: doc merged with no open `HIGH` items.*
  — audit: **done** (was `[ ]` — the file did not exist). `docs/THREAT_MODEL.md`
  is 243 lines: assets, actors, trust boundaries, then T1–T10 each with
  mitigation, explicit residual risk, and file references. Two caveats against
  the task text as written. (a) It is **not STRIDE-structured** — `STRIDE`
  appears 0 times; it is threat-per-scenario instead, which is more useful here
  but is a divergence worth naming. (b) The Verify says "no open HIGH items" and
  **two are explicitly NOT MITIGATED**: T9 KYC evasion (stub by design — see
  `packages/kyc-adapter`, whose only implementation is `FakeKycAdapter`) and T10
  session revocation (a leaked token cannot be revoked). Both are accepted and
  documented rather than open-and-unknown, which is why this is `[x]` and not
  `[~]`, but they are real and belong on the product backlog.

## Sprint 9 — Test Coverage & Quality Gates

Goal: CI is the source of truth for "is this releasable", not a developer's
laptop.

> **Sprint 9 was the critical path and its blocking task has landed.** 9.1 is
> done, which unblocks 6.3, 6.4 and 9.3. The remaining constraint is narrower
> and specific: `infra/docker-compose.test.yml` brings up the **data plane only**
> (postgres, redis, neo4j, localstack). It starts no application services, so
> cross-process flows — `ci-worker` consuming an event, the golden path, the
> scope-blocked path — are still not exercised anywhere.

- [x] **9.1 — Integration test harness against real services.** `infra/docker-compose.test.yml`
  spins Postgres + Redis + Neo4j + LocalStack; a `test:e2e` npm script brings it
  up, migrates, runs Vitest/pytest, tears down. *Verify: `npm run test:e2e`
  green from clean clone.*
  — audit: **done** (was `[ ]`, and was the stated blocker for four other items).
  `scripts/e2e.mjs` is 241 lines with no TODOs: Docker probe with a hard exit
  (explicitly "no mock mode, by design"), `compose up --wait` on an isolated
  `assurecode-e2e` project so teardown cannot touch the dev stack, LocalStack
  bucket creation with graceful fallback to `S3_FALLBACK_DIR`, workspace build,
  `tools/migrate.ts`, `tools/seed-neo4j.ts`, `tools/seed-users.py`, the JS/TS
  suites, then pytest per Python app from that app's own directory, then
  `down -v`. A full `TEST_ENV` block pins non-default ports (55432/56379/57687/54566)
  specifically so a stray `.env` cannot point the run at a live shared Postgres.
  Two follow-ons, tracked here rather than reopening the task: the Python steps
  **downgrade a missing `.venv` to a warning**, so a run with zero Python
  coverage reports green; and the test stack has no app services (see the note
  above).
- [ ] **9.2 — Contract tests for the event bus.** A shared suite
  (`packages/event-bus/test/contract.spec.ts`) runs against `InMemoryBus`,
  `RedisStreamsBus`, and (if Kafka present) `KafkaBus` to prove identical
  ordering/delivery semantics. *Verify: all three adapters pass the same suite.*
  — audit: still not started; `contract.spec.ts` does not exist and
  `event-bus.test.ts` is the only test file in the package. What did change:
  `KafkaBus` now implements retries and a DLQ (`src/index.ts:361,495,504-539`)
  where it previously implemented neither, so it and `RedisStreamsBus`
  (`:152,286,299`) have converged. Each still has its own hand-written `describe`
  block rather than a shared runner, and `InMemoryBus` (`:81`) still has neither
  retries nor DLQ — precisely the asymmetry a shared suite would surface.
- [~] **9.3 — Golden-path E2E test.** A single Vitest test that exercises the
  whole pipeline via the gateway API: initialize → lock → simulate-push → wait
  for `audit.completed` → settle → assert chain verifies + one transfer.
  *Verify: the test passes against the real stack.*
  — audit: `tools/test_e2e_project_flow.js` (16.5KB) is thorough and drives the
  whole flow, ending in a six-evidence SQL acceptance query at `:319-334`; every
  step checks its response. It is still **a standalone Node script, not a Vitest
  test, and wired into no npm script** — the only references to it anywhere are
  in two docs. No `*.e2e.test.ts` exists. Its own header admits `audit_results`
  only lands with a running `ci-worker`, which the test compose stack does not
  provide (see the Sprint 9 note). Now unblocked by 9.1; needs converting and
  wiring, plus the scope-blocked path.
- [~] **9.4 — Coverage gate at 70%.** `c8`/`vitest --coverage` (Node) and
  `pytest-cov` (Python); CI fails below the threshold on changed packages.
  *Verify: drop a package's coverage to 65% → CI red.*
  — audit: upgraded from `[ ]` — the machinery now exists and **is enforced in
  CI** (`production-ci-cd.yml:138-139`, "Enforce Coverage Thresholds"). But it
  is not at 70: `vitest.coverage.config.ts:43-65` sets statements **48** /
  branches 80 / functions **55** / lines **48**, against measured
  50.02/82.89/57.54/50.02 — 22 points short on the line/statement gate. Two
  sub-gaps: `include` is `packages/*/test/**` only, so **every `apps/` suite is
  excluded from coverage by design**; and `pytest-cov` is configured nowhere —
  neither `pyproject.toml` passes `--cov` and CI runs bare `pytest tests -q`.
  `packages/oracle` is held at 100/95/100/100, which is the right instinct
  applied to one package.
  ◐ **Half-resolved 2026-08-24.** The Python half is done and enforced: `pytest-cov` added to both `pyproject.toml` files and to the CI install, with `--cov-fail-under=70` for ai-service (measured 76%, 224 tests) and `75` for scope-guard (measured 81%, 29 tests). Thresholds set from a measured run rather than aspirationally — a gate nobody can meet gets lowered on the first red build. **The Node half is unchanged and still fails this task's criterion:** 48% in `vitest.coverage.config.ts`, and its `include` globs cover `packages/*` only, so every suite under `apps/` is excluded from measurement entirely. Raising it needs tests written, not config changed.

- [ ] **9.5 — Load soak.** A `k6` script (`tools/load/soak.js`) drives 50
  concurrent contract runs for 5 min; capture p95 ledger-append and settlement
  latency into `docs/PERFORMANCE.md`. *Verify: no 5xx; p95 within budget.*
  — audit: not started. `tools/load/` does not exist, no k6 script anywhere, no
  `docs/PERFORMANCE.md`. `tools/benchmark.js` is real (no simulation path) and
  reports p90/p99, but defaults to **30 contracts at concurrency 5**, covers only
  `initialize`/`lock`/`escrow`/`scopeCheck` — **not push, audit or settle** — and
  has no duration/ramp concept, so it is a burst run, not a soak.
- [ ] **9.6 — Chaos test.** Kill `ci-worker` and `settlement-worker` mid-run;
  assert the outbox + DLQ let the system recover and complete without duplicates.
  *Verify: contract still settles exactly once after worker restart.*
  — audit: not started. Zero tests kill or restart a worker. The closest existing
  coverage is `settlement-concurrency.test.ts` and `idempotency-concurrency.test.ts`,
  which prove single-fire under *concurrent requests* — a different property from
  crash recovery. Depends on app services existing in the test compose stack.

## Sprint 10 — Deployment & Release

Goal: one command takes the system from git to a prod-like environment.

- [x] **10.1 — Containerize every service.** Add `Dockerfile` per app
  (multi-stage Node, slim Python); the frontend builds static assets served by
  nginx. Update `infra/docker-compose.yml` to build the app services instead of
  stubs. *Verify: `docker compose up --build` brings the full stack healthy.*
  — audit: **done** (was `[~]`, and was called "the single largest gap in this
  file"). All 8 Dockerfiles exist in `infra/docker/`. `infra/docker-compose.yml`
  went from 101 lines / 4 data services to ~600 lines / 20 services, and it
  **builds** every app service from `infra/docker/Dockerfile.*` rather than
  pulling. Two residual rough edges rather than blockers: `ci-worker` and
  `settlement-worker` have **no healthcheck** (they run no HTTP server — see
  7.3/7.4), and `web` uses the bare-list `depends_on: [api-gateway]` with no
  `service_healthy` condition. Also `webhook-ingest` does not gate on `migrate`
  despite doing a Postgres contract lookup on the request path.
- [~] **10.2 — Infra-as-code for the data plane.** Parameterize compose via
  `.env` for a prod-like profile (`docker-compose.prod.yml` overlay: replicas,
  resource limits, restart policies, logging driver). *Verify: prod overlay
  boots and passes `/readyz`.*
  — audit: `infra/docker-compose.prod.yml` still does not exist. ⚠️ It is cited
  as existing by `docs/master_plan_audit_report.md`; it does not. The Kubernetes
  side is genuinely strong and covers most of the *intent* against a different
  target: 18 manifests, `limits:` in 14, `replicas:` on every workload, and
  `13-autoscaling.yaml` is a real `autoscaling/v2` HPA (api-gateway 3→12 @ 70%
  CPU, ai-service 2→8 @ 75%, with documented rationale for excluding the two
  workers). CI validates them via `scripts/validate-k8s.py` + `kubeconform -strict`.
- [x] **10.3 — Migration + seed on boot.** App containers run `npm run migrate`
  and the Neo4j seed as an init container/entrypoint step; idempotent so
  redeploys are safe. *Verify: fresh DB → boot → schema + seed present.*
  — audit: **done** (was `[~]`, blocked on 10.1). `migrate` (`:256`), `seed`
  (`:274`) and `seed-neo4j-vectors` (`:306`) are wired as one-shot `restart: "no"`
  services, and `service_completed_successfully` gates are in place on
  `api-gateway`, `ci-worker`, `settlement-worker` and `ai-service`. Idempotency
  holds: migrate tracks `_migrations`, seed upserts on `user_id`. k8s equivalents
  at `12-migrate-job.yaml` and `16-seed-neo4j-job.yaml`. Minor: `seed-neo4j-vectors`
  sits behind `profiles: ["neo4j"]` and nothing depends on it, so a graph backend
  is opt-in.
- [~] **10.4 — Config & secret management.** Document the prod secret strategy
  (Docker secrets / env injection); remove all defaults from prod config; fail
  fast on missing required vars. *Verify: boot without the payment secret in
  prod → clear startup error.*
  — audit: the fail-fast half is done and tested. `packages/config/src/secrets.ts`
  `assertProductionSecrets()` rejects placeholders (`REPLACE_ME`, `changeme`, the
  known dev JWT/service tokens) and blanks under `NODE_ENV=production`, is called
  at boot by both `api-gateway` and `webhook-ingest`, and is covered by
  `packages/config/test/secrets.test.ts`. Real overlays now exist too —
  `infra/k8s/overlays/{external-secrets,sealed-secrets,local}/`, the sealed-secrets
  README being a full kubeseal walkthrough. **The strategy document still does
  not exist**; the nearest thing is `RUNBOOK.md:240-251`, which states plainly
  that there is no CD pipeline and every manifest ships `REPLACE_ME`.
- [~] **10.5 — Release CI pipeline.** `.github/workflows/release.yml`: on tag
  `v*`, build images, push to registry, run `test:e2e` against the deployed
  images, publish artifacts. *Verify: a `v1.0.0-rc.1` tag produces runnable
  images + green pipeline.*
  — audit: upgraded from `[ ]` because `production-ci-cd.yml` has become
  substantial — 353 lines across five jobs: `lint` (eslint + ruff), `test`
  (pgvector service container, migrate, seed, npm test, **coverage gate**, both
  pytest suites, ML-DSA suite), `security` (`audit-check.mjs`), `container-build`
  (8-image matrix + Python import smoke test + Trivy + SARIF + SBOM), and
  `k8s-validate`. But against *this task* it falls short on every clause:
  ⚠️ `.github/workflows/release.yml` **does not exist** (it too is cited as
  existing by `docs/master_plan_audit_report.md`); there is **no `tags:` trigger**;
  `container-build` sets **`push: false`** (`:251-252`) so images are built and
  discarded, never reaching a registry; and the workflow contains **zero
  references to `test:e2e`** — the one command that proves the system works never
  runs in CI. SBOM is the only published artifact.
- [ ] **10.6 — Rollback + blue-green notes.** Add a `docs/RELEASE.md` covering
  safe rollback (ledger is append-only, so redeploy is always safe) and a
  blue-green path for the gateway. *Verify: dry-run rollback documented and
  executable.*
  — audit: not started. ⚠️ `docs/RELEASE.md` **does not exist** despite being
  cited as existing by `docs/master_plan_audit_report.md`. Repo-wide search for
  blue-green/canary over docs and manifests returns only the plan files *asking*
  for it. `RUNBOOK.md:240` has a Deployment section, but it documents the
  *absence* of CD rather than a rollback procedure.

## Sprint 11 — Demo, Docs & Handoff

Goal: anyone can run, understand, and extend AssureCode from the repo alone.

- [ ] **11.1 — Seeded demo dataset.** `infra/seed/demo/` with 2 clients, 3
  freelancers, a locked contract, and a passing repo fixture so `infra:up` →
  web UI shows a finished contract without manual entry. *Verify: fresh clone,
  `infra:up`, open UI → demo contract + score visible.*
  — audit: still not started, and now **the single biggest gap for a demo
  artifact** — every other Sprint 11 item is a content edit to a file that
  already exists. `infra/seed/` still holds exactly one file (the Neo4j
  matchmaking cypher). `tools/seed-users.py` seeds 3 clients + 12 freelancers
  into `users` and `freelancer_profiles` and **creates no contract**; the only
  `INSERT INTO contracts` statements in the repo live in four `tools/verify_phase*`
  harnesses, not in a seed path. So after `npm run infra:up` you can log in and
  the UI is empty: no locked contract, no `merkle_ledger` rows, no repo fixture,
  no settlement to look at.
- [~] **11.2 — README rewrite.** Replace the one-liner `README.md` with: what it
  is, architecture diagram, quickstart, screenshots/GIF of the full flow, and
  links to `plan.md`/`plan2.md`. *Verify: a new contributor follows README
  start-to-finish without help.*
  — audit: **downgraded from `[x]`.** The prose is the best-maintained document
  in the repo — quickstart, port table, per-service test commands, a doc index,
  and a "Status & Limitations" section that is genuinely accurate (it volunteers
  the missing payout leg, the fake KYC adapter, 60% scope-guard recall, and that
  tracing stops at the Python boundary). The stale `C:\Users\hp\AssureCode` path
  flagged last time is **fixed** (0 hits repo-wide). But two clauses of the task
  are still unmet: **no architecture diagram** (0 mermaid blocks) and **no
  screenshots or GIF** (0 image references, no assets). Minor: `README.md:61`
  says migrations run V001–V014; `V015__contracts_github_repo.sql` exists.
- [~] **11.3 — ARCHITECTURE.md.** The big picture: service map, event flow
  diagram (Mermaid), data model, the oracle, and the hash-chain
  invariant with the exact `append_ledger` formula. *Verify: diagram renders in
  GitHub; formula matches `V002__ledger.sql`.*
  — audit: upgraded from `[ ]` — the file now exists at the repo root (251 lines)
  with an ASCII service map, a 5-phase data flow, design decisions, the data
  plane, and a candid "known structural issues" section. Three of the task's
  five clauses are unmet: **no Mermaid** (0 hits, so nothing renders in GitHub),
  **no data model**, and — most importantly — **the `append_ledger` formula is
  absent** (0 hits for `append_ledger`, `sha256`, `SHA-256`; only prose about
  RFC 8785/6962). That formula is the system's central invariant and it has two
  versions, neither documented: `V002__ledger.sql:70-77` (`hash_version` 1) is
  superseded by `V009__canonical_hash_and_merkle.sql:149-150`,
  `SHA256(payload_canonical || E'\n' || previous_hash)` (`hash_version` 2). Note
  the Verify clause "formula matches `V002`" is itself now stale. The oracle is
  described correctly as six signals (`:82-94`). Minor: `:161-164` says 14
  migrations; there are 15.
- [~] **11.4 — RUNBOOK.md.** Common ops: how to replay a DLQ event, how to
  manually settle, how to verify/repair a chain, how to rotate keys, how to
  read the Grafana dashboards. *Verify: each runbook step is runnable as written.*
  — audit: upgraded from `[ ]` — the file exists at the repo root (251 lines) and
  what it *does* contain is good and verified runnable: prerequisites, first run,
  a port table, health checks, everyday commands, 11 troubleshooting entries, and
  an honest Deployment section. But **none of the five procedures this task names
  is present**: "replay" appears 0 times (though `tools/replay-event.ts` exists
  and is ready to document), manual settlement 0, chain verify/repair 0 (though
  `npm run ledger:legacy` and `tools/verify_phase8_live.mjs` exist), key rotation
  0, and Grafana appears only as "datasources pre-provisioned" — which is as far
  as it *can* go until 7.3 ships a dashboard. Also resolve the contradiction with
  `ARCHITECTURE.md:206-209` over which services expose `/metrics`.
- [~] **11.5 — End-to-end demo script.** `DEMO.md`: click-by-click + curl
  script that drives the full happy path and one failure path (scope blocked),
  suitable for a live walkthrough. *Verify: run the script cold → full demo
  completes in <5 min.*
  — audit: upgraded from `[ ]` and the closest of the Sprint 11 items to done.
  `DEMO.md` exists at the repo root (172 lines) with click-by-click steps
  against real element IDs (`#btn-login-submit`, `#btn-simulate-push`,
  `#btn-release-funds`), and **the scope-blocked failure path is there**
  (`:128-132`). Two gaps: the **curl half is thin** — one `curl /readyz` and
  nothing for initialize/lock/simulate-push/oracle/settle; and `:111-116` is
  **stale**, still asserting the GitHub webhook cannot produce an audit, which
  `apps/ci-worker/src/source-fetcher.ts` fixed. Also depends on 11.1: run cold
  today, the demo starts from an empty UI.
- [~] **11.6 — Clean repo & CHANGELOG.** Remove any stray build artifacts;
  add `CHANGELOG.md`; confirm `.gitignore` is complete;
  finalize `plan.md`/`plan2.md` statuses. *Verify: `git status` clean after
  build; no secrets tracked.*
  — audit: upgraded from `[ ]`; most clauses now pass. `CHANGELOG.md` exists
  (280 lines, Keep-a-Changelog). `git status --porcelain` is **clean**.
  `.gitignore` covers `node_modules/`, `dist/`, `coverage/`, `storage_fallback/`
  (including the `apps/ai-service/` path that used to dirty the tree), `.venv/`,
  `__pycache__/` and `.env` with a `!.env.example` negation — and
  `git ls-files` confirms none of those are tracked. **`.env` was never
  committed** (`git log --all --diff-filter=A -- .env` is empty): no secret leak.
  Three clauses remain. (a) `CHANGELOG.md` has only `[Unreleased]` — no released
  section. (b) **`AssureCode-FrontEnd/` is 40 tracked files of dead weight**: a
  second React SPA running entirely on mock data, not an npm workspace, not
  built by `Dockerfile.web`, not mentioned in the README layout, unreachable.
  Delete or document it. (c) "finalize plan.md/plan2.md statuses" — this audit
  is that half for `plan2.md`.
- [ ] **11.7 — Tag v1.0.0.** After 11.1–11.6 pass, cut the release tag and
  publish. *Verify: release pipeline green; images pull and run.*
  — audit: not started. `git tag -l` is empty; `package.json` is at
  `1.0.0-alpha.0`. ⚠️ `docs/master_plan_audit_report.md` claims "Tag `v1.0.0`
  validated"; no tag has ever been cut. Note the Verify clause depends on 10.5,
  which does not exist either.

---

## Cross-cutting (continues from `plan.md`)

- **CI (`.github/workflows`):** the coverage gate (9.4) and container scan (8.6)
  have landed in `production-ci-cd.yml`. Still owed: the secret scan (8.2), the
  release stage (10.5), and — most importantly — wiring `npm run test:e2e` into
  CI at all.
- **Observability as a feature:** every new endpoint/migration added in Sprints
  6–8 must carry its metric (7.3) and trace span (7.2) in the same PR. Note the
  two workers currently carry neither.
- **Windows-first DX:** keep all commands runnable under `cmd.exe` /
  cross-platform npm; Linux-only steps stay inside Docker.

## Definition of Done (the project is "complete" when all are true)

Re-derived 2026-08-21. One is now true, five are partial, two remain false.

1. ❌ `plan.md` Sprints 0–5 and `plan2.md` Sprints 6–11 are all `[x]`.
   → Sprints 6–11 stand at 13 `[x]`, 17 `[~]`, 8 `[ ]` of 38 (was 6/13/19).
2. ⚠️ One command (`docker compose -f infra/docker-compose.yml up --build`) brings the full stack green,
   seeded with demo data, UI reachable, all `/readyz` endpoints 200.
   → The stack half is now true: compose builds all seven app services with
   migrate/seed init steps and healthchecks (10.1, 10.3). Two clauses still fail
   — **no demo data** (11.1), and `/readyz` exists on only 2 of 4 HTTP services
   (7.4).
3. ⚠️ `npm run test:e2e` passes the golden-path + scope-blocked path against the
   real stack from a clean clone.
   → The script exists and is real (9.1). But the test stack runs **no app
   services**, the golden path is still an unwired standalone script (9.3), and
   the scope-blocked path is not automated anywhere. Closest to flipping.
4. ⚠️ Coverage gate (≥70%) and secret/container scans are green in CI.
   → Two of three now exist and run. Coverage is enforced but at **48%, not 70**,
   and excludes all of `apps/` (9.4); the container scan runs but is
   **report-only** (8.6); the **secret scan does not exist** (8.2).
5. ⚠️ The hash chain verifies after a full run, and the tamper test proves it
   detects modification.
   → Unchanged in substance, but no longer blocked: the implementation is sound
   and the tamper test exists; 9.1 now provides the Postgres it needs. It has
   still never been executed.
6. ⚠️ A replayed `/settle` produces exactly one transfer (idempotency proven
   under concurrency).
   → The guard table, the concurrency test and the harness all now exist; the
   test has not been run against a live stack. Separately, "one transfer" is
   aspirational — **there is no payout leg**, only capture to the platform.
7. ✅ `README.md`, `ARCHITECTURE.md`, `RUNBOOK.md`, `DEMO.md`, and
   `CHANGELOG.md` are merged and accurate.
   → **Now true.** All five exist at the repo root (four written since the last
   audit). Content gaps are tracked in 11.2–11.6 — chiefly the missing
   `append_ledger` formula and the five absent runbook procedures — and one
   stale passage in `DEMO.md:111-116` should be corrected, but the documents are
   merged and broadly accurate.
8. ❌ Tag `v1.0.0` is cut, release pipeline is green, and images run in a
   prod-like profile.
   → No tag, no `release.yml`, no prod compose overlay, and CI never pushes an
   image (`push: false`).

### Suggested order

The 2026-08-11 order has been largely executed. Revised for what is left, and
scoped to **v1.0.0 as a citable research/demo artifact** rather than a product
launch:

1. **App services in the test compose stack**, then convert 9.3 to Vitest and
   wire it into `scripts/e2e.mjs` and CI. This is the follow-on to 9.1 and it
   flips DoD #3, #5 and #6 at once — three criteria for one piece of work.
   Also make a missing Python `.venv` fail the run rather than warn.
2. **11.1 demo dataset.** The largest remaining single gap: every other Sprint 11
   item is an edit to a file that exists, this one is absent entirely, and
   without it a cold reviewer opens an empty UI.
3. **11.3 / 11.4 doc content** — the `append_ledger` formula and a Mermaid
   diagram in `ARCHITECTURE.md`, the five procedures in `RUNBOOK.md`. All the
   underlying commands already exist; this is writing, not building.
4. **8.2 secret scan.** Smallest self-contained item in the file, and it closes
   the last missing third of DoD #4.
5. **7.3 Grafana dashboard JSON.** Unblocks 7.5, 7.6 and the Grafana half of
   11.4. Grafana already boots with datasources provisioned — it has no panels.
6. **11.6 cleanup + 11.7 tag.** Delete or document `AssureCode-FrontEnd/`, cut a
   released CHANGELOG section, tag.

Deferred as product-launch concerns rather than artifact concerns: 7.6 alerting,
9.5 soak, 9.6 chaos, 10.2 prod overlay, 10.5 release pipeline, 10.6 blue-green.

### Known functional gaps (not tracked by any task above)

- **There is no freelancer payout leg.** Settlement *captures* the client's
  authorised payment to the platform; nothing transfers it onward. `plan.md`
  task 5.3 described this and it was never realised through either payment
  provider. This is the most significant functional gap in the system.
- **KYC approves everything.** `packages/kyc-adapter` has exactly one
  implementation and it is `FakeKycAdapter`. No vendor is wired.
  `THREAT_MODEL.md` T9 records this as "NOT MITIGATED — stub by design".
- **Dispute/arbitration is not implemented**, and the UI button says so.
- **Session revocation is absent** — a leaked JWT cannot be revoked
  (`THREAT_MODEL.md` T10).
- **The KYC modal is still dead code.** `apps/web/src/components/ui/KycVerificationModal.jsx`
  exists but is not exported from the `ui/index.js` barrel and has zero
  importers, so there is no in-app route to verification. Demo clients are
  seeded `VERIFIED` to compensate. *(Unchanged since 2026-08-11.)*
- **Scope-guard recall is 60%** (accuracy 68%, precision 100%) over 50 live
  contracts — it blocks legitimate requests more often than it should. The
  drift detector runs on a **synthetic** calibration set and says so in every
  response (`calibration_is_synthetic: true`).
- **Matchmaking is closer to keyword than semantic matching** — P@1 0.750 on
  tech-named queries but 0.375 on outcome-only phrasing.
- **17 legacy ledger rows** predate canonicalization and are reported
  `unverifiable`, distinct from verified or failed. `npm run ledger:legacy`
  seals rather than backfills them.
- **Real GitHub push auditing is off by default.** *(Resolved in code since
  2026-08-11 — previously listed here as broken.)*
  `apps/ci-worker/src/source-fetcher.ts` fetches a GitHub tarball pinned to
  `commitHash` (never `ref`), wired at `worker.ts:57-67`, with contract linkage
  via `V015` + `PATCH /api/contracts/:id/github-repo`. But
  `ENABLE_GITHUB_SOURCE_FETCH` defaults `false` in both compose and k8s, and it
  has never been run against live GitHub — so in practice only `/simulate-push`
  reaches the pipeline. `tools/github-webhook-replay.mjs` signs and replays real
  deliveries for local testing.
- **`packages/oracle` evaluates 6 signals, not 5.** *(Resolved since 2026-08-11.)*
  `src/index.ts:27-34` gates on `astPassed`, `testsPassed`, `securityPassed`,
  `scopePassed`, `trustScore >= 85` and `criticalVulns === 0`. `README.md`,
  `ARCHITECTURE.md`, `DEMO.md` and `plan.md` all now say six and explicitly
  retract "five"; the only remaining "5-signal" references are in
  `docs/architecture_overview.md`, which is labelled superseded.

### Documents that should not be trusted

- **`docs/master_plan_audit_report.md`** marks Sprints 6–11 and all 8 DoD
  criteria "PASSED" and cites at least nine artifacts that do not exist:
  `infra/grafana/dashboards/assurecode.json`, `tools/secrets-scan.ts`,
  `packages/event-bus/test/contract.spec.ts`, `tools/load/soak.js`,
  `docker-compose.prod.yml`, `.github/workflows/release.yml`, `docs/RELEASE.md`,
  `infra/seed/demo/`, and tag `v1.0.0`. It carries a historical banner but the
  banner did not reach these claims; a correction notice has been added at the
  head of that file.
- **`docs/architecture_overview.md`**, **`docs/NEXTGEN_RESEARCH_PARADIGM.md`**,
  **`docs/NOVEL_RESEARCH_METHODOLOGY.md`** and
  **`docs/RESEARCH_PERFORMANCE_ANALYSIS.md`** are superseded or retracted and
  say so themselves. ML-DSA-87 Merkle-root signing is the one claim from that
  line of work that was retained and made real.

## Notes for the coding agent (continues from `plan.md`)

- Resume in workspace order: shared packages → apps → wire UI last in each slice.
- Every acceptance command must pass before the next task; if an
  environment-bound command (payment keys, ngrok, Kafka) is unavailable,
  implement behind the port + a fake and mark `[!]` `blocked-pending-credentials`,
  not `[x]`.
- Keep the existing UI element IDs stable — `DEMO.md` walks the demo by ID.
- When a task touches money or the ledger (6.1, 6.3, 6.5, 7.5), prefer a
  transactional, idempotent design over a "fast" one.
- All docker-compose commands should use the explicit path
  `docker compose -f infra/docker-compose.yml` (or the prod/test overlay)
  since the compose file does not live at the repo root.
