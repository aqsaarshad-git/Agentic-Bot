import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { randomInt } from 'crypto';
import { CardsService } from '../../cards/cards.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../../database/prisma.service';
import { VerificationService } from '../../verification/verification.service';
import { ToolDefinition } from '../tool-definition.interface';
import { requireCustomerId, toJsonSchema } from './shared';

/**
 * PIN reset is a real, protected workflow: a fresh, PIN-scoped OTP (VerificationSession via
 * purpose: PIN_RESET) IS the verification for this specific action — no separate general
 * identity step-up is required first (that would be a redundant, confusing double-gate: this
 * flow's whole job is achieving verification, not something requiring it as a precondition).
 * initiate_pin_reset/complete_pin_reset therefore sit at the default AUTHENTICATED tier; the
 * real enforcement is complete_pin_reset's own check that a VERIFIED, unconsumed PIN_RESET
 * session exists. The resulting temporary PIN is bcrypt-hashed into Card.pinHash and delivered
 * out-of-band — it is NEVER put into a tool result, so it never passes through Qwen or appears
 * in the conversation transcript.
 */
export function buildPinTools(
  cards: CardsService,
  verification: VerificationService,
  notifications: NotificationsService,
  prisma: PrismaService,
): ToolDefinition[] {
  return [
    {
      name: 'initiate_pin_reset',
      description:
        "Start a PIN reset for one of the customer's cards. Sends a one-time code specifically for this " +
        'action — the customer submits it via verify_otp, then call complete_pin_reset.',
      inputSchema: z.object({ card_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        {
          card_id: {
            type: 'string',
            description: "The card's exact cardId from a previous get_cards result. Optional if the customer has only one card.",
          },
        },
        [],
      ),
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        const card = await cards.resolveForCustomer(customerId, args.card_id);
        if (card.status === 'LOST' || card.status === 'STOLEN') {
          throw new BadRequestException('This card is reported lost or stolen — request a replacement instead of resetting its PIN');
        }
        return verification.startVerification({
          customerId,
          conversationId: ctx.conversationId,
          purpose: 'PIN_RESET',
          targetRef: card.id,
        });
      },
    },
    {
      name: 'complete_pin_reset',
      description:
        'Finish a verified PIN reset — generates and securely delivers a new temporary PIN to the customer. ' +
        'Only works after the customer has confirmed the code sent by initiate_pin_reset via verify_otp. ' +
        'Never reveals the PIN in the conversation itself; only confirms it was sent.',
      inputSchema: z.object({}),
      parametersJsonSchema: toJsonSchema({}, []),
      handler: async (ctx) => {
        const customerId = requireCustomerId(ctx);
        const session = await verification.getVerifiedSession(customerId, ctx.conversationId, 'PIN_RESET');
        if (!session?.targetRef) {
          throw new BadRequestException('Verify the PIN reset code first (verify_otp)');
        }
        const card = await cards.findOneForCustomer(session.targetRef, customerId);
        const tempPin = randomInt(0, 10000).toString().padStart(4, '0');
        await cards.setPin(card.id, tempPin);
        await verification.consumeSession(session.id);
        const customer = await prisma.customer.findUnique({ where: { id: customerId } });
        await notifications.send({
          recipientType: 'CUSTOMER',
          recipientId: customerId,
          channel: customer?.email ? 'EMAIL' : 'SMS',
          subject: 'Your new card PIN',
          content: `Your new temporary PIN is ${tempPin}. Please change it at an ATM as soon as possible.`,
          redactedContent: 'Your new temporary PIN is [REDACTED]. Please change it at an ATM as soon as possible.',
        });
        return { status: 'temp_pin_sent', cardId: card.id, cardNumberMasked: card.cardNumberMasked };
      },
    },
  ];
}
