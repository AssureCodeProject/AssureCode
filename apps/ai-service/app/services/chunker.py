"""Text chunker for RAG ingestion.

Splits raw contract text into overlapping chunks suitable for embedding. Pure
function — no I/O — so it's trivially unit-testable.

Strategy: split on paragraph boundaries (\\n\\n), then greedily pack paragraphs
into chunks up to `target_chars`, with `overlap_chars` of carry-over between
adjacent chunks so semantic context isn't lost at a boundary.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Chunk:
    idx: int
    content: str


def chunk_text(
    text: str,
    target_chars: int = 512,
    overlap_chars: int = 64,
    min_chunk_chars: int = 32,
) -> list[Chunk]:
    """Split text into overlapping chunks.

    Args:
        text: raw contract text (pdf_raw_text or requirements).
        target_chars: soft max length per chunk.
        overlap_chars: characters carried from the previous chunk's tail.
        min_chunk_chars: drop tail chunks shorter than this.

    Returns:
        Ordered list of Chunk with idx 0..n-1.
    """
    if not text or not text.strip():
        return []

    # Normalize whitespace within paragraphs; split on blank-line boundaries.
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    # If no paragraph breaks, fall back to sentence-ish splitting on periods.
    if len(paragraphs) <= 1:
        paragraphs = [s.strip() for s in text.split(". ") if s.strip()]

    chunks: list[Chunk] = []
    current = ""
    overlap = ""

    for para in paragraphs:
        candidate = (overlap + para) if overlap else para
        if len(current) + len(candidate) + 2 <= target_chars or not current:
            current = (current + "\n\n" + candidate) if current else candidate
        else:
            # Flush current, start new chunk with overlap from its tail.
            chunks.append(current)
            overlap = current[-overlap_chars:] if overlap_chars > 0 else ""
            current = overlap + "\n\n" + para if overlap else para

    if current and len(current) >= min_chunk_chars:
        chunks.append(current)

    return [Chunk(idx=i, content=c) for i, c in enumerate(chunks)]
