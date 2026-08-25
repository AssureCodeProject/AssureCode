/**
 * AssureCode integration test harness (plan2.md task 9.1).
 *
 * Brings up an isolated data plane (infra/docker-compose.test.yml), migrates and
 * seeds it, runs the suites against it, and tears it down.
 *
 * Why this exists: 16 of the JS/TS tests and the entire gateway integration
 * surface call `postgresAvailable()` and `describe.skipIf(!PG_UP)`. On a machine
 * with no database that reports as a pass with a skip notice, which is how
 * plan2.md tasks 6.3 and 6.4 came to be marked complete without their stated
 * verification ever having run. This script is the missing half: it makes the
 * services actually present, so those suites execute instead of announcing that
 * they cannot.
 *
 * Usage:
 *   npm run test:e2e              # up -> migrate -> seed -> test -> down
 *   npm run test:e2e -- --keep    # leave the stack running for debugging
 *   npm run test:e2e -- --no-python
 *   npm run test:e2e:up           # just bring the stack up
 *   npm run test:e2e:down         # just tear it down
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(repoRoot, 'infra', 'docker-compose.test.yml');

/**
 * Its own compose project, so `down` cannot reach the dev stack's containers or
 * volumes. The dev stack uses the default project name derived from the
 * directory; sharing it would make a test teardown delete a developer's data.
 */
const PROJECT = 'assurecode-e2e';

const PORTS = {
  postgres: process.env.TEST_POSTGRES_PORT ?? '55432',
  redis: process.env.TEST_REDIS_PORT ?? '56379',
  neo4jBolt: process.env.TEST_NEO4J_BOLT_PORT ?? '57687',
  localstack: process.env.TEST_LOCALSTACK_PORT ?? '54566',
  // The two Python services, started as host processes by startAppServices().
  // 58xxx rather than 8000/8001 so a dev stack can stay up during a test run.
  aiService: process.env.TEST_AI_SERVICE_PORT ?? '58000',
  scopeGuard: process.env.TEST_SCOPE_GUARD_PORT ?? '58001',
};

/**
 * The environment the suites run under.
 *
 * Every one of these is set explicitly rather than left to a default, because
 * @assurecode/config's loadDotEnv() reads the repo-root .env — where
 * DATABASE_URL currently points at a shared remote Postgres. An integration run
 * that inherited that would migrate, seed, and write test rows into a live
 * database. loadDotEnv() never overwrites an already-set variable, so setting
 * them here is what keeps the run inside the disposable stack.
 */
const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: `postgresql://assurecode:assurecode_test@127.0.0.1:${PORTS.postgres}/assurecode_test`,
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: PORTS.postgres,
  POSTGRES_USER: 'assurecode',
  POSTGRES_PASSWORD: 'assurecode_test',
  POSTGRES_DB: 'assurecode_test',
  REDIS_URL: `redis://127.0.0.1:${PORTS.redis}`,
  EVENT_BUS_TYPE: 'redis',
  NEO4J_URI: `bolt://127.0.0.1:${PORTS.neo4jBolt}`,
  NEO4J_USER: 'neo4j',
  NEO4J_PASSWORD: 'assurecode_test',
  S3_ENDPOINT: `http://127.0.0.1:${PORTS.localstack}`,
  S3_BUCKET_NAME: 'assurecode-artifacts',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  // Deterministic test credentials. The suites authenticate as a machine caller
  // with SERVICE_TOKEN (see tools/test-support/infra.ts serviceAuthHeaders).
  JWT_SECRET: 'e2e_jwt_secret_not_for_production',
  SERVICE_TOKEN: 'e2e_service_token_not_for_production',
  // Not an `rzp_` key, so createRazorpayAdapter() selects FakeRazorpayAdapter
  // and the escrow flow runs without touching Razorpay's API.
  RAZORPAY_KEY_ID: 'rzp_test_mock',
  RAZORPAY_KEY_SECRET: 'e2e_razorpay_secret_not_for_production',
  RAZORPAY_WEBHOOK_SECRET: 'e2e_razorpay_webhook_secret_not_for_production',
  // Where the Node side reaches the Python services started by
  // startAppServices(). Without these the gateway would fall back to its
  // localhost:8000 default and hit whatever a developer happens to be running.
  AI_SERVICE_URL: `http://127.0.0.1:${PORTS.aiService}`,
  SCOPE_GUARD_URL: `http://127.0.0.1:${PORTS.scopeGuard}`,
};

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--')) ?? 'all';
const keep = args.includes('--keep');
const skipPython = args.includes('--no-python');
// The golden path needs both Python services and a real Redis bus; this is
// the switch for running the rest of the suite without them.
const skipGolden = args.includes('--no-golden') || skipPython;

