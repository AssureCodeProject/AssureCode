/**
 * The Contract Record PDF's "Requirements Extracted from Uploaded Document"
 * section — the one already-existing GET /api/contracts/:id/assignment-pdf
 * route now also renders contracts.pdf_raw_text when present, as a section
 * separate from Project Requirements (contracts.requirements). Nothing about
 * hashing/H0, RAG ingest, or the upload/extraction endpoint is touched by
 * this feature — those are exercised elsewhere
 * (assignment-decision.test.ts's PDF test, auth-email-validation.test.ts's
 * canonicalization, etc.) and are not re-tested here.
 *
 * Uses the same pdf-parse the extraction endpoint itself uses, so these
 * assertions are on the PDF's actual rendered text, not just "a PDF-shaped
 * buffer came back."
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PDFParse } from 'pdf-parse';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import server from '../src/server.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — Contract Record PDF, uploaded-document section', 'a running PostgreSQL on DATABASE_URL');

interface Registered {
  token: string;
  userId: string;
}

async function register(role: 'client' | 'freelancer', tag: string): Promise<Registered> {
  const res = await server.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: 'a-strong-password-1',
      role,
    },
  });
  const body = res.json();
  return { token: body.token, userId: body.user.userId };
}

function auth(t: Registered): Record<string, string> {
  return { authorization: `Bearer ${t.token}` };
}

async function extractPdfPages(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const parser = new PDFParse({ data: buffer });
  try {
    const info = await parser.getInfo();
    const result = await parser.getText();
    // pdfkit wraps long sentences across lines, and pdf-parse renders each
    // wrapped line break as a literal "\n" rather than collapsing it to a
    // space -- so a multi-word toContain() check can straddle a wrap point
    // that has nothing to do with whether the content is actually present.
    // Collapsing all whitespace runs to a single space makes assertions
    // robust to exactly where pdfkit happened to wrap a given sentence.
    const text = result.text.replace(/\s+/g, ' ');
    return { text, pageCount: info.total };
  } finally {
    await parser.destroy();
  }
}

describe.skipIf(!PG_UP)('Contract Record PDF — uploaded-document content', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  let client: Registered;
  const createdContracts: string[] = [];

  beforeAll(async () => {
    client = await register('client', 'pdf-content-client');
  });

  afterAll(async () => {
    for (const contractId of createdContracts) {
      await pool.query(`DELETE FROM merkle_ledger WHERE contract_id = $1`, [contractId]);
      await pool.query(`DELETE FROM outbox WHERE payload->>'contractId' = $1`, [contractId]);
      await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
    }
    if (client) {
      await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [client.userId]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [client.userId]);
    }
    await pool.end();
  });

  async function createContract(title: string, requirements: string, pdfRawText?: string): Promise<string> {
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: auth(client),
      payload: {
        title,
        requirements,
        budgetCents: 500000,
        deadline: '2026-12-31',
        ...(pdfRawText ? { pdfRawText } : {}),
      },
    });
    const contractId = res.json().contractId as string;
    createdContracts.push(contractId);
    return contractId;
  }

  it('no uploaded PDF: the uploaded-document section is omitted, Project Requirements still renders', async () => {
    const contractId = await createContract('No PDF contract', 'Plain typed requirements, no upload.');
    const res = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-pdf`,
      headers: auth(client),
    });
    expect(res.statusCode).toBe(200);

    const { text } = await extractPdfPages(res.rawPayload as Buffer);
    expect(text).toContain('Plain typed requirements, no upload.');
    expect(text).not.toContain('Requirements Extracted from Uploaded Document');
  });

  it('uploaded PDF present: both sections render, separately, with the accurate not-in-H0 note', async () => {
    const requirements = 'Short client-typed summary.';
    const pdfRawText = 'Full extracted document text describing the detailed scope in depth.';
    const contractId = await createContract('With PDF contract', requirements, pdfRawText);

    const res = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-pdf`,
      headers: auth(client),
    });
    expect(res.statusCode).toBe(200);

    const { text } = await extractPdfPages(res.rawPayload as Buffer);
    expect(text).toContain('Short client-typed summary.');
    expect(text).toContain('Requirements Extracted from Uploaded Document');
    expect(text).toContain('Full extracted document text describing the detailed scope in depth.');
    // requirements !== pdfRawText here, so the PDF must say it is NOT part of H0.
    expect(text).toContain('NOT part of the Genesis Hash (H0) baseline');
  });

  it('the client used "Use Extracted Text" (requirements === pdf_raw_text): the PDF says it IS covered by H0', async () => {
    const sameText = 'This exact text was both typed as requirements and extracted from the uploaded PDF.';
    const contractId = await createContract('Copied-in PDF contract', sameText, sameText);

    const res = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-pdf`,
      headers: auth(client),
    });
    const { text } = await extractPdfPages(res.rawPayload as Buffer);
    expect(text).toContain('is therefore covered by the Genesis Hash (H0) baseline');
  });

  it('very long pdf_raw_text flows across multiple pages without failing or truncating', async () => {
    // ~30,000 characters -- comfortably more than fits on one A4 page at
    // the document's existing font size, so this only passes if pdfkit's
    // automatic page flow (and this feature's heading-orphan guard) is
    // actually working, not just "the endpoint didn't 500."
    const longText = Array.from({ length: 600 }, (_, i) => `Requirement line ${i + 1}: a moderately long sentence describing scope in detail.`).join('\n');
    const contractId = await createContract('Long PDF contract', 'Short requirements.', longText);

    const res = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-pdf`,
      headers: auth(client),
    });
    expect(res.statusCode).toBe(200);

    const { text, pageCount } = await extractPdfPages(res.rawPayload as Buffer);
    expect(pageCount).toBeGreaterThan(1);
    // Neither the first nor the last line was dropped by truncation.
    expect(text).toContain('Requirement line 1:');
    expect(text).toContain('Requirement line 600:');
  });

  it('empty-string pdf_raw_text behaves the same as no upload (no failure, section omitted)', async () => {
    const contractId = await createContract('Empty pdf_raw_text contract', 'Requirements only.', '');
    const res = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-pdf`,
      headers: auth(client),
    });
    expect(res.statusCode).toBe(200);
    const { text } = await extractPdfPages(res.rawPayload as Buffer);
    expect(text).not.toContain('Requirements Extracted from Uploaded Document');
  });

  it('an unrelated user still cannot download the PDF (authorization unchanged by this feature)', async () => {
    const contractId = await createContract('Auth check contract', 'n/a', 'some pdf text');
    const other = await register('client', 'pdf-content-other-client');
    const res = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-pdf`,
      headers: auth(other),
    });
    expect(res.statusCode).toBe(403);
    await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [other.userId]);
    await pool.query(`DELETE FROM users WHERE user_id = $1`, [other.userId]);
  });
});
