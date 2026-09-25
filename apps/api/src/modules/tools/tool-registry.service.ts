import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LlmToolSchema } from '../../ai/llm/llm-provider.interface';
import { TOOL_DEFINITIONS } from './tool-definitions.provider';
import { ToolDefinition, ToolExecutionContext } from './tool-definition.interface';
import { InsufficientVerificationException, VerificationLevel, meetsLevel } from './verification-level';

function redactArgs(args: unknown, sensitiveKeys: string[] | undefined): unknown {
  if (!sensitiveKeys?.length || typeof args !== 'object' || args === null) {
    return args;
  }
  const redacted: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of sensitiveKeys) {
    if (key in redacted) {
      redacted[key] = '[REDACTED]';
    }
  }
  return redacted;
}

@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly byName = new Map<string, ToolDefinition>();
  private readonly dbIdByName = new Map<string, string>();
  private readonly enabledByName = new Map<string, boolean>();

  constructor(
    @Inject(TOOL_DEFINITIONS) private readonly definitions: ToolDefinition[],
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {
    for (const def of definitions) {
      this.byName.set(def.name, def);
    }
  }

  async onModuleInit() {
    for (const def of this.definitions) {
      const record = await this.prisma.tool.upsert({
        where: { name: def.name },
        create: {
          name: def.name,
          description: def.description,
          inputSchema: def.parametersJsonSchema as Prisma.InputJsonValue,
          isEnabled: true,
        },
        update: {
          description: def.description,
          inputSchema: def.parametersJsonSchema as Prisma.InputJsonValue,
        },
      });
      this.dbIdByName.set(def.name, record.id);
      this.enabledByName.set(def.name, record.isEnabled);
    }
    this.logger.log(`Registered ${this.definitions.length} tools`);
  }

  /** Called by ToolsService after it persists an enable/disable toggle, so the change applies immediately. */
  setEnabledCache(name: string, isEnabled: boolean): void {
    this.enabledByName.set(name, isEnabled);
  }

  /** Schemas exposed to the LLM, scoped to what the invoking agent config allows and currently enabled. */
  getSchemasFor(allowedTools: string[]): LlmToolSchema[] {
    return this.definitions
      .filter((d) => allowedTools.includes(d.name) && this.enabledByName.get(d.name) !== false)
      .map((d) => ({ name: d.name, description: d.description, parameters: d.parametersJsonSchema }));
  }

  async validateAndExecute(name: string, rawArgs: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const def = this.byName.get(name);
    const toolDbId = this.dbIdByName.get(name);
    const startedAt = Date.now();

    if (!def || !toolDbId) {
      throw new BadRequestException(`Unknown tool: ${name}`);
    }
    if (!ctx.allowedTools.includes(name)) {
      await this.recordExecution(toolDbId, name, ctx, rawArgs, undefined, false, 'Tool not allowed for this agent', 0);
      throw new BadRequestException(`Tool "${name}" is not authorized for this agent`);
    }
    if (this.enabledByName.get(name) === false) {
      await this.recordExecution(toolDbId, name, ctx, rawArgs, undefined, false, 'Tool is disabled', 0);
      throw new BadRequestException(`Tool "${name}" is currently disabled`);
    }

    const minLevel = def.minVerificationLevel ?? VerificationLevel.AUTHENTICATED;
    if (!meetsLevel(ctx.verificationLevel, minLevel)) {
      await this.recordExecution(
        toolDbId,
        name,
        ctx,
        redactArgs(rawArgs, def.sensitiveArgs),
        undefined,
        false,
        'Insufficient verification level',
        0,
      );
      throw new InsufficientVerificationException(minLevel, ctx.verificationLevel);
    }

    const parsed = def.inputSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      await this.recordExecution(
        toolDbId,
        name,
        ctx,
        redactArgs(rawArgs, def.sensitiveArgs),
        undefined,
        false,
        message,
        Date.now() - startedAt,
      );
      throw new BadRequestException(`Invalid arguments for tool "${name}": ${message}`);
    }

    try {
      const result = await this.executeWithRetry(def, ctx, parsed.data);
      await this.recordExecution(
        toolDbId,
        name,
        ctx,
        redactArgs(parsed.data, def.sensitiveArgs),
        result,
        true,
        undefined,
        Date.now() - startedAt,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordExecution(
        toolDbId,
        name,
        ctx,
        redactArgs(parsed.data, def.sensitiveArgs),
        undefined,
        false,
        message,
        Date.now() - startedAt,
      );
      throw error;
    }
  }

  /** Read-only tools get one automatic retry on transient failure; side-effecting tools never do. */
  private async executeWithRetry(def: ToolDefinition, ctx: ToolExecutionContext, args: unknown): Promise<unknown> {
    try {
      return await def.handler(ctx, args);
    } catch (error) {
      if (!def.idempotent) {
        throw error;
      }
      this.logger.warn(`Tool "${def.name}" failed, retrying once (idempotent): ${error instanceof Error ? error.message : error}`);
      await this.auditService.log({
        requestId: ctx.requestId,
        actorType: AuditActorType.SYSTEM,
        action: 'tool.retry',
        entityType: 'conversation',
        entityId: ctx.conversationId,
        toolName: def.name,
        success: true,
      });
      return def.handler(ctx, args);
    }
  }

  private async recordExecution(
    toolId: string,
    toolName: string,
    ctx: ToolExecutionContext,
    args: unknown,
    result: unknown,
    success: boolean,
    errorMessage: string | undefined,
    durationMs: number,
  ) {
    await this.prisma.toolExecution.create({
      data: {
        toolId,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        callId: ctx.callId,
        requestArgs: (args ?? {}) as Prisma.InputJsonValue,
        resultData: result !== undefined ? (result as Prisma.InputJsonValue) : undefined,
        status: success ? 'SUCCESS' : 'FAILURE',
        errorMessage,
        durationMs,
      },
    });

    await this.auditService.log({
      requestId: ctx.requestId,
      actorType: AuditActorType.AI_AGENT,
      actorId: ctx.actor?.sub,
      action: success ? 'tool.executed' : 'tool.failed',
      entityType: 'conversation',
      entityId: ctx.conversationId,
      toolName,
      result: success ? result : { error: errorMessage },
      success,
    });
  }
}
