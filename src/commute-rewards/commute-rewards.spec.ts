import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { ADMIN_PERMISSION_COMMUTE_REWARDS_MANAGE } from '../admin/admin.constants';
import { AdminModule } from '../admin/admin.module';
import { AdminUser } from '../admin/entities/admin-user.entity';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingMode,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { UsersModule } from '../users/users.module';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehicleType } from '../vehicles/enums/vehicle-type.enum';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { CommuteRewardProgressService } from './commute-reward-progress.service';
import { CommuteRewardsModule } from './commute-rewards.module';
import { CommuteRewardsService } from './commute-rewards.service';
import { CommuteRewardAuditLog } from './entities/commute-reward-audit-log.entity';
import { CommuteRewardCampaign } from './entities/commute-reward-campaign.entity';
import { CommuteRewardClaim } from './entities/commute-reward-claim.entity';
import { CommuteRewardMilestone } from './entities/commute-reward-milestone.entity';
import { CommuteRewardQualifyingTrip } from './entities/commute-reward-qualifying-trip.entity';
import {
  CommuteRewardCampaignStatus,
  CommuteRewardClaimStatus,
} from './enums/commute-reward.enums';
import { CommuteRewardAlreadyClaimedError } from './errors/commute-reward.errors';

describe('Office Commute driver rewards (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let rewardsService: CommuteRewardsService;
  let progressService: CommuteRewardProgressService;
  const tracked: TestWalletContext[] = [];
  const campaignIds: string[] = [];

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
        WalletModule,
        AdminModule,
        CommuteRewardsModule,
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
    rewardsService = moduleRef.get(CommuteRewardsService);
    progressService = moduleRef.get(CommuteRewardProgressService);
  });

  afterEach(async () => {
    if (campaignIds.length > 0) {
      const ids = [...campaignIds];
      campaignIds.length = 0;
      await dataSource
        .getRepository(CommuteRewardAuditLog)
        .createQueryBuilder()
        .delete()
        .where('campaign_id IN (:...ids)', { ids })
        .execute();
      await dataSource
        .getRepository(CommuteRewardClaim)
        .createQueryBuilder()
        .delete()
        .where('campaign_id IN (:...ids)', { ids })
        .execute();
      await dataSource
        .getRepository(CommuteRewardQualifyingTrip)
        .createQueryBuilder()
        .delete()
        .where('campaign_id IN (:...ids)', { ids })
        .execute();
      await dataSource
        .getRepository(CommuteRewardMilestone)
        .createQueryBuilder()
        .delete()
        .where('campaign_id IN (:...ids)', { ids })
        .execute();
      await dataSource
        .getRepository(CommuteRewardCampaign)
        .createQueryBuilder()
        .delete()
        .where('id IN (:...ids)', { ids })
        .execute();
    }

    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (!ctx) continue;
      await dataSource.getRepository(Booking).delete({ passengerId: ctx.userId });
      const rides = await dataSource
        .getRepository(Ride)
        .find({ where: { driverId: ctx.userId } });
      for (const ride of rides) {
        await dataSource.getRepository(Booking).delete({ rideId: ride.id });
      }
      await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
      await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
      await dataSource.getRepository(AdminUser).delete({ userId: ctx.userId });
      await cleanupTestWallet(dataSource, ctx);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  async function trackUser(): Promise<TestWalletContext> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return ctx;
  }

  async function login(userId: string): Promise<string> {
    return authService.signAccessToken(userId);
  }

  async function ensureAdmin(userId: string): Promise<void> {
    const repo = dataSource.getRepository(AdminUser);
    let admin = await repo.findOne({ where: { userId } });
    if (!admin) {
      admin = repo.create({
        userId,
        username: `cr_admin_${userId.slice(0, 8)}`,
        passwordHash: 'x',
        permissions: [ADMIN_PERMISSION_COMMUTE_REWARDS_MANAGE],
        isActive: true,
      });
    } else {
      admin.permissions = Array.from(
        new Set([
          ...(admin.permissions ?? []),
          ADMIN_PERMISSION_COMMUTE_REWARDS_MANAGE,
        ]),
      );
      admin.isActive = true;
    }
    await repo.save(admin);
  }

  async function createVehicle(userId: string): Promise<Vehicle> {
    const repo = dataSource.getRepository(Vehicle);
    return repo.save(
      repo.create({
        userId,
        vehicleType: VehicleType.CAR,
        make: 'Test',
        model: 'Car',
        variant: null,
        registrationNumber: `CR${Date.now().toString(36).toUpperCase()}`,
        registrationYear: 2020,
        color: 'White',
        seatingCapacity: 4,
        isActive: true,
      }),
    );
  }

  async function createCompletedRide(opts: {
    driverId: string;
    vehicleId: string;
    rideType: RideType;
    completedAt: Date;
  }): Promise<Ride> {
    const repo = dataSource.getRepository(Ride);
    return repo.save(
      repo.create({
        driverId: opts.driverId,
        vehicleId: opts.vehicleId,
        rideType: opts.rideType,
        status: RideStatus.COMPLETED,
        source: 'A',
        destination: 'B',
        departureDate: '2026-01-15',
        departureTime: '09:00:00',
        totalSeats: 3,
        availableSeats: 0,
        pricePerSeat: '100',
        completedAt: opts.completedAt,
      }),
    );
  }

  async function addPassengerBooking(opts: {
    rideId: string;
    passengerId: string;
    status: BookingStatus;
    pickupStatus: BookingPickupStatus | null;
    bookingMode?: BookingMode;
  }): Promise<Booking> {
    const repo = dataSource.getRepository(Booking);
    return repo.save(
      repo.create({
        rideId: opts.rideId,
        passengerId: opts.passengerId,
        seats: 1,
        status: opts.status,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
        paymentStatus: BookingPaymentStatus.PAID,
        pricePerSeatSnapshot: '100',
        totalAmount: '100',
        bookingMode: opts.bookingMode ?? BookingMode.COMMUTE,
        pickupStatus: opts.pickupStatus,
        driverPricePerSeatSnapshot: '90',
        riderPricePerSeatSnapshot: '100',
      }),
    );
  }

  async function createActiveCampaign(adminId: string, overrides?: {
    startsAt?: Date;
    endsAt?: Date;
    status?: CommuteRewardCampaignStatus;
    milestones?: Array<{
      sortOrder: number;
      title: string;
      requiredTrips: number;
      windowMonths: number;
      prizeValueCapInr: number;
    }>;
  }) {
    const startsAt =
      overrides?.startsAt ?? new Date(Date.now() - 24 * 3600_000);
    const endsAt =
      overrides?.endsAt ?? new Date(Date.now() + 365 * 24 * 3600_000);
    const detail = await rewardsService.createCampaign(adminId, {
      title: `Campaign ${randomUUID().slice(0, 8)}`,
      timezone: 'Asia/Kolkata',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      milestones: overrides?.milestones ?? [
        {
          sortOrder: 1,
          title: 'Level 1',
          requiredTrips: 42,
          windowMonths: 1,
          prizeValueCapInr: 1000,
        },
        {
          sortOrder: 2,
          title: 'Level 2',
          requiredTrips: 250,
          windowMonths: 6,
          prizeValueCapInr: 5000,
        },
        {
          sortOrder: 3,
          title: 'Level 3',
          requiredTrips: 450,
          windowMonths: 12,
          prizeValueCapInr: 8000,
        },
      ],
    });
    campaignIds.push(detail.id);
    if (overrides?.status === CommuteRewardCampaignStatus.ACTIVE) {
      return rewardsService.setCampaignStatus(
        adminId,
        detail.id,
        CommuteRewardCampaignStatus.ACTIVE,
      );
    }
    if (overrides?.status) {
      // Activate first if needed for PAUSED/ENDED tests.
      if (
        overrides.status === CommuteRewardCampaignStatus.PAUSED ||
        overrides.status === CommuteRewardCampaignStatus.ENDED
      ) {
        await rewardsService.setCampaignStatus(
          adminId,
          detail.id,
          CommuteRewardCampaignStatus.ACTIVE,
        );
      }
      return rewardsService.setCampaignStatus(
        adminId,
        detail.id,
        overrides.status,
      );
    }
    return detail;
  }

  async function seedTrips(
    campaignId: string,
    driverId: string,
    count: number,
    completedAt: Date,
  ) {
    const repo = dataSource.getRepository(CommuteRewardQualifyingTrip);
    const campaign = await dataSource
      .getRepository(CommuteRewardCampaign)
      .findOneOrFail({ where: { id: campaignId } });
    for (let i = 0; i < count; i++) {
      await repo.save(
        repo.create({
          campaignId,
          driverId,
          rideId: randomUUID(),
          completedPassengerCount: 2,
          completedAt: new Date(completedAt.getTime() + i * 1000),
          campaignConfigVersion: campaign.configVersion,
        }),
      );
    }
  }

  it('counts a successful Office Commute ride with two completed passengers once', async () => {
    const driver = await trackUser();
    const p1 = await trackUser();
    const p2 = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    const vehicle = await createVehicle(driver.userId);
    const completedAt = new Date();
    const ride = await createCompletedRide({
      driverId: driver.userId,
      vehicleId: vehicle.id,
      rideType: RideType.COMMUTE,
      completedAt,
    });
    await addPassengerBooking({
      rideId: ride.id,
      passengerId: p1.userId,
      status: BookingStatus.COMPLETED,
      pickupStatus: BookingPickupStatus.PICKED_UP,
    });
    await addPassengerBooking({
      rideId: ride.id,
      passengerId: p2.userId,
      status: BookingStatus.COMPLETED,
      pickupStatus: BookingPickupStatus.PICKED_UP,
    });

    const first = await dataSource.transaction((m) =>
      progressService.recordQualifyingRideInTransaction(m, ride),
    );
    expect(first.recorded).toBe(1);

    const second = await dataSource.transaction((m) =>
      progressService.recordQualifyingRideInTransaction(m, ride),
    );
    expect(second.recorded).toBe(0);

    const total = await progressService.totalQualifyingTrips(
      campaign.id,
      driver.userId,
    );
    expect(total).toBe(1);
  });

  it('does not count a ride with only one completed passenger', async () => {
    const driver = await trackUser();
    const p1 = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    const vehicle = await createVehicle(driver.userId);
    const ride = await createCompletedRide({
      driverId: driver.userId,
      vehicleId: vehicle.id,
      rideType: RideType.COMMUTE,
      completedAt: new Date(),
    });
    await addPassengerBooking({
      rideId: ride.id,
      passengerId: p1.userId,
      status: BookingStatus.COMPLETED,
      pickupStatus: BookingPickupStatus.PICKED_UP,
    });

    const result = await dataSource.transaction((m) =>
      progressService.recordQualifyingRideInTransaction(m, ride),
    );
    expect(result.recorded).toBe(0);
    expect(result.skippedReason).toBe('insufficient_passengers');
  });

  it('does not count an empty ride', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    const vehicle = await createVehicle(driver.userId);
    const ride = await createCompletedRide({
      driverId: driver.userId,
      vehicleId: vehicle.id,
      rideType: RideType.COMMUTE,
      completedAt: new Date(),
    });

    const result = await dataSource.transaction((m) =>
      progressService.recordQualifyingRideInTransaction(m, ride),
    );
    expect(result.recorded).toBe(0);
    expect(result.skippedReason).toBe('insufficient_passengers');
  });

  it('does not count a non-Office-Commute ride', async () => {
    const driver = await trackUser();
    const p1 = await trackUser();
    const p2 = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    const vehicle = await createVehicle(driver.userId);
    const ride = await createCompletedRide({
      driverId: driver.userId,
      vehicleId: vehicle.id,
      rideType: RideType.REGULAR,
      completedAt: new Date(),
    });
    await addPassengerBooking({
      rideId: ride.id,
      passengerId: p1.userId,
      status: BookingStatus.COMPLETED,
      pickupStatus: BookingPickupStatus.PICKED_UP,
      bookingMode: BookingMode.REGULAR,
    });
    await addPassengerBooking({
      rideId: ride.id,
      passengerId: p2.userId,
      status: BookingStatus.COMPLETED,
      pickupStatus: BookingPickupStatus.PICKED_UP,
      bookingMode: BookingMode.REGULAR,
    });

    const result = await dataSource.transaction((m) =>
      progressService.recordQualifyingRideInTransaction(m, ride),
    );
    expect(result.recorded).toBe(0);
    expect(result.skippedReason).toBe('not_commute');
  });

  it('grants Level 1 eligibility at exactly 42 qualifying trips', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    await seedTrips(campaign.id, driver.userId, 42, new Date());
    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l1 = progress.milestones.find((m) => m.sortOrder === 1)!;
    expect(l1.tripCountInWindow).toBe(42);
    expect(l1.thresholdMet).toBe(true);
    expect(l1.canClaim).toBe(true);
    expect(progress.totalQualifyingTrips).toBe(42);
  });

  it('grants Level 2 eligibility at exactly 250 cumulative trips in window', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    await seedTrips(campaign.id, driver.userId, 250, new Date());
    // Approve L1 first so L2 canClaim reflects threshold+sequence.
    const progressBefore = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l1 = progressBefore.milestones.find((m) => m.sortOrder === 1)!;
    const claim = await rewardsService.claimMilestone(
      driver.userId,
      campaign.id,
      l1.milestoneId,
    );
    await rewardsService.reviewClaim(admin.userId, claim.id, {
      decision: 'APPROVE',
    });

    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l2 = progress.milestones.find((m) => m.sortOrder === 2)!;
    expect(l2.tripCountInWindow).toBe(250);
    expect(l2.thresholdMet).toBe(true);
    expect(l2.canClaim).toBe(true);
  });

  it('grants Level 3 eligibility at exactly 450 cumulative trips in window', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    await seedTrips(campaign.id, driver.userId, 450, new Date());
    const progress0 = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l1 = progress0.milestones.find((m) => m.sortOrder === 1)!;
    const c1 = await rewardsService.claimMilestone(
      driver.userId,
      campaign.id,
      l1.milestoneId,
    );
    await rewardsService.reviewClaim(admin.userId, c1.id, {
      decision: 'APPROVE',
    });
    const progress1 = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l2 = progress1.milestones.find((m) => m.sortOrder === 2)!;
    const c2 = await rewardsService.claimMilestone(
      driver.userId,
      campaign.id,
      l2.milestoneId,
    );
    await rewardsService.reviewClaim(admin.userId, c2.id, {
      decision: 'APPROVE',
    });

    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l3 = progress.milestones.find((m) => m.sortOrder === 3)!;
    expect(l3.tripCountInWindow).toBe(450);
    expect(l3.thresholdMet).toBe(true);
    expect(l3.canClaim).toBe(true);
  });

  it('cannot claim Level 1 twice and claiming does not reset cumulative progress', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    await seedTrips(campaign.id, driver.userId, 42, new Date());
    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l1 = progress.milestones.find((m) => m.sortOrder === 1)!;
    await rewardsService.claimMilestone(
      driver.userId,
      campaign.id,
      l1.milestoneId,
    );
    await expect(
      rewardsService.claimMilestone(
        driver.userId,
        campaign.id,
        l1.milestoneId,
      ),
    ).rejects.toBeInstanceOf(CommuteRewardAlreadyClaimedError);

    const after = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    expect(after.totalQualifyingTrips).toBe(42);
  });

  it('cannot claim a higher milestone before preceding is successfully claimed', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    await seedTrips(campaign.id, driver.userId, 250, new Date());
    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l2 = progress.milestones.find((m) => m.sortOrder === 2)!;
    await expect(
      rewardsService.claimMilestone(
        driver.userId,
        campaign.id,
        l2.milestoneId,
      ),
    ).rejects.toThrow(/preceding/i);
  });

  it('concurrent claim requests create no duplicate claims', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    await seedTrips(campaign.id, driver.userId, 42, new Date());
    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l1 = progress.milestones.find((m) => m.sortOrder === 1)!;

    const results = await Promise.allSettled([
      rewardsService.claimMilestone(
        driver.userId,
        campaign.id,
        l1.milestoneId,
      ),
      rewardsService.claimMilestone(
        driver.userId,
        campaign.id,
        l1.milestoneId,
      ),
      rewardsService.claimMilestone(
        driver.userId,
        campaign.id,
        l1.milestoneId,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(2);

    const count = await dataSource.getRepository(CommuteRewardClaim).count({
      where: {
        campaignId: campaign.id,
        driverId: driver.userId,
        milestoneId: l1.milestoneId,
      },
    });
    expect(count).toBe(1);
  });

  it('campaigns outside their date range cannot grant new rewards', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
      milestones: [
        {
          sortOrder: 1,
          title: 'Level 1',
          requiredTrips: 1,
          windowMonths: 12,
          prizeValueCapInr: 1000,
        },
      ],
    });
    await dataSource.getRepository(CommuteRewardCampaign).update(campaign.id, {
      endsAt: new Date(Date.now() - 24 * 3600_000),
    });
    await seedTrips(
      campaign.id,
      driver.userId,
      5,
      new Date(Date.now() - 5 * 24 * 3600_000),
    );
    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l1 = progress.milestones[0];
    expect(l1.canClaim).toBe(false);
    await expect(
      rewardsService.claimMilestone(
        driver.userId,
        campaign.id,
        l1.milestoneId,
      ),
    ).rejects.toThrow(/date range|eligible/i);
  });

  it('admin-only APIs reject ordinary drivers', async () => {
    const driver = await trackUser();
    const token = await login(driver.userId);
    await request(app.getHttpServer())
      .get('/admin/commute-rewards/campaigns')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('drivers cannot query progress using another driver id (JWT identity only)', async () => {
    const driver = await trackUser();
    const other = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    await seedTrips(campaign.id, other.userId, 10, new Date());
    const token = await login(driver.userId);

    const res = await request(app.getHttpServer())
      .get(`/commute-rewards/campaigns/${campaign.id}/progress`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.driverId).toBe(driver.userId);
    expect(res.body.totalQualifyingTrips).toBe(0);
  });

  it('paused and ended campaigns block new claims', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
      milestones: [
        {
          sortOrder: 1,
          title: 'Level 1',
          requiredTrips: 5,
          windowMonths: 12,
          prizeValueCapInr: 1000,
        },
      ],
    });
    await seedTrips(campaign.id, driver.userId, 5, new Date());
    await rewardsService.setCampaignStatus(
      admin.userId,
      campaign.id,
      CommuteRewardCampaignStatus.PAUSED,
    );
    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    expect(progress.milestones[0].canClaim).toBe(false);
    await expect(
      rewardsService.claimMilestone(
        driver.userId,
        campaign.id,
        progress.milestones[0].milestoneId,
      ),
    ).rejects.toThrow(/not active/i);

    await rewardsService.setCampaignStatus(
      admin.userId,
      campaign.id,
      CommuteRewardCampaignStatus.ACTIVE,
    );
    await rewardsService.setCampaignStatus(
      admin.userId,
      campaign.id,
      CommuteRewardCampaignStatus.ENDED,
    );
    await expect(
      rewardsService.claimMilestone(
        driver.userId,
        campaign.id,
        progress.milestones[0].milestoneId,
      ),
    ).rejects.toThrow(/not active/i);
  });

  it('failed claim eligibility leaves no partial claim row', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
    });
    // Only 10 trips — below threshold.
    await seedTrips(campaign.id, driver.userId, 10, new Date());
    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const l1 = progress.milestones.find((m) => m.sortOrder === 1)!;
    await expect(
      rewardsService.claimMilestone(
        driver.userId,
        campaign.id,
        l1.milestoneId,
      ),
    ).rejects.toThrow(/Need 42/);

    const count = await dataSource.getRepository(CommuteRewardClaim).count({
      where: { campaignId: campaign.id, driverId: driver.userId },
    });
    expect(count).toBe(0);
  });

  it('admin can approve and fulfil a claim; ACTIVE milestones are immutable', async () => {
    const driver = await trackUser();
    const admin = await trackUser();
    await ensureAdmin(admin.userId);
    const adminToken = await login(admin.userId);
    const campaign = await createActiveCampaign(admin.userId, {
      status: CommuteRewardCampaignStatus.ACTIVE,
      milestones: [
        {
          sortOrder: 1,
          title: 'Level 1',
          requiredTrips: 3,
          windowMonths: 12,
          prizeValueCapInr: 1000,
        },
      ],
    });
    await seedTrips(campaign.id, driver.userId, 3, new Date());
    const progress = await rewardsService.buildDriverProgress(
      campaign.id,
      driver.userId,
    );
    const claim = await rewardsService.claimMilestone(
      driver.userId,
      campaign.id,
      progress.milestones[0].milestoneId,
    );
    expect(claim.status).toBe(CommuteRewardClaimStatus.UNDER_REVIEW);

    const approved = await rewardsService.reviewClaim(admin.userId, claim.id, {
      decision: 'APPROVE',
    });
    expect(approved.status).toBe(CommuteRewardClaimStatus.APPROVED);

    const fulfilled = await rewardsService.fulfilClaim(admin.userId, claim.id, {
      notes: 'Prize couriered',
    });
    expect(fulfilled.status).toBe(CommuteRewardClaimStatus.FULFILLED);

    await request(app.getHttpServer())
      .patch(
        `/admin/commute-rewards/campaigns/${campaign.id}/milestones/${progress.milestones[0].milestoneId}`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ requiredTrips: 99 })
      .expect(422);
  });
});
