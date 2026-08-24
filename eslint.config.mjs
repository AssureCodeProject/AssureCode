/**
 * ESLint flat config.
 *
 * The CI job was called `lint-and-test` but ran no linter, and no ESLint
 * config existed anywhere in the repository. Ruff was already configured for
 * both Python services and simply never invoked; this is the missing half for
 * the TypeScript and JavaScript workspaces.
 *
 * Deliberately narrow. The point of turning a linter on in an existing
 * codebase is to catch new mistakes, not to generate a few thousand findings
 * that get suppressed wholesale on the first run. Rules here are limited to
 * things that are almost always bugs; style is left alone.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    // Build output, dependencies, and the Python virtualenv that sits inside
    // apps/ai-service.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.venv/**',
      '**/coverage/**',
      'apps/web/dist/**',
      // Runtime artifacts, not source. `storage_fallback` is where the
      // artifact store writes when S3 is unavailable, so it fills up with
      // LLM-generated Jest suites — several of which are not even valid
      // JavaScript. Linting model output tells us nothing about this
      // codebase. Matched at any depth: there is one at the repo root and
      // another under apps/ai-service.
      '**/storage_fallback/**',
      '**/*.egg-info/**',
      '**/__pycache__/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // ── Downgraded to warnings ────────────────────────────────────────
      // The codebase leans on `any` at library boundaries where plugin types
      // and the hoisted fastify version disagree — see the explanatory
      // comments in apps/api-gateway/src/middleware/auth.ts. Those casts are
      // deliberate and documented, so this is a warning rather than a gate.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Unused function arguments are common in Fastify handlers with fixed
      // signatures, e.g. `(_request, reply)`. Underscore-prefixed names are
      // the existing convention for that.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],

      // An empty catch is how this codebase writes "this failure is
      // expected and ignorable" — see the URL parse guard at
      // apps/api-gateway/src/server.ts:87. An empty `if` or loop body is
      // still an error, since that is nearly always an accident.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // ── Kept as errors: these are bugs, not style ─────────────────────
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',

      // `require-atomic-updates` was tried here and removed. Its only hits
      // were six reports in tools/benchmark.js, where each concurrent worker
      // mutates a `row` object it exclusively owns — the rule cannot see
      // that ownership and flags every post-await assignment. All six were
      // false positives, and a rule that only ever fires falsely trains
      // people to ignore the linter.
    },
  },

  {
    // The web app is plain JSX with no TypeScript, and runs in a browser.
    // AssureCode-FrontEnd/ is a second, separate browser app — not an npm
    // workspace member, but still lint-checked, so it needs the same globals.
    files: ['apps/web/**/*.{js,jsx}', 'AssureCode-FrontEnd/src/**/*.{js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Vite injects the React runtime; `React` need not be in scope.
      'no-undef': 'off',
    },
  },

  {
    // Test files use vitest globals in some suites.
    files: ['**/test/**/*.{ts,js}', '**/*.test.{ts,js}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    // CommonJS by design: these are preloaded into the sandbox child via
    // --require and are outside every TypeScript program.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // `require()` is the entire point of these files. egress-guard.cjs is
      // loaded with --require before the sandboxed module graph exists, so
      // it cannot be ESM.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
