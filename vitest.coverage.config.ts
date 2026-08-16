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
        // Measured 2026-08-16: st 50.02 / br 82.89 / fn 57.54 / ln 50.02,
        // after adding suites for packages/shared and packages/telemetry.
        // Set a couple of points below measured, not flush against it. A gate
        // pinned to the exact current number fails the moment anyone adds an
        // uncovered line to an unrelated file — declaring four env vars in
        // packages/config moved this from 45.19 to 45.00 — and a gate that
        // fails for unrelated reasons is one somebody deletes. The margin is
        // small enough to still catch a real regression.
        //
        // The gap is concentrated in ledger-client/src/index.ts (9%) and
        // event-bus/src/outbox-relay.ts (12%), both of which need live
        // Postgres — they are covered by `npm run test:e2e`, not here. Raise
        // these as that changes; do not lower them to make a failing run pass.
        statements: 48,
        branches: 80,
        functions: 55,
        lines: 48,
      },
    },
  },
});
