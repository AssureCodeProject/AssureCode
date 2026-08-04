/**
 * RFC 8785 canonicalization, pinned against the specification's own test
 * vectors plus the properties the ledger depends on.
 *
 * These are hand-computed or taken from RFC 8785 §3.2.3, not from running the
 * implementation and recording what it printed. A test that asserts whatever
 * the code currently does cannot detect the code being wrong.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalize, NotCanonicalizableError } from '../src/canonical.js';
import { chainHash } from '../src/index.js';

describe('canonicalize', () => {
  it('sorts object keys by UTF-16 code unit', () => {
    expect(canonicalize({ b: 2, a: 1, c: 3 })).toBe('{"a":1,"b":2,"c":3}');
  });

  it('sorts recursively, not just at the top level', () => {
    expect(canonicalize({ z: { y: 2, x: 1 }, a: 0 })).toBe('{"a":0,"z":{"x":1,"y":2}}');
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ a: [1, 2], b: 'x' })).toBe('{"a":[1,2],"b":"x"}');
  });

  it('preserves array order, which is significant', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('matches the RFC 8785 §3.2.3 property-ordering vector', () => {
    // Ordering is by UTF-16 code unit: CR (U+000D) < "1" (U+0031) <
    // U+0080 < "€" (U+20AC). This is the case that distinguishes code-unit
    // ordering from a locale-aware or codepoint-name-based sort.
    //
    // Note what is *not* escaped. RFC 8785 §3.2.2.2 defers to ECMAScript's
    // JSON.stringify, which escapes only the control characters, the quote and
    // the backslash — non-ASCII is emitted literally as UTF-8. U+0080 is a
    // C1 control but is above U+001F, so it too is emitted literally.
    const input = { '€': 'Euro Sign', '\r': 'Carriage Return', '1': 'One', '': 'Control' };
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","":"Control","€":"Euro Sign"}',
    );
  });

  it('escapes control characters and quotes as JSON requires', () => {
    expect(canonicalize({ k: 'a"b\\c\nd\te' })).toBe('{"k":"a\\"b\\\\c\\nd\\te"}');
  });

  it('serializes -0 as 0, per JCS', () => {
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
  });

  it('handles booleans, null, and nested empties', () => {
    expect(canonicalize({ t: true, f: false, n: null, e: {}, a: [] })).toBe(
      '{"a":[],"e":{},"f":false,"n":null,"t":true}',
    );
  });

  it('is idempotent: canonicalizing a parsed canonical form reproduces it', () => {
    const once = canonicalize({ b: [{ d: 4, c: 3 }], a: 'x' });
    expect(canonicalize(JSON.parse(once))).toBe(once);
  });

  // ── Refusals ────────────────────────────────────────────────────────
  //
  // Each of these is a case where JSON.stringify silently loses or alters
  // information. In a hash chain that is a collision, so they must throw.

  it('refuses NaN rather than emitting null', () => {
    expect(JSON.stringify({ n: NaN })).toBe('{"n":null}'); // what we must not do
    expect(() => canonicalize({ n: NaN })).toThrow(NotCanonicalizableError);
  });

  it('refuses Infinity', () => {
    expect(() => canonicalize({ n: Infinity })).toThrow(NotCanonicalizableError);
  });

  it('refuses undefined rather than dropping the key', () => {
    expect(JSON.stringify({ a: undefined, b: 1 })).toBe('{"b":1}'); // silently lost
    expect(() => canonicalize({ a: undefined, b: 1 })).toThrow(NotCanonicalizableError);
  });

  it('refuses BigInt rather than narrowing it', () => {
    expect(() => canonicalize({ n: 10n })).toThrow(NotCanonicalizableError);
  });

  it('refuses Date, which would not round-trip through the database', () => {
    expect(() => canonicalize({ d: new Date(0) })).toThrow(NotCanonicalizableError);
  });

  it('names the offending path in the error', () => {
    expect(() => canonicalize({ outer: { inner: [1, undefined] } })).toThrow(/\$\.outer\.inner\[1\]/);
  });

  it('gives key order no effect on the output, which is the whole point', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
});

describe('chainHash', () => {
  it('is SHA256(canonical || LF || previousHash)', () => {
    const canonical = '{"a":1}';
    const prev = 'GENESIS';
    const expected = createHash('sha256').update('{"a":1}\nGENESIS', 'utf8').digest('hex');
    expect(chainHash(canonical, prev)).toBe(expected);
  });

  it('is not the old formula, which agreed with nothing', () => {
    const payload = { a: 1 };
    const old = createHash('sha256').update(JSON.stringify(payload) + 'GENESIS').digest('hex');
    expect(chainHash(canonicalize(payload), 'GENESIS')).not.toBe(old);
  });

  it('separates payload from previous hash unambiguously', () => {
    // Without a delimiter these two would hash identically, because the
    // concatenations are the same byte string.
    const a = chainHash('{"k":"x"}', 'AB');
    const b = chainHash('{"k":"x"}A', 'B');
    expect(a).not.toBe(b);
  });
});
