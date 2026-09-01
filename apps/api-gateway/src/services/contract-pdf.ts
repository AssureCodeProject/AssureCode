/**
 * Contract assignment PDF, generated server-side from authoritative contract
 * data — never from anything the browser sends. The caller
 * (routes/contracts-lifecycle.ts's assignment-pdf route) is responsible for
 * authorization; this module only renders whatever ContractPdfData it is
 * handed.
 *
 * `deliverables` and `technical requirements` sections from the requested
 * template are deliberately omitted: the contract model has no separate
 * columns for them (there is one `requirements` free-text field, which is
 * what scope-guard's RAG ingest also treats as the authoritative scope), so
 * rendering them would mean inventing content the contract does not actually
 * store.
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
  genesisHash: string | null;
  assignmentLedgerHash: string | null;
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
    doc.font('Helvetica').fontSize(12).fillColor('#333333').text('Contract Assignment Document');
    rule();

    heading('Contract Details');
    doc.text(`Contract Title: ${data.title}`);
    doc.text(`Contract ID: ${data.contractId}`);
    doc.text(`Client: ${data.clientDisplayName ?? 'Unknown'}`);
    doc.text(`Assigned Freelancer: ${data.freelancerDisplayName ?? 'Unassigned'}`);
    doc.text(`Assignment Date: ${formatDate(data.assignedAt)}`);
    doc.text(`Contract Status: ${data.status}`);
    rule();

    heading('Project Description');
    doc.text(data.requirements || 'No description on file.');
    rule();

    heading('Requirements and Scope');
    doc.text(
      data.requirements ||
        'No requirements on file. This document reflects only what has been recorded for this contract.',
    );
    rule();

    heading('Financial Terms');
    doc.text(`Agreed Amount: ${formatMoney(data.budgetCents)}`);
    doc.text('Currency: USD');
    doc.text(
      'Escrow Terms: Funds are authorized and held in escrow via AssureCode; release requires the ' +
        'automated CI/CD verification pipeline and trust-score gate to approve settlement.',
    );
    rule();

    heading('Timeline');
    doc.text(`Contract Created: ${formatDate(data.createdAt)}`);
    doc.text(`Due Date: ${data.deadline}`);
    rule();

    heading('Integrity Record');
    doc.text(`Genesis Hash (H0): ${data.genesisHash ?? 'not yet recorded'}`);
    doc.text(`Assignment Decision Status: ${data.assignmentStatus ?? 'N/A'}`);
    if (data.assignmentLedgerHash) {
      doc.text(`Assignment Anchored To Ledger Hash: ${data.assignmentLedgerHash}`);
    }
    doc.moveDown(0.3);
    doc
      .fontSize(8)
      .fillColor('#555555')
      .text(
        "This record reflects AssureCode's tamper-evident ledger as of generation time. Verifying it requires " +
          'cross-checking the hash(es) above against the ledger directly — this PDF file itself is not a ' +
          'cryptographically verifiable or immutable artifact.',
      );
    doc.fillColor('#000000').fontSize(10);
    rule();

    heading('Important Notice');
    doc.text('This document represents the contract information recorded in AssureCode at the time of generation.');

    doc.end();
  });
}
