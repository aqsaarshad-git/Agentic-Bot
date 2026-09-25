import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { AccountsService } from '../../accounts/accounts.service';
import { ToolDefinition } from '../tool-definition.interface';
import { VerificationLevel } from '../verification-level';
import { isoDate, maskAccountNumber, requireCustomerId, toJsonSchema } from './shared';

// Same graceful-degradation shape the legacy demo tools used for an ad-hoc customer with no
// seeded/real account on file (e.g. created via plain chat identify) — never a 404 to the LLM.
const FALLBACK_ACCOUNT = {
  accountNumber: '****0000',
  accountType: 'CHECKING',
  status: 'ACTIVE',
  openedDate: '2026-01-01',
  currency: 'SAR',
};

export function buildAccountTools(accounts: AccountsService, config: ConfigService): ToolDefinition[] {
  return [
    {
      name: 'get_account',
      // Legacy name/shape preserved so orchestrator.service.ts's deterministic forced-tool
      // path (which calls this with `{}`) keeps working unchanged — only fields were added.
      description:
        "Get the customer's payment account details (masked account number, type, status, opening date). " +
        'If they have more than one account, also lists the others.',
      inputSchema: z.object({ account_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        { account_id: { type: 'string', description: 'A specific account ID (optional — defaults to the primary account)' } },
        [],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        let account;
        try {
          account = await accounts.resolveForCustomer(customerId, args.account_id);
        } catch {
          return FALLBACK_ACCOUNT;
        }
        const all = await accounts.findAllForCustomer(customerId);
        const others = all.filter((a) => a.id !== account.id);
        return {
          accountId: account.id,
          accountNumber: maskAccountNumber(account.accountNumber),
          accountType: account.accountType,
          status: account.status,
          statusReason: account.statusReason ?? undefined,
          openedDate: isoDate(account.openedAt),
          currency: account.currency,
          ...(others.length > 0
            ? {
                otherAccounts: others.map((a) => ({
                  accountId: a.id,
                  accountNumber: maskAccountNumber(a.accountNumber),
                  accountType: a.accountType,
                  status: a.status,
                })),
              }
            : {}),
        };
      },
    },
    {
      name: 'get_balance',
      description: "Get the customer's current and available payment account balance.",
      inputSchema: z.object({ account_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        { account_id: { type: 'string', description: 'A specific account ID (optional — defaults to the primary account)' } },
        [],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        try {
          const account = await accounts.resolveForCustomer(customerId, args.account_id);
          return { balance: Number(account.balance), availableBalance: Number(account.availableBalance), currency: account.currency };
        } catch {
          return { balance: 0, availableBalance: 0, currency: 'SAR' };
        }
      },
    },
    {
      name: 'get_account_status',
      description: "Get whether the customer's account is active, suspended, dormant, or closed, and why if restricted.",
      inputSchema: z.object({ account_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        { account_id: { type: 'string', description: 'A specific account ID (optional)' } },
        [],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        try {
          const account = await accounts.resolveForCustomer(customerId, args.account_id);
          return { accountNumber: maskAccountNumber(account.accountNumber), status: account.status, statusReason: account.statusReason ?? null };
        } catch {
          return FALLBACK_ACCOUNT;
        }
      },
    },
    {
      name: 'get_account_limits',
      description: "Get the customer's daily transfer and withdrawal limits for their account.",
      inputSchema: z.object({ account_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        { account_id: { type: 'string', description: 'A specific account ID (optional)' } },
        [],
      ),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        const account = await accounts.resolveForCustomer(customerId, args.account_id);
        return accounts.getLimits(account.id);
      },
    },
    {
      name: 'get_fees',
      description:
        'Get standard fees: transfers, ATM withdrawals, card replacement, and international transactions. ' +
        'General product information — not customer-specific, safe to answer without verification.',
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      minVerificationLevel: VerificationLevel.PUBLIC,
      idempotent: true,
      handler: async () => config.get('banking.fees'),
    },
  ];
}
