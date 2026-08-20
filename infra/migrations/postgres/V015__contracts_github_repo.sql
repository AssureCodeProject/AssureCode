-- =============================================================================
-- V015__contracts_github_repo.sql — Map a contract to the GitHub repository
-- the freelancer pushes to.
--
-- Without this column apps/webhook-ingest has no way to answer the only
-- question that matters when a push arrives: which contract is this work for?
-- It resolved `payload.contract_id || payload.repository?.name ||
-- 'unknown-contract'`, and since GitHub never sends `contract_id`, every real
-- push fell through to the repository *name* — which is not a contract id, so
-- the audit_results insert failed its foreign key to contracts and no audit
-- was ever persisted. The webhook returned 202 the whole time.
--
-- Stores GitHub's `repository.full_name` verbatim ("owner/repo") so the lookup
-- is an equality match on the payload field, with no parsing in the request
-- path. Deliberately NOT unique: a repository is often reused across
-- sequential contracts with the same client, and a unique constraint would
-- make the second contract un-linkable. webhook-ingest disambiguates by
-- preferring a contract that is actually in flight (LOCKED / IN_PROGRESS) and
-- falling back to the most recent — see resolveContractId() in
-- apps/webhook-ingest/src/server.ts.
--
-- Partial index because the column is NULL for every contract that has not
-- been linked yet, and those rows are never looked up by it.
-- =============================================================================

ALTER TABLE contracts
    ADD COLUMN IF NOT EXISTS github_repo_full_name TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_contracts_github_repo
    ON contracts (github_repo_full_name)
    WHERE github_repo_full_name IS NOT NULL;
