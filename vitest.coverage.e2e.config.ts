import { defineConfig } from 'vitest/config';

/**
 * Integration coverage — `npm run test:coverage:e2e`, run from scripts/e2e.mjs.
 *
 * The sibling `vitest.coverage.config.ts` measures the packages only, and says
 * why: most app suites are `describe.skipIf(!PG_UP)`, so including them would
 * make the number a function of whether Postgres happened to be up. That
 * reasoning was right, and it still is — for a gate that has to hold on a bare
 * clone with no Docker.
 *
 * This file is the other half. It runs inside the e2e harness, where Postgres,
 * Redis, Neo4j and LocalStack are guaranteed present, so the app suites
 * actually execute and the application tier can be measured honestly. Two
 * configs rather than one because they answer different questions:
 *
 *   vitest.coverage.config.ts      "what is covered anywhere, by anyone"
 *   vitest.coverage.e2e.config.ts  "what is covered when the system is real"
 *
 * Collapsing them would mean either an infra-free gate that cannot see the
 * application tier, or a gate that fails on a laptop with Docker closed.
 *
 * NOT named vitest.config.ts, for the same reason the sibling is not: vitest
 * walks up to the repository root looking for a config, so a root
 * `vitest.config.ts` is inherited by every workspace and its `include`
 * overrides theirs. Loaded only via an explicit `--config`.
 */
export default defineConfig({
  // Resolve @assurecode/* to source rather than to dist.
  //
  // Without this the number is wrong in a way that flatters nothing and
  // confuses everything. Each package's own suite imports its files by relative
  // path (`../src/secrets.js`), so those show real coverage — but every app and
  // every sibling package imports `@assurecode/config`, whose `main` is
  // `./dist/index.js`. The instrumented file is `packages/config/src/index.ts`,
  // which is therefore never loaded, so 278 lines of code that runs on every
  // single request reported 0%.
  //
  // Aliasing to source makes the report describe the code that actually ran.
  // Confined to this config: the unit-test path keeps consuming dist, which is
  // what the published packages are.
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
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // The golden path is run separately by scripts/e2e.mjs, after the Python
      // services are up and with EVENT_BUS_FORCE_REAL set. Running it here too
      // would start a second gateway on a second port against the same
      // database, and the two would race over the same contract rows.
      'test/golden-path.e2e.test.ts',
    ],
    // App suites talk to real Postgres and Redis, and several wait on events
    // crossing the bus. The default 5s is a unit-test budget.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One worker. These suites share a database, and several assert on rows
    // they inserted by contract id — parallel files interleave migrations,
    // seeds and cleanup against the same tables.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // apps/web is absent by construction: it is .jsx and has no test script,
      // so a `.ts` glob does not reach it. Stated rather than left to be
      // rediscovered — it is the one workspace with no tests at all.
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage-e2e',
      thresholds: {
        // Measured 2026-08-23: st 67.38 / br 71.66 / fn 79.57 / ln 67.38 over
        // 450 tests. Set a couple of points below measured — see the note in
        // vitest.coverage.config.ts on why a gate flush against the current
        // number is one that gets deleted.
        //
        // Short of the plan's 70% target, and the gap is almost entirely one
        // file: apps/api-gateway/src/server.ts is ~2,700 lines at ~34%, which
        // is a third of the whole codebase by statement count. Reaching 70%
        // means route tests there, not adjustments here.
        //
        // Note this number is *lower* than the packages-only gate (71.95%)
        // because it includes the application tier, which the other config
        // excludes. They measure different things on purpose.
        statements: 65,
        branches: 69,
        functions: 77,
        lines: 65,
      },
    },
  },
});
