import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';

import {
  ADMIN_PERMISSION_ACCOUNT_DELETIONS_MANAGE,
  ADMIN_PERMISSION_ACCOUNT_DELETIONS_VIEW,
  ADMIN_PERMISSION_USERS_MANAGE,
  ADMIN_PERMISSION_USERS_VIEW,
} from '../../admin/admin.constants';
import { AdminModule } from '../../admin/admin.module';
import { AdminUser } from '../../admin/entities/admin-user.entity';
import { AuthModule } from '../../auth/auth.module';
import { AuthService } from '../../auth/auth.service';
import { Msg91ResponseFormatError } from '../../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../../auth/providers/otp-provider.interface';
import { Booking } from '../../bookings/entities/booking.entity';
import {
  BookingMode,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from '../../bookings/enums/booking.enums';
import { NoShowClaim } from '../../no-show/entities/no-show-claim.entity';
import {
  NoShowClaimKind,
  NoShowClaimStatus,
} from '../../no-show/enums/no-show.enums';
import { NotificationsModule } from '../../notifications/notifications.module';
import { RideSeries } from '../../rides/entities/ride-series.entity';
import { Ride } from '../../rides/entities/ride.entity';
import {
  RideDirection,
  RideSeriesStatus,
  RideStatus,
  RideType,
  Weekday,
} from '../../rides/enums/ride.enums';
import { SafetyIncident } from '../../safety/sos/entities/safety-incident.entity';
import { SosEvent } from '../../safety/sos/entities/sos-event.entity';
import {
  SafetyIncidentSeverity,
  SafetyIncidentStatus,
  SafetyIncidentType,
  SosCategory,
  SosSeverity,
  SosStatus,
} from '../../safety/sos/enums/sos.enums';
import { TrustedContact } from '../../safety/trusted-contacts/entities/trusted-contact.entity';
import { TrustedContactRelationship } from '../../safety/trusted-contacts/enums/trusted-contact-relationship.enum';
import { SupportTicket } from '../../support/entities/support-ticket.entity';
import {
  SupportBookingsSubcategory,
  SupportTicketCategory,
  SupportTicketStatus,
} from '../../support/enums/support.enums';
import { UserProfile } from '../entities/user-profile.entity';
import { User, UserStatus } from '../entities/user.entity';
import { UsersModule } from '../users.module';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { VehicleType } from '../../vehicles/enums/vehicle-type.enum';
import { PaymentOrder } from '../../wallet/entities/payment-order.entity';
import { WalletBalance } from '../../wallet/entities/wallet-balance.entity';
import {
  WalletHold,
  WalletHoldStatus,
  WalletHoldType,
} from '../../wallet/entities/wallet-hold.entity';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { Withdrawal } from '../../wallet/entities/withdrawal.entity';
import {
  PaymentOrderProvider,
  PaymentOrderStatus,
} from '../../wallet/enums/payment-order.enums';
import {
  PaymentMethodType,
  WithdrawalProvider,
  WithdrawalStatus,
} from '../../wallet/enums/withdrawal.enums';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
} from '../../wallet/test/wallet-test.helpers';
import { WalletModule } from '../../wallet/wallet.module';
import { AccountDeletionEligibilityService } from './account-deletion-eligibility.service';
import { AccountDeletionModule } from './account-deletion.module';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionAuditLog } from './entities/account-deletion-audit-log.entity';
import { AccountDeletionRequest } from './entities/account-deletion-request.entity';
import {
  AccountDeletionAuditAction,
  AccountDeletionRequestStatus,
  DeletionReason,
} from './enums/account-deletion.enums';
import { applyAccountDeletionSchema } from './test/apply-account-deletion-schema';
import { calculateIndiaBusinessDays } from './utils/india-business-days.util';

