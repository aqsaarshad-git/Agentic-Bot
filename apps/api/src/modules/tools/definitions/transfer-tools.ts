import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { AccountsService } from '../../accounts/accounts.service';
import { BeneficiariesService } from '../../beneficiaries/beneficiaries.service';
import { TransfersService } from '../../transfers/transfers.service';
import { VerificationService } from '../../verification/verification.service';
import { ToolDefinition } from '../tool-definition.interface';
import { VerificationLevel } from '../verification-level';
import { requireCustomerId, toJsonSchema } from './shared';

function requireConversationId(ctx: { conversationId?: string }): string {
  if (!ctx.conversationId) {
    throw new BadRequestException('A transfer requires an active conversation');
  }
  return ctx.conversationId;
}

/**
 * Money movement is deliberately a two-tool propose/confirm flow — see create_transfer and
 * confirm_transfer below. Only INTERNAL (between the customer's own accounts) or BENEFICIARY
 * (a saved payee, added via add_beneficiary first) transfers exist — there is no "transfer to
 * an arbitrary account number" tool, which is what makes beneficiary ownership/status checks
 * meaningful rather than decorative.
 */
export function buildTransferTools(
  accounts: AccountsService,
  transfers: TransfersService,
  verification: VerificationService,
  beneficiaries: BeneficiariesService,
): ToolDefinition[] {
  return [
    {
      name: 'get_transfer_limits',
      description: "Get the customer's daily transfer limit and how much of it remains today.",
      inputSchema: z.object({ account_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema({ account_id: { type: 'string', description: 'A specific account ID (optional)' } }, []),
      idempotent: true,
      handler: async (ctx, args) => {
        const account = await accounts.resolveForCustomer(requireCustomerId(ctx), args.account_id);
        return transfers.getRemainingDailyLimit(account.id);
      },
    },
    {
      name: 'create_transfer',
      description:
        'Propose a transfer — does NOT move money yet. Returns a summary the customer must explicitly confirm ' +
        '(call confirm_transfer only after a clear yes) before anything executes. Provide exactly one of ' +
        "destination_account_id (customer's own other account) or a beneficiary transfer: pass beneficiary_id " +
        'if known, else beneficiary_name (matched against their real saved beneficiaries) — never invent an ID.',
      inputSchema: z.object({
        amount: z.number().positive(),
        destination_account_id: z.string().optional(),
        beneficiary_id: z.string().optional(),
        beneficiary_name: z.string().optional(),
        source_account_id: z.string().optional(),
        reason: z.string().optional(),
      }),
      parametersJsonSchema: toJsonSchema(
        {
          amount: { type: 'number', description: 'The amount to transfer' },
          destination_account_id: {
            type: 'string',
            description: "Exact accountId of the customer's OTHER own account, from get_account — never invent one",
          },
          beneficiary_id: {
            type: 'string',
            description: 'Exact beneficiaryId from get_beneficiaries, if known — never invent one',
          },
          beneficiary_name: {
            type: 'string',
            description: "Beneficiary name as the customer said it, if beneficiary_id is unknown — matched against their saved list",
          },
          source_account_id: { type: 'string', description: 'Source account ID (optional, defaults to primary)' },
          reason: { type: 'string', description: 'A note for this transfer (optional)' },
        },
        ['amount'],
      ),
      minVerificationLevel: VerificationLevel.VERIFIED,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        const conversationId = requireConversationId(ctx);
        const fromAccount = await accounts.resolveForCustomer(customerId, args.source_account_id);
        const identitySession = await verification.getVerifiedSession(customerId, conversationId, 'IDENTITY');
        const resolvedBeneficiary =
          args.beneficiary_id || args.beneficiary_name
            ? await beneficiaries.resolveForCustomer(customerId, args.beneficiary_id, args.beneficiary_name)
            : undefined;
        const { transfer, toAccount, beneficiary } = await transfers.proposeTransfer({
          customerId,
          conversationId,
          fromAccountId: fromAccount.id,
          toAccountId: args.destination_account_id,
          beneficiaryId: resolvedBeneficiary?.id,
          amount: args.amount,
          reason: args.reason,
          verificationSessionId: identitySession?.id,
        });
        const destinationAccountNumber = toAccount?.accountNumber ?? beneficiary?.accountNumber ?? '';
        return {
          transferReference: transfer.transferReference,
          sourceAccountLast4: fromAccount.accountNumber.slice(-4),
          destinationLast4: destinationAccountNumber.slice(-4),
          destinationName: beneficiary?.beneficiaryName,
          amount: Number(transfer.amount),
          currency: transfer.currency,
          expiresInMinutes: 5,
          requiresConfirmation: true,
        };
      },
    },
    {
      name: 'confirm_transfer',
      description:
        'Execute the transfer just proposed — call ONLY in direct response to the customer explicitly ' +
        'confirming the create_transfer summary, never an earlier/unrelated "yes". No arguments; acts on ' +
        "this conversation's one pending transfer, fails safely if none.",
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      minVerificationLevel: VerificationLevel.VERIFIED,
      handler: async (ctx) => {
        const customerId = requireCustomerId(ctx);
        const conversationId = requireConversationId(ctx);
        const { transferReference, transaction } = await transfers.confirmAndExecute(customerId, conversationId);
        return {
          transferReference,
          status: 'COMPLETED',
          amount: Number(transaction.amount),
          currency: transaction.currency,
          providerReference: transaction.transactionRef,
          executedAt: transaction.settledAt,
        };
      },
    },
    {
      name: 'cancel_transfer',
      description: "Cancel this conversation's most recently proposed transfer, before it's confirmed.",
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      minVerificationLevel: VerificationLevel.VERIFIED,
      handler: async (ctx) => {
        return transfers.cancelPending(requireCustomerId(ctx), requireConversationId(ctx));
      },
    },
  ];
}
