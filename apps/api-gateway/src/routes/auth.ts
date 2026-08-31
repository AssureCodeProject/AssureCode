/**
 * Auth routes: password login + MFA (TOTP), session management, and GitHub
 * OAuth (freelancer login + repo connection).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { config, logger, dbPool, aiServiceUrl, serviceCallHeaders } from '../context.js';
import { logSecurityAudit, type AuthUser } from '../middleware/rbac.js';
import { verifyPassword, hashPassword } from '../middleware/auth.js';
import { createSession, newSessionId, revokeSession } from '../middleware/session-store.js';
import {
  startEnrollment,
  verifyEnrollment,
  verifyActiveCode,
  disableMfa,
  MfaAlreadyEnabledError,
  MfaNotPendingError,
  MfaNotEnabledError,
} from '../middleware/mfa-store.js';

const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Same short-lived-signed-code shape as the GitHub OAuth exchange code below
// (HMAC over a nonce+timestamp, keyed on JWT_SECRET — no new storage table),
// but with a purpose prefix baked into the signed string. Without it, a code
// minted here would also happen to verify against GitHub's
// verifyExchangeCode (same key, same `userId.ts.nonce` shape) and vice versa
// — two unrelated capabilities that should never be interchangeable.
function signMfaChallenge(userId: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `mfa.${userId}.${ts}.${nonce}`;
  const sig = createHmac('sha256', config.JWT_SECRET).update(payload).digest('base64url');
  return `${userId}.${ts}.${nonce}.${sig}`;
}

function verifyMfaChallenge(challenge: string): string | null {
  const parts = challenge.split('.');
  if (parts.length !== 4) return null;
  const [userId, ts, nonce, sig] = parts;
  const expected = createHmac('sha256', config.JWT_SECRET).update(`mfa.${userId}.${ts}.${nonce}`).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
  const age = Date.now() - Number(ts);
  if (age < 0 || age >= MFA_CHALLENGE_TTL_MS) return null;
  return userId;
}

export function registerAuthRoutes(server: FastifyInstance): void {
  /** The tail end of a successful auth (password-only, or password+TOTP): mint a real session and log it. Shared so both paths agree on exactly what "logged in" means. */
  async function issueSession(
    row: { user_id: string; email: string; role: string; kyc_status: string; mfa_enabled: boolean; display_name: string },
    request: FastifyRequest,
  ) {
    const sessionId = newSessionId();
    const token = (server as any).jwt.sign({
      sub: row.user_id,
      email: row.email,
      role: row.role,
      kycStatus: row.kyc_status,
      mfaEnabled: row.mfa_enabled,
      sid: sessionId,
    });
    await createSession(dbPool, sessionId, {
      userId: row.user_id,
      token,
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
      ttlSeconds: config.JWT_EXPIRES_IN_SECONDS,
    });
    await logSecurityAudit(dbPool, {
      userId: row.user_id,
      action: 'LOGIN',
      resource: 'auth',
      ipAddress: request.ip,
      status: 'SUCCESS',
    });
    return {
      token,
      user: { userId: row.user_id, email: row.email, role: row.role, displayName: row.display_name },
    };
  }

  // A far tighter bucket than the global one. Login is the only unauthenticated
  // route that does credential work, so it is where an online password-guessing
  // attempt lands; argon2id verification is also deliberately expensive, which
  // makes this endpoint the cheapest way to burn gateway CPU. Keyed on IP because
  // there is by definition no authenticated subject yet.
  server.post<{
    Body: { email: string; password: string };
  }>('/auth/login', {
    config: {
      rateLimit: {
        max: Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10),
        timeWindow: '1 minute',
        keyGenerator: (request: FastifyRequest) => request.ip,
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body || {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password are required' });
    }

    const res = await dbPool.query(
      `SELECT user_id, email, password_hash, role, display_name, kyc_status, mfa_enabled
         FROM users WHERE email = $1`,
      [email],
    );

    // Same response whether the email is unknown or the password is wrong —
    // distinguishing the two would let a caller enumerate registered emails.
    const invalid = () => reply.status(401).send({ error: 'Invalid email or password' });
    if (res.rowCount === 0) return invalid();

    const row = res.rows[0];
    const valid = await verifyPassword(password, row.password_hash);
    if (!valid) {
      await logSecurityAudit(dbPool, {
        userId: row.user_id,
        action: 'LOGIN_FAILED',
        resource: 'auth',
        ipAddress: request.ip,
        status: 'DENIED',
      });
      return invalid();
    }

    // Password alone is not enough for an MFA-enrolled account. No session is
    // created yet — only a short-lived, single-purpose challenge naming this
    // user, redeemable at POST /auth/mfa/challenge alongside a live TOTP code.
    if (row.mfa_enabled) {
      await logSecurityAudit(dbPool, {
        userId: row.user_id,
        action: 'MFA_CHALLENGE_ISSUED',
        resource: 'auth',
        ipAddress: request.ip,
        status: 'SUCCESS',
      });
      return reply.send({ mfaRequired: true, challenge: signMfaChallenge(row.user_id) });
    }

    return reply.send(await issueSession(row, request));
  });

  // Self-service account creation. There is no email-verification step and
  // no admin/auditor option here on purpose -- those roles stay
  // seed-script-only (see V013's own comment on why there is deliberately no
  // seeded admin). Rate-limited the same bucket as login: it is also
  // unauthenticated and does the same expensive argon2id work.
  server.post<{
    Body: { email: string; password: string; role: 'client' | 'freelancer' };
  }>('/auth/register', {
    config: {
      rateLimit: {
        max: Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10),
        timeWindow: '1 minute',
        keyGenerator: (request: FastifyRequest) => request.ip,
      },
    },
  }, async (request, reply) => {
    const { email, password, role } = request.body || {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password are required' });
    }
    if (role !== 'client' && role !== 'freelancer') {
      return reply.status(400).send({ error: "role must be 'client' or 'freelancer'" });
    }
    if (password.length < 8) {
      return reply.status(400).send({ error: 'password must be at least 8 characters' });
    }

    const existing = await dbPool.query(`SELECT user_id FROM users WHERE email = $1`, [email]);
    if ((existing.rowCount ?? 0) > 0) {
      return reply.status(409).send({ error: 'An account with this email already exists' });
    }

    const userId = randomUUID();
    const passwordHash = await hashPassword(password);
    // kyc_status left at its column default (UNVERIFIED, see V011) --
    // escrow/settle routes already gate on requireKycVerified, so a freshly
    // registered client correctly cannot fund a contract until KYC clears
    // through the existing (separately gapped) verification path.
    const inserted = await dbPool.query(
      `INSERT INTO users (user_id, email, password_hash, role, display_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, email, role, display_name, kyc_status, mfa_enabled`,
      [userId, email, passwordHash, role, email],
    );

    await logSecurityAudit(dbPool, {
      userId,
      action: 'REGISTER',
      resource: 'auth',
      ipAddress: request.ip,
      status: 'SUCCESS',
    });

    return reply.status(201).send(await issueSession(inserted.rows[0], request));
  });

  // The second step of an MFA-gated login: redeem the challenge from
  // POST /auth/login plus a live TOTP code for a real session. Rate-limited
  // the same as login itself — a 6-digit code is guessable given enough
  // attempts, and this is the endpoint that would take them.
  server.post<{
    Body: { challenge: string; code: string };
  }>('/auth/mfa/challenge', {
    config: {
      rateLimit: {
        max: Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10),
        timeWindow: '1 minute',
        keyGenerator: (request: FastifyRequest) => request.ip,
      },
    },
  }, async (request, reply) => {
    const { challenge, code } = request.body || {};
    if (!challenge || !code) {
      return reply.status(400).send({ error: 'challenge and code are required' });
    }

    const userId = verifyMfaChallenge(challenge);
    if (!userId) {
      return reply.status(401).send({ error: 'Invalid or expired challenge' });
    }

    let valid: boolean;
    try {
      valid = await verifyActiveCode(dbPool, userId, code, config.MFA_SECRET_ENCRYPTION_KEY);
    } catch (err) {
      if (err instanceof MfaNotEnabledError) {
        // Account had MFA disabled between login and this call — the challenge
        // names a state that no longer exists, not a wrong code.
        return reply.status(401).send({ error: 'MFA is no longer enabled for this account' });
      }
      throw err;
    }

    if (!valid) {
      await logSecurityAudit(dbPool, {
        userId,
        action: 'MFA_CHALLENGE_FAILED',
        resource: 'auth',
        ipAddress: request.ip,
        status: 'DENIED',
      });
      return reply.status(401).send({ error: 'Invalid code' });
    }

    const res = await dbPool.query(
      `SELECT user_id, email, role, display_name, kyc_status, mfa_enabled FROM users WHERE user_id = $1`,
      [userId],
    );
    if (res.rowCount === 0) return reply.status(401).send({ error: 'Invalid or expired challenge' });

    return reply.send(await issueSession(res.rows[0], request));
  });

  // Real revocation: the session named in the caller's own token is marked
  // revoked, so that exact token (and any other request presenting it) is
  // rejected by auth.ts's isSessionActive check from this point on — not just
  // discarded client-side, which was this route's entire effect before.
  server.post('/auth/logout', async (request, reply) => {
    const user = (request as any).user as AuthUser | undefined;
    if (user) {
      await revokeSession(dbPool, user.sessionId);
      await logSecurityAudit(dbPool, {
        userId: user.userId,
        action: 'LOGOUT',
        resource: 'auth',
        ipAddress: request.ip,
        status: 'SUCCESS',
      });
    }
    return reply.send({ success: true });
  });

  server.get('/auth/me', async (request, reply) => {
    const user = (request as any).user as AuthUser | undefined;
    if (!user) {
      // Reached only via a valid x-service-token, which has no user identity.
      return reply.send({ authenticated: false, serviceCaller: true });
    }
    // The JWT doesn't carry display_name (it wasn't needed at sign time), so
    // this is the one auth route that reads the database rather than the token.
    const res = await dbPool.query(
      `SELECT u.display_name, u.payout_account_id,
              EXISTS (
                SELECT 1 FROM auth_providers ap
                 WHERE ap.user_id = u.user_id
                   AND ap.provider_type = 'GITHUB'
                   AND ap.access_token_encrypted IS NOT NULL
              ) AS github_connected
         FROM users u WHERE u.user_id = $1`,
      [user.userId],
    );
    return reply.send({
      authenticated: true,
      userId: user.userId,
      email: user.email,
      role: user.role,
      kycStatus: user.kycStatus,
      displayName: res.rows[0]?.display_name ?? user.email,
      githubConnected: res.rows[0]?.github_connected ?? false,
      payoutAccountId: res.rows[0]?.payout_account_id ?? null,
    });
  });

  // ── MFA (TOTP) ───────────────────────────────────────────────────────────
  // Always registered, unlike GitHub OAuth below — MFA is core auth, not an
  // opt-in integration, so it does not depend on any external app being
  // configured.

  server.post('/auth/mfa/enroll', async (request, reply) => {
    const user = (request as any).user as AuthUser | undefined;
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });

    try {
      const { secret, otpauthUri } = await startEnrollment(dbPool, user.userId, user.email, config.MFA_SECRET_ENCRYPTION_KEY);
      return reply.send({ secret, otpauthUri });
    } catch (err) {
      if (err instanceof MfaAlreadyEnabledError) {
        return reply.status(409).send({ error: 'MFA is already enabled; disable it first to re-enroll' });
      }
      throw err;
    }
  });

  // Activates the secret POST /auth/mfa/enroll just handed back. Until this
  // succeeds once, the pending secret gates nothing — login stays
  // password-only, since users.mfa_enabled is only flipped here.
  server.post<{ Body: { code: string } }>('/auth/mfa/verify', async (request, reply) => {
    const user = (request as any).user as AuthUser | undefined;
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });

    const { code } = request.body || {};
    if (!code) return reply.status(400).send({ error: 'code is required' });

    try {
      const ok = await verifyEnrollment(dbPool, user.userId, code, config.MFA_SECRET_ENCRYPTION_KEY);
      if (!ok) return reply.status(401).send({ error: 'Invalid code' });
      await logSecurityAudit(dbPool, {
        userId: user.userId,
        action: 'MFA_ENABLED',
        resource: 'auth',
        ipAddress: request.ip,
        status: 'SUCCESS',
      });
      return reply.send({ success: true });
    } catch (err) {
      if (err instanceof MfaNotPendingError) {
        return reply.status(409).send({ error: 'No pending MFA enrollment; call /auth/mfa/enroll first' });
      }
      throw err;
    }
  });

  // Requires a live code, not just an authenticated session — a stolen session
  // token is exactly what MFA exists to blunt, and letting that same token
  // silently turn MFA back off would undo the point.
  server.post<{ Body: { code: string } }>('/auth/mfa/disable', async (request, reply) => {
    const user = (request as any).user as AuthUser | undefined;
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });

    const { code } = request.body || {};
    if (!code) return reply.status(400).send({ error: 'code is required' });

    let valid: boolean;
    try {
      valid = await verifyActiveCode(dbPool, user.userId, code, config.MFA_SECRET_ENCRYPTION_KEY);
    } catch (err) {
      if (err instanceof MfaNotEnabledError) {
        return reply.status(409).send({ error: 'MFA is not enabled' });
      }
      throw err;
    }
    if (!valid) return reply.status(401).send({ error: 'Invalid code' });

    await disableMfa(dbPool, user.userId);
    await logSecurityAudit(dbPool, {
      userId: user.userId,
      action: 'MFA_DISABLED',
      resource: 'auth',
      ipAddress: request.ip,
      status: 'SUCCESS',
    });
    return reply.send({ success: true });
  });

  // ── GitHub OAuth (freelancer login + repo connection) ───────────────────
  //
  // Opt-in: only registered when GITHUB_CLIENT_ID is configured, so a
  // deployment that never sets it keeps running password-only login untouched
  // (see the conditional assertProductionSecrets check in context.ts).
  if (config.GITHUB_CLIENT_ID) {
    const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
    const EXCHANGE_CODE_TTL_MS = 60 * 1000;
    const githubCallbackUrl = `${config.GATEWAY_URL}/auth/github/callback`;

    // CSRF guard for the redirect round-trip to GitHub: an HMAC over a random
    // nonce + timestamp, keyed on JWT_SECRET (already a required, always-set
    // secret — no new key needed just to sign a short-lived nonce).
    //
    // Optionally carries the *currently authenticated* user's id through the
    // round-trip (link mode) -- GitHub's redirect back to our callback has no
    // Authorization header, so this signed state is the only way the callback
    // can know "attach this GitHub identity to the account that was already
    // logged in," as opposed to plain login mode (no linkUserId), where the
    // callback resolves whichever account the GitHub identity matches. The
    // HMAC is what makes this trustworthy -- only this server could have
    // produced a state naming that user, so no server-side session storage is
    // needed for it.
    function signState(linkUserId?: string): string {
      const nonce = randomUUID();
      const ts = Date.now().toString();
      const payload = `${nonce}.${ts}.${linkUserId ?? ''}`;
      const sig = createHmac('sha256', config.JWT_SECRET).update(payload).digest('base64url');
      return `${payload}.${sig}`;
    }

    function verifyState(state: string): { valid: boolean; linkUserId: string | null } {
      const invalid = { valid: false, linkUserId: null };
      const parts = state.split('.');
      if (parts.length !== 4) return invalid;
      const [nonce, ts, linkUserId, sig] = parts;
      const expected = createHmac('sha256', config.JWT_SECRET).update(`${nonce}.${ts}.${linkUserId}`).digest('base64url');
      const sigBuf = Buffer.from(sig);
      const expectedBuf = Buffer.from(expected);
      if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return invalid;
      const age = Date.now() - Number(ts);
      if (age < 0 || age >= OAUTH_STATE_TTL_MS) return invalid;
      return { valid: true, linkUserId: linkUserId || null };
    }

    // The callback redirects into the SPA rather than handing back a JWT
    // directly — a token in a redirect URL lands in browser history, the
    // Referer header of whatever loads next, and server access logs. This
    // short-TTL signed code stands in for a one-time code without needing a
    // new storage table: it is a capability to fetch (not itself) the session
    // JWT, valid for 60s, which POST /auth/github/exchange redeems below.
    function signExchangeCode(userId: string): string {
      const ts = Date.now().toString();
      const nonce = randomUUID();
      const payload = `${userId}.${ts}.${nonce}`;
      const sig = createHmac('sha256', config.JWT_SECRET).update(payload).digest('base64url');
      return `${payload}.${sig}`;
    }

    // Matchmaking visibility for any GitHub-connected freelancer, regardless
    // of *when* they connected -- not just one created fresh by this
    // callback (isNewUser). A freelancer who registers via /auth/register
    // first and links GitHub afterward (link mode) hits the
    // existingUser/linkToUserId branches below, never isNewUser, and would
    // otherwise never get a freelancer_profiles row at all: checking
    // existence directly, rather than inferring it from which branch just
    // ran, covers GitHub-first signup, register-then-link, and reconnect
    // (already has a row -> no-op) uniformly.
    //
    // freelancer_profiles.profile_embedding is NOT NULL with no default
    // (tools/seed-users.py always computes a real one), so a row can't be
    // inserted without calling out to ai-service's embedder. Best-effort --
    // a failure here still leaves a working login, just not yet
    // matchmaking-visible via skill search (contracts-lifecycle.ts's /match
    // route separately guarantees GitHub-connected freelancers show up
    // regardless of skills once this row exists at all).
    async function ensureFreelancerProfile(userId: string, displayName: string, githubLogin: string | null): Promise<void> {
      const existing = await dbPool.query(`SELECT 1 FROM freelancer_profiles WHERE freelancer_id = $1`, [userId]);
      if ((existing.rowCount ?? 0) > 0) return;

      try {
        const profileText = `${displayName} (GitHub: ${githubLogin ?? userId})`;
        const embedRes = await fetch(`${aiServiceUrl}/embed`, {
          method: 'POST',
          headers: serviceCallHeaders(),
          body: JSON.stringify({ text: profileText }),
          signal: AbortSignal.timeout(10_000),
        });
        if (embedRes.ok) {
          const { vector } = (await embedRes.json()) as { vector: number[] };
          await dbPool.query(
            `INSERT INTO freelancer_profiles (freelancer_id, skills, profile_text, profile_embedding)
             VALUES ($1, $2, $3, $4::vector)
             ON CONFLICT (freelancer_id) DO NOTHING`,
            [userId, [], profileText, `[${vector.join(',')}]`],
          );
        } else {
          logger.warn({ userId, status: embedRes.status }, 'ai-service /embed non-OK; freelancer_profiles row not created');
        }
      } catch (err) {
        logger.warn({ userId, err }, 'Failed to create freelancer_profiles row for GitHub-connected freelancer (non-blocking)');
      }
    }

    function verifyExchangeCode(code: string): string | null {
      const parts = code.split('.');
      if (parts.length !== 4) return null;
      const [userId, ts, nonce, sig] = parts;
      const expected = createHmac('sha256', config.JWT_SECRET).update(`${userId}.${ts}.${nonce}`).digest('base64url');
      const sigBuf = Buffer.from(sig);
      const expectedBuf = Buffer.from(expected);
      if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
      const age = Date.now() - Number(ts);
      if (age < 0 || age >= EXCHANGE_CODE_TTL_MS) return null;
      return userId;
    }

    server.get('/auth/github', async (_request, reply) => {
      const params = new URLSearchParams({
        client_id: config.GITHUB_CLIENT_ID!,
        // No 'public_repo' scope: repos are now org-provisioned by
        // AssureCode's own credential (see settlement-worker's
        // github-provisioner-client), so this connection only needs enough
        // to identify who the freelancer is, not access to their own repos.
        scope: 'read:user user:email',
        state: signState(),
        redirect_uri: githubCallbackUrl,
      });
      return reply.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
    });

    // The authenticated counterpart to /auth/github above: called by the
    // freelancer dashboard's "Connect GitHub" button (already logged in) so
    // the callback links the new identity to *this* account instead of
    // resolving to whichever account that GitHub identity happens to match
    // (which could silently log the caller into someone else's account, as
    // /auth/github's plain-link/no-session design would). Returns the
    // authorize URL as JSON rather than redirecting directly, because the
    // caller needs the current bearer token attached to reach this route at
    // all -- a plain `<a href>` navigation can't carry an Authorization
    // header, so the frontend fetches this first, then navigates the browser
    // to the URL it returns.
    server.get('/auth/github/link-url', async (request, reply) => {
      const user = (request as any).user as AuthUser | undefined;
      if (!user) return reply.status(401).send({ error: 'Unauthorized' });

      const params = new URLSearchParams({
        client_id: config.GITHUB_CLIENT_ID!,
        scope: 'read:user user:email',
        state: signState(user.userId),
        redirect_uri: githubCallbackUrl,
      });
      return reply.send({ url: `https://github.com/login/oauth/authorize?${params.toString()}` });
    });

    server.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      '/auth/github/callback',
      async (request, reply) => {
        const { code, state, error } = request.query;
        const stateResult = state ? verifyState(state) : { valid: false, linkUserId: null };
        if (error || !code || !state || !stateResult.valid) {
          return reply.redirect(`${config.WEB_APP_URL}/?error=github_oauth_failed`);
        }
        const linkToUserId = stateResult.linkUserId;

        try {
          const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              client_id: config.GITHUB_CLIENT_ID,
              client_secret: config.GITHUB_CLIENT_SECRET,
              code,
              redirect_uri: githubCallbackUrl,
            }),
          });
          const tokenJson: any = await tokenRes.json();
          const accessToken: string | undefined = tokenJson?.access_token;
          if (!accessToken) {
            logger.error({ tokenJson }, 'GitHub OAuth token exchange failed');
            return reply.redirect(`${config.WEB_APP_URL}/?error=github_oauth_failed`);
          }

          const ghHeaders = { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'assurecode-api-gateway', Accept: 'application/vnd.github+json' };
          const ghUserRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
          const ghUser: any = await ghUserRes.json();
          if (!ghUser?.id) {
            logger.error({ ghUser }, 'GitHub /user call failed during OAuth callback');
            return reply.redirect(`${config.WEB_APP_URL}/?error=github_oauth_failed`);
          }

          let email: string | undefined = ghUser.email ?? undefined;
          if (!email) {
            const emailsRes = await fetch('https://api.github.com/user/emails', { headers: ghHeaders });
            const emails: any[] = await emailsRes.json().catch(() => []) as any[];
            email = (Array.isArray(emails) ? emails.find((e) => e.primary)?.email ?? emails[0]?.email : undefined) ?? undefined;
          }
          if (!email) {
            logger.error({ githubLogin: ghUser.login }, 'GitHub account has no accessible email');
            return reply.redirect(`${config.WEB_APP_URL}/?error=github_no_email`);
          }

          const providerUserId = String(ghUser.id);
          const displayName: string = ghUser.name || ghUser.login || email;

          // Link mode: attach this GitHub identity to the account that was
          // already logged in when "Connect GitHub" was clicked. Never falls
          // through to the email-match-onto-a-different-account path login
          // mode uses below -- that path is exactly what silently swapped a
          // freelancer into someone else's account when their browser
          // already had an active GitHub session for a different identity.
          if (linkToUserId) {
            const existingProvider = await dbPool.query(
              `SELECT user_id FROM auth_providers WHERE provider_type = 'GITHUB' AND provider_user_id = $1`,
              [providerUserId],
            );
            if ((existingProvider.rowCount ?? 0) > 0 && existingProvider.rows[0].user_id !== linkToUserId) {
              logger.warn(
                { linkToUserId, conflictingUserId: existingProvider.rows[0].user_id },
                'GitHub identity already linked to a different account; refusing to swap the caller\'s session',
              );
              return reply.redirect(`${config.WEB_APP_URL}/?error=github_already_linked`);
            }

            const encryptedToken = config.GITHUB_TOKEN_ENCRYPTION_KEY
              ? (await dbPool.query(`SELECT pgp_sym_encrypt($1, $2) AS enc`, [accessToken, config.GITHUB_TOKEN_ENCRYPTION_KEY])).rows[0].enc
              : null;

            await dbPool.query(
              `INSERT INTO auth_providers (user_id, provider_type, provider_user_id, access_token_encrypted, token_scopes, github_login, token_valid, connected_at)
               VALUES ($1, 'GITHUB', $2, $3, $4, $5, TRUE, now())
               ON CONFLICT (provider_type, provider_user_id) DO UPDATE
                 SET access_token_encrypted = EXCLUDED.access_token_encrypted,
                     token_scopes = EXCLUDED.token_scopes,
                     github_login = EXCLUDED.github_login,
                     token_valid = TRUE,
                     connected_at = now()`,
              [linkToUserId, providerUserId, encryptedToken, tokenJson.scope ?? null, ghUser.login ?? null],
            );
            await dbPool.query(`UPDATE users SET display_name = $2 WHERE user_id = $1`, [linkToUserId, displayName]);
            await ensureFreelancerProfile(linkToUserId, displayName, ghUser.login ?? null);

            await logSecurityAudit(dbPool, {
              userId: linkToUserId,
              action: 'GITHUB_LINKED',
              resource: 'auth',
              ipAddress: request.ip,
              status: 'SUCCESS',
            });

            // Already authenticated -- no exchange code to redeem, just
            // return to the app. The caller's existing session is untouched.
            return reply.redirect(`${config.WEB_APP_URL}/`);
          }

          const client = await dbPool.connect();
          let userId: string;
          try {
            await client.query('BEGIN');

            const existingProvider = await client.query(
              `SELECT user_id FROM auth_providers WHERE provider_type = 'GITHUB' AND provider_user_id = $1`,
              [providerUserId],
            );

            if ((existingProvider.rowCount ?? 0) > 0) {
              userId = existingProvider.rows[0].user_id;
              // Keep the shown name in sync with GitHub on every login -- it
              // was only ever set once at row-creation time otherwise, so a
              // renamed/re-mapped GitHub identity would keep showing a stale
              // name indefinitely.
              await client.query(`UPDATE users SET display_name = $2 WHERE user_id = $1`, [userId, displayName]);
            } else {
              const existingUser = await client.query(`SELECT user_id FROM users WHERE email = $1`, [email]);
              if ((existingUser.rowCount ?? 0) > 0) {
                userId = existingUser.rows[0].user_id;
                await client.query(`UPDATE users SET display_name = $2 WHERE user_id = $1`, [userId, displayName]);
              } else {
                userId = randomUUID();
                // Sentinel password_hash: no argon2 hash will ever verify
                // against it, matching the 'unusable-no-login' convention
                // V012 already established for accounts with no password.
                await client.query(
                  `INSERT INTO users (user_id, email, password_hash, role, display_name)
                   VALUES ($1, $2, 'unusable-no-login', 'freelancer', $3)`,
                  [userId, email, displayName],
                );
              }
            }

            const encryptedToken = config.GITHUB_TOKEN_ENCRYPTION_KEY
              ? (await client.query(`SELECT pgp_sym_encrypt($1, $2) AS enc`, [accessToken, config.GITHUB_TOKEN_ENCRYPTION_KEY])).rows[0].enc
              : null;

            await client.query(
              `INSERT INTO auth_providers (user_id, provider_type, provider_user_id, access_token_encrypted, token_scopes, github_login, token_valid, connected_at)
               VALUES ($1, 'GITHUB', $2, $3, $4, $5, TRUE, now())
               ON CONFLICT (provider_type, provider_user_id) DO UPDATE
                 SET access_token_encrypted = EXCLUDED.access_token_encrypted,
                     token_scopes = EXCLUDED.token_scopes,
                     github_login = EXCLUDED.github_login,
                     token_valid = TRUE,
                     connected_at = now()`,
              [userId, providerUserId, encryptedToken, tokenJson.scope ?? null, ghUser.login ?? null],
            );

            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }

          // Covers a brand-new GitHub-first signup and the existingUser
          // email-match branch above (a password account that never
          // connected GitHub before) uniformly -- see ensureFreelancerProfile's
          // own header for why "does a row exist" is checked directly rather
          // than inferred from which branch just ran.
          await ensureFreelancerProfile(userId, displayName, ghUser.login ?? null);

          await logSecurityAudit(dbPool, {
            userId,
            action: 'LOGIN',
            resource: 'auth',
            ipAddress: request.ip,
            status: 'SUCCESS',
          });

          return reply.redirect(`${config.WEB_APP_URL}/auth/github/callback?code=${signExchangeCode(userId)}`);
        } catch (err: any) {
          logger.error({ err: err?.message }, 'GitHub OAuth callback failed');
          return reply.redirect(`${config.WEB_APP_URL}/?error=github_oauth_failed`);
        }
      },
    );

    server.post<{ Body: { code?: string } }>('/auth/github/exchange', async (request, reply) => {
      const { code } = request.body || {};
      if (!code) return reply.status(400).send({ error: 'code is required' });

      const userId = verifyExchangeCode(code);
      if (!userId) return reply.status(401).send({ error: 'Invalid or expired code' });

      const res = await dbPool.query(
        `SELECT user_id, email, role, display_name, kyc_status, mfa_enabled FROM users WHERE user_id = $1`,
        [userId],
      );
      if (res.rowCount === 0) return reply.status(401).send({ error: 'Invalid or expired code' });

      const row = res.rows[0];
      const sessionId = newSessionId();
      const token = (server as any).jwt.sign({
        sub: row.user_id,
        email: row.email,
        role: row.role,
        kycStatus: row.kyc_status,
        mfaEnabled: row.mfa_enabled,
        sid: sessionId,
      });
      await createSession(dbPool, sessionId, {
        userId: row.user_id,
        token,
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
        ttlSeconds: config.JWT_EXPIRES_IN_SECONDS,
      });

      return reply.send({
        token,
        user: { userId: row.user_id, email: row.email, role: row.role, displayName: row.display_name },
      });
    });

    // Lists the caller's own GitHub repos, using their stored OAuth token —
    // never the shared GITHUB_TOKEN, which is scoped to already-linked public
    // repos only, not to "what can this freelancer see."
    server.get('/api/github/repos', async (request, reply) => {
      const user = (request as any).user as AuthUser | undefined;
      if (!user) return reply.status(401).send({ error: 'Unauthorized' });
      if (!config.GITHUB_TOKEN_ENCRYPTION_KEY) {
        return reply.status(503).send({ error: 'GitHub repo listing is not configured on this deployment' });
      }

      const tokenRow = await dbPool.query(
        `SELECT pgp_sym_decrypt(access_token_encrypted, $2) AS token
           FROM auth_providers WHERE user_id = $1 AND provider_type = 'GITHUB' AND access_token_encrypted IS NOT NULL`,
        [user.userId, config.GITHUB_TOKEN_ENCRYPTION_KEY],
      );
      if (tokenRow.rowCount === 0) {
        return reply.status(404).send({ error: 'No connected GitHub account for this user' });
      }
      const token: string = tokenRow.rows[0].token;

      try {
        const reposRes = await fetch('https://api.github.com/user/repos?per_page=100&sort=pushed', {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'assurecode-api-gateway', Accept: 'application/vnd.github+json' },
        });
        if (!reposRes.ok) {
          logger.warn({ userId: user.userId, status: reposRes.status }, 'GitHub /user/repos call failed');
          return reply.status(502).send({ error: 'Failed to list GitHub repositories' });
        }
        const repos = await reposRes.json() as any[];
        return reply.send(repos.map((r) => ({ name: r.name, full_name: r.full_name, private: r.private })));
      } catch (err) {
        logger.warn({ userId: user.userId, err }, 'GitHub /user/repos call threw');
        return reply.status(502).send({ error: 'Failed to list GitHub repositories' });
      }
    });

    // Drives the freelancer dashboard's connection badge (Not connected /
    // Connected / Reconnection required). RECONNECTION_REQUIRED means a
    // repo-provisioning attempt hit a 404 "unknown user" adding this
    // freelancer's github_login as a collaborator — the identity on file has
    // gone stale (renamed/deleted GitHub account) and needs reconnecting.
    server.get('/api/freelancer/github-status', async (request, reply) => {
      const user = (request as any).user as AuthUser | undefined;
      if (!user) return reply.status(401).send({ error: 'Unauthorized' });

      const res = await dbPool.query(
        `SELECT github_login, token_valid FROM auth_providers WHERE user_id = $1 AND provider_type = 'GITHUB'`,
        [user.userId],
      );
      if (res.rowCount === 0) {
        return reply.send({ status: 'NOT_CONNECTED' });
      }
      const row = res.rows[0];
      return reply.send({
        status: row.token_valid ? 'CONNECTED' : 'RECONNECTION_REQUIRED',
        githubLogin: row.github_login,
      });
    });
  }
}
