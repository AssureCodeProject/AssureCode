-- =============================================================================
-- V023__repo_name_unique.sql — enforce uniqueness on the human-readable repo
-- name (project title + freelancer first name + running sequence number,
-- e.g. "Fintech-Real-Time-Dashboard-Priya-01").
--
-- Unlike the old assurecode-contract-<contract-id> scheme, the new name is
-- not a pure function of the contract id -- it depends on how many other
-- repos already exist for the same title+freelancer at insert time, so two
-- contracts locked at nearly the same instant could compute the same
-- candidate name. This constraint turns that race into a loud, catchable
-- 23505 unique-violation (which apps/settlement-worker/src/worker.ts's
-- insertProvisioningRow retries with the next number) instead of a silent
-- collision that would otherwise make github-provisioner-client.ts's
-- "name already exists" reconciliation adopt the WRONG contract's repo.
-- =============================================================================

ALTER TABLE repo_provisioning ADD CONSTRAINT repo_provisioning_repo_name_key UNIQUE (repo_name);
