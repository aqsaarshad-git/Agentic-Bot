import PDFDocument from 'pdfkit';
import type { Account, Customer, StatementRequest, Transaction } from '@prisma/client';

/**
 * Builds a real, formatted bank-statement PDF from trusted backend data only — every number
 * here comes straight from the Account/Transaction rows passed in, never from Qwen. Opening
 * balance is derived (closing balance minus the period's net change), not stored separately —
 * this system has no historical balance ledger, so this is the honest way to show one without
 * inventing a number: it is exactly consistent with the transactions actually listed below it.
 */
export function generateStatementPdf(params: {
  customer: Customer;
  account: Account;
  statement: StatementRequest;
  transactions: Transaction[];
}): Promise<Buffer> {
  const { customer, account, statement, transactions } = params;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const currency = account.currency;
    const closingBalance = Number(account.balance);
    const netChange = transactions.reduce((sum, t) => sum + (t.type === 'CREDIT' ? Number(t.amount) : -Number(t.amount)), 0);
    const openingBalance = closingBalance - netChange;

    doc.fontSize(20).fillColor('#1a2b4c').text('Barq Bank', { align: 'left' });
    doc.fontSize(10).fillColor('#666').text('Official Account Statement', { align: 'left' });
    doc.moveDown(1.5);

    doc.fontSize(12).fillColor('#000');
    doc.text(`Statement Reference: ${statement.requestNumber}`);
    doc.text(`Account Holder: ${customer.fullName}`);
    doc.text(`Account Number: ${maskAccountNumber(account.accountNumber)}`);
    doc.text(`Statement Period: ${formatDate(statement.periodStart)} to ${formatDate(statement.periodEnd)}`);
    doc.text(`Generated: ${formatDate(new Date())}`);
    doc.moveDown(1);

    doc.fontSize(12).fillColor('#1a2b4c').text('Balance Summary', { underline: true });
    doc.fontSize(11).fillColor('#000');
    doc.text(`Opening Balance: ${openingBalance.toFixed(2)} ${currency}`);
    doc.text(`Closing Balance: ${closingBalance.toFixed(2)} ${currency}`);
    doc.moveDown(1);

    doc.fontSize(12).fillColor('#1a2b4c').text('Transactions', { underline: true });
    doc.moveDown(0.5);

    const colX = { date: 50, desc: 130, type: 340, amount: 400 };
    const startY = doc.y;
    doc.fontSize(10).fillColor('#333');
    doc.text('Date', colX.date, startY, { continued: false });
    doc.text('Description', colX.desc, startY);
    doc.text('Type', colX.type, startY);
    doc.text('Amount', colX.amount, startY);
    doc.moveTo(50, doc.y + 4).lineTo(545, doc.y + 4).strokeColor('#ccc').stroke();
    doc.moveDown(0.5);

    if (transactions.length === 0) {
      doc.fontSize(10).fillColor('#666').text('No transactions were posted during this period.');
    } else {
      for (const t of transactions) {
        const rowY = doc.y;
        const amountText = `${t.type === 'CREDIT' ? '+' : '-'}${Number(t.amount).toFixed(2)} ${t.currency}`;
        doc.fontSize(9).fillColor('#000');
        doc.text(formatDate(t.postedAt), colX.date, rowY, { width: 75 });
        doc.text(t.description ?? t.merchantName ?? '—', colX.desc, rowY, { width: 200 });
        doc.text(t.type, colX.type, rowY, { width: 55 });
        doc.fillColor(t.type === 'CREDIT' ? '#0a7a2f' : '#8a1f1f').text(amountText, colX.amount, rowY, { width: 100 });
        doc.moveDown(0.3);
      }
    }

    doc.moveDown(1.5);
    doc.fontSize(8).fillColor('#888').text('This is a system-generated statement. For assistance, contact Barq Bank Support.', { align: 'center' });

    doc.end();
  });
}

function formatDate(d: Date): string {
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length <= 4 ? accountNumber : `****${accountNumber.slice(-4)}`;
}

export function formatPeriodForFilename(start: Date, end: Date): string {
  const fmt = (d: Date) => new Date(d).toISOString().slice(0, 10);
  return `${fmt(start)}_to_${fmt(end)}`;
}