const isWindows = process.platform === 'win32';

function run(label, cmd, cmdArgs, opts = {}) {
  process.stdout.write(`\n\x1b[1m▸ ${label}\x1b[0m\n`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, ...TEST_ENV, ...(opts.env ?? {}) },
    ...opts,
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.status ?? 1;
}

function mustRun(label, cmd, cmdArgs, opts) {
  const status = run(label, cmd, cmdArgs, opts);
  if (status !== 0) {
    console.error(`\n\x1b[31m✗ ${label} failed (exit ${status})\x1b[0m`);
    if (!keep) composeDown();
    process.exit(status);
  }
}

const compose = (...rest) => ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...rest];

function composeUp() {
  // --wait blocks until every service reports healthy, which is what makes the
  // migration step below safe to run immediately. Without it compose returns as
  // soon as the containers are created and the first connection races Postgres
  // initdb.
  mustRun('Starting test stack', 'docker', compose('up', '-d', '--wait', '--wait-timeout', '180'));
}

function composeDown() {
  run('Tearing down test stack', 'docker', compose('down', '-v', '--remove-orphans'));
}

function dockerAvailable() {
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 10000,
    shell: isWindows,
  });
  return probe.status === 0;
}

/** The venv interpreter for a Python app, or null if it was never created. */
function venvPython(app) {
  const candidate = isWindows
    ? path.join(repoRoot, 'apps', app, '.venv', 'Scripts', 'python.exe')
    : path.join(repoRoot, 'apps', app, '.venv', 'bin', 'python');
  return existsSync(candidate) ? candidate : null;
}

/**
 * The Python services, run as host processes for the golden-path suite.
 *
 * Deliberately not in infra/docker-compose.test.yml — that file is the data
 * plane and its header says so. Running these from the working tree means the
 * suite exercises the code in front of you, not a possibly-stale image.
 *
 * NODE_ENV is deliberately NOT 'test' for them: under test, app/deps.py swaps
 * in the in-memory RAG store and ledger anchor, and the golden path needs the
 * Postgres-backed ones so /xai/score reads the scope decisions the run actually
 * produced.
 *
 * EMBED_PROVIDER is deliberately NOT 'fake' either, which is less obvious.
 * app/deps.py keys three separate adapters off that one flag: `fake` selects
 * FakeEmbedder *and* InMemoryRagStore (get_rag_store) *and* InMemoryArtifactStore.
 * The consequence is invisible until you look for it — POST /rag/ingest answers
 * `200 {"chunks_stored": 2}` while nothing reaches rag_embeddings, so the scope
 * guard then refuses every message for want of an indexed contract, and
 * ci-worker cannot fetch the test bundle it was told was stored, so the sandbox
 * reports 0/0 and no contract can ever settle. The real embedder costs a model
 * load; it is the only way this path is exercised rather than simulated.
 */
const appProcesses = [];

/**
 * True once all-MiniLM-L6-v2 is already on disk in the Hugging Face cache.
 *
 * SentenceTransformer(...) hits the Hub over the network to check the cached
 * snapshot is current even when every file it needs is already local — that
 * "unauthenticated requests to the HF Hub" round-trip is what turned a
 * supposedly-cached model load into a 245s stall in CI (the actual weight
 * load off disk takes under a second). HF_HUB_OFFLINE=1 skips that check
 * entirely, but only once the cache is known to hold the model — set
 * unconditionally, it would break a first-ever run (fresh clone, empty
 * cache) with a hard failure instead of a slow-but-working download.
 */
function hfModelCached() {
  return existsSync(
    path.join(
      process.env.HF_HOME ?? path.join(homedir(), '.cache', 'huggingface'),
      'hub',
      'models--sentence-transformers--all-MiniLM-L6-v2',
    ),
  );
}

