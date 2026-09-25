import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

type DemoTransaction = {
  id: string;
  date: string;
  amount: number;
  currency: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  reason?: string;
};

type AccountOverride = {
  status?: 'ACTIVE' | 'DORMANT' | 'SUSPENDED' | 'CLOSED';
  statusReason?: string;
};

type CardOverride = {
  status?: 'ACTIVE' | 'BLOCKED' | 'EXPIRED' | 'LOST' | 'STOLEN' | 'PENDING_ACTIVATION' | 'PENDING_REPLACEMENT';
  pinFailedAttempts?: number;
  pinBlockedAt?: Date;
  blockReason?: string;
  lostReportedAt?: Date;
  stolenReportedAt?: Date;
};

type SupportCaseSeed = {
  category: string;
  subcategory?: string;
  description: string;
  status?: 'NEW' | 'OPEN' | 'IN_PROGRESS' | 'WAITING_FOR_CUSTOMER' | 'ESCALATED' | 'RESOLVED' | 'CLOSED';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  linkTransactionRef?: string;
  linkCard?: boolean;
  disputeAmount?: number;
};

interface DemoCustomer {
  fullName: string;
  email: string;
  phone: string;
  language: string;
  metadata: {
    account: { accountNumber: string; accountType: string; status: string; openedDate: string };
    balance: { balance: number; currency: string };
    transactions: DemoTransaction[];
  };
  // Additional transactions backfilled into the real Transaction table only (not the
  // legacy metadata blob) — used to sharpen an archetype without disturbing what the
  // still-live legacy get_transactions tool currently returns.
  extraTransactions?: DemoTransaction[];
  accountOverride?: AccountOverride;
  // Masked last-4 digits for this customer's primary seeded card.
  cardLast4: string;
  cardOverride?: CardOverride;
  // When set, seeds a second card (PENDING_REPLACEMENT) replacing the primary one.
  replacementCardLast4?: string;
  onlineBankingLocked?: boolean;
  failedLoginAttempts?: number;
  supportCase?: SupportCaseSeed;
}

