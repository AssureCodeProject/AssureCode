"""Graph repository port: read freelancers + skills from the knowledge graph.

The matchmaker ranks freelancers by skill overlap and trust score. This port
abstracts where that data comes from:
  - Neo4jGraphRepo: live Neo4j via the official driver
  - InMemoryGraphRepo: deterministic fixture for tests/offline startup
"""
from __future__ import annotations

import os
from collections.abc import Sequence
from contextlib import closing
from dataclasses import dataclass, replace
from typing import Any, Protocol, runtime_checkable

import numpy as np


def to_pgvector_literal(values: Sequence[float]) -> str:
    """Format a vector as the text literal pgvector's `::vector` cast accepts.

    Shared with tools/seed-users.py on purpose: the query vector formatted here
    is compared against profile vectors the seed script formatted, so the two
    must round to the same precision or the comparison drifts.
    """
    return "[" + ",".join(f"{float(x):.7f}" for x in values) + "]"


def neo4j_score_to_cosine(score: float) -> float:
    """Convert a Neo4j cosine index score back to a raw cosine similarity.

    THIS IS NOT COSMETIC. The two vector backends report similarity on different
    scales, and nothing downstream would raise if they were mixed up:

      * pgvector — `1 - (a <=> b)` is the raw cosine, in [-1, 1].
      * Neo4j    — a `vector.similarity_function: 'cosine'` index returns a
                   *rescaled* score `(1 + cos) / 2`, in [0, 1].

    `matchmaker` uses this value directly as the skill term
    (`skill_score = max(0.0, similarity)`, then `w_skill * skill_score`). Feeding
    it a rescaled score is not an error, just a different number: every
    candidate's skill term shifts upward and compresses, so Neo4j and Postgres
    produce *different rankings for the same query* with no exception, no log
    line, and no failing test. For a system whose matchmaking numbers are a
    reported result, that is a silent correctness bug in a results table.

    Inverting `(1 + cos) / 2` gives `2 * score - 1`. Clamped to [-1, 1] because
    floating-point error at the extremes can push a score a hair outside its
    range, and a cosine of 1.0000000002 is noise rather than information.

    Verified by the parity test in apps/ai-service/tests/test_graph_repo_neo4j.py,
    which asserts both backends return the same top-k ordering AND
    similarity values within tolerance for the same query vector.
    """
    return max(-1.0, min(1.0, 2.0 * float(score) - 1.0))


def cosine_to_neo4j_score(cosine: float) -> float:
    """Inverse of `neo4j_score_to_cosine`. Used by tests to build fixtures."""
    return (1.0 + float(cosine)) / 2.0


def _psycopg():
    """Return whichever psycopg driver is installed (psycopg2 or psycopg 3)."""
    try:
        import psycopg2

        return psycopg2
    except ImportError:
        import psycopg

        return psycopg


@dataclass(frozen=True)
class FreelancerProfile:
    """A freelancer as the matchmaker sees them."""

    id: str
    name: str
    trust_score: float            # XAI_Trust_Score in [0, 1]
    skills: tuple[str, ...]       # skill names, lowercased
    deliveries: int = 0
    avg_ast: float = 0.0          # maintainability score [0, 100]
    hourly_rate_cents: int = 0
    # Precomputed profile embedding, L2-normalized. Only set by callers that
    # have one available outside a real vector index — e.g. tools/eval's
    # synthetic pools. Empty for the hardcoded fixture profiles below, which
    # is the honest "no index, no vector" case retrieve_by_embedding degrades
    # for (see its Protocol docstring).
    embedding: tuple[float, ...] = ()