function pythonServiceEnv() {
  return {
    ...process.env,
    ...TEST_ENV,
    NODE_ENV: 'development',
    // Real embedder — see the note above on why 'fake' breaks persistence.
    EMBED_PROVIDER: 'sentence-transformers',
    ...(hfModelCached() ? { HF_HUB_OFFLINE: '1' } : {}),
    // The LLM is safe to fake: LLM_PROVIDER selects only the client, and the
    // deterministic stand-in still exercises the Layer 2 code path so
    // securityScanComplete becomes true and the oracle's security signal can
    // actually be satisfied.
    LLM_PROVIDER: 'fake',
    // This stack's LocalStack bucket is best-effort (see createBucket), so the
    // documented local fallback is what keeps test generation failing on logic
    // rather than on storage.
    ALLOW_LOCAL_ARTIFACT_FALLBACK: 'true',
  };
}

async function waitForReady(name, url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      // 200 or 503 both mean the process is serving. 503 only says a dependency
      // is unhappy, and the suite itself reports that far more usefully.
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(`\n\x1b[31m✗ ${name} was not ready within ${timeoutMs / 1000}s.\x1b[0m`);
  return false;
}

/** Returns true when both services are up; false means skip the golden path. */
async function startAppServices() {
  const specs = [
    { app: 'ai-service', port: PORTS.aiService },
    { app: 'scope-guard', port: PORTS.scopeGuard },
  ];

  for (const { app, port } of specs) {
    const py = venvPython(app);
    if (!py) {
      console.warn(
        `\n\x1b[33m! Not starting ${app}\x1b[0m — apps/${app}/.venv not found.` +
          '\n  The golden-path suite will be skipped, not silently passed.',
      );
      return false;
    }

    console.log(`\n\x1b[1m▸ Starting ${app} on :${port}\x1b[0m`);
    const child = spawn(
      py,
      [
        '-m',
        'uvicorn',
        'app.main:app',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--log-level',
        'warning',
      ],
      {
        cwd: path.join(repoRoot, 'apps', app),
        env: pythonServiceEnv(),
        stdio: 'inherit',
      },
    );
    appProcesses.push({ app, child });
  }

  // /readyz, not /healthz: both services build their real embedder lazily on
  // first use (app/ports/embedder.py), and /healthz is deliberately
  // dependency-free liveness only — it would report "ready" before that load
  // has even started. Waiting on /readyz (which now forces and reports on the
  // embedder load, see app/ports/readiness.py's check_embedder) means the
  // golden-path test's first real request never lands on the one that would
  // otherwise pay for a cold model load or Hugging Face download.
  for (const { app, port } of specs) {
    if (!(await waitForReady(app, `http://127.0.0.1:${port}/readyz`))) return false;
  }
  return true;
}

function stopAppServices() {
  for (const { app, child } of appProcesses) {
    if (child.exitCode === null && !child.killed) {
      console.log(`\x1b[2m  stopping ${app}\x1b[0m`);
      child.kill('SIGTERM');
    }
  }
  appProcesses.length = 0;
}

function createBucket() {
  // LocalStack starts empty; the artifact store expects its bucket to exist.
  // Non-fatal: the S3 path has a documented local-directory fallback
  // (S3_FALLBACK_DIR, task 6.6), so a missing bucket degrades rather than fails.
  const status = run(
    'Creating S3 bucket',
    'docker',
    compose('exec', '-T', 'localstack', 'awslocal', 's3', 'mb', 's3://assurecode-artifacts'),
  );
  if (status !== 0) {
    console.warn('  (bucket creation failed — S3 tests will use the local fallback)');
  }
}

