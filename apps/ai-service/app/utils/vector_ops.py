"""Shared Vector Math Utilities (`apps/ai-service/app/utils/vector_ops.py`)

Provides reusable L2 normalization, vector projection, and similarity helpers across AI services.
"""
from __future__ import annotations

import numpy as np


def l2_normalize(vec: np.ndarray, eps: float = 1e-12) -> np.ndarray:
    """L2 normalizes a 1D or 2D numpy array in-place or returns normalized copy."""
    norm = np.linalg.norm(vec)
    if norm > eps:
        return vec / norm
    return vec


def project_to_poincare_ball(x: np.ndarray, max_norm: float = 0.999) -> np.ndarray:
    """Projects a vector into the interior of the Poincaré ball ||x|| < 1."""
    norm = np.linalg.norm(x)
    if norm == 0:
        return x
    if norm >= max_norm:
        return (x / norm) * max_norm
    return x


def cosine_similarity(u: np.ndarray, v: np.ndarray) -> float:
    """Computes cosine similarity between two 1D numpy vectors."""
    u_norm = l2_normalize(u)
    v_norm = l2_normalize(v)
    return float(np.dot(u_norm, v_norm))
