import { UnauthorizedException } from '@nestjs/common';
import { VerificationService } from './verification.service';

type MockPrisma = {
  verificationSession: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  customer: { findUnique: jest.Mock };
};

function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'session-1',
    customerId: 'cust-1',
    conversationId: 'conv-1',
    purpose: 'IDENTITY',
    targetRef: null,
    method: 'OTP_EMAIL',
    codeHash: 'hashed',
    status: 'VERIFICATION_IN_PROGRESS',
    attempts: 0,
    maxAttempts: 3,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    verifiedAt: null,
    consumedAt: null,
    lockedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed'),
  compare: jest.fn().mockResolvedValue(false),
}));

describe('VerificationService', () => {
  let prisma: MockPrisma;
  let auditService: { log: jest.Mock };
  let notifications: { send: jest.Mock };
  let config: { get: jest.Mock };
  let service: VerificationService;

  beforeEach(() => {
    prisma = {
      verificationSession: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
      customer: { findUnique: jest.fn().mockResolvedValue({ id: 'cust-1', email: 'a@b.com' }) },
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn().mockReturnValue('') };
    service = new VerificationService(prisma as any, config as any, notifications as any, auditService as any);
  });

  describe('computeLevel', () => {
    it('returns AUTHENTICATED with no session', async () => {
      prisma.verificationSession.findFirst.mockResolvedValue(null);
      expect(await service.computeLevel('cust-1', 'conv-1')).toBe(1); // AUTHENTICATED
    });

    it('returns VERIFIED for a fresh VERIFIED session', async () => {
      prisma.verificationSession.findFirst.mockResolvedValue(
        makeSession({ status: 'VERIFIED', verifiedAt: new Date() }),
      );
      expect(await service.computeLevel('cust-1', 'conv-1')).toBe(2); // VERIFIED
    });

    it('falls back to AUTHENTICATED once the VERIFIED window has expired', async () => {
      prisma.verificationSession.findFirst.mockResolvedValue(
        makeSession({ status: 'VERIFIED', verifiedAt: new Date(Date.now() - 20 * 60 * 1000) }),
      );
      expect(await service.computeLevel('cust-1', 'conv-1')).toBe(1);
    });

    it('returns PUBLIC with no customerId', async () => {
      expect(await service.computeLevel('', 'conv-1')).toBe(0);
    });
  });

  describe('verifyOtp / lockout', () => {
    it('rejects a wrong code and increments attempts without exhausting the session', async () => {
      prisma.verificationSession.findFirst.mockResolvedValue(makeSession({ attempts: 0 }));
      await expect(
        service.verifyOtp({ customerId: 'cust-1', conversationId: 'conv-1', purpose: 'IDENTITY', code: '000001' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.verificationSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { attempts: 1, status: 'VERIFICATION_IN_PROGRESS' },
      });
    });

    it('marks the session VERIFICATION_FAILED once maxAttempts is reached', async () => {
      prisma.verificationSession.findFirst.mockResolvedValue(makeSession({ attempts: 2, maxAttempts: 3 }));
      await expect(
        service.verifyOtp({ customerId: 'cust-1', conversationId: 'conv-1', purpose: 'IDENTITY', code: 'wrong0' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.verificationSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { attempts: 3, status: 'VERIFICATION_FAILED' },
      });
    });

    it('locks the customer out after 3 consecutive failed/locked sessions', async () => {
      prisma.verificationSession.findFirst.mockResolvedValue(makeSession({ id: 'session-3', attempts: 2, maxAttempts: 3 }));
      prisma.verificationSession.findMany.mockResolvedValue([
        makeSession({ id: 'session-3', status: 'VERIFICATION_FAILED' }),
        makeSession({ id: 'session-2', status: 'VERIFICATION_FAILED' }),
        makeSession({ id: 'session-1', status: 'VERIFICATION_FAILED' }),
      ]);
      await expect(
        service.verifyOtp({ customerId: 'cust-1', conversationId: 'conv-1', purpose: 'IDENTITY', code: 'wrong0' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.verificationSession.update).toHaveBeenCalledWith({
        where: { id: 'session-3' },
        data: { status: 'LOCKED', lockedAt: expect.any(Date) },
      });
    });

    it('does not lock out when a VERIFIED session breaks the failure streak', async () => {
      prisma.verificationSession.findFirst.mockResolvedValue(makeSession({ id: 'session-3', attempts: 2, maxAttempts: 3 }));
      prisma.verificationSession.findMany.mockResolvedValue([
        makeSession({ id: 'session-3', status: 'VERIFICATION_FAILED' }),
        makeSession({ id: 'session-2', status: 'VERIFIED' }),
        makeSession({ id: 'session-1', status: 'VERIFICATION_FAILED' }),
      ]);
      await expect(
        service.verifyOtp({ customerId: 'cust-1', conversationId: 'conv-1', purpose: 'IDENTITY', code: 'wrong0' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.verificationSession.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'LOCKED' }) }),
      );
    });

    it('accepts the dev-bypass code without consuming an attempt', async () => {
      config.get.mockReturnValue('000000');
      prisma.verificationSession.findFirst.mockResolvedValue(makeSession());
      const result = await service.verifyOtp({ customerId: 'cust-1', conversationId: 'conv-1', purpose: 'IDENTITY', code: '000000' });
      expect(result).toEqual({ verified: true });
      expect(prisma.verificationSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: 'VERIFIED', verifiedAt: expect.any(Date) },
      });
    });

    it('rejects an expired code and never matches it even if correct', async () => {
      prisma.verificationSession.findFirst.mockResolvedValue(makeSession({ expiresAt: new Date(Date.now() - 1000) }));
      await expect(
        service.verifyOtp({ customerId: 'cust-1', conversationId: 'conv-1', purpose: 'IDENTITY', code: '123456' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws when nothing is in progress', async () => {
      prisma.verificationSession.findFirst.mockResolvedValue(null);
      await expect(
        service.verifyOtp({ customerId: 'cust-1', conversationId: 'conv-1', purpose: 'IDENTITY', code: '123456' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('createSession lockout gate', () => {
    it('refuses to start a new session while still within the lockout window', async () => {
      prisma.verificationSession.findFirst.mockResolvedValueOnce(makeSession({ status: 'LOCKED', lockedAt: new Date() }));
      await expect(service.createSession({ customerId: 'cust-1', purpose: 'IDENTITY' })).rejects.toThrow();
      expect(prisma.verificationSession.create).not.toHaveBeenCalled();
    });

    it('allows a new session once the lockout window has passed', async () => {
      prisma.verificationSession.findFirst.mockResolvedValueOnce(
        makeSession({ status: 'LOCKED', lockedAt: new Date(Date.now() - 40 * 60 * 1000) }),
      );
      prisma.verificationSession.create.mockResolvedValue(makeSession({ id: 'session-new' }));
      const { session } = await service.createSession({ customerId: 'cust-1', purpose: 'IDENTITY' });
      expect(session.id).toBe('session-new');
      expect(prisma.verificationSession.create).toHaveBeenCalled();
    });
  });
});