async function main() {
  if (!dockerAvailable()) {
    console.error(
      '\n\x1b[31mDocker is not responding.\x1b[0m This harness runs real Postgres, Redis,\n' +
        'Neo4j and LocalStack containers — there is no mock mode, by design.\n' +
        'Start Docker Desktop and try again.',
    );
    process.exit(1);
  }

  if (command === 'down') {
    composeDown();
    return;
  }

  if (command === 'up') {
    composeUp();
    console.log(`\n\x1b[32m✓ Test stack up.\x1b[0m Postgres :${PORTS.postgres}  Redis :${PORTS.redis}  Neo4j :${PORTS.neo4jBolt}  S3 :${PORTS.localstack}`);
    console.log(`  DATABASE_URL=${TEST_ENV.DATABASE_URL}`);
    console.log('  Tear down with: npm run test:e2e:down');
    return;
  }

  composeUp();
  createBucket();

  // Built dist/ is a real dependency of the suites: the tests import the app
  // sources, but those import @assurecode/* from dist/.
  mustRun('Building workspaces', 'node', ['scripts/build-workspaces.mjs']);
  mustRun('Applying migrations', 'npx', ['tsx', 'tools/migrate.ts']);
  mustRun('Seeding Neo4j', 'npx', ['tsx', 'tools/seed-neo4j.ts']);

  const aiPython = venvPython('ai-service');
  if (aiPython && !skipPython) {
    // Seeds users + freelancer_profiles (with embeddings) into the test DB.
    mustRun('Seeding users', aiPython, ['tools/seed-users.py']);
  } else {
    console.warn(
      '\n\x1b[33m! Skipping user seed\x1b[0m — apps/ai-service/.venv not found.' +
        '\n  Matchmaking-dependent assertions will have no profiles to rank.',
    );
  }

  let failures = 0;

  // One pass over every JS/TS suite — packages *and* apps — with coverage.
  //
  // This replaces a bare `npm run test --workspaces`. Same suites, same
  // assertions; the difference is that the app tier is measured, which it
  // cannot be outside this harness: those suites are `describe.skipIf(!PG_UP)`,
  // so on a machine with no database they report as skipped and contribute
  // nothing. That is exactly why the infra-free gate
  // (vitest.coverage.config.ts) covers only packages, and why this second
  // config exists.
  failures += run('Running JS/TS suites with coverage', 'npm', [
    'run',
    'test:coverage:e2e',
  ]) === 0
    ? 0
    : 1;

  if (!skipPython) {
    for (const app of ['ai-service', 'scope-guard']) {
      const py = venvPython(app);
      if (!py) {
        console.warn(`\n\x1b[33m! Skipping ${app} pytest\x1b[0m — apps/${app}/.venv not found.`);
        continue;
      }
      failures +=
        run(`Running ${app} pytest`, py, ['-m', 'pytest', 'tests', '-q'], {
          cwd: path.join(repoRoot, 'apps', app),
        }) === 0
          ? 0
          : 1;
    }
  }

  // ── Golden path ───────────────────────────────────────────────────────
  //
  // The suites above are unit and integration tests of individual pieces
  // against real infrastructure. This is the only thing that drives a contract
  // through the whole lifecycle — initialize, lock, push, audit, score, settle
  // — and asserts the ledger and settlement state at the end. It needs the
  // Python services, because the trust score has no fallback: /score answers
  // 502 when the scorer is unreachable, by design.
  if (!skipGolden) {
    const servicesUp = await startAppServices();
    if (servicesUp) {
      failures +=
        run('Running golden-path suite', 'npx', [
          'vitest',
          'run',
          'test/golden-path.e2e.test.ts',
        ], {
          // The one place a real bus is wanted inside a test process: the
          // gateway and both workers are imported together and must share it.
          env: { ...process.env, ...TEST_ENV, EVENT_BUS_FORCE_REAL: 'true' },
        }) === 0
          ? 0
          : 1;
    } else {
      console.warn(
        '\n\x1b[33m! Golden path skipped\x1b[0m — the Python services did not start.' +
          '\n  This is a SKIP, not a pass.',
      );
    }
    stopAppServices();
  }

  if (!keep) composeDown();
  else console.log('\n\x1b[33m! Stack left running (--keep).\x1b[0m Tear down: npm run test:e2e:down');

  if (failures > 0) {
    console.error(`\n\x1b[31m✗ ${failures} suite group(s) failed.\x1b[0m`);
    process.exit(1);
  }
  console.log('\n\x1b[32m✓ test:e2e green.\x1b[0m');
}

main().catch((err) => {
  console.error(err);
  stopAppServices();
  process.exit(1);
});
