import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationRecipientType, Notification } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { EMAIL_PROVIDER, EmailAttachment, EmailProvider } from '../../email/email-provider.interface';

export interface SendNotificationInput {
  recipientType: NotificationRecipientType;
  recipientId: string;
  channel: NotificationChannel;
  subject?: string;
  content: string;
  /**
   * When `content` carries a secret (an OTP code, a temporary PIN/password), pass a masked
   * version here — it's what actually gets persisted to the `notifications` table (and, in
   * production, logged), never the real secret. `content` itself is only ever used for the
   * (mocked) delivery step and the dev-only console line below.
   */
  redactedContent?: string;
}

/**
 * No real email/SMS gateway is part of the mandated stack yet, so this records the
 * notification as sent immediately. Swapping in a real provider later only changes
 * this service — callers (auth OTP, campaigns, etc.) are unaffected.
 *
 * SECURITY (2026-09-21 reliability hardening pass): confirmed this previously always logged
 * and persisted the raw `content` — for an OTP/PIN/password delivery, that put the plaintext
 * secret into both the server console AND the `notifications` DB table unconditionally, in
 * every environment. `redactedContent` fixes the storage/prod-log side; the dev-only console
 * line below (still showing the real content, gated off in production) is the intended
 * "developer reads it from the console instead of a real gateway" mechanism this project
 * already relies on elsewhere for OTP testing — not a separate leak.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
  ) {}

  /**
   * Genuinely real, verified email delivery — deliberately a SEPARATE method from send() above
   * rather than a modification to it. send() is used by OTP/PIN/password reset (heavily tested,
   * already stable) and always reports SENT immediately by design; changing its contract to
   * depend on a real provider result would risk regressing those flows for a requirement they
   * never had. This method is for callers that need to know the REAL outcome before telling a
   * customer anything succeeded (see StatementsService.sendStatementByEmail) — the Notification
   * row's status reflects what the EmailProvider actually reported, not an assumption.
   */
  async sendEmail(input: {
    recipientId: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    attachments?: EmailAttachment[];
  }): Promise<{ success: boolean; notification: Notification }> {
    const result = await this.emailProvider.send({
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      attachments: input.attachments,
    });
    const notification = await this.prisma.notification.create({
      data: {
        recipientType: 'CUSTOMER',
        recipientId: input.recipientId,
        channel: 'EMAIL',
        subject: input.subject,
        // Never the rendered HTML/attachment bytes — a short, safe description is enough for
        // audit purposes (see the module-level "do not record document contents" requirement).
        content: `Statement email ${result.success ? 'sent' : 'failed'} to registered address on file.`,
        status: result.success ? 'SENT' : 'FAILED',
        sentAt: result.success ? new Date() : null,
      },
    });
    this.logger.log(`Email notification ${notification.id} -> ${input.recipientId}: ${result.success ? 'SENT' : `FAILED (${result.error ?? 'unknown'})`}`);
    return { success: result.success, notification };
  }

  async send(input: SendNotificationInput) {
    const isProduction = process.env.NODE_ENV === 'production';
    const storedContent = input.redactedContent ?? input.content;
    const notification = await this.prisma.notification.create({
      data: {
        recipientType: input.recipientType,
        recipientId: input.recipientId,
        channel: input.channel,
        subject: input.subject,
        content: storedContent,
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    if (isProduction) {
      this.logger.log(`Notification ${notification.id} (${input.channel}) -> ${input.recipientId} sent`);
    } else {
      this.logger.log(`Notification ${notification.id} (${input.channel}) -> ${input.recipientId}: ${input.content}`);
    }
    return notification;
  }
}
