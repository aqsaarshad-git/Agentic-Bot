import { z } from 'zod';
import { Transaction } from '@prisma/client';
import { AccountsService } from '../../accounts/accounts.service';
import { TransactionsService } from '../../transactions/transactions.service';
import { ToolDefinition } from '../tool-definition.interface';
import { humanizeFailureReason, isoDate, requireCustomerId, toJsonSchema } from './shared';

type TransactionWithRefundLinks = Transaction & {
  relatedTransaction?: Transaction | null;
  refunds?: Transaction[];
};

function mapTransaction(t: TransactionWithRefundLinks) {
  return {
    id: t.transactionRef,
    transactionRef: t.transactionRef,
    date: isoDate(t.postedAt),
    amount: Number(t.amount),
    currency: t.currency,
    status: t.status,
    channel: t.channel,
    merchantName: t.merchantName ?? undefined,
    // `description` (2026-09-29, caught live: a real fee transaction had a genuine descriptive
    // note — "ATM withdrawal fee (other network)" — that was never reaching the agent at all,
    // which then had to guess and called a real debit fee a "refund"). Separate from `reason`,
    // which is specifically the FAILURE reason and only ever set for a FAILED transaction.
    description: t.description ?? undefined,
    reason: humanizeFailureReason(t.failureReason),
    // Ground "was I refunded" / "what was this fee for" in real linked transactions instead of
    // narration — refundOf is set when THIS row is itself a refund of another charge; refunds is
    // populated when some other transaction (a refund or a fee) points back at THIS one.
    refundOf: t.relatedTransaction?.transactionRef,
    refunds: t.refunds?.length
      ? t.refunds.map((r) => ({ transactionRef: r.transactionRef, amount: Number(r.amount), channel: r.channel, date: isoDate(r.postedAt) }))
      : undefined,
  };
}

export function buildTransactionTools(accounts: AccountsService, transactions: TransactionsService): ToolDefinition[] {
  return [
    {
      name: 'get_transactions',
      // Legacy name/shape preserved for the orchestrator's deterministic forced-tool path.
      description:
        "Get the customer's recent payment transactions, including any that failed. Use this to answer " +
        'questions like "why did my payment fail" or "show my latest transactions".',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20).optional(),
        account_id: z.string().optional(),
        status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REVERSED']).optional(),
        type: z.enum(['DEBIT', 'CREDIT']).optional(),
        amount: z.number().positive().optional(),
        merchant: z.string().optional(),
        from_date: z.string().optional(),
        to_date: z.string().optional(),
      }),
      parametersJsonSchema: toJsonSchema(
        {
          limit: { type: 'number', description: 'Max number of recent transactions to return (default 5)' },
          account_id: { type: 'string', description: 'A specific account ID (optional)' },
          status: { type: 'string', description: 'Only this status: PENDING, COMPLETED, FAILED or REVERSED', enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'] },
          type: { type: 'string', description: 'DEBIT (money out) or CREDIT (money in)', enum: ['DEBIT', 'CREDIT'] },
          amount: { type: 'number', description: 'Only transactions of exactly this amount, when the customer names one' },
          merchant: { type: 'string', description: 'Only transactions whose merchant name contains this text' },
          from_date: { type: 'string', description: 'Earliest date, YYYY-MM-DD' },
          to_date: { type: 'string', description: 'Latest date, YYYY-MM-DD' },
        },
        [],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        try {
          const account = await accounts.resolveForCustomer(customerId, args.account_id);
          const rows = await transactions.findForAccount(account.id, {
            limit: args.limit ?? 5,
            status: args.status,
            type: args.type,
            amount: args.amount,
            merchant: args.merchant,
            fromDate: args.from_date,
            toDate: args.to_date,
          });
          return { transactions: rows.map(mapTransaction) };
        } catch {
          return { transactions: [] };
        }
      },
    },
    {
      name: 'get_transaction',
      description: 'Get full details of one specific transaction by its reference.',
      inputSchema: z.object({ transaction_ref: z.string() }),
      parametersJsonSchema: toJsonSchema(
        { transaction_ref: { type: 'string', description: 'The transaction reference, e.g. TXN-9931' } },
        ['transaction_ref'],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        const txn = await transactions.findByRefForCustomer(args.transaction_ref, customerId);
        return mapTransaction(txn);
      },
    },
    {
      name: 'get_transaction_status',
      description: 'Get the current status (pending, completed, failed, reversed) of a specific transaction.',
      inputSchema: z.object({ transaction_ref: z.string() }),
      parametersJsonSchema: toJsonSchema(
        { transaction_ref: { type: 'string', description: 'The transaction reference' } },
        ['transaction_ref'],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        const txn = await transactions.findByRefForCustomer(args.transaction_ref, customerId);
        return { transactionRef: txn.transactionRef, status: txn.status };
      },
    },
    {
      name: 'get_transaction_failure_reason',
      description: "Get why a specific transaction failed, if it did. Use this to answer \"why did my payment fail\".",
      inputSchema: z.object({ transaction_ref: z.string() }),
      parametersJsonSchema: toJsonSchema(
        { transaction_ref: { type: 'string', description: 'The transaction reference' } },
        ['transaction_ref'],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        const txn = await transactions.findByRefForCustomer(args.transaction_ref, customerId);
        return {
          transactionRef: txn.transactionRef,
          failed: txn.status === 'FAILED',
          reason: txn.status === 'FAILED' ? humanizeFailureReason(txn.failureReason) ?? 'unspecified' : null,
        };
      },
    },
  ];
}
