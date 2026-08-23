/**
 * The two calls this worker makes back into the gateway.
 *
 * Both exist for the same reason: the gateway owns a piece of the pipeline that
 * this worker needs to happen, and reimplementing either here would put a
 * second copy of it in the process that releases money, free to drift from the
 * one the UI exercises.
 *
 * ── triggerScoring ─────────────────────────────────────────────────────
 *
 * Why this exists at all. The settlement gate needs `trustScore >= 85`, and the
 * only producer of XAI_SCORED in the system is the gateway's
 * GET /api/contracts/:id/score route (apps/api-gateway/src/server.ts). Until
 * this module, the only *caller* of that route was a React effect
 * (apps/web/src/components/XaiTrustScoreView.jsx), so the trust-score half of
 * the gate was satisfiable only when a human opened the XAI tab in a browser.
 * An audit that nobody looked at could never settle.
 *
 * Why it calls the gateway rather than ai-service directly: /score resolves the
 * contract's freelancer, reads the latest audit_results row, shapes the
 * telemetry payload, and publishes the event. Reimplementing that here would
 * put a second copy of the scoring contract in the process that releases money,
 * free to drift from the one the UI exercises. This is the design recorded in
 * infra/docker-compose.yml next to GATEWAY_URL, written before the code existed.
 *
 * ── requestRootSignature ───────────────────────────────────────────────
 *
 * After a settlement seals a Merkle root, the root is signed with ML-DSA-87.
 * The signer is Python (packages/ledger-client/src/ml_dsa.py) and there is no
 * JavaScript ML-DSA in this repo, so signing goes through the gateway to
 * ai-service, which already ships dilithium-py. Before this, the signature
 * columns were written only by tools/sign_merkle_root.py, run by hand.
 *
 * ── shared ─────────────────────────────────────────────────────────────
 *
 * Why a separate module rather than functions inside worker.ts: worker.ts
 * builds a pg.Pool, a Redis event bus, a LedgerClient and a Razorpay adapter at
 * module scope, so importing it from a test opens real sockets. Everything here
 * takes its dependencies as arguments and has no import side effects.
 */
import { randomUUID } from 'node:crypto';
import { getCorrelationId } from '@assurecode/config';

/**
 * The result of one trigger attempt sequence.
 *
 * Deliberately a discriminated union rather than a boolean: the caller logs
 * these at different severities, and "the gateway refused for a reason that
 * will never change" is a different operational fact from "the gateway was
 * unreachable". Collapsing them is what makes a broken deployment look like a
 * transient blip.
 */
export type TriggerOutcome =
  | { kind: 'scored'; trustScore: number; criticalVulns: number }
  | { kind: 'declined'; status: number; detail: string }
  | { kind: 'misconfigured'; status: number; detail: string }
  | { kind: 'unavailable'; attempts: number; detail: string }
  | { kind: 'disabled' };

