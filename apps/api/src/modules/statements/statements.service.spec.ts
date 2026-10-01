import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StatementsService } from './statements.service';

jest.mock('./statement-pdf.util', () => ({
  generateStatementPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
  formatPeriodForFilename: jest.fn().mockReturnValue('2026-09'),
}));
jest.mock('./statement-email.util', () => ({
  buildStatementEmail: jest.fn().mockReturnValue({ subject: 'S', html: '<p/>', text: 'T' }),
}));

describe('StatementsService', () => {
  let prisma: any;
  let notifications: any;
  let service: StatementsService;

  const periodStart = new Date('2026-08-01');
  const periodEnd = new Date('2026-08-31');

  beforeEach(() => {
    prisma = {
      statementRequest: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
      customer: { findUniqueOrThrow: jest.fn() },
      account: { findUniqueOrThrow: jest.fn() },
      transaction: { findMany: jest.fn() },
    };
    notifications = { sendEmail: jest.fn() };
    service = new StatementsService(prisma, notifications);
  });

  // CONFIRMED LIVE BUG (2026-09-28): a customer's unclear "Good" made Qwen call request_statement
  // a second time for the same period, leaving two READY, un-emailed rows behind.
  describe('request — idempotency', () => {
    it('returns the existing READY, un-emailed request for the same conversation/account/period instead of creating a duplicate', async () => {
      const existing = { id: 'stmt-1', requestNumber: 'STMT-1', status: 'READY' };
      prisma.statementRequest.findFirst.mockResolvedValue(existing);

      const result = await service.request({ customerId: 'cust-1', accountId: 'account-1', periodStart, periodEnd, conversationId: 'conv-1' });

      expect(result).toBe(existing);
      expect(prisma.statementRequest.create).not.toHaveBeenCalled();
    });

    it('creates a new request when no matching one exists', async () => {
      prisma.statementRequest.findFirst.mockResolvedValue(null);
      prisma.statementRequest.create.mockResolvedValue({ id: 'stmt-2' });

      await service.request({ customerId: 'cust-1', accountId: 'account-1', periodStart, periodEnd, conversationId: 'conv-1' });

      expect(prisma.statementRequest.create).toHaveBeenCalled();
    });

    it('does not dedupe against a request from a DIFFERENT conversation', async () => {
      // findFirst itself is scoped by conversationId in the where clause — this asserts that
      // scoping is actually present, not just trusted by convention.
      prisma.statementRequest.findFirst.mockResolvedValue(null);
      prisma.statementRequest.create.mockResolvedValue({ id: 'stmt-3' });

      await service.request({ customerId: 'cust-1', accountId: 'account-1', periodStart, periodEnd, conversationId: 'conv-2' });

      expect(prisma.statementRequest.findFirst.mock.calls[0][0].where.conversationId).toBe('conv-2');
    });
  });

  describe('sendStatementByEmail — idempotency and honest delivery', () => {
    const statement = { id: 'stmt-1', requestNumber: 'STMT-1', accountId: 'account-1', periodStart, periodEnd, emailSentAt: null, customerId: 'cust-1' };
    const customer = { id: 'cust-1', email: 'a@b.com' };
    const account = { id: 'account-1', customerId: 'cust-1' };

    it('reports already-sent (success) without re-sending when emailSentAt is already set — never double-sends', async () => {
      prisma.statementRequest.findUnique.mockResolvedValue({ ...statement, emailSentAt: new Date('2026-08-01') });

      const result = await service.sendStatementByEmail({ customerId: 'cust-1', statementRequestId: 'stmt-1' });

      expect(result).toMatchObject({ success: true, alreadySent: true });
      expect(notifications.sendEmail).not.toHaveBeenCalled();
    });

    it('rejects when the customer has no registered email, without ever calling the provider', async () => {
      prisma.statementRequest.findUnique.mockResolvedValue(statement);
      prisma.customer.findUniqueOrThrow.mockResolvedValue({ id: 'cust-1', email: null });

      await expect(service.sendStatementByEmail({ customerId: 'cust-1', statementRequestId: 'stmt-1' })).rejects.toThrow(BadRequestException);
      expect(notifications.sendEmail).not.toHaveBeenCalled();
    });

    it('reports failure honestly (never success) when the real provider send fails', async () => {
      prisma.statementRequest.findUnique.mockResolvedValue(statement);
      prisma.customer.findUniqueOrThrow.mockResolvedValue(customer);
      prisma.account.findUniqueOrThrow.mockResolvedValue(account);
      prisma.transaction.findMany.mockResolvedValue([]);
      notifications.sendEmail.mockResolvedValue({ success: false });

      const result = await service.sendStatementByEmail({ customerId: 'cust-1', statementRequestId: 'stmt-1' });

      expect(result).toMatchObject({ success: false });
      expect(prisma.statementRequest.updateMany).not.toHaveBeenCalled();
    });

    it('claims emailSentAt atomically and reports real success on a genuine send', async () => {
      prisma.statementRequest.findUnique.mockResolvedValue(statement);
      prisma.customer.findUniqueOrThrow.mockResolvedValue(customer);
      prisma.account.findUniqueOrThrow.mockResolvedValue(account);
      prisma.transaction.findMany.mockResolvedValue([]);
      notifications.sendEmail.mockResolvedValue({ success: true });
      prisma.statementRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.sendStatementByEmail({ customerId: 'cust-1', statementRequestId: 'stmt-1' });

      expect(result).toMatchObject({ success: true, alreadySent: false });
      expect(prisma.statementRequest.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'stmt-1', emailSentAt: null });
    });

    it('rejects sending a statement that belongs to a different customer', async () => {
      prisma.statementRequest.findUnique.mockResolvedValue({ ...statement, customerId: 'someone-else' });
      await expect(service.sendStatementByEmail({ customerId: 'cust-1', statementRequestId: 'stmt-1' })).rejects.toThrow(NotFoundException);
    });
  });
});
