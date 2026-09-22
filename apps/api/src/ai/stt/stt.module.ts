import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { STT_PROVIDER } from './stt-provider.interface';
import { MockSttProvider } from './mock-stt.provider';
import { CohereArabicSttProvider } from './cohere/cohere-arabic-stt.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    MockSttProvider,
    CohereArabicSttProvider,
    {
      provide: STT_PROVIDER,
      inject: [ConfigService, MockSttProvider, CohereArabicSttProvider],
      useFactory: (config: ConfigService, mock: MockSttProvider, cohere: CohereArabicSttProvider) => {
        return config.get<string>('stt.provider') === 'cohere' ? cohere : mock;
      },
    },
  ],
  exports: [STT_PROVIDER],
})
export class SttModule {}
