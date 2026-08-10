-- =============================================================================
-- V012__contracts_user_fks.sql — Backfill orphaned contract owners, then FK
-- contracts.client_id / contracts.freelancer_id to users(user_id).
--
-- contracts.client_id has held a fresh randomUUID() per contract since
-- POST /api/contracts/initialize predates the users table (V010). Those rows
-- match no real user and would fail a naive FK add. All such contracts are
-- DRAFT with no downstream ledger value (see plan decision: map, don't
-- delete — they're kept as demo clutter under a real account rather than
-- discarded).
-- =============================================================================

-- Ensure the fallback owner exists even if tools/seed-users.py has not run
-- yet against this database, so the backfill and FK below have somewhere to
-- point. This account is deliberately NOT loginable: 'unusable-no-login' is
-- not a valid argon2id PHC string, so verifyPassword() (which wraps the
-- argon2 verify call in a catch that returns false) rejects every password
-- against it. A migration runs wherever `tools/migrate.ts` runs, including
-- an automated deploy pipeline with no human present to notice a working
-- credential was just created — unlike tools/seed-users.py, which is a
-- manually-invoked, NODE_ENV-gated dev script. If you want this account to
-- actually log in for a local demo, run tools/seed-users.py, which sets a
-- real password hash via ON CONFLICT DO UPDATE.
INSERT INTO users (user_id, email, password_hash, role, display_name)
VALUES (
    'legacy-client',
    'legacy@assurecode.io',
    'unusable-no-login',
    'client',
    'Legacy Demo Client'
)
ON CONFLICT (user_id) DO NOTHING;

-- Reassign every contract whose client_id matches no real user.
UPDATE contracts
   SET client_id = 'legacy-client'
 WHERE client_id NOT IN (SELECT user_id FROM users);

-- freelancer_id is nullable and, as of this migration, always NULL in
-- practice (no contract has ever completed Phase 1 assignment). Null out any
-- stray value that doesn't match a seeded freelancer, so the FK add below
-- cannot fail on data this migration doesn't otherwise touch.
UPDATE contracts
   SET freelancer_id = NULL
 WHERE freelancer_id IS NOT NULL
   AND freelancer_id NOT IN (SELECT user_id FROM users);

ALTER TABLE contracts
    DROP CONSTRAINT IF EXISTS fk_contracts_client_id;
ALTER TABLE contracts
    ADD CONSTRAINT fk_contracts_client_id
    FOREIGN KEY (client_id) REFERENCES users(user_id);

ALTER TABLE contracts
    DROP CONSTRAINT IF EXISTS fk_contracts_freelancer_id;
ALTER TABLE contracts
    ADD CONSTRAINT fk_contracts_freelancer_id
    FOREIGN KEY (freelancer_id) REFERENCES users(user_id);