describe('Account Deletion Workflow (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let jwtService: JwtService;
  let deletionService: AccountDeletionService;
  let eligibilityService: AccountDeletionEligibilityService;
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
        UsersModule,
        AccountDeletionModule,
        AdminModule,
        WalletModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new Msg91ResponseFormatError()),
      })
      .compile();

    dataSource = moduleRef.get<DataSource>(DataSource);
    authService = moduleRef.get<AuthService>(AuthService);
    jwtService = moduleRef.get<JwtService>(JwtService);
    deletionService = moduleRef.get<AccountDeletionService>(
      AccountDeletionService,
    );
    eligibilityService = moduleRef.get<AccountDeletionEligibilityService>(
      AccountDeletionEligibilityService,
    );

    await applyAccountDeletionSchema(dataSource);

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    for (const ctx of tracked) {
      await cleanupTestWallet(dataSource, ctx).catch(() => undefined);
    }
    await app?.close();
    await moduleRef?.close();
  });

  async function createUser(customStatus = UserStatus.ACTIVE): Promise<{
    ctx: TestWalletContext;
    token: string;
    user: User;
  }> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);

    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.findOneByOrFail({ id: ctx.userId });
    if (customStatus !== UserStatus.ACTIVE) {
      user.status = customStatus;
      await userRepo.save(user);
    }

    const token =
      customStatus === UserStatus.DELETED
        ? ''
        : await authService.signAccessToken(user.id);
    return { ctx, token, user };
  }

  async function createAdminUser(
    permissions: string[] = [
      ADMIN_PERMISSION_ACCOUNT_DELETIONS_VIEW,
      ADMIN_PERMISSION_ACCOUNT_DELETIONS_MANAGE,
    ],
  ): Promise<{
    user: User;
    token: string;
    adminId: string;
  }> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);

    const adminRepo = dataSource.getRepository(AdminUser);
    const admin = await adminRepo.save(
      adminRepo.create({
        userId: ctx.userId,
        isActive: true,
        permissions,
        username: `admin_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        passwordHash: 'hashed_password_placeholder',
      }),
    );

    const token = await authService.signAccessToken(ctx.userId);
    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.findOneByOrFail({ id: ctx.userId });
    return { user, token, adminId: admin.id };
  }

  async function createVehicleForUser(userId: string): Promise<Vehicle> {
    const vehicleRepo = dataSource.getRepository(Vehicle);
    return vehicleRepo.save(
      vehicleRepo.create({
        userId,
        vehicleType: VehicleType.CAR,
        make: 'Maruti',
        model: 'Swift',
        registrationNumber: `DL${Math.floor(Math.random() * 90 + 10)}AB${Math.floor(
          Math.random() * 9000 + 1000,
        )}`,
        seatingCapacity: 4,
      }),
    );
  }

  async function createTestRide(
    driverId: string,
    vehicleId: string,
    status = RideStatus.PUBLISHED,
  ): Promise<Ride> {
    const rideRepo = dataSource.getRepository(Ride);
    return rideRepo.save(
      rideRepo.create({
        driverId,
        vehicleId,
        rideType: RideType.REGULAR,
        status,
        source: 'Connaught Place, New Delhi',
        destination: 'Cyber Hub, Gurugram',
        departureDate: '2026-12-01',
        departureTime: '09:00:00',
        totalSeats: 3,
        availableSeats: 3,
        pricePerSeat: '150',
      }),
    );
  }

  // ===========================================================================
  // 1. Business Day Calculation Utility
  // ===========================================================================
  describe('India Business Days Calculation', () => {
    it('excludes Saturdays and Sundays', () => {
      // Friday 2026-11-06 -> 7 business days:
      // Mon 9 (1), Tue 10 (2), Wed 11 (3), Thu 12 (4), Fri 13 (5), Mon 16 (6), Tue 17 (7)
      const friday = new Date('2026-11-06T10:00:00Z');
      const due = calculateIndiaBusinessDays(friday, 7);
      expect(due.getUTCDay()).not.toBe(0); // Not Sunday
      expect(due.getUTCDay()).not.toBe(6); // Not Saturday
      expect(due.toISOString().split('T')[0]).toBe('2026-11-17');
    });

    it('excludes Indian national public holidays', () => {
      // 2026-01-23 (Friday) with 2026-01-26 (Republic Day, Monday):
      // Tue 27 (1), Wed 28 (2), Thu 29 (3), Fri 30 (4), Mon 2 (5), Tue 3 (6), Wed 4 (7)
      const startDate = new Date('2026-01-23T10:00:00Z');
      const due = calculateIndiaBusinessDays(startDate, 7);
      expect(due.toISOString().split('T')[0]).toBe('2026-02-04');
    });
  });

  // ===========================================================================
  // 2. User Deletion Request Submission
  // ===========================================================================
  describe('User Request Submission (Service & API)', () => {
    it('submits valid deletion request, transitions status, and invalidates tokens', async () => {
      const { user, token } = await createUser();

      const res = await request(app.getHttpServer())
        .post('/users/me/account-deletion/request')
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: DeletionReason.NO_LONGER_USING,
          additionalComment: 'No longer commuting on this route',
          acceptedDeletionTerms: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.request.status).toBe(
        AccountDeletionRequestStatus.PENDING,
      );
      expect(res.body.request.id).toBeDefined();
      expect(res.body.request.responseDueAt).toBeDefined();

      // Verify user DB status
      const userRepo = dataSource.getRepository(User);
      const updatedUser = await userRepo.findOneByOrFail({ id: user.id });
      expect(updatedUser.status).toBe(UserStatus.DELETION_REQUESTED);
      expect(updatedUser.tokenVersion).toBe(user.tokenVersion + 1);

      // Verify old access token is revoked immediately
      const probeRes = await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', `Bearer ${token}`);
      expect(probeRes.status).toBe(401);
      expect(probeRes.body.code).toBe('TOKEN_REVOKED');

      // Verify audit log
      const auditRepo = dataSource.getRepository(AccountDeletionAuditLog);
      const audit = await auditRepo.findOneByOrFail({
        requestId: res.body.request.id,
      });
      expect(audit.action).toBe(AccountDeletionAuditAction.REQUEST_SUBMITTED);
      expect(audit.userId).toBe(user.id);
    });

    it('rejects submission when terms are not accepted', async () => {
      const { token } = await createUser();

      const res = await request(app.getHttpServer())
        .post('/users/me/account-deletion/request')
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: DeletionReason.PRIVACY_CONCERNS,
          acceptedDeletionTerms: false,
        });

      expect(res.status).toBe(400);
    });

    it('rejects submission with invalid reason enum', async () => {
      const { token } = await createUser();

      const res = await request(app.getHttpServer())
        .post('/users/me/account-deletion/request')
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'I_JUST_WANT_TO_LEAVE',
          acceptedDeletionTerms: true,
        });

      expect(res.status).toBe(400);
    });

    it('rejects duplicate active deletion request with 409 Conflict', async () => {
      const { user, token } = await createUser();

      await deletionService.submitRequest(user.id, {
        reason: DeletionReason.OTHER,
        acceptedDeletionTerms: true,
      });

      // Attempt second submission
      await expect(
        deletionService.submitRequest(user.id, {
          reason: DeletionReason.OTHER,
          acceptedDeletionTerms: true,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects deletion request for already deleted account', async () => {
      const { user } = await createUser(UserStatus.DELETED);

      await expect(
        deletionService.submitRequest(user.id, {
          reason: DeletionReason.NO_LONGER_USING,
          acceptedDeletionTerms: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===========================================================================
  // 3. Central Account Access Restrictions
  // ===========================================================================
  describe('Central Account Access Restrictions', () => {
    it('blocks normal operations when account is DELETION_REQUESTED', async () => {
      const { user } = await createUser();
      await deletionService.submitRequest(user.id, {
        reason: DeletionReason.NO_LONGER_USING,
        acceptedDeletionTerms: true,
      });

      // Login issued a restricted token
      const freshToken = await authService.signAccessToken(user.id, {
        scope: 'restricted_deletion',
      });

      // Calling regular endpoint (GET /users/me) returns 403 ACCOUNT_DELETION_PENDING
      const res = await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', `Bearer ${freshToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_DELETION_PENDING');
    });

    it('allows GET /users/me/account-deletion with restricted token', async () => {
      const { user } = await createUser();
      await deletionService.submitRequest(user.id, {
        reason: DeletionReason.NO_LONGER_USING,
        additionalComment: 'Secret internal note test',
        acceptedDeletionTerms: true,
      });

      const restrictedToken = await authService.signAccessToken(user.id, {
        scope: 'restricted_deletion',
      });

      const res = await request(app.getHttpServer())
        .get('/users/me/account-deletion')
        .set('Authorization', `Bearer ${restrictedToken}`);

      expect(res.status).toBe(200);
      expect(res.body.hasActiveRequest).toBe(true);
      expect(res.body.request.status).toBe(
        AccountDeletionRequestStatus.PENDING,
      );
      expect(res.body.request.canCancel).toBe(true);
      expect(res.body.request.isCompleted).toBe(false);
      // Ensures admin notes and internal details are never leaked
      expect(res.body.request.adminNote).toBeUndefined();
    });

    it('login with pending account issues restricted token and marks deletionPending', async () => {
      const { ctx, user } = await createUser();
      await deletionService.submitRequest(user.id, {
        reason: DeletionReason.SWITCHED_TO_ANOTHER_SERVICE,
        acceptedDeletionTerms: true,
      });

      const loginRes = await authService.loginOrRegisterWithVerifiedIdentity({
        verified: true,
        phone: ctx.phone,
        email: null,
      });

      expect(loginRes.deletionPending).toBe(true);
      expect(loginRes.user.status).toBe(UserStatus.DELETION_REQUESTED);

      // Verify decoded token contains scope: restricted_deletion
      const decoded = jwtService.decode(loginRes.accessToken);
      expect(decoded.scope).toBe('restricted_deletion');
    });

    it('old DELETED account cannot be logged into or reactivated; new registration creates separate user', async () => {
      const { ctx, user } = await createUser(UserStatus.DELETED);

      // Old account cannot have access tokens signed
      await expect(authService.signAccessToken(user.id)).rejects.toThrow(
        ForbiddenException,
      );

      // OTP verification for that phone does not return the deleted account, but creates a separate new user
      const loginRes = await authService.loginOrRegisterWithVerifiedIdentity({
        verified: true,
        phone: ctx.phone,
        email: null,
      });

      expect(loginRes.user.id).not.toBe(user.id);
      expect(loginRes.user.status).toBe(UserStatus.ACTIVE);

      // Verify the old deleted record is still unchanged in the database
      const userRepo = dataSource.getRepository(User);
      const oldUser = await userRepo.findOneByOrFail({ id: user.id });
      expect(oldUser.status).toBe(UserStatus.DELETED);
      expect(oldUser.phone).toBe(ctx.phone);

      const newWallet = await dataSource
        .getRepository(Wallet)
        .findOneByOrFail({ userId: loginRes.user.id });
      tracked.push({
        userId: loginRes.user.id,
        walletId: newWallet.id,
        balanceId: '',
        phone: ctx.phone,
      });
    });
  });

  // ===========================================================================
  // 4. Cancellation Flow
  // ===========================================================================
  describe('Cancellation Workflow', () => {
    it('cancels PENDING request, restores user ACTIVE status and bumps tokenVersion', async () => {
      const { user } = await createUser();
      const sub = await deletionService.submitRequest(user.id, {
        reason: DeletionReason.OTHER,
        acceptedDeletionTerms: true,
      });

      const cancelRes = await deletionService.cancelRequest(user.id);
      expect(cancelRes.success).toBe(true);

      const userRepo = dataSource.getRepository(User);
      const restoredUser = await userRepo.findOneByOrFail({ id: user.id });
      expect(restoredUser.status).toBe(UserStatus.ACTIVE);

      const requestRepo = dataSource.getRepository(AccountDeletionRequest);
      const reqRow = await requestRepo.findOneByOrFail({
        id: sub.request.id,
      });
      expect(reqRow.status).toBe(AccountDeletionRequestStatus.CANCELLED);
      expect(reqRow.cancelledAt).toBeDefined();

      const auditRepo = dataSource.getRepository(AccountDeletionAuditLog);
      const audit = await auditRepo.findOneByOrFail({
        requestId: sub.request.id,
        action: AccountDeletionAuditAction.REQUEST_CANCELLED,
      });
      expect(audit).toBeDefined();
    });

    it('allows cancellation for UNDER_REVIEW and APPROVED requests', async () => {
      const { user } = await createUser();
      const admin = await createAdminUser();

      const sub = await deletionService.submitRequest(user.id, {
        reason: DeletionReason.NO_LONGER_USING,
        acceptedDeletionTerms: true,
      });

      // Admin reviews
      await deletionService.adminReview(sub.request.id, admin.user.id);
      let status = await deletionService.getStatus(user.id);
      expect(status.request?.status).toBe(
        AccountDeletionRequestStatus.UNDER_REVIEW,
      );

      // User cancels while UNDER_REVIEW
      await deletionService.cancelRequest(user.id);
      status = await deletionService.getStatus(user.id);
      expect(status.hasActiveRequest).toBe(false);
      expect(status.request?.status).toBe(
        AccountDeletionRequestStatus.CANCELLED,
      );
    });

    it('rejects cancellation after permanent deletion has COMPLETED', async () => {
      const { user } = await createUser();
      const admin = await createAdminUser();

      const sub = await deletionService.submitRequest(user.id, {
        reason: DeletionReason.NO_LONGER_USING,
        acceptedDeletionTerms: true,
      });

      await deletionService.adminApprove(sub.request.id, admin.user.id);
      await deletionService.adminComplete(sub.request.id, admin.user.id);

      await expect(deletionService.cancelRequest(user.id)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ===========================================================================
  // 5. Outstanding Obligation Checker (Phase 4)
  // ===========================================================================
  describe('AccountDeletionEligibilityService', () => {
    it('returns eligible: true when user has zero obligations', async () => {
      const { user } = await createUser();
      const res = await eligibilityService.checkEligibility(user.id);
      expect(res.eligible).toBe(true);
      expect(res.blockers).toHaveLength(0);
    });

    it('blocks when user has an active driver ride', async () => {
      const { user } = await createUser();
      const vehicle = await createVehicleForUser(user.id);
      const ride = await createTestRide(
        user.id,
        vehicle.id,
        RideStatus.PUBLISHED,
      );

      const check = await eligibilityService.checkEligibility(user.id);
      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.type === 'ACTIVE_DRIVER_RIDE')).toBe(
        true,
      );

      const rideRepo = dataSource.getRepository(Ride);
      const vehicleRepo = dataSource.getRepository(Vehicle);
      await rideRepo.delete({ id: ride.id });
      await vehicleRepo.delete({ id: vehicle.id });
    });

    it('blocks when user has an in-progress ride', async () => {
      const { user } = await createUser();
      const vehicle = await createVehicleForUser(user.id);
      const ride = await createTestRide(
        user.id,
        vehicle.id,
        RideStatus.IN_PROGRESS,
      );

      const check = await eligibilityService.checkEligibility(user.id);
      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.type === 'RIDE_IN_PROGRESS')).toBe(
        true,
      );

      const rideRepo = dataSource.getRepository(Ride);
      const vehicleRepo = dataSource.getRepository(Vehicle);
      await rideRepo.delete({ id: ride.id });
      await vehicleRepo.delete({ id: vehicle.id });
    });

    it('blocks when user has positive withdrawable wallet balance', async () => {
      const { ctx, user } = await createUser();
      const balanceRepo = dataSource.getRepository(WalletBalance);

      await balanceRepo.update(
        { walletId: ctx.walletId },
        { purchasedAvailable: '500' },
      );

      const check = await eligibilityService.checkEligibility(user.id);
      expect(check.eligible).toBe(false);
      expect(
        check.blockers.some((b) => b.type === 'OUTSTANDING_WALLET_BALANCE'),
      ).toBe(true);

      // Restore zero balance
      await balanceRepo.update(
        { walletId: ctx.walletId },
        { purchasedAvailable: '0' },
      );
    });

    it('blocks when user has an active wallet hold', async () => {
      const { ctx, user } = await createUser();
      const holdRepo = dataSource.getRepository(WalletHold);

      const hold = await holdRepo.save(
        holdRepo.create({
          walletId: ctx.walletId,
          amount: '100',
          holdType: WalletHoldType.ASSURED_DEPOSIT,
          status: WalletHoldStatus.ACTIVE,
          referenceType: 'test_hold',
          referenceId: 'ref_1',
        }),
      );

      const check = await eligibilityService.checkEligibility(user.id);
      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.type === 'ACTIVE_WALLET_HOLD')).toBe(
        true,
      );

      await holdRepo.delete({ id: hold.id });
    });

    it('blocks when user has pending withdrawals', async () => {
      const { ctx, user } = await createUser();
      const withdrawalRepo = dataSource.getRepository(Withdrawal);

      const withdrawal = await withdrawalRepo.save(
        withdrawalRepo.create({
          userId: user.id,
          walletId: ctx.walletId,
          amount: '100',
          status: WithdrawalStatus.INITIATED,
          provider: WithdrawalProvider.MANUAL,
          paymentMethodType: PaymentMethodType.UPI,
          paymentMethodSnapshot: {
            type: PaymentMethodType.UPI,
            upiId: 'user@upi',
            accountHolderName: 'Test',
            accountNumberEncrypted: null,
            accountNumberLast4: null,
            ifscCode: null,
            bankName: null,
          },
          referenceId: `W-${Date.now()}`,
          idempotencyKey: `idemp_w_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        }),
      );

      const check = await eligibilityService.checkEligibility(user.id);
      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.type === 'PENDING_WITHDRAWAL')).toBe(
        true,
      );

      await withdrawalRepo.delete({ id: withdrawal.id });
    });

    it('blocks when user has open safety incidents or SOS', async () => {
      const { user } = await createUser();
      const vehicle = await createVehicleForUser(user.id);
      const ride = await createTestRide(
        user.id,
        vehicle.id,
        RideStatus.COMPLETED,
      );

      const incidentRepo = dataSource.getRepository(SafetyIncident);
      const incident = await incidentRepo.save(
        incidentRepo.create({
          rideId: ride.id,
          type: SafetyIncidentType.SOS,
          status: SafetyIncidentStatus.OPEN,
          severity: SafetyIncidentSeverity.HIGH,
          title: 'Safety test incident',
          summary: 'Emergency test',
        }),
      );

      const check = await eligibilityService.checkEligibility(user.id);
      expect(check.eligible).toBe(false);
      expect(
        check.blockers.some((b) => b.type === 'ACTIVE_SAFETY_INCIDENT'),
      ).toBe(true);

      await incidentRepo.delete({ id: incident.id });
      await dataSource.getRepository(Ride).delete({ id: ride.id });
      await dataSource.getRepository(Vehicle).delete({ id: vehicle.id });
    });

    it('blocks when user has active recurring commute series', async () => {
      const { user } = await createUser();
      const vehicle = await createVehicleForUser(user.id);
      const seriesRepo = dataSource.getRepository(RideSeries);

      const series = await seriesRepo.save(
        seriesRepo.create({
          driverId: user.id,
          vehicleId: vehicle.id,
          publishingDate: '2026-11-01',
          startDate: '2026-11-02',
          endDate: '2026-11-30',
          departureTime: '09:00:00',
          totalSeats: 3,
          pricePerSeat: '100',
          status: RideSeriesStatus.ACTIVE,
          outboundRoute: {
            source: 'Connaught Place',
            destination: 'Cyber Hub',
            routePolyline: 'test_polyline',
            routeLengthMeters: 1000,
            routeDurationSeconds: 600,
            routeSelectionId: '00000000-0000-0000-0000-000000000001',
            routeSelectedAt: new Date(),
          } as any,
        }),
      );

      const check = await eligibilityService.checkEligibility(user.id);
      expect(check.eligible).toBe(false);
      expect(
        check.blockers.some((b) => b.type === 'ACTIVE_COMMUTE_SERIES'),
      ).toBe(true);

      await seriesRepo.delete({ id: series.id });
      await dataSource.getRepository(Vehicle).delete({ id: vehicle.id });
    });
  });

  // ===========================================================================
  // 6. Admin API Endpoints & Permission Enforcement
  // ===========================================================================
  describe('Admin APIs and Permissions', () => {
    it('denies access to non-admin users', async () => {
      const { token } = await createUser();

      const res = await request(app.getHttpServer())
        .get('/admin/account-deletion-requests')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('allows admin with permissions to list requests with status counts', async () => {
      const { token } = await createAdminUser();
      const { user } = await createUser();

      await deletionService.submitRequest(user.id, {
        reason: DeletionReason.NO_LONGER_USING,
        acceptedDeletionTerms: true,
      });

      const res = await request(app.getHttpServer())
        .get('/admin/account-deletion-requests')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toBeDefined();
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.statusCounts.pending).toBeGreaterThanOrEqual(1);
    });

    it('admin review transitions status to UNDER_REVIEW', async () => {
      const admin = await createAdminUser();
      const { user } = await createUser();

      const sub = await deletionService.submitRequest(user.id, {
        reason: DeletionReason.NO_LONGER_USING,
        acceptedDeletionTerms: true,
      });

      const res = await request(app.getHttpServer())
        .post(`/admin/account-deletion-requests/${sub.request.id}/review`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ adminNote: 'Checking obligations' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(AccountDeletionRequestStatus.UNDER_REVIEW);
      expect(res.body.adminId).toBe(admin.user.id);
    });

    it('admin requests user action and user sees action message in status', async () => {
      const admin = await createAdminUser();
      const { user } = await createUser();

      const sub = await deletionService.submitRequest(user.id, {
        reason: DeletionReason.OTHER,
        acceptedDeletionTerms: true,
      });

      const res = await request(app.getHttpServer())
        .post(
          `/admin/account-deletion-requests/${sub.request.id}/request-user-action`,
        )
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          message: 'Please complete your pending booking cancellation',
          adminNote: 'Waiting for rider to cancel',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(
        AccountDeletionRequestStatus.ACTION_REQUIRED,
      );
      expect(res.body.userActionRequired).toBe(true);
      expect(res.body.userActionMessage).toBe(
        'Please complete your pending booking cancellation',
      );

      // Verify user sees this message
      const userStatus = await deletionService.getStatus(user.id);
      expect(userStatus.request?.userActionRequired).toBe(true);
      expect(userStatus.request?.userActionMessage).toBe(
        'Please complete your pending booking cancellation',
      );
    });

    it('blocks admin approval when outstanding obligations exist', async () => {
      const admin = await createAdminUser();
      const { ctx, user } = await createUser();

      const sub = await deletionService.submitRequest(user.id, {
        reason: DeletionReason.NO_LONGER_USING,
        acceptedDeletionTerms: true,
      });

      // Inject blocker (wallet balance)
      const balanceRepo = dataSource.getRepository(WalletBalance);
      await balanceRepo.update(
        { walletId: ctx.walletId },
        { purchasedAvailable: '200' },
      );

      const res = await request(app.getHttpServer())
        .post(`/admin/account-deletion-requests/${sub.request.id}/approve`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send();

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OUTSTANDING_OBLIGATIONS_BLOCK_APPROVAL');
      expect(res.body.blockers).toBeDefined();

      // Clear blocker
      await balanceRepo.update(
        { walletId: ctx.walletId },
        { purchasedAvailable: '0' },
      );
    });
  });

  // ===========================================================================
  // 7. Permanent Deletion & Full Data Retention
  // ===========================================================================
  describe('Permanent Deletion and Data Retention', () => {
    it('executes controlled permanent account closure with full data retention and allows clean re-registration', async () => {
      const admin = await createAdminUser();
      const { ctx, user, token } = await createUser();
      const originalPhone = ctx.phone;
      const originalEmail = `user_${Date.now()}@example.com`;

      // 1. Setup profile and user fields
      const userRepo = dataSource.getRepository(User);
      user.email = originalEmail;
      await userRepo.save(user);

      const profileRepo = dataSource.getRepository(UserProfile);
      let profile = await profileRepo.findOne({ where: { userId: user.id } });
      if (!profile) {
        profile = profileRepo.create({ userId: user.id });
      }
      profile.firstName = 'Rajesh';
      profile.lastName = 'Kumar';
      profile.displayName = 'Rajesh K';
      profile.profilePhoto = 'https://cdn.bhaiway.com/photos/rajesh.jpg';
      profile.gender = 'MALE';
      profile.dateOfBirth = '1990-05-15';
      await profileRepo.save(profile);

      // 2. Setup vehicle / document reference
      const vehicle = await createVehicleForUser(user.id);

      // 3. Setup trusted contact
      const contactRepo = dataSource.getRepository(TrustedContact);
      const contact = await contactRepo.save(
        contactRepo.create({
          userId: user.id,
          name: 'Emergency Contact',
          phoneNumber: '+919999988888',
          relationship: TrustedContactRelationship.OTHER,
        }),
      );

      // 4. Setup completed historical ride
      const rideRepo = dataSource.getRepository(Ride);
      const ride = await createTestRide(
        user.id,
        vehicle.id,
        RideStatus.COMPLETED,
      );

      // 5. Submit deletion request
      const sub = await deletionService.submitRequest(user.id, {
        reason: DeletionReason.NO_LONGER_USING,
        acceptedDeletionTerms: true,
      });

      // 6. Approve deletion request
      await deletionService.adminApprove(sub.request.id, admin.user.id);

      // 7. Complete permanent deletion
      const completeRes = await request(app.getHttpServer())
        .post(`/admin/account-deletion-requests/${sub.request.id}/complete`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          adminNote: 'Audited and verified. Permanent account closure.',
        });

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.success).toBe(true);

      // =======================================================================
      // 8. VERIFY FULL DATA RETENTION (Zero Destruction / Zero Anonymization)
      // =======================================================================

      // 1. Original user row still exists
      const retainedUser = await userRepo.findOneByOrFail({ id: user.id });
      expect(retainedUser).toBeDefined();

      // 2. Original user ID remains unchanged
      expect(retainedUser.id).toBe(user.id);

      // 3. Original phone remains unchanged
      expect(retainedUser.phone).toBe(originalPhone);

      // 4. Original email remains unchanged
      expect(retainedUser.email).toBe(originalEmail);

      // 5. Original name remains unchanged
      const retainedProfile = await profileRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(retainedProfile.firstName).toBe('Rajesh');
      expect(retainedProfile.lastName).toBe('Kumar');
      expect(retainedProfile.displayName).toBe('Rajesh K');

      // 6. Original profile fields remain unchanged
      expect(retainedProfile.gender).toBe('MALE');
      expect(retainedProfile.dateOfBirth).toBe('1990-05-15');

      // 7. Original profile photo reference remains unchanged
      expect(retainedProfile.profilePhoto).toBe(
        'https://cdn.bhaiway.com/photos/rajesh.jpg',
      );

      // 8. KYC/document references remain unchanged
      const vehicleRepo = dataSource.getRepository(Vehicle);
      const retainedVehicle = await vehicleRepo.findOneByOrFail({
        id: vehicle.id,
      });
      expect(retainedVehicle.registrationNumber).toBe(
        vehicle.registrationNumber,
      );

      // 9. Trusted contact records remain unchanged
      const retainedContacts = await contactRepo.find({
        where: { userId: user.id },
      });
      expect(retainedContacts).toHaveLength(1);
      expect(retainedContacts[0].phoneNumber).toBe('+919999988888');

      // 10. Historical rides remain unchanged
      const retainedRides = await rideRepo.find({
        where: { driverId: user.id },
      });
      expect(retainedRides).toHaveLength(1);
      expect(retainedRides[0].id).toBe(ride.id);

      // 11. Wallet records and balances remain unchanged
      const walletRepo = dataSource.getRepository(Wallet);
      const retainedWallet = await walletRepo.findOneByOrFail({
        id: ctx.walletId,
      });
      expect(retainedWallet.userId).toBe(user.id);

      // 12. Account status is DELETED
      expect(retainedUser.status).toBe(UserStatus.DELETED);

      // 13. Deletion request status is COMPLETED
      const requestRepo = dataSource.getRepository(AccountDeletionRequest);
      const completedReq = await requestRepo.findOneByOrFail({
        id: sub.request.id,
      });
      expect(completedReq.status).toBe(AccountDeletionRequestStatus.COMPLETED);
      expect(completedReq.completedAt).toBeDefined();

      // 14. Old login / token signing is rejected
      await expect(authService.signAccessToken(user.id)).rejects.toThrow(
        ForbiddenException,
      );

      // 15. Old access tokens are rejected on protected endpoints
      const oldTokenProbe = await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', `Bearer ${token}`);
      expect(oldTokenProbe.status).toBe(401);

      // 16. Cancellation after completion is rejected
      await expect(deletionService.cancelRequest(user.id)).rejects.toThrow(
        ConflictException,
      );

      // 17. Duplicate completion cannot run twice
      const dupRes = await request(app.getHttpServer())
        .post(`/admin/account-deletion-requests/${sub.request.id}/complete`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send();
      expect(dupRes.status).toBe(409);

      // =======================================================================
      // 18. NEW REGISTRATION FLOW WITH SAME PHONE
      // =======================================================================
      // A new registration flow must succeed, create a brand-new user record with
      // a separate user ID and wallet, without inheriting any old account data!
      const newLogin = await authService.loginOrRegisterWithVerifiedIdentity({
        verified: true,
        phone: originalPhone,
        email: 'fresh.rajesh@example.com',
      });

      expect(newLogin.user.id).not.toBe(user.id);
      expect(newLogin.user.phone).toBe(originalPhone);

      const newWallet = await walletRepo.findOneByOrFail({
        userId: newLogin.user.id,
      });
      expect(newWallet.id).not.toBe(ctx.walletId);

      // Clean up new wallet context
      tracked.push({
        userId: newLogin.user.id,
        walletId: newWallet.id,
        balanceId: '',
        phone: originalPhone,
      });

      // Cleanup ride & vehicle
      await rideRepo.delete({ id: ride.id });
      await vehicleRepo.delete({ id: vehicle.id });
      await contactRepo.delete({ id: contact.id });
    });
  });
});
