import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter } from 'events';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthPrincipal } from '../../common/types/auth-principal';

interface AuthenticatedSocket extends Socket {
  principal?: AuthPrincipal;
}

@WebSocketGateway({ namespace: '/conversations', cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(ChatGateway.name);
  // Lets server-side code observe the same broadcasts a browser socket client would receive,
  // without an actual socket connection — used by PstnCallService to capture streamed TTS
  // audio (audio-stream-start/chunk/end) for a real phone call, which has no browser listening
  // on this conversation's room to play it. Purely additive: broadcast() still always emits to
  // the real Socket.IO room exactly as before.
  private readonly internalEvents = new EventEmitter();

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: AuthenticatedSocket) {
    const token = (client.handshake.auth?.token ?? client.handshake.query?.token) as string | undefined;
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      client.principal = this.jwt.verify<AuthPrincipal>(token);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: AuthenticatedSocket) {
    // no-op for Phase 1
  }

  @SubscribeMessage('join')
  handleJoin(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() data: { conversationId: string }) {
    if (!client.principal || !data?.conversationId) return;
    client.join(`conversation:${data.conversationId}`);
    this.logger.debug(`${client.principal.sub} joined conversation:${data.conversationId}`);
  }

  broadcast(conversationId: string, event: string, payload: unknown) {
    this.server?.to(`conversation:${conversationId}`).emit(event, payload);
    this.internalEvents.emit(conversationId, event, payload);
  }

  /** Subscribe to broadcasts for one conversation without a socket connection. Returns an
   *  unsubscribe function — always call it once done listening (e.g. in a `finally`), the
   *  emitter has no other cleanup of its own. */
  onBroadcast(conversationId: string, handler: (event: string, payload: unknown) => void): () => void {
    this.internalEvents.on(conversationId, handler);
    return () => this.internalEvents.off(conversationId, handler);
  }
}
