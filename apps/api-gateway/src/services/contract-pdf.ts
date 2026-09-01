/**
 * AssureCode Contract Record — the one unified PDF for a contract, generated
 * server-side from authoritative contract data — never from anything the
 * browser sends. The caller (routes/contracts-lifecycle.ts's assignment-pdf
 * route) is responsible for authorization; this module only renders
 * whatever ContractPdfData it is handed.
 *
 * This is deliberately the ONLY contract PDF in the system — there is no
 * separate "Contract Details PDF," "Digital Contract PDF," or "Assignment
 * PDF." One record, useful to both the client and the freelancer.
 *
 * It is an informational record, not a source of truth: it does not claim
 * to be digitally signed, legally binding, an e-signature, or an immutable
 * ledger artifact in its own right. Verifying the integrity fields below
 * means cross-checking them against AssureCode's actual ledger, not trusting
 * this file on its own.
 *
 * `deliverables` and `technical requirements` sections from a hypothetical
 * fuller template are deliberately omitted: the contract model has no
 * separate columns for them (there is one `requirements` free-text field,
 * which is what scope-guard's RAG ingest also treats as the authoritative
 * scope), so rendering them would mean inventing content the contract does
 * not actually store.
 */
import PDFDocument from 'pdfkit';

export interface ContractPdfData {
  contractId: string;
  title: string;
  requirements: string;
  budgetCents: number;
  deadline: string;
  status: string;
  clientDisplayName: string | null;
  freelancerDisplayName: string | null;
  createdAt: string;
  assignedAt: string | null;
  assignmentStatus: string | null;
  decidedAt: string | null;
  rejectionReasonText: string | null;
  genesisHash: string | null;
  assignmentLedgerHash: string | null;
  /** Repository provisioning status, if a repo_provisioning row exists yet —
   *  null means provisioning has not started (e.g. assignment not accepted). */
  repositoryStatus: string | null;
  /** contracts.pdf_raw_text — the full text extracted from an uploaded
   *  requirements PDF at initialize time, stored separately from
   *  `requirements` and NOT part of what /lock hashes into H0 unless the
   *  client copied it into `requirements` themselves (see the "Use Extracted
   *  Text" button in ContractInitialization.jsx). Null/empty when no PDF
   *  was uploaded. */
  pdfRawText: string | null;
}

const PAGE_RIGHT_EDGE = 545;

function formatMoney(budgetCents: number): string {
  return `Rs. ${(budgetCents / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} INR`;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString();
}

/** Human-readable repository status, from repo_provisioning.status (see
 *  V022__repo_provisioning.sql) — never invents a status that isn't there. */
function describeRepositoryStatus(status: string | null): string {
  if (!status) return 'Not yet provisioned — repository setup begins once the freelancer accepts the assignment.';
  if (status === 'COMPLETE') return 'Ready — the private contract repository has been created and the freelancer has been granted access.';
  if (status === 'FAILED') return 'Provisioning could not complete automatically. See the platform for details.';
  return `In progress (${status}).`;
}

/** Renders the document into memory and resolves with the finished bytes — no
 * temp file, nothing written to disk, since on-demand generation is cheap
 * enough here that persisting a copy would just be another thing to secure
 * and expire. */
