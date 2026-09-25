import { z } from 'zod';
import { PrismaService } from '../../../database/prisma.service';
import { VerificationService } from '../../verification/verification.service';
import { ToolDefinition } from '../tool-definition.interface';
import { requireCustomerId, toJsonSchema } from './shared';

export function buildVerificationTools(verification: VerificationService, prisma: PrismaService): ToolDefinition[] {
  return [
    {
      name: 'start_verification',
      description:
        'Starts general identity verification (sends a one-time code) when a VERIFIED-tier action without its ' +
        'own initiate tool (card replace/activate/unblock, add beneficiary, transfer) is blocked with ' +
        'VERIFICATION_REQUIRED. Do NOT use for PIN/password reset — call initiate_pin_reset/' +
        'initiate_password_reset directly instead.',
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      handler: async (ctx) => {
        return verification.startVerification({
          customerId: requireCustomerId(ctx),
          conversationId: ctx.conversationId,
          purpose: 'IDENTITY',
        });
      },
    },
    {
      name: 'verify_otp',
      description:
        'Submit the one-time code the customer just received — the ONLY tool for this, whether sent for ' +
        'identity verification, PIN reset, or password reset. Always resolves to this conversation\'s most ' +
        "recently started verification — don't worry which flow it belongs to, just call it with the code given.",
      inputSchema: z.object({ code: z.string().length(6) }),
      parametersJsonSchema: toJsonSchema({ code: { type: 'string', description: 'The 6-digit code the customer received' } }, ['code']),
      sensitiveArgs: ['code'],
      handler: async (ctx, args) => {
        return verification.verifyPendingCode(requireCustomerId(ctx), ctx.conversationId, args.code);
      },
    },
    {
      name: 'get_verification_status',
      description:
        "Get the customer's current identity verification status for this conversation, including whether " +
        'their online banking login is locked from too many failed attempts.',
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      idempotent: true,
      handler: async (ctx) => {
        const customerId = requireCustomerId(ctx);
        const [status, customer] = await Promise.all([
          verification.computeStatus(customerId, ctx.conversationId),
          prisma.customer.findUnique({ where: { id: customerId } }),
        ]);
        return {
          status,
          onlineBankingLocked: customer?.onlineBankingLocked ?? false,
          failedLoginAttempts: customer?.failedLoginAttempts ?? 0,
        };
      },
    },
  ];
}
