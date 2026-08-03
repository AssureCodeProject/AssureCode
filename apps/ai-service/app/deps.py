"""Dependency factory: build the right adapter for each port based on settings.

This is the composition root — the only place that knows about concrete
adapters. Routes receive instances via FastAPI's Depends().
"""
from __future__ import annotations

from functools import lru_cache

from app.ports.artifact_store import ArtifactStore, InMemoryArtifactStore, S3ArtifactStore
from app.ports.embedder import Embedder, FakeEmbedder, SentenceTransformerEmbedder
from app.ports.graph_repo import GraphRepo, InMemoryGraphRepo, Neo4jGraphRepo
from app.ports.llm_client import (
    CloudflareWorkersAiClient,
    FakeLlmClient,
    GeminiClient,
    LlmClient,
    OpenAIClient,
)
from app.ports.rag_store import InMemoryRagStore, PostgresRagStore, RagStore
from app.services.matchmaker import Matchmaker
from app.settings import Settings, get_settings


@lru_cache(maxsize=1)
def get_embedder() -> Embedder:
    settings = get_settings()
    if settings.embed_provider == "fake":
        return FakeEmbedder(dim=settings.embed_dim)
    try:
        return SentenceTransformerEmbedder(
            model_name=settings.embed_model_name, dim=settings.embed_dim
        )
    except Exception:
        return FakeEmbedder(dim=settings.embed_dim)


@lru_cache(maxsize=1)
def get_graph_repo() -> GraphRepo:
    settings = get_settings()
    if settings.environment == "test" or settings.embed_provider == "fake":
        return InMemoryGraphRepo()
    return Neo4jGraphRepo(
        uri=settings.neo4j_uri, user=settings.neo4j_user, password=settings.neo4j_password
    )


@lru_cache(maxsize=1)
def get_matchmaker() -> Matchmaker:
    settings = get_settings()
    return Matchmaker(
        embedder=get_embedder(),
        graph=get_graph_repo(),
        w_skill=settings.match_weight_skill,
        w_trust=settings.match_weight_trust,
        w_history=settings.match_weight_history,
    )


@lru_cache(maxsize=1)
def get_rag_store() -> RagStore:
    settings = get_settings()
    if settings.environment == "test" or settings.embed_provider == "fake":
        return InMemoryRagStore()
    return PostgresRagStore(database_url=settings.database_url, dim=settings.embed_dim)


@lru_cache(maxsize=1)
def get_llm_client() -> LlmClient:
    settings = get_settings()
    if settings.environment == "test" or settings.llm_provider == "fake":
        return FakeLlmClient()
    if settings.llm_provider == "cloudflare" or (settings.cloudflare_account_id and settings.cloudflare_api_token):
        return CloudflareWorkersAiClient(
            account_id=settings.cloudflare_account_id,
            api_token=settings.cloudflare_api_token,
        )
    if settings.llm_provider == "openai":
        return OpenAIClient(api_key=settings.openai_api_key)
    return GeminiClient(api_key=settings.gemini_api_key)


@lru_cache(maxsize=1)
def get_artifact_store() -> ArtifactStore:
    settings = get_settings()
    if settings.environment == "test" or settings.embed_provider == "fake":
        return InMemoryArtifactStore()
    return S3ArtifactStore(
        endpoint_url=settings.s3_endpoint,
        bucket=settings.s3_bucket,
        region=settings.aws_region,
        access_key=settings.aws_access_key_id,
        secret_key=settings.aws_secret_access_key,
        fallback_dir=settings.s3_fallback_dir,
        max_retries=settings.s3_max_retries,
    )


def reset_deps_cache() -> None:
    """Clear the lru_caches — used by tests that swap settings/adapters."""
    get_embedder.cache_clear()
    get_graph_repo.cache_clear()
    get_matchmaker.cache_clear()
    get_rag_store.cache_clear()
    get_llm_client.cache_clear()
    get_artifact_store.cache_clear()


__all__ = [
    "Settings",
    "get_artifact_store",
    "get_embedder",
    "get_graph_repo",
    "get_llm_client",
    "get_matchmaker",
    "get_rag_store",
    "get_settings",
    "reset_deps_cache",
]