export interface TriggerDeps {
  gatewayUrl: string;
  serviceToken: string;
  /** Kill switch. See ENABLE_AUTO_SCORING in packages/config. */
  enabled: boolean;
  /**
   * Total wall-clock budget across all attempts.
   *
   * A budget rather than an attempt count because this bounds a real cost: the
   * Redis bus awaits each handler before reading the next message, so the retry
   * window is a hard stall on AUDIT_COMPLETED consumption for this worker. A
   * wall-clock number is one you can state; attempts x timeout + backoff is an
   * emergent product nobody computes correctly.
   */
  deadlineMs?: number;
  perAttemptMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Statuses where retrying cannot change the answer.
 *
 * 409 has two causes at the gateway, both terminal: no audit_results row (which
 * the ci-worker write-then-publish ordering should make unreachable), and no
 * assigned freelancer -- genuinely reachable, because /simulate-push does not
 * require an assignment, so a contract can be audited before POST /assign runs.
 */
const TERMINAL_STATUSES = new Set([400, 404, 409, 422]);

/** Token drift between this worker and the gateway. Retrying is pure noise. */
const AUTH_STATUSES = new Set([401, 403]);

const DEFAULT_DEADLINE_MS = 20_000;
const DEFAULT_PER_ATTEMPT_MS = 8_000;
const BACKOFFS_MS = [1_000, 3_000, 7_000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the gateway to score `contractId`, which makes it publish XAI_SCORED.
 *
 * Never throws. The caller runs inside a bus handler that has already durably
 * recorded the audit signals; throwing would send that message down the retry
 * path and then to the DLQ, making the DLQ metric claim audit *ingestion*
 * failed when only this optional follow-up did.
 */
export async function triggerScoring(
  contractId: string,
  deps: TriggerDeps,
): Promise<TriggerOutcome> {
  if (!deps.enabled) return { kind: 'disabled' };

  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const perAttemptMs = deps.perAttemptMs ?? DEFAULT_PER_ATTEMPT_MS;
  const deadline = Date.now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS);

  // encodeURIComponent, not raw interpolation: a contract id containing a slash
  // would otherwise address a different gateway route entirely.
  const url = `${deps.gatewayUrl}/api/contracts/${encodeURIComponent(contractId)}/score`;

  // The handler runs inside runWithCorrelationId, so this carries the audit's
  // correlation id into the gateway and back out onto the XAI_SCORED it
  // publishes -- which is what makes the whole chain one trace.
  const correlationId = getCorrelationId() ?? randomUUID();

  let attempts = 0;
  let lastDetail = 'no attempt completed';

  while (Date.now() < deadline) {
    attempts += 1;

    try {
      const res = await doFetch(url, {
        method: 'GET',
        headers: {
          'x-service-token': deps.serviceToken,
          'x-correlation-id': correlationId,
        },
        signal: AbortSignal.timeout(perAttemptMs),
      });

      if (res.ok) {
        const body = (await res.json()) as { trustScore: number; criticalVulns: number };
        return {
          kind: 'scored',
          trustScore: Number(body.trustScore),
          criticalVulns: Number(body.criticalVulns),
        };
      }

      const detail = (await res.text().catch(() => '')).slice(0, 500);

      if (AUTH_STATUSES.has(res.status)) {
        return { kind: 'misconfigured', status: res.status, detail };
      }
      if (TERMINAL_STATUSES.has(res.status)) {
        return { kind: 'declined', status: res.status, detail };
      }

      // 429 and 5xx fall through to the retry: the gateway may be mid-rollout,
      // the scorer may be restarting, or the telemetry read may have blipped.
      lastDetail = `HTTP ${res.status}: ${detail}`;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      lastDetail =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? `timed out after ${perAttemptMs}ms`
          : String(e?.message ?? err);
    }

    const wait = BACKOFFS_MS[Math.min(attempts - 1, BACKOFFS_MS.length - 1)];
    // Do not sleep past the deadline just to discover it has passed.
    if (Date.now() + wait >= deadline) break;
    await sleep(wait);
  }

  return { kind: 'unavailable', attempts, detail: lastDetail };
}

/** Outcome of asking the gateway to sign a contract's sealed Merkle root. */
export type SignOutcome =
  | { kind: 'signed'; algorithm: string | null; alreadySigned: boolean }
  | { kind: 'unsigned'; status: number; detail: string };

/**
 * Ask the gateway to sign the contract's current Merkle root.
 *
 * One attempt, no retry, and never throws. This runs after the settlement has
 * already committed — the money has moved and the ledger entry is written — so
 * the signature is a summary over settled facts, not a condition of them. A
 * failure here must leave a loud log and nothing else; the recovery is to
 * re-drive POST /root/sign, which is idempotent because the gateway short-
 * circuits when a signature is already present.
 *
 * Deliberately not sharing triggerScoring's retry budget: that budget exists to
 * bound a stall on topic consumption, and this call has no such deadline
 * pressure. Re-running it later costs nothing.
 */
export async function requestRootSignature(
  contractId: string,
  deps: Pick<TriggerDeps, 'gatewayUrl' | 'serviceToken' | 'perAttemptMs' | 'fetchImpl'>,
): Promise<SignOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${deps.gatewayUrl}/api/contracts/${encodeURIComponent(contractId)}/root/sign`;

  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'x-service-token': deps.serviceToken,
        'x-correlation-id': getCorrelationId() ?? randomUUID(),
      },
      // Pure-Python ML-DSA-87 signing is slow; the gateway allows 15s for the
      // signer itself, so this has to allow more than that or it would time out
      // on the client side of a call that was about to succeed.
      signal: AbortSignal.timeout(deps.perAttemptMs ?? 20_000),
    });

    if (res.ok) {
      const body = (await res.json()) as { algorithm?: string; alreadySigned?: boolean };
      return {
        kind: 'signed',
        algorithm: body.algorithm ?? null,
        alreadySigned: Boolean(body.alreadySigned),
      };
    }

    const detail = (await res.text().catch(() => '')).slice(0, 500);
    return { kind: 'unsigned', status: res.status, detail };
  } catch (err) {
    const e = err as { message?: string };
    return { kind: 'unsigned', status: 0, detail: String(e?.message ?? err) };
  }
}

interface TriggerLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * Log an outcome at the severity it deserves.
 *
 * Split out so the severities are visible in one place: an operator reading
 * these lines needs "this contract cannot settle until someone acts" to look
 * different from "this contract was never going to be scored".
 */
export function logTriggerOutcome(
  logger: TriggerLogger,
  contractId: string,
  outcome: TriggerOutcome,
): void {
  switch (outcome.kind) {
    case 'scored':
      logger.info(
        { contractId, trustScore: outcome.trustScore, criticalVulns: outcome.criticalVulns },
        'XAI scoring triggered; gateway published XAI_SCORED',
      );
      return;
    case 'declined':
      logger.warn(
        { contractId, status: outcome.status, detail: outcome.detail },
        'Gateway declined to score this contract; the reason will not change on retry',
      );
      return;
    case 'misconfigured':
      logger.error(
        { contractId, status: outcome.status, detail: outcome.detail },
        'settlement-worker cannot authenticate to the gateway (SERVICE_TOKEN mismatch). ' +
          'Automatic scoring is disabled until this is fixed.',
      );
      return;
    case 'unavailable':
      logger.error(
        { contractId, attempts: outcome.attempts, detail: outcome.detail },
        'Scoring was not triggered. This contract cannot settle until /score is called -- ' +
          'open the XAI tab for it, or re-drive the route directly.',
      );
      return;
    case 'disabled':
      return;
  }
}
