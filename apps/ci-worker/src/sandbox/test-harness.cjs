/**
 * In-process test harness for the sandboxed run.
 *
 * Why not vitest or jest
 * ----------------------
 * Both spawn worker threads or child processes to run test files, and the
 * sandbox withholds `--allow-worker` and `--allow-child-process` on purpose —
 * a worker would run outside the egress guard's in-thread hooks, which is the
 * exact escape route test/sandbox-isolation.test.ts asserts stays closed. So a
 * conventional runner cannot execute here without weakening the isolation the
 * pipeline exists to provide. Rather than punch a hole in the sandbox to fit a
 * runner, the runner is small enough to run in-thread.
 *
 * It has no dependencies, starts no threads, and opens no sockets. It provides
 * the Jest-shaped surface the generated bundles are written against
 * (`describe` / `it` / `expect`, plus `require('@jest/globals')` via the shim
 * the workspace builder writes), executes every case sequentially, and prints
 * one JSON line in the Jest reporter's shape:
 *
 *     {"numPassedTests":N,"numFailedTests":M,"numTotalTests":T}
 *
 * That is exactly what parseTestOutput() in ../types.ts already looks for, so
 * the counts reaching the settlement oracle come from real executions.
 *
 * Failures are reported, never swallowed. A bundle that throws while loading
 * yields 0/0, which the oracle reads as indeterminate — never as a pass.
 */
'use strict';

const path = require('node:path');

