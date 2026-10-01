import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let prisma: any;
  let emailProvider: any;
  let service: NotificationsService;

  beforeEach(() => {
    prisma = { notification: { create: jest.fn() } };
    emailProvider = { send: jest.fn() };
    service = new NotificationsService(prisma, emailProvider);
  });

  describe('sendEmail — the ONLY verified-delivery path (statements)', () => {
    it('records SENT and returns success:true only when the provider actually confirms it', async () => {
      emailProvider.send.mockResolvedValue({ success: true });
      prisma.notification.create.mockResolvedValue({ id: 'n-1', status: 'SENT' });

      const result = await service.sendEmail({ recipientId: 'cust-1', to: 'a@b.com', subject: 'S', html: '<p/>', text: 'T' });

      expect(result.success).toBe(true);
      expect(prisma.notification.create.mock.calls[0][0].data.status).toBe('SENT');
      expect(prisma.notification.create.mock.calls[0][0].data.sentAt).not.toBeNull();
    });

    it('records FAILED and returns success:false when the provider reports failure — never claims delivery it did not confirm', async () => {
      emailProvider.send.mockResolvedValue({ success: false, error: 'SMTP_SEND_FAILED' });
      prisma.notification.create.mockResolvedValue({ id: 'n-1', status: 'FAILED' });

      const result = await service.sendEmail({ recipientId: 'cust-1', to: 'a@b.com', subject: 'S', html: '<p/>', text: 'T' });

      expect(result.success).toBe(false);
      expect(prisma.notification.create.mock.calls[0][0].data.status).toBe('FAILED');
      expect(prisma.notification.create.mock.calls[0][0].data.sentAt).toBeNull();
    });

    it('never persists the rendered HTML/attachment contents — only a safe description', async () => {
      emailProvider.send.mockResolvedValue({ success: true });
      prisma.notification.create.mockResolvedValue({});

      await service.sendEmail({ recipientId: 'cust-1', to: 'a@b.com', subject: 'S', html: '<p>SECRET-DATA</p>', text: 'SECRET-DATA' });

      const content = prisma.notification.create.mock.calls[0][0].data.content;
      expect(content).not.toContain('SECRET-DATA');
    });
  });

  describe('send — OTP/PIN/password codes: persists a redacted version, never the real secret', () => {
    it('stores redactedContent in the DB row, not the real content', async () => {
      prisma.notification.create.mockResolvedValue({ id: 'n-1' });

      await service.send({
        recipientType: 'CUSTOMER',
        recipientId: 'cust-1',
        channel: 'EMAIL',
        content: 'Your code is 123456',
        redactedContent: 'Your code is [REDACTED]',
      });

      expect(prisma.notification.create.mock.calls[0][0].data.content).toBe('Your code is [REDACTED]');
    });

    it('falls back to the real content when no redactedContent is given (non-secret notifications)', async () => {
      prisma.notification.create.mockResolvedValue({ id: 'n-1' });
      await service.send({ recipientType: 'CUSTOMER', recipientId: 'cust-1', channel: 'EMAIL', content: 'Your statement is ready' });
      expect(prisma.notification.create.mock.calls[0][0].data.content).toBe('Your statement is ready');
    });
  });
});
