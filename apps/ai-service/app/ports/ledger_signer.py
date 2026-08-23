"""FIPS 204 ML-DSA-87 signing, exposed as a service port.

Why this lives in ai-service rather than in the worker that seals the root.
ML-DSA-87 exists in this repo in exactly one implementation,
packages/ledger-client/src/ml_dsa.py, and it is Python (dilithium-py). Every
service that seals or settles is TypeScript, and there is no JavaScript ML-DSA
anywhere in the tree — tools/verify_phase8_live.mjs does not verify in JS
either, it shells out to the same Python module. ai-service is the only running
service that can already do this: dilithium-py is a declared dependency of its
`full` extra and the production image installs it.

The alternative was a second implementation in TypeScript. Two implementations
of a signature that must agree byte-for-byte, one of them inside the process
that captures payments, is the hazard packages/oracle's docstring rejects for
the settlement gate for the same reason.

This module imports the signer rather than reimplementing it, so a root signed
at runtime is byte-identical to one signed by tools/sign_merkle_root.py and
verifies under the same command. That equivalence is the point.

If signing ever needs its own key isolation, the shape here is already right:
lift this port and its route into a standalone signer deployment and the callers
change a URL, not a design.
"""
from __future__ import annotations

import hashlib
import sys
from functools import lru_cache
from pathlib import Path

# Path resolution mirrors app/services/owasp_static.py: walk up to the repo
# root, which the container image reproduces at /srv. The Dockerfile copies
# ml_dsa.py to the matching location — without that COPY this import succeeds in
# a checkout and fails in the image.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_LEDGER_SRC = _REPO_ROOT / "packages" / "ledger-client" / "src"
if str(_LEDGER_SRC) not in sys.path:
    sys.path.insert(0, str(_LEDGER_SRC))

from ml_dsa import (  # noqa: E402
    ALGORITHM,
    MlDsaSigner,
    SigningKeyUnavailable,
    verify_root,
)

__all__ = [
    "ALGORITHM",
    "SigningKeyUnavailable",
    "get_signer",
    "signing_status",
    "verify_root",
]


@lru_cache(maxsize=1)
def get_signer() -> MlDsaSigner:
    """The process-wide signer.

    Cached because ML_DSA_87.key_derive is not free and the seed does not change
    for the life of the process. Without the cache every signature pays the key
    derivation, on a pure-Python implementation, inside a request.

    Raises SigningKeyUnavailable when ML_DSA_SEED_HEX is unset or malformed.
    That refusal is deliberate upstream: minting a throwaway key would produce
    signatures that verify against nothing, which is worse than no signature
    because it looks like one.
    """
    return MlDsaSigner.from_env()


def signing_status() -> dict[str, object]:
    """Whether signing is configured, reported rather than raised.

    Used by the status route and, through it, by the UI: a page that claims
    "post-quantum signed" needs a way to find out that nothing is signing before
    it makes the claim.

    The fingerprint is a hash of the public key, not the key itself — enough to
    confirm two environments share a signer, without publishing key material in
    a status endpoint.
    """
    try:
        signer = get_signer()
    except SigningKeyUnavailable as err:
        return {
            "configured": False,
            "algorithm": ALGORITHM,
            "reason": str(err),
            "public_key_fingerprint": None,
        }
    return {
        "configured": True,
        "algorithm": ALGORITHM,
        "reason": None,
        "public_key_fingerprint": hashlib.sha256(signer.public_key).hexdigest()[:32],
    }
