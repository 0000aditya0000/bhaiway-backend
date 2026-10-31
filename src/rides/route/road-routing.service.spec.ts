import { ConfigService } from '@nestjs/config';
import { coordinatePairKey, RoadRoutingService } from './road-routing.service';
import { LatLng } from './route-geometry';

describe('RoadRoutingService', () => {
  let service: RoadRoutingService;
  let mockConfigService: Partial<ConfigService>;
  let mockRedis: {
    status: string;
    get: jest.Mock;
    set: jest.Mock;
  };

  const NOIDA: LatLng = { latitude: 28.5355, longitude: 77.391 };
  const GHAZIABAD: LatLng = { latitude: 28.6692, longitude: 77.4538 };

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'ROUTING_PROVIDER') return 'mock';
        if (key === 'ROUTING_TIMEOUT_MS') return 3000;
        if (key === 'ROUTING_CACHE_TTL_SECONDS') return 86400;
        if (key === 'ROUTING_NEGATIVE_CACHE_TTL_SECONDS') return 300;
        return undefined;
      }),
    };

    mockRedis = {
      status: 'ready',
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    service = new RoadRoutingService(
      mockConfigService as ConfigService,
      mockRedis as unknown as import('ioredis').default,
    );
  });

  describe('Single-pair driving distance resolution', () => {
    it('calculates driving distance using default mock provider', async () => {
      const res = await service.getDrivingDistance(NOIDA, GHAZIABAD);
      expect(res.status).toBe('OK');
      expect(res.provider).toBe('mock');
      expect(res.distanceMeters).toBeGreaterThan(10000);
      expect(res.source).toBe('mock');
    });

    it('caches successful result in memory and Redis', async () => {
      const key = coordinatePairKey(NOIDA, GHAZIABAD);

      const first = await service.getDrivingDistance(NOIDA, GHAZIABAD);
      expect(first.status).toBe('OK');
      expect(mockRedis.set).toHaveBeenCalledWith(
        key,
        expect.stringContaining('"distanceMeters"'),
        'EX',
        86400,
      );

      // Second call should return from in-memory cache without hitting provider
      const second = await service.getDrivingDistance(NOIDA, GHAZIABAD);
      expect(second.source).toBe('cache');
      expect(second.distanceMeters).toBe(first.distanceMeters);
    });

    it('reads from Redis cache on memory miss', async () => {
      const key = coordinatePairKey(NOIDA, GHAZIABAD);
      mockRedis.get.mockResolvedValueOnce(
        JSON.stringify({
          distanceMeters: 18500,
          durationSeconds: 1500,
          status: 'OK',
          provider: 'google',
          source: 'network',
        }),
      );

      const res = await service.getDrivingDistance(NOIDA, GHAZIABAD);
      expect(mockRedis.get).toHaveBeenCalledWith(key);
      expect(res.source).toBe('cache');
      expect(res.distanceMeters).toBe(18500);
      expect(res.provider).toBe('google');
    });

    it('coalesces concurrent requests for the same coordinates into a single flight', async () => {
      let callCount = 0;
      service.setMockRouteHandler(async () => {
        callCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          distanceMeters: 22000,
          status: 'OK',
          provider: 'mock',
          source: 'network',
        };
      });

      // Launch 3 simultaneous requests for the exact same pair
      const [res1, res2, res3] = await Promise.all([
        service.getDrivingDistance(NOIDA, GHAZIABAD),
        service.getDrivingDistance(NOIDA, GHAZIABAD),
        service.getDrivingDistance(NOIDA, GHAZIABAD),
      ]);

      expect(callCount).toBe(1); // Provider only called once
      expect(res1.distanceMeters).toBe(22000);
      expect(res2.distanceMeters).toBe(22000);
      expect(res3.distanceMeters).toBe(22000);
    });

    it('caches NO_ROUTE with negative cache TTL (5 minutes)', async () => {
      const key = coordinatePairKey(NOIDA, GHAZIABAD);
      service.setMockRouteHandler(() => ({
        distanceMeters: null,
        status: 'NO_ROUTE',
        provider: 'mock',
        source: 'network',
      }));

      const res = await service.getDrivingDistance(NOIDA, GHAZIABAD);
      expect(res.status).toBe('NO_ROUTE');
      expect(mockRedis.set).toHaveBeenCalledWith(
        key,
        expect.stringContaining('"NO_ROUTE"'),
        'EX',
        300,
      );
    });

    it('handles Redis error gracefully without failing distance query', async () => {
      mockRedis.get.mockRejectedValueOnce(
        new Error('Redis connection refused'),
      );
      mockRedis.set.mockRejectedValueOnce(
        new Error('Redis connection refused'),
      );

      const res = await service.getDrivingDistance(NOIDA, GHAZIABAD);
      expect(res.status).toBe('OK');
      expect(res.distanceMeters).toBeGreaterThan(0);
    });
  });

  describe('Batch driving distance resolution', () => {
    it('resolves multiple pairs with deduplication', async () => {
      const pairs = [
        { origin: NOIDA, destination: GHAZIABAD },
        { origin: NOIDA, destination: GHAZIABAD }, // duplicate
        { origin: GHAZIABAD, destination: NOIDA },
      ];

      const results = await service.getDrivingDistances(pairs);
      expect(results.size).toBe(2);

      const key1 = coordinatePairKey(NOIDA, GHAZIABAD);
      const key2 = coordinatePairKey(GHAZIABAD, NOIDA);
      expect(results.has(key1)).toBe(true);
      expect(results.has(key2)).toBe(true);
    });
  });
});
