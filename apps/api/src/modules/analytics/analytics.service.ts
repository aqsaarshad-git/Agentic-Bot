import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface AnalyticsRange {
  from?: Date;
  to?: Date;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private range(range: AnalyticsRange) {
    if (!range.from && !range.to) return undefined;
    return { gte: range.from, lte: range.to };
  }

  private async avgLatencyMs(action: string, createdAt?: { gte?: Date; lte?: Date }): Promise<number | null> {
    const rows = await this.prisma.auditLog.findMany({
      where: { action, createdAt },
      select: { result: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const durations = rows
      .map((r) => (r.result as any)?.durationMs)
      .filter((d): d is number => typeof d === 'number');
    if (durations.length === 0) return null;
    return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  }

  async getSummary(range: AnalyticsRange) {
    const createdAt = this.range(range);

    const [
      totalConversations,
      conversationsByState,
      totalCalls,
      callDurations,
      callsByOutcome,
      totalTickets,
      ticketsByStatus,
      ticketsByPriority,
      toolExecTotal,
      toolExecFailures,
      toolExecByTool,
      tools,
      llmErrors,
      escalatedConversationIds,
      callbacksByStatus,
      campaignsByStatus,
      campaignContactsByStatus,
    ] = await Promise.all([
      this.prisma.conversation.count({ where: { createdAt } }),
      this.prisma.conversation.groupBy({ by: ['state'], where: { createdAt }, _count: true }),
      this.prisma.call.count({ where: { createdAt } }),
      this.prisma.call.findMany({ where: { createdAt, durationSeconds: { not: null } }, select: { durationSeconds: true } }),
      this.prisma.call.groupBy({ by: ['outcome'], where: { createdAt }, _count: true }),
      this.prisma.ticket.count({ where: { createdAt } }),
      this.prisma.ticket.groupBy({ by: ['status'], where: { createdAt }, _count: true }),
      this.prisma.ticket.groupBy({ by: ['priority'], where: { createdAt }, _count: true }),
      this.prisma.toolExecution.count({ where: { executedAt: createdAt } }),
      this.prisma.toolExecution.count({ where: { executedAt: createdAt, status: 'FAILURE' } }),
      this.prisma.toolExecution.groupBy({ by: ['toolId', 'status'], where: { executedAt: createdAt }, _count: true }),
      this.prisma.tool.findMany({ select: { id: true, name: true } }),
      this.prisma.auditLog.count({ where: { action: 'llm.error', createdAt } }),
      this.prisma.auditLog.findMany({
        where: { action: 'conversation.state.ESCALATING', createdAt },
        select: { entityId: true },
        distinct: ['entityId'],
      }),
      this.prisma.callback.groupBy({ by: ['status'], where: { createdAt }, _count: true }),
      this.prisma.campaign.groupBy({ by: ['status'], where: { createdAt }, _count: true }),
      this.prisma.campaignContact.groupBy({ by: ['status'], where: { createdAt }, _count: true }),
    ]);

    const avgCallDurationSeconds =
      callDurations.length > 0
        ? Math.round(callDurations.reduce((sum, c) => sum + (c.durationSeconds ?? 0), 0) / callDurations.length)
        : null;

    const toolNameById = new Map(tools.map((t) => [t.id, t.name]));
    const toolBreakdown = new Map<string, { name: string; success: number; failure: number }>();
    for (const row of toolExecByTool) {
      const name = toolNameById.get(row.toolId) ?? row.toolId;
      const entry = toolBreakdown.get(row.toolId) ?? { name, success: 0, failure: 0 };
      if (row.status === 'SUCCESS') entry.success += row._count;
      else entry.failure += row._count;
      toolBreakdown.set(row.toolId, entry);
    }

    const [avgLlmLatencyMs, avgSttLatencyMs, avgTtsLatencyMs, avgTotalResponseMs] = await Promise.all([
      this.avgLatencyMs('latency.llm', createdAt),
      this.avgLatencyMs('latency.stt', createdAt),
      this.avgLatencyMs('latency.tts', createdAt),
      this.avgLatencyMs('latency.total_response', createdAt),
    ]);

    return {
      conversations: {
        total: totalConversations,
        byState: Object.fromEntries(conversationsByState.map((r) => [r.state, r._count])),
        escalationRate: totalConversations > 0 ? escalatedConversationIds.length / totalConversations : 0,
      },
      calls: {
        total: totalCalls,
        avgDurationSeconds: avgCallDurationSeconds,
        byOutcome: Object.fromEntries(callsByOutcome.map((r) => [r.outcome ?? 'IN_PROGRESS', r._count])),
      },
      tickets: {
        total: totalTickets,
        byStatus: Object.fromEntries(ticketsByStatus.map((r) => [r.status, r._count])),
        byPriority: Object.fromEntries(ticketsByPriority.map((r) => [r.priority, r._count])),
      },
      tools: {
        totalExecutions: toolExecTotal,
        failures: toolExecFailures,
        failureRate: toolExecTotal > 0 ? toolExecFailures / toolExecTotal : 0,
        byTool: Array.from(toolBreakdown.values()),
      },
      llm: {
        errorCount: llmErrors,
        avgLatencyMs: avgLlmLatencyMs,
      },
      voice: {
        avgSttLatencyMs,
        avgTtsLatencyMs,
      },
      avgTotalResponseMs,
      callbacks: { byStatus: Object.fromEntries(callbacksByStatus.map((r) => [r.status, r._count])) },
      campaigns: {
        byStatus: Object.fromEntries(campaignsByStatus.map((r) => [r.status, r._count])),
        contactsByStatus: Object.fromEntries(campaignContactsByStatus.map((r) => [r.status, r._count])),
      },
    };
  }
}
