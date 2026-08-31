/**
 * PDF Requirements Upload.
 *
 * Standalone, not tied to a contractId: the client uploads before the form
 * is submitted, reviews the extracted text, and only then initializes the
 * contract with whatever they approved — see ContractInitialization.jsx.
 * "The client must see and approve exactly what gets hashed" (plan F3) is
 * why extraction returns text for review rather than silently populating
 * `requirements` server-side.
 */
import type { FastifyInstance } from 'fastify';
import { logger } from '../context.js';
import { extractPdfText, MAX_PDF_BYTES } from '../middleware/pdf.js';

const PDF_TOO_LARGE_ERROR = `File too large (max ${MAX_PDF_BYTES / (1024 * 1024)} MB)`;

export function registerPdfRoutes(server: FastifyInstance): void {
  server.post('/api/pdf/extract', async (request, reply) => {
    let data;
    try {
      // Same cross-version type friction as the plugin registration in
      // server.ts — @fastify/multipart's `request.file()` decorator is real
      // at runtime.
      data = await (request as any).file();
    } catch {
      // @fastify/multipart throws when the stream exceeds `limits.fileSize`.
      return reply.status(413).send({ error: PDF_TOO_LARGE_ERROR });
    }

    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }
    if (data.mimetype !== 'application/pdf') {
      return reply.status(400).send({ error: `Expected application/pdf, got ${data.mimetype}` });
    }

    const buffer = await data.toBuffer();
    if (data.file.truncated) {
      return reply.status(413).send({ error: PDF_TOO_LARGE_ERROR });
    }

    try {
      const { text, pageCount, truncated } = await extractPdfText(buffer);
      if (!text.trim()) {
        return reply.status(422).send({ error: 'No extractable text found in this PDF (scanned image? empty document?)' });
      }
      return reply.send({ text, pageCount, truncated });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'PDF extraction failed');
      return reply.status(422).send({ error: 'Could not extract text from this PDF — is it a valid, unencrypted PDF?' });
    }
  });
}
