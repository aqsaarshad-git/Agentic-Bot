import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { generateStatementPdf, formatPeriodForFilename } from './statement-pdf.util';
import { buildStatementEmail } from './statement-email.util';

@Injectable()
export class StatementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private generateRequestNumber(): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `STMT-${stamp}${rand}`;
  }

  /** Document GENERATION (the PDF itself) still doesn't exist at request time — this creates
   *  the request and marks it READY immediately with a stub download URL, same as before. Real
   *  PDF generation happens on demand, only when actually needed for an email send (see
   *  sendStatementByEmail) — building it here too would mean generating a document for every
   *  status-only inquiry that never gets delivered anywhere. */
  async request(params: {
    customerId: string;
    accountId: string;
    periodStart: Date;
    periodEnd: Date;
    format?: string;
    conversationId?: string;
  }) {
    const requestNumber = this.generateRequestNumber();
    return this.prisma.statementRequest.create({
      data: {
        requestNumber,
        customerId: params.customerId,
        accountId: params.accountId,
        conversationId: params.conversationId,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        format: params.format ?? 'PDF',
        status: 'READY',
        downloadUrl: `/statements/${requestNumber}.${(params.format ?? 'PDF').toLowerCase()}`,
        readyAt: new Date(),
      },
    });
  }

  async findOneForCustomer(id: string, customerId: string) {
    const statement = await this.prisma.statementRequest.findUnique({ where: { id } });
    if (!statement || statement.customerId !== customerId) {
      throw new NotFoundException(`Statement request ${id} not found`);
    }
    return statement;
  }

  async findByRequestNumberForCustomer(requestNumber: string, customerId: string) {
    const statement = await this.prisma.statementRequest.findUnique({ where: { requestNumber } });
    if (!statement || statement.customerId !== customerId) {
      throw new NotFoundException(`Statement request ${requestNumber} not found`);
    }
    return statement;
  }

  /** Used by the orchestrator's forced-state detector — same "reminds Qwen a pending X exists,
   *  never the security boundary itself" role as TransfersService.getActivePendingSummary. A
   *  statement generated in THIS conversation and not yet emailed is what a bare "yes" resolves
   *  to; scoped by conversationId exactly like a pending transfer, so a customer's statement
   *  from an earlier, unrelated conversation is never picked up by mistake. */
  async getActivePendingEmail(customerId: string, conversationId: string) {
    return this.prisma.statementRequest.findFirst({
      where: { customerId, conversationId, status: 'READY', emailSentAt: null },
      orderBy: { requestedAt: 'desc' },
    });
  }

  /**
   * The actual send. Customer email is resolved from the Customer row ONLY — never accepted as
   * a parameter here or anywhere upstream (see send_statement_by_email's tool definition), so
   * there is no code path by which Qwen's own text could redirect delivery. Idempotency: checks
   * `emailSentAt` before doing any work at all (cheap no-op on a genuine duplicate/retry), and
   * claims it with a conditional update (`WHERE email_sent_at IS NULL`) only AFTER a real
   * successful send — the same atomic-claim shape TransfersService.confirmAndExecute already
   * uses, so a failed send is never mistakenly marked as delivered and can be safely retried.
   */
  async sendStatementByEmail(params: { customerId: string; conversationId?: string; statementRequestId?: string }) {
    const statement = params.statementRequestId
      ? await this.findOneForCustomer(params.statementRequestId, params.customerId)
      : params.conversationId
        ? await this.getActivePendingEmail(params.customerId, params.conversationId)
        : null;

    if (!statement) {
      throw new NotFoundException('No statement is ready to send yet — request one first, for the period you need');
    }
    if (statement.emailSentAt) {
      return { success: true, alreadySent: true, statementReference: statement.requestNumber, sentAt: statement.emailSentAt };
    }

    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: params.customerId } });
    if (!customer.email) {
      throw new BadRequestException('NO_REGISTERED_EMAIL');
    }

    const account = await this.prisma.account.findUniqueOrThrow({ where: { id: statement.accountId } });
    if (account.customerId !== params.customerId) {
      // Defense-in-depth — statement.customerId already guarantees this via findOneForCustomer/
      // getActivePendingEmail, but the account is refetched independently, so re-assert it here
      // rather than trusting the earlier check transitively.
      throw new NotFoundException('Statement request not found');
    }
    const transactions = await this.prisma.transaction.findMany({
      where: { accountId: statement.accountId, postedAt: { gte: statement.periodStart, lte: statement.periodEnd } },
      orderBy: { postedAt: 'asc' },
    });

    const pdfBuffer = await generateStatementPdf({ customer, account, statement, transactions });
    const { subject, html, text } = buildStatementEmail({ customer, statement });
    const filename = `Bank_Statement_${formatPeriodForFilename(statement.periodStart, statement.periodEnd)}.pdf`;

    const { success } = await this.notifications.sendEmail({
      recipientId: customer.id,
      to: customer.email,
      subject,
      html,
      text,
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
    });

    if (!success) {
      return { success: false, statementReference: statement.requestNumber };
    }

    const claim = await this.prisma.statementRequest.updateMany({
      where: { id: statement.id, emailSentAt: null },
      data: { emailSentAt: new Date() },
    });

    return {
      success: true,
      alreadySent: claim.count !== 1,
      statementReference: statement.requestNumber,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
    };
  }
}
