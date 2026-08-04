#!/usr/bin/env python3
"""Sign a contract's Merkle root with FIPS 204 ML-DSA-87.

The root itself is computed by the TypeScript client (`computeAndStoreRoot`),
which owns the tree construction. This tool does one thing: take the stored
root, sign it, and write the signature back.

Splitting it this way is deliberate. Signing is the only step that touches
private key material, so it is the only step that needs to run wherever that key
lives — which in a real deployment is not the same machine as the API.

    python tools/sign_merkle_root.py <contract_id>
    python tools/sign_merkle_root.py --verify <contract_id>
    python tools/sign_merkle_root.py --show-public-key

Requires ML_DSA_SEED_HEX in .env. It will refuse to run without one rather than
generate a throwaway key — see packages/ledger-client/src/ml_dsa.py.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "packages" / "ledger-client" / "src"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _load_dotenv() -> None:
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

from ml_dsa import ALGORITHM, MlDsaSigner, SigningKeyUnavailable, verify_root  # noqa: E402

CA_BUNDLE = REPO_ROOT / "infra" / "certs" / "supabase-ca-bundle.crt"


def connect():
    import psycopg

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is not set.")

    kwargs: dict[str, object] = {"autocommit": True, "connect_timeout": 10}
    if "supabase.co" in database_url and CA_BUNDLE.exists():
        # Same TLS policy as the rest of the system: verification stays on with
        # the pinned root. Never sslmode=require, which encrypts without
        # authenticating and so does not rule out a machine in the middle.
        kwargs["sslmode"] = "verify-full"
        kwargs["sslrootcert"] = str(CA_BUNDLE)
    return psycopg.connect(database_url, **kwargs)


def cmd_sign(contract_id: str) -> int:
    signer = MlDsaSigner.from_env()

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT root_hash, leaf_count FROM merkle_roots WHERE contract_id = %s",
            (contract_id,),
        )
        row = cur.fetchone()
        if row is None:
            print(
                f"No Merkle root recorded for {contract_id}. Compute one first "
                "(LedgerClient.computeAndStoreRoot). Refusing to sign a root that does not exist.",
                file=sys.stderr,
            )
            return 1

        root_hash, leaf_count = row[0], int(row[1])
        sig = signer.sign_root(contract_id, root_hash, leaf_count)

        cur.execute(
            """
            UPDATE merkle_roots
               SET signature = %s, public_key = %s, signature_alg = %s,
                   signed_at = now(), updated_at = now()
             WHERE contract_id = %s
               -- Guard against signing a root that changed between the read and
               -- the write: the tree would have moved on and the signature would
               -- cover a root no longer stored.
               AND root_hash = %s AND leaf_count = %s
            """,
            (sig.signature, sig.public_key, sig.algorithm, contract_id, root_hash, leaf_count),
        )
        if cur.rowcount != 1:
            print(
                "The root changed while it was being signed; nothing was written. Re-run.",
                file=sys.stderr,
            )
            return 1

    print(f"Signed {contract_id}")
    print(f"  algorithm  : {sig.algorithm}")
    print(f"  root       : {root_hash}")
    print(f"  leaves     : {leaf_count}")
    print(f"  signature  : {len(sig.signature)} bytes")
    print(f"  public key : {len(sig.public_key)} bytes ({sig.public_key[:8].hex()}…)")
    return 0


def cmd_verify(contract_id: str) -> int:
    signer = MlDsaSigner.from_env()

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT root_hash, leaf_count, signature, signature_alg FROM merkle_roots WHERE contract_id = %s",
            (contract_id,),
        )
        row = cur.fetchone()

    if row is None:
        print(f"No Merkle root recorded for {contract_id}.", file=sys.stderr)
        return 1

    root_hash, leaf_count, signature, alg = row[0], int(row[1]), row[2], row[3]
    if signature is None:
        print(f"{contract_id}: root is UNSIGNED — no signature to verify.", file=sys.stderr)
        return 1
    if alg != ALGORITHM:
        print(f"{contract_id}: signature algorithm is {alg!r}, expected {ALGORITHM!r}.", file=sys.stderr)
        return 1

    # The expected key is the one derived from the local seed, NOT the
    # public_key column. Verifying against the key stored beside the signature
    # would only prove the two are consistent, which an attacker who can write
    # to the table can arrange for any root they like.
    ok = verify_root(signer.public_key, contract_id, root_hash, leaf_count, bytes(signature))

    print(f"{contract_id}: {'VALID' if ok else 'INVALID'}")
    print(f"  root   : {root_hash}")
    print(f"  leaves : {leaf_count}")
    if not ok:
        print(
            "  The stored signature does not cover this root under the configured key. Either the "
            "ledger changed after signing, or the signature was made with a different key.",
            file=sys.stderr,
        )
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract_id", nargs="?", help="Contract to sign or verify")
    parser.add_argument("--verify", action="store_true", help="Verify instead of signing")
    parser.add_argument(
        "--show-public-key",
        action="store_true",
        help="Print the public key for the configured seed, for out-of-band distribution",
    )
    args = parser.parse_args()

    try:
        if args.show_public_key:
            print(MlDsaSigner.from_env().public_key.hex())
            return 0
        if not args.contract_id:
            parser.error("contract_id is required unless --show-public-key is given")
        return cmd_verify(args.contract_id) if args.verify else cmd_sign(args.contract_id)
    except SigningKeyUnavailable as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
