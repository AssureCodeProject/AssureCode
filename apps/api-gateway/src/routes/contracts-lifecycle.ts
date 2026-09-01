/**
 * Contract lifecycle: list mine, initialize, match, assign, link a GitHub
 * repo, generate tests, and lock.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  InitializeContractSchema,
  LinkGithubRepoSchema,
  ContractLockedSchema,
  TestsGeneratedSchema,
  RejectAssignmentSchema,
  EVENT_TOPICS,
  type InitializeContract,
  type ContractLocked,
  type TestsGenerated,
} from '@assurecode/shared';
import { withIdempotency } from '../middleware/idempotency.js';
import { generateContractPdf } from '../services/contract-pdf.js';
import { type AuthUser, logSecurityAudit } from '../middleware/rbac.js';
import {
  config,
  logger,
  dbPool,
  eventBus,
  ledgerClient,
  aiServiceUrl,
  serviceCallHeaders,
  callAiService,
  clientOnly,
  freelancerOnly,
  freelancerContractParty,
  contractPartyOnly,
} from '../context.js';

/**
 * What /generate-tests answers with when ai-service cannot produce a bundle.
 * `stub: true` is the honest marker: HTTP 200 with an empty bundle would
 * otherwise read as "zero tests were generated for these requirements".
 */
function stubGeneratedTests(contractId: string): { statusCode: number; contractId: string; body: any } {
  return {
    statusCode: 200,
    contractId,
    body: {
      contractId,
      testBundleUrl: '',
      testCount: 0,
      generatedAt: new Date().toISOString(),
      stub: true,
    } as any,
  };
}

/** Shape shared by both /match response paths (ai-service's real MatchItem and the degraded fallback below). */
interface MatchItem {
  freelancer_id: string;
  freelancer_name: string;
  trust_score: number;
  score: number;
  explanation: { skill_score: number; trust_score: number; history_score: number; matched_skills: string[] };
  hourly_rate_cents: number;
}

/**
 * A freelancer who registered for real and has a currently-valid GitHub
 * connection must always be a candidate, regardless of skill match — a
 * brand-new account has no skills on file, so it can never win a real
 * ranking, and would otherwise be permanently invisible to every client.
 * Seeded demo accounts (tools/seed-users.py) never get an auth_providers
 * GITHUB row unless someone deliberately connects one, so this JOIN only
 * ever pulls in real, currently-connected freelancers — it does not change
 * how the 12 seeded accounts rank.
 *
 * Deliberately does NOT require a freelancer_profiles row to exist
 * (LEFT JOIN, not JOIN): that row is only created best-effort, via a call
 * to ai-service's embedder at OAuth time (auth.ts's ensureFreelancerProfile)
 * -- a real freelancer whose embed call happened to fail or time out at
 * connect time would otherwise be silently and permanently invisible here
 * too, exactly the "irrespective of skills" guarantee this function exists
 * to provide. Missing trust_score/hourly_rate just fall back to honest
 * defaults instead.
 *
 * token_valid = TRUE deliberately excludes a freelancer whose GitHub link
 * has gone stale (RECONNECTION_REQUIRED, see /api/freelancer/github-status)
 * — consistent with the rest of the system treating that state as "not
 * really connected right now."
 *
 * Called from both /match response paths (the real ai-service result and
 * the degraded trust-score fallback) so the guarantee holds either way.
 */
async function withAlwaysVisibleFreelancers(results: MatchItem[]): Promise<MatchItem[]> {
  const present = new Set(results.map((r) => r.freelancer_id));
  const { rows } = await dbPool.query(`
    SELECT u.user_id AS freelancer_id, u.display_name, f.trust_score, f.hourly_rate_cents
      FROM users u
      JOIN auth_providers ap ON ap.user_id = u.user_id
                             AND ap.provider_type = 'GITHUB' AND ap.token_valid = TRUE
      LEFT JOIN freelancer_profiles f ON f.freelancer_id = u.user_id
     WHERE u.role = 'freelancer'
  `);

  const extras: MatchItem[] = rows
    .filter((row) => !present.has(row.freelancer_id))
    .map((row) => {
      const trustScore = parseFloat(row.trust_score || 0.5);
      return {
        freelancer_id: row.freelancer_id,
        freelancer_name: row.display_name,
        trust_score: trustScore,
        score: trustScore,
        // Honestly unmeasured, same convention the degraded path already
        // uses -- this candidate isn't here because of a skill match.
        explanation: { skill_score: 0, trust_score: trustScore, history_score: 0, matched_skills: [] },
        hourly_rate_cents: parseInt(row.hourly_rate_cents || 0, 10),
      };
    });

  return [...results, ...extras];
}

