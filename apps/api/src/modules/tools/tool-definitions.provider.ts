import { FactoryProvider, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { CustomersService } from '../customers/customers.service';
import { TicketsService } from '../tickets/tickets.service';
import { ConversationsService } from '../conversations/conversations.service';
import { CallbacksService } from '../callbacks/callbacks.service';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CardsService } from '../cards/cards.service';
import { BeneficiariesService } from '../beneficiaries/beneficiaries.service';
import { TransfersService } from '../transfers/transfers.service';
import { StatementsService } from '../statements/statements.service';
import { VerificationService } from '../verification/verification.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../database/prisma.service';
import { ToolDefinition } from './tool-definition.interface';
import { isCustomerSession, toJsonSchema } from './definitions/shared';
import { buildAccountTools } from './definitions/account-tools';
import { buildTransactionTools } from './definitions/transaction-tools';
import { buildCardTools } from './definitions/card-tools';
import { buildPinTools } from './definitions/pin-tools';
import { buildPasswordTools } from './definitions/password-tools';
import { buildBeneficiaryTools } from './definitions/beneficiary-tools';
import { buildTransferTools } from './definitions/transfer-tools';
import { buildVerificationTools } from './definitions/verification-tools';
import { buildSupportCaseTools } from './definitions/support-case-tools';
import { buildStatementTools } from './definitions/statement-tools';

export const TOOL_DEFINITIONS = Symbol('TOOL_DEFINITIONS');

/** Generic, non-banking tools (customer profile, tickets, conversation control, callbacks) —
 *  the banking domain's tools live in ./definitions/*, one file per domain. */
