# Runbook

Operating the AssureCode stack: starting it, checking it is healthy, and
diagnosing it when it is not.

## Prerequisites

- Node 20+, npm 10+
- Python 3.11 with a venv per Python service (`apps/ai-service/.venv`,
  `apps/scope-guard/.venv`)
- Docker with Compose v2
- ~8 GB free RAM for the full stack (the sentence-transformers model and Neo4j
  are the heavy parts; see [Running lean](#running-lean))

## First run

```bash
cp .env.example .env
npm install
npm run infra:up
npm run migrate
```

The defaults in `.env.example` run the whole system offline: `FakeRazorpayAdapter`
(no `rzp_` key), `FakeKycAdapter` (the only KYC implementation), and
`LLM_PROVIDER=fake` if you set it. Nothing calls a paid API unless you supply
credentials.

There is **no self-signup**. Users come from the seed script:

```bash
python tools/seed-users.py
```

## Ports

| Service | Host port | Notes |
|---|---|---|
| web | 3000 | container listens on 8080 (nginx-unprivileged) |
| api-gateway | 4000 | |
| ai-service | 8000 | |
| scope-guard | 8001 | |
| webhook-ingest | 9000 | |
| Postgres | 5432 | |
| Redis | 6379 | |
| LocalStack | 4566 | |
| OTLP gRPC | 4317 | collector |
| Jaeger UI | 16686 | |
| Prometheus | 9090 | |
| Grafana | 3001 | anonymous viewer enabled — local only |

## Health checks

```bash
curl localhost:4000/healthz   # liveness — process is up
curl localhost:4000/readyz    # readiness — probes Postgres AND Redis
curl localhost:4000/metrics   # Prometheus exposition
curl localhost:8000/healthz   # ai-service
curl localhost:8001/healthz   # scope-guard
```

`/healthz` and `/readyz` are not interchangeable. Container healthchecks use
`/healthz` deliberately: pointing them at `/readyz` makes an ordinary database
blip restart-loop the container.

Health, readiness and metrics endpoints are exempt from rate limiting —
a limiter that 429s a kubelet probe turns a busy service into a restarting one.

## Everyday commands

```bash
npm run infra:up          # start the stack
npm run infra:down        # stop it
npm run migrate           # apply pending migrations (idempotent)
npm run audit             # production dependency gate + exception review
npm run seed:neo4j        # matchmaking graph structure (nodes + relationships)
npm test                  # all Node workspace suites
npm run test:coverage     # coverage thresholds (pure-logic packages)
npm run test:e2e          # full stack, isolated compose project, auto teardown
npm run validate:k8s      # schema-validate the manifests
npm run lint
```

Python suites must run from each service's own directory — both declare a
top-level `app` package, so collecting them together resolves one service's
imports against the other and dies during collection:

```bash
cd apps/ai-service  && pytest tests -q
cd apps/scope-guard && pytest tests -q
```

## Observability

- **Traces** — Jaeger at http://localhost:16686. Every service exports OTLP to
  the collector at `otel-collector:4317`. Trace context rides in the event
  envelope, so a trace spans the bus: a settlement span hangs off the publish
  span that triggered it.
- **Metrics** — Prometheus at http://localhost:9090, Grafana at
  http://localhost:3001 with both datasources pre-provisioned.
- **Correlation ids** — every request and event carries one. To follow a single
  contract end to end, grep logs for its correlation id rather than its
  contract id; the id propagates across services and the bus.

Only `api-gateway` and `webhook-ingest` expose `/metrics`. The Python services
have no instrumentation, so their latency does not appear in Prometheus.

## Troubleshooting

### Tests pass but nothing was actually tested

Suites that need infrastructure use `describe.skipIf(!PG_UP)` / `!REDIS_UP` and
announce themselves:

```
[skip] RedisStreamsBus — Bounded Retries & DLQ — requires a running Redis...
       This suite was SKIPPED, not passed.
```

If you see that line, start the stack and re-run, or use `npm run test:e2e`,
which brings up its own isolated stack and does not skip.

### Events vanish with no errors logged

Check `EVENT_BUS_TYPE`. `infra/docker-compose.yml` hardcodes `redis` precisely
because this file ships no broker: an `EVENT_BUS_TYPE=kafka` left in a
developer's `.env` would point every service at a Kafka that is not running.
For the Kafka topology use the overlay:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.kafka.yml up -d
```

`KafkaBus` now throws on an empty broker list and propagates send failures
rather than silently discarding events — an older version swallowed a module
load error and dropped the entire stream with nothing logged.

### Cross-service calls silently fail

`AI_SERVICE_URL`, `SCOPE_GUARD_URL` and `GATEWAY_URL` must be set explicitly and
must not be derived from the `*_PORT` variables. A URL built from a port alone
resolves to the caller's own container. Every one of these calls has a fallback,
so the failure is quiet — matchmaking, test generation, RAG ingest and XAI
scoring all degrade rather than error.

### `/drift/status` returns 503

Working as intended. `configs/c1_rules.json` has `kappa` and `h` null and
`status: PRE_DATA`; no T2 calibration set exists, so no anytime-valid
false-alarm rate can be reported and the endpoint says so instead of inventing
one. `infra/calibration/scope_drift_synthetic_t2.json` exists for wiring checks
only — it is random floats, and **no number derived from it may be reported.**

### Test generation returns `testCount: 0, stub: true`

The gateway returns a stub whenever `ai-service` is unreachable. It is an
explicit degraded response, not a hidden one. Check `ai-service` health and
`AI_SERVICE_URL`.

### `LlmUnavailableError` / HTTP 503 from ai-service

Cloudflare Workers AI is the only provider and there is no fallback. Set
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or set `LLM_PROVIDER=fake`
to run offline against a deterministic fixture. Any other value is rejected at
startup rather than defaulted.

### Gateway refuses to boot in production

By design. It exits non-zero if the Razorpay adapter resolved to the fake, or if
a secret is still a placeholder (`REPLACE_ME`, `changeme`, `dev_insecure_*`,
blank). Fix the configuration; do not remove the guard.

### 429 Too Many Requests

Global limit is 300/minute keyed on the authenticated user (falling back to IP);
`/auth/login` is 10/minute keyed on IP. Tune with `RATE_LIMIT_MAX`,
`RATE_LIMIT_WINDOW`, `RATE_LIMIT_LOGIN_MAX`. Limits are disabled entirely under
`NODE_ENV=test`.

### `npm run seed:neo4j` finds nothing

Fixed — `infra/seed/neo4j/` was previously matched by the bare `neo4j/` pattern
in `.gitignore`, so the seed was never committed. If you are on an older clone,
pull and confirm the file exists.

### Switching the matchmaking graph to Neo4j

Postgres is the default. Neo4j needs **two** seeds, in order:

```bash
docker compose -f infra/docker-compose.yml up -d neo4j
npm run seed:neo4j                                    # nodes + relationships
python tools/seed-neo4j-vectors.py                    # embeddings + vector index
GRAPH_BACKEND=neo4j <start ai-service>
```

The second step is not optional. Without the vector index the adapter degrades
to a hardcoded in-process fixture — the service reports healthy and returns
plausible rankings computed from fixture data, which is the most misleading
failure mode in the system. Confirm with:

```
MATCH (f:Freelancer) WHERE f.embedding IS NOT NULL RETURN count(f)   -- expect 12
SHOW INDEXES WHERE name = 'freelancer_embeddings'
```

The two backends are verified to produce identical rankings — see
`TestCrossBackendParity` in `apps/ai-service/tests/test_graph_repo_neo4j.py`.
That test skips (loudly) unless both `DATABASE_URL` and Neo4j are reachable and
seeded.

### The dependency audit fails

`npm run audit` gates on **production** advisories only, and accepts a finding
only when `docs/security/audit-exceptions.json` carries a dated entry for it.
Three ways it fails:

- *no reviewed exception* — a new advisory appeared. Fix it, or add an entry
  with a real justification and an expiry.
- *past its review date* — an accepted risk lapsed. Do the upgrade, or
  re-review deliberately. Do not extend by habit.
- *no longer fires* — remove the entry; the file must not accumulate dead
  suppressions.

Dev-only advisories (vitest, vite, postcss, nanoid) are reported but not gated:
none of them ship in a published image.

## Running lean

The full stack is heavy. To drop the observability tier:

```bash
docker compose -f infra/docker-compose.yml up -d \
  --scale grafana=0 --scale prometheus=0 --scale jaeger=0 --scale otel-collector=0
```

Services will still try to export spans to `otel-collector:4317`; the OTLP
exporter fails quietly and the application is unaffected.

## Deployment

`infra/k8s/` holds 15 manifests with a strong security posture — `runAsNonRoot`,
`seccompProfile: RuntimeDefault`, `drop: ["ALL"]`, no automounted service
account tokens, 9 NetworkPolicies, resource limits and probes on every workload.

**There is no CD pipeline.** CI builds all 8 images with `push: false` and
discards them; every manifest uses `:latest` with no registry prefix; every
secret is `REPLACE_ME`. A real deployment needs a registry, image tags pinned to
a commit, and one of the secret paths in
`infra/k8s/overlays/` (External Secrets, Sealed Secrets, or a local untracked
override). Do not put live values in `01-configmap-secrets.yaml` — it is tracked.
