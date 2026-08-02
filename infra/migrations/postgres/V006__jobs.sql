-- =============================================================================
-- V006__jobs.sql — Async Jobs Table Schema for Gateway LLM 503 Fallback
-- =============================================================================

CREATE TABLE IF NOT EXISTS jobs (
    job_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id  VARCHAR(255) NOT NULL,
    job_type     VARCHAR(255) NOT NULL,
    status       VARCHAR(50) NOT NULL DEFAULT 'queued',
    result       JSONB NULL,
    error        TEXT NULL,
    retry_after  INT DEFAULT 5,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_contract_id ON jobs(contract_id);
