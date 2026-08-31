# Threat Model

Trust boundaries, attacker capabilities, and what is and is not mitigated.

**Scope.** This is an academic artifact. Several mitigations below are absent by
design because the corresponding component is deliberately a stub. Those are
marked **NOT MITIGATED** rather than omitted.

## What is being protected

1. **The integrity of the audit record.** If a party can alter what the ledger
   says happened, the entire premise — that a third party can re-derive the
   outcome — fails.
2. **The settlement decision.** Money must be released only when the gate
   approves, exactly once.
3. **The host running untrusted code.** `ci-worker` executes freelancer-supplied
   code by design.
4. **Contract confidentiality between tenants.**

## Actors and capabilities

| Actor | Capabilities | Motivation |
|---|---|---|
| **Malicious freelancer** | Submits arbitrary code; sends arbitrary chat messages; holds a valid freelancer JWT | Get paid for work that does not meet the contract; escape the sandbox |
| **Malicious client** | Creates contracts; holds a valid client JWT; controls the contract text | Avoid paying for work that does meet the contract; retroactively narrow scope |
| **Network attacker** | Observes and replays traffic; no credentials | Replay a settlement; forge a webhook |
| **Compromised service** | Full control of one service's process | Lateral movement; forge events |
| **Curious insider** | Read access to the database or repository | Extract credentials or other tenants' contracts |

Explicitly **out of scope**: a compromised Postgres primary, a malicious
Kubernetes control plane, and physical access. The ledger is tamper-*evident*,
not tamper-*proof* — an attacker with write access to the database can rewrite
history, and the design goal is that doing so is detectable, not impossible.

## Trust boundaries

```
  Internet
     │
     ├── browser ──────────────▶ [B1] api-gateway      JWT/RBAC, rate limit, CORS
     │
     └── GitHub ───────────────▶ [B2] webhook-ingest   HMAC over raw bytes
                                       │
                                  [B3] event bus       in-cluster only
                                       │
                                  [B4] ci-worker ──▶ [B5] sandbox   untrusted code
                                       │
                                  [B6] Postgres / Redis / S3
```

**B1 — Public API.** Every route requires a JWT except an explicit allow-list
(`/healthz`, `/readyz`, `/metrics`, `/auth/login`, `/webhooks/*`). Machine
callers use `x-service-token`. WebSocket `?token=` is accepted only on `/stream`
paths, so a token cannot be smuggled into an arbitrary route via query string.

**B2 — Webhook ingress.** GitHub and Razorpay signatures are verified with
`crypto.timingSafeEqual` over the **raw request bytes**. The gateway installs a
content-type parser that stashes `rawBody` alongside the parsed object — an
earlier version re-serialised the parsed body, whose HMAC can never match, so
every genuine webhook was rejected with 401.

**B3 — Event bus.** No authentication. Any workload that can reach Redis can
publish any event, including a forged `audit.completed`. Mitigated only by
network policy (`infra/k8s/14-network-policies.yaml`); **under docker-compose
there is no boundary at all.**

**B5 — Sandbox.** The strongest boundary in the system and the weakest
implementation. See below.

## Threats and mitigations

### T1 — Freelancer submits malicious code to escape the sandbox

**Mitigated, partially.** `ci-worker` runs code through a `SANDBOX_RUNNER` port.
`DockerSandbox` gives container isolation but requires mounting the host Docker
socket — root-equivalent access on the node, handed to the one service whose job
is running untrusted code. The Kubernetes manifests therefore pin `node`, which
uses the Node permission model: **weaker isolation, and a documented trade**
(`infra/k8s/07-ci-worker.yaml`). An egress guard blocks network access from
audited code.

*Residual risk:* a Node permission-model escape compromises the ci-worker pod.
That pod runs non-root, drops all capabilities, has `seccompProfile:
RuntimeDefault`, no automounted service-account token, and is constrained by
NetworkPolicy — so the blast radius is the pod, not the node.

### T2 — Forged or replayed settlement

