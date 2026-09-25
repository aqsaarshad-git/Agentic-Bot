import { z } from 'zod';
import { Beneficiary } from '@prisma/client';
import { BeneficiariesService } from '../../beneficiaries/beneficiaries.service';
import { ToolDefinition } from '../tool-definition.interface';
import { VerificationLevel } from '../verification-level';
import { maskAccountNumber, requireCustomerId, toJsonSchema } from './shared';

function mapBeneficiary(b: Beneficiary) {
  return {
    beneficiaryId: b.id,
    nickname: b.nickname ?? undefined,
    beneficiaryName: b.beneficiaryName,
    accountNumber: maskAccountNumber(b.accountNumber),
    bankName: b.bankName ?? undefined,
    status: b.status,
  };
}

export function buildBeneficiaryTools(beneficiaries: BeneficiariesService): ToolDefinition[] {
  return [
    {
      name: 'get_beneficiaries',
      description: "List the customer's saved beneficiaries/payees for transfers.",
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      idempotent: true,
      handler: async (ctx) => {
        const rows = await beneficiaries.findForCustomer(requireCustomerId(ctx));
        return { beneficiaries: rows.map(mapBeneficiary) };
      },
    },
    {
      name: 'add_beneficiary',
      description: 'Add a new beneficiary/payee the customer can transfer money to.',
      inputSchema: z.object({
        beneficiary_name: z.string(),
        account_number: z.string(),
        bank_name: z.string().optional(),
        bank_code: z.string().optional(),
        nickname: z.string().optional(),
      }),
      parametersJsonSchema: toJsonSchema(
        {
          beneficiary_name: { type: 'string', description: "The beneficiary's full name" },
          account_number: { type: 'string', description: "The beneficiary's account number" },
          bank_name: { type: 'string', description: 'The beneficiary\'s bank name (optional)' },
          bank_code: { type: 'string', description: 'The beneficiary\'s bank code (optional)' },
          nickname: { type: 'string', description: 'A short nickname for this beneficiary (optional)' },
        },
        ['beneficiary_name', 'account_number'],
      ),
      minVerificationLevel: VerificationLevel.VERIFIED,
      handler: async (ctx, args) => {
        const beneficiary = await beneficiaries.add({
          customerId: requireCustomerId(ctx),
          beneficiaryName: args.beneficiary_name,
          accountNumber: args.account_number,
          bankName: args.bank_name,
          bankCode: args.bank_code,
          nickname: args.nickname,
        });
        return mapBeneficiary(beneficiary);
      },
    },
    {
      name: 'remove_beneficiary',
      description: "Remove a beneficiary/payee from the customer's saved list.",
      inputSchema: z.object({ beneficiary_id: z.string() }),
      parametersJsonSchema: toJsonSchema(
        { beneficiary_id: { type: 'string', description: 'The exact beneficiaryId from a previous get_beneficiaries result — never invent one' } },
        ['beneficiary_id'],
      ),
      handler: async (ctx, args) => {
        const beneficiary = await beneficiaries.remove(args.beneficiary_id, requireCustomerId(ctx));
        return { removed: true, beneficiaryId: beneficiary.id };
      },
    },
  ];
}
