import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

interface DemoCustomer {
  fullName: string;
  email: string;
  phone: string;
  language: string;
  metadata: {
    account: { accountNumber: string; accountType: string; status: string; openedDate: string };
    balance: { balance: number; currency: string };
    transactions: {
      id: string;
      date: string;
      amount: number;
      currency: string;
      status: 'COMPLETED' | 'PENDING' | 'FAILED';
      reason?: string;
    }[];
  };
}

// Each demo customer sees THEIR OWN data when the AI calls get_account/get_balance/
// get_transactions — the tools read this straight off Customer.metadata (see
// tool-definitions.provider.ts). Fixed emails/phones so the same login works every
// test run; combine with OTP_DEV_BYPASS_CODE to skip the OTP hassle entirely.
const DEMO_CUSTOMERS: DemoCustomer[] = [
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  // Real test customer for the PSTN calling feature — +923124439804 is a genuine phone number
  // (not a demo/placeholder), seeded so a real inbound/outbound call resolves to this actual
  // profile (see PstnCallService.findOrCreateCustomerByPhone's normalized-last-10-digits match)
  // instead of an auto-created "Caller <number>" placeholder with no account context.
  {
    fullName: 'Aqsa',
    email: 'aqsa@mytm.co',
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
  },
];

const DEFAULT_AGENT_TOOLS = [
  'get_customer',
  'create_ticket',
  'get_ticket',
  'update_ticket',
  'escalate_ticket',
  'transfer_to_human',
  'end_call',
  'schedule_callback',
  'get_account',
  'get_balance',
  'get_transactions',
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

  for (const demo of DEMO_CUSTOMERS) {
    const existing = await prisma.customer.findFirst({ where: { email: demo.email } });
    if (existing) {
      await prisma.customer.update({
        where: { id: existing.id },
        data: { metadata: demo.metadata as unknown as Prisma.InputJsonValue },
      });
    } else {
      await prisma.customer.create({
        data: {
          fullName: demo.fullName,
          email: demo.email,
          phone: demo.phone,
          language: demo.language,
          metadata: demo.metadata as unknown as Prisma.InputJsonValue,
        },
      });
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
    'being left open.';

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
