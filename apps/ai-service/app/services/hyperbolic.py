"""Poincaré ball geodesic distance — a pre-registered scope-guard baseline.

STATUS: implemented and unit-tested, NOT YET RUN as a baseline. It is listed in
configs/c1_rules.json under `evaluation.baselines` as
"poincare_hyperbolic_distance", and like every other entry there it is blocked
on the T2 labelled set, which does not exist yet. Nothing in the service imports
this module; it is reached only from the evaluation harness once T2 lands. Do
not delete it as dead code — retiring a pre-registered baseline requires editing
c1_rules.json and saying why, not silently dropping the file.

Projects Euclidean embedding vectors into the Poincaré ball model:
  H^d = { x in R^d : ||x|| < 1 }

and computes the exact geodesic distance:
  d_H(u, v) = arcosh( 1 + 2 * ||u - v||^2 / ( (1 - ||u||^2) * (1 - ||v||^2) ) )

KNOWN METHODOLOGICAL CAVEAT — read before reporting any number from this.
`project_to_poincare_ball` clamps any vector of norm >= 0.999 onto the sphere of
radius exactly 0.999. Sentence-transformer embeddings are L2-normalised, so
*every* real input arrives at norm 1.0 and every one of them is clamped to that
same shell. Two consequences:

  * the projection is not an embedding of the data into hyperbolic space, it is
    a projection onto a sphere near the boundary, and it discards magnitude; and
  * the (1 - ||u||^2)(1 - ||v||^2) denominator becomes ~2e-3 * 2e-3 for every
    pair, which inflates all distances by the same large factor and compresses
    the range that the `threshold` argument has to discriminate over.

The 2.5 default threshold is a placeholder — it was never selected on data. A
fair run of this baseline needs the threshold fit on T2 exactly as the cosine
threshold was, otherwise the comparison is rigged against it.

History: an earlier docstring described this as a component of a since-withdrawn
"QR-NGC Protocol" and claimed it "provides zero hierarchical distortion". The
distortion claim was never measured. Both are removed rather than carried
forward.
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
