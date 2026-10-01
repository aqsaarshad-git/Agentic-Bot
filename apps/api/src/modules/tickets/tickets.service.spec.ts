import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TicketsService } from './tickets.service';

describe('TicketsService', () => {
  let prisma: any;
  let transactions: any;
  let service: TicketsService;

  beforeEach(() => {
    prisma = {
      ticket: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      ticketMessage: { create: jest.fn() },
    };
    transactions = { refundTransaction: jest.fn() };
    service = new TicketsService(prisma, transactions);
  });

  describe('createCase — auto-escalation', () => {
    it('auto-escalates a FRAUD_DISPUTE to URGENT/OPEN regardless of what was passed in', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null);
      prisma.ticket.create.mockResolvedValue({});
      await service.createCase({ customerId: 'cust-1', category: 'FRAUD_DISPUTE', description: 'unauthorized charge' });
      expect(prisma.ticket.create.mock.calls[0][0].data.priority).toBe('URGENT');
      expect(prisma.ticket.create.mock.calls[0][0].data.status).toBe('OPEN');
    });

    it('leaves a GENERAL_INQUIRY at the default MEDIUM/NEW', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null);
      prisma.ticket.create.mockResolvedValue({});
      await service.createCase({ customerId: 'cust-1', category: 'GENERAL_INQUIRY', description: 'question about limits' });
      expect(prisma.ticket.create.mock.calls[0][0].data.priority).toBe('MEDIUM');
      expect(prisma.ticket.create.mock.calls[0][0].data.status).toBe('NEW');
    });
  });

  // CONFIRMED LIVE (2026-09-29): calling create_support_case twice for the same fraud report
  // created two duplicate tickets. Fixed with the smallest appropriate protection, not a
  // generic framework — see createCase's own doc comment for the two dedup rules.
  describe('createCase — idempotency', () => {
    it('returns the existing OPEN case instead of creating a duplicate when the same transaction is reported again', async () => {
      const existing = { id: 't-1', ticketNumber: 'TCK-1', status: 'OPEN' };
      prisma.ticket.findFirst.mockResolvedValue(existing);

      const result = await service.createCase({
        customerId: 'cust-1',
        category: 'FRAUD_DISPUTE',
        transactionId: 'txn-1',
        description: 'unauthorized charge',
      });

      expect(result).toBe(existing);
      expect(prisma.ticket.create).not.toHaveBeenCalled();
    });

    it('creates a new case when the earlier one on the same transaction is already RESOLVED/CLOSED', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null); // the open-status filter excludes the resolved one
      prisma.ticket.create.mockResolvedValue({ id: 't-2' });

      await service.createCase({ customerId: 'cust-1', category: 'FRAUD_DISPUTE', transactionId: 'txn-1', description: 'again' });

      expect(prisma.ticket.create).toHaveBeenCalled();
    });

    it('creates two separate cases for two different transactions, even in the same category', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null);
      prisma.ticket.create.mockResolvedValue({});

      await service.createCase({ customerId: 'cust-1', category: 'FRAUD_DISPUTE', transactionId: 'txn-1', description: 'a' });
      await service.createCase({ customerId: 'cust-1', category: 'FRAUD_DISPUTE', transactionId: 'txn-2', description: 'b' });

      expect(prisma.ticket.create).toHaveBeenCalledTimes(2);
    });

    it('dedupes an exact-text general complaint only within the short retry window', async () => {
      const existing = { id: 't-3', ticketNumber: 'TCK-3' };
      prisma.ticket.findFirst.mockResolvedValue(existing);

      const result = await service.createCase({ customerId: 'cust-1', category: 'COMPLAINT', description: 'branch was slow' });

      expect(result).toBe(existing);
      expect(prisma.ticket.findFirst.mock.calls[0][0].where.createdAt).toBeDefined();
      expect(prisma.ticket.create).not.toHaveBeenCalled();
    });

    it('never merges two different general complaints (different description)', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null); // the exact-description match finds nothing
      prisma.ticket.create.mockResolvedValue({});

      await service.createCase({ customerId: 'cust-1', category: 'COMPLAINT', description: 'branch was slow' });
      await service.createCase({ customerId: 'cust-1', category: 'COMPLAINT', description: 'app crashed on login' });

      expect(prisma.ticket.create).toHaveBeenCalledTimes(2);
    });
  });

  // Security / technical / account-service cases are raised from a conversation with a fixed
  // subcategory (see orchestrator SUPPORT_ROUTES) - repeating the report in the same conversation,
  // however it is reworded and however long after, must return the SAME open case.
  describe('createCase — same-conversation subcategory idempotency', () => {
    it('returns the open case already raised for this subcategory in this conversation', async () => {
      const open = { id: 't-9', ticketNumber: 'TCK-9', status: 'OPEN' };
      prisma.ticket.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(open);

      const result = await service.createCase({
        customerId: 'cust-1',
        conversationId: 'conv-1',
        category: 'FRAUD_DISPUTE',
        subcategory: 'ACCOUNT_COMPROMISE',
        description: 'reworded report, 5 minutes later',
      });

      expect(result).toBe(open);
      expect(prisma.ticket.create).not.toHaveBeenCalled();
      expect(prisma.ticket.findFirst.mock.calls[1][0].where).toMatchObject({
        customerId: 'cust-1',
        conversationId: 'conv-1',
        subcategory: 'ACCOUNT_COMPROMISE',
      });
    });

    it('creates a new case when the earlier one in this conversation is no longer open', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null); // open-status filter excludes a resolved one
      prisma.ticket.create.mockResolvedValue({ id: 't-10' });
      await service.createCase({ customerId: 'cust-1', conversationId: 'conv-1', category: 'ACCOUNT_ISSUE', subcategory: 'MOBILE_APP_TECHNICAL', description: 'app' });
      expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
    });

    it('never looks across customers (every lookup is scoped to the requesting customer)', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null);
      prisma.ticket.create.mockResolvedValue({});
      await service.createCase({ customerId: 'cust-2', conversationId: 'conv-1', category: 'ACCOUNT_ISSUE', subcategory: 'ACCOUNT_CLOSURE_REQUEST', description: 'x' });
      for (const call of prisma.ticket.findFirst.mock.calls) expect(call[0].where.customerId).toBe('cust-2');
    });

    it('does not run the extra lookup without a subcategory (plain complaint path unchanged)', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null);
      prisma.ticket.create.mockResolvedValue({});
      await service.createCase({ customerId: 'cust-1', conversationId: 'conv-1', category: 'COMPLAINT', description: 'slow' });
      expect(prisma.ticket.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  // ATM disputes reuse the ordinary dispute path - the linked ATM_WITHDRAWAL transaction and the
  // shortfall-only disputeAmount must be persisted exactly as passed (no separate ATM subsystem).
  describe('createCase — ATM dispute linkage', () => {
    it('persists the linked ATM transaction and the disputed shortfall on an URGENT dispute', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null);
      prisma.ticket.create.mockResolvedValue({});
      await service.createCase({
        customerId: 'cust-1',
        category: 'TRANSACTION_DISPUTE',
        subcategory: 'ATM_PARTIAL_CASH',
        transactionId: 'txn-atm-1410',
        disputeAmount: 100,
        description: 'Withdrew 500 SAR, received 400 SAR',
      });
      const data = prisma.ticket.create.mock.calls[0][0].data;
      expect(data.transactionId).toBe('txn-atm-1410');
      expect(Number(data.disputeAmount)).toBe(100);
      expect(data.priority).toBe('URGENT');
      expect(data.status).toBe('OPEN');
    });

    it('does not open a second ATM dispute for the same still-open transaction', async () => {
      const open = { id: 't-atm', status: 'OPEN' };
      prisma.ticket.findFirst.mockResolvedValue(open);
      const result = await service.createCase({ customerId: 'cust-1', category: 'TRANSACTION_DISPUTE', transactionId: 'txn-atm-1410', description: 'again' });
      expect(result).toBe(open);
      expect(prisma.ticket.create).not.toHaveBeenCalled();
    });
  });

  describe('refund', () => {
    it('rejects a case with no linked transaction', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 't-1', transactionId: null });
      await expect(service.refund('t-1', {})).rejects.toThrow(BadRequestException);
      expect(transactions.refundTransaction).not.toHaveBeenCalled();
    });

    it('issues a real refund against the linked transaction, defaulting to the case disputeAmount, and marks the case RESOLVED', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 't-1',
        transactionId: 'txn-1',
        disputeAmount: { toString: () => '260', valueOf: () => 260 },
        resolution: null,
      });
      transactions.refundTransaction.mockResolvedValue({ amount: 260, currency: 'SAR', transactionRef: 'TXN-REFUND-1' });
      prisma.ticket.update.mockResolvedValue({ status: 'RESOLVED' });

      await service.refund('t-1', {});

      expect(transactions.refundTransaction).toHaveBeenCalledWith('txn-1', { amount: 260, reason: undefined });
      expect(prisma.ticketMessage.create.mock.calls[0][0].data.content).toContain('TXN-REFUND-1');
      expect(prisma.ticket.update.mock.calls[0][0].data.status).toBe('RESOLVED');
    });

    it('lets an explicit amount override the case disputeAmount', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 't-1', transactionId: 'txn-1', disputeAmount: null, resolution: null });
      transactions.refundTransaction.mockResolvedValue({ amount: 100, currency: 'SAR', transactionRef: 'TXN-REFUND-2' });
      prisma.ticket.update.mockResolvedValue({});

      await service.refund('t-1', { amount: 100, reason: 'partial goodwill refund' });

      expect(transactions.refundTransaction).toHaveBeenCalledWith('txn-1', { amount: 100, reason: 'partial goodwill refund' });
    });
  });

  describe('addCustomerMessage — dispute additional information', () => {
    it('rejects adding information to a case belonging to a different customer', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 't-1', ticketNumber: 'TCK-1', customerId: 'someone-else', status: 'OPEN' });
      await expect(service.addCustomerMessage('TCK-1', 'cust-1', 'here is the receipt')).rejects.toThrow(NotFoundException);
      expect(prisma.ticketMessage.create).not.toHaveBeenCalled();
    });

    it('refuses to add information to an already-RESOLVED case', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 't-1', ticketNumber: 'TCK-1', customerId: 'cust-1', status: 'RESOLVED' });
      await expect(service.addCustomerMessage('TCK-1', 'cust-1', 'more info')).rejects.toThrow(BadRequestException);
      expect(prisma.ticketMessage.create).not.toHaveBeenCalled();
    });

    it('refuses to add information to an already-CLOSED case', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 't-1', ticketNumber: 'TCK-1', customerId: 'cust-1', status: 'CLOSED' });
      await expect(service.addCustomerMessage('TCK-1', 'cust-1', 'more info')).rejects.toThrow(BadRequestException);
    });

    it('adds the message and moves WAITING_FOR_CUSTOMER back to IN_PROGRESS', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 't-1', ticketNumber: 'TCK-1', customerId: 'cust-1', status: 'WAITING_FOR_CUSTOMER' });
      prisma.ticket.update.mockResolvedValue({ id: 't-1', ticketNumber: 'TCK-1', status: 'IN_PROGRESS' });

      const result = await service.addCustomerMessage('TCK-1', 'cust-1', 'here is the receipt');

      expect(prisma.ticketMessage.create.mock.calls[0][0].data).toMatchObject({ ticketId: 't-1', authorType: 'CUSTOMER', content: 'here is the receipt' });
      expect(result.status).toBe('IN_PROGRESS');
    });

    it('leaves an already-open (not WAITING_FOR_CUSTOMER) case status unchanged', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 't-1', ticketNumber: 'TCK-1', customerId: 'cust-1', status: 'IN_PROGRESS' });

      const result = await service.addCustomerMessage('TCK-1', 'cust-1', 'additional detail');

      expect(prisma.ticket.update).not.toHaveBeenCalled();
      expect(result.status).toBe('IN_PROGRESS');
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException for a missing ticket', async () => {
      prisma.ticket.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
