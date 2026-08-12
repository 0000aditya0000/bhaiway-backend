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
import { Ride } from '../rides/entities/ride.entity';
import { RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { UserVerification } from '../verification/entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehicleType } from '../vehicles/enums/vehicle-type.enum';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { VehiclesService } from '../vehicles/vehicles.service';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { WalletHold } from '../wallet/entities/wallet-hold.entity';
import {
  WalletPointLot,
  WalletPointSource,
} from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { BookingsModule } from './bookings.module';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import {
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from './enums/booking.enums';

describe('Bookings payment integration', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let bookingsService: BookingsService;
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
    bookingsService = moduleRef.get(BookingsService);
    walletService = moduleRef.get(WalletService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        for (const ride of rides) {
          await dataSource.getRepository(Booking).delete({ rideId: ride.id });
        }
        await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
        await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
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

    return { login, wallet, balance };
  }

  async function markVerified(userId: string, type: VerificationType) {
    if (type === VerificationType.IDENTITY) {
      await verificationService.submitIdentityVerification(userId, {
        documentType: `${type}_SCAN`,
      });
    } else if (type === VerificationType.DRIVING_LICENSE) {
      await verificationService.submitDrivingLicenseVerification(userId, {
        documentType: `${type}_SCAN`,
      });
    } else {
      await verificationService.submitVehicleVerification(userId, {
        documentType: `${type}_SCAN`,
      });
    }

    const record = await dataSource
      .getRepository(UserVerification)
      .findOneByOrFail({
        userId,
        verificationType: type,
        isCurrent: true,
      });

    await verificationService.applyTrustedVerificationDecision(record.id, {
      status: VerificationStatus.VERIFIED,
    });
  }

  async function publishableDriver(totalSeats = 3, pricePerSeat = 200) {
    const { login, wallet } = await createAuthenticatedUser();
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
        destination: 'Connaught Place, Delhi',
        departureDate: '2026-08-20',
        departureTime: '09:00',
        totalSeats,
        pricePerSeat,
        notes: 'AC car',
      })
      .expect(201);

    return { login, wallet, ride: rideResponse.body };
  }

  async function fundedPassenger(creditAmount: bigint) {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);

    if (creditAmount > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: creditAmount,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('booking-fund'),
      });
    }

    return { login, wallet };
  }

  it('PAY_LATER books without touching wallet', async () => {
    const { ride } = await publishableDriver(3, 250);
    const { login, wallet } = await fundedPassenger(1000n);

    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    const txBefore = await dataSource.getRepository(WalletTransaction).count({
      where: { walletId: wallet.id },
    });
    const holdsBefore = await dataSource.getRepository(WalletHold).count({
      where: { walletId: wallet.id },
    });

    const response = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    expect(response.body).toMatchObject({
      paymentMethod: BookingPaymentMethod.PAY_LATER,
      paymentStatus: BookingPaymentStatus.UNPAID,
      status: BookingStatus.CONFIRMED,
      totalAmount: '250',
    });

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balanceAfter.purchasedAvailable).toBe(
      balanceBefore.purchasedAvailable,
    );
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: wallet.id },
      }),
    ).toBe(txBefore);
    expect(
      await dataSource.getRepository(WalletHold).count({
        where: { walletId: wallet.id },
      }),
    ).toBe(holdsBefore);
  });

  it('PAY_NOW debits wallet, creates BOOKING_PAYMENT ledger, marks PAID', async () => {
    const { ride } = await publishableDriver(3, 200);
    const { login, wallet } = await fundedPassenger(500n);
    const key = uniqueIdempotencyKey('pay-now');

    const response = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .set('Idempotency-Key', key)
      .send({
        rideId: ride.id,
        seats: 2,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    expect(response.body).toMatchObject({
      paymentMethod: BookingPaymentMethod.PAY_NOW,
      paymentStatus: BookingPaymentStatus.PAID,
      pricePerSeatSnapshot: '200',
      totalAmount: '400',
      status: BookingStatus.CONFIRMED,
    });

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balance.purchasedAvailable).toBe('100');

    const tx = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({ idempotencyKey: key });
    expect(tx.transactionType).toBe(WalletTransactionType.BOOKING_PAYMENT);
    expect(tx.direction).toBe(WalletTransactionDirection.DEBIT);
    expect(tx.amount).toBe('400');
    expect(tx.referenceType).toBe('BOOKING');
    expect(tx.referenceId).toBe(response.body.id);

    const booking = await dataSource.getRepository(Booking).findOneByOrFail({
      id: response.body.id,
    });
    expect(booking.walletTransactionId).toBe(tx.id);
    expect(booking.idempotencyKey).toBe(key);

    expect(
      await dataSource.getRepository(WalletHold).count({
        where: { walletId: wallet.id },
      }),
    ).toBe(0);

    const mine = await request(app.getHttpServer())
      .get('/bookings/my')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    expect(mine.body[0]).toMatchObject({
      paymentMethod: BookingPaymentMethod.PAY_NOW,
      paymentStatus: BookingPaymentStatus.PAID,
    });
  });

  it('PAY_NOW rejects missing Idempotency-Key', async () => {
    const { ride } = await publishableDriver();
    const { login } = await fundedPassenger(500n);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(400);
  });

  it('PAY_NOW rejects insufficient / suspended / locked wallet', async () => {
    const { ride } = await publishableDriver(3, 200);
    const poor = await fundedPassenger(100n);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${poor.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('poor'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(422);

    const suspended = await fundedPassenger(500n);
    await dataSource.getRepository(Wallet).update(
      { id: suspended.wallet.id },
      { status: WalletStatus.SUSPENDED },
    );
    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${suspended.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('suspended'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(403);

    const locked = await fundedPassenger(500n);
    await dataSource
      .getRepository(Wallet)
      .update({ id: locked.wallet.id }, { status: WalletStatus.LOCKED });
    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${locked.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('locked'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(403);
  });

  it('client cannot supply amount fields or paymentStatus', async () => {
    const { ride } = await publishableDriver();
    const { login } = await fundedPassenger(500n);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('amt'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
        amount: '1',
        totalAmount: '1',
        pricePerSeatSnapshot: '1',
        paymentStatus: BookingPaymentStatus.PAID,
        passengerId: login.user.id,
      })
      .expect(400);
  });

  it('idempotent PAY_NOW retry returns original and charges once', async () => {
    const { ride } = await publishableDriver(3, 200);
    const { login, wallet } = await fundedPassenger(500n);
    const key = uniqueIdempotencyKey('retry');

    const first = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .set('Idempotency-Key', key)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .set('Idempotency-Key', key)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    expect(second.body.id).toBe(first.body.id);

    expect(
      await dataSource.getRepository(Booking).count({
        where: { passengerId: login.user.id, rideId: ride.id },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: wallet.id,
          transactionType: WalletTransactionType.BOOKING_PAYMENT,
        },
      }),
    ).toBe(1);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .set('Idempotency-Key', key)
      .send({
        rideId: ride.id,
        seats: 2,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(409);
  });

  it('booking failure rolls back wallet debit and seats', async () => {
    const { ride } = await publishableDriver(3, 200);
    const { login, wallet } = await fundedPassenger(500n);
    const key = uniqueIdempotencyKey('booking-fail');

    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    const seatsBefore = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: ride.id })
    ).availableSeats;

    const originalSave = Repository.prototype.save;
    const spy = jest
      .spyOn(Repository.prototype, 'save')
      .mockImplementation(async function (
        this: Repository<unknown>,
        entity: unknown,
        ...rest: unknown[]
      ) {
        const maybeBooking = entity as {
          passengerId?: string;
          rideId?: string;
          paymentMethod?: string;
          pricePerSeatSnapshot?: string;
        };
        if (
          maybeBooking &&
          typeof maybeBooking === 'object' &&
          maybeBooking.passengerId &&
          maybeBooking.rideId &&
          maybeBooking.paymentMethod &&
          maybeBooking.pricePerSeatSnapshot
        ) {
          throw new Error('forced booking failure');
        }
        return originalSave.apply(this, [entity, ...rest] as never);
      });

    try {
      await expect(
        bookingsService.create(
          login.user.id,
          {
            rideId: ride.id,
            seats: 1,
            paymentMethod: BookingPaymentMethod.PAY_NOW,
          },
          { idempotencyKey: key },
        ),
      ).rejects.toThrow('forced booking failure');
    } finally {
      spy.mockRestore();
    }

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balanceAfter.purchasedAvailable).toBe(
      balanceBefore.purchasedAvailable,
    );
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { idempotencyKey: key },
      }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(Booking).count({
        where: { rideId: ride.id },
      }),
    ).toBe(0);
    const seatsAfter = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: ride.id })
    ).availableSeats;
    expect(seatsAfter).toBe(seatsBefore);
  });

  it('wallet ledger failure rolls back seats and booking', async () => {
    const { ride } = await publishableDriver(3, 200);
    const { login, wallet } = await fundedPassenger(500n);
    const key = uniqueIdempotencyKey('ledger-fail');

    const seatsBefore = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: ride.id })
    ).availableSeats;
    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    const spy = jest
      .spyOn(walletService, 'debitPointsInTransaction')
      .mockRejectedValue(new Error('forced ledger failure'));

    try {
      await expect(
        bookingsService.create(
          login.user.id,
          {
            rideId: ride.id,
            seats: 1,
            paymentMethod: BookingPaymentMethod.PAY_NOW,
          },
          { idempotencyKey: key },
        ),
      ).rejects.toThrow('forced ledger failure');
    } finally {
      spy.mockRestore();
    }

    expect(
      await dataSource.getRepository(Booking).count({
        where: { rideId: ride.id },
      }),
    ).toBe(0);
    const seatsAfter = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: ride.id })
    ).availableSeats;
    expect(seatsAfter).toBe(seatsBefore);

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balanceAfter.purchasedAvailable).toBe(
      balanceBefore.purchasedAvailable,
    );
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { idempotencyKey: key },
      }),
    ).toBe(0);
  });

  it('concurrent PAY_NOW cannot overbook and keeps wallet consistent', async () => {
    const { ride } = await publishableDriver(2, 200);
    const passengerA = await fundedPassenger(500n);
    const passengerB = await fundedPassenger(500n);

    const results = await Promise.allSettled([
      bookingsService.create(
        passengerA.login.user.id,
        {
          rideId: ride.id,
          seats: 2,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        },
        { idempotencyKey: uniqueIdempotencyKey('conc-a') },
      ),
      bookingsService.create(
        passengerB.login.user.id,
        {
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        },
        { idempotencyKey: uniqueIdempotencyKey('conc-b') },
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rideRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(rideRow.availableSeats).toBe(0);

    const confirmed = await dataSource.getRepository(Booking).find({
      where: { rideId: ride.id, status: BookingStatus.CONFIRMED },
    });
    const bookedSeats = confirmed.reduce((sum, b) => sum + b.seats, 0);
    expect(bookedSeats).toBe(2);

    const txs = await dataSource.getRepository(WalletTransaction).find({
      where: {
        transactionType: WalletTransactionType.BOOKING_PAYMENT,
        referenceId: confirmed[0].id,
      },
    });
    expect(txs).toHaveLength(1);
  });

  it('concurrent PAY_NOW against same wallet cannot corrupt balance', async () => {
    const rideA = await publishableDriver(2, 200);
    const rideB = await publishableDriver(2, 200);
    const { login, wallet } = await fundedPassenger(500n);

    const results = await Promise.allSettled([
      bookingsService.create(
        login.user.id,
        {
          rideId: rideA.ride.id,
          seats: 2,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        },
        { idempotencyKey: uniqueIdempotencyKey('wallet-a') },
      ),
      bookingsService.create(
        login.user.id,
        {
          rideId: rideB.ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        },
        { idempotencyKey: uniqueIdempotencyKey('wallet-b') },
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    const available =
      BigInt(balance.purchasedAvailable) +
      BigInt(balance.promotionalAvailable) +
      BigInt(balance.driverEarnedAvailable);
    expect(available).toBeGreaterThanOrEqual(0n);

    const debitTotal = (
      await dataSource.getRepository(WalletTransaction).find({
        where: {
          walletId: wallet.id,
          transactionType: WalletTransactionType.BOOKING_PAYMENT,
          direction: WalletTransactionDirection.DEBIT,
        },
      })
    ).reduce((sum, tx) => sum + BigInt(tx.amount), 0n);

    expect(available + debitTotal).toBe(500n);
    expect(Number(available)).toBe(500 - Number(debitTotal));
  });

  it('PAY_NOW consumes promotional points before purchased (existing priority)', async () => {
    const { ride } = await publishableDriver(3, 150);
    const { login, wallet } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);

    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 100n,
      sourceType: WalletPointSource.PROMOTIONAL,
      idempotencyKey: uniqueIdempotencyKey('promo'),
    });
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 200n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('purch'),
    });

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('priority'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balance.promotionalAvailable).toBe('0');
    expect(balance.purchasedAvailable).toBe('150');

    const lots = await dataSource.getRepository(WalletPointLot).find({
      where: { walletId: wallet.id },
    });
    const promo = lots.find(
      (lot) => lot.sourceType === WalletPointSource.PROMOTIONAL,
    );
    const purchased = lots.find(
      (lot) => lot.sourceType === WalletPointSource.PURCHASED,
    );
    expect(promo?.availableAmount).toBe('0');
    expect(purchased?.availableAmount).toBe('150');
  });
});
