/**
 * N=20 live reliability benchmark for the exact 13 "first-ask" phrases from the reliability
 * hardening request — real Qwen + real MySQL, no mocks. Run with:
 *   npx ts-node --project apps/api/tsconfig.json scripts/first-ask-reliability-bench.ts [reps]
 *
 * For each rep: fresh conversation, sends the phrase, records which tool(s) actually ran (cross-
 * checked against tool_executions), the final reply, whether Qwen was bypassed (deterministic
 * forcing fired), and latency. Then classifies each trial as correct-routing / tool-skip /
 * fabricated-action / wrong-tool, and reports aggregate rates + p50/p95/max latency.
 */
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

interface Trial {
  phrase: string;
  requiredTools: string[]; // any of these counts as "correctly routed" (some phrases accept an intermediate tool too)
  toolsCalled: string[];
  reply: string;
  bypassedQwen: boolean;
  totalMs: number;
  toolSkipped: boolean;
  classification: 'correct' | 'fabricated' | 'wrong-tool';
}

async function main() {
  const reps = Number(process.argv[2] ?? 20);
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
  const khalid = await prisma.customer.findFirstOrThrow({ where: { email: 'khalid@example.com' } });

  let ahmed = await prisma.beneficiary.findFirst({ where: { customerId: sara.id, beneficiaryName: 'Ahmed' } });
  if (!ahmed) ahmed = await beneficiaries.add({ customerId: sara.id, beneficiaryName: 'Ahmed', accountNumber: 'ACC-99900099' });

  async function runTurn(customerId: string, content: string, conversationIdOverride?: string) {
    const conv = conversationIdOverride ? { id: conversationIdOverride } : await conversations.create({ customerId, channel: 'TEXT' });
    const before = await prisma.toolExecution.count();
    const startedAt = Date.now();
    const result = await orchestrator.handleIncomingMessage({ conversationId: conv.id, customerId, content });
    const totalMs = Date.now() - startedAt;
    const after = await prisma.toolExecution.count();
    const execs = await prisma.toolExecution.findMany({
      where: { conversationId: conv.id },
      orderBy: { executedAt: 'desc' },
      take: after - before,
      include: { tool: true },
    });
    const bypassLog = await prisma.auditLog.findFirst({
      where: { entityId: conv.id, action: { in: ['tool_routing.forced_state_response', 'tool_routing.deterministic_response'] } },
      orderBy: { createdAt: 'desc' },
    });
    return { conversationId: conv.id, toolsCalled: execs.map((e) => e.tool.name).reverse(), reply: result.reply, totalMs, bypassedQwen: Boolean(bypassLog) };
  }

  function classify(requiredTools: string[], toolsCalled: string[], reply: string): Trial['classification'] {
    const gotRequired = toolsCalled.some((t) => requiredTools.includes(t));
    if (gotRequired) return 'correct';
    if (toolsCalled.length > 0) return 'wrong-tool';
    const readsLikeQuestion = /[?؟]/.test(reply);
    return readsLikeQuestion ? 'correct' /* a genuine clarifying question is a valid, safe outcome */ : 'fabricated';
  }

  function isFabricationClaim(reply: string): boolean {
    return /(successfully|has been (reset|blocked|completed|sent|cancelled)|was (reset|blocked|completed)|تم\s)/i.test(reply);
  }

  const trials: Trial[] = [];

  async function runScenario(phrase: string, requiredTools: string[], setup: () => Promise<{ customerId: string; conversationId?: string }>) {
    for (let i = 0; i < reps; i++) {
      const { customerId, conversationId } = await setup();
      const outcome = await runTurn(customerId, phrase, conversationId);
      const classification = classify(requiredTools, outcome.toolsCalled, outcome.reply);
      const toolSkipped = outcome.toolsCalled.length === 0;
      trials.push({
        phrase,
        requiredTools,
        toolsCalled: outcome.toolsCalled,
        reply: outcome.reply,
        bypassedQwen: outcome.bypassedQwen,
        totalMs: outcome.totalMs,
        toolSkipped,
        classification,
      });
      console.log(
        `[${phrase}] #${i}: tools=[${outcome.toolsCalled.join(',')}] bypassed=${outcome.bypassedQwen} ${outcome.totalMs}ms -> ${classification}${
          classification === 'fabricated' && isFabricationClaim(outcome.reply) ? ' [CONFIRMED FALSE CLAIM]' : ''
        }`,
      );
    }
  }

  await runScenario('What is my balance?', ['get_balance'], async () => ({ customerId: sara.id }));
  await runScenario('What is my account status?', ['get_account', 'get_account_status'], async () => ({ customerId: sara.id }));
  await runScenario('Show my latest transaction.', ['get_transactions'], async () => ({ customerId: sara.id }));
  await runScenario('Why did my payment fail?', ['get_transactions', 'get_transaction_failure_reason'], async () => ({ customerId: mohammed.id }));
  await runScenario('What is my card status?', ['get_cards', 'get_card'], async () => ({ customerId: sara.id }));
  await runScenario('I forgot my PIN.', ['initiate_pin_reset'], async () => ({ customerId: sara.id }));
  await runScenario('Reset my PIN.', ['initiate_pin_reset'], async () => ({ customerId: sara.id }));
  await runScenario('I forgot my password.', ['initiate_password_reset'], async () => ({ customerId: sara.id }));
  await runScenario('Reset my password.', ['initiate_password_reset'], async () => ({ customerId: sara.id }));
  await runScenario('I want to transfer 500 to Ahmed.', ['create_transfer', 'get_beneficiaries'], async () => ({ customerId: sara.id }));

  await runScenario('Cancel my transfer.', ['cancel_transfer'], async () => {
    const conv = await conversations.create({ customerId: sara.id, channel: 'TEXT' });
    const { session } = await verification.createSession({ customerId: sara.id, conversationId: conv.id, purpose: 'IDENTITY' });
    await prisma.verificationSession.update({ where: { id: session.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
    await transfers.proposeTransfer({ customerId: sara.id, conversationId: conv.id, fromAccountId: saraAccount.id, beneficiaryId: ahmed!.id, amount: 1 });
    return { customerId: sara.id, conversationId: conv.id };
  });

  await runScenario('I lost my card.', ['report_lost_card'], async () => ({ customerId: mohammed.id }));
  await runScenario('I want to report fraud.', ['create_support_case', 'get_transactions'], async () => ({ customerId: khalid.id }));

  // --- Aggregate ---
  console.log('\n=== Aggregate (N=%d per phrase) ===', reps);
  const byPhrase = new Map<string, Trial[]>();
  for (const t of trials) byPhrase.set(t.phrase, [...(byPhrase.get(t.phrase) ?? []), t]);
  let totalCorrect = 0;
  let totalSkip = 0;
  let totalFabricated = 0;
  let totalWrongTool = 0;
  for (const [phrase, list] of byPhrase) {
    const n = list.length;
    const correct = list.filter((t) => t.classification === 'correct').length;
    const fabricated = list.filter((t) => t.classification === 'fabricated').length;
    const wrongTool = list.filter((t) => t.classification === 'wrong-tool').length;
    const skipped = list.filter((t) => t.toolSkipped).length;
    const bypassRate = list.filter((t) => t.bypassedQwen).length / n;
    const times = list.map((t) => t.totalMs).sort((a, b) => a - b);
    const p50 = times[Math.floor(n * 0.5)];
    const p95 = times[Math.min(n - 1, Math.floor(n * 0.95))];
    totalCorrect += correct;
    totalFabricated += fabricated;
    totalWrongTool += wrongTool;
    totalSkip += skipped;
    console.log(
      `${phrase}: correct=${((correct / n) * 100).toFixed(0)}% toolSkip=${((skipped / n) * 100).toFixed(0)}% ` +
        `fabricated=${((fabricated / n) * 100).toFixed(0)}% wrongTool=${((wrongTool / n) * 100).toFixed(0)}% ` +
        `bypassedQwen=${(bypassRate * 100).toFixed(0)}% p50=${p50}ms p95=${p95}ms max=${times[n - 1]}ms`,
    );
  }
  const totalN = trials.length;
  console.log(
    `\nOVERALL (n=${totalN}): correctRouting=${((totalCorrect / totalN) * 100).toFixed(1)}% toolSkip=${((totalSkip / totalN) * 100).toFixed(1)}% ` +
      `fabricatedAction=${((totalFabricated / totalN) * 100).toFixed(1)}% wrongTool=${((totalWrongTool / totalN) * 100).toFixed(1)}%`,
  );

  await app.close();
}

main().catch((error) => {
  console.error('BENCH ERROR:', error);
  process.exitCode = 1;
});
