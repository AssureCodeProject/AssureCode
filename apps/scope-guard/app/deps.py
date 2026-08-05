"""Composition root for the scope guard.

The retrieval and anchoring adapters live in apps/ai-service so there is exactly
one implementation of the pgvector query and the H0 lookup. Two copies of that
SQL in two services would drift, and a scope guard that ranks chunks differently
from the service that ingested them is worse than one that shares the code.
The path insert below is the same pattern tools/verify_owasp_2025_cloudflare.py
uses to score the shipped scanner rather than a copy of it.
"""
from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path

# apps/scope-guard/app/deps.py -> repo root is 3 levels up.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_AI_SERVICE = _REPO_ROOT / "apps" / "ai-service"
if str(_AI_SERVICE) not in sys.path:
    sys.path.insert(0, str(_AI_SERVICE))

from app.ports.embedder import Embedder, FakeEmbedder, SentenceTransformerEmbedder  # noqa: E402
from app.ports.ledger_anchor import (  # noqa: E402
    InMemoryLedgerAnchor,
    LedgerAnchorUnavailable,
    PostgresLedgerAnchor,
)
from app.ports.rag_store import (  # noqa: E402
    InMemoryRagStore,
    PostgresRagStore,
    RagStore,
    RagStoreUnavailable,
)
from app.ports.scope_log import (  # noqa: E402
    InMemoryScopeLog,
    PostgresScopeLog,
    ScopeDecisionRecord,
    ScopeLogUnavailable,
)

__all__ = [
    "Embedder",
    "InMemoryLedgerAnchor",
    "InMemoryRagStore",
    "InMemoryScopeLog",
    "LedgerAnchorUnavailable",
    "RagStore",
    "RagStoreUnavailable",
    "ScopeDecisionRecord",
    "ScopeLogUnavailable",
    "get_drift_calibration",
    "get_embedder",
    "get_ledger_anchor",
    "get_rag_store",
    "get_scope_log",
    "get_settings",
    "reset_deps_cache",
]


def _load_repo_dotenv() -> None:
    """Load the repo-root .env into os.environ, without overwriting.

    Nothing did this. Settings below reads os.environ directly, so starting the
    service the documented way — `uvicorn app.main:app` from apps/scope-guard —
    left DATABASE_URL empty. The adapters then took their in-memory branches:
    InMemoryLedgerAnchor with no anchors registered, InMemoryRagStore with no
    chunks, InMemoryScopeLog writing to a list that dies with the process.

    The result was a service that started cleanly, answered /healthz "ok", and
    refused every real scope check with "contract has no ledger entries" — for
    contracts that were correctly locked and indexed. The failure pointed at the
    caller instead of at the configuration, which is what makes this worth
    fixing rather than documenting.

    Real environment variables win, so containers and CI are unaffected.
    """
    env_path = _REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_repo_dotenv()


class Settings:
    """Scope-guard configuration, read from the environment."""

    def __init__(self) -> None:
        self.environment = os.environ.get("NODE_ENV", os.environ.get("ENVIRONMENT", "development"))
        self.embed_provider = os.environ.get("EMBED_PROVIDER", "sentence-transformers")
        self.embed_model_name = os.environ.get("EMBED_MODEL_NAME", "all-MiniLM-L6-v2")
        self.embed_dim = int(os.environ.get("EMBED_DIM", "384"))
        self.database_url = os.environ.get("DATABASE_URL", "")
        self.retrieval_k = int(os.environ.get("SCOPE_RETRIEVAL_K", "5"))
        # Threshold on the best retrieved similarity, measured rather than
        # chosen: tools/calibrate_scope_threshold.py sweeps it against
        # all-MiniLM-L6-v2 on a hand-labelled contract.
        #
        # Measured 2026-08-04 — in-scope 0.324-0.970, out-of-scope 0.055-0.341.
        # The classes OVERLAP in [0.324, 0.341], so no threshold separates them
        # perfectly; 0.2731 maximises accuracy at 14/16 with 2 false positives
        # and 0 false negatives. Erring toward false positives is deliberate:
        # wrongly allowing an out-of-scope request costs a scope amendment,
        # while wrongly flagging an in-scope one blocks legitimate work and
        # holds a payment.
        #
        # That 0.875 is accuracy on the set the threshold was selected from, so
        # it is a fitting figure and not a generalisation estimate.
        self.scope_threshold = float(os.environ.get("SCOPE_SIMILARITY_THRESHOLD", "0.2731"))
        # C1 drift detector. These match configs/c1_rules.json, which was frozen
        # before any statistic was computed; changing either after the fact is a
        # post-hoc adjustment and has to be reported as one.
        self.drift_delta = float(os.environ.get("SCOPE_DRIFT_DELTA", "0.05"))
        self.drift_epsilon = float(os.environ.get("SCOPE_DRIFT_EPSILON", "0.92"))

    @property
    def is_test(self) -> bool:
        return self.environment == "test"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