export function generateContractPdf(data: ContractPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const rule = () => {
      doc.moveDown(0.6);
      doc.strokeColor('#999999').lineWidth(0.5).moveTo(50, doc.y).lineTo(PAGE_RIGHT_EDGE, doc.y).stroke();
      doc.moveDown(0.6);
    };
    // Forces a page break before a heading that would otherwise land in the
    // last sliver of a page with none of its body text — pdfkit happily
    // flows an overflowing .text() call onto a new page on its own, but it
    // has no "keep this heading with the paragraph after it" concept, so a
    // heading alone is what needs the explicit check.
    const ensureSpace = (minHeight: number) => {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + minHeight > bottom) doc.addPage();
    };
    const heading = (text: string) => {
      ensureSpace(60);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(text.toUpperCase());
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(10).fillColor('#000000');
    };

    doc.font('Helvetica-Bold').fontSize(20).text('ASSURECODE');
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#333333').text('CONTRACT RECORD');
    doc.font('Helvetica').fontSize(9).fillColor('#555555');
    doc.text(`Contract ID: ${data.contractId}`);
    doc.text(`Status: ${data.status}`);
    doc.text(`Generated: ${new Date().toISOString()}`);
    doc.fillColor('#000000').fontSize(10);
    rule();

    // ── 1. Contract Summary ──────────────────────────────────────────
    heading('Contract Summary');
    doc.text(`Contract Title: ${data.title}`);
    doc.text(`Contract ID: ${data.contractId}`);
    doc.text(`Current Status: ${data.status}`);
    rule();

    // ── 2. Parties ────────────────────────────────────────────────────
    heading('Parties');
    doc.text(`Client: ${data.clientDisplayName ?? 'Unknown'}`);
    doc.text(`Assigned Freelancer: ${data.freelancerDisplayName ?? 'Not yet assigned'}`);
    rule();

    // ── 3. Project Requirements ──────────────────────────────────────
    heading('Project Requirements');
    doc.text(data.requirements || 'No requirements on file.');
    rule();

    // ── 3b. Requirements Extracted from Uploaded Document ─────────────
    // Deliberately a separate section, never merged into Project
    // Requirements above: `requirements` is the authoritative field the
    // contract was actually locked against, and `pdf_raw_text` is
    // additional material the client uploaded that may or may not be the
    // same text (see the pdfRawTextMatchesRequirements note below). Omitted
    // entirely when empty, rather than printing an empty section.
    const hasPdfText = Boolean(data.pdfRawText && data.pdfRawText.trim());
    if (hasPdfText) {
      heading('Requirements Extracted from Uploaded Document');
      doc.text(data.pdfRawText as string);
      rule();
    }

    // ── 4. Financial Information ─────────────────────────────────────
    heading('Financial Information');
    doc.text(`Agreed Amount: ${formatMoney(data.budgetCents)}`);
    doc.text('Currency: INR');
    doc.text(
      'Payment processing is subject to the contract\'s configured verification and settlement workflow: ' +
        'funds are authorized via the escrow provider and released only once the automated CI/CD verification, ' +
        'scope, and trust-score gate approve settlement.',
    );
    rule();

    // ── 5. Timeline ───────────────────────────────────────────────────
    heading('Timeline');
    doc.text(`Contract Created: ${formatDate(data.createdAt)}`);
    doc.text(`Assigned: ${formatDate(data.assignedAt)}`);
    if (data.decidedAt) {
      doc.text(`Freelancer Responded: ${formatDate(data.decidedAt)}`);
    }
    doc.text(`Due Date: ${data.deadline}`);
    rule();

    // ── 6. Repository / Development Status ───────────────────────────
    heading('Repository / Development Status');
    doc.text(describeRepositoryStatus(data.repositoryStatus));
    rule();

    // ── 7. Integrity Record ──────────────────────────────────────────
    heading('Integrity Record');
    doc.text(`Original Contract Genesis Hash (H0): ${data.genesisHash ?? 'not yet recorded'}`);
    if (data.assignmentLedgerHash) {
      doc.text(`Assignment Anchored To Ledger Hash: ${data.assignmentLedgerHash}`);
    }
    doc.moveDown(0.3);
    doc
      .fontSize(8)
      .fillColor('#555555')
      .text(
        "This record references AssureCode's tamper-evident contract ledger. Integrity can be independently " +
          'checked against the corresponding authoritative ledger records — this document itself is not a ' +
          'digitally signed, legally binding, or self-verifying artifact.',
      );
    if (hasPdfText) {
      // Whether the hashed baseline IS the uploaded document's text is a
      // factual question, not a guess: /lock hashes exactly whatever
      // `requirements` contained at that moment, and the only way the PDF's
      // text gets into `requirements` is the client explicitly clicking
      // "Use Extracted Text" (ContractInitialization.jsx), which copies it
      // verbatim. An exact match is therefore real evidence, not a heuristic
      // guess -- and the negative case must say so too, since staying silent
      // would read as "assume yes."
      const pdfTextIsHashedRequirements = data.requirements.trim() === (data.pdfRawText as string).trim();
      doc.moveDown(0.2);
      doc.text(
        pdfTextIsHashedRequirements
          ? 'Note: the Requirements Extracted from Uploaded Document section matches the Project Requirements ' +
              'above and is therefore covered by the Genesis Hash (H0) baseline.'
          : 'Note: the Requirements Extracted from Uploaded Document section is additional material from the ' +
              'uploaded file and is NOT part of the Genesis Hash (H0) baseline — only Project Requirements above is.',
      );
    }
    doc.fillColor('#000000').fontSize(10);
    rule();

    // ── 8. Assignment / Acceptance Record ────────────────────────────
    heading('Assignment / Acceptance Record');
    if (!data.assignmentStatus || data.assignmentStatus === 'PENDING') {
      doc.text('Assignment Status: Awaiting Freelancer Response');
    } else if (data.assignmentStatus === 'ACCEPTED') {
      doc.text('Assignment Status: Accepted');
      doc.text(`Accepted At: ${formatDate(data.decidedAt)}`);
    } else if (data.assignmentStatus === 'REJECTED') {
      doc.text('Assignment Status: Rejected');
      doc.text(`Rejected At: ${formatDate(data.decidedAt)}`);
      if (data.rejectionReasonText) {
        doc.text(`Reason: ${data.rejectionReasonText}`);
      }
    } else {
      doc.text(`Assignment Status: ${data.assignmentStatus}`);
    }
    rule();

    // ── Footer / Disclaimer ───────────────────────────────────────────
    doc.fontSize(8).fillColor('#555555');
    doc.text('Generated from AssureCode contract records.');
    doc.text(
      'This document is an informational record of contract data and related system events. Where integrity ' +
        'data is shown, verification should be performed against the corresponding AssureCode authoritative ' +
        'ledger records.',
    );

    doc.end();
  });
}
