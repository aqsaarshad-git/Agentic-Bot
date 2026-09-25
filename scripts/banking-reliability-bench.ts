/**
 * Live Qwen tool-calling reliability benchmark for the banking domain — drives
 * OrchestratorService.handleIncomingMessage() directly (real DB, real Qwen, no HTTP) for a fixed
 * scenario set, N repetitions each, and reports tool-call correctness + latency percentiles.
 *
 * Run with: npx ts-node --project apps/api/tsconfig.json scripts/banking-reliability-bench.ts [reps] [--ab-only]
 *   --ab-only restricts the run to the two Phase-2 A/B targets (transfer_confirm, verify_code) —
 *   used for the before/after comparison; omit it for the full scenario suite.
 *
 * NOT part of `npm test` — hits the real Qwen instance and mutates real dev-DB rows (new
 * conversations, a handful of small transfers). Safe to re-run; every scenario sets up its own
 * fresh conversation/state.
 */
// Must run before any Nest import: NestJS ConfigModule.forRoot() has no explicit envFilePath in
// app.module.ts, so it loads `.env` relative to process.cwd() — running this script from the
// repo root would silently load the (empty, for LLM_PROVIDER/QWEN_*) root .env instead of
// apps/api/.env, falling back to the mock LLM provider without any error. dotenv's default
// `override: false` means pre-populating process.env here first is safe — ConfigModule's own
// later `.env` load just finds nothing new to override.
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../apps/api/.env') });

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../apps/api/src/app.module';
import { OrchestratorService } from '../apps/api/src/modules/orchestrator/orchestrator.service';
import { PrismaService } from '../apps/api/src/database/prisma.service';
import { ConversationsService } from '../apps/api/src/modules/conversations/conversations.service';
import { AccountsService } from '../apps/api/src/modules/accounts/accounts.service';
import { TransfersService } from '../apps/api/src/modules/transfers/transfers.service';
import { BeneficiariesService } from '../apps/api/src/modules/beneficiaries/beneficiaries.service';
import { VerificationService } from '../apps/api/src/modules/verification/verification.service';

interface TurnOutcome {
  toolsCalled: string[];
  reply: string;
  totalMs: number;
  promptEvalCount?: number;
}

interface ScenarioOutcome {
  scenario: string;
  rep: number;
  expectedTool: string | null;
  called: boolean;
  wrongTool: boolean;
  totalMs: number;
  extra?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const abOnly = args.includes('--ab-only');
  const reps = Number(args.find((a) => /^\d+$/.test(a)) ?? 8);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const orchestrator = app.get(OrchestratorService);
  const prisma = app.get(PrismaService);
  const conversations = app.get(ConversationsService);
  const accounts = app.get(AccountsService);
  const transfers = app.get(TransfersService);
  const beneficiaries = app.get(BeneficiariesService);
  const verification = app.get(VerificationService);

  const sara = await prisma.customer.findFirstOrThrow({ where: { email: 'sara@example.com' } });
  const saraAccount = await accounts.getPrimaryAccount(sara.id);
  const mohammed = await prisma.customer.findFirstOrThrow({ where: { email: 'mohammed@example.com' } });

  let benchBeneficiary = await prisma.beneficiary.findFirst({ where: { customerId: sara.id, beneficiaryName: 'Bench Beneficiary' } });
  if (!benchBeneficiary) {
    benchBeneficiary = await beneficiaries.add({ customerId: sara.id, beneficiaryName: 'Bench Beneficiary', accountNumber: 'ACC-99900002' });
  }

  async function freshConversation(customerId: string) {
    return conversations.create({ customerId, channel: 'TEXT' });
  }

  async function runTurn(conversationId: string, customerId: string, content: string): Promise<TurnOutcome> {
    const beforeCount = await prisma.toolExecution.count();
    const startedAt = Date.now();
    const result = await orchestrator.handleIncomingMessage({ conversationId, customerId, content });
    const totalMs = Date.now() - startedAt;
    const afterCount = await prisma.toolExecution.count();
    const newExecs = await prisma.toolExecution.findMany({
      where: { conversationId },
      orderBy: { executedAt: 'desc' },
      take: afterCount - beforeCount,
      include: { tool: true },
    });
    const toolsCalled = newExecs.map((e) => e.tool.name).reverse();
    const llmLog = await prisma.auditLog.findFirst({
      where: { entityId: conversationId, action: 'latency.llm' },
      orderBy: { createdAt: 'desc' },
    });
    const promptEvalCount = (llmLog?.result as Record<string, unknown> | null)?.promptEvalCount as number | undefined;
    return { toolsCalled, reply: result.reply, totalMs, promptEvalCount };
  }

  const outcomes: ScenarioOutcome[] = [];

  async function scenario(
    name: string,
    expectedTool: string | null,
    setupAndAsk: (rep: number) => Promise<TurnOutcome>,
  ) {
    for (let rep = 0; rep < reps; rep++) {
      const outcome = await setupAndAsk(rep);
      const called = expectedTool ? outcome.toolsCalled.includes(expectedTool) : true;
      const wrongTool = expectedTool ? !called && outcome.toolsCalled.length > 0 : false;
      outcomes.push({ scenario: name, rep, expectedTool, called, wrongTool, totalMs: outcome.totalMs, extra: outcome.reply.slice(0, 80) });
      process.stdout.write(
        `${name} #${rep}: tools=[${outcome.toolsCalled.join(',')}] expected=${expectedTool ?? '-'} ` +
          `${called ? 'OK' : 'MISS'} ${outcome.totalMs}ms promptEval=${outcome.promptEvalCount ?? '-'}\n`,
      );
    }
  }

