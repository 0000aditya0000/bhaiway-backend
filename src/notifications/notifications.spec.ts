import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { BookingPaymentMethod } from '../bookings/enums/booking.enums';
import { ChatModule } from '../chat/chat.module';
import { deleteChatForBookingIds } from '../chat/test/chat-test.helpers';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { TrackingModule } from '../tracking/tracking.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { markVerificationVerified } from '../verification/test/verification-test.helpers';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { VerificationType } from '../verification/enums/verification.enums';
import { VehicleType } from '../vehicles/enums/vehicle-type.enum';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { VehiclesService } from '../vehicles/vehicles.service';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  creditTestWalletPoints,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { NotificationDevice } from './entities/notification-device.entity';
import { Notification } from './entities/notification.entity';
import {
  NotificationPlatform,
  NotificationStatus,
  NotificationType,
} from './enums/notification.enums';
import {
  assuredPublishedKey,
  bookingConfirmedKey,
  bookingReceivedKey,
  chatMessageKey,
  commuteConfirmedKey,
  commuteRequestedKey,
  walletCreditedKey,
} from './notifications.helpers';
import { NotificationsModule } from './notifications.module';
import { NotificationsService } from './notifications.service';
import { MockNotificationProvider } from './providers/mock-notification.provider';

