"""ML-DSA-87 signature tests.

The negative cases are the point. The module these replace had a verifier that
accepted every forgery, and it had no test that tried one — every test asserted
that a signature it had just made verified, which the broken implementation also
satisfied. Each test below therefore attempts an attack and asserts it fails.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ml_dsa import (  # noqa: E402
    ALGORITHM,
    LEDGER_CONTEXT,
    MlDsaSigner,
    SigningKeyUnavailable,
    public_key_from_seed,
    verify_root,
)

SEED_A = bytes(range(32))
SEED_B = bytes(range(32, 64))

CONTRACT = "AC-TEST-1"
ROOT = "a" * 64
LEAVES = 4


@pytest.fixture
def signer() -> MlDsaSigner:
    return MlDsaSigner(SEED_A)


# ── The scheme is actually ML-DSA-87 ──────────────────────────────────


def test_key_and_signature_sizes_are_fips_204_ml_dsa_87(signer: MlDsaSigner) -> None:
    """Cheapest evidence that a real lattice scheme is running.

    The old implementation produced a 128-hex-character 'signature', because it
    was a SHA3-512 digest. ML-DSA-87 signatures are 4627 bytes.
    """
    sig = signer.sign_root(CONTRACT, ROOT, LEAVES)
    assert len(signer.public_key) == 2592
    assert len(sig.signature) == 4627
    assert sig.algorithm == ALGORITHM


def test_signing_is_deterministic(signer: MlDsaSigner) -> None:
    a = signer.sign_root(CONTRACT, ROOT, LEAVES).signature
    b = signer.sign_root(CONTRACT, ROOT, LEAVES).signature
    assert a == b


def test_key_derivation_is_deterministic() -> None:
    assert MlDsaSigner(SEED_A).public_key == MlDsaSigner(SEED_A).public_key
    assert public_key_from_seed(SEED_A) == MlDsaSigner(SEED_A).public_key


def test_different_seeds_give_different_keys() -> None:
    assert MlDsaSigner(SEED_A).public_key != MlDsaSigner(SEED_B).public_key


# ── Happy path ────────────────────────────────────────────────────────


def test_a_genuine_signature_verifies(signer: MlDsaSigner) -> None:
    sig = signer.sign_root(CONTRACT, ROOT, LEAVES)
    assert verify_root(signer.public_key, CONTRACT, ROOT, LEAVES, sig.signature) is True


# ── Forgery and tampering ─────────────────────────────────────────────


def test_a_tampered_root_fails(signer: MlDsaSigner) -> None:
    """The property the whole ledger rests on: edit an entry, the root moves."""
    sig = signer.sign_root(CONTRACT, ROOT, LEAVES)
    tampered = "b" * 64
    assert verify_root(signer.public_key, CONTRACT, tampered, LEAVES, sig.signature) is False


def test_a_signature_cannot_be_moved_to_another_contract(signer: MlDsaSigner) -> None:
    sig = signer.sign_root(CONTRACT, ROOT, LEAVES)
    assert verify_root(signer.public_key, "AC-OTHER", ROOT, LEAVES, sig.signature) is False


def test_truncating_the_tree_fails(signer: MlDsaSigner) -> None:
    """Dropping trailing entries and re-presenting an older root is detected,
    because the leaf count is bound into the signed message."""
    sig = signer.sign_root(CONTRACT, ROOT, LEAVES)
    assert verify_root(signer.public_key, CONTRACT, ROOT, LEAVES - 1, sig.signature) is False


def test_another_key_cannot_verify(signer: MlDsaSigner) -> None:
    sig = signer.sign_root(CONTRACT, ROOT, LEAVES)
    other = MlDsaSigner(SEED_B)
    assert verify_root(other.public_key, CONTRACT, ROOT, LEAVES, sig.signature) is False


def test_an_attacker_resigning_with_their_own_key_is_caught(signer: MlDsaSigner) -> None:
    """The database-write attacker from the module's threat model.

    They edit the ledger, recompute the root, and sign it with a key they
    control. Everything is internally consistent — and it still fails, because
    the verifier checks against a public key it already trusts rather than the
    one presented alongside the signature.
    """
    attacker = MlDsaSigner(SEED_B)
    forged_root = "c" * 64
    forged = attacker.sign_root(CONTRACT, forged_root, LEAVES)

    # Self-consistent under the attacker's own key.
    assert verify_root(attacker.public_key, CONTRACT, forged_root, LEAVES, forged.signature) is True
    # And worthless against the key the verifier expects.
    assert verify_root(signer.public_key, CONTRACT, forged_root, LEAVES, forged.signature) is False


def test_a_flipped_bit_in_the_signature_fails(signer: MlDsaSigner) -> None:
    sig = bytearray(signer.sign_root(CONTRACT, ROOT, LEAVES).signature)
    sig[100] ^= 0x01
    assert verify_root(signer.public_key, CONTRACT, ROOT, LEAVES, bytes(sig)) is False


def test_garbage_is_rejected_rather_than_raising(signer: MlDsaSigner) -> None:
    """Malformed input must be a failed verification, not an exception a caller
    might forget to catch and treat as success."""
    assert verify_root(signer.public_key, CONTRACT, ROOT, LEAVES, b"") is False
    assert verify_root(signer.public_key, CONTRACT, ROOT, LEAVES, b"\x00" * 10) is False
    assert verify_root(b"", CONTRACT, ROOT, LEAVES, b"\x00" * 4627) is False


def test_the_forgery_that_broke_the_old_implementation_now_fails() -> None:
    """The exact attack that quantum_lattice.py accepted.

    Its verifier checked only that zk_proof == sha3_256(b"ZK-LATTICE-PROOF:" +
    commitment) — two fields of the same signature. Anyone could satisfy that in
    one line, for any payload, against any public key hash. The dictionary below
    is that forgery, and it is rejected now, both as a structure and after being
    flattened to the bytes it once stood for.
    """
    import hashlib

    commitment = hashlib.sha3_512(b"R-LWE-COMMITMENT:anything").hexdigest()
    forged = {
        "algorithm": "NIST-ML-DSA-87",
        "publicKeyHash": "0" * 64,
        "signatureCommitment": commitment,
        "zeroKnowledgeProof": hashlib.sha3_256(
            b"ZK-LATTICE-PROOF:" + commitment.encode()
        ).hexdigest(),
    }

    # The old check passed on exactly this, without looking at the message.
    assert forged["zeroKnowledgeProof"] == hashlib.sha3_256(
        b"ZK-LATTICE-PROOF:" + forged["signatureCommitment"].encode()
    ).hexdigest()

    pk = MlDsaSigner(SEED_A).public_key
    # Rejected as a wrong-typed signature rather than raising into the caller.
    assert verify_root(pk, CONTRACT, ROOT, LEAVES, forged) is False  # type: ignore[arg-type]
    # And rejected as the raw bytes it encoded.
    assert verify_root(pk, CONTRACT, ROOT, LEAVES, bytes.fromhex(commitment)) is False


# ── Key handling ──────────────────────────────────────────────────────


def test_a_short_seed_is_rejected() -> None:
    with pytest.raises(ValueError):
        MlDsaSigner(b"too short")


def test_a_missing_seed_refuses_rather_than_inventing_a_key(monkeypatch) -> None:
    monkeypatch.delenv("ML_DSA_SEED_HEX", raising=False)
    with pytest.raises(SigningKeyUnavailable):
        MlDsaSigner.from_env()


def test_a_malformed_seed_refuses(monkeypatch) -> None:
    monkeypatch.setenv("ML_DSA_SEED_HEX", "nothex!!")
    with pytest.raises(SigningKeyUnavailable):
        MlDsaSigner.from_env()

    monkeypatch.setenv("ML_DSA_SEED_HEX", "aabb")
    with pytest.raises(SigningKeyUnavailable):
        MlDsaSigner.from_env()


def test_from_env_uses_the_configured_seed(monkeypatch) -> None:
    monkeypatch.setenv("ML_DSA_SEED_HEX", SEED_A.hex())
    assert MlDsaSigner.from_env().public_key == MlDsaSigner(SEED_A).public_key


def test_the_context_string_is_bound_into_the_signature(signer: MlDsaSigner) -> None:
    """Domain separation: a root signature cannot be replayed as a signature
    over some other message this system might sign later."""
    from dilithium_py.ml_dsa import ML_DSA_87

    sig = signer.sign_root(CONTRACT, ROOT, LEAVES)
    message = f"{CONTRACT}\n{ROOT}\n{LEAVES}".encode("utf-8")

    assert ML_DSA_87.verify(signer.public_key, message, sig.signature, ctx=LEDGER_CONTEXT) is True
    assert ML_DSA_87.verify(signer.public_key, message, sig.signature, ctx=b"") is False
