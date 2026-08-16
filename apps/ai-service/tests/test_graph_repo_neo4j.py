"""Tests for the Neo4j graph adapter.

Three layers, deliberately separated by what they need:

  * Pure arithmetic for the score conversion — always runs.
  * Adapter behaviour against a stubbed driver — always runs, no Neo4j.
  * Live integration and cross-backend parity — skipped without a running
    Neo4j (and Postgres, for parity), announced rather than silently passing.

The conversion tests are the ones that matter most. `retrieve_by_embedding` was
a stub returning similarity 0.0 for every freelancer, so selecting this backend
silently deleted the semantic half of matchmaking. The replacement introduces a
subtler version of the same hazard: Neo4j's cosine index reports `(1+cos)/2`
while pgvector reports raw `cos`, and *both* are plausible floats that survive
the `max(0.0, ...)` clamp in the matchmaker. Getting the conversion wrong does
not raise; it just ranks differently.
"""
from __future__ import annotations

import os
from typing import ClassVar

import pytest

from app.ports.graph_repo import (
    FreelancerProfile,
    Neo4jGraphRepo,
    cosine_to_neo4j_score,
    neo4j_score_to_cosine,
)

# ── Layer 1: score conversion ───────────────────────────────────────────────


class TestScoreConversion:
    @pytest.mark.parametrize(
        "score,expected_cosine",
        [
            (1.0, 1.0),    # identical vectors
            (0.5, 0.0),    # orthogonal
            (0.0, -1.0),   # opposed
            (0.75, 0.5),
            (0.25, -0.5),
        ],
    )
    def test_known_points(self, score, expected_cosine):
        assert neo4j_score_to_cosine(score) == pytest.approx(expected_cosine, abs=1e-12)

    @pytest.mark.parametrize("cosine", [-1.0, -0.73, -0.25, 0.0, 0.25, 0.5, 0.9999, 1.0])
    def test_round_trip_is_exact(self, cosine):
        assert neo4j_score_to_cosine(cosine_to_neo4j_score(cosine)) == pytest.approx(cosine, abs=1e-12)

    def test_clamped_to_the_cosine_range(self):
        # Floating-point error at the extremes can push a score a hair outside
        # [0,1]; a cosine of 1.0000000002 is noise, not information.
        assert neo4j_score_to_cosine(1.0000000002) == 1.0
        assert neo4j_score_to_cosine(-0.0000000002) == -1.0

    def test_conversion_is_monotonic(self):
        # Order must be preserved, or the ORDER BY in the Cypher stops matching
        # the order the caller sees.
        scores = [0.1, 0.3, 0.5, 0.7, 0.9]
        cosines = [neo4j_score_to_cosine(s) for s in scores]
        assert cosines == sorted(cosines)

    def test_raw_score_would_be_wrong_by_a_wide_margin(self):
        # The specific reason this conversion exists: an orthogonal pair (no
        # semantic relation at all) reports 0.5 from Neo4j. Used unconverted,
        # every unrelated candidate would carry half the maximum skill score.
        assert cosine_to_neo4j_score(0.0) == 0.5
        assert neo4j_score_to_cosine(0.5) == 0.0


# ── Layer 2: adapter behaviour with a stubbed driver ────────────────────────


class _Record(dict):
    """Neo4j records are mapping-like; dict is a faithful enough stand-in."""


class _StubDriver:
    """Records queries and returns canned rows, in the driver's 3-tuple shape."""

    def __init__(self, rows=None, raises=False):
        self._rows = rows or []
        self._raises = raises
        self.calls = []

    def execute_query(self, cypher, **params):
        self.calls.append({"cypher": cypher, "params": params})
        if self._raises:
            raise RuntimeError("neo4j is unreachable")
        return self._rows, None, None

    def close(self):
        pass


def _vector_row(fid, name, score, skills=("react",), trust=0.9):
    return _Record(
        id=fid,
        name=name,
        trust=trust,
        deliveries=5,
        avg_ast=80.0,
        rate=7000,
        skills=list(skills),
        score=score,
    )


def _repo_with(driver) -> Neo4jGraphRepo:
    repo = Neo4jGraphRepo("bolt://stub:7687", "neo4j", "pw")
    repo._driver = driver  # bypass _ensure_driver; no connection attempted
    return repo


