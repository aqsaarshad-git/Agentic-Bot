import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ToolRegistryService } from './tool-registry.service';
import { ToolDefinition } from './tool-definition.interface';
import { InsufficientVerificationException, VerificationLevel } from './verification-level';

function baseCtx(verificationLevel: VerificationLevel) {
  return { customerId: 'cust-1', conversationId: 'conv-1', allowedTools: ['read_thing', 'sensitive_thing'], verificationLevel };
}

describe('ToolRegistryService', () => {
  let prisma: any;
  let auditService: { log: jest.Mock };
  let registry: ToolRegistryService;
  let sensitiveHandler: jest.Mock;
  let readHandler: jest.Mock;

  const definitions: ToolDefinition[] = [];

  beforeEach(async () => {
    readHandler = jest.fn().mockResolvedValue({ ok: true });
    sensitiveHandler = jest.fn().mockResolvedValue({ ok: true });

    definitions.length = 0;
    definitions.push(
      {
        name: 'read_thing',
        description: 'reads something',
        inputSchema: z.object({}),
        parametersJsonSchema: { type: 'object', properties: {}, required: [] },
        idempotent: true,
        handler: readHandler,
      },
      {
        name: 'sensitive_thing',
        description: 'does something sensitive',
        inputSchema: z.object({ code: z.string() }),
        parametersJsonSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
        minVerificationLevel: VerificationLevel.VERIFIED,
        sensitiveArgs: ['code'],
        handler: sensitiveHandler,
      },
    );

    prisma = {
      tool: {
        upsert: jest.fn(({ where }: any) => Promise.resolve({ id: `db-${where.name}`, isEnabled: true })),
      },
      toolExecution: { create: jest.fn().mockResolvedValue(undefined) },
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    registry = new ToolRegistryService(definitions, prisma, auditService as any);
    await registry.onModuleInit();
  });

  it('executes a tool at the default AUTHENTICATED tier', async () => {
    const result = await registry.validateAndExecute('read_thing', {}, baseCtx(VerificationLevel.AUTHENTICATED));
    expect(result).toEqual({ ok: true });
    expect(readHandler).toHaveBeenCalled();
  });

  it('blocks a VERIFIED-tier tool for an AUTHENTICATED-only session, never calling the handler', async () => {
    await expect(
      registry.validateAndExecute('sensitive_thing', { code: '123456' }, baseCtx(VerificationLevel.AUTHENTICATED)),
    ).rejects.toThrow(InsufficientVerificationException);
    expect(sensitiveHandler).not.toHaveBeenCalled();
  });

  it('allows a VERIFIED-tier tool once the session is VERIFIED', async () => {
    const result = await registry.validateAndExecute('sensitive_thing', { code: '123456' }, baseCtx(VerificationLevel.VERIFIED));
    expect(result).toEqual({ ok: true });
    expect(sensitiveHandler).toHaveBeenCalled();
  });

  it('redacts sensitiveArgs before persisting requestArgs, on both success and failure', async () => {
    await registry.validateAndExecute('sensitive_thing', { code: '123456' }, baseCtx(VerificationLevel.VERIFIED));
    const successCall = prisma.toolExecution.create.mock.calls.find((c: any) => c[0].data.status === 'SUCCESS');
    expect(successCall[0].data.requestArgs).toEqual({ code: '[REDACTED]' });

    await expect(
      registry.validateAndExecute('sensitive_thing', { code: '654321' }, baseCtx(VerificationLevel.AUTHENTICATED)),
    ).rejects.toThrow();
    const failureCall = prisma.toolExecution.create.mock.calls.find(
      (c: any) => c[0].data.status === 'FAILURE' && c[0].data.errorMessage === 'Insufficient verification level',
    );
    expect(failureCall[0].data.requestArgs).toEqual({ code: '[REDACTED]' });
  });

  it('rejects a tool not in the agent allowlist', async () => {
    const ctx = { ...baseCtx(VerificationLevel.VERIFIED), allowedTools: [] };
    await expect(registry.validateAndExecute('read_thing', {}, ctx)).rejects.toThrow(BadRequestException);
    expect(readHandler).not.toHaveBeenCalled();
  });

  it('rejects an unknown tool name', async () => {
    await expect(registry.validateAndExecute('does_not_exist', {}, baseCtx(VerificationLevel.VERIFIED))).rejects.toThrow(
      BadRequestException,
    );
  });
});
