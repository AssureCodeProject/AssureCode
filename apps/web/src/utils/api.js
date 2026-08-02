/**
 * Shared API Client Helper (`apps/web/src/utils/api.js`)
 *
 * Centralized fetch wrapper for AssureCode web interface.
 * Handles content-type headers, JSON parsing, and unified error handling.
 */

export async function callApi(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  };

  const response = await fetch(endpoint, options);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `API Error (${response.status}): ${response.statusText}`);
  }
  return response.json();
}
