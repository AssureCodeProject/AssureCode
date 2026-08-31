# api-gateway route split — design

## Context

`apps/api-gateway/src/server.ts` is 3,469 lines and holds every route the gateway
serves: auth, MFA, GitHub OAuth, the contract lifecycle, KYC, escrow/settlement,
XAI scoring, oracle/drift, PDF extraction, chat (incl. a websocket stream),
audits, webhooks, GitHub repo listing, and health/readiness/metrics. The
service boundary (api-gateway as its own deployable unit) is correct; the
internal organization is not — one file this size is hard to navigate, makes
unrelated changes collide in diffs, and obscures which routes share which
guards.

This came out of a broader architecture review this session that found the
overall service topology and cross-cutting patterns (transactional outbox,
port/adapter pattern, honest-degradation discipline, observability) sound.
Two other concerns surfaced in that review — whether `ai-service` and
`scope-guard` should be one service, and whether the Kafka/Neo4j backend
pluggability is earning its cost — are **explicitly out of scope here**. Both
are judgment calls with real tradeoffs the user hasn't decided on yet; this
spec is scoped to the one unambiguous fix: splitting the file with no
behavior change.

## Goal

Reorganize `server.ts` into a composition root plus per-domain route modules,
with identical runtime behavior. This is pure code movement — no new
functionality, no changed response shapes, no changed guard logic.

## Approach

**Plain registration functions + a shared `context.ts`, not Fastify plugins.**

Fastify's `server.register(plugin)` creates an encapsulation scope: a
decorator or hook registered inside one plugin does not automatically reach
another. For a security-sensitive gateway (RBAC guards, the global auth
`onRequest` hook, rate limiting) that risk is worth avoiding entirely rather
than managing. Instead:

- `src/context.ts` holds the shared singletons already constructed at
  module load time today — `dbPool`, `config`, `logger`, `eventBus`,
  `ledgerClient`, `kycAdapter`, `aiServiceUrl`, `serviceCallHeaders()` /
  `callAiService()`, and the route guards (`clientOnly`, `clientVerified`,
  `settlementGuards`, `freelancerOnly`) — as plain exports.
- Each domain file exports one function, `registerXRoutes(server: FastifyInstance)`,
  that imports what it needs from `context.ts` and calls `server.get/post/patch(...)`
  directly on the instance it's given. No `.register()`, no plugin scope, no
  decorator visibility question.
- `server.ts` shrinks to: build the Fastify instance, register CORS / JWT /
  rate-limit / idempotency / `@fastify/websocket`, wire the global auth
  `onRequest` hook, call each `registerXRoutes(server)` in sequence, start
  listening.

Websocket routes (`{ websocket: true }`) work unchanged under this scheme —
they're still registered on the same root instance, just from a different
file, after the websocket plugin is registered in `server.ts`.

## File breakdown

| File | Routes |
|---|---|
| `src/context.ts` | shared singletons + guards (see above) |
| `src/routes/auth.ts` | `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/mfa/*`, `/auth/github*`, session issuing |
| `src/routes/contracts-lifecycle.ts` | initialize, mine, match, assign, github-repo link, generate-tests, lock |
| `src/routes/contracts-escrow.ts` | escrow, escrow/verify, settle |
| `src/routes/contracts-audit.ts` | score, oracle, drift, root, root/sign, verify, simulate-push |
| `src/routes/contracts-chat.ts` | chat, chat/stream (websocket) |
| `src/routes/kyc.ts` | verify, status/:userId, connect-onboarding |
| `src/routes/pdf.ts` | pdf/extract |
| `src/routes/github.ts` | github/repos |
| `src/routes/webhooks.ts` | webhooks/razorpay, `recordPaymentEvent` helper |
| `src/routes/health.ts` | healthz, readyz, metrics |
| `src/server.ts` | composition root only |

Zod request/response schemas and small route-local helpers move with the
route file that uses them; nothing shared gets duplicated.

## Execution order (incremental, one session)

Extract in this order, running the relevant existing test file(s) after each
step before moving to the next:

1. `context.ts` (no route change yet — just relocates shared state; existing
   `gateway.test.ts` / `rbac.test.ts` should still pass unmodified against
   the still-monolithic `server.ts` importing from it)
2. `routes/health.ts` (lowest risk, no auth/guards)
3. `routes/auth.ts` → verify against `rbac.test.ts`, `mfa.test.ts`, `github-oauth.test.ts`, `session-revocation.test.ts`
4. `routes/kyc.ts` → verify against `kyc-ownership.test.ts`
5. `routes/webhooks.ts` → verify against `razorpay-webhook.test.ts`, `razorpay-payout-webhook.test.ts`
6. `routes/pdf.ts`, `routes/github.ts` (small, low risk)
7. `routes/contracts-lifecycle.ts` → verify against `github-repo.test.ts`, `idempotency*.test.ts`, `routes.test.ts`
8. `routes/contracts-escrow.ts`, `routes/contracts-audit.ts`, `routes/contracts-chat.ts` → verify against `routes.test.ts`, `ledger-tamper.test.ts`
9. Final pass: full suite (`npm -w @assurecode/api-gateway run test`), full
   typecheck, full lint, `node scripts/verify-web.js` (unaffected, but cheap
   to confirm nothing else broke)

## Risks / mitigations

- **Missed import / shared helper left behind in `server.ts`** — caught by
  typecheck immediately (a route file referencing something not exported
  from `context.ts` fails to compile), not a runtime surprise.
- **Guard applied to the wrong route during the move** — caught by
  `rbac.test.ts` and `kyc-ownership.test.ts`, which assert on 401/403
  behavior per route.
- **Route registration order accidentally matters somewhere** — Fastify's
  router does not depend on registration order for path matching (static
  routes take precedence over parametric ones regardless of order), so this
  is not expected to be a real risk, but the final full-suite run would
  surface it if wrong.

## Out of scope

- Any change to route logic, response shapes, or guard behavior.
- The `ai-service`/`scope-guard` merge question.
- Any change to Kafka/Neo4j/backend pluggability.
- `apps/ci-worker`, `apps/settlement-worker`, `apps/webhook-ingest` internal
  organization (not raised as a concern; each is already much smaller than
  `server.ts`).
