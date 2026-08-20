"""Text chunker for RAG ingestion.

Splits raw contract text into chunks suitable for embedding. Pure function —
no I/O — so it's trivially unit-testable.

Strategy: emit one chunk per *semantic unit* (paragraph, list item, or
sentence). Units are merged only when one is too short to embed on its own, and
split only when one is longer than `target_chars`.

Why not greedy packing
----------------------
This previously split the text into units and then greedily packed them back
up to `target_chars`. For contract requirements that silently undid the split:
a five-requirement contract is ~340 characters, so all five packed into a
single chunk and every message was scored against one blended vector covering
login *and* migrations *and* error codes *and* tests *and* validation.

Retrieval then had one candidate, which made top-k ranking a no-op, and the
similarity of a message about any single requirement was dragged down by the
four it did not mention. Measured on the benchmark fixture in tools/benchmark.js
under all-MiniLM-L6-v2, that cost most of the guard's recall:

    packed into 1 chunk    in-scope recall 1/5, out-of-scope held 5/5
    one chunk per unit     in-scope recall 4/5, out-of-scope held 5/5

with the threshold unchanged in both rows. Chunk granularity has to match the
granularity of the query: a client asks about one requirement at a time.

Overlap is applied only when a single unit is split across chunks, which is the
case it exists for — carrying context across an arbitrary cut in continuous
prose. Carrying it across a genuine boundary between two requirements would
reintroduce exactly the blending described above.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Chunk:
    idx: int
    content: str


# A sentence terminator followed by whitespace. Keeps the terminator with the
# sentence it ends, which `text.split(". ")` did not.
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")


def _split_units(text: str) -> list[str]:
    """Break text into the smallest semantic units it legibly offers.

    Blank lines separate paragraphs; single newlines within a paragraph
    separate list items (requirements are commonly written one per line). When
    the text offers no line structure at all, fall back to sentences — a
    one-line requirements blob is still five requirements.
    """
    units: list[str] = []
    for paragraph in (p.strip() for p in text.split("\n\n")):
        if not paragraph:
            continue
        units.extend(line.strip() for line in paragraph.split("\n") if line.strip())

    if len(units) <= 1:
        source = units[0] if units else text.strip()
        units = [s.strip() for s in _SENTENCE_BREAK.split(source) if s.strip()]

    return units


def _split_oversized(unit: str, target_chars: int, overlap_chars: int) -> list[str]:
    """Window a single over-long unit, carrying `overlap_chars` between windows."""
    stride = max(1, target_chars - overlap_chars)
    return [unit[i : i + target_chars] for i in range(0, len(unit), stride)]


def chunk_text(
    text: str,
    target_chars: int = 512,
    overlap_chars: int = 64,
    min_chunk_chars: int = 16,
) -> list[Chunk]:
    """Split text into embedding-sized chunks, one per semantic unit.

    Args:
        text: raw contract text (pdf_raw_text or requirements).
        target_chars: hard max length per chunk; longer units are windowed.
        overlap_chars: characters carried between windows of a split unit.
        min_chunk_chars: a unit shorter than this is merged with the ones
            following it, rather than embedded alone as a fragment. Deliberately
            low: it is meant to catch structural debris ("Notes:", "1.", "(a)"),
            not short requirements. "Persist accounts in PostgreSQL." is 31
            characters and is a whole requirement, so a bound above it would
            re-merge exactly what this chunker exists to keep apart.

    Returns:
        Ordered list of Chunk with idx 0..n-1.
    """
    if not text or not text.strip():
        return []

    chunks: list[str] = []
    pending = ""  # a unit held back because it is too short to stand alone

    for unit in _split_units(text):
        current = f"{pending} {unit}".strip() if pending else unit

        # Still too small to carry meaning on its own — hold it for the next
        # unit rather than embedding a fragment.
        if len(current) < min_chunk_chars:
            pending = current
            continue

        pending = ""
        if len(current) > target_chars:
            chunks.extend(_split_oversized(current, target_chars, overlap_chars))
        else:
            chunks.append(current)

    # A trailing runt has nothing left to merge with. Append it to the previous
    # chunk if there is one, so no text is dropped, otherwise keep it alone —
    # for a very short contract it is the entire corpus.
    if pending:
        if chunks:
            chunks[-1] = f"{chunks[-1]} {pending}"
        else:
            chunks.append(pending)

    return [Chunk(idx=i, content=c) for i, c in enumerate(chunks)]
