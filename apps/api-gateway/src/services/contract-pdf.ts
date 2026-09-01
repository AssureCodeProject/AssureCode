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
}

const PAGE_RIGHT_EDGE = 545;

function formatMoney(budgetCents: number): string {
  return `$${(budgetCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`;
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
    const heading = (text: string) => {
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

    // ── 4. Financial Information ─────────────────────────────────────
    heading('Financial Information');
    doc.text(`Agreed Amount: ${formatMoney(data.budgetCents)}`);
    doc.text('Currency: USD');
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
