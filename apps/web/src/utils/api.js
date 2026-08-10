/**
 * Shared API Client Helper (`apps/web/src/utils/api.js`)
 *
 * Centralized fetch wrapper for AssureCode web interface.
 * Handles content-type headers, JSON parsing, unified error handling, and
 * the Authorization header for the gateway's auth guard.
 */

// In-memory only — AuthContext calls setAuthToken() on login/logout/rehydrate.
// A module-level variable, not React state, because this file is a plain
// function called from anywhere, not a component; threading the token
// through every call site would risk missing one, which is exactly the
// gap this is meant to close in a single place.
let authToken = null;

export function setAuthToken(token) {
  authToken = token;
}

/** For the two WebSocket streams, which pass the token as ?token=... instead
 *  of an Authorization header — the browser WebSocket API cannot set one. */
export function getAuthToken() {
  return authToken;
}

/**
 * The single place the Authorization header is attached. Every HTTP call in
 * the app goes out through this — callApi, apiRequest and uploadFile are the
 * only three shapes a caller should ever need, so no component has a reason
 * to reach for a bare fetch() and silently drop the JWT.
 */
function authorizedFetch(endpoint, { method = 'GET', headers = {}, body } = {}) {
  return fetch(endpoint, {
    method,
    headers: authToken ? { ...headers, Authorization: `Bearer ${authToken}` } : headers,
    body,
  });
}

function apiError(response, payload) {
  return new Error(payload.error || `API Error (${response.status}): ${response.statusText}`);
}

/** JSON request that throws on any non-2xx — the default for callers that
 *  only care about the success body. */
export async function callApi(endpoint, method = 'GET', body = null) {
  const response = await authorizedFetch(endpoint, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw apiError(response, await response.json().catch(() => ({})));
  }
  return response.json();
}

/**
 * JSON request that resolves for *any* status and hands back the parsed body.
 * For the callers that need the body of a non-2xx response: a blocked message
 * returns 403 with `reason`/`mediation` rather than `error`, and the score /
 * oracle screens distinguish one HTTP status from another. callApi's
 * throw-on-non-2xx would discard both.
 */
export async function apiRequest(endpoint, { method = 'GET', body } = {}) {
  const response = await authorizedFetch(endpoint, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    payload: await response.json().catch(() => ({})),
  };
}

/** Multipart upload — no Content-Type header, the browser sets the
 *  boundary itself; callApi's fixed 'application/json' would break it. */
export async function uploadFile(endpoint, file) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await authorizedFetch(endpoint, { method: 'POST', body: formData });
  if (!response.ok) {
    throw apiError(response, await response.json().catch(() => ({})));
  }
  return response.json();
}
