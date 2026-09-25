import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { TicketsService } from '../../tickets/tickets.service';
import { TransactionsService } from '../../transactions/transactions.service';
import { ToolDefinition } from '../tool-definition.interface';
import { isCustomerSession, requireCustomerId, toJsonSchema } from './shared';

const CASE_CATEGORIES = ['ACCOUNT_ISSUE', 'CARD_ISSUE', 'FRAUD_DISPUTE', 'TRANSACTION_DISPUTE', 'COMPLAINT', 'GENERAL_INQUIRY'] as const;

export function buildSupportCaseTools(tickets: TicketsService, transactions: TransactionsService): ToolDefinition[] {
  return [
    {
      name: 'create_support_case',
      description:
        'Create a support case for the customer — a complaint, dispute, or issue needing follow-up or tracking. ' +
        'For a transaction the customer does not recognize or disputes as unauthorized, use category ' +
        'FRAUD_DISPUTE (this is auto-escalated and prioritized as urgent).',
      inputSchema: z.object({
        category: z.enum(CASE_CATEGORIES),
        subcategory: z.string().optional(),
        description: z.string(),
        account_id: z.string().optional(),
        card_id: z.string().optional(),
        transaction_ref: z.string().optional(),
        dispute_amount: z.number().optional(),
      }),
      parametersJsonSchema: toJsonSchema(
        {
          category: { type: 'string', description: 'Case category', enum: [...CASE_CATEGORIES] },
          subcategory: { type: 'string', description: 'A more specific subcategory, e.g. UNAUTHORIZED_TRANSACTION, LOST_CARD' },
          description: { type: 'string', description: "A description of the customer's issue" },
          account_id: { type: 'string', description: 'Related account ID, if applicable' },
          card_id: { type: 'string', description: 'Related card ID, if applicable' },
          transaction_ref: { type: 'string', description: 'Related transaction reference, if disputing a specific transaction' },
          dispute_amount: { type: 'number', description: 'Disputed amount, if applicable' },
        },
        ['category', 'description'],
      ),
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        let transactionId: string | undefined;
        if (args.transaction_ref) {
          const txn = await transactions.findByRefForCustomer(args.transaction_ref, customerId);
          transactionId = txn.id;
        }
        const kase = await tickets.createCase({
          customerId,
          conversationId: ctx.conversationId,
          category: args.category,
          subcategory: args.subcategory,
          description: args.description,
          accountId: args.account_id,
          cardId: args.card_id,
          transactionId,
          disputeAmount: args.dispute_amount,
        });
        return { caseId: kase.ticketNumber, category: kase.category, status: kase.status, priority: kase.priority };
      },
    },
    {
      name: 'get_support_case',
      description: 'Get the status and details of a support case by its case ID.',
      inputSchema: z.object({ case_id: z.string() }),
      parametersJsonSchema: toJsonSchema({ case_id: { type: 'string', description: 'The case ID, e.g. TCK-ABC123' } }, ['case_id']),
      idempotent: true,
      handler: async (ctx, args) => {
        const kase = await tickets.findByTicketNumber(args.case_id);
        if (isCustomerSession(ctx) && kase.customerId !== ctx.customerId) {
          throw new NotFoundException(`Case ${args.case_id} not found`);
        }
        return {
          caseId: kase.ticketNumber,
          category: kase.category,
          subcategory: kase.subcategory ?? undefined,
          status: kase.status,
          priority: kase.priority,
          resolution: kase.resolution ?? undefined,
        };
      },
    },
    {
      name: 'get_customer_cases',
      description: "List the customer's recent support cases.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional() }),
      parametersJsonSchema: toJsonSchema({ limit: { type: 'number', description: 'Max number to return (default 10)' } }, []),
      idempotent: true,
      handler: async (ctx, args) => {
        const rows = await tickets.findAllForCustomer(requireCustomerId(ctx), { take: args.limit ?? 10 });
        return {
          cases: rows.map((t) => ({ caseId: t.ticketNumber, category: t.category, status: t.status, priority: t.priority, createdAt: t.createdAt })),
        };
      },
    },
  ];
}
