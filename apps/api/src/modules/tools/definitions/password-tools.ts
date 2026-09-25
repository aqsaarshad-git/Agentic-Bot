import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { VerificationService } from '../../verification/verification.service';
import { ToolDefinition } from '../tool-definition.interface';
import { requireCustomerId, toJsonSchema } from './shared';

function generateTemporaryPassword(): string {
  return randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
}

/**
 * Mirrors pin-tools.ts exactly: a fresh, PASSWORD_RESET-scoped OTP IS the verification for this
 * action (no redundant general-identity gate first — see pin-tools.ts's doc comment for why
 * that would be a confusing double-gate), same "never put the secret in a tool result" rule.
 */
export function buildPasswordTools(
  verification: VerificationService,
  notifications: NotificationsService,
  prisma: PrismaService,
): ToolDefinition[] {
  return [
    {
      name: 'initiate_password_reset',
      description:
        "Start a reset of the customer's online banking password. Sends a one-time code for this action " +
        '— the customer submits it via verify_otp, then call complete_password_reset.',
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      handler: async (ctx) => {
        const customerId = requireCustomerId(ctx);
        return verification.startVerification({ customerId, conversationId: ctx.conversationId, purpose: 'PASSWORD_RESET' });
      },
    },
    {
      name: 'complete_password_reset',
      description:
        'Finish a verified password reset — generates and securely delivers a new temporary password, and clears ' +
        'any account lock from too many failed logins. Never reveals the password in the conversation itself.',
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      handler: async (ctx) => {
        const customerId = requireCustomerId(ctx);
        const session = await verification.getVerifiedSession(customerId, ctx.conversationId, 'PASSWORD_RESET');
        if (!session) {
          throw new BadRequestException('Verify the password reset code first (verify_otp)');
        }
        const tempPassword = generateTemporaryPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 10);
        const customer = await prisma.customer.update({
          where: { id: customerId },
          data: { passwordHash, onlineBankingLocked: false, onlineBankingLockedAt: null, failedLoginAttempts: 0 },
        });
        await verification.consumeSession(session.id);
        await notifications.send({
          recipientType: 'CUSTOMER',
          recipientId: customerId,
          channel: customer.email ? 'EMAIL' : 'SMS',
          subject: 'Your new temporary password',
          content: `Your new temporary password is ${tempPassword}. Please change it after logging in.`,
          redactedContent: 'Your new temporary password is [REDACTED]. Please change it after logging in.',
        });
        return { status: 'temp_password_sent' };
      },
    },
  ];
}