@runtime_checkable
class GraphRepo(Protocol):
    """Read-only access to the matchmaking graph."""

    def all_freelancers(self) -> Sequence[FreelancerProfile]:
        ...

    def retrieve_by_embedding(
        self, query_vector: Sequence[float], limit: int = 50
    ) -> Sequence[tuple[FreelancerProfile, float]]:
        """Top-`limit` freelancers by profile-embedding similarity to `query_vector`.

        Returns (profile, cosine_similarity) pairs, pre-sorted by similarity
        descending. Backends with a real vector index (PostgresGraphRepo) do
        this as a single indexed query; backends without one degrade to
        `all_freelancers()` with similarity 0.0 — an explicit "unmeasured",
        not a fabricated score, so the caller's composite ranking falls back
        to trust + history only rather than silently pretending to know
        semantic relevance it has no way to compute.
        """
        ...

    def update_trust_score(self, freelancer_id: str, trust_score: float) -> bool:
        """Persist a computed trust score. True only if it was durably stored.

        Declared here rather than left to duck-typing. All three adapters have
        always implemented it, but the single call site reached it through
        `hasattr(graph_repo, "update_trust_score")` and assigned the result to
        `trust_score_persisted` in the /xai/score response — so a backend that
        silently lacked the method reported `false`, and one whose write failed
        into an in-process dict reported `true`. Neither is a property of the
        Protocol anyone could check.
        """
        ...