class TestRetrieveByEmbedding:
    def test_converts_index_scores_to_raw_cosine(self):
        driver = _StubDriver([
            _vector_row("freelancer-a", "A", cosine_to_neo4j_score(0.9)),
            _vector_row("freelancer-b", "B", cosine_to_neo4j_score(0.4)),
        ])
        results = _repo_with(driver).retrieve_by_embedding([0.1] * 384, limit=5)

        assert [p.id for p, _ in results] == ["freelancer-a", "freelancer-b"]
        assert results[0][1] == pytest.approx(0.9, abs=1e-9)
        assert results[1][1] == pytest.approx(0.4, abs=1e-9)

    def test_a_negative_cosine_survives_as_negative(self):
        # Neo4j reports 0.25 for cos=-0.5. If that reached the matchmaker
        # unconverted it would be a positive skill score for a semantically
        # opposed profile.
        driver = _StubDriver([_vector_row("freelancer-a", "A", cosine_to_neo4j_score(-0.5))])
        results = _repo_with(driver).retrieve_by_embedding([0.1] * 384)
        assert results[0][1] == pytest.approx(-0.5, abs=1e-9)

    def test_queries_the_expected_index_with_the_limit_and_vector(self):
        driver = _StubDriver([_vector_row("freelancer-a", "A", 1.0)])
        vec = [0.5] * 384
        _repo_with(driver).retrieve_by_embedding(vec, limit=7)

        call = driver.calls[0]
        assert "db.index.vector.queryNodes" in call["cypher"]
        assert call["params"]["index"] == Neo4jGraphRepo.VECTOR_INDEX
        assert call["params"]["limit"] == 7
        assert call["params"]["vec"] == vec

    def test_deduplicates_and_sorts_skills(self):
        driver = _StubDriver([
            _vector_row("freelancer-a", "A", 1.0, skills=["React", "react", "Docker", None]),
        ])
        profile, _ = _repo_with(driver).retrieve_by_embedding([0.1] * 384)[0]
        assert profile.skills == ("docker", "react")

    def test_null_numeric_properties_coalesce(self):
        row = _vector_row("freelancer-a", "A", 1.0)
        row.update(trust=None, deliveries=None, avg_ast=None, rate=None)
        profile, _ = _repo_with(_StubDriver([row])).retrieve_by_embedding([0.1] * 384)[0]

        assert profile.trust_score == 0.0
        assert profile.deliveries == 0
        assert profile.avg_ast == 0.0
        assert profile.hourly_rate_cents == 0


class TestDegradation:
    """A ranked-but-degraded answer beats a 500 — but it must not be silent."""

    def test_falls_back_when_the_driver_is_unavailable(self):
        repo = Neo4jGraphRepo("bolt://nowhere:7687", "neo4j", "pw")
        repo._driver = None
        # _ensure_driver will fail to connect; the fallback must still answer.
        results = repo.retrieve_by_embedding([0.1] * 384, limit=3)
        assert len(results) == 3
        assert all(isinstance(p, FreelancerProfile) for p, _ in results)

    def test_falls_back_when_the_query_raises(self):
        results = _repo_with(_StubDriver(raises=True)).retrieve_by_embedding([0.1] * 384, limit=2)
        assert len(results) == 2

    def test_an_empty_index_degrades_rather_than_reporting_no_candidates(self):
        # An empty result means the index exists but nothing was indexed — the
        # graph was seeded without running the vector seeder. That is
        # "unmeasured", not "nothing matches"; returning [] would hand the
        # matchmaker an empty candidate set it would treat as final.
        results = _repo_with(_StubDriver([])).retrieve_by_embedding([0.1] * 384, limit=4)
        assert len(results) == 4
        assert all(score == 0.0 for _, score in results), "degraded scores must be an explicit 0.0"


