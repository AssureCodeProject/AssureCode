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
  EVENT_TOPICS,
  type InitializeContract,
  type ContractLocked,
  type TestsGenerated,
} from '@assurecode/shared';
import { withIdempotency } from '../middleware/idempotency.js';
import { type AuthUser } from '../middleware/rbac.js';
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
      }>;
    };
  }>('/api/contracts/mine', freelancerOnly, async (request, reply) => {
    const user = (request as any).user as AuthUser;

    const result = await dbPool.query(
      `SELECT c.contract_id, c.title, c.status, c.budget_cents, c.deadline,
              c.client_id, u.display_name AS client_display_name, c.created_at
         FROM contracts c
         LEFT JOIN users u ON u.user_id = c.client_id
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

      await dbPool.query(
        `UPDATE contracts SET freelancer_id = $1 WHERE contract_id = $2`,
        [freelancerId, contractId],
      );

      logger.info({ contractId, freelancerId }, 'Freelancer assigned to contract');

      await ledgerClient.append(
        contractId,
        'CONTRACT_ASSIGNED',
        { contractId, freelancerId },
      );

      return {
        statusCode: 200,
        contractId,
        body: { contractId, freelancerId, status: 'ASSIGNED' },
      };
    });
  });

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
