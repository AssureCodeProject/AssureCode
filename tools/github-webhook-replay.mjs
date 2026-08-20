/**
 * Deliver a signed GitHub push webhook to a local webhook-ingest.
 *
 * GitHub cannot reach localhost, so the push path is the one part of the audit
 * pipeline a developer cannot exercise without a tunnel. This script removes
 * that constraint: it builds the delivery GitHub would send, signs it with
 * GITHUB_WEBHOOK_SECRET exactly as GitHub does (hex HMAC-SHA256 over the raw
 * bytes, in `x-hub-signature-256`), and POSTs it to webhook-ingest.
 *
 * It is a *delivery* mechanism, not a mock. The service verifies the signature
 * for real, resolves the contract through the real Postgres lookup, and
 * publishes a real code.push.received — so a signature bug or an unlinked
 * repository fails here exactly as it would in production. What it cannot tell
 * you is whether the repository's webhook configuration is right; only a tunnel
 * proves that.
 *
 * Usage:
 *   node tools/github-webhook-replay.mjs --repo owner/repo
 *   node tools/github-webhook-replay.mjs --repo owner/repo --sha <40-hex>
 *   node tools/github-webhook-replay.mjs --repo owner/repo --event ping
 *   node tools/github-webhook-replay.mjs --repo owner/repo --deleted
 *
 * Flags:
 *   --repo    <owner/repo>  Required. Matched verbatim against contracts.github_repo_full_name.
 *   --sha     <40-hex>      Commit to report. Defaults to a placeholder, which ci-worker
 *                           will fail to fetch — pass a real one to exercise the audit.
 *   --ref     <ref>         Defaults to refs/heads/main.
 *   --event   <name>        push (default) | ping | any other type, to prove it is ignored.
 *   --deleted               Send a branch deletion (null SHA), which must be ignored.
 *   --secret  <value>       Override the signing secret, to prove a bad one really is a 401.
 *   --url     <url>         webhook-ingest base URL. Defaults to http://localhost:9000.
 */
import crypto from 'node:crypto';
import { loadConfig } from '@assurecode/config';

const config = loadConfig();

// ── Arguments ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

/** GitHub's sentinel for "there is no commit here" — matches server.ts. */
const NULL_SHA = '0'.repeat(40);

const repoFullName = flag('repo');
const eventName = flag('event', 'push');
const ref = flag('ref', 'refs/heads/main');
const sha = has('deleted') ? NULL_SHA : flag('sha', 'a'.repeat(40));
const baseUrl = (flag('url', `http://localhost:${config.WEBHOOK_INGEST_PORT}`) || '').replace(/\/$/, '');

if (!repoFullName || !/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
  console.error('error: --repo must be given as owner/repo (not a URL, not a bare name).\n');
  console.error('It is compared verbatim against the linked repository:');
  console.error('  psql $DATABASE_URL -c "SELECT contract_id, github_repo_full_name FROM contracts WHERE github_repo_full_name IS NOT NULL"');
  console.error('\nLink one with:');
  console.error('  curl -X PATCH $GATEWAY/api/contracts/<id>/github-repo -d \'{"githubRepoFullName":"owner/repo"}\'');
  process.exit(1);
}

// Deliberately allows the default. Unlike the gateway's secrets this one has a
// working dev fallback, and a developer who has not set it should still be able
// to exercise the path rather than be stopped by a config error.
const webhookSecret = flag('secret', config.GITHUB_WEBHOOK_SECRET);

// ── Build the delivery ─────────────────────────────────────────────────

const [owner, repoName] = repoFullName.split('/');

/**
 * The shape GitHub actually posts. `after` and `head_commit.id` are both set
 * because server.ts falls back from one to the other, and a payload that
 * disagreed with itself would test neither branch honestly.
 */
function buildBody() {
  return JSON.stringify({
    ref,
    before: 'b'.repeat(40),
    after: sha,
    deleted: sha === NULL_SHA,
    head_commit:
      sha === NULL_SHA
        ? null
        : { id: sha, message: 'Replayed from tools/github-webhook-replay.mjs' },
    repository: {
      full_name: repoFullName,
      name: repoName,
      clone_url: `https://github.com/${repoFullName}.git`,
      html_url: `https://github.com/${repoFullName}`,
    },
    pusher: { name: owner },
    sender: { login: owner },
  });
}

async function deliver(body) {
  // Sign the exact bytes being sent. Serialising once and reusing the string is
  // the whole point — and it is the same reason the webhook must be set to
  // application/json: a urlencoded body is not the bytes GitHub signed, so
  // every genuine delivery would fail verification.
  const signature = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');

  const res = await fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`,
      'x-github-event': eventName,
      'x-github-delivery': crypto.randomUUID(),
      'User-Agent': 'GitHub-Hookshot/replay',
    },
    body,
  });

  const text = await res.text();
  // 202 accepted a push; 200 is a correct *refusal to act* on a ping or a
  // branch deletion. Both are healthy — GitHub disables a hook that answers
  // its opening ping with anything else.
  const ok = res.status === 202 || res.status === 200;
  console.log(`  ${ok ? '✓' : '✗'} HTTP ${res.status} ${text}`);
  return { ok, status: res.status };
}

// ── Run ────────────────────────────────────────────────────────────────

console.log(`\nDelivering ${eventName} to ${baseUrl}/webhooks/github`);
console.log(`  repo   ${repoFullName}`);
console.log(`  ref    ${ref}`);
console.log(`  commit ${sha}${sha === NULL_SHA ? '  (null SHA — branch deletion)' : ''}\n`);

let result;
try {
  result = await deliver(buildBody());
} catch (err) {
  console.error(`\n✗ Could not reach webhook-ingest at ${baseUrl}: ${err.message}`);
  console.error('  Is it running? `npm run infra:up` or `npm -w @assurecode/webhook-ingest run dev`.');
  process.exit(1);
}

if (!result.ok) {
  console.error('');
  if (result.status === 401) {
    console.error('✗ Signature rejected.');
    console.error('  GITHUB_WEBHOOK_SECRET here differs from the one webhook-ingest loaded.');
    console.error('  Config is read once at boot, and Docker bakes env at container *create*');
    console.error('  time — after editing .env, recreate rather than restart:');
    console.error('    docker compose --env-file .env -f infra/docker-compose.yml up -d --force-recreate webhook-ingest');
  } else if (result.status === 404) {
    console.error(`✗ No contract is linked to ${repoFullName}.`);
    console.error('  Link it first — the repository is the only handle on identity a delivery carries:');
    console.error(`    curl -X PATCH $GATEWAY/api/contracts/<id>/github-repo -d '{"githubRepoFullName":"${repoFullName}"}'`);
  } else if (result.status === 503) {
    console.error('✗ The contract lookup failed — Postgres is unreachable from webhook-ingest.');
    console.error('  It fails closed rather than publish against a guessed contract id.');
  }
  process.exit(1);
}

if (result.status === 200) {
  console.log('\n✓ Correctly ignored. Nothing was published, which is the point.');
  process.exit(0);
}

console.log('\n✓ Accepted and published. Follow it into ci-worker:');
console.log('    docker logs -f assurecode-ci-worker');
console.log('\n  Then confirm the audit landed:');
console.log('    psql $DATABASE_URL -c "SELECT contract_id, created_at FROM audit_results ORDER BY created_at DESC LIMIT 1"');
