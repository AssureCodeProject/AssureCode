# Security scanning

Local security tooling for AssureCode. Two scanners are wired up; both are run
on demand from the repo root via `npm run`.

## `npm run scan:audit` — npm audit

Runs `npm audit --json`, writes the full report to
`docs/security/npm-audit.json`, and prints a severity breakdown plus the
top 25 advisories to the terminal.

The exit code is non-zero if vulnerabilities are present — wire this into CI
to fail builds on new advisories.

To apply fixes (read the changelog first; `--force` includes breaking changes):

```bash
npm audit fix          # safe fixes only
npm audit fix --force  # includes breaking upgrades
```

## `npm run scan:semgrep` — Semgrep (SAST)

Runs Semgrep with the `p/default` curated ruleset against
`apps/`, `packages/`, `tools/`, and `scripts/`. Fails (exit 1) on any
finding at or above the configured severity.

The wrapper (`tools/scan-semgrep.mjs`) locates the `semgrep` binary
automatically — it checks `PATH` first, then the standard Windows
`pip --user` Scripts dir. No need to add anything to PATH for it to work.

Common invocations:

```bash
npm run scan:semgrep                                    # default ruleset
node tools/scan-semgrep.mjs --config p/owasp-top-ten    # OWASP Top 10
node tools/scan-semgrep.mjs --config p/security-audit   # security audit rules
node tools/scan-semgrep.mjs --config p/typescript       # TS-specific
node tools/scan-semgrep.mjs --config auto               # auto-detect from files
```

Custom rules can be added by dropping YAML into `.semgrep/` at the repo root
and passing `--config .semgrep`.

## First-time Semgrep setup

If Semgrep isn't installed yet:

```bash
pip install --user semgrep
```

This installs to `%APPDATA%\Python\Python313\Scripts\` on Windows. The wrapper
script already searches there, so no further setup is required. If you want
to invoke `semgrep` directly from the shell, add that Scripts dir to your
user PATH.

Verify with:

```bash
node tools/scan-semgrep.mjs --version
```

## CI integration

Suggested gate (add to `.github/workflows/ci.yml` or equivalent):

```yaml
- run: npm ci
- run: npm run scan:audit
- run: npm run scan:semgrep
```

`scan:audit` will fail on any new critical/high advisory; `scan:semgrep` will
fail on any blocking finding. Both are exit-code driven, so a non-zero exit
blocks the pipeline.

## Triage notes

The most recent scan (`docs/security/npm-audit.json`) reports 29 advisories
(1 critical, 7 high, 20 moderate, 1 low). Highlights to address first:

- **postcss ≤ 8.5.17** — path traversal via `sourceMappingURL` (arbitrary
  `.map` file disclosure). Upgrade in apps that build with postcss.
- **fast-uri 3.0.0–3.1.3** — host confusion via backslash authority delimiter
  and failed IDN canonicalization (SSRF class). Pulled by a transitive
  dependency in `@nestjs/common` chain.
- **@babel/core ≤ 7.29.0** — arbitrary file read via `sourceMappingURL`.
- **esbuild ≤ 0.24.2** — dev-server cross-origin request smuggling
  (dev-only impact, but upgrade to silence).
- **multer (transitive)** — file-upload RCE class — one critical, treat as
  urgent.
- **@opentelemetry/* (<2.8.0)** — unbounded memory in W3C Baggage
  propagation. Fix requires bumping OTel SDK to ≥ 0.221 (breaking).

`npm audit fix` resolves the safe subset (postcss, fast-uri, find-my-way,
@babel/core, cookie, cross-spawn, fast-redact, request, validator, etc.).
The OpenTelemetry and esbuild upgrades need `--force` plus a manual review of
the resulting version bumps.
