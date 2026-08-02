-- =============================================================================
-- V007__vector_hnsw.sql — Hierarchical Navigable Small World (HNSW) Vector Index
--
-- Enables sub-2ms ANN (Approximate Nearest Neighbor) cosine distance searches
-- directly inside PostgreSQL via pgvector for RAG requirement matching.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_rag_embeddings_hnsw 
ON rag_embeddings USING hnsw (embedding vector_cosine_ops);
