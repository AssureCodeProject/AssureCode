-- =============================================================================
-- V013__widen_user_roles.sql — allow the 'auditor' and 'admin' roles to exist.
--
-- `AuthUser.role` in apps/api-gateway/src/middleware/rbac.ts is typed
--   'client' | 'freelancer' | 'auditor' | 'admin'
-- and `requireRole()` accepts all four. The users table, however, was created
-- in V010 with
--   CHECK (role IN ('client', 'freelancer'))
-- so no row with either of the other two values could ever be inserted.
--
-- The consequence was quiet rather than loud: every `requireRole(['admin'])`
-- guard and the admin branch of the ownership check in
-- apps/api-gateway/src/server.ts were unreachable code. Nothing errored —
-- there was simply no account those paths could ever match, so a privileged
-- route was protected by a condition that could not be satisfied and an
-- escalation path that looked implemented was not.
--
-- Widening the constraint is the smaller half of the fix. It makes the
-- database agree with the type; it does not create any privileged account,
-- and there is deliberately no seeded admin here — granting the first one is
-- an operational decision, not a migration.
-- =============================================================================

-- The CHECK was declared inline in V010, so Postgres named it after the
-- table and column: users_role_check. Dropping by that name with IF EXISTS
-- keeps this migration idempotent and safe to re-run, which is the contract
-- every other migration in this directory follows.
ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('client', 'freelancer', 'auditor', 'admin'));

-- Roles are read on every authenticated request that hits an RBAC guard.
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
