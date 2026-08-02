"""Tests for the chunker (pure function, task 1.5)."""
from __future__ import annotations

from app.services.chunker import chunk_text


def test_empty_text_yields_no_chunks() -> None:
    assert chunk_text("") == []
    assert chunk_text("   \n\n  ") == []


def test_short_text_is_one_chunk() -> None:
    chunks = chunk_text("Build a React dashboard with charts.")
    assert len(chunks) == 1
    assert chunks[0].idx == 0
    assert "React dashboard" in chunks[0].content


def test_long_text_splits_into_multiple_chunks() -> None:
    # Generate 8 paragraphs of ~120 chars each → with target 256, should split.
    paragraphs = "\n\n".join(
        f"Paragraph {i}: " + ("lorem ipsum dolor sit amet " * 5) for i in range(8)
    )
    chunks = chunk_text(paragraphs, target_chars=256, overlap_chars=32)
    assert len(chunks) >= 2
    # Idxs must be sequential starting at 0.
    assert [c.idx for c in chunks] == list(range(len(chunks)))


def test_chunks_respect_target_size_roughly() -> None:
    paragraphs = "\n\n".join(f"Section {i} content here." for i in range(20))
    chunks = chunk_text(paragraphs, target_chars=128, overlap_chars=16)
    # Each chunk should be <= target + some slack for the final packing.
    assert all(len(c.content) <= 200 for c in chunks)


def test_overlap_carries_context_between_chunks() -> None:
    paragraphs = "\n\n".join(f"Topic {i} paragraph." for i in range(10))
    chunks = chunk_text(paragraphs, target_chars=64, overlap_chars=20)
    if len(chunks) >= 2:
        # The overlap means the tail of chunk 0 should appear at the start of chunk 1.
        tail = chunks[0].content[-20:]
        # Overlap is taken literally — it should be a substring of chunk 1.
        assert tail in chunks[1].content or chunks[1].content.startswith(tail[:10])