class TestUpdateTrustScore:
    def test_reports_success_only_when_neo4j_acknowledged_the_write(self):
        driver = _StubDriver([_Record(id="freelancer-priya")])
        assert _repo_with(driver).update_trust_score("freelancer-priya", 0.77) is True

    def test_reports_failure_when_no_node_matched(self):
        assert _repo_with(_StubDriver([])).update_trust_score("nope", 0.5) is False

    def test_a_fallback_write_is_not_reported_as_persisted(self):
        # The bug this pins: the fallback writes to an in-process dict that dies
        # with the process and is invisible to other replicas, and it used to
        # return True — so /xai/score asserted durability for a value that had
        # none.
        repo = _repo_with(_StubDriver(raises=True))
        assert repo.update_trust_score("freelancer-priya", 0.77) is False

    def test_the_fallback_write_still_happens(self):
        # Only the claim was wrong, not the write: a later read in the same
        # process must still be consistent.
        repo = _repo_with(_StubDriver(raises=True))
        repo.update_trust_score("freelancer-priya", 0.77)
        updated = {f.id: f for f in repo._fallback.all_freelancers()}["freelancer-priya"]
        assert updated.trust_score == 0.77


# ── Layer 3: live Neo4j ─────────────────────────────────────────────────────


def _neo4j_available() -> bool:
    try:
        from neo4j import GraphDatabase
    except ImportError:
        return False
    try:
        driver = GraphDatabase.driver(
            os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
            auth=(
                os.environ.get("NEO4J_USER", "neo4j"),
                os.environ.get("NEO4J_PASSWORD", "assurecode_local_dev"),
            ),
            connection_timeout=2.0,
        )
        driver.verify_connectivity()
        records, _, _ = driver.execute_query(
            "MATCH (f:Freelancer) WHERE f.embedding IS NOT NULL RETURN count(f) AS n"
        )
        driver.close()
        return bool(records) and records[0]["n"] > 0
    except Exception:
        return False


NEO4J_UP = _neo4j_available()
if not NEO4J_UP:
    print(
        "[skip] Neo4j integration — needs a running Neo4j seeded with vectors "
        "(`npm run seed:neo4j && python tools/seed-neo4j-vectors.py`). "
        "These tests were SKIPPED, not passed."
    )


@pytest.mark.skipif(not NEO4J_UP, reason="requires a vector-seeded Neo4j")
class TestLiveNeo4j:
    @pytest.fixture(scope="class")
    def repo(self):
        return Neo4jGraphRepo(
            os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
            os.environ.get("NEO4J_USER", "neo4j"),
            os.environ.get("NEO4J_PASSWORD", "assurecode_local_dev"),
        )

    @pytest.fixture(scope="class")
    def embedder(self):
        from app.ports.embedder import SentenceTransformerEmbedder

        return SentenceTransformerEmbedder("all-MiniLM-L6-v2", dim=384)

    def test_reads_the_seeded_roster(self, repo):
        profiles = repo.all_freelancers()
        assert len(profiles) == 12
        assert {p.id for p in profiles} >= {"freelancer-priya", "freelancer-chen"}

    def test_returns_real_similarities_not_zeros(self, repo, embedder):
        # The regression this whole change exists to fix.
        results = repo.retrieve_by_embedding(embedder.embed("react typescript frontend").tolist(), limit=5)
        assert len(results) == 5
        assert any(score > 0.1 for _, score in results), "all-zero scores means the stub is back"

    def test_results_are_sorted_by_descending_similarity(self, repo, embedder):
        results = repo.retrieve_by_embedding(embedder.embed("python fastapi backend").tolist(), limit=8)
        scores = [s for _, s in results]
        assert scores == sorted(scores, reverse=True)

    def test_similarities_are_in_the_cosine_range(self, repo, embedder):
        # A value above 1.0 would mean the un-rescale is missing; the raw index
        # score for a near-identical pair is ~1.0 and would pass a naive
        # "<= 1.0" check, so the discriminating assertion is the spread below.
        results = repo.retrieve_by_embedding(embedder.embed("golang microservices").tolist(), limit=12)
        for _, score in results:
            assert -1.0 <= score <= 1.0

    def test_unrelated_queries_score_near_or_below_zero(self, repo, embedder):
        # The check that actually detects a missing un-rescale. Raw Neo4j scores
        # are bounded below by 0.5 for orthogonal vectors, so if ANY result for
        # a deliberately unrelated brief lands below 0.4, the conversion ran.
        results = repo.retrieve_by_embedding(
            embedder.embed("competitive ballroom dancing adjudication").tolist(), limit=12
        )
        assert min(s for _, s in results) < 0.4, (
            "no result scored below 0.4 for an unrelated brief — scores look like "
            "raw (1+cos)/2 index scores rather than converted cosines"
        )

    def test_a_domain_specialist_wins_its_own_domain(self, repo, embedder):
        results = repo.retrieve_by_embedding(
            embedder.embed("solidity ethereum smart contract web3").tolist(), limit=3
        )
        assert results[0][0].id == "freelancer-chen"


