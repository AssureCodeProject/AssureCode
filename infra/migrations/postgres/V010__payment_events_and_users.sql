-- =============================================================================
-- V010__payment_events_and_users.sql — Users, Freelancer Profiles & Payment Events
-- =============================================================================

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Payment Events ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_events (
    event_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_intent_id TEXT        NOT NULL,
    contract_id       TEXT        NOT NULL,
    event_type        TEXT        NOT NULL,
    amount_cents      INTEGER     NOT NULL,
    payload           JSONB       NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_contract 
    ON payment_events(contract_id);

-- ── Users Table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    user_id       TEXT        PRIMARY KEY,
    email         TEXT        UNIQUE NOT NULL,
    password_hash TEXT        NOT NULL,
    role          TEXT        NOT NULL CHECK (role IN ('client', 'freelancer')),
    display_name  TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Freelancer Profiles Table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS freelancer_profiles (
    freelancer_id     TEXT        PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    skills            TEXT[]      NOT NULL,
    trust_score       REAL        NOT NULL DEFAULT 0.5,
    deliveries        INTEGER     NOT NULL DEFAULT 0,
    avg_ast           REAL        NOT NULL DEFAULT 0.0,
    hourly_rate_cents INTEGER     NOT NULL DEFAULT 0,
    profile_text      TEXT        NOT NULL,
    profile_embedding vector(384) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_freelancer_profiles_hnsw
    ON freelancer_profiles USING hnsw (profile_embedding vector_cosine_ops);
