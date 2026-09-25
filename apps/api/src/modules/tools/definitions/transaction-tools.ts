import { z } from 'zod';
import { Transaction } from '@prisma/client';
import { AccountsService } from '../../accounts/accounts.service';
import { TransactionsService } from '../../transactions/transactions.service';
import { ToolDefinition } from '../tool-definition.interface';
import { humanizeFailureReason, isoDate, requireCustomerId, toJsonSchema } from './shared';

function mapTransaction(t: Transaction) {
  return {
    id: t.transactionRef,
    transactionRef: t.transactionRef,
    date: isoDate(t.postedAt),
    amount: Number(t.amount),
    currency: t.currency,
    status: t.status,
    reason: humanizeFailureReason(t.failureReason),
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
      inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional(), account_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        {
          limit: { type: 'number', description: 'Max number of recent transactions to return (default 5)' },
          account_id: { type: 'string', description: 'A specific account ID (optional)' },
        },
        [],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        try {
          const account = await accounts.resolveForCustomer(customerId, args.account_id);
          const rows = await transactions.findForAccount(account.id, { limit: args.limit ?? 5 });
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