// Each demo customer sees THEIR OWN data when the AI calls the account/card/transaction
// tools. The `metadata` JSON blob is the legacy demo data source (still read by the
// pre-banking-domain tools); the fields below drive the real Account/Transaction/Card/
// Ticket rows backfilled further down, which the banking-domain tools read instead.
// Fixed emails/phones so the same login works every test run; combine with
// OTP_DEV_BYPASS_CODE to skip the OTP hassle entirely.
const DEMO_CUSTOMERS: DemoCustomer[] = [
  {
    // Archetype A-adjacent (kept as-is: one historical failed/pending txn + healthy history).
    fullName: 'Ahmed Al-Rashid',
    email: 'ahmed@example.com',
    phone: '+966501234567',
    language: 'ar',
    metadata: {
      account: { accountNumber: 'ACC-10029384', accountType: 'PERSONAL', status: 'ACTIVE', openedDate: '2024-02-11' },
      balance: { balance: 1250.75, currency: 'SAR' },
      transactions: [
        { id: 'TXN-9931', date: '2026-09-03', amount: 89.0, currency: 'SAR', status: 'FAILED', reason: 'Insufficient funds' },
        { id: 'TXN-9918', date: '2026-09-01', amount: 120.0, currency: 'SAR', status: 'PENDING' },
        { id: 'TXN-9902', date: '2026-08-29', amount: 250.0, currency: 'SAR', status: 'COMPLETED' },
        { id: 'TXN-9884', date: '2026-08-21', amount: 45.5, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    cardLast4: '3341',
  },
  {
    // Archetype A: active, healthy, all-completed history.
    fullName: 'Sara Al-Fahad',
    email: 'sara@example.com',
    phone: '+966502345678',
    language: 'ar',
    metadata: {
      account: { accountNumber: 'ACC-10047621', accountType: 'PERSONAL', status: 'ACTIVE', openedDate: '2023-06-04' },
      balance: { balance: 8340.2, currency: 'SAR' },
      transactions: [
        { id: 'TXN-8821', date: '2026-09-05', amount: 500.0, currency: 'SAR', status: 'COMPLETED' },
        { id: 'TXN-8790', date: '2026-08-27', amount: 1200.0, currency: 'SAR', status: 'COMPLETED' },
        { id: 'TXN-8754', date: '2026-08-14', amount: 75.0, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    cardLast4: '4452',
  },
  {
    // Archetype B: insufficient-funds failure + pending transaction, active card.
    fullName: 'Mohammed bin Khalid',
    email: 'mohammed@example.com',
    phone: '+966503456789',
    language: 'en',
    metadata: {
      account: { accountNumber: 'ACC-10058873', accountType: 'BUSINESS', status: 'ACTIVE', openedDate: '2022-11-30' },
      balance: { balance: 340.0, currency: 'SAR' },
      transactions: [
        { id: 'TXN-7710', date: '2026-09-06', amount: 60.0, currency: 'SAR', status: 'PENDING' },
        { id: 'TXN-7699', date: '2026-09-02', amount: 300.0, currency: 'SAR', status: 'FAILED', reason: 'Card expired' },
        { id: 'TXN-7654', date: '2026-08-19', amount: 150.0, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    extraTransactions: [
      { id: 'TXN-7722', date: '2026-09-07', amount: 210.0, currency: 'SAR', status: 'FAILED', reason: 'Insufficient funds' },
    ],
    cardLast4: '5563',
  },
  {
    // Archetype C: PIN blocked, online banking locked, suspended account.
    fullName: 'Fatima Al-Zahra',
    email: 'fatima@example.com',
    phone: '+966504567890',
    language: 'ar',
    metadata: {
      account: { accountNumber: 'ACC-10061190', accountType: 'PERSONAL', status: 'SUSPENDED', openedDate: '2025-01-17' },
      balance: { balance: 12.4, currency: 'SAR' },
      transactions: [
        { id: 'TXN-6602', date: '2026-08-30', amount: 40.0, currency: 'SAR', status: 'FAILED', reason: 'Account suspended' },
        { id: 'TXN-6590', date: '2026-08-10', amount: 90.0, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    accountOverride: { status: 'SUSPENDED', statusReason: 'Suspended pending identity re-verification' },
    cardLast4: '6674',
    cardOverride: {
      status: 'BLOCKED',
      pinFailedAttempts: 3,
      pinBlockedAt: new Date('2026-09-19T10:15:00Z'),
      blockReason: 'PIN blocked after 3 consecutive failed attempts',
    },
    onlineBankingLocked: true,
    failedLoginAttempts: 5,
  },
  // Real test customer for the PSTN calling feature — +923124439804 is a genuine phone number
  // (not a demo/placeholder), seeded so a real inbound/outbound call resolves to this actual
  // profile (see PstnCallService.findOrCreateCustomerByPhone's normalized-last-10-digits match)
  // instead of an auto-created "Caller <number>" placeholder with no account context.
  {
    fullName: 'Aqsa',
    // Real Gmail address (2026-09-23) — statement-email delivery testing needs a real inbox
    // that actually receives mail, unlike the Ethereal sandbox used for everything else.
    email: 'aqsaarshad094@gmail.com',
    phone: '+923124439804',
    language: 'en',
    metadata: {
      account: { accountNumber: 'ACC-10072341', accountType: 'PERSONAL', status: 'ACTIVE', openedDate: '2025-04-02' },
      balance: { balance: 2430.5, currency: 'SAR' },
      transactions: [
        { id: 'TXN-5510', date: '2026-09-08', amount: 150.0, currency: 'SAR', status: 'COMPLETED' },
        { id: 'TXN-5487', date: '2026-08-30', amount: 60.0, currency: 'SAR', status: 'PENDING' },
        { id: 'TXN-5462', date: '2026-08-19', amount: 220.0, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    cardLast4: '7785',
  },
  {
    fullName: 'Shamir',
    email: 'shamir@example.com',
    phone: '+923037433442',
    language: 'en',
    metadata: {
      account: { accountNumber: 'ACC-10083452', accountType: 'PERSONAL', status: 'ACTIVE', openedDate: '2025-06-19' },
      balance: { balance: 975.0, currency: 'SAR' },
      transactions: [
        { id: 'TXN-4410', date: '2026-09-07', amount: 200.0, currency: 'SAR', status: 'COMPLETED' },
        { id: 'TXN-4392', date: '2026-08-25', amount: 45.0, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    cardLast4: '8896',
  },
  {
    // Archetype D: lost/stolen card + replacement in progress.
    fullName: 'Khalid Al-Otaibi',
    email: 'khalid@example.com',
    phone: '+966505678901',
    language: 'ar',
    metadata: {
      account: { accountNumber: 'ACC-10094512', accountType: 'PERSONAL', status: 'ACTIVE', openedDate: '2024-05-10' },
      balance: { balance: 3200.0, currency: 'SAR' },
      transactions: [
        { id: 'TXN-3310', date: '2026-09-10', amount: 180.0, currency: 'SAR', status: 'COMPLETED' },
        { id: 'TXN-3298', date: '2026-08-28', amount: 95.0, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    cardLast4: '5588',
    cardOverride: {
      status: 'STOLEN',
      stolenReportedAt: new Date('2026-09-19T08:30:00Z'),
      blockReason: 'Reported stolen by customer',
    },
    replacementCardLast4: '5599',
    supportCase: {
      category: 'CARD_ISSUE',
      subcategory: 'STOLEN_CARD',
      description: 'Customer reported their debit card stolen; replacement card requested and in progress.',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      linkCard: true,
    },
  },
  {
    // Archetype E: suspicious/disputed transaction.
    fullName: 'Noura Al-Harbi',
    email: 'noura@example.com',
    phone: '+966506789012',
    language: 'ar',
    metadata: {
      account: { accountNumber: 'ACC-10105673', accountType: 'PERSONAL', status: 'ACTIVE', openedDate: '2023-09-22' },
      balance: { balance: 5600.0, currency: 'SAR' },
      transactions: [
        { id: 'TXN-2210', date: '2026-09-18', amount: 780.0, currency: 'SAR', status: 'COMPLETED' },
        { id: 'TXN-2195', date: '2026-08-22', amount: 95.0, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    cardLast4: '7712',
    supportCase: {
      category: 'FRAUD_DISPUTE',
      subcategory: 'UNAUTHORIZED_TRANSACTION',
      description: "Customer does not recognize a transaction on their account and disputes it as unauthorized.",
      status: 'ESCALATED',
      priority: 'URGENT',
      linkTransactionRef: 'TXN-2210',
      disputeAmount: 780.0,
    },
  },
];

const DEFAULT_AGENT_TOOLS = [
  // Generic support
  'get_customer',
  'create_ticket',
  'get_ticket',
  'update_ticket',
  'escalate_ticket',
  'transfer_to_human',
  'end_call',
  'schedule_callback',
  // Account
  'get_account',
  'get_balance',
  'get_account_status',
  'get_account_limits',
  'get_fees',
  // Transactions
  'get_transactions',
  'get_transaction',
  'get_transaction_status',
  'get_transaction_failure_reason',
  // Cards
  'get_cards',
  'get_card',
  'activate_card',
  'block_card',
  'unblock_card',
  'replace_card',
  'report_lost_card',
  'report_stolen_card',
  // PIN
  'initiate_pin_reset',
  'complete_pin_reset',
  // Password
  'initiate_password_reset',
  'complete_password_reset',
  // Identity verification (verify_otp handles PIN/password reset codes too — see verification-tools.ts)
  'start_verification',
  'verify_otp',
  'get_verification_status',
  // Beneficiaries
  'get_beneficiaries',
  'add_beneficiary',
  'remove_beneficiary',
  // Transfers
  'get_transfer_limits',
  'create_transfer',
  'confirm_transfer',
  'cancel_transfer',
  // Support cases
  'create_support_case',
  'get_support_case',
  'get_customer_cases',
  // Statements
  'request_statement',
  'get_statement',
  'send_statement_by_email',
];

const PERMISSIONS = [
  'manage_users',
  'manage_agents',
  'manage_customers',
  'manage_tickets',
  'manage_knowledge_base',
  'manage_tools',
  'view_analytics',
  'view_audit_logs',
];

function mapAccountType(legacyType: string): 'CHECKING' | 'SAVINGS' | 'BUSINESS' {
  return legacyType === 'BUSINESS' ? 'BUSINESS' : 'CHECKING';
}

function mapFailureReason(reason?: string) {
  switch (reason) {
    case 'Insufficient funds':
      return 'INSUFFICIENT_FUNDS' as const;
    case 'Card expired':
      return 'CARD_EXPIRED' as const;
    case 'Account suspended':
      return 'ACCOUNT_SUSPENDED' as const;
    default:
      return reason ? ('OTHER' as const) : null;
  }
}

function maskedCardNumber(last4: string): string {
  return `**** **** **** ${last4}`;
}

async function upsertCard(
  accountId: string,
  cardNumberMasked: string,
  data: {
    status: 'ACTIVE' | 'BLOCKED' | 'EXPIRED' | 'LOST' | 'STOLEN' | 'PENDING_ACTIVATION' | 'PENDING_REPLACEMENT';
    pinFailedAttempts?: number;
    pinBlockedAt?: Date | null;
    pinSetAt?: Date | null;
    activatedAt?: Date | null;
    blockedAt?: Date | null;
    blockReason?: string | null;
    lostReportedAt?: Date | null;
    stolenReportedAt?: Date | null;
    replacesCardId?: string | null;
  },
) {
  const existing = await prisma.card.findFirst({ where: { accountId, cardNumberMasked } });
  const fields = {
    status: data.status,
    cardType: 'DEBIT' as const,
    expiryMonth: 11,
    expiryYear: 2028,
    pinFailedAttempts: data.pinFailedAttempts ?? 0,
    pinBlockedAt: data.pinBlockedAt ?? null,
    pinSetAt: data.pinSetAt ?? null,
    activatedAt: data.activatedAt ?? null,
    blockedAt: data.blockedAt ?? null,
    blockReason: data.blockReason ?? null,
    lostReportedAt: data.lostReportedAt ?? null,
    stolenReportedAt: data.stolenReportedAt ?? null,
    replacesCardId: data.replacesCardId ?? null,
  };
  if (existing) {
    return prisma.card.update({ where: { id: existing.id }, data: fields });
  }
  return prisma.card.create({ data: { accountId, cardNumberMasked, ...fields } });
}

async function main() {
  const roles = await Promise.all(
    ['ADMIN', 'SUPERVISOR', 'AGENT'].map((name) =>
      prisma.role.upsert({ where: { name }, create: { name }, update: {} }),
    ),
  );
  const adminRole = roles.find((r) => r.name === 'ADMIN')!;

  const permissions = await Promise.all(
    PERMISSIONS.map((name) => prisma.permission.upsert({ where: { name }, create: { name }, update: {} })),
  );

  await Promise.all(
    permissions.map((permission) =>
      prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id } },
        create: { roleId: adminRole.id, permissionId: permission.id },
        update: {},
      }),
    ),
  );

  const adminEmail = 'admin@example.com';
  const adminPassword = 'ChangeMe123!';
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  await prisma.user.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, passwordHash, name: 'Platform Admin', roleId: adminRole.id },
    update: {},
  });

  const customerIdByEmail = new Map<string, string>();
  for (const demo of DEMO_CUSTOMERS) {
    const existing = await prisma.customer.findFirst({ where: { email: demo.email } });
    if (existing) {
      await prisma.customer.update({
        where: { id: existing.id },
        data: {
          metadata: demo.metadata as unknown as Prisma.InputJsonValue,
          onlineBankingLocked: demo.onlineBankingLocked ?? false,
          failedLoginAttempts: demo.failedLoginAttempts ?? 0,
        },
      });
      customerIdByEmail.set(demo.email, existing.id);
    } else {
      const created = await prisma.customer.create({
        data: {
          fullName: demo.fullName,
          email: demo.email,
          phone: demo.phone,
          language: demo.language,
          metadata: demo.metadata as unknown as Prisma.InputJsonValue,
          onlineBankingLocked: demo.onlineBankingLocked ?? false,
          failedLoginAttempts: demo.failedLoginAttempts ?? 0,
        },
      });
      customerIdByEmail.set(demo.email, created.id);
    }
  }

  // Backfill the real banking-domain tables (Account/Transaction/Card/Ticket) from the
  // same demo definitions above — the legacy `metadata` JSON blob stays in place so the
  // pre-banking-domain tools keep working unchanged until they're cut over.
  for (const demo of DEMO_CUSTOMERS) {
    const customerId = customerIdByEmail.get(demo.email)!;
    const { account: legacyAccount, balance } = demo.metadata;

    const account = await prisma.account.upsert({
      where: { accountNumber: legacyAccount.accountNumber },
      create: {
        accountNumber: legacyAccount.accountNumber,
        customerId,
        accountType: mapAccountType(legacyAccount.accountType),
        status: demo.accountOverride?.status ?? (legacyAccount.status as 'ACTIVE' | 'SUSPENDED'),
        statusReason: demo.accountOverride?.statusReason ?? null,
        currency: balance.currency,
        balance: balance.balance,
        availableBalance: balance.balance,
        openedAt: new Date(legacyAccount.openedDate),
      },
      update: {
        accountType: mapAccountType(legacyAccount.accountType),
        status: demo.accountOverride?.status ?? (legacyAccount.status as 'ACTIVE' | 'SUSPENDED'),
        statusReason: demo.accountOverride?.statusReason ?? null,
        currency: balance.currency,
        balance: balance.balance,
        availableBalance: balance.balance,
      },
    });

    const allTransactions = [...demo.metadata.transactions, ...(demo.extraTransactions ?? [])];
    for (const txn of allTransactions) {
      await prisma.transaction.upsert({
        where: { transactionRef: txn.id },
        create: {
          transactionRef: txn.id,
          accountId: account.id,
          type: 'DEBIT',
          channel: 'OTHER',
          amount: txn.amount,
          currency: txn.currency,
          status: txn.status,
          failureReason: mapFailureReason(txn.reason),
          description: txn.reason ?? null,
          postedAt: new Date(txn.date),
        },
        update: {
          amount: txn.amount,
          currency: txn.currency,
          status: txn.status,
          failureReason: mapFailureReason(txn.reason),
          description: txn.reason ?? null,
        },
      });
    }

    const cardIsIssue = demo.cardOverride?.status && demo.cardOverride.status !== 'ACTIVE';
    const primaryCard = await upsertCard(account.id, maskedCardNumber(demo.cardLast4), {
      status: demo.cardOverride?.status ?? 'ACTIVE',
      pinFailedAttempts: demo.cardOverride?.pinFailedAttempts,
      pinBlockedAt: demo.cardOverride?.pinBlockedAt ?? null,
      pinSetAt: new Date(legacyAccount.openedDate),
      activatedAt: new Date(legacyAccount.openedDate),
      blockedAt: cardIsIssue ? new Date() : null,
      blockReason: demo.cardOverride?.blockReason ?? null,
      lostReportedAt: demo.cardOverride?.lostReportedAt ?? null,
      stolenReportedAt: demo.cardOverride?.stolenReportedAt ?? null,
    });

    if (demo.replacementCardLast4) {
      await upsertCard(account.id, maskedCardNumber(demo.replacementCardLast4), {
        status: 'PENDING_REPLACEMENT',
        replacesCardId: primaryCard.id,
      });
    }

    if (demo.supportCase) {
      const sc = demo.supportCase;
      const ticketNumber = `CASE-${legacyAccount.accountNumber}`;
      const linkedTransaction = sc.linkTransactionRef
        ? await prisma.transaction.findUnique({ where: { transactionRef: sc.linkTransactionRef } })
        : null;
      const existingTicket = await prisma.ticket.findUnique({ where: { ticketNumber } });
      const ticketData = {
        customerId,
        category: sc.category,
        subcategory: sc.subcategory ?? null,
        description: sc.description,
        status: sc.status ?? 'OPEN',
        priority: sc.priority ?? 'MEDIUM',
        accountId: account.id,
        cardId: sc.linkCard ? primaryCard.id : null,
        transactionId: linkedTransaction?.id ?? null,
        disputeAmount: sc.disputeAmount ?? null,
      };
      if (existingTicket) {
        await prisma.ticket.update({ where: { id: existingTicket.id }, data: ticketData });
      } else {
        await prisma.ticket.create({ data: { ticketNumber, ...ticketData } });
      }
    }
  }

  const defaultSystemInstructions =
    'You are a helpful, concise customer support assistant for a payment account service. ' +
    'Use the available tools to look up real account/transaction information rather than guessing. If you ' +
    "cannot resolve the customer's issue, offer to create a support ticket or transfer them to a human agent. " +
    'You are ALWAYS talking to exactly one already-authenticated customer — the one you are in this ' +
    "conversation with — and every account/balance/transaction/ticket tool you have only ever returns or " +
    "affects THIS customer's own data; there is no way for you to look up or act on any other person's " +
    'account, and you must never imply otherwise. If the customer asks about "my account", "my balance", or ' +
    '"my transactions", that always means their own account — never ask them to confirm whose account you ' +
    'mean, never ask for "a customer ID" to look someone else up, and never offer to check a different named ' +
    "person's account. If speech-to-text produced a name or phrase that seems unrelated to the request (a " +
    'likely mishearing), do not build a whole line of questioning around that name — briefly note you may not ' +
    "have understood correctly and ask the customer to repeat what THEY need, still assuming it's about their " +
    'own account. ' +
    "Always reply in the same language as the customer's most recent message (English or Arabic) — match " +
    'whatever they just wrote or said, even if it differs from earlier in the conversation. ' +
    'If the customer switches languages during the conversation, follow the language of their latest message, ' +
    "not earlier ones. Do not translate the customer's own message back to them unless they explicitly ask " +
    'for a translation. Do not mix Arabic and English within a single reply unless a term genuinely has no ' +
    'natural equivalent (e.g. a reference/transaction ID). Keep confirmations, clarifying questions, ' +
    'account/transaction details, and error or apology messages in that same language too — never switch ' +
    'languages partway through a reply. ' +
    'On a phone call, when the customer indicates they are done — e.g. "thanks, that\'s all", "okay bye", ' +
    'confirming their issue is resolved, or otherwise signaling the conversation is over — call the ' +
    'end_call tool, then give a brief, friendly goodbye, so the call closes out properly instead of ' +
    'being left open. ' +
    'Transfer policy: a transfer can only go to one of the customer\'s OWN other accounts (destination_account_id — ' +
    'never a third party\'s account number) or to a saved beneficiary (beneficiary_id, from get_beneficiaries). ' +
    'If the customer names an existing beneficiary, use them directly. If the customer wants to send money to ' +
    'someone not already saved, first collect that person\'s name and account number and call add_beneficiary, ' +
    'then create_transfer with the new beneficiary_id — there is no separate way to transfer straight to a bare ' +
    'account number, and you must never put a third party\'s account number into destination_account_id. ' +
    'Never state or imply that a transfer, PIN reset, password reset, or any other financial action has ' +
    'happened, is complete, or changed the account unless you actually called the corresponding tool THIS turn ' +
    'and it returned success — never narrate an action ahead of calling its tool, and never describe an updated ' +
    'balance without calling get_balance again first, even if a transfer was discussed earlier in the ' +
    'conversation. ' +
    'Bank statements: real statements are issued monthly by default — if the customer just says "my statement" ' +
    'with no period in mind, call request_statement with no period arguments at all (it defaults to last ' +
    'calendar month) rather than asking which period they mean. Only ask if they said something that implies a ' +
    'different period without being specific enough to compute yourself (e.g. "a few months back" — a named ' +
    'month, "last 3 months", "this year", or an explicit range should be converted to ISO dates by you, not ' +
    'asked about again). Then offer to email it to their registered address on file ' +
    '— e.g. "I can send this to your registered email address, would you like me to?" — never ask the customer ' +
    'for an email address and never accept one they give you; the destination is always their own address ' +
    'already on file, resolved by the backend, not something you provide as an argument. Only call ' +
    'send_statement_by_email after they clearly say yes to that specific offer, never on a bare greeting or an ' +
    'unrelated question — if they ask something else first, answer it and keep the offer to email the ' +
    'statement pending for later in the same conversation. Only tell the customer the statement was sent if ' +
    'send_statement_by_email itself reports success; if it reports no registered email is on file, say so ' +
    'plainly rather than inventing one; if it reports any other failure, apologize and say you were not able to ' +
    'send it right now — never claim it was sent when it was not. This system still has no SMS delivery — never ' +
    'say you have texted a statement or any document.';

  const existingAgent = await prisma.aiAgent.findFirst({
    where: { name: 'General Support Agent' },
    include: { configs: { where: { isActive: true } } },
  });

  if (!existingAgent) {
    await prisma.aiAgent.create({
      data: {
        name: 'General Support Agent',
        description: 'Default agent: handles account/payment inquiries, tickets, and escalations.',
        configs: {
          create: {
            version: 1,
            systemInstructions: defaultSystemInstructions,
            supportedLanguages: ['ar', 'en'],
            allowedTools: DEFAULT_AGENT_TOOLS,
            knowledgeBaseAccess: true,
            isActive: true,
          },
        },
      },
    });
  } else if (existingAgent.configs[0]) {
    // Re-running seed keeps the default agent's tool list in sync as the tool set evolves.
    await prisma.agentConfig.update({
      where: { id: existingAgent.configs[0].id },
      data: { systemInstructions: defaultSystemInstructions, allowedTools: DEFAULT_AGENT_TOOLS },
    });
  }

  // eslint-disable-next-line no-console
  console.log('Seed complete.');
  // eslint-disable-next-line no-console
  console.log(`Admin login -> email: ${adminEmail}  password: ${adminPassword}`);
  // eslint-disable-next-line no-console
  console.log('\nDemo customer logins (support page, email OR phone) — OTP: use OTP_DEV_BYPASS_CODE (000000) or the devOtp shown on screen:');
  for (const demo of DEMO_CUSTOMERS) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${demo.fullName.padEnd(20)} email: ${demo.email.padEnd(22)} phone: ${demo.phone}  ` +
        `balance: ${demo.metadata.balance.balance} ${demo.metadata.balance.currency}`,
    );
  }
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
