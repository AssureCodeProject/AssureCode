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

  const login = useCallback(async (email, password) => {
    const data = await callApi('/auth/login', 'POST', { email, password });
    setAuthToken(data.token);
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    setUser(toUser(data.user));
    return data.user;
  }, []);

  const logout = useCallback(() => {
    // Best-effort — JWT is stateless, so failure to reach the gateway does
    // not block clearing the local session.
    callApi('/auth/logout', 'POST').catch(() => {});
    clearStoredToken();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, isAuthenticated: !!user, isLoading, login, logout }),
    [user, isLoading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

export default AuthContext;
