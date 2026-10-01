import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

type DemoTransaction = {
  id: string;
  date: string;
  amount: number;
  currency: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'REVERSED';
  reason?: string;
  channel?:
    | 'CARD_PURCHASE'
    | 'POS'
    | 'ONLINE'
    | 'ATM_WITHDRAWAL'
    | 'ATM_DEPOSIT'
    | 'TRANSFER'
    | 'FEE'
    | 'REFUND'
    | 'DIRECT_DEBIT'
    | 'OTHER';
  merchantName?: string;
  // Links a REFUND-channel row back to the original charge it refunds — must reference a txn
  // id that appears EARLIER in the same customer's transaction list (backfilled in order).
  relatedTransactionRef?: string;
};

type BeneficiarySeed = {
  name: string;
  accountNumber: string;
  bankName?: string;
  status?: 'ACTIVE' | 'PENDING_VERIFICATION' | 'BLOCKED' | 'REMOVED';
};

type TransferSeed = {
  reference: string;
  toBeneficiaryIndex: number;
  amount: number;
  fee?: number;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  failureReason?: 'INSUFFICIENT_FUNDS' | 'LIMIT_EXCEEDED' | 'OTHER';
  daysAgo: number;
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
  // When set, seeds a second, independently ACTIVE card (not a replacement) — the "customer has
  // more than one usable card" archetype, distinct from replacementCardLast4's stolen/lost flow.
  secondCardLast4?: string;
  onlineBankingLocked?: boolean;
  failedLoginAttempts?: number;
  supportCase?: SupportCaseSeed;
  // Additional cases beyond the single `supportCase` above — for archetypes needing more than
  // one (e.g. a resolved case AND a still-open complaint on the same customer).
  supportCases?: SupportCaseSeed[];
  beneficiaries?: BeneficiarySeed[];
  // Historical, already-resolved transfers (COMPLETED/FAILED/CANCELLED only — never a live
  // PENDING_CONFIRMATION row, which would imply an executable action still open on some
  // long-gone conversation). Requires `beneficiaries` above; toBeneficiaryIndex refers to it.
  transfers?: TransferSeed[];
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
    // Real Gmail address (2026-09-28) — statement-email delivery testing on a second real inbox.
    email: 'aqsa10641064@gmail.com',
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
      // Reversed payment archetype: the charge itself was voided/reversed, not refunded separately.
      { id: 'TXN-7730', date: '2026-09-04', amount: 175.0, currency: 'SAR', status: 'REVERSED', channel: 'CARD_PURCHASE', merchantName: 'Gulf Office Supplies' },
      // Duplicate-payment archetype: same merchant/amount, one day apart — needs disambiguation,
      // never assume which one the customer means.
      { id: 'TXN-7741', date: '2026-09-05', amount: 320.0, currency: 'SAR', status: 'COMPLETED', channel: 'POS', merchantName: 'Riyadh Wholesale Mart' },
      { id: 'TXN-7742', date: '2026-09-06', amount: 320.0, currency: 'SAR', status: 'COMPLETED', channel: 'POS', merchantName: 'Riyadh Wholesale Mart' },
    ],
    cardLast4: '5563',
    // Beneficiary support archetype: one usable, one blocked (e.g. flagged as suspicious).
    beneficiaries: [
      { name: 'Al-Rajhi Supplies Est.', accountNumber: 'ACC-90011223', bankName: 'Barq Bank', status: 'ACTIVE' },
      { name: 'Unverified Vendor Co.', accountNumber: 'ACC-90022998', bankName: 'Barq Bank', status: 'BLOCKED' },
    ],
    // Transfer history archetype: one completed (with its beneficiary fee actually charged), one
    // failed on insufficient funds — covers "pending/failed transfer" and "transfer history".
    transfers: [
      { reference: 'TRF-SEED0001', toBeneficiaryIndex: 0, amount: 500, fee: 5, status: 'COMPLETED', daysAgo: 6 },
      { reference: 'TRF-SEED0002', toBeneficiaryIndex: 0, amount: 2000, status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS', daysAgo: 2 },
    ],
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
    // Multiple independently-active cards archetype: two usable cards, neither a replacement of
    // the other — "my card isn't working" must be disambiguated, never guessed.
    secondCardLast4: '8897',
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
  {
    // Archetype F: lost (not stolen) card, plus a resolved/closed case and a still-open
    // complaint — covers the "resolved/closed ticket" and "complaint" gaps together.
    fullName: 'Yousef Al-Qahtani',
    email: 'yousef@example.com',
    phone: '+966507890123',
    language: 'en',
    metadata: {
      account: { accountNumber: 'ACC-10116784', accountType: 'PERSONAL', status: 'ACTIVE', openedDate: '2024-08-03' },
      balance: { balance: 1840.0, currency: 'SAR' },
      transactions: [
        { id: 'TXN-1120', date: '2026-09-12', amount: 60.0, currency: 'SAR', status: 'COMPLETED' },
        { id: 'TXN-1108', date: '2026-08-30', amount: 300.0, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    cardLast4: '9901',
    cardOverride: {
      status: 'LOST',
      lostReportedAt: new Date('2026-09-20T14:00:00Z'),
      blockReason: 'Reported lost by customer',
    },
    replacementCardLast4: '9912',
    supportCase: {
      category: 'GENERAL_INQUIRY',
      subcategory: 'ACCOUNT_LIMITS',
      description: 'Customer asked about their daily transfer and ATM limits.',
      status: 'CLOSED',
      priority: 'LOW',
    },
    supportCases: [
      {
        category: 'COMPLAINT',
        subcategory: 'BRANCH_SERVICE',
        description: 'Customer complained about long wait times at a branch visit.',
        status: 'WAITING_FOR_CUSTOMER',
        priority: 'MEDIUM',
      },
    ],
  },
  {
    // Archetype G: ATM cash-not-dispensed dispute (still open) + a transaction-dispute case
    // that's genuinely pending a refund (resolved outcome not yet reached — nothing to
    // fabricate) — covers the ATM-dispute and pending-refund gaps.
    fullName: 'Layla Hassan',
    email: 'layla@example.com',
    phone: '+966508901234',
    language: 'en',
    metadata: {
      account: { accountNumber: 'ACC-10127895', accountType: 'PERSONAL', status: 'ACTIVE', openedDate: '2024-03-15' },
      balance: { balance: 2100.0, currency: 'SAR' },
      transactions: [
        { id: 'TXN-1310', date: '2026-09-14', amount: 90.0, currency: 'SAR', status: 'COMPLETED' },
      ],
    },
    extraTransactions: [
      // Account debited, but the ATM never dispensed the cash — the transaction itself is
      // COMPLETED (money genuinely left the account); only a dispute/case makes this right,
      // never a claim that it's "already been refunded".
      { id: 'TXN-1322', date: '2026-09-21', amount: 400.0, currency: 'SAR', status: 'COMPLETED', channel: 'ATM_WITHDRAWAL', merchantName: 'Barq Bank ATM - King Fahd Rd' },
      // A separate, earlier dispute that already concluded with a real, linked refund —
      // "was I refunded" must be answerable from this link, never from a resolution note alone.
      { id: 'TXN-1298', date: '2026-09-01', amount: 260.0, currency: 'SAR', status: 'COMPLETED', channel: 'ONLINE', merchantName: 'Najm Electronics' },
      { id: 'TXN-1299', date: '2026-09-03', amount: 260.0, currency: 'SAR', status: 'COMPLETED', channel: 'REFUND', merchantName: 'Najm Electronics', relatedTransactionRef: 'TXN-1298' },
      // ATM matrix (2026-09-29, real-world gap-closing pass) — B: partial cash (full amount
      // debited, only part physically dispensed — the shortfall is the dispute amount, never a
      // fabricated auto-refund of the full withdrawal).
      { id: 'TXN-1410', date: '2026-09-22', amount: 500.0, currency: 'SAR', status: 'COMPLETED', channel: 'ATM_WITHDRAWAL', merchantName: 'Barq Bank ATM - Olaya St' },
      // C: wrong amount dispensed (dispensed more/less than requested — again the discrepancy,
      // not the whole transaction, is what's disputed).
      { id: 'TXN-1420', date: '2026-09-23', amount: 200.0, currency: 'SAR', status: 'COMPLETED', channel: 'ATM_WITHDRAWAL', merchantName: 'Barq Bank ATM - Tahlia St' },
      // E: still pending — must be reported as PENDING, never narrated as if it already failed
      // or succeeded.
      { id: 'TXN-1430', date: '2026-09-24', amount: 100.0, currency: 'SAR', status: 'PENDING', channel: 'ATM_WITHDRAWAL', merchantName: 'Barq Bank ATM - King Fahd Rd' },
      // F: reversed — the withdrawal itself was voided, distinct from a separately-issued refund.
      { id: 'TXN-1440', date: '2026-09-25', amount: 150.0, currency: 'SAR', status: 'REVERSED', channel: 'ATM_WITHDRAWAL', merchantName: 'Other Bank ATM - Airport' },
      // G: customer doesn't recognize this withdrawal at all — a fraud dispute, not a
      // cash-not-dispensed one.
      { id: 'TXN-1450', date: '2026-09-26', amount: 600.0, currency: 'SAR', status: 'COMPLETED', channel: 'ATM_WITHDRAWAL', merchantName: 'Unknown ATM - Jeddah' },
      // H: a real, DB-grounded ATM fee (out-of-network) — "why was I charged this" must be
      // answerable from this linked row, never a config-only number with nothing behind it.
      { id: 'TXN-1460', date: '2026-09-26', amount: 300.0, currency: 'SAR', status: 'COMPLETED', channel: 'ATM_WITHDRAWAL', merchantName: 'Other Bank ATM - Jeddah' },
      { id: 'TXN-1461', date: '2026-09-26', amount: 10.0, currency: 'SAR', status: 'COMPLETED', channel: 'FEE', merchantName: 'Other Bank ATM - Jeddah', relatedTransactionRef: 'TXN-1460', reason: 'ATM withdrawal fee (other network)' },
      // I: withdrawal limit reached — a real FAILED transaction with a real failure reason, not
      // an inferred/guessed one.
      { id: 'TXN-1470', date: '2026-09-27', amount: 5000.0, currency: 'SAR', status: 'FAILED', channel: 'ATM_WITHDRAWAL', merchantName: 'Barq Bank ATM - Olaya St', reason: 'Limit exceeded' },
    ],
    cardLast4: '9933',
    supportCases: [
      {
        category: 'TRANSACTION_DISPUTE',
        subcategory: 'ATM_CASH_NOT_DISPENSED',
        description: 'Customer states the ATM debited their account but did not dispense any cash.',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        linkTransactionRef: 'TXN-1322',
        disputeAmount: 400.0,
      },
      {
        category: 'TRANSACTION_DISPUTE',
        subcategory: 'DUPLICATE_CHARGE',
        description: 'Customer was charged twice for the same online order; refund requested for the duplicate.',
        status: 'OPEN',
        priority: 'MEDIUM',
        linkTransactionRef: 'TXN-1298',
        disputeAmount: 260.0,
      },
      {
        category: 'TRANSACTION_DISPUTE',
        subcategory: 'ATM_PARTIAL_CASH',
        description: 'Customer requested 500 SAR but the ATM only dispensed 300 SAR; the full 500 was debited.',
        status: 'OPEN',
        priority: 'HIGH',
        linkTransactionRef: 'TXN-1410',
        disputeAmount: 200.0,
      },
      {
        category: 'TRANSACTION_DISPUTE',
        subcategory: 'ATM_WRONG_AMOUNT',
        description: 'Customer requested 200 SAR but the ATM dispensed only 150 SAR.',
        status: 'OPEN',
        priority: 'MEDIUM',
        linkTransactionRef: 'TXN-1420',
        disputeAmount: 50.0,
      },
      {
        category: 'FRAUD_DISPUTE',
        subcategory: 'UNRECOGNIZED_ATM_WITHDRAWAL',
        description: 'Customer does not recognize this ATM withdrawal at all and suspects unauthorized use.',
        status: 'ESCALATED',
        priority: 'URGENT',
        linkTransactionRef: 'TXN-1450',
        disputeAmount: 600.0,
      },
      // D: card retained by the ATM machine itself — deliberately NOT flipped to a card status
      // here (this system has no real branch/courier process to recover a machine-retained
      // card, and inventing a status transition with no real recovery workflow behind it would
      // be exactly the "represent it honestly as a support case" principle this section asks
      // for, not a fabricated capability).
      {
        category: 'CARD_ISSUE',
        subcategory: 'RETAINED_BY_ATM',
        description: 'The ATM retained the customer\'s card during a withdrawal attempt.',
        status: 'OPEN',
        priority: 'HIGH',
        linkCard: true,
      },
    ],
  },
];

const DEFAULT_AGENT_TOOLS = [
  // Generic support
  'get_customer',
  'update_contact_info',
  'create_ticket',
  'get_ticket',
  'update_ticket',
  'escalate_ticket',
  'transfer_to_human',
  'end_call',
  'schedule_callback',
  'get_callback_status',
  'cancel_callback',
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
  'get_transfer',
  'create_transfer',
  'confirm_transfer',
  'cancel_transfer',
  // Support cases
  'create_support_case',
  'get_support_case',
  'get_customer_cases',
  'add_case_information',
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
    case 'Limit exceeded':
      return 'LIMIT_EXCEEDED' as const;
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

/**
 * index 0 keeps the original `CASE-{accountNumber}` ticket number (backward compatible with
 * every already-seeded single-case customer); additional cases from `supportCases` get an
 * index suffix, so a customer can have more than one without a naming collision.
 */
async function upsertSupportCase(params: {
  customerId: string;
  accountNumber: string;
  index: number;
  accountId: string;
  primaryCardId: string;
  sc: SupportCaseSeed;
}) {
  const ticketNumber = params.index === 0 ? `CASE-${params.accountNumber}` : `CASE-${params.accountNumber}-${params.index}`;
  const linkedTransaction = params.sc.linkTransactionRef
    ? await prisma.transaction.findUnique({ where: { transactionRef: params.sc.linkTransactionRef } })
    : null;
  const ticketData = {
    customerId: params.customerId,
    category: params.sc.category,
    subcategory: params.sc.subcategory ?? null,
    description: params.sc.description,
    status: params.sc.status ?? 'OPEN',
    priority: params.sc.priority ?? 'MEDIUM',
    accountId: params.accountId,
    cardId: params.sc.linkCard ? params.primaryCardId : null,
    transactionId: linkedTransaction?.id ?? null,
    disputeAmount: params.sc.disputeAmount ?? null,
  };
  const existingTicket = await prisma.ticket.findUnique({ where: { ticketNumber } });
  if (existingTicket) {
    await prisma.ticket.update({ where: { id: existingTicket.id }, data: ticketData });
  } else {
    await prisma.ticket.create({ data: { ticketNumber, ...ticketData } });
  }
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

    // Order matters: a REFUND row's relatedTransactionRef must name a txn listed EARLIER in
    // this same array, since each is upserted in sequence and the lookup below only finds
    // whatever already exists.
    const allTransactions = [...demo.metadata.transactions, ...(demo.extraTransactions ?? [])];
    for (const txn of allTransactions) {
      const relatedTransaction = txn.relatedTransactionRef
        ? await prisma.transaction.findUnique({ where: { transactionRef: txn.relatedTransactionRef } })
        : null;
      const type = txn.channel === 'REFUND' || txn.channel === 'ATM_DEPOSIT' ? 'CREDIT' : 'DEBIT';
      // `reason` doubles as the seed's plain-English `description` for ANY status, but only
      // means a real `failureReason` when the transaction actually FAILED — a completed fee/
      // ATM transaction using `reason` just for a human-readable description must never pick up
      // a stray OTHER failure reason it never had (2026-09-29, caught live: a completed fee
      // transaction with a descriptive `reason` was narrated as "an unspecified issue").
      const failureReason = txn.status === 'FAILED' ? mapFailureReason(txn.reason) : null;
      await prisma.transaction.upsert({
        where: { transactionRef: txn.id },
        create: {
          transactionRef: txn.id,
          accountId: account.id,
          type,
          channel: txn.channel ?? 'OTHER',
          amount: txn.amount,
          currency: txn.currency,
          status: txn.status,
          failureReason,
          description: txn.reason ?? null,
          merchantName: txn.merchantName ?? null,
          relatedTransactionId: relatedTransaction?.id ?? null,
          postedAt: new Date(txn.date),
        },
        update: {
          amount: txn.amount,
          currency: txn.currency,
          status: txn.status,
          failureReason,
          description: txn.reason ?? null,
          merchantName: txn.merchantName ?? null,
          relatedTransactionId: relatedTransaction?.id ?? null,
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
    if (demo.secondCardLast4) {
      await upsertCard(account.id, maskedCardNumber(demo.secondCardLast4), { status: 'ACTIVE' });
    }

    const allCases = [demo.supportCase, ...(demo.supportCases ?? [])].filter(
      (sc): sc is SupportCaseSeed => Boolean(sc),
    );
    for (let i = 0; i < allCases.length; i++) {
      await upsertSupportCase({
        customerId,
        accountNumber: legacyAccount.accountNumber,
        index: i,
        accountId: account.id,
        primaryCardId: primaryCard.id,
        sc: allCases[i],
      });
    }

    const beneficiaryRecords = [];
    for (const b of demo.beneficiaries ?? []) {
      const record = await prisma.beneficiary.upsert({
        where: { customerId_accountNumber: { customerId, accountNumber: b.accountNumber } },
        create: {
          customerId,
          beneficiaryName: b.name,
          accountNumber: b.accountNumber,
          bankName: b.bankName ?? 'Barq Bank',
          status: b.status ?? 'ACTIVE',
        },
        update: { beneficiaryName: b.name, bankName: b.bankName ?? 'Barq Bank', status: b.status ?? 'ACTIVE' },
      });
      beneficiaryRecords.push(record);
    }

    if (demo.transfers?.length) {
      // Any conversation belonging to this customer will do — these are historical,
      // already-resolved transfers, not a live pending action tied to a real chat turn.
      let conversation = await prisma.conversation.findFirst({ where: { customerId }, orderBy: { createdAt: 'asc' } });
      if (!conversation) {
        conversation = await prisma.conversation.create({ data: { customerId, channel: 'TEXT', state: 'CALL_ENDED' } });
      }

      for (const t of demo.transfers) {
        const beneficiary = beneficiaryRecords[t.toBeneficiaryIndex];
        if (!beneficiary) continue;
        const occurredAt = new Date(Date.now() - t.daysAgo * 24 * 60 * 60 * 1000);

        let resultingTransactionId: string | null = null;
        if (t.status === 'COMPLETED') {
          const debitTxn = await prisma.transaction.upsert({
            where: { transactionRef: `${t.reference}-DR` },
            create: {
              transactionRef: `${t.reference}-DR`,
              accountId: account.id,
              type: 'DEBIT',
              channel: 'TRANSFER',
              amount: t.amount,
              currency: 'SAR',
              status: 'COMPLETED',
              description: `Transfer to ${beneficiary.beneficiaryName}`,
              postedAt: occurredAt,
              settledAt: occurredAt,
            },
            update: {},
          });
          resultingTransactionId = debitTxn.id;

          if (t.fee) {
            await prisma.transaction.upsert({
              where: { transactionRef: `${t.reference}-FEE` },
              create: {
                transactionRef: `${t.reference}-FEE`,
                accountId: account.id,
                type: 'DEBIT',
                channel: 'FEE',
                amount: t.fee,
                currency: 'SAR',
                status: 'COMPLETED',
                description: 'Beneficiary transfer fee',
                relatedTransactionId: debitTxn.id,
                postedAt: occurredAt,
                settledAt: occurredAt,
              },
              update: {},
            });
          }
        }

        await prisma.transfer.upsert({
          where: { transferReference: t.reference },
          create: {
            transferReference: t.reference,
            customerId,
            conversationId: conversation.id,
            fromAccountId: account.id,
            beneficiaryId: beneficiary.id,
            type: 'BENEFICIARY',
            amount: t.amount,
            fee: t.fee ?? 0,
            currency: 'SAR',
            status: t.status,
            failureReason: t.failureReason ?? null,
            resultingTransactionId,
            confirmationExpiresAt: occurredAt,
            confirmedAt: occurredAt,
            executedAt: t.status === 'COMPLETED' ? occurredAt : null,
            createdAt: occurredAt,
          },
          update: {
            status: t.status,
            failureReason: t.failureReason ?? null,
            resultingTransactionId,
          },
        });
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
    'say you have texted a statement or any document. ' +
    'Contact info changes (phone, email, mailing address): this needs the customer to be VERIFIED first, same ' +
    'as any other sensitive change. If update_contact_info fails because they are not yet verified, call ' +
    'start_verification and ask them to read back the code; once they give a code, that IS the verification ' +
    'code — treat it as such and let the system confirm it, do not ask again or assume it worked yourself. ' +
    'Only after verification is confirmed, call update_contact_info with EXACTLY the new value the customer ' +
    'just stated — copy it character-for-character, never paraphrase, reformat, or invent a different number ' +
    'or address. Only tell the customer it was updated if update_contact_info itself reports success this turn ' +
    '— never say a phone/email/address change is "in effect" or "reflected in our records" ahead of that.';

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
