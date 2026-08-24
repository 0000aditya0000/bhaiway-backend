import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  forwardRef,
  HttpException,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';

import { isPlatformUserId } from '../wallet/platform-wallet.constants';
import {
  RideLocationUpdatedEventDto,
  RideTrackingEndedEventDto,
} from './dto/ride-tracking-response.dto';
import { UpdateDriverLocationDto } from './dto/update-driver-location.dto';
import { rideTrackingRoom } from './tracking.constants';
import {
  TRACKING_SERVER_EVENTS,
  TRACKING_SOCKET_EVENTS,
  TRACKING_SOCKET_NAMESPACE,
} from './tracking.events';
import { TrackingService } from './tracking.service';

interface TrackingJoinPayload {
  rideId?: string;
}

interface DriverLocationSocketPayload extends UpdateDriverLocationDto {
  rideId?: string;
}

@WebSocketGateway({
  namespace: TRACKING_SOCKET_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class TrackingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger('Tracking');

  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(forwardRef(() => TrackingService))
    private readonly trackingService: TrackingService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn('[Tracking][socket] connection rejected: missing token');
        client.disconnect(true);
        return;
      }

      const secret = this.configService.getOrThrow<string>('JWT_ACCESS_SECRET');
      const payload = await this.jwtService.verifyAsync<{ sub?: string }>(
        token,
        { secret },
      );

      if (!payload?.sub || isPlatformUserId(payload.sub)) {
        this.logger.warn(
          '[Tracking][socket] connection rejected: invalid subject',
        );
        client.disconnect(true);
        return;
      }

      client.data.userId = payload.sub;
      this.logger.log(
        `[Tracking][socket] connected socket=${client.id} user=${payload.sub}`,
      );
      this.logger.log(
        `[Tracking][socket] authenticated socket=${client.id} user=${payload.sub}`,
      );
    } catch {
      this.logger.warn(
        `[Tracking][socket] connection rejected: auth failed socket=${client.id}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(
      `[Tracking][socket] disconnected socket=${client.id} user=${client.data?.userId ?? 'unknown'}`,
    );
  }

  @SubscribeMessage(TRACKING_SOCKET_EVENTS.JOIN)
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: TrackingJoinPayload,
  ) {
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      return { ok: false, error: 'Unauthorized' };
    }

    const rideId = body?.rideId?.trim();
    if (!rideId) {
      return { ok: false, error: 'rideId is required' };
    }

    try {
      const access = await this.trackingService.assertCanJoinTrackingRoom(
        userId,
        rideId,
      );
      const room = rideTrackingRoom(rideId);
      await client.join(room);

      if (access.role === 'passenger') {
        this.logger.log(
          `[Tracking][socket] passenger joined ride=${rideId} user=${userId} socket=${client.id}`,
        );
      } else {
        this.logger.log(
          `[Tracking][socket] joined ride ride=${rideId} role=${access.role} user=${userId} socket=${client.id}`,
        );
      }

      return { ok: true, rideId, room, role: access.role };
    } catch (error) {
      const message = socketErrorMessage(error, 'Unable to join ride room');
      client.emit(TRACKING_SERVER_EVENTS.ERROR, {
        code: 'JOIN_DENIED',
        message,
        rideId,
      });
      return { ok: false, error: message };
    }
  }

  @SubscribeMessage(TRACKING_SOCKET_EVENTS.LEAVE)
  async handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: TrackingJoinPayload,
  ) {
    const rideId = body?.rideId?.trim();
    if (!rideId) {
      return { ok: false, error: 'rideId is required' };
    }
    await client.leave(rideTrackingRoom(rideId));
    return { ok: true, rideId };
  }

  @SubscribeMessage(TRACKING_SOCKET_EVENTS.DRIVER_LOCATION_UPDATE)
  async handleDriverLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: DriverLocationSocketPayload,
  ) {
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      return { ok: false, error: 'Unauthorized' };
    }

    const rideId = body?.rideId?.trim();
    if (!rideId) {
      return { ok: false, error: 'rideId is required' };
    }

    try {
      const dto: UpdateDriverLocationDto = {
        latitude: body.latitude,
        longitude: body.longitude,
        timestamp: body.timestamp,
        heading: body.heading,
        speed: body.speed,
      };

      const result = await this.trackingService.updateDriverLocation(
        userId,
        rideId,
        dto,
      );

      // Ensure the driver is in the ride room so they can observe broadcasts if needed.
      await client.join(rideTrackingRoom(rideId));

      return {
        ok: true,
        throttled: Boolean((result as { throttled?: boolean }).throttled),
        tracking: result,
      };
    } catch (error) {
      const message = socketErrorMessage(error, 'Location update failed');
      client.emit(TRACKING_SERVER_EVENTS.ERROR, {
        code: 'LOCATION_REJECTED',
        message,
        rideId,
      });
      return { ok: false, error: message };
    }
  }

  /** Broadcast latest location to everyone in `ride:{rideId}`. */
  broadcastLocationUpdated(
    rideId: string,
    event: RideLocationUpdatedEventDto,
  ): void {
    if (!this.server) {
      return;
    }
    const room = rideTrackingRoom(rideId);
    this.server.to(room).emit(TRACKING_SERVER_EVENTS.LOCATION_UPDATED, event);
    this.logger.log(
      `[Tracking][tracking] location broadcast ride=${rideId} room=${room}`,
    );
  }

  /** Notify room that tracking stopped; then drop sockets from the room. */
  async broadcastTrackingEnded(
    rideId: string,
    reason = 'ended',
  ): Promise<void> {
    if (!this.server) {
      return;
    }
    const room = rideTrackingRoom(rideId);
    const payload: RideTrackingEndedEventDto = { rideId, reason };
    this.server.to(room).emit(TRACKING_SERVER_EVENTS.TRACKING_ENDED, payload);
    this.logger.log(
      `[Tracking][tracking] ended broadcast ride=${rideId} reason=${reason}`,
    );

    try {
      const sockets = await this.server.in(room).fetchSockets();
      await Promise.all(sockets.map((socket) => socket.leave(room)));
    } catch {
      // Best-effort room cleanup after end.
    }
  }

  private extractToken(client: Socket): string | null {
    const authToken = client.handshake?.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken.trim().replace(/^Bearer\s+/i, '');
    }

    const header = client.handshake?.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7).trim();
    }

    return null;
  }
}

function socketErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') {
      return response;
    }
    if (typeof response === 'object' && response && 'message' in response) {
      const message = (response as { message: string | string[] }).message;
      return Array.isArray(message) ? message.join(', ') : String(message);
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
