import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { deleteChatForBookingIds } from '../chat/test/chat-test.helpers';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
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
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletService } from '../wallet/wallet.service';
import { BookingsModule } from './bookings.module';
import { Booking } from './entities/booking.entity';
import {
  BookingCancellationReason,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from './enums/booking.enums';

describe('Commute cancellation lifecycle (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
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
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (!ctx) {
        continue;
      }

      const passengerBookings = await dataSource.getRepository(Booking).find({
        where: { passengerId: ctx.userId },
        select: { id: true },
      });
      if (passengerBookings.length > 0) {
        await deleteChatForBookingIds(
          dataSource,
          passengerBookings.map((booking) => booking.id),
        );
        await dataSource.getRepository(WalletTransaction).delete({
          referenceId: In(passengerBookings.map((booking) => booking.id)),
        });
        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
      }

      const driverRides = await dataSource.getRepository(Ride).find({
        where: { driverId: ctx.userId },
        select: { id: true },
      });
      if (driverRides.length > 0) {
        const rideIds = driverRides.map((ride) => ride.id);
        const rideBookings = await dataSource.getRepository(Booking).find({
          where: { rideId: In(rideIds) },
          select: { id: true },
        });
        if (rideBookings.length > 0) {
          await deleteChatForBookingIds(
            dataSource,
            rideBookings.map((booking) => booking.id),
          );
          await dataSource.getRepository(WalletTransaction).delete({
            referenceId: In(rideBookings.map((booking) => booking.id)),
          });
          await dataSource.getRepository(Booking).delete({
            rideId: In(rideIds),
          });
        }
        await dataSource.getRepository(Ride).delete({ id: In(rideIds) });
      }

      await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
      await dataSource.getRepository(UserVerification).delete({
        userId: ctx.userId,
      });
      await dataSource.getRepository(UserProfile).delete({
        userId: ctx.userId,
      });
      await dataSource.getRepository(WalletTransaction).delete({
        walletId: ctx.walletId,
      });
      await cleanupTestWallet(dataSource, ctx);
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  async function createAuthenticatedUser() {
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
        firstName: 'Commute',
        lastName: 'User',
        displayName: 'Commute User',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/user.jpg',
      }),
    );

    return { login, wallet, balance };
  }

  async function markVerified(userId: string, type: VerificationType) {
    await markVerificationVerified(
      verificationService,
      dataSource,
      userId,
      type,
    );
  }

  async function publishCommuteDriver(totalSeats = 3, pricePerSeat = 100) {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Maruti',
      model: 'Swift',
      variant: 'ZX',
      registrationNumber: `DL01${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2023,
      color: 'Blue',
      seatingCapacity: 5,
    });
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);

    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 10000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('commute-driver-fund'),
    });

    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: RideType.COMMUTE,
        vehicleId: vehicle.id,
        source: 'Gurgaon Cyber City',
        destination: 'Noida Sector 62',
        departureDate: '2026-09-01',
        departureTime: '08:30',
        totalSeats,
        pricePerSeat,
        notes: 'Office commute',
      })
      .expect(201);

    return { login, wallet, ride: rideResponse.body };
  }

  async function fundedPassenger(creditAmount: bigint) {
    const { login, wallet, balance } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);

    if (creditAmount > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: creditAmount,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('commute-passenger-fund'),
      });
    }

    return { login, wallet, balance };
  }

  async function createPassengers(count: number, creditAmount: bigint) {
    const passengers = [];
    for (let i = 0; i < count; i += 1) {
      passengers.push(await fundedPassenger(creditAmount));
    }
    return passengers;
  }

  async function createCommuteBooking(
    accessToken: string,
    rideId: string,
    seats: number,
    idempotencyKey = uniqueIdempotencyKey('commute-book'),
  ) {
    return request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        rideId,
        seats,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
  }

  async function acceptBooking(driverToken: string, bookingId: string) {
    return request(app.getHttpServer())
      .post(`/bookings/${bookingId}/accept`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);
  }

  it('passenger cancels CONFIRMED booking → restores seats + full refund', async () => {
    const { login: driver, ride } = await publishCommuteDriver(3, 100);
    const { login: passenger, wallet } = await fundedPassenger(5000n);
    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      2,
    );

    await acceptBooking(driver.accessToken, booking.body.id);

    const cancelled = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);

    expect(cancelled.body).toMatchObject({
      status: BookingStatus.CANCELLED,
      paymentStatus: BookingPaymentStatus.REFUNDED,
      seatsRestored: 2,
      fareRefunded: '220',
      alreadyApplied: false,
    });

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(3);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balance.purchasedAvailable).toBe('5000');
  });

  it('passenger cancellation is idempotent', async () => {
    const { login: driver, ride } = await publishCommuteDriver(3, 100);
    const { login: passenger } = await fundedPassenger(2000n);
    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      1,
    );

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);

    const retry = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);

    expect(retry.body.alreadyApplied).toBe(true);

    const refundCount = await dataSource.getRepository(WalletTransaction).count({
      where: { idempotencyKey: `commute:rider-cancel:${booking.body.id}` },
    });
    expect(refundCount).toBe(1);
  });

  it('accepting final seat auto-cancels remaining pending requests with refund', async () => {
    const { login: driver, ride } = await publishCommuteDriver(3, 100);
    const passengers = await createPassengers(5, 5000n);

    const bookings = [];
    for (const passenger of passengers) {
      bookings.push(
        await createCommuteBooking(passenger.login.accessToken, ride.id, 1),
      );
    }

    await acceptBooking(driver.accessToken, bookings[0].body.id);
    await acceptBooking(driver.accessToken, bookings[1].body.id);

    const thirdAccept = await acceptBooking(
      driver.accessToken,
      bookings[2].body.id,
    );

    expect(thirdAccept.body.autoCancelledBookings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bookingId: bookings[3].body.id,
          status: BookingStatus.CANCELLED,
          cancellationReason: BookingCancellationReason.COMMUTE_RIDE_FULL,
          refunded: true,
        }),
        expect.objectContaining({
          bookingId: bookings[4].body.id,
          status: BookingStatus.CANCELLED,
          cancellationReason: BookingCancellationReason.COMMUTE_RIDE_FULL,
          refunded: true,
        }),
      ]),
    );

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(0);

    for (let i = 0; i < 3; i += 1) {
      const stored = await dataSource.getRepository(Booking).findOneByOrFail({
        id: bookings[i].body.id,
      });
      expect(stored.status).toBe(BookingStatus.CONFIRMED);
    }

    for (let i = 3; i < 5; i += 1) {
      const stored = await dataSource.getRepository(Booking).findOneByOrFail({
        id: bookings[i].body.id,
      });
      expect(stored).toMatchObject({
        status: BookingStatus.CANCELLED,
        cancellationReason: BookingCancellationReason.COMMUTE_RIDE_FULL,
        paymentStatus: BookingPaymentStatus.REFUNDED,
      });

      const refundCount = await dataSource
        .getRepository(WalletTransaction)
        .count({
          where: {
            idempotencyKey: `commute:ride-full:${bookings[i].body.id}`,
          },
        });
      expect(refundCount).toBe(1);
    }

    const pendingList = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .query({ status: BookingStatus.PENDING })
      .expect(200);
    expect(pendingList.body.items).toHaveLength(0);
  });

  it('does not auto-cancel pending requests until ride becomes full', async () => {
    const { login: driver, ride } = await publishCommuteDriver(5, 100);
    const passengers = await createPassengers(3, 5000n);

    const bookings = [];
    for (const passenger of passengers) {
      bookings.push(
        await createCommuteBooking(passenger.login.accessToken, ride.id, 2),
      );
    }

    const firstAccept = await acceptBooking(
      driver.accessToken,
      bookings[0].body.id,
    );
    expect(firstAccept.body.autoCancelledBookings).toBeUndefined();

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(3);

    for (const booking of bookings.slice(1)) {
      const stored = await dataSource.getRepository(Booking).findOneByOrFail({
        id: booking.body.id,
      });
      expect(stored.status).toBe(BookingStatus.PENDING);
    }
  });

  it('multi-seat accept fills ride and auto-cancels remaining pending request', async () => {
    const { login: driver, ride } = await publishCommuteDriver(5, 100);
    const [a, b, c, d] = await createPassengers(4, 5000n);

    const bookingA = await createCommuteBooking(a.login.accessToken, ride.id, 2);
    const bookingB = await createCommuteBooking(b.login.accessToken, ride.id, 2);
    const bookingC = await createCommuteBooking(c.login.accessToken, ride.id, 1);
    const bookingD = await createCommuteBooking(d.login.accessToken, ride.id, 1);

    await acceptBooking(driver.accessToken, bookingA.body.id);
    await acceptBooking(driver.accessToken, bookingB.body.id);

    const thirdAccept = await acceptBooking(
      driver.accessToken,
      bookingC.body.id,
    );

    expect(thirdAccept.body.autoCancelledBookings).toEqual([
      expect.objectContaining({ bookingId: bookingD.body.id, refunded: true }),
    ]);

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(0);
  });

  it('confirmed passenger cancellation restores seat without auto-cancelling other pending', async () => {
    const { login: driver, ride } = await publishCommuteDriver(3, 100);
    const [a, b, c, d] = await createPassengers(4, 5000n);

    const bookingA = await createCommuteBooking(a.login.accessToken, ride.id, 1);
    const bookingB = await createCommuteBooking(b.login.accessToken, ride.id, 1);
    const bookingC = await createCommuteBooking(c.login.accessToken, ride.id, 1);
    const bookingD = await createCommuteBooking(d.login.accessToken, ride.id, 1);

    await acceptBooking(driver.accessToken, bookingA.body.id);
    await acceptBooking(driver.accessToken, bookingB.body.id);

    await request(app.getHttpServer())
      .post(`/bookings/${bookingA.body.id}/cancel`)
      .set('Authorization', `Bearer ${a.login.accessToken}`)
      .expect(200);

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(2);

    const storedC = await dataSource.getRepository(Booking).findOneByOrFail({
      id: bookingC.body.id,
    });
    const storedD = await dataSource.getRepository(Booking).findOneByOrFail({
      id: bookingD.body.id,
    });
    expect(storedC.status).toBe(BookingStatus.PENDING);
    expect(storedD.status).toBe(BookingStatus.PENDING);

    const pending = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .query({ status: BookingStatus.PENDING })
      .expect(200);
    expect(pending.body.items).toHaveLength(2);
  });

  it('driver cancels commute ride and refunds all paid bookings', async () => {
    const { login: driver, ride } = await publishCommuteDriver(3, 100);
    const [a, b, c, d] = await createPassengers(4, 5000n);

    const bookingA = await createCommuteBooking(a.login.accessToken, ride.id, 1);
    const bookingB = await createCommuteBooking(b.login.accessToken, ride.id, 1);
    const bookingC = await createCommuteBooking(c.login.accessToken, ride.id, 1);
    const bookingD = await createCommuteBooking(d.login.accessToken, ride.id, 1);

    await acceptBooking(driver.accessToken, bookingA.body.id);
    await acceptBooking(driver.accessToken, bookingB.body.id);

    const cancelledRide = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(cancelledRide.body).toMatchObject({
      status: RideStatus.CANCELLED,
      cancelledBookingCount: 4,
      fareRefundedTotal: '440',
      alreadyApplied: false,
    });

    for (const booking of [bookingA, bookingB, bookingC, bookingD]) {
      const stored = await dataSource.getRepository(Booking).findOneByOrFail({
        id: booking.body.id,
      });
      expect(stored).toMatchObject({
        status: BookingStatus.CANCELLED,
        cancellationReason: BookingCancellationReason.RIDE_CANCELLED,
        paymentStatus: BookingPaymentStatus.REFUNDED,
      });
    }

    const search = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .query({
        source: 'Gurgaon',
        destination: 'Noida',
        date: '2026-09-01',
        rideType: RideType.COMMUTE,
      })
      .expect(200);
    expect(search.body.items.find((item: { id: string }) => item.id === ride.id)).toBeUndefined();
  });

  it('driver ride cancellation is idempotent', async () => {
    const { login: driver, ride } = await publishCommuteDriver(3, 100);
    const { login: passenger } = await fundedPassenger(2000n);
    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      1,
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const retry = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(retry.body.alreadyApplied).toBe(true);

    const refundCount = await dataSource.getRepository(WalletTransaction).count({
      where: { idempotencyKey: `commute:ride-cancel:${booking.body.id}` },
    });
    expect(refundCount).toBe(1);
  });

  it('failed accept does not auto-cancel remaining pending requests', async () => {
    const { login: driver, ride } = await publishCommuteDriver(3, 100);
    const [a, b] = await createPassengers(2, 5000n);

    const bookingA = await createCommuteBooking(a.login.accessToken, ride.id, 2);
    const bookingB = await createCommuteBooking(b.login.accessToken, ride.id, 2);

    await acceptBooking(driver.accessToken, bookingA.body.id);

    await request(app.getHttpServer())
      .post(`/bookings/${bookingB.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);

    const storedB = await dataSource.getRepository(Booking).findOneByOrFail({
      id: bookingB.body.id,
    });
    expect(storedB.status).toBe(BookingStatus.PENDING);

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(1);
    expect(storedRide.availableSeats).toBeGreaterThanOrEqual(0);
  });
});
