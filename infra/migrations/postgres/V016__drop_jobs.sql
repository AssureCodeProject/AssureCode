-- =============================================================================
-- V016__drop_jobs.sql — remove the async-jobs table
-- =============================================================================
--
-- V006 created `jobs` to back a 503 fallback in the gateway's generate-tests
-- route: when ai-service had no LLM available, the gateway inserted a row with
-- status 'queued' and returned 202 with a pollUrl.
--
-- Nothing ever processed those rows. There was no `UPDATE jobs` anywhere in the
-- repository, no worker subscribed to anything that would produce one, and no
-- UI caller for GET /api/jobs/:jobId. Every row inserted stayed 'queued'
-- permanently, and the poll endpoint reported that state as though work were in
-- progress.
--
-- Test generation is synchronous — /generate-tests returns the bundle directly
-- — so the queue had nothing to be a queue for. The route now answers 503 with
-- a Retry-After when the LLM is unavailable, which is what was actually true.
--
-- Dropping rather than leaving it in place: an empty-by-design table that looks
-- like a work queue is an invitation to build against it.
-- =============================================================================

DROP INDEX IF EXISTS idx_jobs_contract_id;
DROP INDEX IF EXISTS idx_jobs_status;
DROP TABLE IF EXISTS jobs;
