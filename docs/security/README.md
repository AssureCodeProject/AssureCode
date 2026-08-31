# Security scanning

Local security tooling for AssureCode.

## `npm run audit` — dependency gate

Runs `scripts/audit-check.mjs`, not a bare `npm audit --json` — a bare gate
had been red on every run for months, which trains everyone to ignore it. This
version: audits **production** dependencies only (`--omit=dev`; dev-tool
advisories are reported but not gated on, since exploiting them needs
attacker-controlled code already running on a developer's machine); fails on
any high/critical production advisory not listed in
`docs/security/audit-exceptions.json`; and fails on an **expired** or
**stale** (no-longer-firing) exception, so an accepted risk has a deadline
instead of being permanent by default. It does not write
`docs/security/npm-audit.json` — that file is a separately-generated,
point-in-time snapshot (see Triage notes below), not this script's output.
Already wired into the `security` job in `production-ci-cd.yml`.

To apply fixes (read the changelog first; `--force` includes breaking changes):

```bash
npm audit fix          # safe fixes only
npm audit fix --force  # includes breaking upgrades
```

## `node tools/scan-semgrep.mjs` — Semgrep (SAST)

Runs Semgrep with the `p/default` curated ruleset against
`apps/`, `packages/`, `tools/`, and `scripts/`. Fails (exit 1) on any
finding at or above the configured severity. **Not currently wired into CI** —
run it locally or add it as a step yourself.

The wrapper locates the `semgrep` binary automatically — it checks `PATH`
first, then the standard Windows `pip --user` Scripts dir. No need to add
anything to PATH for it to work.

Common invocations:

```bash
node tools/scan-semgrep.mjs                             # default ruleset
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

`npm run audit` already runs in the `security` job of
`production-ci-cd.yml`, which `container-build` depends on — a new
unaccepted high/critical production advisory genuinely blocks a merge.
Semgrep is not in that job; add a step running `node tools/scan-semgrep.mjs`
there if you want it gated too.

## Triage notes

A snapshot scan from 2026-07-30 (`docs/security/npm-audit.json`, run by hand
via `npm audit --json`, not by `scripts/audit-check.mjs`) reported 29
advisories (1 critical, 7 high, 20 moderate, 1 low) — a point-in-time
artifact, not live CI output; re-run `npm audit --json > docs/security/npm-audit.json`
to refresh it. Highlights to address first, as of that snapshot:

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