class InMemoryGraphRepo:
    """Static fixture repo — mirrors the 12 freelancers in tools/seed-users.py.

    Used by tests and as the fallback when a live backend is unreachable. Keeps
    the matchmaker runnable end-to-end without a graph or a database.

    KEEP THIS IN SYNC with tools/seed-users.py's FREELANCERS and
    infra/seed/neo4j/V001__seed_matchmaking.cypher — those two are already
    identical, and this is the copy that drifts. It previously held 8 entries in
    which `freelancer-chen` was named "Chen Wei" (reversed) with Python/AI
    skills that now belong to `freelancer-alex`, `freelancer-sarah` carried the
    front-end skills that belong to `freelancer-chen`, a `freelancer-devon`
    existed nowhere else, and alex/david/maya/omar/maria were missing entirely.
    Because tests run against this fixture by default, assertions written here
    were describing a roster the rest of the system had moved on from.

    It cannot import the roster directly: tools/seed-users.py imports from this
    module, so the dependency only runs one way. The generator that produced
    these entries is in the same script, and re-running it is how to re-sync.
    """

    def __init__(self) -> None:
        self._freelancers: dict[str, FreelancerProfile] = {
            "freelancer-priya": FreelancerProfile(
                id="freelancer-priya",
                name="Priya Sharma",
                trust_score=0.92,
                skills=("docker", "fastify", "node.js", "postgresql", "react", "typescript"),
                deliveries=18,
                avg_ast=87.0,
                hourly_rate_cents=8500,
            ),
            "freelancer-marcus": FreelancerProfile(
                id="freelancer-marcus",
                name="Marcus Lindgren",
                trust_score=0.81,
                skills=("aws", "docker", "fastapi", "postgresql", "python", "redis"),
                deliveries=11,
                avg_ast=79.0,
                hourly_rate_cents=7200,
            ),
            "freelancer-aisha": FreelancerProfile(
                id="freelancer-aisha",
                name="Aisha Okafor",
                trust_score=0.76,
                skills=("cypress", "jest", "react", "tailwind", "typescript"),
                deliveries=7,
                avg_ast=83.0,
                hourly_rate_cents=6000,
            ),
            "freelancer-tomas": FreelancerProfile(
                id="freelancer-tomas",
                name="Tomás Rivera",
                trust_score=0.64,
                skills=("docker", "node.js", "postgresql", "react"),
                deliveries=4,
                avg_ast=71.0,
                hourly_rate_cents=4500,
            ),
            "freelancer-elena": FreelancerProfile(
                id="freelancer-elena",
                name="Elena Rostova",
                trust_score=0.95,
                skills=("docker", "go", "owasp", "postgresql", "python", "rust", "security"),
                deliveries=22,
                avg_ast=91.0,
                hourly_rate_cents=9500,
            ),
            "freelancer-chen": FreelancerProfile(
                id="freelancer-chen",
                name="Wei Chen",
                trust_score=0.88,
                skills=("ethereum", "hardhat", "react", "solidity", "typescript", "web3"),
                deliveries=14,
                avg_ast=84.0,
                hourly_rate_cents=9000,
            ),
            "freelancer-alex": FreelancerProfile(
                id="freelancer-alex",
                name="Alex Mercer",
                trust_score=0.89,
                skills=("fastapi", "langchain", "python", "pytorch", "rag", "vector.db"),
                deliveries=16,
                avg_ast=88.0,
                hourly_rate_cents=8800,
            ),
            "freelancer-sarah": FreelancerProfile(
                id="freelancer-sarah",
                name="Sarah Jenkins",
                trust_score=0.83,
                skills=("aws", "ci/cd", "docker", "kubernetes", "prometheus", "terraform"),
                deliveries=12,
                avg_ast=82.0,
                hourly_rate_cents=7800,
            ),
            "freelancer-david": FreelancerProfile(
                id="freelancer-david",
                name="David Kim",
                trust_score=0.79,
                skills=("android", "flutter", "ios", "react.native", "typescript"),
                deliveries=9,
                avg_ast=78.0,
                hourly_rate_cents=6800,
            ),
            "freelancer-maya": FreelancerProfile(
                id="freelancer-maya",
                name="Maya Patel",
                trust_score=0.91,
                skills=("kafka", "neo4j", "postgresql", "redis", "snowflake", "sql"),
                deliveries=19,
                avg_ast=89.0,
                hourly_rate_cents=8900,
            ),
            "freelancer-omar": FreelancerProfile(
                id="freelancer-omar",
                name="Omar Farooq",
                trust_score=0.85,
                skills=("go", "grpc", "kubernetes", "microservices", "postgresql", "rust"),
                deliveries=13,
                avg_ast=85.0,
                hourly_rate_cents=8200,
            ),
            "freelancer-maria": FreelancerProfile(
                id="freelancer-maria",
                name="Maria Garcia",
                trust_score=0.87,
                skills=("graphql", "next.js", "tailwind", "typescript", "vue.js"),
                deliveries=15,
                avg_ast=86.0,
                hourly_rate_cents=7500,
            ),
        }

    def update_trust_score(self, freelancer_id: str, trust_score: float) -> bool:
        if freelancer_id in self._freelancers:
            fp = self._freelancers[freelancer_id]
            self._freelancers[freelancer_id] = replace(fp, trust_score=trust_score)
            return True
        return False

    def all_freelancers(self) -> Sequence[FreelancerProfile]:
        return tuple(self._freelancers.values())

    def retrieve_by_embedding(
        self, query_vector: Sequence[float], limit: int = 50
    ) -> Sequence[tuple[FreelancerProfile, float]]:
        """Real cosine ranking when profiles carry an embedding (e.g. tools/eval's
        synthetic pools, which attach one precisely to exercise this path), else
        the honest "unmeasured" 0.0 fallback for the hardcoded fixture profiles.

        This is an in-process brute-force scan, not an indexed lookup — fine for
        eval-scale synthetic pools and tests, wrong for a real deployment, which
        is exactly why PostgresGraphRepo exists as the production adapter.
        """
        profiles = self.all_freelancers()
        with_embedding = [p for p in profiles if p.embedding]
        if not with_embedding:
            return [(p, 0.0) for p in profiles[:limit]]

        q = np.asarray(query_vector, dtype=np.float64)
        scored = [(p, float(np.dot(q, np.asarray(p.embedding, dtype=np.float64)))) for p in with_embedding]
        scored.sort(key=lambda pair: pair[1], reverse=True)
        return scored[:limit]


