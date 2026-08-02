"""NLP matchmaker: rank freelancers against a contract's requirements.

Pipeline:
  1. Embed the requirements text (port: Embedder).
  2. For each freelancer, embed their skill "profile string" the same way.
  3. Score = w_skill * cosine(req, profile)        # semantic skill match
           + w_trust * trust_score                  # explainable trust
           + w_history * normalized_history         # delivery track record
  4. Sort desc, return top-k with a per-freelancer explanation.

The semantic term lets "React frontend" match a freelancer whose profile says
"TypeScript React Node" even without exact keyword overlap. The trust and
history terms are the XAI legibility guarantees — every score decomposes into
named, auditable components.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.ports.embedder import Embedder
from app.ports.graph_repo import FreelancerProfile, GraphRepo


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
    ) -> None:
        self._embedder = embedder
        self._graph = graph
        self._w_skill = w_skill
        self._w_trust = w_trust
        self._w_history = w_history
        # Cache of profile vectors, keyed by freelancer id.
        self._profile_vecs: dict[str, np.ndarray] = {}

    def match(self, requirements: str, top_k: int = 5) -> list[MatchResult]:
        freelancers = self._graph.all_freelancers()
        if not freelancers:
            return []

        req_vec = self._embedder.embed(requirements)
        # Normalize max deliveries for the history term so it lands in [0, 1].
        max_deliveries = max((f.deliveries for f in freelancers), default=1) or 1

        results: list[MatchResult] = []
        for f in freelancers:
            prof_vec = self._profile_vector(f)
            skill_score = float(np.dot(req_vec, prof_vec))  # both L2-normalized → cosine
            skill_score = max(0.0, skill_score)              # clamp negatives to 0

            trust_score = float(np.clip(f.trust_score, 0.0, 1.0))
            history_score = float(f.deliveries) / float(max_deliveries)

            total = (
                self._w_skill * skill_score
                + self._w_trust * trust_score
                + self._w_history * history_score
            )

            # Surface the requirement tokens that overlap the freelancer's skills.
            req_tokens = {t.lower() for t in requirements.split()}
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

    def _profile_vector(self, f: FreelancerProfile) -> np.ndarray:
        cached = self._profile_vecs.get(f.id)
        if cached is not None:
            return cached
        # Profile string: name + skills. Name helps semantic disambiguation;
        # skills carry the matching signal.
        profile_text = f"{f.name} {' '.join(f.skills)}"
        vec = self._embedder.embed(profile_text)
        self._profile_vecs[f.id] = vec
        return vec