# ── Layer 3b: cross-backend parity ──────────────────────────────────────────


def _postgres_available() -> bool:
    """True when Postgres is reachable AND its profile vectors are indexed.

    Probes through `retrieve_by_embedding` rather than by inspecting
    `FreelancerProfile.embedding`: `_PROFILE_COLUMNS` does not select
    `profile_embedding`, so that attribute is empty for every row even on a
    fully seeded database. Checking it made this suite skip unconditionally —
    silently, and while reporting green.

    Distinct, non-zero similarities are the signal that the vector query really
    ran; the fallback path returns 0.0 for everything.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        return False
    try:
        from app.ports.graph_repo import PostgresGraphRepo

        repo = PostgresGraphRepo(database_url=url)
        scores = [s for _, s in repo.retrieve_by_embedding([0.05] * 384, limit=5)]
        return len(scores) >= 2 and len(set(scores)) > 1
    except Exception:
        return False


PG_UP = _postgres_available()
if NEO4J_UP and not PG_UP:
    print(
        "[skip] Cross-backend parity — needs DATABASE_URL pointing at a Postgres "
        "seeded by tools/seed-users.py. This test was SKIPPED, not passed."
    )


@pytest.mark.skipif(not (NEO4J_UP and PG_UP), reason="requires both backends seeded")
class TestCrossBackendParity:
    """The test that makes the 'Neo4j is a real backend' claim defensible.

    Both adapters index the same 12 profiles, embedded from the same text with
    the same model. If they disagree on ordering, one of them is wrong — and the
    most likely cause is the score-scale mismatch, which produces no error.
    """

    QUERIES: ClassVar[list[str]] = [
        "react typescript frontend developer",
        "python fastapi backend api",
        "solidity ethereum smart contract",
        "kubernetes terraform docker infrastructure",
    ]

    @pytest.fixture(scope="class")
    def backends(self):
        from app.ports.embedder import SentenceTransformerEmbedder
        from app.ports.graph_repo import PostgresGraphRepo

        return (
            Neo4jGraphRepo(
                os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
                os.environ.get("NEO4J_USER", "neo4j"),
                os.environ.get("NEO4J_PASSWORD", "assurecode_local_dev"),
            ),
            PostgresGraphRepo(database_url=os.environ["DATABASE_URL"]),
            SentenceTransformerEmbedder("all-MiniLM-L6-v2", dim=384),
        )

    @pytest.mark.parametrize("query", QUERIES)
    def test_same_top_3_ordering(self, backends, query):
        neo, pg, embedder = backends
        vec = embedder.embed(query).tolist()

        neo_ids = [p.id for p, _ in neo.retrieve_by_embedding(vec, limit=3)]
        pg_ids = [p.id for p, _ in pg.retrieve_by_embedding(vec, limit=3)]

        assert neo_ids == pg_ids, f"backends disagree on ranking for {query!r}"

    @pytest.mark.parametrize("query", QUERIES)
    def test_similarity_values_agree(self, backends, query):
        # Ordering can coincide while the values differ by a constant — which is
        # exactly what a missing un-rescale produces, and what would silently
        # shift the composite score in matchmaker.
        neo, pg, embedder = backends
        vec = embedder.embed(query).tolist()

        neo_scores = {p.id: s for p, s in neo.retrieve_by_embedding(vec, limit=5)}
        pg_scores = {p.id: s for p, s in pg.retrieve_by_embedding(vec, limit=5)}

        for fid in set(neo_scores) & set(pg_scores):
            assert neo_scores[fid] == pytest.approx(pg_scores[fid], abs=0.02), (
                f"{fid}: neo4j {neo_scores[fid]:.4f} vs postgres {pg_scores[fid]:.4f} "
                "— check neo4j_score_to_cosine"
            )

    def test_the_two_backends_return_the_same_roster(self, backends):
        neo, pg, _ = backends
        assert {p.id for p in neo.all_freelancers()} == {p.id for p in pg.all_freelancers()}
