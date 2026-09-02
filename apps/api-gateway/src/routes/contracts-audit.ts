/**
 * Ledger chain reads, Merkle root + post-quantum signing, scope drift,
 * XAI trust scoring, the settlement oracle's state, and simulate-push.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { TRUST_SCORE_THRESHOLD } from '@assurecode/oracle';
import { EVENT_TOPICS } from '@assurecode/shared';
import {
  logger,
  dbPool,
  eventBus,
  ledgerClient,
  oracleStore,
  aiServiceUrl,
  scopeGuardUrl,
  serviceCallHeaders,
  latestAuditPayload,
  contractPartyOnly,
} from '../context.js';

export function registerContractsAuditRoutes(server: FastifyInstance): void {
  server.get<{
    Params: { contractId: string };
    Reply: {
      contractId: string;
      chain: Array<{
        ledgerId: number;
        actionType: string;
        previousHash: string;
        currentHash: string;
        createdAt: string;
      }>;
    };
  }>('/api/contracts/:contractId', contractPartyOnly, async (request, reply) => {
    const { contractId } = request.params;

    const chain = await ledgerClient.getChain(contractId);

    return reply.status(200).send({
      contractId,
      chain: chain.map((row) => ({
        ledgerId: row.ledgerId,
        actionType: row.actionType,
        previousHash: row.previousHash,
        currentHash: row.currentHash,
        createdAt: row.createdAt,
      })),
    });
  });

  server.get<{
    Params: { contractId: string };
    Reply: { contractId: string; valid: boolean } | { error: string };
  }>('/api/contracts/:contractId/verify', contractPartyOnly, async (request, reply) => {
    const { contractId } = request.params;
    const chain = await ledgerClient.getChain(contractId);
    if (chain.length === 0) {
      return reply.status(404).send({ error: 'Contract not found' });
    }

    const valid = await ledgerClient.verifyChain(contractId);
    if (!valid) {
      return reply.status(409).send({ contractId, valid: false });
    }

    return reply.status(200).send({ contractId, valid: true });
  });

  // ── Merkle root: read and post-quantum signing ──────────────────────────
  //
  // Until these routes existed, merkle_roots.signature was written only by
  // tools/sign_merkle_root.py, run by hand. No service signed anything, so in
  // normal operation every root the system produced had a NULL signature while
  // the UI footer asserted "NIST ML-DSA POST-QUANTUM SIGNED" for all of them.
  // GET /root is what lets the UI make that claim only when it is true.

  server.get<{
    Params: { contractId: string };
    Reply:
      | {
          contractId: string;
          rootHash: string;
          leafCount: number;
          maxLedgerId: number | null;
          chainValid: boolean | null;
          signature: {
            signed: boolean;
            algorithm: string | null;
            signedAt: string | null;
            publicKeyFingerprint: string | null;
          };
        }
      | { error: string; reason: 'no-root' | 'no-contract' | 'unavailable' };
  }>('/api/contracts/:contractId/root', contractPartyOnly, async (request, reply) => {
    const { contractId } = request.params;

    let chain: Awaited<ReturnType<typeof ledgerClient.getChain>>;
    let root: Awaited<ReturnType<typeof ledgerClient.getRoot>>;
    try {
      chain = await ledgerClient.getChain(contractId);
      root = chain.length === 0 ? null : await ledgerClient.getRoot(contractId);
    } catch (err) {
      // A failed read means we could not establish whether a root exists. Every
      // other answer this route can give — 404, or a signature verdict — is a
      // claim about the ledger, and we have not learned one. Reporting absence
      // from a failed lookup is the specific mistake this catch exists to
      // prevent, and it is the one the UI would render as "ROOT UNSIGNED".
      request.log.error({ err, contractId }, 'Merkle root lookup failed');
      return reply.status(503).send({ error: 'Ledger lookup unavailable', reason: 'unavailable' });
    }

    if (chain.length === 0) {
      return reply
        .status(404)
        .send({ error: `Contract ${contractId} not found`, reason: 'no-contract' });
    }

    if (!root) {
      // Distinct from "unsigned": a contract that has never settled has no root
      // to sign at all, and the UI must be able to tell those apart rather than
      // rendering both as a missing signature.
      return reply.status(404).send({
        error: `No Merkle root sealed for ${contractId} yet. Roots are computed on settlement.`,
        reason: 'no-root',
      });
    }

    const signed = root.signature !== null && root.signature.length > 0;

    return reply.status(200).send({
      contractId,
      rootHash: root.rootHash,
      leafCount: root.leafCount,
      maxLedgerId: root.maxLedgerId,
      chainValid: await ledgerClient.verifyChain(contractId),
      signature: {
        // Derived from the column, never from the fact that a row exists. It must
        // not be possible for this to answer true without signature bytes.
        signed,
        algorithm: signed ? root.signatureAlg : null,
        signedAt: signed ? root.signedAt : null,
        publicKeyFingerprint:
          signed && root.publicKey
            ? createHash('sha256').update(root.publicKey).digest('hex').slice(0, 32)
            : null,
      },
    });
  });

  server.post<{
    Params: { contractId: string };
    Reply:
      | { contractId: string; signed: true; alreadySigned: boolean; algorithm: string | null; signedAt: string | null }
      | { error: string };
  }>('/api/contracts/:contractId/root/sign', async (request, reply) => {
    // Service callers only. A signature is an assertion by the platform about its
    // own ledger; there is no user whose session should be able to mint one.
    if (!(request as unknown as { isServiceCaller?: boolean }).isServiceCaller) {
      return reply.status(403).send({ error: 'Service callers only' });
    }

    const { contractId } = request.params;

    const root = await ledgerClient.getRoot(contractId);
    if (!root) {
      return reply.status(409).send({
        error:
          `No Merkle root recorded for ${contractId}. Compute one first. ` +
          `Refusing to sign a root that does not exist.`,
      });
    }

    if (root.signature && root.signature.length > 0) {
      // computeAndStoreRoot clears the signature whenever the tree changes, so a
      // signature that is still present necessarily covers the current root.
      // Re-signing would be deterministic anyway; skipping the round trip keeps
      // the retry path from paying for a pure-Python ML-DSA signature each time.
      return reply.status(200).send({
        contractId,
        signed: true,
        alreadySigned: true,
        algorithm: root.signatureAlg,
        signedAt: root.signedAt,
      });
    }

    let signed: { algorithm: string; signature_b64: string; public_key_b64: string };
    try {
      const res = await fetch(`${aiServiceUrl}/ledger/sign-root`, {
        method: 'POST',
        headers: serviceCallHeaders(),
        body: JSON.stringify({
          contract_id: contractId,
          root_hash: root.rootHash,
          leaf_count: root.leafCount,
        }),
        // Generous: dilithium-py is pure Python by design (it installs without a
        // toolchain), and ML-DSA-87 signing there is not fast.
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // 503 is propagated verbatim. "No signing key configured" is a distinct
        // operational answer from "the signer failed", and collapsing them is
        // what lets a permanently unsigned ledger read as a transient blip.
        return reply
          .status(res.status === 503 ? 503 : 502)
          .send({ error: `Root signing unavailable: signer returned ${res.status}. ${detail}` });
      }

      signed = (await res.json()) as typeof signed;
    } catch (err) {
      request.log.error({ contractId, err }, 'ML-DSA signer unreachable');
      return reply.status(502).send({ error: 'Root signing unavailable: signer unreachable' });
    }

    const stored = await ledgerClient.storeRootSignature({
      contractId,
      rootHash: root.rootHash,
      leafCount: root.leafCount,
      signature: Buffer.from(signed.signature_b64, 'base64'),
      publicKey: Buffer.from(signed.public_key_b64, 'base64'),
      algorithm: signed.algorithm,
    });

    if (!stored) {
      // The tree moved between the read and the write. Same refusal as
      // tools/sign_merkle_root.py: never write a signature that covers a root the
      // ledger no longer holds.
      return reply.status(409).send({
        error: 'The root changed while it was being signed; nothing was written. Recompute and retry.',
      });
    }

    const after = await ledgerClient.getRoot(contractId);
    return reply.status(200).send({
      contractId,
      signed: true,
      alreadySigned: false,
      algorithm: signed.algorithm,
      signedAt: after?.signedAt ?? null,
    });
  });

  // A demo stand-in only, used when the caller supplies no code of their own —
  // there is no real freelancer code-submission flow yet, so this route has no
  // other source of "what got pushed". Labeled honestly rather than passed off
  // as a real submission: ci-worker's processCodePush refuses to run with no
  // code at all (`No code supplied`, enforced by its own tests), so silently
  // sending nothing — which this route did before — meant the audit pipeline
  // could never produce a result through this path, ever, even fully wired up.
  const SIMULATED_PUSH_DEMO_CODE = `// Demo push — no real freelancer submission flow exists yet.
function add(a, b) {
  return a + b;
}

module.exports = { add };
`;

  server.post<{
    Params: { contractId: string };
    Body: { code?: string };
    Reply: { message: string; eventId: string } | { error: string };
  }>('/api/contracts/:contractId/simulate-push', contractPartyOnly, async (request, reply) => {
    const { contractId } = request.params;
    const callerCode = request.body?.code?.trim();
    const code = callerCode || SIMULATED_PUSH_DEMO_CODE;

    const eventId = randomUUID();

    const chain = await ledgerClient.getChain(contractId);
    if (chain.length === 0) {
      return reply.status(404).send({ error: 'Contract not found' });
    }

    // Simulate Push and a real GitHub webhook push publish the identical
    // CODE_PUSH_RECEIVED event and land on the identical oracle_state row —
    // there is only ever one "latest" audit per contract, not a history the
    // gate reads from. Without this guard, clicking Simulate Push after a
    // real push silently discards the real result (and vice versa) with no
    // warning, which is exactly the confusing "my real code isn't reflected"
    // symptom this guard exists to prevent. `(payload->>'demo')::boolean IS
    // NOT TRUE` treats a pre-existing row with no `demo` key at all (written
    // before this field existed) as real too — the safe assumption, not the
    // permissive one.
    const realAuditRes = await dbPool.query(
      `SELECT 1 FROM audit_results WHERE contract_id = $1 AND (payload->>'demo')::boolean IS NOT TRUE LIMIT 1`,
      [contractId],
    );
    if ((realAuditRes.rowCount ?? 0) > 0) {
      return reply.status(409).send({
        error:
          'This contract has already received a real GitHub push. Simulate Push is disabled for it to avoid ' +
          'silently overwriting the real audit result — push a new commit to the repository to re-run verification.',
      });
    }

    // `demo` travels with the event so ci-worker knows to pair the snippet above
    // with its matching suite rather than with the contract's generated tests —
    // which describe the contract's product and would fail against a two-line
    // adder for reasons that say nothing about the code or the pipeline. The
    // flag is what keeps a demo run labelled as one all the way through.
    await eventBus.publish(
      EVENT_TOPICS.CODE_PUSH_RECEIVED,
      { contractId, repository: 'test-repo', commitSha: 'abc123', eventId, code, demo: !callerCode },
      eventId,
    );

    logger.info({ contractId, eventId, codeSource: callerCode ? 'caller-supplied' : 'demo-fallback' }, 'Simulated GitHub push event');

    return reply.status(200).send({
      message: 'GitHub push event simulated',
      eventId,
    });
  });

  // ── XAI Trust Score Endpoint (Task 4.4) ──────────────────────────────────

  server.get<{
    Params: { contractId: string };
    Reply:
      | {
          contractId: string;
          freelancerId: string;
          trustScore: number;
          criticalVulns: number;
          scopeMeasured: boolean;
          threshold: number;
          // The per-term arithmetic that produced the score. This is the whole
          // interpretability claim, so it is forwarded rather than reduced to a
          // single number the caller has to take on trust.
          terms: Array<{
            name: string;
            value: number;
            weight: number;
            contribution: number;
            justification: string;
          }>;
          // Advisory explanation of trustScore, generated after it's final.
          // Absent when the LLM is unavailable — the score is unaffected either way.
          narrative: string | null;
          telemetry: {
            maintainability: number;
            cyclomaticComplexity: number;
            passedTests: number;
            totalTests: number;
            vulnerabilities: number;
            criticalVulns: number;
            highVulns: number;
          };
          // Specific, actionable findings behind the aggregate telemetry above
          // -- which hidden tests failed and why, which functions are too
          // complex, which security findings were flagged and where. A
          // freelancer needs this to know what to actually change; the
          // aggregate numbers alone don't say.
          details: {
            testFailures: { name: string; message: string }[];
            complexFunctions: { name: string; line: number; cyclomaticComplexity: number }[];
            vulnerabilityDetails: {
              type: string;
              category: string;
              severity: string;
              message: string;
              line?: number;
            }[];
          };
          justifications: string[];
          scoredAt: string;
        }
      | { error: string };
  }>('/api/contracts/:contractId/score', contractPartyOnly, async (request, reply) => {
    const { contractId } = request.params;
    const chain = await ledgerClient.getChain(contractId);

    if (chain.length === 0) {
      return reply.status(404).send({ error: 'Contract not found' });
    }

    // ── Real telemetry, or no score at all ────────────────────────────────
    //
    // This endpoint used to post a hardcoded telemetry literal to the AI service
    // and fall back to the constant 0.92 whenever that call failed for any
    // reason — including when it succeeded but returned non-2xx. Every contract
    // in the system therefore scored 0.92, and that number reached the
    // specification as a measured result. Objective 4 says the score comes from
    // telemetry, so the absence of telemetry has to be an error, not a default.
    let audit: {
      maintainability: number;
      cyclomaticComplexity: number;
      passedTests: number;
      totalTests: number;
      vulnerabilities: number;
      criticalVulns: number;
      highVulns: number;
    };
    let freelancerId: string;
    // Specific findings behind the aggregate numbers above -- which hidden
    // tests failed and why, which functions are too complex, which security
    // findings were flagged and where. Same audit_results row already read
    // for `audit`, just not reduced to counts. See audit-store.ts's
    // AuditPayload for where these are produced.
    let details: {
      testFailures: { name: string; message: string }[];
      complexFunctions: { name: string; line: number; cyclomaticComplexity: number }[];
      vulnerabilityDetails: {
        type: string;
        category: string;
        severity: string;
        message: string;
        line?: number;
      }[];
    };

    try {
      const auditPayload = await latestAuditPayload(contractId);

      if (auditPayload === null) {
        return reply.status(409).send({
          error:
            `No audit results recorded for ${contractId}. The trust score is computed from CI ` +
            `telemetry; run the pipeline before requesting a score.`,
        });
      }

      audit = {
        maintainability: Number(auditPayload.maintainability),
        cyclomaticComplexity: Number(auditPayload.cyclomaticComplexity),
        passedTests: Number(auditPayload.passedTests),
        totalTests: Number(auditPayload.totalTests),
        vulnerabilities: Number(auditPayload.vulnerabilities),
        criticalVulns: Number(auditPayload.criticalVulns ?? 0),
        highVulns: Number(auditPayload.highVulns ?? 0),
      };

      details = {
        testFailures: (auditPayload.testFailures as typeof details.testFailures) ?? [],
        complexFunctions: (auditPayload.complexFunctions as typeof details.complexFunctions) ?? [],
        vulnerabilityDetails:
          (auditPayload.vulnerabilityDetails as typeof details.vulnerabilityDetails) ?? [],
      };

      const contractRes = await dbPool.query(
        `SELECT freelancer_id FROM contracts WHERE contract_id = $1`,
        [contractId],
      );
      freelancerId = contractRes.rows[0]?.freelancer_id ?? '';
    } catch (err) {
      request.log.error({ err, contractId }, 'Failed to read audit telemetry');
      return reply.status(503).send({ error: 'Audit telemetry unavailable' });
    }

    if (!freelancerId) {
      return reply.status(409).send({
        error: `Contract ${contractId} has no assigned freelancer, so there is nobody to score.`,
      });
    }

    let scored: {
      trust_score: number;
      justifications: string[];
      critical_vulnerabilities: number;
      scope_measured: boolean;
      terms: Array<{
        name: string;
        value: number;
        weight: number;
        contribution: number;
        justification: string;
      }>;
      // Advisory only — see apps/ai-service/app/routes/xai.py _generate_narrative.
      // Passed through as-is; nothing here reads it. The oracle gate downstream
      // (packages/oracle) evaluates trust_score alone.
      narrative: string | null;
    };

    try {
      const aiRes = await fetch(`${aiServiceUrl}/xai/score`, {
        method: 'POST',
        headers: serviceCallHeaders(),
        body: JSON.stringify({
          contract_id: contractId,
          freelancer_id: freelancerId,
          telemetry: {
            maintainability: audit.maintainability,
            cyclomatic_complexity: Math.max(1, audit.cyclomaticComplexity),
            passed_tests: audit.passedTests,
            total_tests: audit.totalTests,
            total_vulnerabilities: audit.vulnerabilities,
            critical_vulnerabilities: audit.criticalVulns,
            high_vulnerabilities: audit.highVulns,
          },
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!aiRes.ok) {
        // Propagate the scorer's own refusal rather than overriding it. A 409
        // from the scorer means it declined to score, and answering that with a
        // number would defeat the point of it having declined.
        const detail = await aiRes.text().catch(() => '');
        request.log.warn({ contractId, status: aiRes.status, detail }, 'XAI scorer declined');
        return reply
          .status(aiRes.status === 409 || aiRes.status === 422 ? aiRes.status : 502)
          .send({ error: `Trust score unavailable: scorer returned ${aiRes.status}. ${detail}` });
      }

      scored = (await aiRes.json()) as typeof scored;
    } catch (err) {
      request.log.error({ contractId, err }, 'XAI scorer unreachable');
      return reply.status(502).send({ error: 'Trust score unavailable: scorer unreachable' });
    }

    const scoredAt = new Date().toISOString();
    const correlationId = randomUUID();

    // narrative is deliberately not part of this payload — it never enters the
    // event bus, never reaches oracle.recordScore, and cannot affect the
    // settlement gate. It is added to the HTTP reply only, below.
    const scorePayload = {
      contractId,
      freelancerId,
      trustScore: scored.trust_score,
      criticalVulns: scored.critical_vulnerabilities,
      justifications: scored.justifications,
      scoredAt,
    };

    await eventBus.publish(EVENT_TOPICS.XAI_SCORED, scorePayload, correlationId);

    return reply.status(200).send({
      ...scorePayload,
      scopeMeasured: scored.scope_measured,
      threshold: TRUST_SCORE_THRESHOLD,
      terms: scored.terms,
      narrative: scored.narrative,
      telemetry: {
        maintainability: audit.maintainability,
        cyclomaticComplexity: audit.cyclomaticComplexity,
        passedTests: audit.passedTests,
        totalTests: audit.totalTests,
        vulnerabilities: audit.vulnerabilities,
        criticalVulns: audit.criticalVulns,
        highVulns: audit.highVulns,
      },
      details,
    });
  });

  // ── Scope Drift (C1) ────────────────────────────────────────────────────
  //
  // Assess cumulative drift over the contract's recorded scope decisions, then
  // anchor the assessment in the Merkle ledger.
  //
  // The anchoring is the point, and it is why this route exists in the gateway
  // rather than inside the scope guard. A scope flag that freezes a payment has
  // to be re-derivable in a dispute: the ledger entry binds the decision to the
  // contract's genesis hash and to the statistics that produced it, so a later
  // reader can recompute rather than take it on trust. It also keeps the RFC 8785
  // canonical serializer a single implementation — a Python copy in the scope
  // guard could disagree, and a hash chain with two serializers is exactly the
  // defect V009 removed.
  server.post<{
    Params: { contractId: string };
    Reply: { assessment: Record<string, unknown>; ledgerId: number; currentHash: string } | { error: string };
  }>('/api/contracts/:contractId/drift', contractPartyOnly, async (request, reply) => {
    const { contractId } = request.params;

    let assessment: Record<string, unknown>;
    try {
      const res = await fetch(
        `${scopeGuardUrl}/scope/drift/${encodeURIComponent(contractId)}`,
        { headers: serviceCallHeaders(), signal: AbortSignal.timeout(10_000) },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // 409 (nothing recorded yet) and 503 (no calibration set) are both
        // propagated rather than flattened: "there is no sequence to assess" and
        // "there is no calibrated guarantee available" are different answers and
        // the caller must be able to tell them apart.
        return reply
          .status(res.status === 409 || res.status === 503 ? res.status : 502)
          .send({ error: `Drift assessment unavailable: scope guard returned ${res.status}. ${detail}` });
      }

      assessment = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      request.log.error({ err, contractId }, 'Scope guard unreachable for drift assessment');
      return reply.status(502).send({ error: 'Drift assessment unavailable: scope guard unreachable' });
    }

    const ledgerPayload = assessment.ledger_payload as Record<string, unknown> | undefined;
    if (!ledgerPayload) {
      return reply.status(502).send({ error: 'Scope guard returned no ledger payload to anchor' });
    }

    try {
      const row = await ledgerClient.append(contractId, 'SCOPE_DRIFT_ASSESSED', ledgerPayload);
      return reply.status(200).send({
        assessment,
        ledgerId: row.ledgerId,
        currentHash: row.currentHash,
      });
    } catch (err) {
      // The assessment is not returned if it could not be anchored. An
      // unanchored drift flag is an assertion, and the whole claim of this
      // endpoint is that it is evidence.
      request.log.error({ err, contractId }, 'Failed to anchor drift assessment');
      return reply.status(503).send({
        error: 'Drift assessment computed but could not be anchored to the ledger; not returning an unanchored flag.',
      });
    }
  });

  // ── Settlement Oracle State ─────────────────────────────────────────────
  //
  // The settlement UI previously rendered five hardcoded "VERIFIED" oracle cards
  // from a mock module, so it showed a passing oracle for contracts that had
  // never been audited. This is the same verdict the settlement worker acts on —
  // `OracleStore.evaluate` — read through the shared package, so the screen and
  // the payment cannot disagree.
  server.get<{
    Params: { contractId: string };
    Reply:
      | {
          contractId: string;
          freelancerId: string | null;
          approved: boolean;
          threshold: number;
          signals: {
            astPassed: boolean;
            testsPassed: boolean;
            securityPassed: boolean;
            scopePassed: boolean;
            trustScore: number | null;
            criticalVulns: number | null;
          };
          blockers: string[];
          scopeChecks: { allowed: number; rejected: number; total: number };
          escrow: {
            orderId: string;
            paymentId: string | null;
            amountMinor: number;
            currency: string;
            status: string;
            createdAt: string;
            authorizedAt: string | null;
          } | null;
          settlement: { status: string; transferId: string | null; updatedAt: string } | null;
        }
      | { error: string };
  }>('/api/contracts/:contractId/oracle', contractPartyOnly, async (request, reply) => {
    const { contractId } = request.params;

    const chain = await ledgerClient.getChain(contractId);
    if (chain.length === 0) {
      return reply.status(404).send({ error: 'Contract not found' });
    }

    try {
      const verdict = await oracleStore.evaluate(contractId);

      const scopeRes = await dbPool.query(
        `SELECT count(*) FILTER (WHERE allowed)     AS allowed,
                count(*) FILTER (WHERE NOT allowed) AS rejected,
                count(*)                            AS total
           FROM scope_checks WHERE contract_id = $1`,
        [contractId],
      );
      const sc = scopeRes.rows[0] ?? {};

      // Any escrow row, not just PENDING: after a capture the row is RELEASED,
      // and the UI needs to be able to say so. It also drives the funding panel —
      // a row at PENDING means an order exists that nobody has paid yet, which is
      // exactly when the UI should offer Checkout.
      const escrowRes = await dbPool.query(
        `SELECT order_id, payment_id, amount_cents, currency, status, created_at, authorized_at
           FROM escrow WHERE contract_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [contractId],
      );
      const settlementRes = await dbPool.query(
        `SELECT status, transfer_id, updated_at FROM settlements WHERE contract_id = $1`,
        [contractId],
      );

      // The settlement UI needs the payee. It used to send the literal 'f_alex'.
      const contractRes = await dbPool.query(
        `SELECT freelancer_id FROM contracts WHERE contract_id = $1`,
        [contractId],
      );

      const escrowRow = escrowRes.rows[0];
      const settlementRow = settlementRes.rows[0];

      return reply.status(200).send({
        contractId,
        freelancerId: contractRes.rows[0]?.freelancer_id ?? null,
        approved: verdict.approved,
        threshold: TRUST_SCORE_THRESHOLD,
        signals: verdict.signals,
        blockers: verdict.blockers,
        scopeChecks: {
          allowed: Number(sc.allowed ?? 0),
          rejected: Number(sc.rejected ?? 0),
          total: Number(sc.total ?? 0),
        },
        escrow: escrowRow
          ? {
              orderId: escrowRow.order_id,
              // NULL until the customer pays — the difference between an order
              // that exists and funds that are actually held.
              paymentId: escrowRow.payment_id ?? null,
              amountMinor: Number(escrowRow.amount_cents),
              currency: escrowRow.currency ?? 'INR',
              status: escrowRow.status,
              createdAt: new Date(escrowRow.created_at).toISOString(),
              authorizedAt: escrowRow.authorized_at
                ? new Date(escrowRow.authorized_at).toISOString()
                : null,
            }
          : null,
        settlement: settlementRow
          ? {
              status: settlementRow.status,
              transferId: settlementRow.transfer_id,
              updatedAt: new Date(settlementRow.updated_at).toISOString(),
            }
          : null,
      });
    } catch (err) {
      // An unreadable oracle is not an approving one, and it is not an empty one
      // either — returning a body of `false` signals would render as a definite
      // rejection rather than as "we could not find out".
      request.log.error({ err, contractId }, 'Oracle state lookup failed');
      return reply.status(503).send({ error: 'Oracle state unavailable' });
    }
  });
}
