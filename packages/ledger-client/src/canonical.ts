/**
 * Canonical JSON serialization (RFC 8785, JSON Canonicalization Scheme).
 *
 * Why this exists
 * ---------------
 * A hash chain is only tamper-evident if two independent parties can recompute
 * the same hash from the same data. Before this module there were three
 * different serializations in play and no two of them agreed:
 *
 *   V002 append_ledger   sha256( (to_jsonb(payload) || to_jsonb(prev))::text )
 *   verifyChain (SQL)    the same expression again, so it always agreed with
 *                        itself and could never detect a wrong hash
 *   calculateSha256 (JS) sha256( JSON.stringify(payload) + prev )
 *
 * Measured against live PostgreSQL 17.6, the first expression does not do what
 * its comment claims. `jsonb_object || jsonb_scalar` is not "concatenate the
 * text"; PostgreSQL promotes the object to a one-element array and appends the
 * scalar, so the hashed string was:
 *
 *     [{"a": 1, "b": 2}, "GENESIS"]
 *
 * while JavaScript hashed:
 *
 *     {"b":2,"a":1}GENESIS
 *
 * Different bytes, different key order, different structure. The JS fallback in
 * verifyChain could therefore never agree with a row the database wrote — it
 * would have reported tampering on every honest chain, had it ever run.
 *
 * The fix, and why it is this one
 * -------------------------------
 * The canonical form is produced here, in TypeScript, and the exact bytes are
 * what the database hashes and stores. PostgreSQL is not asked to re-serialize
 * anything, so there is no second serializer to disagree with. That removes the
 * hardest part of the problem: replicating PostgreSQL's jsonb text output in
 * JavaScript is not merely fiddly, it is unsound in general, because jsonb
 * normalizes numeric literals in ways no JavaScript number can round-trip.
 *
 * RFC 8785 was chosen over an ad-hoc "sorted keys, no spaces" rule because it
 * is a published specification with test vectors, which matters when the output
 * is what an audit rests on.
 *
 * Scope and limits
 * ----------------
 * This implements the JCS profile that the ledger's payloads actually use:
 * objects, arrays, strings, booleans, null, and numbers that are finite IEEE
 * 754 doubles. It deliberately *throws* rather than coercing for anything else:
 *
 *   * NaN and Infinity have no JSON representation. JSON.stringify silently
 *     emits `null` for them, which would let two different payloads hash
 *     identically — precisely the collision a ledger must not permit.
 *   * `undefined` and functions are dropped by JSON.stringify, so a payload
 *     could lose a field between being hashed and being read back.
 *   * BigInt cannot be represented, and rounding it into a double would change
 *     the value being attested to.
 *
 * Refusing is the correct behaviour: a value that cannot be canonically
 * serialized cannot be anchored, and pretending otherwise anchors something
 * other than what the caller passed.
 *
 * Number formatting follows JCS, which defers to ECMAScript's Number::toString.
 * `JSON.stringify` uses that same algorithm, so `String(n)` is used directly
 * rather than reimplementing the shortest-round-trip conversion. The one
 * divergence JCS requires is that -0 serializes as `0`.
 */

export class NotCanonicalizableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotCanonicalizableError';
  }
}

/**
 * Sort object keys as RFC 8785 requires: by their UTF-16 code units.
 *
 * `Array.prototype.sort()`'s default comparator already compares strings by
 * UTF-16 code unit, but it is written out explicitly here because the default
 * is a coincidence of the specification rather than a documented guarantee for
 * this purpose, and a future reader should not have to know that.
 */
function compareCodeUnits(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

function serializeString(value: string): string {
  // JSON.stringify's string escaping is exactly the JCS rule: escape only what
  // must be escaped, use the two-character forms where they exist, and \u00xx
  // for the remaining control characters.
  return JSON.stringify(value);
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new NotCanonicalizableError(
      `${value} has no JSON representation. JSON.stringify would emit null for it, which would ` +
        'let two different payloads hash to the same value.',
    );
  }
  // JCS: -0 is serialized as 0. String(-0) gives "0" already, but Object.is is
  // used so the intent survives a future refactor of this line.
  if (Object.is(value, -0)) return '0';
  return String(value);
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value);
    case 'string':
      return serializeString(value);
    case 'bigint':
      throw new NotCanonicalizableError(
        `BigInt at ${path} cannot be canonically serialized: JSON has no bigint type, and ` +
          'narrowing it to a double would change the value being anchored.',
      );
    case 'undefined':
      throw new NotCanonicalizableError(
        `undefined at ${path} cannot be canonically serialized. JSON.stringify silently drops ` +
          'it, so the payload that was hashed would not be the payload that was passed.',
      );
    case 'function':
    case 'symbol':
      throw new NotCanonicalizableError(`${typeof value} at ${path} cannot be serialized.`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item, i) => serialize(item, `${path}[${i}]`));
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) {
    // Deliberately refused. JSON.stringify would turn this into an ISO string
    // via toJSON, so the value read back from the database would be a string
    // and would not re-canonicalize to the same thing on verification.
    throw new NotCanonicalizableError(
      `Date at ${path} cannot be canonically serialized. Convert it to a string at the call ` +
        'site, so the payload that is stored is the payload that was hashed.',
    );
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareCodeUnits);
  const members = keys.map(
    (key) => `${serializeString(key)}:${serialize(obj[key], `${path}.${key}`)}`,
  );
  return `{${members.join(',')}}`;
}

/** Canonical RFC 8785 serialization. Throws rather than losing information. */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}