**Mitigated.** Settlement is guarded by an atomic conditional-upsert claim on
the `settlements` table's primary key (`INSERT ... ON CONFLICT (contract_id)
DO UPDATE ... WHERE settlements.status = 'FAILED'`) — single-fire without an
advisory lock; the `pg_advisory_lock` calls elsewhere in the codebase
serialize *ledger appends*, a different subsystem. Mutating routes are
idempotent via a bounded, TTL'd in-process cache (FIFO eviction by insertion
order, not LRU) in front of an `idempotency_keys` table — the table is what
makes it correct across replicas and restarts. Razorpay webhook redelivery is
deduplicated by a unique index on `provider_event_id`, inserted-then-checked
so two concurrent redeliveries cannot both pass a read-first check.

*Residual risk:* idempotency under concurrency is asserted by
`idempotency-concurrency.test.ts`, which requires live Postgres and therefore
skips on a bare clone.

### T3 — Tampering with the audit record

**Mitigated (evidence, not prevention).** Payloads are canonicalised with
RFC 8785 before hashing, so the hash is reproducible by anyone; the chain is
RFC 6962 with domain separation between leaf and interior nodes; roots are
signed with FIPS 204 ML-DSA-87. Any modification breaks verification.

*Residual risk:* 17 legacy rows predate canonicalization and report
`unverifiable`. The signing key is a local seed (`ML_DSA_SEED_HEX`) in
development — a signature under a key nobody else holds proves nothing to a
third party. Production posture requires an HSM/KMS with only the public key
distributed.

### T4 — Client retroactively narrows scope to avoid paying

**Mitigated.** This is the specific attack `H0` anchoring exists for. Scope
decisions bind to the genesis hash of the contract *as locked*, so editing the
contract afterwards does not change what past decisions were judged against, and
the binding is independently replayable. If `H0` cannot be resolved the guard
refuses rather than degrading into a free-floating similarity check.

### T5 — Prompt injection via contract text or code

**Partially mitigated**, in four layers (`apps/ai-service/app/services/prompt_guard.py`):

1. **The static layer is not injectable.** `owasp_static` is deterministic
   regex/AST matching, and LLM findings are *added* to static findings rather
   than replacing them, so no amount of persuasion can erase a static finding.
   This is the structural floor everything else rests on.
2. **Output is schema-checked.** `_normalize_llm_findings` drops findings with
   an unknown category, an unknown severity, or a line outside the file.
3. **Input is nonce-delimited.** Untrusted text is fenced with a random
   per-request sentinel rather than a markdown ``` fence, and backtick runs are
   defanged. Code containing ``` used to close the fence, making everything
   after it read as prompt — the cheapest possible injection against a code
   reviewer.
4. **Attempts are reported as evidence.** A detected attempt becomes an
   A05:2025 HIGH finding against the line it appears on, so attempting the
   attack is strictly worse for the attacker than not attempting it.

**Residual risk, and it is real.** The attack that remains is *suppression*: an
empty finding array is well-formed, in-schema, and indistinguishable from "this
code is clean", so output validation cannot catch it. Detection (layer 3) is
pattern-based and therefore incomplete — it raises the cost, it does not
eliminate the vector. A vulnerability that only the LLM layer would have caught
can still be hidden. Do not describe this as solved.

The XAI trust score is *not* exposed: it is computed deterministically from CI
telemetry, and the LLM only writes a narrative explanation of an already-final
number.

### T6 — Credential exposure

**Mitigated.** Passwords are argon2id (`@node-rs/argon2`). Login returns a
uniform error to prevent email enumeration. Postgres TLS pins
`infra/certs/supabase-ca-bundle.crt` with `rejectUnauthorized: true`. The
production secret guard rejects `dev_insecure_*`, `REPLACE_ME`, `changeme` and
blank values at boot, and the gateway exits non-zero if the Razorpay adapter
resolved to the fake. `.env` is gitignored; k8s secrets are placeholders with
three real backends available (External Secrets, Sealed Secrets, local override).

*Historical:* an earlier revision of `01-configmap-secrets.yaml` carried a
live-looking JWT secret and database credentials in plaintext. Treat anything
derived from them as burned.

### T7 — Brute-force / resource exhaustion

**Mitigated.** Global rate limit of 300/min keyed on the authenticated subject
(falling back to source IP, so one NAT egress is not one bucket); `/auth/login`
is separately limited to 10/min per IP because it is unauthenticated and
performs deliberately expensive argon2id verification. Health, readiness and
metrics endpoints are exempt so probes and scrapes are never throttled.

*Residual risk:* the limiter is in-process, so the effective limit scales with
replica count. A shared Redis store is the fix.

### T8 — Lateral movement from a compromised service

**Partially mitigated.** 15 NetworkPolicies restrict pod-to-pod traffic; every
workload runs non-root with a dedicated ServiceAccount and
`automountServiceAccountToken: false`.

The Python services now require `x-service-token` on every route except their
probe allow-list (`apps/ai-service/app/ports/service_auth.py`, shared by both
via the `__path__` extension in `apps/scope-guard/app/__init__.py`). The
dependency is declared on the FastAPI constructor, so a route added later is
protected by default rather than failing open when someone forgets to decorate
it. Comparison is `secrets.compare_digest`. In production a missing or
placeholder `SERVICE_TOKEN` raises at import, so the process fails before it
binds a port instead of serving unauthenticated traffic.

*Residual risk:* a single shared secret across all machine callers — the
gateway, ci-worker and the verification harnesses all present the same token, so
it cannot distinguish them and rotating it is all-or-nothing. Outside
production, an unset token disables the check entirely so the offline stack
works without ceremony; that is deliberate, and it means a *staging* deployment
that forgets `NODE_ENV=production` is unauthenticated.

### T9 — Malicious KYC / sanctions evasion

**NOT MITIGATED.** `createKycAdapter()` always returns `FakeKycAdapter`, which
approves everything immediately. The route writes `id_status = 'APPROVED'` and
`aml_sanctions_checked = true` without consulting any provider, and
`document_hash` is a random UUID slice rather than a hash of a document. The
`requireKycVerified` gate correctly reads status from the database rather than
the JWT claim — the plumbing is right, the verification is a stub.

### T10 — Session hijacking / inability to revoke

**Mitigated.** `apps/api-gateway/src/middleware/session-store.ts` backs a real
session lifecycle against `user_sessions` — `createSession` / `isSessionActive`
/ `revokeSession` — checked on every authenticated request via the auth
middleware's `onRequest` hook, not just at login. `POST /auth/logout` calls
`revokeSession` for real rather than being a client-side no-op, so a revoked
token is rejected on its very next use, before expiry. TOTP MFA is likewise
real, not schema-only: `apps/api-gateway/src/middleware/mfa-store.ts`
implements the full enroll → verify → challenge lifecycle against
`mfa_credentials` and gates login on it. A dedicated regression suite,
`apps/api-gateway/test/session-revocation.test.ts`, proves both halves: logout
revokes, and an expired/revoked session is rejected.

*Residual risk:* this closes the "cannot be revoked" gap, not session security
generally — a still-active token remains a bearer credential for its lifetime,
same as any JWT. `auth_providers` (OAuth/SSO) has real callers via GitHub OAuth
login, not independently re-verified here as thoroughly as the session/MFA
path.

### T11 — Scope-guard bypass via adversarial chat input

**Partially mitigated.** `apps/scope-guard/app/main.py` retrieves the top-k
indexed contract chunks and scores an incoming chat message by plain cosine
similarity over Sentence-BERT embeddings — there is no hyperbolic-geometry or
Poincaré-ball scoring anywhere in the codebase, despite an earlier (now
removed) doc revision claiming otherwise. Off-scope messages below the
similarity threshold are rejected with `403`.

*Residual risk:* the threshold's held-out accuracy is a known weakness, not a
strong guarantee — see `docs/plan2.md`'s "known functional gaps" (scope-guard
recall ~60% over 50 live contracts, calibration synthetic by default). An
adversarial paraphrase close enough in embedding space to an in-scope chunk can
still pass.

**Historical hardening, for context.** Three resource-exhaustion bugs from an
earlier audit are fixed and worth naming since they touch this trust boundary
indirectly: a double pool-connection acquisition in `verifyChain()` (now
wrapped in `finally`), a WebSocket chat listener leak (unsubscribe callbacks
now run on `socket.on('close')`), and an unbounded idempotency `Map` (now a
bounded, 10,000-entry, TTL'd cache with FIFO eviction).

## Summary

| Threat | Status |
|---|---|
| T1 Sandbox escape | Partial — Node permission model, documented trade |
| T2 Replayed settlement | Mitigated |
| T3 Ledger tampering | Mitigated (evidence) — 17 legacy rows not independently verifiable |
| T4 Retroactive scope narrowing | Mitigated via `H0` anchoring |
| T5 Prompt injection | Partial — static floor + nonce fencing; **suppression remains** |
| T6 Credential exposure | Mitigated |
| T7 Brute force | Mitigated — per-process limiter |
| T8 Lateral movement | Mitigated — `x-service-token` on both Python services |
| **T9 KYC evasion** | **NOT MITIGATED — stub by design** |
| T10 Session revocation | Mitigated |
| T11 Scope-guard embedding bypass | Partial — cosine threshold, ~60% recall |

Ordered by what a reviewer should ask about first: **T9** (KYC approves
everyone — the one remaining NOT MITIGATED entry), then T5's residual
suppression vector, T1's sandbox choice, and T11's recall.

On T3: the 17 legacy rows can be *sealed* but not retroactively verified — see
`packages/ledger-client/src/legacy-anchor.ts` and `npm run ledger:legacy`.
Sealing appends a normal, verifiable entry committing to their hashes, which
makes any later alteration detectable without rewriting history. Recomputing
their hashes under the current formula would make them all "verify" and would
destroy the property the ledger exists for, because recomputation is exactly
what rewriting history looks like.
