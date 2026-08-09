/**
 * @assurecode/api-gateway — PDF requirements text extraction.
 *
 * The upload is untrusted input arriving right before a cryptographic commit
 * (contract lock hashes whatever text ends up in `requirements`/`pdf_raw_text`).
 * Page count and extracted length are capped before anything reaches the RAG
 * chunker, so a malformed or hostile PDF can't exhaust memory or blow up the
 * embedding pipeline mid-demo.
 */
import { PDFParse } from 'pdf-parse';

export const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_PDF_PAGES = 50;
export const MAX_EXTRACTED_CHARS = 200_000;

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  truncated: boolean;
}

/** Extract plain text from a PDF buffer, capped in pages and length. */
export async function extractPdfText(buffer: Buffer): Promise<PdfExtractionResult> {
  const parser = new PDFParse({ data: buffer });
  try {
    const info = await parser.getInfo();
    const totalPages = info.total;
    const pagesToRead = Math.min(totalPages, MAX_PDF_PAGES);

    const result = await parser.getText(pagesToRead < totalPages ? { first: pagesToRead } : {});

    let text = result.text;
    let truncated = totalPages > pagesToRead;
    if (text.length > MAX_EXTRACTED_CHARS) {
      text = text.slice(0, MAX_EXTRACTED_CHARS);
      truncated = true;
    }

    return { text, pageCount: totalPages, truncated };
  } finally {
    await parser.destroy();
  }
}
