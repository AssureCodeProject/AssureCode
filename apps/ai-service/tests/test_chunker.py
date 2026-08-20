"""Tests for the chunker (pure function, task 1.5)."""
from __future__ import annotations

import textwrap

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


def test_overlap_carries_context_within_a_split_unit() -> None:
    """Overlap exists for cuts made *inside* a unit, where context is lost."""
    # One unit, no internal boundaries, longer than the target — so the
    # chunker has to window it and the window edges are arbitrary.
    long_unit = "lorem ipsum dolor sit amet consectetur " * 10
    chunks = chunk_text(long_unit, target_chars=120, overlap_chars=30)
    assert len(chunks) >= 2
    tail = chunks[0].content[-30:]
    assert chunks[1].content.startswith(tail)


def test_distinct_units_are_not_merged_into_one_chunk() -> None:
    """Regression: five requirements must not collapse into one blended chunk.

    They previously did - 341 characters of requirements packed under a
    512-character target - which left retrieval one candidate to rank and cost
    the scope guard most of its recall. See the chunker module docstring.
    """
    requirements = textwrap.dedent(
        """        Build a REST API for user login and session management using Fastify.
        Persist user accounts and sessions in PostgreSQL with schema migrations.
        Return JSON error responses with appropriate HTTP status codes.
        Write Jest integration tests covering the authentication endpoints.
        Add input validation and sanitization on all user-supplied fields."""
    )
    chunks = chunk_text(requirements, target_chars=512, overlap_chars=64)
    assert len(chunks) == 5
    assert "Fastify" in chunks[0].content
    assert "Fastify" not in chunks[4].content


def test_single_line_requirements_blob_splits_on_sentences() -> None:
    """No line structure is not a reason to give up and emit one chunk."""
    blob = (
        "Build a REST API for user login. Persist accounts in PostgreSQL. "
        "Return JSON error responses with appropriate status codes."
    )
    chunks = chunk_text(blob, target_chars=512, overlap_chars=64)
    assert len(chunks) == 3
    assert chunks[0].content == "Build a REST API for user login."
    # 31 characters, and a whole requirement. It stays its own chunk.
    assert chunks[1].content == "Persist accounts in PostgreSQL."


def test_no_text_is_dropped() -> None:
    """A trailing runt joins the previous chunk rather than vanishing."""
    text = textwrap.dedent(
        """\
        A sufficiently long first requirement line that stands alone.
        tiny"""
    )
    chunks = chunk_text(text, target_chars=512, overlap_chars=64)
    assert "tiny" in " ".join(c.content for c in chunks)
