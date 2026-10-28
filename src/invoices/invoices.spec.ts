import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AdminModule } from '../admin/admin.module';
import {
  ADMIN_PERMISSION_INVOICES_MANAGE,
  ADMIN_PERMISSION_INVOICES_VIEW,
} from '../admin/admin.constants';
import { AdminUser } from '../admin/entities/admin-user.entity';
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
import { deleteChatForBookingIds } from '../chat/test/chat-test.helpers';
import { SmtpMailService } from '../email/smtp-mail.service';
import { RatingTask } from '../ratings/entities/rating-task.entity';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import {
  withAssuredPublishHeaders,
  withAssuredTestRoute,
} from '../rides/test/assured-ride-test.helpers';
import { startRideAndVerifyAllPickups } from '../rides/test/ride-trip-test.helpers';
import { withSelectedRoute } from '../rides/test/selected-route-test.helpers';
import { User } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VerificationType } from '../verification/enums/verification.enums';
import { markVerificationVerified } from '../verification/test/verification-test.helpers';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehicleType } from '../vehicles/enums/vehicle-type.enum';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { VehiclesService } from '../vehicles/vehicles.service';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { GstInvoiceJob } from './entities/invoice-job.entity';
import { InvoiceTaxConfig } from './entities/invoice-tax-config.entity';
import { GstInvoice } from './entities/invoice.entity';
import {
  InvoiceEmailStatus,
  InvoiceJobStatus,
  InvoicePlaceOfSupplyMode,
  InvoiceTaxConfigStatus,
  InvoiceTaxPricingMode,
} from './enums/invoice.enums';
import { InvoiceIssuanceService } from './invoice-issuance.service';
import { InvoiceWorkerService } from './invoice-worker.service';
import { InvoicesModule } from './invoices.module';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for invoice tests');
  }
  return secret;
}

