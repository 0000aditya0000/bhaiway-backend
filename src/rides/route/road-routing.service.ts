import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../../tracking/tracking.constants';
import { haversineMeters, LatLng } from './route-geometry';
import {
  CoordinatePair,
  IRoadRoutingProvider,
  RoadDistanceResult,
} from './road-routing.interface';

export const DEFAULT_ROUTING_TIMEOUT_MS = 3_000;
export const DEFAULT_ROUTING_MAX_CONCURRENCY = 5;
export const DEFAULT_ROUTING_MAX_CANDIDATES = 20;
export const DEFAULT_ROUTING_CACHE_TTL_SECONDS = 86_400; // 24 hours
export const DEFAULT_ROUTING_NEGATIVE_CACHE_TTL_SECONDS = 300; // 5 minutes

export function coordinatePairKey(origin: LatLng, destination: LatLng): string {
  const oLat = origin.latitude.toFixed(4);
  const oLng = origin.longitude.toFixed(4);
  const dLat = destination.latitude.toFixed(4);
  const dLng = destination.longitude.toFixed(4);
  return `routing:drive:${oLat},${oLng}:${dLat},${dLng}`;
}

type MemoryCacheEntry = {
  result: RoadDistanceResult;
  expiresAt: number;
};

type MockRouteHandler = (
  origin: LatLng,
  destination: LatLng,
) => Promise<RoadDistanceResult | null> | RoadDistanceResult | null;

@Injectable()
export class RoadRoutingService {
  private readonly logger = new Logger('RoadRouting');
  private readonly memoryCache = new Map<string, MemoryCacheEntry>();
  private readonly inFlight = new Map<string, Promise<RoadDistanceResult>>();
  private customMockHandler?: MockRouteHandler;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * For tests only: register a deterministic mock handler.
   */
  setMockRouteHandler(handler?: MockRouteHandler): void {
    this.customMockHandler = handler;
  }

  /**
   * Clear in-memory cache (for testing or maintenance).
   */
  clearMemoryCache(): void {
    this.memoryCache.clear();
  }

  /**
   * Main entrypoint: batch resolves driving distances for multiple origin/destination pairs.
   * Handles deduplication, caching (memory + Redis), bounded concurrency, and timeouts.
   */
  async getDrivingDistances(
    pairs: CoordinatePair[],
  ): Promise<Map<string, RoadDistanceResult>> {
    const results = new Map<string, RoadDistanceResult>();
    if (pairs.length === 0) {
      return results;
    }

    const maxCandidates = this.getMaxCandidatesPerSearch();
    const candidateSubset = pairs.slice(0, maxCandidates);

    // 1. Deduplicate unique pairs
    const uniquePairs = new Map<string, CoordinatePair>();
    for (const pair of candidateSubset) {
      const key = coordinatePairKey(pair.origin, pair.destination);
      if (!uniquePairs.has(key)) {
        uniquePairs.set(key, pair);
      }
    }

    // 2. Resolve cached and uncached pairs
    const uncachedEntries: Array<{ key: string; pair: CoordinatePair }> = [];
    for (const [key, pair] of uniquePairs.entries()) {
      const cached = await this.getCachedResult(key);
      if (cached) {
        results.set(key, { ...cached, source: 'cache' });
      } else {
        uncachedEntries.push({ key, pair });
      }
    }

    const cacheHits = results.size;
    const cacheMisses = uncachedEntries.length;

    // 3. Resolve uncached pairs with bounded concurrency
    if (uncachedEntries.length > 0) {
      const concurrency = this.getMaxConcurrency();
      const resolvedList = await this.executeWithConcurrency(
        uncachedEntries.map(({ key, pair }) => async () => {
          const res = await this.getOrFetchDistance(
            key,
            pair.origin,
            pair.destination,
          );
          return { key, res };
        }),
        concurrency,
      );

      for (const item of resolvedList) {
        results.set(item.key, item.res);
      }
    }

    this.logger.debug(
      `[RoadRouting] Batch resolved total=${candidateSubset.length} unique=${uniquePairs.size} cacheHits=${cacheHits} misses=${cacheMisses}`,
    );

    return results;
  }

