/**
 * @assurecode/api-gateway — JWT authentication guard.
 *
 * packages/rbac.ts already expected `(request as any).user: AuthUser` to be
 * populated by something upstream — `requireRole` and `requireKycVerified`
 * have been dead code since they were written because nothing ever set it.
 * This is that something: an onRequest hook that verifies a bearer JWT (or a
 * SERVICE_TOKEN for machine callers) and decorates the request the way rbac.ts
 * already assumes.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type pg from 'pg';
import type { AuthUser } from './rbac.js';
import { isSessionActive } from './session-store.js';

/**
 * Paths a request can reach with no credential at all: liveness/readiness/
 * metrics probes (an orchestrator has no user session), and the two
 * machine-to-machine webhooks, which authenticate by HMAC signature over the
 * raw body rather than by user identity — putting them behind a user JWT
 * would make Razorpay and GitHub unable to call us at all.
 */
const PUBLIC_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/auth/login',
  // The second half of an MFA-gated login: the caller holds a short-lived
  // challenge from /auth/login, not a session — there is nothing to verify a
  // bearer token against yet.
  '/auth/mfa/challenge',
  // GitHub OAuth's whole point is standing in for a session that doesn't
  // exist yet: /github kicks off the redirect, /github/callback is GitHub
  // calling back with no JWT of ours to present, and /github/exchange trades
  // the short-lived signed code the callback minted for the real session JWT.
  '/auth/github',
  '/auth/github/callback',
  '/auth/github/exchange',
]);
const PUBLIC_PREFIXES = ['/webhooks/'];

function isPublicPath(url: string): boolean {
  const path = url.split('?')[0];
  if (PUBLIC_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * The two WebSocket routes (`/api/contracts/:id/chat/stream`,
 * `/api/audits/:id/stream`) are reached via the browser's native WebSocket
 * API, which cannot set an Authorization header — there is no hook for it in
 * the spec. They accept the JWT as a `?token=` query parameter instead, same
 * as the connection URL itself, and only these two paths honor it: a query
 * param can end up in access logs or a Referer header, so the fallback stays
 * off everywhere a header is a viable option.
 */
function isStreamPath(url: string): boolean {
  return url.split('?')[0].endsWith('/stream');
}

export interface JwtPayload {
  sub: string; // user_id
  email: string;
  role: AuthUser['role'];
  kycStatus: AuthUser['kycStatus'];
  mfaEnabled: boolean;
  /** Names the user_sessions row this token was issued under — see session-store.ts. */
  sid: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    jwt: {
      sign: (payload: JwtPayload) => string;
      verify: (token: string) => JwtPayload;
    };
  }
  interface FastifyRequest {
    jwtVerify: () => Promise<JwtPayload>;
  }
}

/**
 * Both calls are synchronous registrations on the root instance — matching
 * the existing `void server.register(fastifyCors, ...)` pattern in server.ts
 * rather than awaiting `.register()`, which returns the chainable instance,
 * not a boot-completion promise; the real completion signal is `.ready()`,
 * which Fastify calls internally before dispatching the first request.
 */
export function registerAuth(
  server: FastifyInstance,
  jwtSecret: string,
  serviceToken: string,
  pool: pg.Pool,
  jwtExpiresInSeconds: number,
): void {
  // @fastify/jwt's published types resolve against a different structural
  // shape of FastifyInstance than this workspace's hoisted fastify version
  // exposes (an npm workspace hoisting artifact, not a real incompatibility —
  // the plugin registers and runs correctly). Cast at the boundary rather
  // than fight the type resolution.
  //
  // `sign.expiresIn` as a plain number is seconds (fast-jwt's convention —
  // see JWT_EXPIRES_IN_SECONDS's comment in packages/config). Before this,
  // no expiry was set at all: a token was valid until whoever held it lost
  // it, which is the same problem revocation exists to solve, from the other
  // direction.
  void server.register(fastifyJwt as any, { secret: jwtSecret, sign: { expiresIn: jwtExpiresInSeconds } });

  server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicPath(request.url)) return;

    // Machine callers (CI harnesses, benchmark/verify scripts) authenticate
    // with a shared token instead of a user session — there is no human to
    // log in as when `tools/benchmark.js` hits the gateway from a cron job.
    const serviceHeader = request.headers['x-service-token'];
    if (serviceHeader && serviceHeader === serviceToken) {
      (request as any).user = undefined;
      (request as any).isServiceCaller = true;
      return;
    }

    let payload: JwtPayload;
    try {
      if (isStreamPath(request.url)) {
        const queryToken = (request.query as Record<string, unknown> | undefined)?.token;
        const authHeader = request.headers.authorization;
        const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
        const token = bearer ?? (typeof queryToken === 'string' ? queryToken : undefined);
        if (!token) throw new Error('no token');
        payload = (server as any).jwt.verify(token) as JwtPayload;
      } else {
        payload = await request.jwtVerify();
      }

      // A cryptographically valid, unexpired JWT is not the same claim as "the
      // session it names is still active" — this is the actual revocation
      // check. A stolen token that has not yet hit its `exp` still fails here
      // the moment its session is logged out. Fails closed: a DB error is not
      // distinguishable from "revoked" to the caller.
      if (!(await isSessionActive(pool, payload.sid))) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'This session has been revoked or has expired.' });
      }

      (request as any).user = {
        userId: payload.sub,
        email: payload.email,
        role: payload.role,
        kycStatus: payload.kycStatus,
        mfaEnabled: payload.mfaEnabled,
        sessionId: payload.sid,
      } satisfies AuthUser;
    } catch {
      return reply.status(401).send({ error: 'Unauthorized', message: 'A valid Authorization bearer token or x-service-token header is required.' });
    }
  });
}

/** argon2id hash for storage in users.password_hash. */
export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, { algorithm: 2 /* argon2id */ });
}

/** Constant-time-safe verify against a stored argon2id PHC string. */
export function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return argon2Verify(storedHash, password).catch(() => false);
}