  // --- Phase 2 A/B targets ---
  await scenario('transfer_confirm', 'confirm_transfer', async () => {
    const conv = await freshConversation(sara.id);
    await verification.createSession({ customerId: sara.id, conversationId: conv.id, purpose: 'IDENTITY' }).then(({ session }) =>
      prisma.verificationSession.update({ where: { id: session.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } }),
    );
    await transfers.proposeTransfer({
      customerId: sara.id,
      conversationId: conv.id,
      fromAccountId: saraAccount.id,
      beneficiaryId: benchBeneficiary!.id,
      amount: 1,
    });
    return runTurn(conv.id, sara.id, 'Yes, confirm it');
  });

  await scenario('verify_code', 'verify_otp', async () => {
    const conv = await freshConversation(sara.id);
    await verification.createSession({ customerId: sara.id, conversationId: conv.id, purpose: 'IDENTITY' });
    return runTurn(conv.id, sara.id, 'The code is 000000');
  });

  if (!abOnly) {
    await scenario('transfer_cancel', 'cancel_transfer', async () => {
      const conv = await freshConversation(sara.id);
      await verification.createSession({ customerId: sara.id, conversationId: conv.id, purpose: 'IDENTITY' }).then(({ session }) =>
        prisma.verificationSession.update({ where: { id: session.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } }),
      );
      await transfers.proposeTransfer({
        customerId: sara.id,
        conversationId: conv.id,
        fromAccountId: saraAccount.id,
        beneficiaryId: benchBeneficiary!.id,
        amount: 1,
      });
      return runTurn(conv.id, sara.id, "No, don't do that");
    });

    await scenario('greeting', null, async () => {
      const conv = await freshConversation(sara.id);
      return runTurn(conv.id, sara.id, 'Hello!');
    });

    await scenario('balance', 'get_balance', async () => {
      const conv = await freshConversation(sara.id);
      return runTurn(conv.id, sara.id, "What's my balance?");
    });

    await scenario('balance_repeat_2nd_call', 'get_balance', async () => {
      const conv = await freshConversation(sara.id);
      await runTurn(conv.id, sara.id, "What's my balance?");
      await runTurn(conv.id, sara.id, 'Tell me about the weather.');
      return runTurn(conv.id, sara.id, 'And what is my balance now?');
    });

    await scenario('account_status', 'get_account', async () => {
      const conv = await freshConversation(sara.id);
      return runTurn(conv.id, sara.id, 'Is my account active?');
    });

    await scenario('transaction_failure_reason', 'get_transactions', async () => {
      const conv = await freshConversation(mohammed.id);
      return runTurn(conv.id, mohammed.id, 'Why did my last payment fail?');
    });

    await scenario('card_status', null, async () => {
      const conv = await freshConversation(sara.id);
      const outcome = await runTurn(conv.id, sara.id, "What's the status of my card?");
      return outcome; // pure Qwen-discretion, expectedTool null -> just records what happened, no pass/fail
    });

    await scenario('arabic_balance', 'get_balance', async () => {
      const conv = await freshConversation(sara.id);
      return runTurn(conv.id, sara.id, 'كم رصيدي؟');
    });

    await scenario('balance_after_transfer', 'get_balance', async () => {
      const conv = await freshConversation(sara.id);
      const before = await prisma.account.findUniqueOrThrow({ where: { id: saraAccount.id } });
      const { session } = await verification.createSession({ customerId: sara.id, conversationId: conv.id, purpose: 'IDENTITY' });
      await prisma.verificationSession.update({ where: { id: session.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
      const { transfer } = await transfers.proposeTransfer({
        customerId: sara.id,
        conversationId: conv.id,
        fromAccountId: saraAccount.id,
        beneficiaryId: benchBeneficiary!.id,
        amount: 1,
      });
      await transfers.confirmAndExecute(sara.id, conv.id);
      const outcome = await runTurn(conv.id, sara.id, "What's my balance now?");
      const expectedBalance = (Number(before.balance) - 1).toFixed(2);
      const mentionsFreshValue = outcome.reply.includes(expectedBalance) || outcome.reply.includes(String(Number(expectedBalance)));
      outcome.reply = `[expected ${expectedBalance}, fresh=${mentionsFreshValue}] ${outcome.reply}`;
      void transfer;
      return outcome;
    });
  }

  // --- Aggregate ---
  console.log('\n=== Aggregate ===');
  const byScenario = new Map<string, ScenarioOutcome[]>();
  for (const o of outcomes) {
    byScenario.set(o.scenario, [...(byScenario.get(o.scenario) ?? []), o]);
  }
  for (const [name, list] of byScenario) {
    const withExpectation = list.filter((o) => o.expectedTool !== null);
    const n = withExpectation.length;
    const successRate = n ? withExpectation.filter((o) => o.called).length / n : NaN;
    const wrongRate = n ? withExpectation.filter((o) => o.wrongTool).length / n : NaN;
    const times = list.map((o) => o.totalMs).sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)];
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
    const max = times[times.length - 1];
    console.log(
      `${name}: n=${list.length} successRate=${n ? (successRate * 100).toFixed(0) + '%' : 'n/a'} ` +
        `wrongToolRate=${n ? (wrongRate * 100).toFixed(0) + '%' : 'n/a'} p50=${p50}ms p95=${p95}ms max=${max}ms`,
    );
  }

  await app.close();
}

main().catch((error) => {
  console.error('BENCH ERROR:', error);
  process.exitCode = 1;
});
