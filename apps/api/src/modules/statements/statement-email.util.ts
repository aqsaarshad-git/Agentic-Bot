import type { Customer, StatementRequest } from '@prisma/client';

function formatPeriodLabel(start: Date, end: Date): string {
  const fmt = (d: Date) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

/** Professional, minimal bank-style email — no account number, no balance, no transaction
 *  detail in the BODY (see the module's own "do not unnecessarily expose sensitive information
 *  in the email body" requirement) — all of that lives only in the attached PDF. */
export function buildStatementEmail(params: { customer: Customer; statement: StatementRequest }): {
  subject: string;
  html: string;
  text: string;
} {
  const period = formatPeriodLabel(params.statement.periodStart, params.statement.periodEnd);
  const subject = `Your Bank Statement – ${period}`;
  const text =
    `Dear ${params.customer.fullName},\n\n` +
    `Please find attached your bank statement for ${period}.\n\n` +
    `For your security, please do not share this document or your banking credentials with anyone.\n\n` +
    `Regards,\nBarq Bank Support`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1a1a1a; max-width: 520px; margin: 0 auto;">
      <div style="background: #1a2b4c; padding: 20px 24px; border-radius: 6px 6px 0 0;">
        <span style="color: #fff; font-size: 18px; font-weight: bold;">Barq Bank</span>
      </div>
      <div style="border: 1px solid #e2e2e2; border-top: none; padding: 24px; border-radius: 0 0 6px 6px;">
        <p>Dear ${escapeHtml(params.customer.fullName)},</p>
        <p>Please find attached your bank statement for <strong>${period}</strong>.</p>
        <p style="color: #666; font-size: 13px;">
          For your security, please do not share this document or your banking credentials with anyone.
        </p>
        <p style="margin-top: 24px;">Regards,<br/>Barq Bank Support</p>
      </div>
    </div>`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
