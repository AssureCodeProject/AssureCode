# AssureCode — Handoff for the 32GB machine

**Give this whole file to Claude Code** (either it'll already be in the repo after
`git pull`, or paste this file's contents directly into a fresh chat). It has no memory
of the conversation that produced it — everything needed is below.

---

## 0. What this is, in one paragraph

AssureCode is a "Trust-Code 2.0" freelance-escrow platform: a Fastify API gateway, a
FastAPI `ai-service` (NLP matchmaking over pgvector + XAI trust scoring), a FastAPI
`scope-guard` (RAG-based chat scope enforcement + conformal drift detection), a
`ci-worker` (sandboxed code audit), a `settlement-worker` (event-driven escrow release),
and a React/Vite frontend — all wired through a pluggable event bus (Redis Streams /
Kafka / in-memory) and a Postgres+pgvector database (currently Supabase-hosted). Every
piece below was built and unit/integration-tested on an 8GB machine that cannot run the
full 6-service stack plus a real message broker at once. **Your job on this 32GB machine
is to prove it as one continuous, real, running system for the first time, fix one known
bug, and do the live-only verification that the smaller machine couldn't.**

Repo: `https://github.com/Suhaskumard/AssureCode.git`. Confirm you're on the right
branch/commit with `git log -1 --format="%H %s"` before starting.

---

## 1. Two things the human needs to hand you manually (not through git)

1. **`.env`** — gitignored, never committed, not in this document. It must be copied
   directly from the 8GB machine (USB drive, direct file transfer — never pasted into
   chat, never committed). It contains the Supabase DB password, `JWT_SECRET`,
   `SERVICE_TOKEN`, `CLOUDFLARE_API_TOKEN`, and `ML_DSA_SEED_HEX`. **Keep those specific
   values identical to the 8GB machine's copy** — if both machines might touch the same
   Supabase database or verify each other's tokens/signatures, mismatched secrets break
   things in confusing ways. The only values you're expected to change while doing this
   work are `EVENT_BUS_TYPE` (section 5) and optionally `STRIPE_SECRET_KEY` (section 8).
2. Confirmation that the working-tree changes from the 8GB machine's session were
   committed and pushed before you pulled. If `git log -1` doesn't show a recent commit
   touching `apps/api-gateway/src/middleware/auth.ts`, `apps/web/src/components/LoginScreen.jsx`,
   or `tools/eval/build_t2_calibration.py`, stop and ask the human to push first.

---

## 2. One-time machine setup

Requirements: Node ≥20 (built/tested with v24.18.0), Python ≥3.11, Docker Desktop (WSL2
backend if Windows — needed for local infra, the Kafka broker, and the ci-worker's real
Docker sandbox).

```bash
# from repo root
npm install                     # installs all workspaces (apps/* + packages/*)

# ai-service — full extras include sentence-transformers, psycopg, pgvector, boto3, dilithium-py
cd apps/ai-service
python -m venv .venv
.venv/Scripts/pip install -e ".[full,test]"      # Windows
# .venv/bin/pip install -e ".[full,test]"        # macOS/Linux
cd ../..

# scope-guard — base deps already include sentence-transformers/psycopg/pgvector; [dev] adds pytest
cd apps/scope-guard
python -m venv .venv
.venv/Scripts/pip install -e ".[dev]"
cd ../..
```

Copy `.env` into the repo root now (see section 1).

---

## 3. Start infrastructure

```bash
npm run infra:up
# -> docker compose --env-file .env -f infra/docker-compose.yml up -d
# starts local Postgres (pgvector), Neo4j, Redis, LocalStack (S3)
```

**Important:** `.env`'s `DATABASE_URL` currently points at the remote Supabase instance
used during development, *not* this local Postgres container. That's deliberate — it
means you get the same seeded users/freelancers/contracts the 8GB machine already has,
with no re-seeding needed. Leave `DATABASE_URL` alone unless you deliberately want an
isolated local DB (in which case you'd need to run the migrations in
`infra/migrations/postgres/` in order and then `python tools/seed-users.py`).

Kafka is a separate compose file, not bundled into `infra:up`:

```bash
docker compose -f infra/docker-compose.kafka.yml up -d
# starts zookeeper + kafka, broker reachable at localhost:9092
```

---

## 4. Start all six services (six separate terminals)

```bash
npm run dev:gateway                                              # :4000
npm run dev:ci                                                   # ci-worker, no port
npm run dev:settlement                                           # settlement-worker, no port
npm -w @assurecode/webhook-ingest run dev                        # :9000 (optional — /simulate-push bypasses this)
npm run dev:web                                                  # :5173, open this in a browser

cd apps/ai-service && .venv/Scripts/python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
cd apps/scope-guard && .venv/Scripts/python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

If everything starts cleanly with `EVENT_BUS_TYPE=redis` (the current `.env` default),
that already proves more than the 8GB machine ever could — a real Redis-backed
cross-process event bus, not the in-memory single-process fallback used for local
verification before.

---

## 5. Fix the Kafka bug, then prove Kafka works too

**The bug** (found during a code-quality refactor on the 8GB machine, not yet fixed):
`packages/event-bus/src/index.ts`, class `KafkaBus`, around line 318:

```ts
constructor(brokers: string[], clientId = 'assurecode-bus') {
  try {
    const { Kafka } = require('kafkajs');   // <-- require() in an ESM package
    this.kafka = new Kafka({ clientId, brokers });
    this.producer = this.kafka.producer();
  } catch {
    this.kafka = null;                       // <-- silently swallows the failure
    this.producer = null;
  }
  ...
}
```

`packages/event-bus/package.json` has `"type": "module"` — this file is ESM, where
`require` doesn't exist. That line throws a `ReferenceError` every time, the `catch`
swallows it, and from then on `publish()`/`subscribe()` silently no-op. **Right now,
`EVENT_BUS_TYPE=kafka` drops every single event with zero errors logged.** It's also
worth knowing `kafkajs` isn't even listed as a dependency in
`packages/event-bus/package.json` — it would fail even if `require` worked.

**Fix:**

1. Add the real dependency:
   ```bash
   npm install kafkajs --workspace=@assurecode/event-bus
   ```
2. In `packages/event-bus/src/index.ts`, add a static import near the top with the
   other imports:
   ```ts
   import { Kafka } from 'kafkajs';
   ```
3. In the `KafkaBus` constructor, drop the runtime `require` and just use the
   statically-imported `Kafka` directly. Since a static import can't silently "not be
   there" the way `require` could, decide what (if anything) the `try/catch` should
   still guard — `new Kafka(...)` doesn't connect to a broker immediately, so
   constructing it shouldn't normally throw. A reasonable version:
   ```ts
   constructor(brokers: string[], clientId = 'assurecode-bus') {
     this.kafka = new Kafka({ clientId, brokers });
     this.producer = this.kafka.producer();
     ...
   }
   ```
   (Keep whatever error handling already exists around actual `connect()`/`send()`
   calls elsewhere in the class — this only concerns the constructor's now-pointless
   catch.)
4. Rebuild and re-run the existing suite:
   ```bash
   npm run build
   npm test --workspace=@assurecode/event-bus
   # baseline on the 8GB machine (in-memory bus only) was 4 passed, 1 skipped
   ```
5. **Prove it live** — this path has never actually been exercised end-to-end before:
   - Set `EVENT_BUS_TYPE=kafka` in `.env`.
   - Confirm `docker compose -f infra/docker-compose.kafka.yml up -d` is running.
   - Start gateway + ci-worker + settlement-worker (section 4).
   - Push a contract through to the code-push step (section 6) and confirm ci-worker's
     terminal actually logs receiving `CODE_PUSH_RECEIVED`, and that `audit_results`
     shows up in the DB for that contract. If nothing happens, the fix didn't take —
     don't just trust a clean build, watch the events actually cross processes.
   - Switch back to `EVENT_BUS_TYPE=redis` afterward if that's the intended demo
     configuration (Redis is the documented default; Kafka is validated but optional).

---

## 6. Full click-through acceptance run

This is the actual "prove it's demo-ready" step — do this by clicking through the UI at
`http://localhost:5173`, not by trusting a script.

1. **Login** as `client@acme.com` / `demo1234` (or any of the seeded accounts — see
   `tools/seed-users.py` for the full list of 3 clients / 12 freelancers).
2. **Initialize a contract** — either paste requirements text or upload a PDF and review
   the extracted text before continuing.
3. **Matchmaking** — you should see ranked candidate cards (ai-service's
   retrieve-then-rerank over pgvector), not an automatic invisible assignment. Pick one
   and assign manually.
4. **Lock the contract** — escrow gets created (via `FakeEscrowAdapter` unless you've
   swapped in a real Stripe key, section 8).
5. **Scope-guard chat** — open the chat panel, send a few in-scope messages, then some
   that should read as scope drift, then something clearly out of scope. Watch the
   blocked/delivered states and the drift-assessment table (CUSUM + martingale numbers).
   It will say its calibration is synthetic — that's expected and correct, not a bug;
   don't take `SCOPE_DRIFT_CALIBRATION_SYNTHETIC=0` as a task here (see section 9).
6. **Push code** — trigger `/simulate-push` (or a real GitHub webhook if
   `webhook-ingest` is wired up) with real code. Watch ci-worker run it — on this
   machine, with Docker available, it should select `DockerSandbox`, not the
   `NodePermissionSandbox` fallback the 8GB machine used. Confirm `audit_results`
   populates.
7. **Score** — the XAI trust score should compute, and the advisory narrative should
   generate via a **real** Cloudflare Workers AI call (this is the first time it's ever
   been exercised live — every test so far ran against a fake LLM client). Confirm the
   narrative text reads sensibly and changing nothing about the telemetry doesn't change
   the trust score (there's a dedicated isolation test, but this is the live-path check).
8. **Oracle → settlement** — the four-signal gate should pass or fail correctly;
   settlement-worker should claim and commit the settlement, write the trust score back
   to `freelancer_profiles`, increment `deliveries`, and seal a Merkle root.

Then run the scripted checks against that same contract:

```bash
node tools/test_e2e_project_flow.js
# should report all six tables genuinely non-zero:
# assigned / completed / audits / escrows / settlements / roots
# — not just an unconditional "PASSED"

npm run verify
# node scripts/verify-web.js && matchmaking_eval.py --sizes 100 --no-ablation --no-report && node tools/benchmark.js
```

---

## 7. Optional / lower priority

- **Real Stripe test key** — `.env`'s `STRIPE_SECRET_KEY=sk_test_mock` currently forces
  `createEscrowAdapter()` to return `FakeEscrowAdapter`. Replace it with a real
  `sk_test_...` key if you want to demo actual Stripe test-mode escrow instead of the
  fake. `StripeEscrowAdapter` (`packages/stripe-adapter/src/index.ts`) is already fully
  implemented — this is a config change, not a code change.
- **Two latent (currently unreachable) bugs**, found during the same refactor pass that
  found the Kafka bug — safe to leave, cheap to fix if you're already in that code:
  - `apps/ai-service/app/ports/graph_repo.py`, `InMemoryGraphRepo.update_trust_score` —
    rebuilds the profile field-by-field and omits `embedding`, which would silently
    zero it out if ever called on a vector-carrying profile. Fix:
    `dataclasses.replace(fp, trust_score=trust_score)` instead of manual reconstruction.
  - `apps/api-gateway/src/server.ts`, `POST /api/contracts/:contractId/match` —
    hardcodes `http://localhost:8000/match` instead of using the already-computed
    service URL used by the other AI-service routes in the same file.
- `npm run build` at the repo root only builds the 11 TS workspaces
  (`scripts/build-workspaces.mjs`) — it does **not** build the web app. Run
  `npm run build:web` separately if you need a production frontend build.

---

## 8. What NOT to do

- Don't rotate `JWT_SECRET`, `SERVICE_TOKEN`, or `ML_DSA_SEED_HEX` — keep them identical
  to the 8GB machine's `.env`.
- Don't commit `.env`, and don't paste its contents into chat, logs, or this file.
- `tools/seed-users.py` is a safe-to-rerun upsert, but it resets every seeded account's
  password back to the shared demo hash (`demo1234`) if run against the shared Supabase
  DB — fine for a demo reset, just be aware it's not additive-only.
- **Don't author C1's real calibration data yourself.** `SCOPE_DRIFT_CALIBRATION_SYNTHETIC=1`
  is intentional and honest — the real thing (`data/t2_authored/`) requires a
  human-written pilot set with two independent annotators (see
  `data/t2_authored/README.md`), specifically because LLM-authored calibration data
  would be circular evidence for a semantic drift detector. The tooling
  (`tools/eval/build_t2_calibration.py`) is finished; the data is the human's task, not
  Claude Code's, on either machine.
