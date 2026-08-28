-- =============================================================================
-- V020__session_revocation.sql — make user_sessions load-bearing
--
-- user_sessions has existed since V011 with no code ever writing to it: JWTs
-- were stateless with no expiry claim and no way to invalidate one early — a
-- leaked token stayed valid forever, and POST /auth/logout only wrote an audit
-- log entry, not a real revocation. This adds the one column the existing
-- schema was missing to make revocation expressible: a session is active iff
-- its row exists, revoked_at IS NULL, and expires_at is in the future.
-- =============================================================================

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;
