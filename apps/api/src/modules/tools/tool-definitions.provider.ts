import { FactoryProvider, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { CustomersService } from '../customers/customers.service';
import { TicketsService } from '../tickets/tickets.service';
import { ConversationsService } from '../conversations/conversations.service';
import { CallbacksService } from '../callbacks/callbacks.service';
import { ToolDefinition, ToolExecutionContext } from './tool-definition.interface';

export const TOOL_DEFINITIONS = Symbol('TOOL_DEFINITIONS');

/**
 * True unless this is an EXPLICITLY staff-authenticated session (ctx.actor?.type === 'user')
 * — restricted-to-own-data is the safe default, not something a session has to opt into.
 * This matters because CallsService (the voice pipeline) never passes an `actor` at all when
 * invoking the orchestrator — a call is inherently the customer's own, so there was nothing to
 * pass — meaning a check that only restricted when `actor?.type === 'customer'` would have
 * left EVERY voice call unrestricted (ctx.actor undefined there), missing exactly the pipeline
 * this was meant to protect. Only an explicit staff actor (chat sent via POST
 * /conversations/:id/messages by an ADMIN/AGENT/SUPERVISOR) gets the broader lookup access,
 * matching their existing RBAC-gated REST access to any customer's data elsewhere in the app.
 */
function isCustomerSession(ctx: ToolExecutionContext): boolean {
  return ctx.actor?.type !== 'user';
}

function toJsonSchema(shape: Record<string, { type: string; description: string; enum?: string[] }>, required: string[]) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(shape).map(([key, val]) => [key, { type: val.type, description: val.description, ...(val.enum ? { enum: val.enum } : {}) }]),
    ),
    required,
  };
}

function buildToolDefinitions(
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
    // --- Business domain: a single payment/transactions account system (§9 "Account tools").
    //     Real per-customer data, sourced from Customer.metadata (seeded for the demo
    //     customers — see prisma/seed.ts) so different logins actually see different
    //     accounts/balances/transactions, with a generic fallback for ad-hoc customers
    //     created via plain chat identify (no seeded metadata). Replace with a real
    //     account/ledger service integration when one exists — the tool contract
    //     (name/args/shape) wouldn't need to change.
    {
      name: 'get_account',
      description: "Get the customer's payment account details (account number, type, status).",
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      idempotent: true,
      handler: async (ctx) => {
        const data = await loadCustomerAccountData(customers, ctx.customerId);
        return data.account;
      },
    },
    {
      name: 'get_balance',
      description: "Get the customer's current payment account balance.",
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      idempotent: true,
      handler: async (ctx) => {
        const data = await loadCustomerAccountData(customers, ctx.customerId);
        return data.balance;
      },
    },
    {
      name: 'get_transactions',
      description:
        "Get the customer's recent payment transactions, including any that failed. Use this to answer " +
        "questions like \"why did my payment fail\".",
      inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional() }),
      parametersJsonSchema: toJsonSchema(
        { limit: { type: 'number', description: 'Max number of recent transactions to return (default 5)' } },
        [],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const data = await loadCustomerAccountData(customers, ctx.customerId);
        return { transactions: data.transactions.slice(0, args.limit ?? 5) };
      },
    },
  ];
}

interface AccountTransaction {
  id: string;
  date: string;
  amount: number;
  currency: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  reason?: string;
}

interface CustomerAccountData {
  account: { accountNumber: string; accountType: string; status: string; openedDate: string };
  balance: { balance: number; currency: string };
  transactions: AccountTransaction[];
}

const FALLBACK_ACCOUNT_DATA: CustomerAccountData = {
  account: { accountNumber: 'ACC-00000000', accountType: 'PERSONAL', status: 'ACTIVE', openedDate: '2026-01-01' },
  balance: { balance: 0, currency: 'SAR' },
  transactions: [],
};

/** Reads the seeded demo account data off Customer.metadata, or a safe generic fallback for ad-hoc customers. */
async function loadCustomerAccountData(customers: CustomersService, customerId?: string): Promise<CustomerAccountData> {
  if (!customerId) return FALLBACK_ACCOUNT_DATA;
  const customer = await customers.findOne(customerId);
  const metadata = customer.metadata as { account?: unknown; balance?: unknown; transactions?: unknown } | null;
  if (!metadata?.account || !metadata.balance) return FALLBACK_ACCOUNT_DATA;
  return {
    account: metadata.account as CustomerAccountData['account'],
    balance: metadata.balance as CustomerAccountData['balance'],
    transactions: Array.isArray(metadata.transactions) ? (metadata.transactions as AccountTransaction[]) : [],
  };
}

export const toolDefinitionsProvider: FactoryProvider<ToolDefinition[]> = {
  provide: TOOL_DEFINITIONS,
  inject: [CustomersService, TicketsService, ConversationsService, CallbacksService],
  useFactory: buildToolDefinitions,
};
