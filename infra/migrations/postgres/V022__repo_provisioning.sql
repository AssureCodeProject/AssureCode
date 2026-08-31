-- =============================================================================
-- V022__repo_provisioning.sql — org-owned per-contract GitHub repo provisioning
--
-- Replaces the old model (client manually types an existing owner/repo,
-- freelancer's own token registers the webhook) with AssureCode owning a
-- GitHub org and provisioning a private repo per contract itself: create repo
-- -> add freelancer as outside collaborator -> attach webhook -> flip the
-- contract ACTIVE. Mirrors the existing reconciler pattern in
-- apps/settlement-worker/src/worker.ts (reconcileMissingScores /
-- reconcilePendingPayouts): a per-contract row tracks how far provisioning
-- got, so a crash or transient GitHub failure resumes from the last
-- successfully-completed step instead of redoing it or leaving the contract
-- stuck.
-- =============================================================================

-- Needed to invite a freelancer as an outside collaborator (GitHub's
-- collaborator-invite endpoint takes a login, not the numeric user id
-- already stored in auth_providers.provider_user_id).
ALTER TABLE auth_providers ADD COLUMN IF NOT EXISTS github_login TEXT;

-- Flips false when a provisioning attempt's collaborator-invite call gets a
-- 404 "unknown user" for the login on file (i.e. it's gone stale) -- the one
-- case where the freelancer genuinely needs to reconnect their GitHub
-- identity. Surfaced by GET /api/freelancer/github-status.
ALTER TABLE auth_providers ADD COLUMN IF NOT EXISTS token_valid BOOLEAN NOT NULL DEFAULT TRUE;

-- The CHECK was declared inline in V001, so Postgres named it after the
-- table and column: contracts_status_check. Same drop/re-add pattern V013
-- already used to widen users_role_check.
ALTER TABLE contracts
    DROP CONSTRAINT IF EXISTS contracts_status_check;

ALTER TABLE contracts
    ADD CONSTRAINT contracts_status_check
    CHECK (status IN ('DRAFT','LOCKED','IN_PROGRESS','ACTIVE','COMPLETED','DISPUTED'));

-- One row per contract (contract_id is the PK), which is what makes "start
-- provisioning" idempotent for free: a second attempt is
-- INSERT ... ON CONFLICT (contract_id) DO NOTHING, so a race between two
-- workers picking up the same CONTRACT_LOCKED event can never create two
-- rows -- and therefore never two repos.
CREATE TABLE IF NOT EXISTS repo_provisioning (
    contract_id             TEXT        PRIMARY KEY REFERENCES contracts(contract_id) ON DELETE CASCADE,
    github_org              TEXT        NOT NULL,
    repo_name               TEXT        NOT NULL,
    repo_id                 BIGINT      NULL,
    repo_full_name          TEXT        NULL,
    repo_html_url           TEXT        NULL,
    freelancer_user_id      TEXT        NOT NULL REFERENCES users(user_id),
    freelancer_github_login TEXT        NOT NULL,
    collaborator_status     TEXT        NOT NULL DEFAULT 'PENDING'
                             CHECK (collaborator_status IN ('PENDING','INVITED','ACCEPTED','FAILED')),
    webhook_status          TEXT        NOT NULL DEFAULT 'PENDING'
                             CHECK (webhook_status IN ('PENDING','ATTACHED','FAILED')),
    webhook_id              BIGINT      NULL,
    status                  TEXT        NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING','REPO_CREATED','COLLABORATOR_ADDED','WEBHOOK_ATTACHED','COMPLETE','FAILED')),
    attempts                INT         NOT NULL DEFAULT 0,
    last_error              TEXT        NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The reconciler's sweep query (status NOT IN ('COMPLETE','FAILED') AND
-- attempts < cap) runs on every interval tick; keep it index-backed.
CREATE INDEX IF NOT EXISTS idx_repo_provisioning_status ON repo_provisioning(status) WHERE status NOT IN ('COMPLETE', 'FAILED');