@lru_cache(maxsize=1)
def get_embedder() -> Embedder:
    settings = get_settings()
    if settings.embed_provider == "fake" or settings.is_test:
        return FakeEmbedder(dim=settings.embed_dim)
    # No silent fallback to FakeEmbedder: hash-bucket vectors would produce
    # confident-looking similarities that mean nothing, and the caller could not
    # tell. A missing model is a startup failure.
    return SentenceTransformerEmbedder(
        model_name=settings.embed_model_name, dim=settings.embed_dim
    )


@lru_cache(maxsize=1)
def get_rag_store() -> RagStore:
    settings = get_settings()
    if settings.is_test or not settings.database_url:
        return InMemoryRagStore()
    return PostgresRagStore(database_url=settings.database_url, dim=settings.embed_dim)


@lru_cache(maxsize=1)
def get_ledger_anchor():
    settings = get_settings()
    if settings.is_test or not settings.database_url:
        return InMemoryLedgerAnchor()
    return PostgresLedgerAnchor(database_url=settings.database_url)


@lru_cache(maxsize=1)
def get_scope_log():
    settings = get_settings()
    if settings.is_test or not settings.database_url:
        return InMemoryScopeLog()
    return PostgresScopeLog(database_url=settings.database_url)


@lru_cache(maxsize=1)
def get_drift_calibration() -> tuple[tuple[float, ...], bool]:
    """Calibration residuals for the C1 detector, and whether they are synthetic.

    Returns an empty tuple when none is configured, which is the current state:
    the T2 calibration set is Phase 7 and does not exist. The drift endpoint
    turns that into a 503 rather than substituting a default — a conformal
    guarantee quoted against an unmeasured distribution is a number with no
    referent, and it would be indistinguishable in the response from a real one.

    SCOPE_DRIFT_CALIBRATION_PATH points at a JSON file of in-scope residuals.
    SCOPE_DRIFT_CALIBRATION_SYNTHETIC=1 marks them as not-a-real-measurement,
    and the flag is carried through to the response and the ledger record.
    """
    import json

    path = os.environ.get("SCOPE_DRIFT_CALIBRATION_PATH", "").strip()
    if not path:
        return ((), False)

    file = Path(path)
    if not file.is_absolute():
        file = _REPO_ROOT / file
    if not file.exists():
        raise RuntimeError(
            f"SCOPE_DRIFT_CALIBRATION_PATH points at {file}, which does not exist. "
            "Refusing to start the drift detector with no calibration rather than "
            "silently falling back to an uncalibrated one."
        )

    residuals = tuple(float(x) for x in json.loads(file.read_text(encoding="utf-8")))
    synthetic = os.environ.get("SCOPE_DRIFT_CALIBRATION_SYNTHETIC", "0") == "1"
    return (residuals, synthetic)


def reset_deps_cache() -> None:
    get_settings.cache_clear()
    get_embedder.cache_clear()
    get_rag_store.cache_clear()
    get_ledger_anchor.cache_clear()
    get_scope_log.cache_clear()
    get_drift_calibration.cache_clear()
