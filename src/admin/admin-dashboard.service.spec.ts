import { AdminDashboardService } from './admin-dashboard.service';
import { AdminLiveMapFilter } from './dto/admin-dashboard-query.dto';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { WalletTransactionType } from '../wallet/entities/wallet-transaction.entity';
import { PLATFORM_WALLET_ID } from '../wallet/platform-wallet.constants';

describe('AdminDashboardService', () => {
  function makeService(overrides: Record<string, any> = {}) {
    const rideRepository = {
      createQueryBuilder: jest.fn(),
      count: jest.fn(),
    };
    const userRepository = {
      createQueryBuilder: jest.fn(),
    };
    const verificationRepository = {
      query: jest.fn(),
    };
    const walletTransactionRepository = {
      createQueryBuilder: jest.fn(),
    };
    const trackingService = {
      getStoredLocationsForRides: jest.fn().mockResolvedValue(new Map()),
    };
    const adminAlertService = {
      getAttentionSummary: jest.fn().mockResolvedValue({
        critical: 1,
        warning: 2,
        total: 3,
        alerts: [
          {
            id: 'a1',
            category: 'VEHICLE_VERIFICATION',
            severity: 'CRITICAL',
            status: 'OPEN',
            title: 'RC Verification unavailable',
            message: 'RC Verification API unavailable',
            source: 'cashfree-vehicle-rc',
            createdAt: new Date('2026-03-20T10:00:00.000Z'),
          },
        ],
      }),
      getRecentActivity: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'e1',
            eventType: 'ALERT_OPENED',
            category: 'VEHICLE_VERIFICATION',
            severity: 'CRITICAL',
            title: 'New high-priority alert',
            description: 'RC Verification unavailable',
            createdAt: new Date('2026-03-20T10:00:00.000Z'),
          },
        ],
        nextCursor: null,
      }),
    };

    const service = new AdminDashboardService(
      rideRepository as any,
      userRepository as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      verificationRepository as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      walletTransactionRepository as any,
      trackingService as any,
      adminAlertService as any,
    );

    return {
      service,
      rideRepository,
      userRepository,
      verificationRepository,
      walletTransactionRepository,
      trackingService,
      adminAlertService,
      ...overrides,
    };
  }

  function mockCountQb(count: number) {
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(count),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
  }

  it('aggregates summary metrics and attention without leaking secrets', async () => {
    const ctx = makeService();
    const rideQb = mockCountQb(4);
    ctx.rideRepository.createQueryBuilder.mockReturnValue(rideQb);
    ctx.rideRepository.count.mockResolvedValue(2);
    ctx.userRepository.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(100),
    });
    ctx.verificationRepository.query.mockResolvedValue([{ count: 12 }]);

    const revenueQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: '250' }),
    };
    ctx.walletTransactionRepository.createQueryBuilder.mockReturnValue(revenueQb);

    const summary = await ctx.service.getSummary();

    expect(summary.period.timezone).toBe('Asia/Kolkata');
    expect(summary.metrics.revenueToday).toBe(250);
    expect(summary.metrics.activeRidesNow).toBe(2);
    expect(summary.metrics.users).toBe(100);
    expect(summary.metrics.drivers).toBe(12);
    expect(summary.attention).toEqual(
      expect.objectContaining({ critical: 1, warning: 2, total: 3 }),
    );
    expect(summary.attention.alerts[0].title).toBe('RC Verification unavailable');
    expect(summary.recentActivity[0].title).toBe('New high-priority alert');

    const payload = JSON.stringify(summary);
    expect(payload).not.toMatch(/client_secret|password|otp|aadhaar/i);

    expect(revenueQb.where).toHaveBeenCalledWith(
      'tx.wallet_id = :walletId',
      expect.objectContaining({ walletId: PLATFORM_WALLET_ID }),
    );
    expect(revenueQb.andWhere).toHaveBeenCalledWith(
      'tx.transaction_type IN (:...types)',
      expect.objectContaining({
        types: expect.arrayContaining([
          WalletTransactionType.COMMUTE_PLATFORM_MARGIN,
        ]),
      }),
    );
  });

  it('SOS live-map filter returns empty without querying rides', async () => {
    const ctx = makeService();
    const result = await ctx.service.getLiveMap(AdminLiveMapFilter.SOS);
    expect(result).toEqual({ filter: 'SOS', items: [] });
    expect(ctx.rideRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('filters OFFICE_COMMUTE to COMMUTE IN_PROGRESS rides', async () => {
    const ctx = makeService();
    const qb = mockCountQb(0);
    qb.getMany.mockResolvedValue([
      {
        id: 'ride-1',
        rideType: RideType.COMMUTE,
        status: RideStatus.IN_PROGRESS,
        driverId: 'd1',
        vehicleId: 'v1',
      },
    ]);
    ctx.rideRepository.createQueryBuilder.mockReturnValue(qb);
    ctx.trackingService.getStoredLocationsForRides.mockResolvedValue(
      new Map([
        [
          'ride-1',
          {
            latitude: 28.6,
            longitude: 77.2,
            updatedAt: '2026-03-20T10:00:00.000Z',
            heading: 90,
            speed: 20,
          },
        ],
      ]),
    );

    const result = await ctx.service.getLiveMap(
      AdminLiveMapFilter.OFFICE_COMMUTE,
    );
    expect(qb.andWhere).toHaveBeenCalledWith('ride.ride_type = :type', {
      type: RideType.COMMUTE,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      rideId: 'ride-1',
      latitude: 28.6,
      longitude: 77.2,
      sosActive: false,
    });
    expect(result.items[0]).not.toHaveProperty('clientSecret');
  });

  it('filters OUTSTATION to REGULAR + ASSURED (no OUTSTATION type exists)', async () => {
    const ctx = makeService();
    const qb = mockCountQb(0);
    ctx.rideRepository.createQueryBuilder.mockReturnValue(qb);
    await ctx.service.getLiveMap(AdminLiveMapFilter.OUTSTATION);
    expect(qb.andWhere).toHaveBeenCalledWith('ride.ride_type IN (:...types)', {
      types: [RideType.REGULAR, RideType.ASSURED],
    });
  });
});
