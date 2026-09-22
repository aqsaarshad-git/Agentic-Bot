import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface AuditLogEntry {
  requestId?: string;
  actorType: AuditActorType;
  actorId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  toolName?: string;
  result?: unknown;
  success: boolean;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditLogEntry): Promise<void> {
    // Every latency.* entry (STT, TTS, LLM, classification, total-response — see
    // CallsService/OrchestratorService) is printed to the console, not just written to the
    // audit_logs table, specifically so a human tester can copy the raw timing numbers
    // straight out of the running server's terminal after a real microphone test call,
    // without needing to query the DB.
    if (entry.action.startsWith('latency.') && entry.result && typeof entry.result === 'object') {
      const { durationMs, ...extra } = entry.result as Record<string, unknown>;
      if (typeof durationMs === 'number') {
        const where = [entry.entityType, entry.entityId].filter(Boolean).join(':');
        const extraStr = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
        this.logger.log(`[LATENCY] ${entry.action} = ${durationMs}ms${where ? ` (${where})` : ''}${extraStr}`);
      }
    }
    try {
      await this.prisma.auditLog.create({
        data: {
          requestId: entry.requestId,
          actorType: entry.actorType,
          actorId: entry.actorId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          toolName: entry.toolName,
          result: entry.result as Prisma.InputJsonValue | undefined,
          success: entry.success,
        },
      });
    } catch (error) {
      // Audit logging must never break the primary request flow.
      this.logger.error('Failed to write audit log', error instanceof Error ? error.stack : String(error));
    }
  }

  async findMany(params: {
    entityType?: string;
    entityId?: string;
    actorType?: AuditActorType;
    take?: number;
    skip?: number;
  }) {
    const { entityType, entityId, actorType, take = 50, skip = 0 } = params;
    return this.prisma.auditLog.findMany({
      where: {
        entityType,
        entityId,
        actorType,
      },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });
  }
}
