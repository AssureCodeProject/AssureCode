-- =============================================================================
-- V001__init.sql — Core tables + pgvector extension
--
-- Applied by tools/migrate.ts. Idempotent-safe (CREATE EXTENSION IF NOT EXISTS,
-- CREATE TABLE IF NOT EXISTS).
-- =============================================================================

-- Enable pgvector for RAG embeddings (384-dim Sentence-BERT vectors)
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Contracts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contracts (
    contract_id   TEXT        PRIMARY KEY,
    client_id     TEXT        NOT NULL DEFAULT 'anonymous',
    freelancer_id TEXT        NULL,
    title         TEXT        NOT NULL,
    requirements  TEXT        NOT NULL,
    pdf_raw_text  TEXT        NULL,
    budget_cents  INTEGER     NOT NULL,
    deadline      DATE        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','LOCKED','IN_PROGRESS','COMPLETED','DISPUTED')),
    hidden_tests_s3_key  TEXT   NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RAG Embeddings (pgvector) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS rag_embeddings (
    id           BIGSERIAL   PRIMARY KEY,
    contract_id  TEXT        NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
    chunk_idx    INTEGER     NOT NULL,
    content      TEXT        NOT NULL,
    embedding    vector(384) -- all-MiniLM-L6-v2 dimension
);

CREATE INDEX IF NOT EXISTS idx_rag_embeddings_contract ON rag_embeddings(contract_id, chunk_idx);

-- ── Escrow ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escrow (
    payment_intent_id TEXT PRIMARY KEY,
    contract_id       TEXT   NOT NULL REFERENCES contracts(contract_id),
    amount_cents      INTEGER NOT NULL,
    status            TEXT   NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','CAPTURED','REFUNDED','RELEASED')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Audit Results ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_results (
    audit_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id TEXT        NOT NULL REFERENCES contracts(contract_id),
    payload     JSONB       NOT NULL,
    passed      BOOLEAN     NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_results_contract ON audit_results(contract_id);