class Neo4jGraphRepo:
    """Live Neo4j adapter. Connects lazily; degrades to InMemory on failure.

    The matchmaker is non-blocking-critical — if Neo4j is briefly unreachable
    we still return ranked results from the in-memory mirror rather than 500.
    """

    def __init__(self, uri: str, user: str, password: str) -> None:
        self._uri = uri
        self._user = user
        self._password = password
        self._driver = None
        self._fallback = InMemoryGraphRepo()

    def update_trust_score(self, freelancer_id: str, trust_score: float) -> bool:
        """Persist to Neo4j. Returns False when the write did not reach it.

        The fallback deliberately does NOT report success. It writes to
        `InMemoryGraphRepo`'s dict, which dies with the process and is invisible
        to every other replica — so returning True there made
        `trust_score_persisted` in the /xai/score response assert durability for
        a value that had none. The in-memory write is still performed, so a
        subsequent read in the same process is consistent; only the claim about
        it is corrected.
        """
        self._ensure_driver()
        if self._driver is None:
            self._fallback.update_trust_score(freelancer_id, trust_score)
            return False
        try:
            cypher = "MATCH (f:Freelancer {id: $id}) SET f.XAI_Trust_Score = $trust RETURN f.id"
            records, _, _ = self._driver.execute_query(cypher, id=freelancer_id, trust=trust_score)
            return len(records) > 0
        except Exception:
            self._fallback.update_trust_score(freelancer_id, trust_score)
            return False

    def _ensure_driver(self) -> None:
        if self._driver is not None:
            return
        try:
            from neo4j import GraphDatabase

            # Bounded timeouts, because `GraphDatabase.driver()` does not connect
            # — the first query does. With the library defaults (30s connection
            # timeout, 60s acquisition, 30s of transaction retries) an
            # unreachable Neo4j stalled the caller for ~90 seconds before the
            # `except` below could fall back. That was measured on the trust
            # score endpoint, where persisting the score to the graph is a side
            # effect: the score itself was already computed, and the request
            # hung anyway. A degradation path that takes longer than the client
            # is willing to wait is not a degradation path.
            self._driver = GraphDatabase.driver(
                self._uri,
                auth=(self._user, self._password),
                connection_timeout=float(os.environ.get("NEO4J_CONNECTION_TIMEOUT", "3.0")),
                connection_acquisition_timeout=float(
                    os.environ.get("NEO4J_ACQUISITION_TIMEOUT", "5.0")
                ),
                max_transaction_retry_time=float(os.environ.get("NEO4J_RETRY_TIME", "2.0")),
            )
        except Exception:  # pragma: no cover — import/connect failures are environment-bound
            self._driver = None

    def all_freelancers(self) -> Sequence[FreelancerProfile]:
        self._ensure_driver()
        if self._driver is None:
            return self._fallback.all_freelancers()
        try:
            return self._query_freelancers()
        except Exception:  # pragma: no cover — live DB only
            return self._fallback.all_freelancers()

    #: Name of the vector index created by tools/seed-neo4j-vectors.py.
    VECTOR_INDEX = "freelancer_embeddings"

    def retrieve_by_embedding(
        self, query_vector: Sequence[float], limit: int = 50
    ) -> Sequence[tuple[FreelancerProfile, float]]:
        """Top-`limit` freelancers by cosine similarity, via the vector index.

        This used to return `[(p, 0.0) for p in all_freelancers()]` — similarity
        zero for everyone — because the Cypher seed stored no vectors. Selecting
        this backend therefore deleted the semantic half of matchmaking silently:
        `matchmaker` multiplies this value by `w_skill`, so every candidate's
        skill term became 0 and ranking collapsed to trust + delivery count.

        Falls back to the in-memory mirror on any failure, including a missing
        index, for the reason in the class docstring: matchmaking is not
        blocking-critical and a ranked-but-degraded answer beats a 500.
        """
        self._ensure_driver()
        if self._driver is None:
            return self._fallback.retrieve_by_embedding(query_vector, limit)
        try:
            rows = self._query_by_vector(list(float(x) for x in query_vector), limit)
            # An empty result means the index exists but nothing is indexed —
            # i.e. the graph was seeded without running the vector seeder. That
            # is "unmeasured", not "nothing matches", so degrade rather than
            # report an empty candidate set the matchmaker would treat as final.
            return rows if rows else self._fallback.retrieve_by_embedding(query_vector, limit)
        except Exception:  # pragma: no cover — live DB only
            return self._fallback.retrieve_by_embedding(query_vector, limit)

    def _query_by_vector(  # pragma: no cover — live DB only
        self, query_vector: list[float], limit: int
    ) -> list[tuple[FreelancerProfile, float]]:
        cypher = """
        CALL db.index.vector.queryNodes($index, $limit, $vec)
        YIELD node AS f, score
        OPTIONAL MATCH (f)-[:HAS_SKILL]->(s:Skill)
        RETURN f.id AS id, f.name AS name, f.XAI_Trust_Score AS trust,
               f.deliveries AS deliveries, f.avgAST AS avg_ast,
               f.hourlyRateCents AS rate,
               collect(DISTINCT toLower(s.name)) AS skills,
               score AS score
        ORDER BY score DESC
        """
        records, _, _ = self._driver.execute_query(  # type: ignore[union-attr]
            cypher, index=self.VECTOR_INDEX, limit=int(limit), vec=query_vector
        )
        return [(self._profile_from_record(r), neo4j_score_to_cosine(float(r["score"]))) for r in records]

    @staticmethod
    def _profile_from_record(r) -> FreelancerProfile:  # pragma: no cover — exercised via stubs
        """Map one Cypher record to a profile.

        Lowercasing happens here as well as in the Cypher's `toLower(s.name)`.
        That is deliberate duplication, not an oversight: skill names are
        compared against lowercased query tokens downstream, so a single Cypher
        edit that dropped `toLower` would silently stop every skill matching
        without failing anything. Normalisation belongs with the type that
        promises it, and it is idempotent, so paying for it twice costs nothing.
        """
        skills = {str(s).lower() for s in (r["skills"] or []) if s}
        return FreelancerProfile(
            id=r["id"],
            name=r["name"],
            trust_score=float(r["trust"] or 0.0),
            skills=tuple(sorted(skills)),
            deliveries=int(r["deliveries"] or 0),
            avg_ast=float(r["avg_ast"] or 0.0),
            hourly_rate_cents=int(r["rate"] or 0),
        )

    def _query_freelancers(self) -> Sequence[FreelancerProfile]:  # pragma: no cover — live DB only
        cypher = """
        MATCH (f:Freelancer)
        OPTIONAL MATCH (f)-[hs:HAS_SKILL]->(s:Skill)
        RETURN f.id AS id, f.name AS name, f.XAI_Trust_Score AS trust,
               f.deliveries AS deliveries, f.avgAST AS avg_ast,
               f.hourlyRateCents AS rate,
               collect(DISTINCT toLower(s.name)) AS skills
        """
        records, _, _ = self._driver.execute_query(cypher)  # type: ignore[union-attr]
        # Same mapping as the vector path, so the two cannot drift in how they
        # normalise skills or coalesce nulls.
        return [self._profile_from_record(r) for r in records]


