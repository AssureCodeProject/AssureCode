import { defineConfig } from 'vitest/config';

/**
 * Root coverage configuration — `npm run test:coverage`.
 *
 * Deliberately NOT named `vitest.config.ts`. Each workspace runs its own bare
 * `vitest run`, and vitest walks up to the repository root looking for a
 * config; a root `vitest.config.ts` is therefore inherited by every workspace
 * and its `include` below overrides theirs, so each one finds zero test files
 * and — now that `--passWithNoTests` is gone — fails. This file is loaded only
 * via an explicit `--config`.
 *
 * Scoped deliberately to the pure-logic packages. Those run identically on a
 * bare clone and in CI, so a threshold measured here means the same thing in
 * both places. The app suites are excluded because most of them are
 * `describe.skipIf(!PG_UP)` against live Postgres/Redis: including them would
 * make the coverage number a function of whether infrastructure happened to be
 * up, which is exactly the kind of environment-dependent green this gate exists
 * to prevent. Integration coverage is asserted by `npm run test:e2e` instead.
 *
 * Thresholds are set at the level the suites currently reach, so any drop is a
 * regression rather than a number nobody can hit. Raise them as coverage grows;
 * do not lower them to make a failing run pass.
 */
export default defineConfig({
  // Resolve @assurecode/* to source rather than to dist. Same fix, same
  // reasoning, as vitest.coverage.e2e.config.ts: a package's own suite
  // imports its files relatively (`../src/secrets.js`) and shows real
  // coverage, but a *sibling* package importing e.g. `@assurecode/config`
  // resolves to `./dist/index.js` — the instrumented `src/index.ts` never
  // loads, so code that runs on every request reports 0%. This was fixed for
  // the e2e config but not this one, which is what the CI coverage gate
  // actually runs — hence packages/config/src/index.ts and
  // packages/telemetry/src/{index,telemetry,tracing}.ts showing 0% despite
  // running under every other package's tests.
  resolve: {
    alias: [
      'config',
      'event-bus',
      'kyc-adapter',
      'ledger-client',
      'oracle',
      'razorpay-adapter',
      'shared',
      'telemetry',
    ].map((name) => ({
      find: `@assurecode/${name}`,
      replacement: new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname.replace(
        /^\/([A-Za-z]:)/,
        '$1',
      ),
    })),
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // shared and telemetry used to be excluded because neither had any
      // tests; both do now, so they count toward the number.
      exclude: ['**/dist/**', '**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        // packages/oracle — the settlement gate — is held at the level it
        // actually reaches (100/96.55/100/100), far above the aggregate,
        // because it is the code path that releases money. It should never
        // regress; the aggregate is allowed to lag while other packages catch
        // up.
        'packages/oracle/src/**': {
          statements: 100,
          branches: 95,
          functions: 100,
          lines: 100,
        },
        // Measured 2026-08-25: st 71.51 / br 84.19 / fn 77.23 / ln 71.51 —
        // after adding the resolve.alias above (previously only present in
        // the e2e config), which fixed packages/config/src/index.ts and
        // packages/telemetry/src/{index,telemetry}.ts silently reporting 0%
        // despite running under every other package's tests, and after
        // deleting two dead files (packages/config/src/correlation.ts and
        // packages/telemetry/src/tracing.ts — exact duplicates of the real
        // ones in packages/telemetry, unreferenced by any index.ts barrel,
        // confirmed via a repo-wide grep for relative imports before
        // removal). Without those two fixes this gate measured 64.84% in CI
        // (report-only run), well under threshold, for reasons that had
        // nothing to do with a real drop in tested behaviour.
        //
        // `functions` now clears its floor by 0.23 points — the thinnest
        // margin of the four. The next function-heavy addition to
        // event-bus/src/index.ts (65.38% functions) or
        // razorpay-adapter/src/index.ts (67.85%) without a matching test is
        // likely to be what trips this gate next; that is a real regression
        // signal, not gate fragility, and should not be "fixed" by lowering
        // the threshold.
        //
        // The remaining gap is ledger-client/src/index.ts (needs live
        // Postgres) and event-bus/src/index.ts (the Kafka/Redis branches,
        // needs live infra) — both measured honestly by
        // vitest.coverage.e2e.config.ts instead.
        //
        // Raise these as coverage grows; do not lower them to make a failing
        // run pass.
        statements: 70,
        branches: 82,
        functions: 77,
        lines: 70,
      },
    },
  },
});
