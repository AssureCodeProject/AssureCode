"""Routes under /embed — the embedding port's HTTP face.

POST /embed         → embed a single text → { vector, dim }
POST /embed/batch   → embed many         → { vectors, dim }
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.deps import get_embedder
from app.ports.embedder import Embedder

router = APIRouter(prefix="/embed", tags=["embed"])


class EmbedRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)


class EmbedResponse(BaseModel):
    vector: list[float]
    dim: int


class EmbedBatchRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=256)


class EmbedBatchResponse(BaseModel):
    vectors: list[list[float]]
    dim: int


@router.post("", response_model=EmbedResponse)
def embed(req: EmbedRequest, embedder: Embedder = Depends(get_embedder)) -> EmbedResponse:
    vec = embedder.embed(req.text)
    return EmbedResponse(vector=vec.tolist(), dim=embedder.dim)


@router.post("/batch", response_model=EmbedBatchResponse)
def embed_batch(
    req: EmbedBatchRequest, embedder: Embedder = Depends(get_embedder)
) -> EmbedBatchResponse:
    mat = embedder.embed_batch(req.texts)
    return EmbedBatchResponse(vectors=mat.tolist(), dim=embedder.dim)
