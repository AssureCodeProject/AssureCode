"""Merkle root signing over HTTP.

The property that matters here is not "the route returns 200". It is that a
signature produced through this route verifies under the same function
tools/sign_merkle_root.py uses — because that equivalence is the entire reason
the route imports packages/ledger-client/src/ml_dsa.py instead of reimplementing
ML-DSA in the service. If the two ever diverge, every root signed at runtime
becomes unverifiable by the tool that is supposed to check it, and nothing else
in the suite would notice.
"""
from __future__ import annotations

import base64

import pytest
from support import service_client

from app.main import app
from app.ports import ledger_signer

client = service_client(app)

# 32 bytes of hex. Fixed rather than random so a failure is reproducible.
SEED = "5a" * 32
ROOT_HASH = "c" * 64
CONTRACT = "AC-SIGN-TEST"

# FIPS 204 ML-DSA-87 sizes. Asserting them is the cheapest evidence that a real
# scheme ran rather than a stub returning a plausible-looking string.
ML_DSA_87_SIGNATURE_BYTES = 4627
ML_DSA_87_PUBLIC_KEY_BYTES = 2592


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("ML_DSA_SEED_HEX", SEED)
    # get_signer is lru_cached for the life of the process; without clearing it
    # the first test to run would pin the key for every later one.
    ledger_signer.get_signer.cache_clear()
    yield
    ledger_signer.get_signer.cache_clear()


@pytest.fixture
def unconfigured(monkeypatch):
    monkeypatch.delenv("ML_DSA_SEED_HEX", raising=False)
    ledger_signer.get_signer.cache_clear()
    yield
    ledger_signer.get_signer.cache_clear()


def sign(contract_id=CONTRACT, root_hash=ROOT_HASH, leaf_count=7):
    return client.post(
        "/ledger/sign-root",
        json={"contract_id": contract_id, "root_hash": root_hash, "leaf_count": leaf_count},
    )


def test_signs_a_root_with_real_ml_dsa_87(configured):
    res = sign()
    assert res.status_code == 200, res.text

    body = res.json()
    assert body["algorithm"] == "ML-DSA-87"
    assert len(base64.b64decode(body["signature_b64"])) == ML_DSA_87_SIGNATURE_BYTES
    assert len(base64.b64decode(body["public_key_b64"])) == ML_DSA_87_PUBLIC_KEY_BYTES


def test_signature_verifies_under_the_same_function_the_cli_uses(configured):
    """The cross-implementation check. Signed over HTTP, verified in-process."""
    body = sign().json()
    signature = base64.b64decode(body["signature_b64"])
    public_key = base64.b64decode(body["public_key_b64"])

    assert ledger_signer.verify_root(public_key, CONTRACT, ROOT_HASH, 7, signature) is True


@pytest.mark.parametrize(
    "contract_id,root_hash,leaf_count",
    [
        ("AC-OTHER", ROOT_HASH, 7),  # different contract
        (CONTRACT, "d" * 64, 7),  # different root
        (CONTRACT, ROOT_HASH, 8),  # different leaf count
    ],
)
def test_signature_does_not_verify_against_a_different_triple(
    configured, contract_id, root_hash, leaf_count
):
    """All three fields are bound into the signed message, not just the root.

    leaf_count matters as much as the hash: a tree truncated to a prefix can
    share neither, but signing the hash alone would leave the count unattested.
    """
    body = sign().json()
    signature = base64.b64decode(body["signature_b64"])
    public_key = base64.b64decode(body["public_key_b64"])

    assert ledger_signer.verify_root(public_key, contract_id, root_hash, leaf_count, signature) is False


def test_signing_is_deterministic(configured):
    """FIPS 204 permits both modes; ml_dsa.py chooses deterministic on purpose.

    Relied on by the gateway, which treats an already-signed root as a no-op
    rather than re-signing.
    """
    assert sign().json()["signature_b64"] == sign().json()["signature_b64"]


def test_refuses_with_503_when_no_seed_is_configured(unconfigured):
    """Not 200 with an empty signature, and not 500.

    An unconfigured seed is a deployment state the caller can act on. Minting a
    throwaway key instead would produce signatures that verify against nothing,
    which is worse than no signature because it looks like one.
    """
    res = sign()
    assert res.status_code == 503
    assert "ML_DSA_SEED_HEX" in res.json()["detail"]


@pytest.mark.parametrize(
    "root_hash",
    ["", "abc", "C" * 64, "z" * 64, "a" * 63, "a" * 65],
)
def test_rejects_a_root_hash_the_ledger_could_not_store(configured, root_hash):
    """merkle_roots.root_hash is CHAR(64) lowercase hex (V009).

    Validating the shape means a caller cannot obtain a signature over a string
    that could never appear in the table.
    """
    assert sign(root_hash=root_hash).status_code == 422


def test_rejects_a_negative_leaf_count(configured):
    assert sign(leaf_count=-1).status_code == 422


def test_signing_status_reports_configured(configured):
    body = client.get("/ledger/signing-status").json()
    assert body["configured"] is True
    assert body["algorithm"] == "ML-DSA-87"
    assert body["reason"] is None
    # A fingerprint, not the key: enough to confirm two environments share a
    # signer without publishing key material from a status endpoint.
    assert len(body["public_key_fingerprint"]) == 32


def test_signing_status_reports_unconfigured_without_raising(unconfigured):
    """The route the UI depends on to know whether it may claim "signed"."""
    res = client.get("/ledger/signing-status")
    assert res.status_code == 200
    body = res.json()
    assert body["configured"] is False
    assert body["public_key_fingerprint"] is None
    assert "ML_DSA_SEED_HEX" in body["reason"]
