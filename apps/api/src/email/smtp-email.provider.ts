import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { EmailProvider, EmailSendResult, SendEmailParams } from './email-provider.interface';

/**
 * Real SMTP send via nodemailer — the direct Node equivalent of the reference Laravel
 * project's MAIL_MAILER=smtp driver (that project's own Docker/production config: Gmail SMTP,
 * smtp.gmail.com:587, a Gmail address + app password via MAIL_USERNAME/MAIL_PASSWORD). Works
 * identically against any standard SMTP server, not just Gmail — nothing here is Gmail-specific
 * beyond the config default in configuration.ts.
 *
 * Credential handling: MAIL_USERNAME/MAIL_PASSWORD are read once here, at construction, straight
 * from ConfigService (which reads them from apps/api/.env, gitignored) — never logged, never
 * returned in EmailSendResult, never passed to a tool result or the LLM. On failure, only
 * `error.message` is kept (see the catch block) — no full error object/stack that could
 * otherwise leak transport internals (e.g. an SMTP server banner or connection string).
 */
@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromAddress: string;
  private readonly fromName: string;

  constructor(config: ConfigService) {
    this.fromAddress = config.get<string>('mail.fromAddress')!;
    this.fromName = config.get<string>('mail.fromName')!;
    this.transporter = nodemailer.createTransport({
      host: config.get<string>('mail.host'),
      port: config.get<number>('mail.port'),
      secure: config.get<number>('mail.port') === 465,
      auth: {
        user: config.get<string>('mail.username'),
        pass: config.get<string>('mail.password'),
      },
      // LATENCY (2026-09-28, real-call review — customer asked to "make it in a better
      // latency"): without pooling, every single send pays a fresh TCP+TLS handshake and a full
      // Gmail SMTP AUTH round trip from zero, on top of the message itself — real, measurable
      // time that has nothing to do with this message's own size. Pooling keeps a small number
      // of already-authenticated connections open and reuses them across sends (this provider is
      // a Nest singleton, so the pool lives for the process's lifetime) — the first send after a
      // cold start still pays the full cost, but every send after that is faster. Real send is
      // already backgrounded (fire-and-forget) so this isn't customer-facing wait time either
      // way, but a faster real send still means the email itself arrives sooner.
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
    });
  }

  async send(params: SendEmailParams): Promise<EmailSendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromAddress}>`,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        attachments: params.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
      return { success: true, messageId: info.messageId };
    } catch (error) {
      // Deliberately message-only (see class doc comment) — never the raw error object.
      this.logger.error(`SMTP send failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, error: 'SMTP_SEND_FAILED' };
    }
  }
}
