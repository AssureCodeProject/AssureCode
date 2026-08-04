"""FIPS 204 ML-DSA-87 signatures over the ledger's Merkle root.

What this replaces
------------------
`quantum_lattice.py` claimed to be "NIST FIPS 204 ML-DSA" implementing "Ring
Learning With Errors over polynomial rings R_q = Z_q[X]/(X^n + 1)". It computed
no lattice arithmetic. It hashed strings:

    public_key_hash  = sha3_256(b"ML-DSA-PUBKEY:"  + seed)
    signature        = sha3_512(b"R-LWE-COMMITMENT:" + message + private_key_hash)
    zk_proof         = sha3_256(b"ZK-LATTICE-PROOF:" + signature)

and its verifier was:

    expected_zk = sha3_256(b"ZK-LATTICE-PROOF:" + commitment)
    return signature["zeroKnowledgeProof"] == expected_zk

Read that verifier carefully. It never touches the message — `payload_hash` is
accepted as a parameter and never used. It never touches key material. It checks
only that one field of the signature is the SHA3 of another field of the *same
signature*, which anybody can satisfy for any message in one line:

    forged = {"algorithm": "NIST-ML-DSA-87",
              "publicKeyHash": victim_public_key_hash,
              "signatureCommitment": "00",
              "zeroKnowledgeProof": sha3_256(b"ZK-LATTICE-PROOF:00").hexdigest()}

That forgery verifies against any public key hash, for any payload. The function
was not weak cryptography; it was a well-formedness check wearing the costume of
a signature.

This module uses dilithium-py's `ML_DSA_87`, a pure-Python implementation of
FIPS 204 with the standard parameter set: 2592-byte public keys, 4896-byte
private keys, 4627-byte signatures. Those sizes are checked in the tests, since
they are the cheapest evidence that a real scheme is running rather than a hash.

Threat model — read this before trusting a verification result
--------------------------------------------------------------
The signature covers the Merkle root, so it detects any change to any ledger
entry: a modified payload changes its leaf, which changes the root, which the
old signature no longer covers.

It does NOT, on its own, stop an attacker who can write to the database. Such an
attacker can edit an entry, recompute the root, sign it with *their own* key,
and overwrite `merkle_roots.public_key` with theirs. Every self-consistency
check then passes.

What closes that hole is the verifier knowing which public key to expect, from
somewhere the attacker does not control. `verify_root` therefore requires the
expected public key as an argument — it has no mode that accepts whatever key
came alongside the signature. The stored `public_key` column exists for
convenience and diagnostics, not as an authority.

Key material
------------
The signing key is derived deterministically from a 32-byte seed supplied by the
environment. It is never generated on the fly: a signer that mints a fresh key
per process produces signatures that verify only against a key nobody else has
seen, which is indistinguishable from no signature at all.

For this project the seed lives in ML_DSA_SEED_HEX in .env, which is a
development posture, not a production one — a real deployment needs the private
key in an HSM or a KMS, with only the public key on the verifying side. That
limitation is stated here rather than left for a reader to discover.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from dilithium_py.ml_dsa import ML_DSA_87

__all__ = [
    "ALGORITHM",
    "LEDGER_CONTEXT",
    "MlDsaSigner",
    "SigningKeyUnavailable",
    "public_key_from_seed",
    "verify_root",
]

ALGORITHM = "ML-DSA-87"

# FIPS 204 signing takes a context string that is bound into the signature. It
# is used here as domain separation: a signature made over a Merkle root cannot
# be replayed as a signature over anything else this system might sign later,
# even if the byte strings coincide.
LEDGER_CONTEXT = b"assurecode/merkle-root/v1"

SEED_BYTES = 32


class SigningKeyUnavailable(RuntimeError):
    """Raised when no signing seed is configured.

    Deliberately fatal. The alternative — generating a random key so the call
    succeeds — produces a signature that proves nothing, and the caller has no
    way to tell that is what happened.
    """


def _message(contract_id: str, root_hash: str, leaf_count: int) -> bytes:
    """The bytes that are signed.

    The root alone is not enough. Two contracts can legitimately have identical
    roots (an empty ledger always does), so a signature over the root alone
    could be lifted from one contract to another. Binding the contract id and
    the leaf count makes each signature specific to the tree it was made for,
    and makes truncation — dropping trailing entries and re-presenting an older
    root — visible rather than silent.
    """
    return f"{contract_id}\n{root_hash}\n{leaf_count}".encode("utf-8")


def _seed_from_env() -> bytes:
    raw = os.environ.get("ML_DSA_SEED_HEX", "").strip()
    if not raw:
        raise SigningKeyUnavailable(
            "ML_DSA_SEED_HEX is not set. Generate one with "
            "`python -c \"import os;print(os.urandom(32).hex())\"` and put it in .env. "
            "Refusing to sign with a throwaway key, which would produce a signature that "
            "verifies against nothing anyone else holds."
        )
    try:
        seed = bytes.fromhex(raw)
    except ValueError as err:
        raise SigningKeyUnavailable(f"ML_DSA_SEED_HEX is not valid hex: {err}") from err
    if len(seed) != SEED_BYTES:
        raise SigningKeyUnavailable(
            f"ML_DSA_SEED_HEX must decode to {SEED_BYTES} bytes, got {len(seed)}"
        )
    return seed


def public_key_from_seed(seed: bytes) -> bytes:
    """The public key for a seed, without constructing a signer."""
    pk, _ = ML_DSA_87.key_derive(seed)
    return pk


@dataclass(frozen=True)
class RootSignature:
    algorithm: str
    signature: bytes
    public_key: bytes


class MlDsaSigner:
    """Signs Merkle roots with a key derived from a fixed seed."""

    def __init__(self, seed: bytes) -> None:
        if len(seed) != SEED_BYTES:
            raise ValueError(f"seed must be {SEED_BYTES} bytes, got {len(seed)}")
        self._public_key, self._private_key = ML_DSA_87.key_derive(seed)

    @classmethod
    def from_env(cls) -> "MlDsaSigner":
        return cls(_seed_from_env())

    @property
    def public_key(self) -> bytes:
        return self._public_key

    def sign_root(self, contract_id: str, root_hash: str, leaf_count: int) -> RootSignature:
        # deterministic=True so the same tree always yields the same signature.
        # FIPS 204 permits both; determinism is chosen because it makes the
        # verification script reproducible and removes a source of nondeterminism
        # from results that get published.
        sig = ML_DSA_87.sign(
            self._private_key,
            _message(contract_id, root_hash, leaf_count),
            ctx=LEDGER_CONTEXT,
            deterministic=True,
        )
        return RootSignature(algorithm=ALGORITHM, signature=sig, public_key=self._public_key)


def verify_root(
    expected_public_key: bytes,
    contract_id: str,
    root_hash: str,
    leaf_count: int,
    signature: bytes,
) -> bool:
    """Verify a root signature against a public key the caller already trusts.

    `expected_public_key` is required and is not defaulted to whatever is stored
    beside the signature — see the threat model in the module docstring. A
    verifier that accepts the key it is handed by the same party that handed it
    the signature is verifying only that the two are consistent.
    """
    if not expected_public_key or not signature:
        return False
    try:
        return ML_DSA_87.verify(
            expected_public_key,
            _message(contract_id, root_hash, leaf_count),
            signature,
            ctx=LEDGER_CONTEXT,
        )
    except Exception:
        # A malformed signature is a failed verification, not an exception the
        # caller has to remember to catch — the one place where swallowing is
        # right, because every failure mode here means "do not trust this".
        return False
