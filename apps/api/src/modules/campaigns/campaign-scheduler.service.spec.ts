import { CampaignSchedulerService } from './campaign-scheduler.service';

// Callback auto-dial / auto-complete (audit Part 16 #7): the scheduler genuinely dials due
// callbacks and only flips a callback to COMPLETED once a real Call.endTime exists. These tests
// drive the public tick() entry point with mocks — no real PSTN, DB or clock dependence beyond
// "yesterday" vs "tomorrow" dates.
const YESTERDAY = new Date(Date.now() - 24 * 3600 * 1000);
const TOMORROW = new Date(Date.now() + 24 * 3600 * 1000);

describe('CampaignSchedulerService — callbacks', () => {
  let prisma: any;
  let config: any;
  let conversations: any;
  let callsService: any;
  let pstn: any;
  let audit: any;
  let service: CampaignSchedulerService;

  beforeEach(() => {
    prisma = {
      campaign: { findMany: jest.fn().mockResolvedValue([]) },
      campaignContact: { findMany: jest.fn(), update: jest.fn() },
      campaignCall: { create: jest.fn() },
      callback: { findMany: jest.fn(), update: jest.fn() },
      customer: { findUnique: jest.fn() },
    };
    config = { get: jest.fn().mockReturnValue(false) };
    conversations = { addMessage: jest.fn() };
    callsService = { startCall: jest.fn().mockResolvedValue({ call: { id: 'call-sim-1' } }) };
    pstn = { dial: jest.fn().mockResolvedValue({ call: { id: 'call-pstn-1' } }) };
    audit = { log: jest.fn() };
    service = new CampaignSchedulerService(prisma, config, conversations, callsService, pstn, audit);
  });

  /** findMany is called for PENDING (due) callbacks first, then SCHEDULED (close-out). */
  function mockCallbacks(pending: unknown[], scheduled: unknown[] = []) {
    prisma.callback.findMany.mockImplementation(async (args: any) => (args.where.status === 'PENDING' ? pending : scheduled));
  }

  it('dials a due PENDING callback and moves it to SCHEDULED with the real call id', async () => {
    mockCallbacks([{ id: 'cb-1', customerId: 'cust-1', requestedDate: YESTERDAY, requestedTime: '09:00' }]);

    await service.tick();

    expect(callsService.startCall).toHaveBeenCalledWith('cust-1', 'OUTBOUND', undefined);
    expect(prisma.callback.update).toHaveBeenCalledWith({ where: { id: 'cb-1' }, data: { status: 'SCHEDULED', callId: 'call-sim-1' } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'callback.call_placed', entityId: 'cb-1' }));
  });

  it('does NOT dial a callback scheduled for the future', async () => {
    mockCallbacks([{ id: 'cb-2', customerId: 'cust-1', requestedDate: TOMORROW, requestedTime: '09:00' }]);

    await service.tick();

    expect(callsService.startCall).not.toHaveBeenCalled();
    expect(pstn.dial).not.toHaveBeenCalled();
    expect(prisma.callback.update).not.toHaveBeenCalled();
  });

  it('only ever queries PENDING callbacks for dialing, so a CANCELLED/COMPLETED one is never re-dialed', async () => {
    mockCallbacks([]);
    await service.tick();
    const statuses = prisma.callback.findMany.mock.calls.map((c: any[]) => c[0].where.status);
    expect(statuses).toContain('PENDING');
    expect(statuses).not.toContain('CANCELLED');
  });

  it('places a REAL PSTN call when telephony is enabled and the customer has a phone on file', async () => {
    config.get.mockReturnValue(true);
    prisma.customer.findUnique.mockResolvedValue({ phone: '+966500000001' });
    mockCallbacks([{ id: 'cb-3', customerId: 'cust-1', requestedDate: YESTERDAY, requestedTime: '09:00' }]);

    await service.tick();

    expect(pstn.dial).toHaveBeenCalledWith({ customerId: 'cust-1', phoneNumber: '+966500000001', aiAgentId: undefined });
    expect(callsService.startCall).not.toHaveBeenCalled();
    expect(prisma.callback.update).toHaveBeenCalledWith({ where: { id: 'cb-3' }, data: { status: 'SCHEDULED', callId: 'call-pstn-1' } });
  });

  it('falls back to the simulated call when telephony is enabled but no phone number is on file', async () => {
    config.get.mockReturnValue(true);
    prisma.customer.findUnique.mockResolvedValue({ phone: null });
    mockCallbacks([{ id: 'cb-4', customerId: 'cust-1', requestedDate: YESTERDAY, requestedTime: '09:00' }]);

    await service.tick();

    expect(pstn.dial).not.toHaveBeenCalled();
    expect(callsService.startCall).toHaveBeenCalledTimes(1);
  });

  it('marks a SCHEDULED callback COMPLETED only when its real call has an endTime (query-level guarantee)', async () => {
    mockCallbacks([], [{ id: 'cb-5', callId: 'call-9', call: { endTime: new Date() } }]);

    await service.tick();

    const closeOutQuery = prisma.callback.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.where.status === 'SCHEDULED');
    expect(closeOutQuery.where.call).toEqual({ endTime: { not: null } });
    expect(prisma.callback.update).toHaveBeenCalledWith({ where: { id: 'cb-5' }, data: { status: 'COMPLETED' } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'callback.completed', entityId: 'cb-5' }));
  });

  it('does not overlap two ticks (a slow dial must not cause a double-dial)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    prisma.campaign.findMany.mockImplementation(async () => {
      await gate;
      return [];
    });
    mockCallbacks([]);

    const first = service.tick();
    await service.tick(); // second tick while the first is still running -> returns immediately
    expect(prisma.campaign.findMany).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('one failing dial does not crash the tick loop', async () => {
    callsService.startCall.mockRejectedValue(new Error('dial failed'));
    mockCallbacks([{ id: 'cb-6', customerId: 'cust-1', requestedDate: YESTERDAY, requestedTime: '09:00' }]);

    await expect(service.tick()).resolves.toBeUndefined();
    expect(prisma.callback.update).not.toHaveBeenCalled(); // never falsely marked SCHEDULED
  });
});

describe('CampaignSchedulerService — campaign contacts', () => {
  it('marks a contact FAILED once it has used all its attempts instead of dialing again', async () => {
    const prisma: any = {
      campaign: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'camp-1', status: 'ACTIVE', startDate: new Date(Date.now() - 1e9), endDate: null, startTime: null, endTime: null, maxAttempts: 2, retryIntervalMinutes: 1 },
        ]),
      },
      campaignContact: { findMany: jest.fn().mockResolvedValue([{ id: 'cc-1', customerId: 'cust-1', attempts: 2, lastAttemptAt: null }]), update: jest.fn() },
      campaignCall: { create: jest.fn() },
      callback: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    };
    const callsService = { startCall: jest.fn() };
    const service = new CampaignSchedulerService(prisma, { get: jest.fn() } as any, {} as any, callsService as any, {} as any, { log: jest.fn() } as any);

    await service.tick();

    expect(prisma.campaignContact.update).toHaveBeenCalledWith({ where: { id: 'cc-1' }, data: { status: 'FAILED' } });
    expect(callsService.startCall).not.toHaveBeenCalled();
  });
});
