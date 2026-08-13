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
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  STRIPE_SECRET_KEY: 'sk_test_mock',
};

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--')) ?? 'all';
const keep = args.includes('--keep');
const skipPython = args.includes('--no-python');

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

function main() {
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

  // --include-workspace-root=false so the root's own `test` script is not
  // re-entered recursively.
  failures += run('Running JS/TS suites', 'npm', [
    'run',
    'test',
    '--workspaces',
    '--if-present',
    '--include-workspace-root=false',
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

  if (!keep) composeDown();
  else console.log('\n\x1b[33m! Stack left running (--keep).\x1b[0m Tear down: npm run test:e2e:down');

  if (failures > 0) {
    console.error(`\n\x1b[31m✗ ${failures} suite group(s) failed.\x1b[0m`);
    process.exit(1);
  }
  console.log('\n\x1b[32m✓ test:e2e green.\x1b[0m');
}

main();