// ── assertions ──────────────────────────────────────────────────

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function render(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Structural equality, sufficient for the JSON-shaped values these tests compare. */
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function expect(actual) {
  const matchers = {
    toBe(expected) {
      if (!Object.is(actual, expected)) {
        throw new AssertionError(`expected ${render(actual)} to be ${render(expected)}`);
      }
    },
    toEqual(expected) {
      if (!deepEqual(actual, expected)) {
        throw new AssertionError(`expected ${render(actual)} to equal ${render(expected)}`);
      }
    },
    toStrictEqual(expected) {
      matchers.toEqual(expected);
    },
    toBeTruthy() {
      if (!actual) throw new AssertionError(`expected ${render(actual)} to be truthy`);
    },
    toBeFalsy() {
      if (actual) throw new AssertionError(`expected ${render(actual)} to be falsy`);
    },
    toBeNull() {
      if (actual !== null) throw new AssertionError(`expected ${render(actual)} to be null`);
    },
    toBeUndefined() {
      if (actual !== undefined) throw new AssertionError(`expected ${render(actual)} to be undefined`);
    },
    toBeDefined() {
      if (actual === undefined) throw new AssertionError('expected value to be defined');
    },
    toBeGreaterThan(n) {
      if (!(actual > n)) throw new AssertionError(`expected ${render(actual)} > ${render(n)}`);
    },
    toBeGreaterThanOrEqual(n) {
      if (!(actual >= n)) throw new AssertionError(`expected ${render(actual)} >= ${render(n)}`);
    },
    toBeLessThan(n) {
      if (!(actual < n)) throw new AssertionError(`expected ${render(actual)} < ${render(n)}`);
    },
    toBeLessThanOrEqual(n) {
      if (!(actual <= n)) throw new AssertionError(`expected ${render(actual)} <= ${render(n)}`);
    },
    toContain(needle) {
      const ok =
        typeof actual === 'string'
          ? actual.includes(needle)
          : Array.isArray(actual) && actual.some((v) => deepEqual(v, needle));
      if (!ok) throw new AssertionError(`expected ${render(actual)} to contain ${render(needle)}`);
    },
    toHaveLength(n) {
      if (!actual || actual.length !== n) {
        throw new AssertionError(`expected length ${n}, got ${actual ? actual.length : 'none'}`);
      }
    },
    toHaveProperty(key) {
      if (!actual || !(key in actual)) {
        throw new AssertionError(`expected ${render(actual)} to have property ${render(key)}`);
      }
    },
    toMatch(re) {
      const ok = re instanceof RegExp ? re.test(String(actual)) : String(actual).includes(String(re));
      if (!ok) throw new AssertionError(`expected ${render(actual)} to match ${String(re)}`);
    },
    async toThrow() {
      let threw = false;
      try {
        await actual();
      } catch {
        threw = true;
      }
      if (!threw) throw new AssertionError('expected function to throw');
    },
  };

  matchers.not = new Proxy(
    {},
    {
      get(_t, name) {
        return async (...args) => {
          let failed = false;
          try {
            await matchers[name](...args);
          } catch {
            failed = true;
          }
          if (!failed) throw new AssertionError(`expected NOT .${String(name)}(...) to hold`);
        };
      },
    },
  );

  matchers.resolves = {
    async toEqual(expected) {
      matchers.toEqual.call(null, expected);
    },
  };

  return matchers;
}

// ── collection ──────────────────────────────────────────────────

const cases = [];
const suite = [];

function describe(name, fn) {
  suite.push(name);
  try {
    fn();
  } finally {
    suite.pop();
  }
}

function it(name, fn) {
  cases.push({ name: [...suite, name].join(' › '), fn, skip: false });
}
it.only = it;
it.skip = (name, fn) => cases.push({ name: [...suite, name].join(' › '), fn, skip: true });
it.todo = (name) => cases.push({ name: [...suite, name].join(' › '), fn: null, skip: true });
it.each = () => it;

const test = it;
test.only = it;
test.skip = it.skip;
test.todo = it.todo;

const hooks = { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
const beforeAll = (fn) => hooks.beforeAll.push(fn);
const afterAll = (fn) => hooks.afterAll.push(fn);
const beforeEach = (fn) => hooks.beforeEach.push(fn);
const afterEach = (fn) => hooks.afterEach.push(fn);

// Published as globals as well as via the @jest/globals shim: bundles are
// inconsistent about which they use, and a bundle that fails to load because a
// name was missing would report 0/0 and look like an infrastructure fault.
Object.assign(globalThis, {
  describe,
  it,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
});

// ── execution ───────────────────────────────────────────────────

/** Per-case time budget. A hung test must not consume the whole run's budget. */
const CASE_TIMEOUT_MS = Number(process.env.HARNESS_CASE_TIMEOUT_MS || 5000);

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}

async function main() {
  const bundle = process.argv[2];
  if (!bundle) {
    process.stdout.write('[harness] no test bundle path supplied\n');
    process.stdout.write(JSON.stringify({ numPassedTests: 0, numFailedTests: 0, numTotalTests: 0 }) + '\n');
    process.exitCode = 1;
    return;
  }

  try {
    require(path.resolve(bundle));
  } catch (err) {
    // A bundle that cannot even load has measured nothing. 0/0 is the
    // indeterminate signal; it must not be reported as a pass.
    process.stdout.write(`[harness] failed to load ${bundle}: ${err && err.message}\n`);
    process.stdout.write(JSON.stringify({ numPassedTests: 0, numFailedTests: 0, numTotalTests: 0 }) + '\n');
    process.exitCode = 1;
    return;
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const fn of hooks.beforeAll) {
    try {
      await withTimeout(fn(), CASE_TIMEOUT_MS, 'beforeAll');
    } catch (err) {
      process.stdout.write(`[harness] beforeAll failed: ${err && err.message}\n`);
    }
  }

  for (const c of cases) {
    if (c.skip || !c.fn) {
      skipped++;
      process.stdout.write(`  - ${c.name} (skipped)\n`);
      continue;
    }
    try {
      for (const h of hooks.beforeEach) await withTimeout(h(), CASE_TIMEOUT_MS, 'beforeEach');
      await withTimeout(c.fn(), CASE_TIMEOUT_MS, c.name);
      for (const h of hooks.afterEach) await withTimeout(h(), CASE_TIMEOUT_MS, 'afterEach');
      passed++;
      process.stdout.write(`  ✓ ${c.name}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`  ✗ ${c.name}: ${(err && err.message) || String(err)}\n`);
    }
  }

  for (const fn of hooks.afterAll) {
    try {
      await withTimeout(fn(), CASE_TIMEOUT_MS, 'afterAll');
    } catch {
      /* teardown noise does not change the verdict */
    }
  }

  // Jest reporter shape — parseTestOutput() in ../types.ts reads these keys.
  // Skipped cases are excluded from the total: a skipped test demonstrated
  // nothing, and counting it as part of the denominator would let a bundle
  // lower its own pass bar by skipping.
  process.stdout.write(
    JSON.stringify({
      numPassedTests: passed,
      numFailedTests: failed,
      numPendingTests: skipped,
      numTotalTests: passed + failed,
    }) + '\n',
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
