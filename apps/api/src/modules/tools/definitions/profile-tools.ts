import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { CustomersService } from '../../customers/customers.service';
import { VerificationService } from '../../verification/verification.service';
import { ToolDefinition } from '../tool-definition.interface';
import { VerificationLevel } from '../verification-level';
import { requireCustomerId, toJsonSchema } from './shared';

/**
 * CONFIRMED LIVE (2026-09-29): the first version of this tool was gated behind
 * `minVerificationLevel: VERIFIED` at the registry level — the same shape as create_transfer.
 * That relies on Qwen noticing the rejection, separately calling start_verification, then
 * REMEMBERING to re-invoke update_contact_info with the right values once the customer reads
 * back a code — three independent judgment calls with nothing forcing them, and live testing
 * showed it reliably failing (0/3 real runs completed; one run even invented a support-case ID
 * that was never actually created). Transfers avoid this because confirm_transfer needs zero
 * arguments — the pending amount/beneficiary already lives server-side. This tool now does the
 * same: when verification is missing, it starts the OTP challenge itself and stores the
 * requested change on the session's targetRef; orchestrator.service.ts's existing OTP-digit
 * forcing path (the same one that verifies a bare "the code is 123456") applies it automatically
 * once the code is confirmed, so Qwen only ever has to get ONE decision right — recognizing the
 * request and calling this tool with the stated values — not a five-hop recovery chain.
 */
export function buildProfileTools(customers: CustomersService, verification: VerificationService): ToolDefinition[] {
  return [
    {
      name: 'update_contact_info',
      description:
        "Update the customer's registered phone number, email address, and/or mailing address. Provide only " +
        'the field(s) that changed. Handles verification itself — call this directly with the new value(s), ' +
        'even before the customer is verified.',
      inputSchema: z
        .object({
          phone: z.string().optional(),
          email: z.string().email().optional(),
          address: z.string().optional(),
        })
        .refine((v) => v.phone || v.email || v.address, { message: 'Provide at least one field to update' }),
      parametersJsonSchema: toJsonSchema(
        {
          phone: { type: 'string', description: 'New phone number, if it changed' },
          email: { type: 'string', description: 'New email address, if it changed' },
          address: { type: 'string', description: 'New mailing address, if it changed' },
        },
        [],
      ),
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        if (!args.phone && !args.email && !args.address) {
          throw new BadRequestException('Provide at least one field to update');
        }
        const level = await verification.computeLevel(customerId, ctx.conversationId);
        if (level < VerificationLevel.VERIFIED) {
          await verification.createSession({
            customerId,
            conversationId: ctx.conversationId,
            purpose: 'IDENTITY',
            targetRef: JSON.stringify({ phone: args.phone, email: args.email, address: args.address }),
          });
          return {
            updated: false,
            needsVerification: true,
            message:
              'A verification code has been sent. Tell the customer a code was sent and ask them to read it back — ' +
              'do not say the change is complete yet.',
          };
        }
        const updated = await customers.updateContactInfo(customerId, {
          phone: args.phone,
          email: args.email,
          address: args.address,
        });
        return { updated: true, phone: updated.phone, email: updated.email, address: updated.address ?? undefined };
      },
    },
  ];
}
