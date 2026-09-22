import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

export interface VoiceSession {
  roomName: string;
  participantToken: string;
}

/**
 * Thin wrapper around the LiveKit server SDK: room lifecycle + participant tokens.
 * This is the voice *transport* only — audio frame handling (STT/TTS wiring to actual
 * media tracks) is a LiveKit Agents-style worker, intentionally out of scope until a
 * real LiveKit server (self-hosted or Cloud) is available to develop and test against.
 * Until LIVEKIT_URL/KEY/SECRET are configured, callers get a clear, typed error rather
 * than a silent no-op — same pattern as QwenProvider when unconfigured.
 */
@Injectable()
export class LiveKitService {
  private readonly logger = new Logger(LiveKitService.name);
  private readonly url: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private roomService?: RoomServiceClient;

  constructor(private readonly config: ConfigService) {
    this.url = this.config.get<string>('livekit.url') ?? '';
    this.apiKey = this.config.get<string>('livekit.apiKey') ?? '';
    this.apiSecret = this.config.get<string>('livekit.apiSecret') ?? '';
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.apiKey && this.apiSecret);
  }

  private getRoomService(): RoomServiceClient {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Voice transport is not configured (LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET missing).',
      );
    }
    if (!this.roomService) {
      const httpUrl = this.url.replace(/^ws/, 'http');
      this.roomService = new RoomServiceClient(httpUrl, this.apiKey, this.apiSecret);
    }
    return this.roomService;
  }

  async createSession(roomName: string, participantIdentity: string): Promise<VoiceSession> {
    const roomService = this.getRoomService();
    try {
      await roomService.createRoom({ name: roomName });
    } catch (error) {
      this.logger.warn(`createRoom for ${roomName} failed (may already exist): ${error instanceof Error ? error.message : error}`);
    }

    const at = new AccessToken(this.apiKey, this.apiSecret, { identity: participantIdentity });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    const participantToken = await at.toJwt();

    return { roomName, participantToken };
  }

  async endSession(roomName: string): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      await this.getRoomService().deleteRoom(roomName);
    } catch (error) {
      this.logger.warn(`deleteRoom for ${roomName} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}
