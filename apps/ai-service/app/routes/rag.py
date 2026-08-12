"""Routes under /rag — ingest contract text into the embedding store.

POST /rag/ingest → chunk + embed + persist. Called by the gateway after a
contract is locked (task 1.5) so the scope guard can cosine-match against it
later (task 3.3).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import get_embedder, get_rag_store
from app.ports.embedder import Embedder
from app.ports.rag_store import RagStore, RagStoreUnavailable, StoredChunk
from app.services.chunker import chunk_text

router = APIRouter(prefix="/rag", tags=["rag"])


class IngestRequest(BaseModel):
    contract_id: str = Field(..., min_length=1, max_length=128)
    text: str = Field(..., min_length=1, max_length=200_000)
    target_chars: int = Field(default=512, ge=64, le=4096)
    overlap_chars: int = Field(default=64, ge=0, le=512)


class IngestResponse(BaseModel):
    contract_id: str
    chunks_stored: int
    dim: int


@router.post("/ingest", response_model=IngestResponse)
def ingest(
    req: IngestRequest,
    embedder: Embedder = Depends(get_embedder),
    store: RagStore = Depends(get_rag_store),
) -> IngestResponse:
    # 1. Chunk the raw text.
    chunks = chunk_text(req.text, target_chars=req.target_chars, overlap_chars=req.overlap_chars)
    if not chunks:
        return IngestResponse(contract_id=req.contract_id, chunks_stored=0, dim=embedder.dim)

    # 2. Embed all chunks in one batch.
    vecs = embedder.embed_batch([c.content for c in chunks])

    # 3. Persist.
    stored = [
        StoredChunk(
            contract_id=req.contract_id,
            chunk_idx=c.idx,
            content=c.content,
            embedding=tuple(float(x) for x in vecs[i]),
        )
        for i, c in enumerate(chunks)
    ]
    # A store failure is a dependency failure, and it has to say so. Letting
    # RagStoreUnavailable propagate gave the caller a bare HTTP 500 "Internal
    # Server Error" with the reason only in this service's logs — so a contract
    # that was never indexed looked like a bug here rather than a missing
    # prerequisite there. The most common cause is exactly that: ingesting for a
    # contract_id with no row in `contracts`, which the foreign key rejects.
    try:
        n = store.store(req.contract_id, stored)
    except RagStoreUnavailable as err:
        raise HTTPException(
            status_code=503,
            detail=f"Could not persist contract chunks for {req.contract_id}: {err}",
        ) from err
    return IngestResponse(contract_id=req.contract_id, chunks_stored=n, dim=embedder.dim)


class CountResponse(BaseModel):
    contract_id: str
    chunks: int


@router.get("/count/{contract_id}", response_model=CountResponse)
def count(contract_id: str, store: RagStore = Depends(get_rag_store)) -> CountResponse:
    return CountResponse(contract_id=contract_id, chunks=store.count(contract_id))
