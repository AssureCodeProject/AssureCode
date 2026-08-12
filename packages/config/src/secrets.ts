/**
 * @assurecode/config — production secret validation.
 *
 * The gateway already refused to boot in production on a dev-default
 * JWT_SECRET or SERVICE_TOKEN, but the check lived inline in server.ts, so it
 * protected exactly one of the five Node services. webhook-ingest, whose
 * GITHUB_WEBHOOK_SECRET fell back to a literal published in this repository,
 * had no equivalent guard at all: a deploy that forgot the env var would
 * happily accept webhooks signed with a secret any reader of the source can
 * compute.
 *
 * This is that check, lifted to the shared package so each service declares
 * which secrets it needs rather than reimplementing the rule.
 *
 * `findInsecureSecrets` is pure so it can be tested without spawning a
 * process; `assertProductionSecrets` is the thin exiting wrapper services
 * actually call at boot.
 */

/**
 * Values that are never acceptable in production because they are public.
 *
 * The three `dev_insecure_*` / `assurecode_github_secret` entries are the
 * schema and code defaults. `REPLACE_ME` is what the tracked Kubernetes
 * manifest ships (infra/k8s/01-configmap-secrets.yaml) — the base manifest is
 * applyable so the CI dry-run passes, and this is what stops it from also
 * being *runnable* if someone forgets the secrets overlay.
 */
export const PLACEHOLDER_SECRET_VALUES: ReadonlySet<string> = new Set([
  'dev_insecure_jwt_secret_change_me',
  'dev_insecure_service_token_change_me',
  'assurecode_github_secret',
  'REPLACE_ME',
  'changeme',
  'change_me',
]);

/**
 * True when a secret is absent, blank, or one of the known public
 * placeholders. Whitespace-only counts as absent: a Kubernetes Secret key
 * with an empty string is a very easy accident, and it authenticates nobody.
 */
export function isPlaceholderSecret(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  return PLACEHOLDER_SECRET_VALUES.has(trimmed);
}

/**
 * Names of the required secrets that are missing or still placeholders.
 * Returns names only — never values, so the result is safe to log.
 */
export function findInsecureSecrets(
  source: Record<string, string | undefined>,
  requiredKeys: readonly string[],
): string[] {
  return requiredKeys.filter((key) => isPlaceholderSecret(source[key]));
}

export interface AssertSecretsOptions {
  /** Skip the check outside production. Defaults to the source's NODE_ENV. */
  nodeEnv?: string;
  /** Where to report the failure. Defaults to console.error. */
  onError?: (message: string) => void;
  /** Called instead of process.exit(1) when the check fails. For tests. */
  onFail?: (missing: string[]) => void;
}

/**
 * Exit the process when any required secret is missing or a known
 * placeholder — but only in production. Development and test runs are
 * expected to use the defaults; that is what makes them runnable without a
 * secrets store.
 *
 * Call this at module scope, before the server starts listening: a service
 * that cannot authenticate its callers should never reach the point of
 * accepting one.
 */
export function assertProductionSecrets(
  source: Record<string, string | undefined>,
  requiredKeys: readonly string[],
  options: AssertSecretsOptions = {},
): void {
  const nodeEnv = options.nodeEnv ?? source.NODE_ENV;
  if (nodeEnv !== 'production') return;

  const missing = findInsecureSecrets(source, requiredKeys);
  if (missing.length === 0) return;

  const report = options.onError ?? ((message: string) => console.error(message));
  report(
    `Refusing to start: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} ` +
      'unset or still set to a placeholder value. These defaults are public in the ' +
      'repository, so anything they authenticate is forgeable. Supply real values ' +
      '(see infra/k8s/overlays/) and restart.',
  );

  if (options.onFail) {
    options.onFail(missing);
    return;
  }
  process.exit(1);
}
