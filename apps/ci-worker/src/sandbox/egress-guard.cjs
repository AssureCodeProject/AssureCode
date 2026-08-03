/**
 * Egress guard — preloaded into the sandbox child before any untrusted code.
 *
 * Node's permission model (`--permission`) covers the filesystem, child
 * processes, native addons, and worker threads, but it does not gate outbound
 * network access. This closes that gap by removing the transports themselves.
 *
 * Why each piece is needed, and why they are not redundant:
 *
 *   - `Module._load` intercepts CommonJS `require`.
 *   - `registerHooks` intercepts ESM `import`. This must be the synchronous,
 *     in-thread variant: the async `module.register()` spawns a worker thread,
 *     which `--permission` denies (correctly — a worker would be an escape
 *     route around these very hooks).
 *   - `fetch` and friends are globals, reachable without importing anything.
 *   - `process.binding` is a legacy path straight to the C++ layer that
 *     bypasses the module system entirely.
 *
 * The guard is only sound in combination with the flags in
 * node-permission-sandbox.ts. Without `--allow-child-process` and
 * `--allow-worker` withheld, untrusted code could simply spawn an unguarded
 * process. The negative tests in test/sandbox-isolation.test.ts assert every
 * one of these routes stays closed.
 */
'use strict';

const DENIED_PATTERN = /^(node:)?(net|tls|dgram|http|https|http2|dns|inspector)(\/|$)/;

function denied(specifier) {
  const err = new Error(`EGRESS_DENIED: '${specifier}' is not available inside the sandbox`);
  err.code = 'EGRESS_DENIED';
  return err;
}

// ── CommonJS require ────────────────────────────────────────────
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (DENIED_PATTERN.test(request)) throw denied(request);
  return originalLoad.apply(this, arguments);
};

// ── ESM import ──────────────────────────────────────────────────
// registerHooks is synchronous and in-thread (Node >= 22.15). module.register()
// would need a worker thread, which the permission flags deny.
if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (DENIED_PATTERN.test(specifier)) throw denied(specifier);
      return nextResolve(specifier, context);
    },
  });
} else {
  throw new Error(
    'This Node build lacks module.registerHooks(), so ESM imports of network ' +
      'modules cannot be blocked in-thread. Refusing to run untrusted code ' +
      'under an isolation guarantee that would not hold. Node >= 22.15 required.',
  );
}

// ── globals ─────────────────────────────────────────────────────
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
  Object.defineProperty(globalThis, name, {
    configurable: false,
    writable: false,
    value: () => {
      throw denied(name);
    },
  });
}

// ── legacy internal binding escape hatch ────────────────────────
if (typeof process.binding === 'function') {
  Object.defineProperty(process, 'binding', {
    configurable: false,
    writable: false,
    value: (name) => {
      throw denied(`process.binding(${name})`);
    },
  });
}