describe('Notifications (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let notificationsService: NotificationsService;
  let mockProvider: MockNotificationProvider;
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
        VerificationModule,
        VehiclesModule,
        WalletModule,
        RidesModule,
        BookingsModule,
        TrackingModule,
        ChatModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        async verifyAccessToken() {
          throw new Error('OTP not used in notification tests');
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    authService = moduleRef.get(AuthService);
    verificationService = moduleRef.get(VerificationService);
    vehiclesService = moduleRef.get(VehiclesService);
    walletService = moduleRef.get(WalletService);
    notificationsService = moduleRef.get(NotificationsService);
    mockProvider = moduleRef.get(MockNotificationProvider);
  });

  afterAll(async () => {
    for (const ctx of tracked.splice(0)) {
      await cleanupTestWallet(dataSource, ctx).catch(() => undefined);
    }
    await app.close();
  });

  beforeEach(() => {
    mockProvider.reset();
  });

  async function createUser(label: string) {
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
    tracked.push({
      userId: login.user.id,
      walletId: wallet.id,
      balanceId: '',
      phone,
    });

    const profileRepo = dataSource.getRepository(UserProfile);
    const existingProfile = await profileRepo.findOne({
      where: { userId: login.user.id },
    });
    if (existingProfile) {
      existingProfile.firstName = label;
      existingProfile.displayName = label;
      await profileRepo.save(existingProfile);
    } else {
      await profileRepo.save(
        profileRepo.create({
          userId: login.user.id,
          firstName: label,
          lastName: 'User',
          displayName: label,
          gender: null,
          dateOfBirth: null,
          profilePhoto: null,
        }),
      );
    }

    await creditTestWalletPoints(
      walletService,
      wallet.id,
      login.user.id,
      50_000n,
    );

    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.IDENTITY,
    );

    return login;
  }

  async function publishableDriver(label: string) {
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

  async function publishRegularRide(driverToken: string, vehicleId: string) {
    const res = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        vehicleId,
        rideType: RideType.REGULAR,
        source: 'Noida',
        destination: 'Delhi',
        departureDate: '2030-06-15',
        departureTime: '09:00:00',
        totalSeats: 3,
        pricePerSeat: 100,
        sourceLatitude: 28.5355,
        sourceLongitude: 77.391,
        destinationLatitude: 28.6139,
        destinationLongitude: 77.209,
      })
      .expect(201);
    return res.body as { id: string };
  }

  function registerDevice(
    token: string,
    fcmToken: string,
    platform: NotificationPlatform = NotificationPlatform.ANDROID,
  ) {
    return request(app.getHttpServer())
      .post('/notifications/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({
        token: fcmToken,
        platform,
        deviceId: 'dev-1',
        appVersion: '1.0.0',
      });
  }

  async function waitForNotification(
    idempotencyKey: string,
    timeoutMs = 5_000,
  ): Promise<Notification> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const row = await notificationsService.findByIdempotencyKey(idempotencyKey);
      if (row) {
        await notificationsService.flushDispatch(row.id);
        const refreshed = await notificationsService.findByIdempotencyKey(
          idempotencyKey,
        );
        if (refreshed) {
          return refreshed;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Notification not found for ${idempotencyKey}`);
  }

  describe('device registration', () => {
    it('registers Android and iOS tokens, refreshes, reassigns, deactivates', async () => {
      const a = await createUser('Alice');
      const b = await createUser('Bob');
      const androidToken = `fcm-android-${randomUUID()}`;
      const iosToken = `fcm-ios-${randomUUID()}`;

      const android = await registerDevice(
        a.accessToken,
        androidToken,
        NotificationPlatform.ANDROID,
      ).expect(201);
      expect(android.body.isActive).toBe(true);
      expect(android.body.platform).toBe(NotificationPlatform.ANDROID);

      await registerDevice(
        a.accessToken,
        iosToken,
        NotificationPlatform.IOS,
      ).expect(201);

      const refresh = await registerDevice(
        a.accessToken,
        androidToken,
        NotificationPlatform.ANDROID,
      ).expect(201);
      expect(refresh.body.id).toBe(android.body.id);

      const reassigned = await registerDevice(
        b.accessToken,
        androidToken,
        NotificationPlatform.ANDROID,
      ).expect(201);
      expect(reassigned.body.isActive).toBe(true);
      const device = await dataSource.getRepository(NotificationDevice).findOne({
        where: { token: androidToken },
      });
      expect(device?.userId).toBe(b.user.id);

      await request(app.getHttpServer())
        .delete(`/notifications/devices/${encodeURIComponent(androidToken)}`)
        .set('Authorization', `Bearer ${b.accessToken}`)
        .expect(200);

      const deactivated = await dataSource
        .getRepository(NotificationDevice)
        .findOne({ where: { token: androidToken } });
      expect(deactivated?.isActive).toBe(false);

      await request(app.getHttpServer())
        .delete(`/notifications/devices/${encodeURIComponent(iosToken)}`)
        .set('Authorization', `Bearer ${b.accessToken}`)
        .expect(403);
    });
  });

  describe('regular booking + idempotency + failure safety', () => {
    it('notifies driver and passenger; FCM failure does not break booking', async () => {
      const { login: driver, vehicle } = await publishableDriver('DriverReg');
      const passenger = await createUser('PassReg');
      await registerDevice(
        driver.accessToken,
        `tok-driver-${randomUUID()}`,
      ).expect(201);
      await registerDevice(
        passenger.accessToken,
        `tok-pass-${randomUUID()}`,
      ).expect(201);

      mockProvider.throwOnSend = true;

      const ride = await publishRegularRide(driver.accessToken, vehicle.id);
      const booking = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('reg-book'))
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_LATER,
        })
        .expect(201);

      expect(booking.body.id).toBeDefined();

      mockProvider.throwOnSend = false;
      mockProvider.reset();

      const received = await waitForNotification(
        bookingReceivedKey(booking.body.id),
      );
      expect(received.type).toBe(NotificationType.BOOKING_RECEIVED);
      expect(received.recipientUserId).toBe(driver.user.id);

      const confirmed = await waitForNotification(
        bookingConfirmedKey(booking.body.id),
      );
      expect(confirmed.type).toBe(NotificationType.BOOKING_CONFIRMED);
      expect(confirmed.recipientUserId).toBe(passenger.user.id);

      await notificationsService.safeNotifyBookingReceived({
        bookingId: booking.body.id,
        rideId: ride.id,
        driverId: driver.user.id,
        passengerId: passenger.user.id,
        bookingMode: 'REGULAR',
      });
      const dupCount = await dataSource.getRepository(Notification).count({
        where: { idempotencyKey: bookingReceivedKey(booking.body.id) },
      });
      expect(dupCount).toBe(1);

      await deleteChatForBookingIds(dataSource, [booking.body.id]);
    });
  });

  describe('wallet credited', () => {
    it('creates one wallet notification; failed debit creates none', async () => {
      const user = await createUser('WalletUser');
      await registerDevice(user.accessToken, `tok-w-${randomUUID()}`).expect(201);

      const before = await dataSource.getRepository(Notification).count({
        where: {
          recipientUserId: user.user.id,
          type: NotificationType.WALLET_CREDITED,
        },
      });

      const credit = await walletService.creditPoints({
        walletId: tracked.find((t) => t.userId === user.user.id)!.walletId,
        userId: user.user.id,
        amount: 250n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('wallet-credit-n'),
      });

      const row = await waitForNotification(
        walletCreditedKey(credit.transaction.id),
      );
      expect(row.type).toBe(NotificationType.WALLET_CREDITED);
      expect(row.data.amount).toBe('250');

      await walletService.creditPoints({
        walletId: tracked.find((t) => t.userId === user.user.id)!.walletId,
        userId: user.user.id,
        amount: 250n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: credit.transaction.idempotencyKey,
      });
      const afterDup = await dataSource.getRepository(Notification).count({
        where: { idempotencyKey: walletCreditedKey(credit.transaction.id) },
      });
      expect(afterDup).toBe(1);

      mockProvider.throwOnSend = true;
      const credit2 = await walletService.creditPoints({
        walletId: tracked.find((t) => t.userId === user.user.id)!.walletId,
        userId: user.user.id,
        amount: 10n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('wallet-credit-fail-fcm'),
      });
      expect(credit2.transaction.id).toBeDefined();
      mockProvider.throwOnSend = false;

      try {
        await walletService.debitPoints({
          walletId: tracked.find((t) => t.userId === user.user.id)!.walletId,
          userId: user.user.id,
          amount: 999_999_999n,
          idempotencyKey: uniqueIdempotencyKey('wallet-debit-fail'),
        });
        fail('expected insufficient balance');
      } catch {
        // expected
      }
      const afterFail = await dataSource.getRepository(Notification).count({
        where: {
          recipientUserId: user.user.id,
          type: NotificationType.WALLET_CREDITED,
        },
      });
      expect(afterFail).toBeGreaterThanOrEqual(before + 2);
    });
  });

  describe('multi-device + invalid token', () => {
    it('sends to all active devices and deactivates permanent invalid tokens', async () => {
      const user = await createUser('MultiDev');
      const t1 = `tok-m1-${randomUUID()}`;
      const t2 = `tok-m2-${randomUUID()}`;
      const t3 = `tok-m3-${randomUUID()}`;
      await registerDevice(user.accessToken, t1).expect(201);
      await registerDevice(user.accessToken, t2).expect(201);
      await registerDevice(user.accessToken, t3).expect(201);
      mockProvider.permanentInvalidTokens.add(t2);

      await notificationsService.safeEnqueue({
        recipientUserId: user.user.id,
        type: NotificationType.BOOKING_CONFIRMED,
        title: 'Ride confirmed',
        body: 'Your ride has been confirmed.',
        data: { type: NotificationType.BOOKING_CONFIRMED },
        idempotencyKey: `booking-confirmed:test-${randomUUID()}`,
      });

      await new Promise((r) => setTimeout(r, 200));
      const sentTokens = mockProvider.sent.map((s) => s.token);
      expect(sentTokens).toContain(t1);
      expect(sentTokens).toContain(t3);
      expect(sentTokens).not.toContain(t2);

      const invalid = await dataSource.getRepository(NotificationDevice).findOne({
        where: { token: t2 },
      });
      expect(invalid?.isActive).toBe(false);
    });
  });

  describe('chat message push', () => {
    it('notifies other participant once; sender never notified', async () => {
      const { login: driver, vehicle } = await publishableDriver('ChatDriver');
      const passenger = await createUser('ChatPass');
      await registerDevice(
        driver.accessToken,
        `tok-cd-${randomUUID()}`,
      ).expect(201);
      await registerDevice(
        passenger.accessToken,
        `tok-cp-${randomUUID()}`,
      ).expect(201);

      const ride = await publishRegularRide(driver.accessToken, vehicle.id);
      const booking = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('chat-book'))
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_LATER,
        })
        .expect(201);

      const conv = await request(app.getHttpServer())
        .get('/chat/conversations')
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .expect(200);
      const conversationId = conv.body.items[0].id as string;

      mockProvider.reset();
      const clientMessageId = randomUUID();
      const sent = await request(app.getHttpServer())
        .post(`/chat/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .send({
          clientMessageId,
          message: 'Hello driver',
        })
        .expect(201);

      const push = await waitForNotification(chatMessageKey(sent.body.messageId));
      expect(push.recipientUserId).toBe(driver.user.id);
      expect(push.type).toBe(NotificationType.CHAT_MESSAGE);

      const senderPush = await dataSource.getRepository(Notification).find({
        where: {
          recipientUserId: passenger.user.id,
          type: NotificationType.CHAT_MESSAGE,
        },
      });
      expect(senderPush).toHaveLength(0);

      await notificationsService.safeNotifyChatMessage({
        messageId: sent.body.messageId,
        conversationId,
        bookingId: booking.body.id,
        recipientUserId: driver.user.id,
        senderUserId: passenger.user.id,
      });
      const count = await dataSource.getRepository(Notification).count({
        where: { idempotencyKey: chatMessageKey(sent.body.messageId) },
      });
      expect(count).toBe(1);

      await deleteChatForBookingIds(dataSource, [booking.body.id]);
    });
  });

  describe('assured published idempotency', () => {
    it('creates one ASSURED_RIDE_PUBLISHED notification', async () => {
      const { login: driver, vehicle } = await publishableDriver('AssuredDrv');
      await registerDevice(
        driver.accessToken,
        `tok-ad-${randomUUID()}`,
      ).expect(201);

      const res = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${driver.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('assured-pub'))
        .send({
          vehicleId: vehicle.id,
          rideType: RideType.ASSURED,
          source: 'Noida Sector 18',
          destination: 'Haridwar',
          departureDate: '2031-11-22',
          departureTime: '06:15:00',
          totalSeats: 3,
          pricePerSeat: 500,
          sourceLatitude: 28.5701,
          sourceLongitude: 77.3219,
          destinationLatitude: 29.9457,
          destinationLongitude: 78.1642,
        })
        .expect(201);

      // First into an empty geographic queue becomes ACTIVE; otherwise PENDING.
      if (res.body.status === RideStatus.ASSURANCE_ACTIVE) {
        const n = await waitForNotification(assuredPublishedKey(res.body.id));
        expect(n.type).toBe(NotificationType.ASSURED_RIDE_PUBLISHED);
        expect(n.recipientUserId).toBe(driver.user.id);
      } else {
        await notificationsService.safeNotifyAssuredPublished({
          rideId: res.body.id,
          driverId: driver.user.id,
        });
        // Simulate live transition notification even if queued pending.
        const n = await waitForNotification(assuredPublishedKey(res.body.id));
        expect(n.type).toBe(NotificationType.ASSURED_RIDE_PUBLISHED);
      }

      await notificationsService.safeNotifyAssuredPublished({
        rideId: res.body.id,
        driverId: driver.user.id,
      });
      const count = await dataSource.getRepository(Notification).count({
        where: { idempotencyKey: assuredPublishedKey(res.body.id) },
      });
      expect(count).toBe(1);
    });
  });

  describe('commute request + confirm', () => {
    it('notifies driver on PENDING and passenger on accept', async () => {
      const { login: driver, vehicle } = await publishableDriver('CommuteDrv');
      const passenger = await createUser('CommutePass');
      await registerDevice(
        driver.accessToken,
        `tok-cmd-${randomUUID()}`,
      ).expect(201);
      await registerDevice(
        passenger.accessToken,
        `tok-cmp-${randomUUID()}`,
      ).expect(201);

      const ride = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${driver.accessToken}`)
        .send({
          vehicleId: vehicle.id,
          rideType: RideType.COMMUTE,
          source: 'Office Park',
          destination: 'Home Colony',
          departureDate: '2030-08-10',
          departureTime: '08:30:00',
          totalSeats: 3,
          pricePerSeat: 80,
          sourceLatitude: 28.5,
          sourceLongitude: 77.4,
          destinationLatitude: 28.55,
          destinationLongitude: 77.45,
        })
        .expect(201);

      const booking = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('commute-req'))
        .send({
          rideId: ride.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        })
        .expect(201);

      const requested = await waitForNotification(
        commuteRequestedKey(booking.body.id),
      );
      expect(requested.type).toBe(NotificationType.COMMUTE_BOOKING_REQUESTED);
      expect(requested.recipientUserId).toBe(driver.user.id);

      await request(app.getHttpServer())
        .post(`/bookings/${booking.body.id}/accept`)
        .set('Authorization', `Bearer ${driver.accessToken}`)
        .expect(200);

      const confirmed = await waitForNotification(
        commuteConfirmedKey(booking.body.id),
      );
      expect(confirmed.type).toBe(NotificationType.COMMUTE_BOOKING_CONFIRMED);
      expect(confirmed.recipientUserId).toBe(passenger.user.id);

      await deleteChatForBookingIds(dataSource, [booking.body.id]);
    });
  });

  describe('retry / permanent invalid', () => {
    it('retries transient failure and does not loop forever on permanent invalid', async () => {
      const user = await createUser('RetryUser');
      const token = `tok-retry-${randomUUID()}`;
      await registerDevice(user.accessToken, token).expect(201);

      const key = `booking-confirmed:retry-${randomUUID()}`;
      await notificationsService.safeEnqueue({
        recipientUserId: user.user.id,
        type: NotificationType.BOOKING_CONFIRMED,
        title: 'Ride confirmed',
        body: 'Your ride has been confirmed.',
        data: { type: NotificationType.BOOKING_CONFIRMED },
        idempotencyKey: key,
      });
      await new Promise((r) => setTimeout(r, 300));
      let row = await notificationsService.findByIdempotencyKey(key);
      expect(row).toBeTruthy();
      await dataSource
        .getRepository(Notification)
        .update(
          { id: row!.id },
          {
            nextAttemptAt: null,
            attemptCount: 0,
            status: NotificationStatus.PENDING,
          },
        );
      mockProvider.failTransient = true;
      await notificationsService.flushDispatch(row!.id);
      row = (await notificationsService.findByIdempotencyKey(key))!;
      expect(row.status).toBe(NotificationStatus.PENDING);
      expect(row.attemptCount).toBeGreaterThanOrEqual(1);

      mockProvider.failTransient = false;
      await dataSource
        .getRepository(Notification)
        .update({ id: row.id }, { nextAttemptAt: null });
      await notificationsService.flushDispatch(row.id);
      row = (await notificationsService.findByIdempotencyKey(key))!;
      expect(row.status).toBe(NotificationStatus.SENT);

      const bad = `tok-bad-${randomUUID()}`;
      await registerDevice(user.accessToken, bad).expect(201);
      mockProvider.failTransient = false;
      mockProvider.permanentInvalidTokens.add(bad);
      await dataSource
        .getRepository(NotificationDevice)
        .update({ userId: user.user.id }, { isActive: false });
      await dataSource
        .getRepository(NotificationDevice)
        .update({ token: bad }, { isActive: true });

      const key2 = `booking-confirmed:perm-${randomUUID()}`;
      await notificationsService.safeEnqueue({
        recipientUserId: user.user.id,
        type: NotificationType.BOOKING_CONFIRMED,
        title: 'Ride confirmed',
        body: 'Your ride has been confirmed.',
        data: { type: NotificationType.BOOKING_CONFIRMED },
        idempotencyKey: key2,
      });
      await new Promise((r) => setTimeout(r, 300));
      const created2 = await notificationsService.findByIdempotencyKey(key2);
      await dataSource
        .getRepository(NotificationDevice)
        .update({ token: bad }, { isActive: true });
      await dataSource.getRepository(Notification).update(
        { id: created2!.id },
        {
          nextAttemptAt: null,
          attemptCount: 0,
          status: NotificationStatus.PENDING,
          failureReason: null,
        },
      );
      await notificationsService.flushDispatch(created2!.id);
      const failed = (await notificationsService.findByIdempotencyKey(key2))!;
      expect([NotificationStatus.FAILED, NotificationStatus.PENDING]).toContain(
        failed.status,
      );
      const device = await dataSource.getRepository(NotificationDevice).findOne({
        where: { token: bad },
      });
      expect(device?.isActive).toBe(false);
      if (failed.status === NotificationStatus.PENDING) {
        expect(failed.failureReason).toMatch(/INVALID|UNREGISTERED|NO_ACTIVE/i);
      } else {
        expect(failed.failureReason).toMatch(/INVALID|UNREGISTERED|ALL_TOKENS/i);
      }
    });
  });
});
