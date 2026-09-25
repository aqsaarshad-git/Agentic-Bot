import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EMAIL_PROVIDER } from './email-provider.interface';
import { LogEmailProvider } from './log-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    LogEmailProvider,
    SmtpEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService, LogEmailProvider, SmtpEmailProvider],
      useFactory: (config: ConfigService, log: LogEmailProvider, smtp: SmtpEmailProvider) => {
        return config.get<string>('mail.mailer') === 'smtp' ? smtp : log;
      },
    },
  ],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
