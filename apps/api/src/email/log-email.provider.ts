import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider, EmailSendResult, SendEmailParams } from './email-provider.interface';

/**
 * Stand-in for a real SMTP send — same role as MockTtsProvider/MockLlmProvider elsewhere in
 * this codebase, and the direct equivalent of the reference Laravel project's own MAIL_MAILER=log
 * default: never opens a network connection, just records that a send was attempted. Returns
 * success so the rest of the pipeline (statement generation, idempotency, audit) can be
 * exercised end-to-end without real credentials configured. Swapping to SmtpEmailProvider is a
 * config change (MAIL_MAILER=smtp + real MAIL_USERNAME/MAIL_PASSWORD) — see EmailModule.
 */
@Injectable()
export class LogEmailProvider implements EmailProvider {
  private readonly logger = new Logger(LogEmailProvider.name);

  async send(params: SendEmailParams): Promise<EmailSendResult> {
    const isProduction = process.env.NODE_ENV === 'production';
    this.logger.log(
      `[MAIL_MAILER=log] Would send to ${params.to}: "${params.subject}"` +
        (params.attachments?.length ? ` with ${params.attachments.length} attachment(s)` : '') +
        (isProduction ? '' : ` — body: ${params.text ?? params.html}`),
    );
    return { success: true, messageId: `log-${Date.now()}` };
  }
}