function buildCoreToolDefinitions(
  customers: CustomersService,
  tickets: TicketsService,
  conversations: ConversationsService,
  callbacks: CallbacksService,
): ToolDefinition[] {
  return [
    {
      name: 'get_customer',
      description: "Look up the current customer's profile by their customer ID.",
      inputSchema: z.object({ customer_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        { customer_id: { type: 'string', description: 'The customer ID to look up (staff sessions only — ignored for customer sessions, which always use their own ID)' } },
        [],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        // Confirmed live: a confused customer session had the agent asking for "a customer
        // ID" to look up a DIFFERENT named person's account — this handler previously
        // trusted whatever ID was supplied with no check at all, meaning it would have
        // returned that other real customer's name/email/phone. A customer session is now
        // always pinned to their own authenticated ID, ignoring anything supplied; only a
        // staff session (which already has RBAC-gated access to any customer via the normal
        // REST API) may look up an arbitrary ID here.
        const customerId = isCustomerSession(ctx) ? ctx.customerId : (args.customer_id ?? ctx.customerId);
        if (!customerId) throw new NotFoundException('No customer associated with this conversation');
        const customer = await customers.findOne(customerId);
        return {
          id: customer.id,
          fullName: customer.fullName,
          email: customer.email,
          phone: customer.phone,
          language: customer.language,
        };
      },
    },
    {
      name: 'create_ticket',
      description: 'Create a support ticket for the current customer when their issue needs follow-up or tracking.',
      inputSchema: z.object({
        category: z.string().optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
        description: z.string(),
      }),
      parametersJsonSchema: toJsonSchema(
        {
          category: { type: 'string', description: 'Short category, e.g. billing, delivery, technical' },
          priority: { type: 'string', description: 'Ticket priority', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
          description: { type: 'string', description: "A description of the customer's issue" },
        },
        ['description'],
      ),
      handler: async (ctx, args) => {
        if (!ctx.customerId) throw new NotFoundException('No customer associated with this conversation');
        const ticket = await tickets.create({
          customerId: ctx.customerId,
          conversationId: ctx.conversationId,
          category: args.category,
          priority: args.priority,
          description: args.description,
          aiSummary: args.description,
        });
        return { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, status: ticket.status };
      },
    },
    {
      name: 'get_ticket',
      description: 'Get the current status and details of a ticket by its ticket number.',
      inputSchema: z.object({ ticket_number: z.string() }),
      parametersJsonSchema: toJsonSchema(
        { ticket_number: { type: 'string', description: 'The ticket number, e.g. TCK-ABC123' } },
        ['ticket_number'],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const ticket = await tickets.findByTicketNumber(args.ticket_number);
        // A customer session must never be able to read another customer's ticket by
        // guessing/being given its number — "not found" (not "forbidden") so the response
        // doesn't even confirm whether that ticket number belongs to someone else.
        if (isCustomerSession(ctx) && ticket.customerId !== ctx.customerId) {
          throw new NotFoundException(`Ticket ${args.ticket_number} not found`);
        }
        return { ticketNumber: ticket.ticketNumber, status: ticket.status, priority: ticket.priority };
      },
    },
    {
      name: 'update_ticket',
      description: "Update a ticket's status, priority, or resolution notes.",
      inputSchema: z.object({
        ticket_number: z.string(),
        status: z.enum(['NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'ESCALATED', 'RESOLVED', 'CLOSED']).optional(),
        resolution: z.string().optional(),
      }),
      parametersJsonSchema: toJsonSchema(
        {
          ticket_number: { type: 'string', description: 'The ticket number to update' },
          status: {
            type: 'string',
            description: 'New status',
            enum: ['NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'ESCALATED', 'RESOLVED', 'CLOSED'],
          },
          resolution: { type: 'string', description: 'Resolution notes' },
        },
        ['ticket_number'],
      ),
      handler: async (ctx, args) => {
        const existing = await tickets.findByTicketNumber(args.ticket_number);
        // Same ownership check as get_ticket — without it, a customer session could not only
        // READ but actually MODIFY (status/resolution) another customer's ticket.
        if (isCustomerSession(ctx) && existing.customerId !== ctx.customerId) {
          throw new NotFoundException(`Ticket ${args.ticket_number} not found`);
        }
        const updated = await tickets.update(existing.id, { status: args.status, resolution: args.resolution });
        return { ticketNumber: updated.ticketNumber, status: updated.status };
      },
    },
    {
      name: 'escalate_ticket',
      description: 'Escalate an existing ticket to a specialist/human team.',
      inputSchema: z.object({ ticket_number: z.string(), reason: z.string() }),
      parametersJsonSchema: toJsonSchema(
        {
          ticket_number: { type: 'string', description: 'The ticket number to escalate' },
          reason: { type: 'string', description: 'Why this needs human/specialist attention' },
        },
        ['ticket_number', 'reason'],
      ),
      handler: async (ctx, args) => {
        const existing = await tickets.findByTicketNumber(args.ticket_number);
        if (isCustomerSession(ctx) && existing.customerId !== ctx.customerId) {
          throw new NotFoundException(`Ticket ${args.ticket_number} not found`);
        }
        const updated = await tickets.escalate(existing.id, args.reason);
        return { ticketNumber: updated.ticketNumber, status: updated.status };
      },
    },
    {
      name: 'transfer_to_human',
      description: 'Transfer the current conversation to a human support agent.',
      inputSchema: z.object({ reason: z.string() }),
      parametersJsonSchema: toJsonSchema(
        { reason: { type: 'string', description: 'Why a human agent is needed' } },
        ['reason'],
      ),
      handler: async (ctx, args) => {
        if (ctx.conversationId) {
          await conversations.updateState(ctx.conversationId, 'ESCALATING');
        }
        return { escalated: true, reason: args.reason };
      },
    },
    {
      name: 'end_call',
      description: 'End the current conversation/call, e.g. once the customer confirms their issue is resolved.',
      inputSchema: z.object({ reason: z.string().optional() }),
      parametersJsonSchema: toJsonSchema({ reason: { type: 'string', description: 'Why the conversation is ending' } }, []),
      handler: async (ctx) => {
        if (ctx.conversationId) {
          await conversations.updateState(ctx.conversationId, 'CALL_ENDED');
        }
        return { ended: true };
      },
    },
    {
      name: 'schedule_callback',
      description: 'Schedule a callback for the customer at a date/time they specify.',
      inputSchema: z.object({
        requested_date: z.string().describe('ISO date, e.g. 2026-09-05'),
        requested_time: z.string().describe('e.g. 15:00'),
        reason: z.string().optional(),
      }),
      parametersJsonSchema: toJsonSchema(
        {
          requested_date: { type: 'string', description: 'ISO date for the callback, e.g. 2026-09-05' },
          requested_time: { type: 'string', description: 'Time for the callback, e.g. 15:00' },
          reason: { type: 'string', description: 'Reason for the callback' },
        },
        ['requested_date', 'requested_time'],
      ),
      handler: async (ctx, args) => {
        if (!ctx.customerId) throw new NotFoundException('No customer associated with this conversation');
        const callback = await callbacks.create({
          customerId: ctx.customerId,
          conversationId: ctx.conversationId,
          requestedDate: new Date(args.requested_date),
          requestedTime: args.requested_time,
          reason: args.reason,
        });
        return {
          callbackId: callback.id,
          requestedDate: args.requested_date,
          requestedTime: args.requested_time,
          status: callback.status,
        };
      },
    },
  ];
}

function buildToolDefinitions(
  customers: CustomersService,
  tickets: TicketsService,
  conversations: ConversationsService,
  callbacks: CallbacksService,
  accounts: AccountsService,
  transactions: TransactionsService,
  cards: CardsService,
  beneficiaries: BeneficiariesService,
  transfers: TransfersService,
  statements: StatementsService,
  verification: VerificationService,
  notifications: NotificationsService,
  config: ConfigService,
  prisma: PrismaService,
): ToolDefinition[] {
  return [
    ...buildCoreToolDefinitions(customers, tickets, conversations, callbacks),
    ...buildAccountTools(accounts, config),
    ...buildTransactionTools(accounts, transactions),
    ...buildCardTools(accounts, cards),
    ...buildPinTools(cards, verification, notifications, prisma),
    ...buildPasswordTools(verification, notifications, prisma),
    ...buildBeneficiaryTools(beneficiaries),
    ...buildTransferTools(accounts, transfers, verification, beneficiaries),
    ...buildVerificationTools(verification, prisma),
    ...buildSupportCaseTools(tickets, transactions),
    ...buildStatementTools(accounts, statements),
  ];
}

export const toolDefinitionsProvider: FactoryProvider<ToolDefinition[]> = {
  provide: TOOL_DEFINITIONS,
  inject: [
    CustomersService,
    TicketsService,
    ConversationsService,
    CallbacksService,
    AccountsService,
    TransactionsService,
    CardsService,
    BeneficiariesService,
    TransfersService,
    StatementsService,
    VerificationService,
    NotificationsService,
    ConfigService,
    PrismaService,
  ],
  useFactory: buildToolDefinitions,
};