class PostgresGraphRepo:
    """PostgreSQL + pgvector backed adapter for freelancer profiles.

    Reads profiles and vectors directly from `freelancer_profiles` + `users` tables.
    Fallback to InMemoryGraphRepo if connection fails.
    """

    # Columns 0-6 of every profile query, in the order _profile_from_row reads
    # them. Queries may append further columns (see retrieve_by_embedding).
    _PROFILE_COLUMNS = """
        f.freelancer_id, u.display_name, f.trust_score, f.skills,
        f.deliveries, f.avg_ast, f.hourly_rate_cents
    """

    # Bounded, because libpq's default is to wait indefinitely. Every method
    # here wraps its query in `except Exception -> self._fallback`, which reads
    # as a safe degradation but is not one without this: against an unreachable
    # host the connect never returns, so there is no exception to catch and the
    # fallback is unreachable. The request simply hangs. This is the same bound
    # PostgresScopeLog already applies, for the same reason — an unavailable
    # database has to fail, and failing has to take a bounded amount of time or
    # it is indistinguishable from working.
    CONNECT_TIMEOUT_SECONDS = int(os.environ.get("GRAPH_REPO_CONNECT_TIMEOUT", "5"))

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        self._fallback = InMemoryGraphRepo()

    def _connect(self):
        return _psycopg().connect(
            self._database_url, connect_timeout=self.CONNECT_TIMEOUT_SECONDS
        )

    @staticmethod
    def _profile_from_row(row: Sequence[Any]) -> FreelancerProfile:
        """Build a profile from the leading _PROFILE_COLUMNS of a result row."""
        skills = tuple(row[3]) if isinstance(row[3], (list, tuple)) else ()
        return FreelancerProfile(
            id=row[0],
            name=row[1],
            trust_score=float(row[2]),
            skills=skills,
            deliveries=int(row[4]),
            avg_ast=float(row[5]),
            hourly_rate_cents=int(row[6]),
        )

    def _fetch_all(self, sql: str, params: tuple = ()) -> list[tuple]:
        with closing(self._connect()) as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def all_freelancers(self) -> Sequence[FreelancerProfile]:
        try:
            rows = self._fetch_all(f"""
                SELECT {self._PROFILE_COLUMNS}
                FROM freelancer_profiles f
                JOIN users u ON u.user_id = f.freelancer_id
                ORDER BY f.trust_score DESC
            """)
            if not rows:
                return self._fallback.all_freelancers()
            return [self._profile_from_row(r) for r in rows]
        except Exception:
            return self._fallback.all_freelancers()

    def update_trust_score(self, freelancer_id: str, trust_score: float) -> bool:
        try:
            with closing(self._connect()) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE freelancer_profiles SET trust_score = %s WHERE freelancer_id = %s",
                        (trust_score, freelancer_id),
                    )
                conn.commit()
            return True
        except Exception:
            return self._fallback.update_trust_score(freelancer_id, trust_score)

    def retrieve_by_embedding(
        self, query_vector: Sequence[float], limit: int = 50
    ) -> Sequence[tuple[FreelancerProfile, float]]:
        """Top-`limit` freelancers by pgvector cosine distance, index-accelerated.

        `profile_embedding <=> $1` is the operator `idx_freelancer_profiles_hnsw`
        (V010) is built on — ordering by it directly is what lets Postgres use
        the HNSW index instead of a sequential scan. Ordering by the full
        composite score instead (skill/trust/history combined) would force a
        seq scan and discard the index entirely, which is why reranking happens
        as a second, separate step in Python over just this batch.

        Vectors are L2-normalized at embed time (both query and stored
        profiles use the same SentenceTransformerEmbedder), so
        `cosine_similarity = 1 - cosine_distance`.
        """
        try:
            vec_literal = to_pgvector_literal(query_vector)
            rows = self._fetch_all(
                f"""
                SELECT {self._PROFILE_COLUMNS},
                       1 - (f.profile_embedding <=> %s::vector) AS similarity
                FROM freelancer_profiles f
                JOIN users u ON u.user_id = f.freelancer_id
                ORDER BY f.profile_embedding <=> %s::vector
                LIMIT %s
                """,
                (vec_literal, vec_literal, limit),
            )
            if not rows:
                return self._fallback.retrieve_by_embedding(query_vector, limit)
            return [(self._profile_from_row(r), float(r[7])) for r in rows]
        except Exception:
            return self._fallback.retrieve_by_embedding(query_vector, limit)

