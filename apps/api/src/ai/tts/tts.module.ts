import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TTS_PROVIDER } from './tts-provider.interface';
import { MockTtsProvider } from './mock-tts.provider';
import { VoxCpm2TtsProvider } from './voxcpm2/voxcpm2-tts.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    MockTtsProvider,
    VoxCpm2TtsProvider,
    {
      provide: TTS_PROVIDER,
      inject: [ConfigService, MockTtsProvider, VoxCpm2TtsProvider],
      useFactory: (config: ConfigService, mock: MockTtsProvider, voxcpm2: VoxCpm2TtsProvider) => {
        return config.get<string>('tts.provider') === 'voxcpm2' ? voxcpm2 : mock;
      },
    },
  ],
  exports: [TTS_PROVIDER],
})
export class TtsModule {}
