import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';
import { In } from 'typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingPaymentMethod } from '../bookings/enums/booking.enums';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VerificationType } from '../verification/enums/verification.enums';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { markVerificationVerified } from '../verification/test/verification-test.helpers';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehicleType } from '../vehicles/enums/vehicle-type.enum';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { VehiclesService } from '../vehicles/vehicles.service';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  creditTestWalletPoints,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { TrackingModule } from '../tracking/tracking.module';
import { ChatModule } from './chat.module';
import {
  CHAT_SERVER_EVENTS,
  CHAT_SOCKET_EVENTS,
  CHAT_SOCKET_NAMESPACE,
} from './chat.events';
import { ChatConversationStatus } from './enums/chat.enums';
import { ChatConversation } from './entities/chat-conversation.entity';
import { ChatMessage } from './entities/chat-message.entity';
import { RatingTask } from '../ratings/entities/rating-task.entity';

function waitForEvent<T>(
  socket: Socket,
  event: string,
  timeoutMs = 8_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitAck<T>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 8_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ack on ${event}`));
    }, timeoutMs);
    socket
      .timeout(timeoutMs)
      .emit(event, payload, (err: Error | null, response: T) => {
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }
        resolve(response);
      });
  });
}

describe('Ride chat (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let baseUrl: string;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: process.env.DATABASE_URL,
          autoLoadEntities: true,
          synchronize: false,
          logging: false,
        }),
        AuthModule,
        WalletModule,
        VerificationModule,
        VehiclesModule,
        RidesModule,
        BookingsModule,
        TrackingModule,
        ChatModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new Msg91ResponseFormatError()),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    dataSource = moduleRef.get(DataSource);
    authService = moduleRef.get(AuthService);
    verificationService = moduleRef.get(VerificationService);
    vehiclesService = moduleRef.get(VehiclesService);
    walletService = moduleRef.get(WalletService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (!ctx) continue;

      const asPassenger = await dataSource.getRepository(Booking).find({
        where: { passengerId: ctx.userId },
      });
      const asDriverRides = await dataSource.getRepository(Ride).find({
        where: { driverId: ctx.userId },
        select: { id: true },
      });
      const asDriverBookings =
        asDriverRides.length === 0
          ? []
          : await dataSource.getRepository(Booking).find({
              where: { rideId: In(asDriverRides.map((r) => r.id)) },
            });
      const bookings = [...asPassenger, ...asDriverBookings];
      const bookingIds = [...new Set(bookings.map((b) => b.id))];
      const rideIds = asDriverRides.map((r) => r.id);

      if (bookingIds.length > 0) {
        await dataSource
          .getRepository(RatingTask)
          .createQueryBuilder()
          .delete()
          .where('booking_id IN (:...ids)', { ids: bookingIds })
          .execute();

        const conversations = await dataSource
          .getRepository(ChatConversation)
          .find({ where: { bookingId: In(bookingIds) } });
        const conversationIds = conversations.map((c) => c.id);
        if (conversationIds.length > 0) {
          await dataSource
            .getRepository(ChatMessage)
            .createQueryBuilder()
            .delete()
            .where('conversation_id IN (:...ids)', { ids: conversationIds })
            .execute();
          await dataSource
            .getRepository(ChatConversation)
            .createQueryBuilder()
            .delete()
            .where('id IN (:...ids)', { ids: conversationIds })
            .execute();
        }

        await dataSource
          .getRepository(Booking)
          .createQueryBuilder()
          .delete()
          .where('id IN (:...ids)', { ids: bookingIds })
          .execute();
      }

      const leftoverConversations = await dataSource
        .getRepository(ChatConversation)
        .find({
          where: [{ driverId: ctx.userId }, { passengerId: ctx.userId }],
        });
      if (leftoverConversations.length > 0) {
        const ids = leftoverConversations.map((c) => c.id);
        await dataSource
          .getRepository(ChatMessage)
          .createQueryBuilder()
          .delete()
          .where('conversation_id IN (:...ids)', { ids })
          .execute();
        await dataSource
          .getRepository(ChatConversation)
          .createQueryBuilder()
          .delete()
          .where('id IN (:...ids)', { ids })
          .execute();
      }

      if (rideIds.length > 0) {
        const remainingBookings = await dataSource.getRepository(Booking).find({
          where: { rideId: In(rideIds) },
        });
        const remainingBookingIds = remainingBookings.map((b) => b.id);
        if (remainingBookingIds.length > 0) {
          await dataSource
            .getRepository(RatingTask)
            .createQueryBuilder()
            .delete()
            .where('booking_id IN (:...ids)', { ids: remainingBookingIds })
            .execute();
          const conversations = await dataSource
            .getRepository(ChatConversation)
            .find({ where: { bookingId: In(remainingBookingIds) } });
          const conversationIds = conversations.map((c) => c.id);
          if (conversationIds.length > 0) {
            await dataSource
              .getRepository(ChatMessage)
              .createQueryBuilder()
              .delete()
              .where('conversation_id IN (:...ids)', { ids: conversationIds })
              .execute();
            await dataSource
              .getRepository(ChatConversation)
              .createQueryBuilder()
              .delete()
              .where('id IN (:...ids)', { ids: conversationIds })
              .execute();
          }
          await dataSource
            .getRepository(Booking)
            .createQueryBuilder()
            .delete()
            .where('id IN (:...ids)', { ids: remainingBookingIds })
            .execute();
        }

        await dataSource
          .getRepository(RatingTask)
          .createQueryBuilder()
          .delete()
          .where('ride_id IN (:...ids)', { ids: rideIds })
          .execute();
        await dataSource
          .getRepository(Ride)
          .createQueryBuilder()
          .delete()
          .where('id IN (:...ids)', { ids: rideIds })
          .execute();
      }

      await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
      await dataSource.getRepository(UserVerification).delete({
        userId: ctx.userId,
      });
      await dataSource.getRepository(UserProfile).delete({
        userId: ctx.userId,
      });
      await cleanupTestWallet(dataSource, ctx);
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  async function createUser(label: string, options: { verified?: boolean } = {}) {
    const phone = `+91${Date.now().toString().slice(-9)}${Math.floor(
      Math.random() * 10,
    )}`;
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });
    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId: login.user.id,
    });
    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    tracked.push({
      userId: login.user.id,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });

    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: label,
        lastName: 'User',
        displayName: label,
        gender: null,
        dateOfBirth: null,
        profilePhoto: null,
      }),
    );

    await creditTestWalletPoints(
      walletService,
      wallet.id,
      login.user.id,
      50_000n,
    );

    if (options.verified !== false) {
      await markVerificationVerified(
        verificationService,
        dataSource,
        login.user.id,
        VerificationType.IDENTITY,
      );
    }

    return login;
  }

  async function publishableDriver(label = 'Driver') {
    const login = await createUser(label);
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: `UP16${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2024,
      color: 'White',
      seatingCapacity: 5,
    });
    for (const type of [
      VerificationType.IDENTITY,
      VerificationType.DRIVING_LICENSE,
      VerificationType.VEHICLE,
    ]) {
      await markVerificationVerified(
        verificationService,
        dataSource,
        login.user.id,
        type,
      );
    }
    return { login, vehicle };
  }

  async function publishRegular(
    token: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const res = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId,
        source: 'Noida Sector 62',
        destination: 'Connaught Place',
        departureDate: '2026-09-20',
        departureTime: '09:00',
        totalSeats: 3,
        pricePerSeat: 100,
        maxTwoInBackSeat: false,
        noSmoking: true,
        noPets: true,
        luggageAllowed: true,
        ...overrides,
      })
      .expect(201);
    return res.body;
  }

  async function bookPayLater(token: string, rideId: string, seats = 1) {
    const res = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rideId,
        seats,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
    return res.body;
  }

  function connectChat(token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(`${baseUrl}${CHAT_SOCKET_NAMESPACE}`, {
        auth: { token },
        transports: ['websocket'],
        forceNew: true,
      });
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('socket connect timeout'));
      }, 8_000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it('REGULAR: booking opens chat; send/idempotency/authz/close on complete', async () => {
    const driver = await publishableDriver('ChatDriver');
    const passenger = await createUser('ChatPassenger');
    const stranger = await createUser('Stranger', { verified: false });

    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    const booking = await bookPayLater(passenger.accessToken, ride.id);

    const list = await request(app.getHttpServer())
      .get('/chat/conversations')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);

    expect(list.body.items).toHaveLength(1);
    const conversationId = list.body.items[0].id as string;
    expect(list.body.items[0].bookingId).toBe(booking.id);
    expect(list.body.items[0].status).toBe(ChatConversationStatus.OPEN);
    expect(list.body.items[0].otherParticipant.id).toBe(driver.login.user.id);

    await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(403);

    const clientMessageId = randomUUID();
    const sent = await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId, message: '  Where are you?  ' })
      .expect(201);

    expect(sent.body.status).toBe('SENT');
    expect(sent.body.message.message).toBe('Where are you?');

    const dup = await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId, message: 'Where are you?' })
      .expect(201);
    expect(dup.body.status).toBe('DUPLICATE');
    expect(dup.body.messageId).toBe(sent.body.messageId);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: '   ' })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        clientMessageId: randomUUID(),
        message: 'x'.repeat(1001),
      })
      .expect(400);

    const ok1000 = await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        clientMessageId: randomUUID(),
        message: 'y'.repeat(1000),
      })
      .expect(201);
    expect(ok1000.body.message.message).toHaveLength(1000);

    // Start + complete ride to close chat
    await dataSource.getRepository(Ride).update(
      { id: ride.id },
      { status: RideStatus.IN_PROGRESS },
    );
    await dataSource.query(
      `UPDATE bookings SET pickup_status = 'PICKED_UP' WHERE id = $1`,
      [booking.id],
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const closed = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(closed.body.status).toBe(ChatConversationStatus.CLOSED);

    const history = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(history.body.items.length).toBeGreaterThan(0);

    const blocked = await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'after close' })
      .expect(409);
    expect(blocked.body.code).toBe('CHAT_CLOSED');
  });

  it('MULTI-PASSENGER: separate conversations and passenger isolation', async () => {
    const driver = await publishableDriver('MultiDriver');
    const p1 = await createUser('PassengerA');
    const p2 = await createUser('PassengerB');

    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
      { totalSeats: 3 },
    );
    const b1 = await bookPayLater(p1.accessToken, ride.id);
    const b2 = await bookPayLater(p2.accessToken, ride.id);

    const driverList = await request(app.getHttpServer())
      .get('/chat/conversations')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(driverList.body.items).toHaveLength(2);
    const c1 = driverList.body.items.find(
      (c: { bookingId: string }) => c.bookingId === b1.id,
    );
    const c2 = driverList.body.items.find(
      (c: { bookingId: string }) => c.bookingId === b2.id,
    );
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c1.id).not.toBe(c2.id);

    await request(app.getHttpServer())
      .get(`/chat/conversations/${c1.id}`)
      .set('Authorization', `Bearer ${p2.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${c1.id}/messages`)
      .set('Authorization', `Bearer ${p1.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'hi from A' })
      .expect(201);

    const p2Messages = await request(app.getHttpServer())
      .get(`/chat/conversations/${c2.id}/messages`)
      .set('Authorization', `Bearer ${p2.accessToken}`)
      .expect(200);
    expect(p2Messages.body.items).toHaveLength(0);
  });

  it('WEBSOCKET: authenticated send emits message + ACK; closed rejects', async () => {
    const driver = await publishableDriver('WsDriver');
    const passenger = await createUser('WsPassenger');
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    await bookPayLater(passenger.accessToken, ride.id);

    const list = await request(app.getHttpServer())
      .get('/chat/conversations')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    const conversationId = list.body.items[0].id as string;

    const passengerSocket = await connectChat(passenger.accessToken);
    const driverSocket = await connectChat(driver.login.accessToken);

    await emitAck(passengerSocket, CHAT_SOCKET_EVENTS.JOIN, {
      conversationId,
    });
    await emitAck(driverSocket, CHAT_SOCKET_EVENTS.JOIN, { conversationId });

    const messagePromise = waitForEvent<{ message: string }>(
      driverSocket,
      CHAT_SERVER_EVENTS.MESSAGE,
    );
    const ackPromise = waitForEvent<{ status: string; messageId: string }>(
      passengerSocket,
      CHAT_SERVER_EVENTS.MESSAGE_ACK,
    );

    const sendResult = await emitAck<{ ok: boolean; status: string }>(
      passengerSocket,
      CHAT_SOCKET_EVENTS.SEND,
      {
        conversationId,
        clientMessageId: randomUUID(),
        message: 'socket hello',
      },
    );
    expect(sendResult.ok).toBe(true);

    const [message, ack] = await Promise.all([messagePromise, ackPromise]);
    expect(message.message).toBe('socket hello');
    expect(ack.status).toBe('SENT');

    await dataSource.getRepository(ChatConversation).update(
      { id: conversationId },
      {
        status: ChatConversationStatus.CLOSED,
        closedAt: new Date(),
      },
    );

    const closedSend = await emitAck<{ ok: boolean; error: string }>(
      passengerSocket,
      CHAT_SOCKET_EVENTS.SEND,
      {
        conversationId,
        clientMessageId: randomUUID(),
        message: 'should fail',
      },
    );
    expect(closedSend.ok).toBe(false);

    passengerSocket.close();
    driverSocket.close();
  });

  it('conversation uniqueness per booking', async () => {
    const driver = await publishableDriver('UniqueDriver');
    const passenger = await createUser('UniquePassenger');
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    const booking = await bookPayLater(passenger.accessToken, ride.id);

    const rows = await dataSource.getRepository(ChatConversation).find({
      where: { bookingId: booking.id },
    });
    expect(rows).toHaveLength(1);

    await expect(
      dataSource.getRepository(ChatConversation).save(
        dataSource.getRepository(ChatConversation).create({
          rideId: ride.id,
          bookingId: booking.id,
          driverId: driver.login.user.id,
          passengerId: passenger.user.id,
          status: ChatConversationStatus.OPEN,
        }),
      ),
    ).rejects.toBeTruthy();
  });

  it('COMMUTE: PENDING booking opens chat; reject closes it', async () => {
    const driver = await publishableDriver('CommuteDriver');
    const passenger = await createUser('CommutePassenger');

    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.COMMUTE,
        vehicleId: driver.vehicle.id,
        source: 'Office Park A',
        destination: 'Office Park B',
        departureDate: '2026-09-21',
        departureTime: '08:30',
        totalSeats: 3,
        pricePerSeat: 100,
        maxTwoInBackSeat: false,
        noSmoking: true,
        noPets: true,
        luggageAllowed: true,
        sourceLatitude: 28.5355,
        sourceLongitude: 77.391,
        destinationLatitude: 28.6139,
        destinationLongitude: 77.209,
      })
      .expect(201);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('chat-commute'))
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    expect(booking.body.status).toBe('PENDING');

    const list = await request(app.getHttpServer())
      .get('/chat/conversations')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    const conversationId = list.body.items[0].id as string;
    expect(list.body.items[0].status).toBe(ChatConversationStatus.OPEN);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'pending hello' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const closed = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(closed.body.status).toBe(ChatConversationStatus.CLOSED);

    const blocked = await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'after reject' })
      .expect(409);
    expect(blocked.body.code).toBe('CHAT_CLOSED');
  });
});
