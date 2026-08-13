"""Application settings loaded from environment variables.

12-factor config — every external dependency is configurable so tests can swap
a fake adapter in via EMBED_PROVIDER= fake and a real Neo4j/Postgres in dev.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

def _find_repo_root() -> Path | None:
    """The checkout root, or None when the service is not running from one.

    `<root>/apps/ai-service/app/settings.py` -> parents[3]. This used to be a
    bare `parents[3]`, which is correct in a checkout and raises IndexError
    everywhere else: the container copies the app to /app, so there are only
    three parents and the index does not exist. That fired at *import* time, so
    `uvicorn app.main:app` died before binding a port — the published image had
    never started, and the compose/k8s healthcheck reported it as unhealthy with
    no clue why.

    None is the honest answer there rather than a fallback path. Outside a
    checkout there is no .env to anchor to and configuration comes from the
    environment, which is what 12-factor asks for; the .env lookup below is a
    developer convenience, not a requirement.
    """
    parents = Path(__file__).resolve().parents
    if len(parents) > 3 and (parents[3] / "apps").is_dir():
        return parents[3]
    return None


_REPO_ROOT = _find_repo_root()
_ENV_FILES = (
    (_REPO_ROOT / ".env", _REPO_ROOT / "apps" / "ai-service" / ".env")
    if _REPO_ROOT is not None
    else None
)


class Settings(BaseSettings):
    # env_file paths are resolved against the *process* working directory, so a
    # bare ".env" meant the service's configuration depended on where uvicorn
    # was launched from. Started from apps/ai-service — which is what the README
    # says to do — no .env was found and every setting silently took its
    # default, including DATABASE_URL. The service then reported healthy while
    # pointing at a localhost Postgres that does not exist, and the first
    # symptom was a request that hung. Anchor to the repo root instead.
    #
    # A service-local .env still wins, for per-service overrides.
    model_config = SettingsConfigDict(
        env_file=_ENV_FILES,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── Runtime ───────────────────────────────────────────────
    environment: str = Field(default="dev", alias="NODE_ENV")
    log_level: str = Field(default="info", alias="LOG_LEVEL")

    # ── Embedding port ────────────────────────────────────────
    # "sentence-transformers" loads all-MiniLM-L6-v2; "fake" returns a
    # deterministic hash-based vector so tests run without torch.
    embed_provider: str = Field(default="sentence-transformers", alias="EMBED_PROVIDER")
    embed_model_name: str = Field(default="all-MiniLM-L6-v2", alias="EMBED_MODEL_NAME")
    embed_dim: int = Field(default=384, alias="EMBED_DIM")

    # ── Neo4j (matchmaker graph) ──────────────────────────────
    neo4j_uri: str = Field(default="bolt://localhost:7687", alias="NEO4J_URI")
    neo4j_user: str = Field(default="neo4j", alias="NEO4J_USER")
    neo4j_password: str = Field(default="assurecode_local_dev", alias="NEO4J_PASSWORD")

    # ── Postgres (RAG embeddings store) ───────────────────────
    database_url: str = Field(
        default="postgresql://assurecode:assurecode_local_dev@localhost:5432/assurecode",
        alias="DATABASE_URL",
    )

    # ── LLM provider (test-gen, security, XAI judge) ──────────
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    cloudflare_account_id: str = Field(default="", alias="CLOUDFLARE_ACCOUNT_ID")
    cloudflare_api_token: str = Field(default="", alias="CLOUDFLARE_API_TOKEN")
    llm_provider: str = Field(default="gemini", alias="LLM_PROVIDER")  # gemini | openai | cloudflare

    # ── S3 / LocalStack (artifact storage) ────────────────────
    s3_endpoint: str = Field(default="http://localhost:4566", alias="S3_ENDPOINT")
    s3_bucket: str = Field(default="assurecode-artifacts", alias="S3_BUCKET_NAME")
    aws_region: str = Field(default="us-east-1", alias="AWS_REGION")
    aws_access_key_id: str = Field(default="test", alias="AWS_ACCESS_KEY_ID")
    aws_secret_access_key: str = Field(default="test", alias="AWS_SECRET_ACCESS_KEY")
    s3_fallback_dir: str = Field(default="./storage_fallback", alias="S3_FALLBACK_DIR")
    s3_max_retries: int = Field(default=3, alias="S3_MAX_RETRIES")

    # Whether an unreachable S3 may fall back to local disk.
    #
    # Left unset, this resolves to False in production and True everywhere
    # else (see `allow_local_artifact_fallback`). Across replicas the fallback
    # writes an artifact to one pod's ephemeral filesystem and reports success,
    # so a later read on a different pod finds nothing and no error is ever
    # raised. Set explicitly to True only if you have a shared volume mounted
    # at S3_FALLBACK_DIR and genuinely want that behaviour.
    allow_local_artifact_fallback_override: bool | None = Field(
        default=None, alias="ALLOW_LOCAL_ARTIFACT_FALLBACK"
    )

    @property
    def allow_local_artifact_fallback(self) -> bool:
        if self.allow_local_artifact_fallback_override is not None:
            return self.allow_local_artifact_fallback_override
        return self.environment != "production"

    # ── Matchmaker tuning ─────────────────────────────────────
    # Score = w_skill * skill_overlap + w_trust * trust + w_history * history
    match_weight_skill: float = Field(default=0.5, alias="MATCH_WEIGHT_SKILL")
    match_weight_trust: float = Field(default=0.35, alias="MATCH_WEIGHT_TRUST")
    match_weight_history: float = Field(default=0.15, alias="MATCH_WEIGHT_HISTORY")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings singleton — override in tests by clearing the cache."""
    return Settings()  # type: ignore[call-arg]
