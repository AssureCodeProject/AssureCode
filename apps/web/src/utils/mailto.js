/**
 * mailto: link builder for the Contact Client / Contact Freelancer feature.
 *
 * Deliberately the entire "messaging" implementation — no chat, no
 * WebSocket, no messages table, no inbox. This opens whatever email client
 * the user's own system is configured with; AssureCode never sees the
 * content of what gets sent, and clicking the button never touches contract
 * state (see the callers: this is pure client-side URL construction from
 * data the caller already fetched through an authorized endpoint).
 */

/**
 * Builds a `mailto:` URL with a properly encoded subject/body. The address
 * itself is not percent-encoded (per RFC 6068 the address portion is not a
 * query component, and a valid email address never contains characters that
 * would need it) — only `subject`/`body` go through `encodeURIComponent`.
 */
export function buildMailtoUrl({ to, subject, body }) {
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  const query = params.toString();
  return `mailto:${to}${query ? `?${query}` : ''}`;
}

export function contractContactSubject(contractId) {
  return `Question regarding AssureCode Contract ${contractId}`;
}

export function freelancerToClientBody({ clientName, contractTitle, contractId, freelancerName }) {
  return (
    `Hello ${clientName || 'there'},\n\n` +
    `I am reviewing the contract "${contractTitle}" (Contract ID: ${contractId}) and would like some ` +
    `clarification regarding the project requirements.\n\n` +
    `Thank you,\n${freelancerName || ''}`
  );
}

export function clientToFreelancerBody({ freelancerName, contractTitle, contractId, clientName }) {
  return (
    `Hello ${freelancerName || 'there'},\n\n` +
    `I am contacting you regarding the contract:\n\n${contractTitle}\nContract ID: ${contractId}\n\n` +
    `Thank you,\n${clientName || ''}`
  );
}