  /**
   * Resolve a single origin/destination driving distance with caching and single-flight coalescing.
   */
  async getDrivingDistance(
    origin: LatLng,
    destination: LatLng,
  ): Promise<RoadDistanceResult> {
    const key = coordinatePairKey(origin, destination);
    const cached = await this.getCachedResult(key);
    if (cached) {
      return { ...cached, source: 'cache' };
    }
    return this.getOrFetchDistance(key, origin, destination);
  }

  private async getOrFetchDistance(
    key: string,
    origin: LatLng,
    destination: LatLng,
  ): Promise<RoadDistanceResult> {
    // Single-flight deduplication
    const existingPromise = this.inFlight.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    const fetchPromise = this.fetchAndCacheDistance(key, origin, destination);
    this.inFlight.set(key, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fetchAndCacheDistance(
    key: string,
    origin: LatLng,
    destination: LatLng,
  ): Promise<RoadDistanceResult> {
    const provider = this.resolveProvider();
    const timeoutMs = this.getTimeoutMs();

    const start = Date.now();
    let result: RoadDistanceResult;
    try {
      result = await provider.calculateDrivingDistance(
        origin,
        destination,
        timeoutMs,
      );
    } catch (error) {
      const elapsed = Date.now() - start;
      const isTimeout =
        (error instanceof Error && error.name === 'AbortError') ||
        elapsed >= timeoutMs;
      result = {
        distanceMeters: null,
        status: isTimeout ? 'TIMEOUT' : 'PROVIDER_ERROR',
        provider: provider.name,
        source: 'network',
        errorMessage:
          error instanceof Error ? error.message : 'Unknown routing error',
      };
      this.logger.warn(
        `[RoadRouting] Provider ${provider.name} failed (${result.status}) for ${key}: ${result.errorMessage}`,
      );
    }

    // Cache according to status
    if (result.status === 'OK' && result.distanceMeters != null) {
      await this.setCachedResult(key, result, this.getCacheTtlSeconds());
    } else if (result.status === 'NO_ROUTE') {
      await this.setCachedResult(
        key,
        result,
        this.getNegativeCacheTtlSeconds(),
      );
    }

    return result;
  }

  private async getCachedResult(
    key: string,
  ): Promise<RoadDistanceResult | null> {
    // 1. Check in-memory cache
    const now = Date.now();
    const mem = this.memoryCache.get(key);
    if (mem) {
      if (mem.expiresAt > now) {
        return mem.result;
      }
      this.memoryCache.delete(key);
    }

    // 2. Check Redis cache if available
    if (this.redis && this.isRedisReady()) {
      try {
        const raw = await this.redis.get(key);
        if (raw) {
          const parsed = JSON.parse(raw) as RoadDistanceResult;
          // Hydrate memory cache for fast subsequent reads
          this.memoryCache.set(key, {
            result: parsed,
            expiresAt: now + 60_000, // 1 minute local window
          });
          return parsed;
        }
      } catch (error) {
        this.logger.warn(
          `[RoadRouting] Redis GET failed for key=${key}: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
      }
    }

    return null;
  }

  private async setCachedResult(
    key: string,
    result: RoadDistanceResult,
    ttlSeconds: number,
  ): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1_000;
    this.memoryCache.set(key, { result, expiresAt });

    // Prune memory cache if it grows too large
    if (this.memoryCache.size > 2_000) {
      this.pruneMemoryCache();
    }

    // Save to Redis
    if (this.redis && this.isRedisReady()) {
      try {
        await this.redis.set(key, JSON.stringify(result), 'EX', ttlSeconds);
      } catch (error) {
        this.logger.warn(
          `[RoadRouting] Redis SET failed for key=${key}: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
      }
    }
  }

  private pruneMemoryCache(): void {
    const now = Date.now();
    for (const [k, v] of this.memoryCache.entries()) {
      if (v.expiresAt <= now) {
        this.memoryCache.delete(k);
      }
    }
  }

  private isRedisReady(): boolean {
    return Boolean(this.redis && String(this.redis.status) === 'ready');
  }

  private resolveProvider(): IRoadRoutingProvider {
    // Priority: custom mock handler (for unit/integration tests)
    if (this.customMockHandler) {
      return {
        name: 'mock',
        calculateDrivingDistance: async (origin, dest) => {
          const custom = await this.customMockHandler!(origin, dest);
          if (custom) {
            return custom;
          }
          const straight = haversineMeters(origin, dest);
          return {
            distanceMeters: Math.round(straight * 1.2),
            status: 'OK',
            provider: 'mock',
            source: 'mock',
          };
        },
      };
    }

    const configProvider =
      this.configService
        .get<string>('ROUTING_PROVIDER')
        ?.trim()
        ?.toLowerCase() || process.env.ROUTING_PROVIDER?.trim()?.toLowerCase();

    if (configProvider === 'osrm') {
      return this.createOsrmProvider();
    }

    if (configProvider === 'mock') {
      return this.createDefaultMockProvider();
    }

    // Default: Google Maps if API key is present
    const googleKey =
      this.configService.get<string>('GOOGLE_MAPS_API_KEY')?.trim() ||
      process.env.GOOGLE_MAPS_API_KEY?.trim();

    if (googleKey) {
      return this.createGoogleProvider(googleKey);
    }

    // In testing without Google key, fall back to default mock
    return this.createDefaultMockProvider();
  }

  private createGoogleProvider(apiKey: string): IRoadRoutingProvider {
    return {
      name: 'google',
      calculateDrivingDistance: async (origin, dest, timeoutMs) => {
        const url = new URL(
          'https://maps.googleapis.com/maps/api/directions/json',
        );
        url.searchParams.set(
          'origin',
          `${origin.latitude},${origin.longitude}`,
        );
        url.searchParams.set(
          'destination',
          `${dest.latitude},${dest.longitude}`,
        );
        url.searchParams.set('mode', 'driving');
        url.searchParams.set('key', apiKey);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!response.ok) {
            return {
              distanceMeters: null,
              status: 'PROVIDER_ERROR',
              provider: 'google',
              source: 'network',
              errorMessage: `HTTP ${response.status}`,
            };
          }

          const body = (await response.json()) as {
            status?: string;
            error_message?: string;
            routes?: Array<{
              legs?: Array<{
                distance?: { value?: number };
                duration?: { value?: number };
              }>;
            }>;
          };

          if (
            body.status === 'OK' &&
            body.routes?.[0]?.legs?.[0]?.distance?.value != null
          ) {
            const leg = body.routes[0].legs[0];
            return {
              distanceMeters: leg.distance!.value!,
              durationSeconds: leg.duration?.value ?? null,
              status: 'OK',
              provider: 'google',
              source: 'network',
            };
          }

          if (body.status === 'ZERO_RESULTS' || body.status === 'NOT_FOUND') {
            return {
              distanceMeters: null,
              status: 'NO_ROUTE',
              provider: 'google',
              source: 'network',
            };
          }

          return {
            distanceMeters: null,
            status: 'PROVIDER_ERROR',
            provider: 'google',
            source: 'network',
            errorMessage:
              body.error_message || body.status || 'Google Directions error',
          };
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  private createOsrmProvider(): IRoadRoutingProvider {
    const baseUrl =
      this.configService.get<string>('OSRM_BASE_URL')?.trim() ||
      process.env.OSRM_BASE_URL?.trim() ||
      'http://router.project-osrm.org';

    return {
      name: 'osrm',
      calculateDrivingDistance: async (origin, dest, timeoutMs) => {
        const url = `${baseUrl.replace(/\/+$/, '')}/route/v1/driving/${origin.longitude},${origin.latitude};${dest.longitude},${dest.latitude}?overview=false`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!response.ok) {
            return {
              distanceMeters: null,
              status: 'PROVIDER_ERROR',
              provider: 'osrm',
              source: 'network',
              errorMessage: `HTTP ${response.status}`,
            };
          }

          const body = (await response.json()) as {
            code?: string;
            routes?: Array<{ distance?: number; duration?: number }>;
          };

          if (body.code === 'Ok' && body.routes?.[0]?.distance != null) {
            const r = body.routes[0];
            return {
              distanceMeters: Math.round(r.distance!),
              durationSeconds:
                r.duration != null ? Math.round(r.duration) : null,
              status: 'OK',
              provider: 'osrm',
              source: 'network',
            };
          }

          if (body.code === 'NoRoute') {
            return {
              distanceMeters: null,
              status: 'NO_ROUTE',
              provider: 'osrm',
              source: 'network',
            };
          }

          return {
            distanceMeters: null,
            status: 'PROVIDER_ERROR',
            provider: 'osrm',
            source: 'network',
            errorMessage: body.code || 'OSRM error',
          };
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  private createDefaultMockProvider(): IRoadRoutingProvider {
    return {
      name: 'mock',
      calculateDrivingDistance: (origin, dest) => {
        const straight = haversineMeters(origin, dest);
        return Promise.resolve({
          distanceMeters: Math.round(straight * 1.2), // Default 20% road factor
          durationSeconds: Math.round((straight * 1.2) / 16.6), // ~60 km/h
          status: 'OK',
          provider: 'mock',
          source: 'mock',
        });
      },
    };
  }

  private async executeWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    limit: number,
  ): Promise<T[]> {
    const results: T[] = [];
    results.length = tasks.length;
    let currentIndex = 0;

    const worker = async (): Promise<void> => {
      while (currentIndex < tasks.length) {
        const index = currentIndex;
        currentIndex += 1;
        results[index] = await tasks[index]();
      }
    };

    const workers: Promise<void>[] = [];
    const poolSize = Math.min(limit, tasks.length);
    for (let i = 0; i < poolSize; i += 1) {
      workers.push(worker());
    }

    await Promise.all(workers);
    return results;
  }

  private getTimeoutMs(): number {
    const raw =
      this.configService.get<string | number>('ROUTING_TIMEOUT_MS') ??
      process.env.ROUTING_TIMEOUT_MS;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : DEFAULT_ROUTING_TIMEOUT_MS;
  }

  private getMaxConcurrency(): number {
    const raw =
      this.configService.get<string | number>('ROUTING_MAX_CONCURRENCY') ??
      process.env.ROUTING_MAX_CONCURRENCY;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0
      ? num
      : DEFAULT_ROUTING_MAX_CONCURRENCY;
  }

  private getMaxCandidatesPerSearch(): number {
    const raw =
      this.configService.get<string | number>(
        'ROUTING_MAX_CANDIDATES_PER_SEARCH',
      ) ?? process.env.ROUTING_MAX_CANDIDATES_PER_SEARCH;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0
      ? num
      : DEFAULT_ROUTING_MAX_CANDIDATES;
  }

  private getCacheTtlSeconds(): number {
    const raw =
      this.configService.get<string | number>('ROUTING_CACHE_TTL_SECONDS') ??
      process.env.ROUTING_CACHE_TTL_SECONDS;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0
      ? num
      : DEFAULT_ROUTING_CACHE_TTL_SECONDS;
  }

  private getNegativeCacheTtlSeconds(): number {
    const raw =
      this.configService.get<string | number>(
        'ROUTING_NEGATIVE_CACHE_TTL_SECONDS',
      ) ?? process.env.ROUTING_NEGATIVE_CACHE_TTL_SECONDS;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0
      ? num
      : DEFAULT_ROUTING_NEGATIVE_CACHE_TTL_SECONDS;
  }
}
