"""Graph repository port: read freelancers + skills from the knowledge graph.

The matchmaker ranks freelancers by skill overlap and trust score. This port
abstracts where that data comes from:
  - Neo4jGraphRepo: live Neo4j via the official driver
  - InMemoryGraphRepo: deterministic fixture for tests/offline startup
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Protocol, Sequence, runtime_checkable


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


@runtime_checkable
class GraphRepo(Protocol):
    """Read-only access to the matchmaking graph."""

    def all_freelancers(self) -> Sequence[FreelancerProfile]:
        ...


class InMemoryGraphRepo:
    """Static fixture repo — mirrors infra/seed/neo4j/V001__seed_matchmaking.cypher.

    Used by tests and as the fallback when NEO4J_URI is unreachable at startup.
    Keeps the matchmaker runnable end-to-end without a live graph.
    """

    def __init__(self) -> None:
        self._freelancers: dict[str, FreelancerProfile] = {
            "freelancer-priya": FreelancerProfile(
                id="freelancer-priya",
                name="Priya Sharma",
                trust_score=0.92,
                skills=("react", "typescript", "node.js", "fastify", "postgresql", "docker"),
                deliveries=18,
                avg_ast=87.0,
                hourly_rate_cents=8500,
            ),
            "freelancer-marcus": FreelancerProfile(
                id="freelancer-marcus",
                name="Marcus Lindgren",
                trust_score=0.81,
                skills=("python", "fastapi", "postgresql", "docker", "aws", "redis"),
                deliveries=11,
                avg_ast=79.0,
                hourly_rate_cents=7200,
            ),
            "freelancer-aisha": FreelancerProfile(
                id="freelancer-aisha",
                name="Aisha Okafor",
                trust_score=0.76,
                skills=("react", "typescript", "cypress", "jest", "tailwind"),
                deliveries=7,
                avg_ast=83.0,
                hourly_rate_cents=6000,
            ),
            "freelancer-tomas": FreelancerProfile(
                id="freelancer-tomas",
                name="Tomás Rivera",
                trust_score=0.64,
                skills=("react", "node.js", "postgresql", "docker"),
                deliveries=4,
                avg_ast=71.0,
                hourly_rate_cents=4500,
            ),
            "freelancer-elena": FreelancerProfile(
                id="freelancer-elena",
                name="Elena Rostova",
                trust_score=0.95,
                skills=("python", "security", "owasp", "docker", "rust", "go", "postgresql"),
                deliveries=22,
                avg_ast=91.0,
                hourly_rate_cents=9500,
            ),
            "freelancer-chen": FreelancerProfile(
                id="freelancer-chen",
                name="Chen Wei",
                trust_score=0.89,
                skills=("python", "fastapi", "ai", "llm", "rag", "pytorch", "vector.db", "langchain"),
                deliveries=15,
                avg_ast=86.0,
                hourly_rate_cents=9000,
            ),
            "freelancer-sarah": FreelancerProfile(
                id="freelancer-sarah",
                name="Sarah Jenkins",
                trust_score=0.88,
                skills=("react", "typescript", "solidity", "web3", "next.js", "tailwind", "ethereum"),
                deliveries=14,
                avg_ast=84.0,
                hourly_rate_cents=8800,
            ),
            "freelancer-devon": FreelancerProfile(
                id="freelancer-devon",
                name="Devon Vance",
                trust_score=0.85,
                skills=("docker", "kubernetes", "terraform", "aws", "devops", "ci/cd", "prometheus", "grafana"),
                deliveries=12,
                avg_ast=82.0,
                hourly_rate_cents=7800,
            ),
        }

    def update_trust_score(self, freelancer_id: str, trust_score: float) -> bool:
        if freelancer_id in self._freelancers:
            fp = self._freelancers[freelancer_id]
            self._freelancers[freelancer_id] = FreelancerProfile(
                id=fp.id,
                name=fp.name,
                trust_score=trust_score,
                skills=fp.skills,
                deliveries=fp.deliveries,
                avg_ast=fp.avg_ast,
                hourly_rate_cents=fp.hourly_rate_cents,
            )
            return True
        return False

    def all_freelancers(self) -> Sequence[FreelancerProfile]:
        return tuple(self._freelancers.values())


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
        self._ensure_driver()
        if self._driver is None:
            return self._fallback.update_trust_score(freelancer_id, trust_score)
        try:
            cypher = "MATCH (f:Freelancer {id: $id}) SET f.XAI_Trust_Score = $trust RETURN f.id"
            records, _, _ = self._driver.execute_query(cypher, id=freelancer_id, trust=trust_score)
            return len(records) > 0
        except Exception:
            return self._fallback.update_trust_score(freelancer_id, trust_score)

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

    def _query_freelancers(self) -> Sequence[FreelancerProfile]:  # pragma: no cover — live DB only
        cypher = """
        MATCH (f:Freelancer)
        OPTIONAL MATCH (f)-[hs:HAS_SKILL]->(s:Skill)
        RETURN f.id AS id, f.name AS name, f.XAI_Trust_Score AS trust,
               f.deliveries AS deliveries, f.avgAST AS avg_ast,
               f.hourlyRateCents AS rate,
               collect(DISTINCT toLower(s.name)) AS skills
        """
        profiles: list[FreelancerProfile] = []
        records, _, _ = self._driver.execute_query(cypher)  # type: ignore[union-attr]
        for r in records:
            skills = tuple(sorted({s for s in (r["skills"] or []) if s}))
            profiles.append(
                FreelancerProfile(
                    id=r["id"],
                    name=r["name"],
                    trust_score=float(r["trust"] or 0.0),
                    skills=skills,
                    deliveries=int(r["deliveries"] or 0),
                    avg_ast=float(r["avg_ast"] or 0.0),
                    hourly_rate_cents=int(r["rate"] or 0),
                )
            )
        return profiles


class PostgresGraphRepo:
    """PostgreSQL + pgvector backed adapter for freelancer profiles.

    Reads profiles and vectors directly from `freelancer_profiles` + `users` tables.
    Fallback to InMemoryGraphRepo if connection fails.
    """

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        self._fallback = InMemoryGraphRepo()

    def all_freelancers(self) -> Sequence[FreelancerProfile]:
        try:
            try:
                import psycopg2 as psycopg
            except ImportError:
                import psycopg

            conn = psycopg.connect(self._database_url)
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT f.freelancer_id, u.display_name, f.trust_score, f.skills,
                           f.deliveries, f.avg_ast, f.hourly_rate_cents
                    FROM freelancer_profiles f
                    JOIN users u ON u.user_id = f.freelancer_id
                    ORDER BY f.trust_score DESC
                """)
                rows = cur.fetchall()
            conn.close()

            if not rows:
                return self._fallback.all_freelancers()

            profiles = []
            for r in rows:
                skills = tuple(r[3]) if isinstance(r[3], (list, tuple)) else ()
                profiles.append(
                    FreelancerProfile(
                        id=r[0],
                        name=r[1],
                        trust_score=float(r[2]),
                        skills=skills,
                        deliveries=int(r[4]),
                        avg_ast=float(r[5]),
                        hourly_rate_cents=int(r[6]),
                    )
                )
            return profiles
        except Exception:
            return self._fallback.all_freelancers()

    def update_trust_score(self, freelancer_id: str, trust_score: float) -> bool:
        try:
            try:
                import psycopg2 as psycopg
            except ImportError:
                import psycopg

            conn = psycopg.connect(self._database_url)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE freelancer_profiles SET trust_score = %s WHERE freelancer_id = %s",
                    (trust_score, freelancer_id),
                )
            conn.commit()
            conn.close()
            return True
        except Exception:
            return self._fallback.update_trust_score(freelancer_id, trust_score)

