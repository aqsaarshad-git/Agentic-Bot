import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TicketMessageAuthorType, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
  ) {}

  private generateTicketNumber(): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TCK-${stamp}-${rand}`;
  }

  async create(dto: CreateTicketDto) {
    return this.prisma.ticket.create({
      data: {
        ticketNumber: this.generateTicketNumber(),
        customerId: dto.customerId,
        conversationId: dto.conversationId,
        category: dto.category,
        priority: dto.priority ?? 'MEDIUM',
        description: dto.description,
        aiSummary: dto.aiSummary,
      },
    });
  }

  findAll(params: { status?: TicketStatus; customerId?: string; take?: number; skip?: number }) {
    const { status, customerId, take = 50, skip = 0 } = params;
    return this.prisma.ticket.findMany({
      where: { status, customerId },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: {
        customer: true,
        assignments: {
          where: { unassignedAt: null },
          include: { user: { select: { id: true, name: true } } },
        },
      },
    });
  }

  async findOne(id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: { customer: true, messages: { orderBy: { createdAt: 'asc' } }, assignments: true },
    });
    if (!ticket) {
      throw new NotFoundException(`Ticket ${id} not found`);
    }
    return ticket;
  }

  async findByTicketNumber(ticketNumber: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { ticketNumber },
      include: { transaction: true, card: true },
    });
    if (!ticket) {
      throw new NotFoundException(`Ticket ${ticketNumber} not found`);
    }
    return ticket;
  }

  async update(id: string, dto: UpdateTicketDto) {
    const existing = await this.findOne(id);
    let status = dto.status;

    if (dto.assignToUserId) {
      await this.prisma.$transaction([
        this.prisma.ticketAssignment.updateMany({
          where: { ticketId: id, unassignedAt: null },
          data: { unassignedAt: new Date() },
        }),
        this.prisma.ticketAssignment.create({
          data: { ticketId: id, userId: dto.assignToUserId },
        }),
      ]);
      // Assigning a brand-new ticket implicitly moves it into an active state.
      if (!status && existing.status === 'NEW') {
        status = 'OPEN';
      }
    }

    return this.prisma.ticket.update({
      where: { id },
      data: {
        status,
        priority: dto.priority,
        category: dto.category,
        resolution: dto.resolution,
      },
    });
  }

  async addMessage(id: string, authorType: TicketMessageAuthorType, content: string, authorId?: string) {
    await this.findOne(id);
    return this.prisma.ticketMessage.create({
      data: { ticketId: id, authorType, authorId, content },
    });
  }

  /**
   * Customer-facing "add information to my case" — ownership-checked (unlike addMessage above,
   * which is the staff-side method with no such check) and refuses on a case that's already
   * RESOLVED/CLOSED, so a decided case can't be arbitrarily reopened by adding text to it. A
   * case sitting in WAITING_FOR_CUSTOMER moves back to IN_PROGRESS — the customer just answered
   * what it was waiting on; every other status is left exactly as it was (adding info doesn't
   * itself decide anything about priority/urgency).
   */
  async addCustomerMessage(ticketNumber: string, customerId: string, content: string) {
    const ticket = await this.findByTicketNumber(ticketNumber);
    if (ticket.customerId !== customerId) {
      throw new NotFoundException(`Case ${ticketNumber} not found`);
    }
    if (ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') {
      throw new BadRequestException(`Case ${ticketNumber} is already ${ticket.status.toLowerCase()} and can't be updated — open a new case if this is still unresolved`);
    }
    await this.prisma.ticketMessage.create({
      data: { ticketId: ticket.id, authorType: 'CUSTOMER', content },
    });
    if (ticket.status === 'WAITING_FOR_CUSTOMER') {
      return this.prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'IN_PROGRESS' } });
    }
    return ticket;
  }

  async escalate(id: string, reason: string) {
    await this.findOne(id);
    await this.prisma.ticketMessage.create({
      data: { ticketId: id, authorType: 'SYSTEM', content: `Escalated: ${reason}` },
    });
    return this.prisma.ticket.update({ where: { id }, data: { status: 'ESCALATED' } });
  }

  /**
   * Support cases (categories K + M — disputes/fraud, general complaints) reuse Ticket rather
   * than a parallel model, since it already has everything a case needs. A fraud/transaction
   * dispute is auto-escalated to URGENT priority and OPEN status regardless of what was passed
   * in — it should never sit in NEW/unassigned while money is potentially at risk.
   */
  /**
   * Idempotent by real-world identity, not a generic framework (smallest appropriate
   * protection, per the request that added this — 2026-09-29, confirmed live: calling
   * create_support_case twice for the same report created two duplicate tickets).
   *
   * Two different rules, because "the same case" means something different depending on
   * whether there's a concrete linked entity:
   *  - Linked to a real transaction/card (fraud dispute, transaction dispute, card issue):
   *    the entity itself IS the identity of the case — reporting fraud on the same transaction
   *    twice is the same case, no matter how much time passed, as long as it's still open.
   *  - No linked entity (a general complaint/inquiry): there's no stronger identity than the
   *    text itself, so only an exact-match retry within a short window (60s — long enough for
   *    a retried tool call or double form-submit, short enough that two genuinely separate
   *    complaints made minutes apart — the case explicitly required NOT to merge — still both
   *    get their own ticket).
   */
  async createCase(params: {
    customerId: string;
    conversationId?: string;
    category: string;
    subcategory?: string;
    description: string;
    accountId?: string;
    cardId?: string;
    transactionId?: string;
    disputeAmount?: number;
  }) {
    const openStatuses: TicketStatus[] = ['NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'ESCALATED'];
    if (params.transactionId || params.cardId) {
      const existing = await this.prisma.ticket.findFirst({
        where: {
          customerId: params.customerId,
          category: params.category,
          transactionId: params.transactionId,
          cardId: params.cardId,
          status: { in: openStatuses },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return existing;
    } else {
      const existing = await this.prisma.ticket.findFirst({
        where: {
          customerId: params.customerId,
          category: params.category,
          subcategory: params.subcategory,
          description: params.description,
          createdAt: { gt: new Date(Date.now() - 60_000) },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return existing;
      // A subcategorized case raised from a conversation (security/technical/account-service
      // reports) is ALSO the same case for the rest of that conversation while it stays open,
      // regardless of how the customer rewords it or how long they keep talking about it.
      if (params.conversationId && params.subcategory) {
        const sameConversation = await this.prisma.ticket.findFirst({
          where: {
            customerId: params.customerId,
            category: params.category,
            subcategory: params.subcategory,
            conversationId: params.conversationId,
            status: { in: openStatuses },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (sameConversation) return sameConversation;
      }
    }

    const isDispute = params.category === 'FRAUD_DISPUTE' || params.category === 'TRANSACTION_DISPUTE';
    return this.prisma.ticket.create({
      data: {
        ticketNumber: this.generateTicketNumber(),
        customerId: params.customerId,
        conversationId: params.conversationId,
        category: params.category,
        subcategory: params.subcategory,
        priority: isDispute ? 'URGENT' : 'MEDIUM',
        status: isDispute ? 'OPEN' : 'NEW',
        description: params.description,
        aiSummary: params.description,
        accountId: params.accountId,
        cardId: params.cardId,
        transactionId: params.transactionId,
        disputeAmount: params.disputeAmount,
      },
    });
  }

  /**
   * Issues a real refund against the transaction this case is disputing, and records it on the
   * ticket — the mechanism that makes "resolved" mean something actually happened rather than
   * just a resolution note. Staff-only (see TicketsController.refund).
   */
  async refund(id: string, params: { amount?: number; reason?: string }) {
    const ticket = await this.findOne(id);
    if (!ticket.transactionId) {
      throw new BadRequestException('This case has no linked transaction to refund');
    }
    const amount = params.amount ?? (ticket.disputeAmount ? Number(ticket.disputeAmount) : undefined);
    const refundTxn = await this.transactions.refundTransaction(ticket.transactionId, { amount, reason: params.reason });

    await this.prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorType: 'SYSTEM',
        content: `Refund issued: ${Number(refundTxn.amount)} ${refundTxn.currency} (${refundTxn.transactionRef}).`,
      },
    });
    return this.prisma.ticket.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolution: ticket.resolution ?? `Refunded ${Number(refundTxn.amount)} ${refundTxn.currency} (${refundTxn.transactionRef}).`,
      },
      include: { transaction: true, card: true },
    });
  }

  findAllForCustomer(
    customerId: string,
    params: { status?: TicketStatus; take?: number; transactionId?: string; cardId?: string } = {},
  ) {
    return this.prisma.ticket.findMany({
      where: { customerId, status: params.status, transactionId: params.transactionId, cardId: params.cardId },
      orderBy: { createdAt: 'desc' },
      take: params.take ?? 10,
      include: { transaction: true, card: true },
    });
  }
}
