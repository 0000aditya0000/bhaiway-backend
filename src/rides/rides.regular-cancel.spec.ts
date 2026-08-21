import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import {
  VerificationType,
} from '../verification/enums/verification.enums';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { markVerificationVerified } from '../verification/test/verification-test.helpers';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehicleType } from '../vehicles/enums/vehicle-type.enum';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { VehiclesService } from '../vehicles/vehicles.service';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { Ride } from './entities/ride.entity';
import {
  RideCancellationReason,
  RideStatus,
  RideType,
} from './enums/ride.enums';
import { RidesModule } from './rides.module';
import { RidesService } from './rides.service';

describe('Regular ride driver cancellation (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let ridesService: RidesService;
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
    ridesService = moduleRef.get(RidesService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        for (const ride of rides) {
          await dataSource.getRepository(Booking).delete({ rideId: ride.id });
        }
        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
        await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
        await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
        await dataSource.getRepository(UserProfile).delete({
          userId: ctx.userId,
        });
        await dataSource.getRepository(UserVerification).delete({
          userId: ctx.userId,
        });
        await cleanupTestWallet(dataSource, ctx);
      }
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

    return login;
  }

  async function markVerified(userId: string, type: VerificationType) {
    await markVerificationVerified(
      verificationService,
      dataSource,
      userId,
      type,
    );
  }

  async function publishableDriver(totalSeats = 3) {
    const login = await createAuthenticatedUser();
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
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);

    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Noida Sector 62',
        destination: 'Connaught Place',
        departureDate: '2026-08-20',
        departureTime: '09:00',
        totalSeats,
        pricePerSeat: 250,
      })
      .expect(201);

    return { login, vehicle, ride: rideResponse.body };
  }

  async function verifiedPassenger() {
    const login = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    return login;
  }

  it('Regular ride with no bookings cancels successfully', async () => {
    const { login, ride } = await publishableDriver();

    const response = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(response.body).toMatchObject({
      rideId: ride.id,
      status: RideStatus.CANCELLED,
      cancellationReason: RideCancellationReason.DRIVER_CANCELLED,
      cancelledBookingCount: 0,
      driverDepositForfeited: null,
      riderCompensationTotal: '0',
      platformForfeiture: '0',
      alreadyApplied: false,
    });

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);
    expect(rideRow.cancellationReason).toBe(
      RideCancellationReason.DRIVER_CANCELLED,
    );
    expect(rideRow.availableSeats).toBe(ride.availableSeats);
  });

  it('Regular ride with PAY_LATER passenger cancels ride and booking', async () => {
    const { login: driver, ride } = await publishableDriver(3);
    const passenger = await verifiedPassenger();

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    const seatsBefore = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: ride.id })
    ).availableSeats;

    const response = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(response.body.cancelledBookingCount).toBe(1);
    expect(response.body.driverDepositForfeited).toBeNull();

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);
    expect(rideRow.availableSeats).toBe(seatsBefore);

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(bookingRow.status).toBe(BookingStatus.CANCELLED);
    expect(bookingRow.cancellationReason).toBe(
      BookingCancellationReason.RIDE_CANCELLED,
    );
  });

  it('Regular ride with multiple passengers cancels all active bookings', async () => {
    const { login: driver, ride } = await publishableDriver(4);
    const p1 = await verifiedPassenger();
    const p2 = await verifiedPassenger();

    const b1 = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${p1.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    const b2 = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${p2.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(response.body.cancelledBookingCount).toBe(2);

    for (const id of [b1.body.id, b2.body.id]) {
      const row = await dataSource
        .getRepository(Booking)
        .findOneByOrFail({ id });
      expect(row.status).toBe(BookingStatus.CANCELLED);
      expect(row.cancellationReason).toBe(
        BookingCancellationReason.RIDE_CANCELLED,
      );
    }
  });

  it('does not reprocess already cancelled bookings', async () => {
    const { login: driver, ride } = await publishableDriver(3);
    const passenger = await verifiedPassenger();

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await dataSource.getRepository(Booking).update(
      { id: booking.body.id },
      {
        status: BookingStatus.CANCELLED,
        cancellationReason: BookingCancellationReason.RIDER_CANCELLED,
        cancelledAt: new Date(),
      },
    );

    const response = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(response.body.cancelledBookingCount).toBe(0);

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(bookingRow.cancellationReason).toBe(
      BookingCancellationReason.RIDER_CANCELLED,
    );
  });

  it('non-owner cannot cancel Regular ride', async () => {
    const { ride } = await publishableDriver();
    const other = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(404);
  });

  it('Regular cancellation does not create Assured wallet transactions', async () => {
    const { login: driver, ride } = await publishableDriver();
    const passenger = await verifiedPassenger();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    const driverWallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId: driver.user.id });
    const txBefore = await dataSource.getRepository(WalletTransaction).count({
      where: { walletId: driverWallet.id },
    });

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const txAfter = await dataSource.getRepository(WalletTransaction).count({
      where: { walletId: driverWallet.id },
    });
    expect(txAfter).toBe(txBefore);
  });

  it('already cancelled Regular ride is idempotent', async () => {
    const { login, ride } = await publishableDriver();

    const first = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(first.body.alreadyApplied).toBe(false);

    const second = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(second.body).toMatchObject({
      rideId: ride.id,
      status: RideStatus.CANCELLED,
      cancellationReason: RideCancellationReason.DRIVER_CANCELLED,
      alreadyApplied: true,
      driverDepositForfeited: null,
      riderCompensationTotal: '0',
      platformForfeiture: '0',
    });
  });

  it('transactional rollback leaves ride and bookings unchanged on failure', async () => {
    const { login: driver, ride } = await publishableDriver(3);
    const passenger = await verifiedPassenger();

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    const beforeRide = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    const beforeBooking = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });

    const originalSave = Repository.prototype.save;
    const spy = jest
      .spyOn(Repository.prototype, 'save')
      .mockImplementation(async function (
        this: Repository<unknown>,
        entity: unknown,
        ...rest: unknown[]
      ) {
        const maybeRide = entity as {
          status?: RideStatus;
          cancellationReason?: RideCancellationReason | null;
        };
        if (
          maybeRide &&
          typeof maybeRide === 'object' &&
          maybeRide.status === RideStatus.CANCELLED &&
          maybeRide.cancellationReason ===
            RideCancellationReason.DRIVER_CANCELLED
        ) {
          throw new Error('forced regular cancel failure');
        }
        return originalSave.apply(this, [entity, ...rest] as never);
      });

    try {
      await expect(
        ridesService.cancelByDriver(driver.user.id, ride.id),
      ).rejects.toThrow('forced regular cancel failure');
    } finally {
      spy.mockRestore();
    }

    const afterRide = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    const afterBooking = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });

    expect(afterRide.status).toBe(beforeRide.status);
    expect(afterRide.availableSeats).toBe(beforeRide.availableSeats);
    expect(afterBooking.status).toBe(beforeBooking.status);
    expect(afterBooking.cancellationReason).toBe(
      beforeBooking.cancellationReason,
    );
  });
});