export function registerContractsLifecycleRoutes(server: FastifyInstance): void {
  server.get<{
    Reply: {
      contracts: Array<{
        contractId: string;
        title: string;
        status: string;
        budgetCents: number;
        deadline: string;
        clientId: string;
        clientDisplayName: string | null;
        createdAt: string;
        assignmentStatus: string | null;
        assignmentId: number | null;
        requirementsSummary: string | null;
      }>;
    };
  }>('/api/contracts/mine', freelancerOnly, async (request, reply) => {
    const user = (request as any).user as AuthUser;

    // LATERAL, not a plain JOIN: a contract can have more than one
    // contract_assignments row for this freelancer (reject -> reassign ->
    // accept), and only the most recent one is the live decision. Restricted
    // to this freelancer's own rows so a contract reassigned to someone else
    // after rejecting this freelancer doesn't show them a stale ACCEPTED/
    // PENDING that belongs to the new assignee.
    const result = await dbPool.query(
      `SELECT c.contract_id, c.title, c.status, c.budget_cents, c.deadline,
              c.client_id, u.display_name AS client_display_name, c.created_at,
              LEFT(c.requirements, 240) AS requirements_summary,
              ca.status AS assignment_status, ca.assignment_id
         FROM contracts c
         LEFT JOIN users u ON u.user_id = c.client_id
         LEFT JOIN LATERAL (
           SELECT status, assignment_id FROM contract_assignments
            WHERE contract_id = c.contract_id AND freelancer_id = $1
            ORDER BY assignment_id DESC LIMIT 1
         ) ca ON true
        WHERE c.freelancer_id = $1
        ORDER BY c.created_at DESC`,
      [user.userId],
    );

    return reply.status(200).send({
      contracts: result.rows.map((row) => ({
        contractId: row.contract_id,
        title: row.title,
        status: row.status,
        budgetCents: row.budget_cents,
        deadline: row.deadline,
        clientId: row.client_id,
        clientDisplayName: row.client_display_name ?? null,
        createdAt: row.created_at,
        assignmentStatus: row.assignment_status ?? null,
        assignmentId: row.assignment_id ?? null,
        requirementsSummary: row.requirements_summary ?? null,
      })),
    });
  });

  server.post<{
    Body: InitializeContract;
    Reply: { contractId: string; clientId: string } & InitializeContract;
  }>('/api/contracts/initialize', async (request, reply) => {
    return withIdempotency(dbPool, request, reply, async () => {
      const body = InitializeContractSchema.parse(request.body);

      // `AC-${Date.now().toString(36)}` alone collides: two contracts initialized
      // in the same millisecond get the same id, and the second one's INSERT
      // below would fail — or worse, silently attach to the first one's ledger.
      // The random suffix makes the identifier unique rather than merely usually
      // unique.
      const contractId = `AC-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;

      // client_id used to be a fresh randomUUID() per contract — it matched no
      // real user, which is why the V012 migration had 114 rows to backfill
      // before it could add the FK. A logged-in client now owns the contract
      // for real; a SERVICE_TOKEN caller (CI harnesses, benchmark scripts) has
      // no user identity, so it falls back to the seeded legacy-client account
      // rather than being blocked entirely.
      const user = (request as any).user as AuthUser | undefined;
      if (user && user.role !== 'client') {
        return {
          statusCode: 403,
          contractId: '',
          body: { error: `Role '${user.role}' cannot initialize a contract` } as any,
        };
      }
      const clientId = user?.userId ?? 'legacy-client';
      const correlationId = randomUUID();

      // Persist contract to database so downstream endpoints can reference it.
      // pdf_raw_text is the full extracted document (POST /api/pdf/extract),
      // stored separately from `requirements` — the client may have trimmed or
      // edited the summary that gets hashed without losing the source text the
      // lock-time RAG ingest uses.
      await dbPool.query(
        `INSERT INTO contracts (contract_id, client_id, title, requirements, pdf_raw_text, budget_cents, deadline, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT')
         ON CONFLICT (contract_id) DO NOTHING`,
        [contractId, clientId, body.title, body.requirements, body.pdfRawText ?? null, body.budgetCents, body.deadline],
      );

      logger.info(
        { contractId, clientId, title: body.title },
        'Contract initialized',
      );

      await eventBus.publish(
        EVENT_TOPICS.CONTRACT_INITIALIZED,
        { contractId, clientId, ...body },
        correlationId,
      );

      const resBody = {
        contractId,
        clientId,
        ...body,
      };

      return {
        statusCode: 201,
        contractId,
        body: resBody,
      };
    });
  });

  server.post<{
    Params: { contractId: string };
    Body: { requirements: string; topK?: number };
  }>('/api/contracts/:contractId/match', clientOnly, async (request, reply) => {
    const { contractId } = request.params;
    const { requirements, topK } = request.body || {};

    try {
      const aiRes = await fetch(`${aiServiceUrl}/match`, {
        method: 'POST',
        headers: serviceCallHeaders(),
        body: JSON.stringify({
          requirements: requirements || '',
          top_k: topK || 5,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (aiRes.ok) {
        const data = (await aiRes.json()) as { results?: MatchItem[]; [key: string]: unknown };
        const results = await withAlwaysVisibleFreelancers(data.results ?? []);
        return reply.send({ ...data, results, count: results.length });
      }

      logger.warn(
        { contractId, status: aiRes.status },
        'AI service /match returned non-OK, falling back to trust-score ranking',
      );
    } catch (err) {
      logger.warn({ contractId, err }, 'AI service match unreachable, falling back to trust-score ranking');
    }

    // Degraded path: no embedder reachable, so there is no semantic signal to
    // report. Previously this hardcoded skill_score: 0.85 and history_score: 0.8
    // — literal constants presented as if they were computed — and dumped a
    // freelancer's entire skill list as "matched_skills" regardless of whether
    // any of it appeared in what the client asked for. Both terms are honestly
    // unmeasured here (0), the same "no vector, no fabricated score" convention
    // InMemoryGraphRepo uses on the ai-service side; matched_skills is a real
    // (if crude) keyword overlap against the requirements text, not the whole
    // roster; and `degraded: true` lets the frontend say so instead of
    // presenting this as an ordinary ranked result.
    const pgRes = await dbPool.query(`
      SELECT f.freelancer_id, u.display_name, f.trust_score, f.skills, f.hourly_rate_cents
      FROM freelancer_profiles f
      JOIN users u ON u.user_id = f.freelancer_id
      ORDER BY f.trust_score DESC
      LIMIT $1
    `, [topK || 5]);

    const reqTokens = new Set(
      (requirements || '')
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.replace(/^\W+|\W+$/g, ''))
        .filter(Boolean),
    );

    const rankedResults = pgRes.rows.map((row) => {
      const trustScore = parseFloat(row.trust_score || 0.5);
      const skills: string[] = Array.isArray(row.skills) ? row.skills : [];
      return {
        freelancer_id: row.freelancer_id,
        freelancer_name: row.display_name,
        trust_score: trustScore,
        score: trustScore,
        explanation: {
          skill_score: 0,
          trust_score: trustScore,
          history_score: 0,
          matched_skills: skills.filter((s) => reqTokens.has(String(s).toLowerCase())),
        },
        hourly_rate_cents: parseInt(row.hourly_rate_cents || 0, 10),
      };
    });
    const results = await withAlwaysVisibleFreelancers(rankedResults);

    return reply.send({
      results,
      count: results.length,
      degraded: true,
      degradedReason:
        'AI matching service unavailable — ranked by trust score only; skill and delivery-history terms are unmeasured, not zero-rated.',
    });
  });

  /**
   * Assign a freelancer to a contract. This no longer puts work in the
   * freelancer's hands directly — it creates a PENDING contract_assignments
   * row and stops there; nothing provisions a repository or moves the
   * contract to ACTIVE until the freelancer explicitly accepts via
   * POST .../assignment/accept. See subscribeAssignmentAccepted in
   * apps/settlement-worker/src/worker.ts for what accepting triggers.
   */
  server.post<{
    Params: { contractId: string };
    Body: { freelancerId: string };
  }>('/api/contracts/:contractId/assign', clientOnly, async (request, reply) => {
    return withIdempotency(dbPool, request, reply, async () => {
      const { contractId } = request.params;
      const { freelancerId } = request.body || {};

      if (!freelancerId) {
        return {
          statusCode: 400,
          contractId,
          body: { error: 'freelancerId is required' } as any,
        };
      }

      // Reassigning over an assignment the freelancer already accepted would
      // silently pull the workspace out from under whoever is already on it.
      // A prior PENDING or REJECTED row is fine to supersede.
      const activeRes = await dbPool.query(
        `SELECT 1 FROM contract_assignments WHERE contract_id = $1 AND status = 'ACCEPTED'`,
        [contractId],
      );
      if ((activeRes.rowCount ?? 0) > 0) {
        return {
          statusCode: 409,
          contractId,
          body: {
            error: 'ASSIGNMENT_ALREADY_ACTIVE',
            message: 'This contract already has an accepted assignment.',
          } as any,
        };
      }

      // The genesis ledger row (H0) for this contract — always the first row
      // ever appended (previous_hash = 'GENESIS'), regardless of whether
      // /lock has run yet. This is what the freelancer's eventual acceptance
      // gets anchored to, so it refers to the contract as originally written
      // rather than to whatever the row currently reads.
      const h0Res = await dbPool.query(
        `SELECT ledger_id, current_hash FROM merkle_ledger
          WHERE contract_id = $1 ORDER BY ledger_id ASC LIMIT 1`,
        [contractId],
      );
      const h0 = h0Res.rows[0] as { ledger_id: number; current_hash: string } | undefined;

      await dbPool.query(
        `UPDATE contracts SET freelancer_id = $1 WHERE contract_id = $2`,
        [freelancerId, contractId],
      );

      let assignmentId: number;
      try {
        const insertRes = await dbPool.query(
          `INSERT INTO contract_assignments (contract_id, freelancer_id, locked_ledger_id, locked_ledger_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING assignment_id`,
          [contractId, freelancerId, h0?.ledger_id ?? null, h0?.current_hash ?? null],
        );
        assignmentId = insertRes.rows[0].assignment_id;
      } catch (err: any) {
        // 23505 on idx_contract_assignments_one_pending: a concurrent /assign
        // call already created a pending decision for this contract.
        if (err?.code === '23505') {
          return {
            statusCode: 409,
            contractId,
            body: {
              error: 'ASSIGNMENT_ALREADY_PENDING',
              message: 'A decision is already pending for this contract.',
            } as any,
          };
        }
        throw err;
      }

      logger.info(
        { contractId, freelancerId, assignmentId },
        'Freelancer assigned to contract; awaiting their acceptance',
      );

      await ledgerClient.appendWithOutbox(
        contractId,
        'CONTRACT_ASSIGNED',
        { contractId, freelancerId, assignmentId },
        EVENT_TOPICS.ASSIGNMENT_PENDING,
        { contractId, freelancerId, assignmentId },
        randomUUID(),
      );

      return {
        statusCode: 200,
        contractId,
        body: { contractId, freelancerId, assignmentId, status: 'ASSIGNMENT_PENDING' },
      };
    });
  });

  /**
   * Full contract + current assignment-decision view for "View Contract
   * Details" on the freelancer's assignment card (and the client's own
   * mirror of the same screen). contractPartyOnly, not freelancerOnly: the
   * client who owns the contract has the same legitimate reason to read it.
   */
  server.get<{ Params: { contractId: string } }>(
    '/api/contracts/:contractId/assignment-details',
    contractPartyOnly,
    async (request, reply) => {
      const { contractId } = request.params;

      const contractRes = await dbPool.query(
        `SELECT c.contract_id, c.title, c.requirements, c.budget_cents, c.deadline, c.status,
                c.client_id, cu.display_name AS client_display_name,
                c.freelancer_id, fu.display_name AS freelancer_display_name,
                c.created_at
           FROM contracts c
           LEFT JOIN users cu ON cu.user_id = c.client_id
           LEFT JOIN users fu ON fu.user_id = c.freelancer_id
          WHERE c.contract_id = $1`,
        [contractId],
      );
      if (contractRes.rowCount === 0) {
        return reply.status(404).send({ error: 'Not Found', message: `No contract ${contractId}` });
      }
      const c = contractRes.rows[0];

      // Most recent assignment decision — a rejected-then-reassigned contract
      // can have more than one row; the latest is the live one.
      const assignmentRes = await dbPool.query(
        `SELECT assignment_id, freelancer_id, status, locked_ledger_id, locked_ledger_hash,
                rejection_reason_code, rejection_reason_text, assigned_at, decided_at
           FROM contract_assignments
          WHERE contract_id = $1
          ORDER BY assignment_id DESC
          LIMIT 1`,
        [contractId],
      );
      const a = assignmentRes.rows[0];

      const h0Res = await dbPool.query(
        `SELECT current_hash FROM merkle_ledger WHERE contract_id = $1 ORDER BY ledger_id ASC LIMIT 1`,
        [contractId],
      );

      return reply.send({
        contractId: c.contract_id,
        title: c.title,
        requirements: c.requirements,
        budgetCents: c.budget_cents,
        deadline: c.deadline,
        status: c.status,
        clientId: c.client_id,
        clientDisplayName: c.client_display_name ?? null,
        freelancerId: c.freelancer_id,
        freelancerDisplayName: c.freelancer_display_name ?? null,
        createdAt: c.created_at,
        genesisHash: h0Res.rows[0]?.current_hash ?? null,
        assignment: a
          ? {
              assignmentId: a.assignment_id,
              status: a.status,
              lockedLedgerId: a.locked_ledger_id,
              lockedLedgerHash: a.locked_ledger_hash,
              rejectionReasonCode: a.rejection_reason_code,
              rejectionReasonText: a.rejection_reason_text,
              assignedAt: a.assigned_at,
              decidedAt: a.decided_at,
            }
          : null,
      });
    },
  );

  /**
   * The authoritative contract PDF — generated fresh from the database on
   * every request (nothing is cached or stored), so it always reflects
   * current data rather than a snapshot that can drift from it. Guarded by
   * contractPartyOnly: exactly the same "this contract's client or its
   * assigned freelancer, or admin" check as assignment-details, which is the
   * whole authorization requirement here (an unrelated freelancer's user id
   * matches neither contracts.client_id nor contracts.freelancer_id, so
   * requireContractParty answers 403 before this handler ever runs).
   */
  server.get<{ Params: { contractId: string } }>(
    '/api/contracts/:contractId/assignment-pdf',
    contractPartyOnly,
    async (request, reply) => {
      const { contractId } = request.params;

      const contractRes = await dbPool.query(
        `SELECT c.contract_id, c.title, c.requirements, c.budget_cents, c.deadline, c.status,
                cu.display_name AS client_display_name, fu.display_name AS freelancer_display_name,
                c.created_at
           FROM contracts c
           LEFT JOIN users cu ON cu.user_id = c.client_id
           LEFT JOIN users fu ON fu.user_id = c.freelancer_id
          WHERE c.contract_id = $1`,
        [contractId],
      );
      if (contractRes.rowCount === 0) {
        return reply.status(404).send({ error: 'Not Found', message: `No contract ${contractId}` });
      }
      const c = contractRes.rows[0];

      const assignmentRes = await dbPool.query(
        `SELECT status, locked_ledger_hash, assigned_at FROM contract_assignments
          WHERE contract_id = $1 ORDER BY assignment_id DESC LIMIT 1`,
        [contractId],
      );
      const a = assignmentRes.rows[0];

      const h0Res = await dbPool.query(
        `SELECT current_hash FROM merkle_ledger WHERE contract_id = $1 ORDER BY ledger_id ASC LIMIT 1`,
        [contractId],
      );

      const pdfBuffer = await generateContractPdf({
        contractId: c.contract_id,
        title: c.title,
        requirements: c.requirements,
        budgetCents: c.budget_cents,
        deadline: c.deadline,
        status: c.status,
        clientDisplayName: c.client_display_name ?? null,
        freelancerDisplayName: c.freelancer_display_name ?? null,
        createdAt: c.created_at,
        assignedAt: a?.assigned_at ?? null,
        assignmentStatus: a?.status ?? null,
        genesisHash: h0Res.rows[0]?.current_hash ?? null,
        assignmentLedgerHash: a?.locked_ledger_hash ?? null,
      });

      logSecurityAudit(dbPool, {
        userId: (request as any).user?.userId,
        action: 'CONTRACT_PDF_DOWNLOADED',
        resource: `contract:${contractId}`,
        ipAddress: request.ip,
        status: 'SUCCESS',
      }).catch(() => undefined);

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${contractId}-assignment.pdf"`)
        .send(pdfBuffer);
    },
  );

  /**
   * The freelancer explicitly accepts a pending assignment. The conditional
   * UPDATE (status='PENDING' -> 'ACCEPTED', gated in the WHERE clause) is the
   * actual concurrency guard — two tabs, a retry, and a reject racing an
   * accept all resolve to exactly one winner because only one request's
   * UPDATE can match a row still at 'PENDING'. withIdempotency's header-keyed
   * cache is a second, independent layer for the common case (same key
   * resubmitted) but is not what this route relies on for correctness.
   */
  server.post<{ Params: { contractId: string } }>(
    '/api/contracts/:contractId/assignment/accept',
    freelancerContractParty,
    async (request, reply) => {
      return withIdempotency(dbPool, request, reply, async () => {
        const { contractId } = request.params;
        const user = (request as any).user as AuthUser;
        const correlationId = randomUUID();

        const updateRes = await dbPool.query(
          `UPDATE contract_assignments
              SET status = 'ACCEPTED', decided_at = NOW(), updated_at = NOW()
            WHERE contract_id = $1 AND freelancer_id = $2 AND status = 'PENDING'
          RETURNING assignment_id, locked_ledger_hash, decided_at`,
          [contractId, user.userId],
        );

        if (updateRes.rowCount === 0) {
          const currentRes = await dbPool.query(
            `SELECT status FROM contract_assignments
              WHERE contract_id = $1 AND freelancer_id = $2
              ORDER BY assignment_id DESC LIMIT 1`,
            [contractId, user.userId],
          );
          const currentStatus: string | null = currentRes.rows[0]?.status ?? null;
          return {
            statusCode: 409,
            contractId,
            body: {
              error: 'ASSIGNMENT_NOT_PENDING',
              message: currentStatus
                ? `This assignment is already ${currentStatus}.`
                : 'No pending assignment found for you on this contract.',
              status: currentStatus,
            } as any,
          };
        }

        const row = updateRes.rows[0];

        // The current UI's Phase-1 flow still calls /assign before /lock (see
        // the note on that route), so merkle_ledger can genuinely have no
        // genesis row yet at assignment time — locked_ledger_hash is captured
        // there on a best-effort basis. Acceptance happens later, often much
        // later, than that same short assign -> generate-tests -> lock
        // sequence, so re-resolving H0 here (rather than only at /assign)
        // is what actually gets it populated in the realistic case: by the
        // time a freelancer gets around to accepting, the contract has
        // almost always been locked. Best-effort UPDATE, not re-fetched into
        // the response below on failure — a missing H0 anchor is a weaker
        // integrity claim, not a reason to fail an otherwise-valid acceptance.
        let lockedLedgerHash: string | null = row.locked_ledger_hash ?? null;
        if (!lockedLedgerHash) {
          try {
            const h0Res = await dbPool.query(
              `SELECT ledger_id, current_hash FROM merkle_ledger
                WHERE contract_id = $1 ORDER BY ledger_id ASC LIMIT 1`,
              [contractId],
            );
            const h0 = h0Res.rows[0] as { ledger_id: number; current_hash: string } | undefined;
            if (h0) {
              await dbPool.query(
                `UPDATE contract_assignments SET locked_ledger_id = $1, locked_ledger_hash = $2, updated_at = NOW()
                  WHERE assignment_id = $3`,
                [h0.ledger_id, h0.current_hash, row.assignment_id],
              );
              lockedLedgerHash = h0.current_hash;
            }
          } catch (err: any) {
            logger.warn({ contractId, err: err.message }, 'Failed to backfill H0 anchor onto accepted assignment');
          }
        }

        logger.info(
          { contractId, freelancerId: user.userId, assignmentId: row.assignment_id, lockedLedgerHash },
          'Freelancer accepted assignment',
        );

        // ASSIGNMENT_ACCEPTED is what settlement-worker's
        // subscribeAssignmentAccepted listens for to (1) notify the client and
        // (2) begin repo provisioning — see worker.ts. Nothing here calls
        // provisioning directly; the gateway stays a thin request/response
        // surface and the worker is the reactor, matching every other
        // lifecycle transition in this file.
        await ledgerClient.appendWithOutbox(
          contractId,
          'ASSIGNMENT_ACCEPTED',
          {
            contractId,
            freelancerId: user.userId,
            assignmentId: row.assignment_id,
            lockedLedgerHash,
          },
          EVENT_TOPICS.ASSIGNMENT_ACCEPTED,
          { contractId, freelancerId: user.userId, assignmentId: row.assignment_id },
          correlationId,
        );

        return {
          statusCode: 200,
          contractId,
          body: {
            contractId,
            assignmentId: row.assignment_id,
            status: 'ACCEPTED',
            decidedAt: row.decided_at,
          },
        };
      });
    },
  );

  /**
   * The freelancer explicitly declines a pending assignment. Same conditional-
   * UPDATE concurrency guard as accept. Clears contracts.freelancer_id so the
   * contract is immediately visible as unassigned for the client to reassign;
   * repository provisioning is never triggered because ASSIGNMENT_ACCEPTED —
   * the only event subscribeAssignmentAccepted listens for — is never
   * published on this path.
   */
  server.post<{ Params: { contractId: string }; Body: unknown }>(
    '/api/contracts/:contractId/assignment/reject',
    freelancerContractParty,
    async (request, reply) => {
      return withIdempotency(dbPool, request, reply, async () => {
        const { contractId } = request.params;
        const user = (request as any).user as AuthUser;
        const correlationId = randomUUID();
        const { reasonCode, reasonText } = RejectAssignmentSchema.parse(request.body ?? {});

        const updateRes = await dbPool.query(
          `UPDATE contract_assignments
              SET status = 'REJECTED', decided_at = NOW(), updated_at = NOW(),
                  rejection_reason_code = $3, rejection_reason_text = $4
            WHERE contract_id = $1 AND freelancer_id = $2 AND status = 'PENDING'
          RETURNING assignment_id, decided_at`,
          [contractId, user.userId, reasonCode ?? null, reasonText ?? null],
        );

        if (updateRes.rowCount === 0) {
          const currentRes = await dbPool.query(
            `SELECT status FROM contract_assignments
              WHERE contract_id = $1 AND freelancer_id = $2
              ORDER BY assignment_id DESC LIMIT 1`,
            [contractId, user.userId],
          );
          const currentStatus: string | null = currentRes.rows[0]?.status ?? null;
          return {
            statusCode: 409,
            contractId,
            body: {
              error: 'ASSIGNMENT_NOT_PENDING',
              message: currentStatus
                ? `This assignment is already ${currentStatus}.`
                : 'No pending assignment found for you on this contract.',
              status: currentStatus,
            } as any,
          };
        }

        await dbPool.query(`UPDATE contracts SET freelancer_id = NULL WHERE contract_id = $1`, [contractId]);

        const row = updateRes.rows[0];
        logger.info(
          { contractId, freelancerId: user.userId, assignmentId: row.assignment_id, reasonCode },
          'Freelancer rejected assignment',
        );

        await ledgerClient.appendWithOutbox(
          contractId,
          'ASSIGNMENT_REJECTED',
          { contractId, freelancerId: user.userId, assignmentId: row.assignment_id, reasonCode: reasonCode ?? null },
          EVENT_TOPICS.ASSIGNMENT_REJECTED,
          {
            contractId,
            freelancerId: user.userId,
            assignmentId: row.assignment_id,
            reasonCode: reasonCode ?? null,
            reasonText: reasonText ?? null,
          },
          correlationId,
        );

        return {
          statusCode: 200,
          contractId,
          body: { contractId, assignmentId: row.assignment_id, status: 'REJECTED', decidedAt: row.decided_at },
        };
      });
    },
  );

  /**
   * Link a contract to the GitHub repository the freelancer pushes to.
   *
   * This is what makes a real push auditable. apps/webhook-ingest receives a
   * delivery carrying `repository.full_name` and nothing that identifies a
   * contract — GitHub has no idea this platform exists — so without a stored
   * mapping it cannot name the contract the push belongs to, and the audit it
   * would produce has no valid `contract_id` to be filed under.
   *
   * Separate from /assign rather than a field on it, because the two facts change
   * independently: a repository can be re-pointed mid-contract (wrong repo linked,
   * work moved) without re-assigning the freelancer, and a freelancer can be
   * assigned before the repository exists.
   */
  server.patch<{
    Params: { contractId: string };
    Body: { githubRepoFullName: string };
  }>('/api/contracts/:contractId/github-repo', clientOnly, async (request, reply) => {
    return withIdempotency(dbPool, request, reply, async () => {
      const { contractId } = request.params;
      // Throws ZodError on a URL or a bare repo name, which the global error
      // handler renders as a 400 naming the field.
      const { githubRepoFullName } = LinkGithubRepoSchema.parse(request.body);

      const result = await dbPool.query(
        `UPDATE contracts SET github_repo_full_name = $1 WHERE contract_id = $2
         RETURNING contract_id, freelancer_id`,
        [githubRepoFullName, contractId],
      );

      // An UPDATE that matches nothing is not an error to Postgres, so without
      // this a typo'd contract id reports success and the failure only surfaces
      // on a push weeks later, as a repository that appears linked but is not.
      if (result.rowCount === 0) {
        return {
          statusCode: 404,
          contractId,
          body: { error: 'Not Found', message: `No contract ${contractId}` } as any,
        };
      }

      logger.info({ contractId, githubRepoFullName }, 'GitHub repository linked to contract');

      await ledgerClient.append(contractId, 'CONTRACT_REPO_LINKED', {
        contractId,
        githubRepoFullName,
      });

      // Best-effort webhook registration. The repo belongs to the freelancer,
      // not the client who just called this route — so the token that can
      // actually add a webhook to it is the *freelancer's* stored GitHub OAuth
      // token (looked up by contracts.freelancer_id), not the caller's. A
      // freelancer with no connected GitHub account (still logs in with a
      // password) simply gets no auto-registered webhook; the repo link itself
      // still succeeds, and the webhook can be added manually as a fallback.
      const freelancerId: string | null = result.rows[0].freelancer_id;
      if (freelancerId && config.WEBHOOK_INGEST_PUBLIC_URL && config.GITHUB_TOKEN_ENCRYPTION_KEY) {
        try {
          const tokenRow = await dbPool.query(
            `SELECT pgp_sym_decrypt(access_token_encrypted, $2) AS token
               FROM auth_providers WHERE user_id = $1 AND provider_type = 'GITHUB' AND access_token_encrypted IS NOT NULL`,
            [freelancerId, config.GITHUB_TOKEN_ENCRYPTION_KEY],
          );
          const freelancerToken: string | undefined = tokenRow.rows[0]?.token;
          if (freelancerToken) {
            const hookRes = await fetch(`https://api.github.com/repos/${githubRepoFullName}/hooks`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${freelancerToken}`,
                'User-Agent': 'assurecode-api-gateway',
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                name: 'web',
                active: true,
                events: ['push'],
                config: {
                  url: `${config.WEBHOOK_INGEST_PUBLIC_URL}/webhooks/github`,
                  content_type: 'json',
                  secret: config.GITHUB_WEBHOOK_SECRET,
                },
              }),
            });
            if (hookRes.ok) {
              logger.info({ contractId, githubRepoFullName }, 'GitHub webhook auto-registered for repo');
            } else {
              logger.warn(
                { contractId, githubRepoFullName, status: hookRes.status },
                'GitHub webhook auto-registration failed; add it manually',
              );
            }
          }
        } catch (err) {
          logger.warn({ contractId, githubRepoFullName, err }, 'GitHub webhook auto-registration threw (non-blocking)');
        }
      }

      return {
        statusCode: 200,
        contractId,
        body: { contractId, githubRepoFullName },
      };
    });
  });

  // Read-only status for the auto-provisioned repo (settlement-worker's
  // attemptProvisioning, hooked off CONTRACT_LOCKED — see worker.ts). Used
  // by both the freelancer dashboard (to show the clone link once ready)
  // and the client's own view of contract progress. No auth-role
  // restriction beyond being logged in: either party on the contract has a
  // legitimate reason to see whether the workspace is ready yet.
  server.get<{ Params: { contractId: string } }>(
    '/api/contracts/:contractId/repo-provisioning',
    async (request, reply) => {
      const { contractId } = request.params;
      const res = await dbPool.query(
        `SELECT status, repo_full_name, repo_html_url, collaborator_status, webhook_status, last_error, updated_at
           FROM repo_provisioning WHERE contract_id = $1`,
        [contractId],
      );
      if (res.rowCount === 0) {
        return reply.status(404).send({ error: 'Not Found', message: `No provisioning record for ${contractId}` });
      }
      const row = res.rows[0];
      return reply.send({
        contractId,
        status: row.status,
        repoFullName: row.repo_full_name,
        repoHtmlUrl: row.repo_html_url,
        collaboratorStatus: row.collaborator_status,
        webhookStatus: row.webhook_status,
        lastError: row.last_error,
        updatedAt: row.updated_at,
      });
    },
  );

  server.post<{
    Params: { contractId: string };
    Body: { title: string; requirements: string; framework?: string };
    Reply:
    | {
      contractId: string;
      testBundleUrl: string;
      testCount: number;
      generatedAt: string;
    }
    | { error: string; retryAfter: number };
  }>('/api/contracts/:contractId/generate-tests', clientOnly, async (request, reply) => {
    return withIdempotency(dbPool, request, reply, async () => {
      const { contractId } = request.params;
      const { title, requirements, framework } = request.body || {};
      const correlationId = randomUUID();

      logger.info({ contractId }, 'Generating tests via ai-service');

      try {
        const aiRes = await fetch(`${aiServiceUrl}/generate-tests`, {
          method: 'POST',
          headers: serviceCallHeaders(),
          body: JSON.stringify({
            contract_id: contractId,
            title: title || 'untitled',
            requirements: requirements || '',
            framework: framework || 'jest',
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (aiRes.status === 503) {
          const retryAfterHeader = aiRes.headers.get('retry-after');
          const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) || 5 : 5;

          // 503 and a Retry-After, not 202 and a job id.
          //
          // This branch used to insert a row into `jobs` with status 'queued' and
          // hand back a pollUrl. No worker ever transitioned those rows — there
          // was no `UPDATE jobs` anywhere in the repo — so the poll endpoint
          // answered 'queued' forever and the caller waited on work that was
          // never going to start. Saying "unavailable, try again" is the truth;
          // saying "queued" was not.
          logger.warn(
            { contractId, retryAfter },
            'ai-service has no LLM available for test generation; asking the caller to retry',
          );
          return {
            statusCode: 503,
            contractId,
            body: {
              error:
                'Test generation is temporarily unavailable: the AI service has no LLM ' +
                'provider configured or reachable. Retry after the interval below.',
              retryAfter,
            },
          };
        }

        if (!aiRes.ok) {
          logger.warn({ contractId, status: aiRes.status }, 'ai-service generate-tests unavailable, returning stub response');
          return stubGeneratedTests(contractId);
        }

        const genRaw = (await aiRes.json()) as {
          contract_id: string;
          s3_key: string;
          s3_url: string;
          test_count: number;
          framework: string;
          generated_at: string;
        };

        const genData: TestsGenerated = {
          contractId: genRaw.contract_id,
          s3Key: genRaw.s3_key,
          s3Url: genRaw.s3_url,
          testCount: genRaw.test_count,
          framework: genRaw.framework,
          generatedAt: genRaw.generated_at,
        };

        TestsGeneratedSchema.parse(genData);

        await ledgerClient.appendWithOutbox(
          contractId,
          'TESTS_GENERATED',
          {
            s3Key: genData.s3Key,
            s3Url: genData.s3Url,
            testCount: genData.testCount,
            framework: genData.framework,
          },
          EVENT_TOPICS.TESTS_GENERATED,
          {
            ...genData,
          },
          correlationId,
        );

        return {
          statusCode: 200,
          contractId,
          body: {
            contractId,
            testBundleUrl: genData.s3Url,
            testCount: genData.testCount,
            generatedAt: genData.generatedAt,
          },
        };
      } catch (err) {
        logger.warn({ contractId, err }, 'ai-service generate-tests unreachable, returning stub response');
        return stubGeneratedTests(contractId);
      }
    });
  });

  server.post<{
    Params: { contractId: string };
    Body: InitializeContract;
    Reply: ContractLocked;
  }>('/api/contracts/:contractId/lock', clientOnly, async (request, reply) => {
    return withIdempotency(dbPool, request, reply, async () => {
      const { contractId } = request.params;
      const body = InitializeContractSchema.parse(request.body);
      const correlationId = randomUUID();

      const ledgerRow = await ledgerClient.appendWithOutbox(
        contractId,
        'CONTRACT_LOCKED',
        {
          title: body.title,
          requirements: body.requirements,
          budgetCents: body.budgetCents,
          deadline: body.deadline,
        },
        EVENT_TOPICS.CONTRACT_LOCKED,
        {
          contractId,
          title: body.title,
          budgetCents: body.budgetCents,
          deadline: body.deadline,
        },
        correlationId,
      );

      const lockedPayload: ContractLocked = {
        contractId,
        hash: ledgerRow.currentHash,
        timestamp: ledgerRow.createdAt,
        title: body.title,
        budgetCents: body.budgetCents,
        deadline: body.deadline,
      };

      ContractLockedSchema.parse(lockedPayload);

      logger.info(
        { contractId, hash: ledgerRow.currentHash },
        'Contract locked to ledger',
      );

      // Fire-and-forget: ingest contract text into RAG store for scope checking.
      // Prefer the full extracted PDF text over the (possibly trimmed) summary
      // in `requirements` — it gives the scope guard's retrieval real material
      // to match against instead of a one-line brief.
      let ragText = body.requirements;
      try {
        const pdfRes = await dbPool.query(`SELECT pdf_raw_text FROM contracts WHERE contract_id = $1`, [contractId]);
        const pdfRawText = pdfRes.rows[0]?.pdf_raw_text as string | null | undefined;
        if (pdfRawText && pdfRawText.trim()) ragText = pdfRawText;
      } catch (err) {
        logger.warn({ contractId, err }, 'Failed to read pdf_raw_text for RAG ingest, using requirements');
      }
      void callAiService('/rag/ingest', {
        contract_id: contractId,
        text: ragText,
        target_chars: 512,
        overlap_chars: 64,
      });

      return {
        statusCode: 200,
        contractId,
        body: lockedPayload,
      };
    });
  });
}
