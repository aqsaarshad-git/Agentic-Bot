import { z } from 'zod';
import { Card } from '@prisma/client';
import { AccountsService } from '../../accounts/accounts.service';
import { CardsService } from '../../cards/cards.service';
import { ToolDefinition } from '../tool-definition.interface';
import { VerificationLevel } from '../verification-level';
import { requireCustomerId, toJsonSchema } from './shared';

function mapCard(c: Card) {
  return {
    cardId: c.id,
    cardNumberMasked: c.cardNumberMasked,
    cardType: c.cardType,
    status: c.status,
    expiryMonth: c.expiryMonth,
    expiryYear: c.expiryYear,
    activationRequired: c.status === 'PENDING_ACTIVATION',
  };
}

// card_id is optional on every one of these — resolved to the customer's single card when they
// only have one (see CardsService.resolveForCustomer). This closes a real, observed failure
// mode: asked to act on "the" card, a small model would sometimes invent a plausible-looking ID
// instead of copying the real one from a prior get_cards result — with only one card on file
// (the common case), there's nothing left it can get wrong.
const CARD_ID_DESC = {
  type: 'string',
  description: 'Exact cardId from get_cards/get_card. Optional if the customer has only one card (auto-resolves) — never invent one.',
};

export function buildCardTools(accounts: AccountsService, cards: CardsService): ToolDefinition[] {
  return [
    {
      name: 'get_cards',
      description: "List the customer's debit/credit cards and their status.",
      inputSchema: z.object({ account_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema({ account_id: { type: 'string', description: 'Limit to one account (optional)' } }, []),
      idempotent: true,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        const accountIds = args.account_id
          ? [(await accounts.assertOwned(args.account_id, customerId)).id]
          : (await accounts.findAllForCustomer(customerId)).map((a) => a.id);
        const rows = await cards.findForAccounts(accountIds);
        return { cards: rows.map(mapCard) };
      },
    },
    {
      name: 'get_card',
      description: "Get details of one of the customer's cards.",
      inputSchema: z.object({ card_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema({ card_id: CARD_ID_DESC }, []),
      idempotent: true,
      handler: async (ctx, args) => {
        const card = await cards.resolveForCustomer(requireCustomerId(ctx), args.card_id);
        return mapCard(card);
      },
    },
    {
      name: 'activate_card',
      description: 'Activate a new card that is pending activation.',
      inputSchema: z.object({ card_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema({ card_id: CARD_ID_DESC }, []),
      minVerificationLevel: VerificationLevel.VERIFIED,
      handler: async (ctx, args) => {
        const card = await cards.resolveForCustomer(requireCustomerId(ctx), args.card_id);
        const updated = await cards.activate(card.id);
        return mapCard(updated);
      },
    },
    {
      name: 'block_card',
      description: "Block the customer's card, e.g. if they suspect misuse or simply want it temporarily disabled.",
      inputSchema: z.object({ card_id: z.string().optional(), reason: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        { card_id: CARD_ID_DESC, reason: { type: 'string', description: 'Why the card is being blocked' } },
        [],
      ),
      handler: async (ctx, args) => {
        const card = await cards.resolveForCustomer(requireCustomerId(ctx), args.card_id);
        const updated = await cards.block(card.id, args.reason);
        return mapCard(updated);
      },
    },
    {
      name: 'unblock_card',
      description: 'Unblock a previously blocked card, if policy allows (not lost, stolen, or expired).',
      inputSchema: z.object({ card_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema({ card_id: CARD_ID_DESC }, []),
      minVerificationLevel: VerificationLevel.VERIFIED,
      handler: async (ctx, args) => {
        const card = await cards.resolveForCustomer(requireCustomerId(ctx), args.card_id);
        const updated = await cards.unblock(card.id);
        return mapCard(updated);
      },
    },
    {
      name: 'replace_card',
      description: 'Request a replacement for a damaged or expired card (not lost/stolen — use report_lost_card or report_stolen_card for those).',
      inputSchema: z.object({ card_id: z.string().optional(), reason: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        { card_id: CARD_ID_DESC, reason: { type: 'string', description: 'Why a replacement is needed' } },
        [],
      ),
      minVerificationLevel: VerificationLevel.VERIFIED,
      handler: async (ctx, args) => {
        const card = await cards.resolveForCustomer(requireCustomerId(ctx), args.card_id);
        const replacement = await cards.replace(card.id, args.reason);
        return { requested: true, replacementCard: mapCard(replacement) };
      },
    },
    {
      name: 'report_lost_card',
      description: "Report the card lost — immediately blocks it and requests a replacement. Urgent, don't delay.",
      inputSchema: z.object({ card_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema({ card_id: CARD_ID_DESC }, []),
      handler: async (ctx, args) => {
        const resolved = await cards.resolveForCustomer(requireCustomerId(ctx), args.card_id);
        const { card, replacement } = await cards.reportLost(resolved.id);
        return { blocked: true, card: mapCard(card), replacementCard: mapCard(replacement) };
      },
    },
    {
      name: 'report_stolen_card',
      description:
        "Report the card stolen — immediately blocks it and requests a replacement. Urgent, don't delay. If " +
        'the customer mentions unauthorized use, also consider create_support_case (fraud).',
      inputSchema: z.object({ card_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema({ card_id: CARD_ID_DESC }, []),
      handler: async (ctx, args) => {
        const resolved = await cards.resolveForCustomer(requireCustomerId(ctx), args.card_id);
        const { card, replacement } = await cards.reportStolen(resolved.id);
        return { blocked: true, card: mapCard(card), replacementCard: mapCard(replacement) };
      },
    },
  ];
}