describe('GST tax invoices (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let worker: InvoiceWorkerService;
  let issuance: InvoiceIssuanceService;
  const tracked: TestWalletContext[] = [];
  const sendEmail = jest.fn().mockResolvedValue(undefined);
  let sendEmailSpy: jest.SpyInstance;
  const storageDir = mkdtempSync(path.join(os.tmpdir(), 'bhaiway-invoices-'));

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);
    process.env.INVOICE_STORAGE_DIR = storageDir;

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
        AdminModule,
        WalletModule,
        VerificationModule,
        VehiclesModule,
        RidesModule,
        BookingsModule,
        InvoicesModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new Msg91ResponseFormatError()),
      })
      .overrideProvider(SmtpMailService)
      .useValue({
        sendEmail,
        getFromAddress: () => 'BhaiWay <alerts@kodenzolabs.in>',
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
    worker = moduleRef.get(InvoiceWorkerService);
    issuance = moduleRef.get(InvoiceIssuanceService);
    sendEmailSpy = jest
      .spyOn(SmtpMailService.prototype, 'sendEmail')
      .mockImplementation(async (params) => {
        await sendEmail(params);
      });
  });

  afterEach(async () => {
    sendEmail.mockClear();
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (!ctx) continue;
      const rides = await dataSource.getRepository(Ride).find({
        where: { driverId: ctx.userId },
      });
      const bookingIds = new Set<string>();
      for (const ride of rides) {
        const rideBookings = await dataSource.getRepository(Booking).find({
          where: { rideId: ride.id },
          select: { id: true },
        });
        rideBookings.forEach((row) => bookingIds.add(row.id));
        await dataSource.getRepository(RatingTask).delete({ rideId: ride.id });
      }
      const passengerBookings = await dataSource.getRepository(Booking).find({
        where: { passengerId: ctx.userId },
        select: { id: true },
      });
      passengerBookings.forEach((row) => bookingIds.add(row.id));
      const ids = [...bookingIds];
      if (ids.length > 0) {
        await dataSource
          .getRepository(RatingTask)
          .createQueryBuilder()
          .delete()
          .where('booking_id IN (:...ids)', { ids })
          .execute();
        await deleteChatForBookingIds(dataSource, ids);
      }
      await dataSource.query(
        `DELETE FROM commute_reward_qualifying_trips WHERE driver_id = $1`,
        [ctx.userId],
      );
      for (const ride of rides) {
        await dataSource.getRepository(Booking).delete({ rideId: ride.id });
      }
      await dataSource.getRepository(Booking).delete({ passengerId: ctx.userId });
      await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
      await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
      await dataSource.getRepository(AdminUser).delete({ userId: ctx.userId });
      await dataSource.getRepository(UserVerification).delete({
        userId: ctx.userId,
      });
      await dataSource.getRepository(UserProfile).delete({ userId: ctx.userId });
      await cleanupTestWallet(dataSource, ctx);
    }
  });

  afterAll(async () => {
    sendEmailSpy?.mockRestore();
    await app?.close();
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
    return { login, wallet };
  }

  async function fundedDriver() {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: `MH12${Date.now().toString().slice(-6)}`,
      registrationYear: 2024,
      color: 'Blue',
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
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 10000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('inv-driver'),
    });
    return { login, wallet, vehicle };
  }

  async function fundedPassenger(email?: string) {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.IDENTITY,
    );
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 10000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('inv-pass'),
    });
    if (email) {
      await dataSource.getRepository(User).update(
        { id: login.user.id },
        { email, emailVerified: true },
      );
    }
    return { login, wallet };
  }

  async function ensureAdmin(userId: string, permissions = [
    ADMIN_PERMISSION_INVOICES_VIEW,
    ADMIN_PERMISSION_INVOICES_MANAGE,
  ]) {
    const repo = dataSource.getRepository(AdminUser);
    let admin = await repo.findOne({ where: { userId } });
    if (!admin) {
      admin = repo.create({
        userId,
        username: `inv_admin_${userId.slice(0, 8)}`,
        passwordHash: 'x',
        permissions,
        isActive: true,
      });
    } else {
      admin.permissions = permissions;
      admin.isActive = true;
    }
    await repo.save(admin);
    return authService.signAccessToken(userId);
  }

  async function seedIssuerAndTax(adminToken: string) {
    await dataSource.query(`DELETE FROM invoice_tax_config_audit`);
    await dataSource.query(`DELETE FROM invoice_tax_configs`);
    await request(app.getHttpServer())
      .put('/admin/invoices/issuer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        legalName: 'Example Mobility Private Limited',
        gstin: '27AABCU9603R1ZM',
        addressLine1: 'Plot 1, Test Park',
        city: 'Pune',
        state: 'Maharashtra',
        stateCode: '27',
        pinCode: '411001',
        invoicePrefix: 'BW',
        footerNotes: 'This is a computer generated tax invoice.',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/admin/invoices/logo')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', PNG_1X1, {
        filename: 'logo.png',
        contentType: 'image/png',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/admin/invoices/tax-configs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        serviceCategory: 'Passenger transportation',
        rideTypes: [RideType.REGULAR, RideType.COMMUTE],
        sacCode: '996411',
        gstRateBasisPoints: 1800,
        pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
        placeOfSupplyMode: InvoicePlaceOfSupplyMode.ISSUER_STATE,
        effectiveFrom: '2020-04-01T00:00:00.000Z',
        status: InvoiceTaxConfigStatus.ACTIVE,
      })
      .expect(201);
  }

  async function publishRegular(driverToken: string, vehicleId: string) {
    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(
        withSelectedRoute({
          rideType: RideType.REGULAR,
          vehicleId,
          source: 'Invoice Source',
          destination: 'Invoice Dest',
          departureDate: '2028-04-11',
          departureTime: '09:00',
          totalSeats: 3,
          pricePerSeat: 200,
        }),
      )
      .expect(201);
    return response.body as { id: string };
  }

  async function publishCommute(driverToken: string, vehicleId: string) {
    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(
        withSelectedRoute({
          rideType: RideType.COMMUTE,
          vehicleId,
          source: 'Gurgaon',
          destination: 'Noida',
          departureDate: '2028-04-12',
          departureTime: '08:30',
          totalSeats: 3,
          pricePerSeat: 100,
        }),
      )
      .expect(201);
    return response.body as { id: string };
  }

  async function completeEligibleRide(
    driverToken: string,
    rideId: string,
  ): Promise<void> {
    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driverToken,
      rideId,
      pickupOtpPepper(),
    );
    await request(app.getHttpServer())
      .post(`/rides/${rideId}/complete`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);
    await drainRideInvoices(rideId);
  }

  async function drainRideInvoices(rideId: string): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    const jobs = await dataSource.getRepository(GstInvoiceJob).find({
      where: { rideId },
    });
    for (const job of jobs) {
      await worker.processJob(job.id);
    }
  }

  it('missing tax configuration does not block Regular completion', async () => {
    await dataSource.query(`DELETE FROM invoice_tax_config_audit`);
    await dataSource.query(`DELETE FROM invoice_tax_configs`);
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await completeEligibleRide(driver.login.accessToken, ride.id);
    const stored = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(stored.status).toBe(RideStatus.COMPLETED);

    const invoices = await dataSource.getRepository(GstInvoice).find({
      where: { rideId: ride.id },
    });
    expect(invoices).toHaveLength(0);
    const jobs = await dataSource.getRepository(GstInvoiceJob).find({
      where: { rideId: ride.id },
    });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some((job) => job.status === InvoiceJobStatus.ISSUED)).toBe(
      false,
    );
    expect(
      jobs.some(
        (job) =>
          job.status === InvoiceJobStatus.FAILED ||
          job.status === InvoiceJobStatus.PENDING ||
          job.status === InvoiceJobStatus.PROCESSING,
      ),
    ).toBe(true);
  });

  it('Outstation completion creates exactly one rider invoice and emails the rider', async () => {
    const adminUser = await createAuthenticatedUser();
    const adminToken = await ensureAdmin(adminUser.login.user.id);
    await seedIssuerAndTax(adminToken);

    const driver = await fundedDriver();
    const riderEmail = `rider.${randomUUID()}@example.com`;
    const passenger = await fundedPassenger(riderEmail);
    const other = await fundedPassenger();
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await completeEligibleRide(driver.login.accessToken, ride.id);
    await Promise.all([
      request(app.getHttpServer())
        .post(`/rides/${ride.id}/complete`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`),
      request(app.getHttpServer())
        .post(`/rides/${ride.id}/complete`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`),
    ]);
    await worker.processDue();

    const invoices = await dataSource.getRepository(GstInvoice).find({
      where: { rideId: ride.id },
    });
    if (invoices.length === 0) {
      const jobs = await dataSource.getRepository(GstInvoiceJob).find({
        where: { rideId: ride.id },
      });
      throw new Error(
        `Expected an invoice, jobs=${JSON.stringify(
          jobs.map((job) => ({
            status: job.status,
            lastError: job.lastError,
            attempts: job.attemptCount,
          })),
        )}`,
      );
    }
    expect(invoices).toHaveLength(1);
    expect(invoices[0].bookingId).toBe(booking.body.id);
    expect(invoices[0].riderUserId).toBe(passenger.login.user.id);
    expect(invoices[0].invoiceNumber).toMatch(/^BW\/\d{4}-\d{2}\/\d{6}$/);
    expect(invoices[0].netFarePaise).toBe('20000');
    expect(invoices[0].totalTaxPaise).toBe('3600');
    await worker.deliverEmail(invoices[0].id);
    const mailed = await dataSource
      .getRepository(GstInvoice)
      .findOneByOrFail({ id: invoices[0].id });
    expect(mailed.emailStatus).toBe(InvoiceEmailStatus.SENT);
    expect(sendEmail).toHaveBeenCalled();
    expect(sendEmail.mock.calls[0][0].to).toBe(riderEmail);

    const list = await request(app.getHttpServer())
      .get('/invoices')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(list.body.total).toBe(1);

    await request(app.getHttpServer())
      .get(`/invoices/${invoices[0].id}`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .get(`/invoices/${invoices[0].id}`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(404);

    const pdf = await request(app.getHttpServer())
      .get(`/invoices/${invoices[0].id}/pdf`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(pdf.body.toString('utf8', 0, 4)).toBe('%PDF');

    const originalRate = invoices[0].gstRateBasisPoints;
    const configs = await dataSource.getRepository(InvoiceTaxConfig).find();
    await request(app.getHttpServer())
      .patch(`/admin/invoices/tax-configs/${configs[0].id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ gstRateBasisPoints: 500 })
      .expect(200);
    const reloaded = await dataSource
      .getRepository(GstInvoice)
      .findOneByOrFail({ id: invoices[0].id });
    expect(reloaded.gstRateBasisPoints).toBe(originalRate);
    expect(reloaded.taxConfigSnapshot).toMatchObject({
      gstRateBasisPoints: originalRate,
    });
  });

  it('Daily Office Commute completion creates exactly one invoice', async () => {
    const adminUser = await createAuthenticatedUser();
    const adminToken = await ensureAdmin(adminUser.login.user.id);
    await seedIssuerAndTax(adminToken);
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(
      `commute.${randomUUID()}@example.com`,
    );
    const ride = await publishCommute(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('inv-commute'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await completeEligibleRide(driver.login.accessToken, ride.id);
    const invoices = await dataSource.getRepository(GstInvoice).find({
      where: { rideId: ride.id },
    });
    if (invoices.length === 0) {
      const jobs = await dataSource.getRepository(GstInvoiceJob).find({
        where: { rideId: ride.id },
      });
      throw new Error(
        `Expected a commute invoice, jobs=${JSON.stringify(
          jobs.map((job) => ({
            status: job.status,
            lastError: job.lastError,
            attempts: job.attemptCount,
          })),
        )}`,
      );
    }
    expect(invoices).toHaveLength(1);
    expect(invoices[0].rideType).toBe(RideType.COMMUTE);
    expect(invoices[0].bookingId).toBe(booking.body.id);
  });

  it('Assured, cancelled, and no-show bookings do not generate rider invoices', async () => {
    const adminUser = await createAuthenticatedUser();
    const adminToken = await ensureAdmin(adminUser.login.user.id);
    await seedIssuerAndTax(adminToken);

    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const assured = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(driver.login.accessToken))
      .send(
        withAssuredTestRoute({
          rideType: RideType.ASSURED,
          vehicleId: driver.vehicle.id,
          source: 'Assured A',
          destination: 'Assured B',
          departureDate: '2028-04-13',
          departureTime: '10:00',
          totalSeats: 3,
          pricePerSeat: 500,
        }),
      )
      .expect(201);
    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('inv-assured'))
      .send({
        rideId: assured.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);
    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      assured.body.id,
      pickupOtpPepper(),
    );
    await request(app.getHttpServer())
      .post(`/rides/${assured.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    await worker.processDue();
    expect(
      await dataSource.getRepository(GstInvoice).count({
        where: { rideId: assured.body.id },
      }),
    ).toBe(0);

    const cancelDriver = await fundedDriver();
    const cancelPassenger = await fundedPassenger();
    const cancelledRide = await publishRegular(
      cancelDriver.login.accessToken,
      cancelDriver.vehicle.id,
    );
    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${cancelPassenger.login.accessToken}`)
      .send({
        rideId: cancelledRide.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/rides/${cancelledRide.id}/cancel`)
      .set('Authorization', `Bearer ${cancelDriver.login.accessToken}`)
      .expect(200);
    await worker.processDue();
    expect(
      await dataSource.getRepository(GstInvoice).count({
        where: { rideId: cancelledRide.id },
      }),
    ).toBe(0);

    const noShowDriver = await fundedDriver();
    const noShowPassenger = await fundedPassenger();
    const noShowRide = await publishRegular(
      noShowDriver.login.accessToken,
      noShowDriver.vehicle.id,
    );
    const noShowBooking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${noShowPassenger.login.accessToken}`)
      .send({
        rideId: noShowRide.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
    await dataSource.getRepository(Booking).update(
      { id: noShowBooking.body.id },
      {
        status: BookingStatus.CANCELLED,
        cancellationReason: BookingCancellationReason.RIDER_NO_SHOW,
      },
    );
    await request(app.getHttpServer())
      .post(`/rides/${noShowRide.id}/start`)
      .set('Authorization', `Bearer ${noShowDriver.login.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/rides/${noShowRide.id}/complete`)
      .set('Authorization', `Bearer ${noShowDriver.login.accessToken}`)
      .expect(200);
    await worker.processDue();
    expect(
      await dataSource.getRepository(GstInvoice).count({
        where: { rideId: noShowRide.id },
      }),
    ).toBe(0);
  });

  it('allocates unique invoice numbers under concurrent transactions', async () => {
    const adminUser = await createAuthenticatedUser();
    const adminToken = await ensureAdmin(adminUser.login.user.id);
    await seedIssuerAndTax(adminToken);
    const issuedAt = new Date('2026-05-15T10:00:00.000Z');
    const numbers = await Promise.all(
      Array.from({ length: 8 }, () =>
        dataSource.transaction((manager) =>
          issuance.nextInvoiceNumber(manager, 'BW', issuedAt),
        ),
      ),
    );
    expect(new Set(numbers).size).toBe(8);
  });

  it('rejects overlapping active tax configuration', async () => {
    const adminUser = await createAuthenticatedUser();
    const adminToken = await ensureAdmin(adminUser.login.user.id);
    await seedIssuerAndTax(adminToken);
    await request(app.getHttpServer())
      .post('/admin/invoices/tax-configs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        serviceCategory: 'Passenger transportation overlap',
        rideTypes: [RideType.REGULAR],
        sacCode: '996411',
        gstRateBasisPoints: 500,
        pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
        placeOfSupplyMode: InvoicePlaceOfSupplyMode.ISSUER_STATE,
        effectiveFrom: '2024-04-01T00:00:00.000Z',
        status: InvoiceTaxConfigStatus.ACTIVE,
      })
      .expect(400);
  });

  it('retries failed email without sending duplicates after success', async () => {
    const adminUser = await createAuthenticatedUser();
    const adminToken = await ensureAdmin(adminUser.login.user.id);
    await seedIssuerAndTax(adminToken);

    const driver = await fundedDriver();
    const passenger = await fundedPassenger(
      `retry.${randomUUID()}@example.com`,
    );
    const ride = await publishRegular(
      driver.login.accessToken,
      driver.vehicle.id,
    );
    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
    await completeEligibleRide(driver.login.accessToken, ride.id);

    const invoice = await dataSource.getRepository(GstInvoice).findOne({
      where: { rideId: ride.id },
    });
    if (!invoice) {
      const jobs = await dataSource.getRepository(GstInvoiceJob).find({
        where: { rideId: ride.id },
      });
      throw new Error(
        `Expected retry invoice, jobs=${JSON.stringify(
          jobs.map((job) => ({
            status: job.status,
            lastError: job.lastError,
            attempts: job.attemptCount,
          })),
        )}`,
      );
    }

    await dataSource.getRepository(GstInvoice).update(
      { id: invoice.id },
      {
        emailStatus: InvoiceEmailStatus.FAILED,
        emailAttemptCount: 1,
        emailLastError: 'smtp timeout',
        emailSentAt: null,
        emailNextAttemptAt: new Date(Date.now() + 60_000),
      },
    );
    sendEmail.mockClear();
    await request(app.getHttpServer())
      .post(`/admin/invoices/${invoice.id}/retry-email`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    const sent = await dataSource
      .getRepository(GstInvoice)
      .findOneByOrFail({ id: invoice.id });
    expect(sent.emailStatus).toBe(InvoiceEmailStatus.SENT);

    const callsAfterSent = sendEmail.mock.calls.length;
    await request(app.getHttpServer())
      .post(`/admin/invoices/${invoice.id}/retry-email`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect(sendEmail.mock.calls.length).toBe(callsAfterSent);
  });
});
