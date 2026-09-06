import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { HttpException, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';

import { isPlatformUserId } from '../wallet/platform-wallet.constants';
import { REDIS_CLIENT } from '../tracking/tracking.constants';
import { resolveRedisConnectionConfig } from '../tracking/redis/redis-config';
import { createRedisClient } from '../tracking/redis/redis.provider';
import { ChatService, ChatRealtimePayload } from './chat.service';
import {
  CHAT_REDIS_CHANNEL,
  CHAT_SERVER_EVENTS,
  CHAT_SOCKET_EVENTS,
  CHAT_SOCKET_NAMESPACE,
  chatConversationRoom,
} from './chat.events';

interface ChatConversationPayload {
  conversationId?: string;
}

interface ChatSendPayload {
  conversationId?: string;
  clientMessageId?: string;
  message?: string;
}

interface ChatReadPayload {
  conversationId?: string;
  upToMessageId?: string;
}

type ChatBusEnvelope = {
  originInstanceId: string;
  payload: ChatRealtimePayload;
};

@WebSocketGateway({
  namespace: CHAT_SOCKET_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class ChatGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  private readonly logger = new Logger('Chat');
  private readonly instanceId = randomUUID();
  private subscriber: Redis | null = null;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  afterInit(): void {
    this.chatService.setRealtimePublisher((payload) => {
      void this.publishAndFanout(payload);
    });
    void this.startSubscriber();
  }

  async onModuleDestroy(): Promise<void> {
    this.chatService.setRealtimePublisher(null);
    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        this.subscriber.disconnect();
      }
      this.subscriber = null;
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn('[Chat][socket] connection rejected: missing token');
        client.disconnect(true);
        return;
      }

      const secret = this.configService.getOrThrow<string>('JWT_ACCESS_SECRET');
      const payload = await this.jwtService.verifyAsync<{ sub?: string }>(
        token,
        { secret },
      );

      if (!payload?.sub || isPlatformUserId(payload.sub)) {
        this.logger.warn('[Chat][socket] connection rejected: invalid subject');
        client.disconnect(true);
        return;
      }

      client.data.userId = payload.sub;
      this.logger.log(
        `[Chat][socket] connected socket=${client.id} user=${payload.sub}`,
      );
    } catch {
      this.logger.warn(
        `[Chat][socket] connection rejected: auth failed socket=${client.id}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(
      `[Chat][socket] disconnected socket=${client.id} user=${client.data?.userId ?? 'unknown'}`,
    );
  }

  @SubscribeMessage(CHAT_SOCKET_EVENTS.JOIN)
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatConversationPayload,
  ) {
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      return { ok: false, error: 'Unauthorized' };
    }

    const conversationId = body?.conversationId?.trim();
    if (!conversationId) {
      return { ok: false, error: 'conversationId is required' };
    }

    try {
      await this.chatService.getConversation(userId, conversationId);
      await client.join(chatConversationRoom(conversationId));
      return { ok: true, conversationId };
    } catch (error) {
      this.emitError(client, error, conversationId);
      return { ok: false, error: this.errorMessage(error) };
    }
  }

  @SubscribeMessage(CHAT_SOCKET_EVENTS.LEAVE)
  async handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatConversationPayload,
  ) {
    const conversationId = body?.conversationId?.trim();
    if (!conversationId) {
      return { ok: false, error: 'conversationId is required' };
    }
    await client.leave(chatConversationRoom(conversationId));
    return { ok: true, conversationId };
  }

  @SubscribeMessage(CHAT_SOCKET_EVENTS.SEND)
  async handleSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatSendPayload,
  ) {
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      return { ok: false, error: 'Unauthorized' };
    }

    const conversationId = body?.conversationId?.trim();
    const clientMessageId = body?.clientMessageId?.trim();
    if (!conversationId || !clientMessageId) {
      return {
        ok: false,
        error: 'conversationId and clientMessageId are required',
      };
    }

    try {
      const ack = await this.chatService.sendMessage(userId, conversationId, {
        clientMessageId,
        message: body.message ?? '',
      });
      client.emit(CHAT_SERVER_EVENTS.MESSAGE_ACK, ack);
      return { ok: true, ...ack };
    } catch (error) {
      this.emitError(client, error, conversationId);
      return { ok: false, error: this.errorMessage(error) };
    }
  }

  @SubscribeMessage(CHAT_SOCKET_EVENTS.READ)
  async handleRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatReadPayload,
  ) {
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      return { ok: false, error: 'Unauthorized' };
    }

    const conversationId = body?.conversationId?.trim();
    if (!conversationId) {
      return { ok: false, error: 'conversationId is required' };
    }

    try {
      const result = await this.chatService.markRead(
        userId,
        conversationId,
        body.upToMessageId,
      );
      return { ok: true, ...result };
    } catch (error) {
      this.emitError(client, error, conversationId);
      return { ok: false, error: this.errorMessage(error) };
    }
  }

  @SubscribeMessage(CHAT_SOCKET_EVENTS.TYPING)
  async handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatConversationPayload,
  ) {
    return this.handleTypingState(client, body, true);
  }

  @SubscribeMessage(CHAT_SOCKET_EVENTS.STOP_TYPING)
  async handleStopTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatConversationPayload,
  ) {
    return this.handleTypingState(client, body, false);
  }

  private async handleTypingState(
    client: Socket,
    body: ChatConversationPayload,
    typing: boolean,
  ) {
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      return { ok: false, error: 'Unauthorized' };
    }

    const conversationId = body?.conversationId?.trim();
    if (!conversationId) {
      return { ok: false, error: 'conversationId is required' };
    }

    try {
      await this.chatService.assertCanType(userId, conversationId);
      this.chatService.publishTyping(userId, conversationId, typing);
      return { ok: true };
    } catch (error) {
      this.emitError(client, error, conversationId);
      return { ok: false, error: this.errorMessage(error) };
    }
  }

  private async publishAndFanout(payload: ChatRealtimePayload): Promise<void> {
    // Always deliver on this instance first (works if Redis is down).
    this.emitLocal(payload);

    try {
      if (this.redis.status === 'ready') {
        const envelope: ChatBusEnvelope = {
          originInstanceId: this.instanceId,
          payload,
        };
        await this.redis.publish(CHAT_REDIS_CHANNEL, JSON.stringify(envelope));
      }
    } catch (error) {
      this.logger.warn(
        `[Chat] Redis publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private emitLocal(payload: ChatRealtimePayload): void {
    const room = chatConversationRoom(payload.conversationId);
    switch (payload.type) {
      case 'message':
        this.server.to(room).emit(CHAT_SERVER_EVENTS.MESSAGE, payload.message);
        break;
      case 'read':
        this.server.to(room).emit(CHAT_SERVER_EVENTS.READ, {
          conversationId: payload.conversationId,
          readerId: payload.readerId,
          readAt: payload.readAt,
          markedCount: payload.markedCount,
        });
        break;
      case 'typing':
        this.server.to(room).emit(CHAT_SERVER_EVENTS.TYPING, {
          conversationId: payload.conversationId,
          userId: payload.userId,
        });
        break;
      case 'stop_typing':
        this.server.to(room).emit(CHAT_SERVER_EVENTS.STOP_TYPING, {
          conversationId: payload.conversationId,
          userId: payload.userId,
        });
        break;
      case 'conversation_closed':
        this.server.to(room).emit(CHAT_SERVER_EVENTS.CONVERSATION_CLOSED, {
          conversationId: payload.conversationId,
          closedAt: payload.closedAt,
        });
        break;
    }
  }

  private async startSubscriber(): Promise<void> {
    try {
      const resolved = resolveRedisConnectionConfig({
        NODE_ENV: this.configService.get<string>('NODE_ENV'),
        REDIS_URL: this.configService.get<string>('REDIS_URL'),
        REDIS_HOST: this.configService.get<string>('REDIS_HOST'),
        REDIS_PORT: this.configService.get<string>('REDIS_PORT'),
        REDIS_PASSWORD: this.configService.get<string>('REDIS_PASSWORD'),
        REDIS_USERNAME: this.configService.get<string>('REDIS_USERNAME'),
      });
      this.subscriber = createRedisClient(resolved);
      await this.subscriber.subscribe(CHAT_REDIS_CHANNEL);
      this.subscriber.on('message', (_channel, raw) => {
        try {
          const envelope = JSON.parse(raw) as ChatBusEnvelope;
          if (!envelope?.payload || !envelope.originInstanceId) {
            return;
          }
          // Origin already emitted locally — skip echo on this process.
          if (envelope.originInstanceId === this.instanceId) {
            return;
          }
          this.emitLocal(envelope.payload);
        } catch {
          this.logger.warn('[Chat] ignored invalid Redis chat payload');
        }
      });
      this.logger.log('[Chat] Redis subscriber ready');
    } catch (error) {
      this.logger.warn(
        `[Chat] Redis subscriber unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.subscriber = null;
    }
  }

  private extractToken(client: Socket): string | null {
    const authToken = client.handshake?.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken.trim();
    }
    const header = client.handshake?.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim();
    }
    return null;
  }

  private emitError(
    client: Socket,
    error: unknown,
    conversationId?: string,
  ): void {
    client.emit(CHAT_SERVER_EVENTS.ERROR, {
      code: this.errorCode(error),
      message: this.errorMessage(error),
      conversationId: conversationId ?? null,
    });
  }

  private errorCode(error: unknown): string {
    if (error instanceof HttpException) {
      const body = error.getResponse();
      if (
        typeof body === 'object' &&
        body !== null &&
        'code' in body &&
        typeof (body as { code: unknown }).code === 'string'
      ) {
        return (body as { code: string }).code;
      }
      return `HTTP_${error.getStatus()}`;
    }
    return 'CHAT_ERROR';
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpException) {
      const body = error.getResponse();
      if (typeof body === 'string') {
        return body;
      }
      if (typeof body === 'object' && body !== null && 'message' in body) {
        const message = (body as { message: unknown }).message;
        if (typeof message === 'string') {
          return message;
        }
        if (Array.isArray(message)) {
          return message.join(', ');
        }
      }
      return error.message;
    }
    return error instanceof Error ? error.message : 'Chat error';
  }
}
