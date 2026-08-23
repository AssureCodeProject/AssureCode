"""Merkle root signing.

Objective 8 says the ledger root is signed with a post-quantum scheme. Until
this route existed the only thing that ever wrote merkle_roots.signature was
tools/sign_merkle_root.py, run by hand. No service signed, so in normal
operation every root the system produced had a NULL signature while the UI
footer asserted "NIST ML-DSA POST-QUANTUM SIGNED" unconditionally. This route
is what makes that claim true, and GET /ledger/signing-status is what lets the
claim be withdrawn honestly when it is not.

Scope of this endpoint. It signs the (contract_id, root_hash, leaf_count)
triple it is handed and does not read the database. That keeps ai-service out of
the ledger schema and keeps the guarded merkle_roots write in exactly one place
(LedgerClient.storeRootSignature). The cost is that any holder of SERVICE_TOKEN
can obtain a signature over an arbitrary triple — acceptable because the threat
model in packages/ledger-client/src/ml_dsa.py already states the signature is
not a defence against database write access, and because the real caller (the
gateway) only ever signs a root it has just read out of merkle_roots.
"""
from __future__ import annotations

import base64

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.ports.ledger_signer import SigningKeyUnavailable, get_signer, signing_status

router = APIRouter(prefix="/ledger", tags=["ledger"])


class SignRootRequest(BaseModel):
    contract_id: str = Field(..., min_length=1)
    # merkle_roots.root_hash is CHAR(64) holding lowercase hex — see
    # V009__canonical_hash_and_merkle.sql. Validating the shape here means a
    # caller cannot obtain a signature over a string the ledger could not store.
    root_hash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    leaf_count: int = Field(..., ge=0)


class SignRootResponse(BaseModel):
    algorithm: str
    signature_b64: str
    public_key_b64: str


@router.post("/sign-root", response_model=SignRootResponse)
def sign_root(req: SignRootRequest) -> SignRootResponse:
    try:
        signer = get_signer()
    except SigningKeyUnavailable as err:
        # 503, not 500. An unconfigured seed is a deployment state the caller
        # can act on and should report differently from a signer that broke;
        # flattening the two is what lets a permanently unsigned ledger look
        # like a transient blip.
        raise HTTPException(status_code=503, detail=str(err)) from err

    sig = signer.sign_root(req.contract_id, req.root_hash, req.leaf_count)
    return SignRootResponse(
        algorithm=sig.algorithm,
        signature_b64=base64.b64encode(sig.signature).decode("ascii"),
        public_key_b64=base64.b64encode(sig.public_key).decode("ascii"),
    )


@router.get("/signing-status")
def get_signing_status() -> dict[str, object]:
    """Whether this deployment can sign at all. Never raises."""
    return signing_status()
