import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LLM_PROVIDER } from './llm-provider.interface';
import { MockLlmProvider } from './mock-llm.provider';
import { QwenProvider } from './qwen.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    MockLlmProvider,
    QwenProvider,
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService, MockLlmProvider, QwenProvider],
      useFactory: (config: ConfigService, mock: MockLlmProvider, qwen: QwenProvider) => {
        return config.get<string>('llm.provider') === 'qwen' ? qwen : mock;
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
