import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';
import { DataSource, In } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingCancellationReason,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { RatingTask } from '../ratings/entities/rating-task.entity';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import {
  ASSURED_TEST_ROUTE,
  withAssuredPublishHeaders,
} from '../rides/test/assured-ride-test.helpers';
import { startRideAndVerifyAllPickups } from '../rides/test/ride-trip-test.helpers';
import { TrackingModule } from '../tracking/tracking.module';
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
import {
  WalletHold,
  WalletHoldStatus,
} from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
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
import { ChatModule } from './chat.module';
import { ChatService } from './chat.service';
import {
  CHAT_SERVER_EVENTS,
  CHAT_SOCKET_EVENTS,
  CHAT_SOCKET_NAMESPACE,
} from './chat.events';
import { ChatConversation } from './entities/chat-conversation.entity';
import { ChatMessage } from './entities/chat-message.entity';
import { ChatConversationStatus } from './enums/chat.enums';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
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

describe('Ride chat hardening (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let chatService: ChatService;
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
    chatService = moduleRef.get(ChatService);
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
        await dataSource.query(
          `
          UPDATE rides
          SET status = 'CANCELLED',
              assured_queue_id = NULL,
              cancellation_reason = 'DRIVER_CANCELLED',
              cancelled_at = NOW()
          WHERE id = ANY($1::uuid[])
            AND ride_type = 'ASSURED'
            AND status::text LIKE 'ASSURANCE%'
          `,
          [rideIds],
        );
        await dataSource
          .getRepository(Ride)
          .createQueryBuilder()
          .delete()
          .where('id IN (:...ids)', { ids: rideIds })
          .execute();
      }

      await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
      await dataSource
        .getRepository(UserVerification)
        .delete({ userId: ctx.userId });
      await dataSource.getRepository(UserProfile).delete({ userId: ctx.userId });
      await cleanupTestWallet(dataSource, ctx);
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  async function trackUser(login: {
    user: { id: string };
    accessToken: string;
  }) {
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
      phone: '',
    });
    return { login, wallet, balance };
  }

  async function createUser(label: string) {
    const phone = `+91${Date.now().toString().slice(-9)}${Math.floor(
      Math.random() * 10,
    )}`;
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });
    const { wallet } = await trackUser(login);
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
      80_000n,
    );
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.IDENTITY,
    );
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

  async function walletSnapshot(userId: string) {
    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId,
    });
    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    const holds = await dataSource.getRepository(WalletHold).find({
      where: { walletId: wallet.id, status: WalletHoldStatus.ACTIVE },
    });
    return {
      available: balance.availablePoints,
      held: balance.heldPoints,
      activeHoldIds: holds.map((h) => h.id).sort(),
      activeHoldAmounts: holds.map((h) => h.amount).sort(),
    };
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
        departureDate: '2026-10-20',
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

  async function conversationIdForBooking(
    token: string,
    bookingId: string,
  ): Promise<string> {
    const list = await request(app.getHttpServer())
      .get('/chat/conversations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const item = list.body.items.find(
      (c: { bookingId: string }) => c.bookingId === bookingId,
    );
    expect(item).toBeDefined();
    return item.id as string;
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

  it('ASSURED E2E: book → chat → start stays OPEN → complete closes; finance untouched by chat', async () => {
    const driver = await publishableDriver('AssuredChatDriver');
    const passenger = await createUser('AssuredChatPassenger');

    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(driver.login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId: driver.vehicle.id,
        source: 'Assured Chat Source',
        destination: 'Assured Chat Dest',
        departureDate: `2027-01-${String(10 + (Date.now() % 18)).padStart(2, '0')}`,
        departureTime: '10:00',
        totalSeats: 3,
        pricePerSeat: 500,
        ...ASSURED_TEST_ROUTE,
      })
      .expect(201);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('chat-assured-book'))
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);

    expect(booking.body.status).toBe(BookingStatus.CONFIRMED);
    expect(booking.body.securityDepositStatus).toBe('HELD');

    const beforeChatPassenger = await walletSnapshot(passenger.user.id);
    const beforeChatDriver = await walletSnapshot(driver.login.user.id);
    const beforeHold = await dataSource.getRepository(WalletHold).findOneByOrFail({
      id: (
        await dataSource.getRepository(Booking).findOneByOrFail({
          id: booking.body.id,
        })
      ).walletHoldId!,
    });

    const conversationId = await conversationIdForBooking(
      passenger.accessToken,
      booking.body.id,
    );

    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'assured passenger hi' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'assured driver reply' })
      .expect(201);

    const afterChatPassenger = await walletSnapshot(passenger.user.id);
    const afterChatDriver = await walletSnapshot(driver.login.user.id);
    expect(afterChatPassenger).toEqual(beforeChatPassenger);
    expect(afterChatDriver).toEqual(beforeChatDriver);

    const holdAfterChat = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({ id: beforeHold.id });
    expect(holdAfterChat.status).toBe(beforeHold.status);
    expect(holdAfterChat.amount).toBe(beforeHold.amount);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.body.id,
      pickupOtpPepper(),
    );

    const mid = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(mid.body.status).toBe(ChatConversationStatus.OPEN);

    const completed = await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(completed.body.status).toBe(RideStatus.COMPLETED);

    const closed = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(closed.body.status).toBe(ChatConversationStatus.CLOSED);
    expect(closed.body.closedAt).toBeTruthy();

    const history = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(history.body.items.length).toBeGreaterThanOrEqual(2);

    const blocked = await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'after complete' })
      .expect(409);
    expect(blocked.body.code).toBe('CHAT_CLOSED');

    const bookingRow = await dataSource.getRepository(Booking).findOneByOrFail({
      id: booking.body.id,
    });
    expect(bookingRow.status).toBe(BookingStatus.COMPLETED);
    expect(bookingRow.paymentStatus).not.toBe(BookingPaymentStatus.REFUNDED);
  });

  it('COMMUTE: PENDING→accept keeps same conversationId; complete closes', async () => {
    const driver = await publishableDriver('CommuteContDriver');
    const passenger = await createUser('CommuteContPassenger');

    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.COMMUTE,
        vehicleId: driver.vehicle.id,
        source: 'Commute A',
        destination: 'Commute B',
        departureDate: '2026-10-22',
        departureTime: '08:00',
        totalSeats: 3,
        pricePerSeat: 100,
        maxTwoInBackSeat: false,
        noSmoking: true,
        noPets: true,
        luggageAllowed: true,
      })
      .expect(201);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('chat-commute-cont'))
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    expect(booking.body.status).toBe(BookingStatus.PENDING);

    const beforeAcceptId = await conversationIdForBooking(
      passenger.accessToken,
      booking.body.id,
    );

    await request(app.getHttpServer())
      .post(`/chat/conversations/${beforeAcceptId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'pending ping' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${beforeAcceptId}/messages`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'driver pending pong' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const afterAcceptId = await conversationIdForBooking(
      passenger.accessToken,
      booking.body.id,
    );
    expect(afterAcceptId).toBe(beforeAcceptId);

    const stillOpen = await request(app.getHttpServer())
      .get(`/chat/conversations/${afterAcceptId}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(stillOpen.body.status).toBe(ChatConversationStatus.OPEN);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.body.id,
      pickupOtpPepper(),
    );
    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const closed = await request(app.getHttpServer())
      .get(`/chat/conversations/${afterAcceptId}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(closed.body.status).toBe(ChatConversationStatus.CLOSED);

    const history = await request(app.getHttpServer())
      .get(`/chat/conversations/${afterAcceptId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(history.body.items.length).toBeGreaterThanOrEqual(2);

    const blocked = await request(app.getHttpServer())
      .post(`/chat/conversations/${afterAcceptId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'nope' })
      .expect(409);
    expect(blocked.body.code).toBe('CHAT_CLOSED');
  });

  it('MULTI-PASSENGER: 3 conversations isolated', async () => {
    const driver = await publishableDriver('IsoDriver');
    const pA = await createUser('IsoA');
    const pB = await createUser('IsoB');
    const pC = await createUser('IsoC');

    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
      { totalSeats: 3 },
    );
    const bA = await bookPayLater(pA.accessToken, ride.id);
    const bB = await bookPayLater(pB.accessToken, ride.id);
    const bC = await bookPayLater(pC.accessToken, ride.id);

    const cA = await conversationIdForBooking(pA.accessToken, bA.id);
    const cB = await conversationIdForBooking(pB.accessToken, bB.id);
    const cC = await conversationIdForBooking(pC.accessToken, bC.id);
    expect(new Set([cA, cB, cC]).size).toBe(3);

    const driverList = await request(app.getHttpServer())
      .get('/chat/conversations')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(driverList.body.items).toHaveLength(3);

    await request(app.getHttpServer())
      .get(`/chat/conversations/${cA}`)
      .set('Authorization', `Bearer ${pB.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/chat/conversations/${cB}`)
      .set('Authorization', `Bearer ${pC.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/chat/conversations/${cC}`)
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${cA}/messages`)
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'only A' })
      .expect(201);

    const bMsgs = await request(app.getHttpServer())
      .get(`/chat/conversations/${cB}/messages`)
      .set('Authorization', `Bearer ${pB.accessToken}`)
      .expect(200);
    expect(bMsgs.body.items).toHaveLength(0);

    const cMsgs = await request(app.getHttpServer())
      .get(`/chat/conversations/${cC}/messages`)
      .set('Authorization', `Bearer ${pC.accessToken}`)
      .expect(200);
    expect(cMsgs.body.items).toHaveLength(0);
  });

  it('NO-SHOW isolation: A closes, B stays OPEN', async () => {
    const driver = await publishableDriver('NoShowDriver');
    const pA = await createUser('NoShowA');
    const pB = await createUser('NoShowB');

    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(driver.login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId: driver.vehicle.id,
        source: 'NoShow Source',
        destination: 'NoShow Dest',
        departureDate: `2027-02-${String(10 + (Date.now() % 18)).padStart(2, '0')}`,
        departureTime: '11:00',
        totalSeats: 3,
        pricePerSeat: 400,
        ...ASSURED_TEST_ROUTE,
      })
      .expect(201);

    const bA = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('noshow-a'))
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);
    const bB = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${pB.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('noshow-b'))
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);

    const cA = await conversationIdForBooking(pA.accessToken, bA.body.id);
    const cB = await conversationIdForBooking(pB.accessToken, bB.body.id);

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await dataSource.getRepository(Ride).update(
      { id: ride.body.id },
      { departureDate: '2020-01-01', departureTime: '00:00:00' },
    );

    await request(app.getHttpServer())
      .post(`/bookings/${bA.body.id}/rider-no-show`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const aClosed = await request(app.getHttpServer())
      .get(`/chat/conversations/${cA}`)
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .expect(200);
    expect(aClosed.body.status).toBe(ChatConversationStatus.CLOSED);
    expect(aClosed.body.closedAt).toBeTruthy();

    const bOpen = await request(app.getHttpServer())
      .get(`/chat/conversations/${cB}`)
      .set('Authorization', `Bearer ${pB.accessToken}`)
      .expect(200);
    expect(bOpen.body.status).toBe(ChatConversationStatus.OPEN);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${cA}/messages`)
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'a blocked' })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${cB}/messages`)
      .set('Authorization', `Bearer ${pB.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'b still ok' })
      .expect(201);

    const bookingA = await dataSource.getRepository(Booking).findOneByOrFail({
      id: bA.body.id,
    });
    expect(bookingA.status).toBe(BookingStatus.CANCELLED);
    expect(bookingA.cancellationReason).toBe(
      BookingCancellationReason.RIDER_NO_SHOW,
    );
  });

  it('concurrent duplicate clientMessageId is idempotent', async () => {
    const driver = await publishableDriver('IdemDriver');
    const passenger = await createUser('IdemPassenger');
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    const booking = await bookPayLater(passenger.accessToken, ride.id);
    const conversationId = await conversationIdForBooking(
      passenger.accessToken,
      booking.id,
    );
    const clientMessageId = randomUUID();

    const [a, b] = await Promise.all([
      chatService.sendMessage(passenger.user.id, conversationId, {
        clientMessageId,
        message: 'concurrent once',
      }),
      chatService.sendMessage(passenger.user.id, conversationId, {
        clientMessageId,
        message: 'concurrent once',
      }),
    ]);

    expect(a.messageId).toBe(b.messageId);
    expect([a.status, b.status].sort()).toEqual(['DUPLICATE', 'SENT'].sort());

    const count = await dataSource.getRepository(ChatMessage).count({
      where: { senderId: passenger.user.id, clientMessageId },
    });
    expect(count).toBe(1);
  });

  it('lazy reconcile closes OPEN chat when ride already COMPLETED', async () => {
    const driver = await publishableDriver('ReconDriver');
    const passenger = await createUser('ReconPassenger');
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    const booking = await bookPayLater(passenger.accessToken, ride.id);
    const conversationId = await conversationIdForBooking(
      passenger.accessToken,
      booking.id,
    );

    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'before drift' })
      .expect(201);

    // Simulate post-settlement close failure: ride COMPLETED, chat still OPEN.
    await dataSource.getRepository(Ride).update(
      { id: ride.id },
      { status: RideStatus.COMPLETED },
    );
    await dataSource.getRepository(Booking).update(
      { id: booking.id },
      { status: BookingStatus.COMPLETED },
    );
    await dataSource.getRepository(ChatConversation).update(
      { id: conversationId },
      { status: ChatConversationStatus.OPEN, closedAt: null },
    );

    const blocked = await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'should close' })
      .expect(409);
    expect(blocked.body.code).toBe('CHAT_CLOSED');

    const row = await dataSource
      .getRepository(ChatConversation)
      .findOneByOrFail({ id: conversationId });
    expect(row.status).toBe(ChatConversationStatus.CLOSED);
    expect(row.closedAt).toBeTruthy();

    const history = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(history.body.items.some((m: { message: string }) => m.message === 'before drift')).toBe(
      true,
    );
  });

  it('cursor pagination has no duplicates/gaps', async () => {
    const driver = await publishableDriver('PageDriver');
    const passenger = await createUser('PagePassenger');
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    const booking = await bookPayLater(passenger.accessToken, ride.id);
    const conversationId = await conversationIdForBooking(
      passenger.accessToken,
      booking.id,
    );

    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await request(app.getHttpServer())
        .post(`/chat/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .send({
          clientMessageId: randomUUID(),
          message: `msg-${i}`,
        })
        .expect(201);
      ids.push(res.body.messageId);
    }

    const page1 = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}/messages`)
      .query({ limit: 3 })
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(page1.body.items).toHaveLength(3);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.nextBefore).toBe(page1.body.items[2].id);

    const page2 = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}/messages`)
      .query({ limit: 3, before: page1.body.nextBefore })
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(page2.body.items).toHaveLength(3);
    expect(page2.body.hasMore).toBe(true);

    const page3 = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}/messages`)
      .query({ limit: 3, before: page2.body.nextBefore })
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(page3.body.items).toHaveLength(1);
    expect(page3.body.hasMore).toBe(false);

    const all = [
      ...page1.body.items,
      ...page2.body.items,
      ...page3.body.items,
    ].map((m: { id: string }) => m.id);
    expect(new Set(all).size).toBe(7);
    expect(all).toEqual([...ids].reverse());
  });

  it('message validation: blank/whitespace/length/type', async () => {
    const driver = await publishableDriver('ValDriver');
    const passenger = await createUser('ValPassenger');
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    const booking = await bookPayLater(passenger.accessToken, ride.id);
    const conversationId = await conversationIdForBooking(
      passenger.accessToken,
      booking.id,
    );

    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: '' })
      .expect(400);

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

    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        clientMessageId: randomUUID(),
        message: 'y'.repeat(1000),
        messageType: 'TEXT',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        clientMessageId: randomUUID(),
        message: 'image?',
        messageType: 'IMAGE',
      })
      .expect(400);
  });

  it('WEBSOCKET authz: unrelated join denied; closed send denied', async () => {
    const driver = await publishableDriver('WsHardDriver');
    const passenger = await createUser('WsHardPassenger');
    const stranger = await createUser('WsHardStranger');
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    const booking = await bookPayLater(passenger.accessToken, ride.id);
    const conversationId = await conversationIdForBooking(
      passenger.accessToken,
      booking.id,
    );

    const strangerSocket = await connectChat(stranger.accessToken);
    const denied = await emitAck<{ ok: boolean }>(
      strangerSocket,
      CHAT_SOCKET_EVENTS.JOIN,
      { conversationId },
    );
    expect(denied.ok).toBe(false);

    const sendDenied = await emitAck<{ ok: boolean }>(
      strangerSocket,
      CHAT_SOCKET_EVENTS.SEND,
      {
        conversationId,
        clientMessageId: randomUUID(),
        message: 'spoof',
        senderId: passenger.user.id,
      },
    );
    expect(sendDenied.ok).toBe(false);
    strangerSocket.close();

    await dataSource.getRepository(ChatConversation).update(
      { id: conversationId },
      {
        status: ChatConversationStatus.CLOSED,
        closedAt: new Date(),
      },
    );

    const passengerSocket = await connectChat(passenger.accessToken);
    await emitAck(passengerSocket, CHAT_SOCKET_EVENTS.JOIN, {
      conversationId,
    });
    const closedSend = await emitAck<{ ok: boolean }>(
      passengerSocket,
      CHAT_SOCKET_EVENTS.SEND,
      {
        conversationId,
        clientMessageId: randomUUID(),
        message: 'closed',
      },
    );
    expect(closedSend.ok).toBe(false);

    const err = await new Promise<{ code: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no error event')), 3000);
      passengerSocket.once(CHAT_SERVER_EVENTS.ERROR, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      passengerSocket.emit(CHAT_SOCKET_EVENTS.SEND, {
        conversationId,
        clientMessageId: randomUUID(),
        message: 'closed again',
      });
    });
    expect(err.code).toBe('CHAT_CLOSED');
    passengerSocket.close();
  });

  it('passenger cancel closes only that conversation', async () => {
    const driver = await publishableDriver('CancelDriver');
    const pA = await createUser('CancelA');
    const pB = await createUser('CancelB');
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
      { totalSeats: 3 },
    );
    const bA = await bookPayLater(pA.accessToken, ride.id);
    const bB = await bookPayLater(pB.accessToken, ride.id);
    const cA = await conversationIdForBooking(pA.accessToken, bA.id);
    const cB = await conversationIdForBooking(pB.accessToken, bB.id);

    await request(app.getHttpServer())
      .post(`/chat/conversations/${cA}/messages`)
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'keep me' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/bookings/${bA.id}/cancel`)
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .expect(200);

    const a = await request(app.getHttpServer())
      .get(`/chat/conversations/${cA}`)
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .expect(200);
    expect(a.body.status).toBe(ChatConversationStatus.CLOSED);
    expect(a.body.closedAt).toBeTruthy();

    const hist = await request(app.getHttpServer())
      .get(`/chat/conversations/${cA}/messages`)
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .expect(200);
    expect(hist.body.items[0].message).toBe('keep me');

    await request(app.getHttpServer())
      .post(`/chat/conversations/${cA}/messages`)
      .set('Authorization', `Bearer ${pA.accessToken}`)
      .send({ clientMessageId: randomUUID(), message: 'blocked' })
      .expect(409);

    const b = await request(app.getHttpServer())
      .get(`/chat/conversations/${cB}`)
      .set('Authorization', `Bearer ${pB.accessToken}`)
      .expect(200);
    expect(b.body.status).toBe(ChatConversationStatus.OPEN);
  });
});
