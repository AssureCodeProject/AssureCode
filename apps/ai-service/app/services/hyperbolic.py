"""Poincaré Hyperbolic Riemannian Manifold Distance Module for QR-NGC Protocol.

Projects Euclidean embedding vectors into the Poincaré Ball model of hyperbolic space:
  H^d = { x in R^d : ||x|| < 1 }

Computes exact Poincaré geodesic distance:
  d_H(u, v) = arcosh( 1 + 2 * ||u - v||^2 / ( (1 - ||u||^2) * (1 - ||v||^2) ) )

Provides zero hierarchical distortion for AST and contract requirement embeddings.
"""
from __future__ import annotations

import numpy as np


from app.utils.vector_ops import project_to_poincare_ball


def poincare_geodesic_distance(u: np.ndarray, v: np.ndarray) -> float:
    """Calculates exact Poincaré Geodesic Distance between vectors u and v in H^d."""
    u_proj = project_to_poincare_ball(u)
    v_proj = project_to_poincare_ball(v)

    sq_dist = np.sum((u_proj - v_proj) ** 2)
    u_sqnorm = np.sum(u_proj**2)
    v_sqnorm = np.sum(v_proj**2)

    denom = (1.0 - u_sqnorm) * (1.0 - v_sqnorm)
    if denom <= 0:
        denom = 1e-10

    arg = 1.0 + 2.0 * (sq_dist / denom)
    arg = max(1.0, arg)  # arcosh domain requirement x >= 1

    return float(np.arccosh(arg))


def hyperbolic_scope_check(message_vec: np.ndarray, requirement_vecs: list[np.ndarray], threshold: float = 2.5) -> dict[str, float | bool]:
    """Evaluates scope boundary in Hyperbolic Space H^d.
    
    Lower geodesic distance implies higher structural semantic alignment.
    """
    if not requirement_vecs:
        return {"allowed": True, "min_geodesic_distance": 0.0}

    distances = [poincare_geodesic_distance(message_vec, req_vec) for req_vec in requirement_vecs]
    min_dist = min(distances)

    allowed = min_dist <= threshold

    return {
        "allowed": allowed,
        "min_geodesic_distance": round(min_dist, 4),
        "threshold": threshold,
    }
