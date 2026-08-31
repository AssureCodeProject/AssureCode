import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { callApi, setAuthToken } from '../utils/api';

const AuthContext = createContext(null);

const TOKEN_STORAGE_KEY = 'assurecode_auth_token';

/** The gateway returns the same user shape from /auth/login and /auth/me. */
function toUser({ userId, email, role, displayName }) {
  return { userId, email, role, displayName };
}

/** Drop the token from both the in-memory client and localStorage. */
function clearStoredToken() {
  setAuthToken(null);
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/**
 * App.jsx persists the active contract workspace to localStorage, unscoped
 * to any particular user (see App.jsx's assurecode_active_tab /
 * assurecode_contract_data effects). Without this, a second person signing
 * in on the same browser inherits whatever contract the previous session
 * left behind — wrong topic, wrong trust score, wrong freelancer context.
 */
function clearStoredContractWorkspace() {
  localStorage.removeItem('assurecode_contract_data');
  localStorage.removeItem('assurecode_active_tab');
}

/**
 * Auth state for the whole app. The token itself lives in memory (see
 * utils/api.js) and is only persisted to localStorage so a page refresh
 * doesn't force a re-login — the same pattern App.jsx already uses for
 * contract/phase state.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Rehydrate from a stored token on first mount by asking the gateway who
  // it belongs to, rather than trusting decoded claims that may be stale or
  // (if the secret ever rotated) no longer valid.
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!stored) {
      setIsLoading(false);
      return;
    }
    setAuthToken(stored);
    callApi('/auth/me')
      .then((me) => {
        if (me.authenticated) {
          setUser(toUser(me));
        } else {
          clearStoredToken();
        }
      })
      .catch(clearStoredToken)
      .finally(() => setIsLoading(false));
  }, []);

  // POST /auth/login answers one of two shapes: a real session for a
  // password-only account, or {mfaRequired, challenge} for one enrolled in
  // MFA — no token, no user, nothing to sign in with yet. The caller has to
  // branch on that before treating this as "logged in" (see
  // completeMfaChallenge for the second step).
  const login = useCallback(async (email, password) => {
    const data = await callApi('/auth/login', 'POST', { email, password });
    if (data.mfaRequired) {
      return { mfaRequired: true, challenge: data.challenge };
    }
    setAuthToken(data.token);
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    clearStoredContractWorkspace();
    setUser(toUser(data.user));
    return { mfaRequired: false, user: data.user };
  }, []);

  // Second step of an MFA-gated login: redeem the challenge login() returned
  // plus a live TOTP code for the real session. Same token-storage shape as
  // login()/completeGithubLogin() above.
  const completeMfaChallenge = useCallback(async (challenge, code) => {
    const data = await callApi('/auth/mfa/challenge', 'POST', { challenge, code });
    setAuthToken(data.token);
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    clearStoredContractWorkspace();
    setUser(toUser(data.user));
    return data.user;
  }, []);

  // GET /auth/github/callback redirects here with a short-lived one-time
  // code rather than a real JWT (see server.ts) — this is the follow-up call
  // that actually redeems it. Same token-storage shape as login() above.
  const completeGithubLogin = useCallback(async (code) => {
    const data = await callApi('/auth/github/exchange', 'POST', { code });
    setAuthToken(data.token);
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    clearStoredContractWorkspace();
    setUser(toUser(data.user));
    return data.user;
  }, []);

  const logout = useCallback(() => {
    // Best-effort — JWT is stateless, so failure to reach the gateway does
    // not block clearing the local session.
    callApi('/auth/logout', 'POST').catch(() => {});
    clearStoredToken();
    clearStoredContractWorkspace();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, isAuthenticated: !!user, isLoading, login, logout, completeGithubLogin, completeMfaChallenge }),
    [user, isLoading, login, logout, completeGithubLogin, completeMfaChallenge],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

export default AuthContext;
