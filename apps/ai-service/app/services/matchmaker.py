"""NLP matchmaker: rank freelancers against a contract's requirements.

Pipeline (retrieve-then-rerank):
  1. Embed the requirements text (port: Embedder).
  2. Retrieve: top ~50 candidates by pgvector cosine distance, index-accelerated
     (GraphRepo.retrieve_by_embedding). Profile vectors are computed once at
     seed/write time, not per request — see tools/seed-users.py.
  3. Rerank: composite score over just those candidates —
       Score = w_skill * cosine(req, profile)        # semantic skill match
              + w_trust * trust_score                  # explainable trust
              + w_history * normalized_history          # delivery track record
  4. Sort desc, return top-k with a per-freelancer explanation.

Two stages, not one: HNSW only accelerates ordering by the distance operator
itself. Ordering directly by the composite would force a sequential scan and
discard the index, so retrieval and reranking stay separate steps.

The semantic term lets "React frontend" match a freelancer whose profile says
"TypeScript React Node" even without exact keyword overlap. The trust and
history terms are the XAI legibility guarantees — every score decomposes into
named, auditable components.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from app.ports.embedder import Embedder
from app.ports.graph_repo import GraphRepo

RETRIEVAL_POOL_SIZE = 50


def _requirement_tokens(requirements: str) -> set[str]:
    """Lowercased requirement words, stripped of leading/trailing punctuation.

    Used only to report *which* skills overlapped, for the explanation — the
    skill score itself is the embedding cosine, not this token set.
    """
    tokens = {re.sub(r"^\W+|\W+$", "", t.lower()) for t in requirements.split()}
    tokens.discard("")
    return tokens


@dataclass(frozen=True)
class MatchExplanation:
    """Per-freelancer score breakdown — returned to the client for XAI."""

    skill_score: float
    trust_score: float
    history_score: float
    matched_skills: tuple[str, ...]


@dataclass(frozen=True)
class MatchResult:
    freelancer_id: str
    freelancer_name: str
    trust_score: float
    score: float                  # weighted total in [0, 1]
    explanation: MatchExplanation
    hourly_rate_cents: int


class Matchmaker:
    def __init__(
        self,
        embedder: Embedder,
        graph: GraphRepo,
        w_skill: float = 0.5,
        w_trust: float = 0.35,
        w_history: float = 0.15,
        retrieval_pool_size: int = RETRIEVAL_POOL_SIZE,
    ) -> None:
        self._embedder = embedder
        self._graph = graph
        self._w_skill = w_skill
        self._w_trust = w_trust
        self._w_history = w_history
        # Configurable mainly so evaluation/consistency-check tooling can ask
        # for a pool covering an entire synthetic population — production
        # deployments should leave this at the default; a larger pool trades
        # the HNSW index's speed advantage for exhaustiveness.
        self._retrieval_pool_size = retrieval_pool_size

    def match(self, requirements: str, top_k: int = 5) -> list[MatchResult]:
        req_vec = self._embedder.embed(requirements)

        candidates = self._graph.retrieve_by_embedding(
            req_vec.tolist(), limit=self._retrieval_pool_size
        )
        if not candidates:
            return []

        # Normalize the history term over this candidate batch, not a global
        # table scan — consistent with "only touch what retrieval returned"
        # and, at any realistic pool size, indistinguishable from a global max.
        max_deliveries = max((f.deliveries for f, _ in candidates), default=1) or 1

        req_tokens = _requirement_tokens(requirements)

        results: list[MatchResult] = []
        for f, similarity in candidates:
            skill_score = max(0.0, float(similarity))  # clamp negative cosine to 0
            trust_score = float(np.clip(f.trust_score, 0.0, 1.0))
            history_score = float(f.deliveries) / float(max_deliveries)

            total = (
                self._w_skill * skill_score
                + self._w_trust * trust_score
                + self._w_history * history_score
            )

            # Surface the requirement tokens that overlap the freelancer's skills.
            matched = tuple(sorted(req_tokens & set(f.skills)))

            results.append(
                MatchResult(
                    freelancer_id=f.id,
                    freelancer_name=f.name,
                    trust_score=trust_score,
                    score=round(total, 4),
                    explanation=MatchExplanation(
                        skill_score=round(skill_score, 4),
                        trust_score=round(trust_score, 4),
                        history_score=round(history_score, 4),
                        matched_skills=matched,
                    ),
                    hourly_rate_cents=f.hourly_rate_cents,
                )
            )

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:top_k]
