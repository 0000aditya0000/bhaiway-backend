import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { isAtOrAfterDeparture } from '../assured/assured-timing';
import { CreateRideDto } from './dto/create-ride.dto';
import {
  RideSeries,
  type CommuteRouteSnapshot,
} from './entities/ride-series.entity';
import { Ride } from './entities/ride.entity';
import {
  RideDirection,
  RideSeriesStatus,
  RideStatus,
  RideType,
  SeriesScope,
} from './enums/ride.enums';
import { CommuteScheduleConflictError } from './errors/ride-publishing.errors';
import { assertDepartureIsInFuture } from './ride-publishing.rules';
import {
  commutePublishFingerprint,
  commuteRecurrenceWindow,
  eligibleCommuteOccurrenceDates,
  isCommuteSeriesPublish,
  isReturnAfterOutbound,
  normalizeExcludedWeekdays,
  weekdayOfCivilDate,
} from './commute-recurrence';
import { toCivilDateString } from '../common/time/ride-timezone';
import {
  RouteSelectionService,
  type SelectedRouteFields,
} from './route/route-selection.service';

export interface CommuteSeriesPublishResult {
  original: Ride;
  occurrences: Ride[];
  series: RideSeries;
}

@Injectable()
export class CommuteRideSeriesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(RideSeries)
    private readonly seriesRepository: Repository<RideSeries>,
    private readonly routeSelectionService: RouteSelectionService,
  ) {}

  async publish(
    driverId: string,
    dto: CreateRideDto,
    idempotencyKey: string | null | undefined,
  ): Promise<CommuteSeriesPublishResult> {
    this.assertSeriesRequest(dto);
    const key = this.requireIdempotencyKey(idempotencyKey);

    const outboundRoute = this.toRouteSnapshot(
      dto.source.trim(),
      dto.destination.trim(),
      this.routeSelectionService.resolveSelectedRoute({
        token: dto.routeSelectionToken,
        sourceLatitude: dto.sourceLatitude,
        sourceLongitude: dto.sourceLongitude,
        destinationLatitude: dto.destinationLatitude,
        destinationLongitude: dto.destinationLongitude,
      }),
    );

    const returnEnabled = dto.returnEnabled === true;
    let returnRoute: CommuteRouteSnapshot | null = null;
    const outboundTime = this.normalizeTime(dto.departureTime);
    let returnTime: string | null = null;

    if (returnEnabled) {
      returnTime = this.normalizeTime(dto.returnDepartureTime!);
      if (!isReturnAfterOutbound(outboundTime, returnTime)) {
        throw new BadRequestException(
          'returnDepartureTime must be after departureTime on the same calendar date. Overnight returns are not supported.',
        );
      }
      returnRoute = this.resolveReturnRoute(dto, outboundRoute);
    }

    let excludedWeekdays;
    try {
      excludedWeekdays = normalizeExcludedWeekdays(dto.excludeWeekdays);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid excludeWeekdays',
      );
    }
    const recurring = dto.recurring === true;
    const publishingDate = dto.departureDate;
    const window = recurring
      ? commuteRecurrenceWindow(publishingDate)
      : { startDate: publishingDate, endDate: publishingDate, dates: [publishingDate] };

    if (recurring && excludedWeekdays.includes(weekdayOfCivilDate(publishingDate))) {
      throw new BadRequestException(
        'The publishing date cannot be excluded from the recurring schedule.',
      );
    }

    const occurrenceDates = recurring
      ? eligibleCommuteOccurrenceDates({
          publishingDate,
          excludedWeekdays,
        })
      : [publishingDate];

    if (occurrenceDates.length === 0) {
      throw new BadRequestException(
        'The recurring schedule does not include any eligible dates.',
      );
    }

    for (const date of occurrenceDates) {
      assertDepartureIsInFuture(date, outboundTime);
      if (returnTime) {
        assertDepartureIsInFuture(date, returnTime);
      }
    }

    const fingerprint = commutePublishFingerprint({
      driverId,
      rideType: RideType.COMMUTE,
      vehicleId: dto.vehicleId,
      source: dto.source.trim(),
      destination: dto.destination.trim(),
      sourceLatitude: dto.sourceLatitude,
      sourceLongitude: dto.sourceLongitude,
      destinationLatitude: dto.destinationLatitude,
      destinationLongitude: dto.destinationLongitude,
      departureDate: publishingDate,
      departureTime: outboundTime,
      totalSeats: dto.totalSeats,
      pricePerSeat: dto.pricePerSeat,
      maxTwoInBackSeat: dto.maxTwoInBackSeat ?? false,
      noSmoking: dto.noSmoking ?? false,
      noPets: dto.noPets ?? false,
      luggageAllowed: dto.luggageAllowed ?? true,
      notes: dto.notes?.trim() ?? null,
      recurring,
      excludeWeekdays: excludedWeekdays,
      returnEnabled,
      returnDepartureTime: returnTime,
      returnSource: returnRoute?.source ?? null,
      returnDestination: returnRoute?.destination ?? null,
      outboundPolyline: outboundRoute.routePolyline,
      outboundLengthMeters: outboundRoute.routeLengthMeters,
      returnPolyline: returnRoute?.routePolyline ?? null,
      returnLengthMeters: returnRoute?.routeLengthMeters ?? null,
    });

    const existing = await this.seriesRepository.findOne({
      where: { publishIdempotencyKey: key },
    });
    if (existing) {
      return this.existingSeriesResult(existing, driverId, fingerprint);
    }

    const originalRideId = randomUUID();
    const seriesId = randomUUID();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `commute-series:${driverId}`,
        ]);
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `commute-vehicle:${dto.vehicleId}`,
        ]);

        const existingAfterLock = await manager.getRepository(RideSeries).findOne({
          where: { publishIdempotencyKey: key },
        });
        if (existingAfterLock) {
          return this.existingSeriesResult(
            existingAfterLock,
            driverId,
            fingerprint,
            manager,
          );
        }

        const plannedSlots: Array<{ date: string; time: string }> = [];
        for (const date of occurrenceDates) {
          plannedSlots.push({ date, time: outboundTime });
          if (returnTime) {
            plannedSlots.push({ date, time: returnTime });
          }
        }
        await this.assertSlotsAvailable(manager, driverId, dto.vehicleId, plannedSlots);

        const series = manager.getRepository(RideSeries).create({
          id: seriesId,
          driverId,
          vehicleId: dto.vehicleId,
          rideType: RideType.COMMUTE,
          status: RideSeriesStatus.ACTIVE,
          publishingDate,
          startDate: window.startDate,
          endDate: window.endDate,
          excludedWeekdays,
          departureTime: outboundTime,
          returnEnabled,
          returnDepartureTime: returnTime,
          totalSeats: dto.totalSeats,
          pricePerSeat: String(dto.pricePerSeat),
          maxTwoInBackSeat: dto.maxTwoInBackSeat ?? false,
          noSmoking: dto.noSmoking ?? false,
          noPets: dto.noPets ?? false,
          luggageAllowed: dto.luggageAllowed ?? true,
          notes: dto.notes?.trim() ?? null,
          outboundRoute,
          returnRoute,
          originalRideId,
          publishIdempotencyKey: key,
          requestFingerprint: fingerprint,
        });
        await manager.getRepository(RideSeries).save(series);

        const occurrences: Ride[] = [];
        for (const date of occurrenceDates) {
          const outboundId =
            date === publishingDate ? originalRideId : randomUUID();
          const outbound = this.buildOccurrence(manager, {
            id: outboundId,
            driverId,
            dto,
            seriesId,
            date,
            time: outboundTime,
            direction: RideDirection.OUTBOUND,
            route: outboundRoute,
          });
          occurrences.push(await manager.getRepository(Ride).save(outbound));

          if (returnRoute && returnTime) {
            const inbound = this.buildOccurrence(manager, {
              id: randomUUID(),
              driverId,
              dto,
              seriesId,
              date,
              time: returnTime,
              direction: RideDirection.RETURN,
              route: returnRoute,
            });
            occurrences.push(await manager.getRepository(Ride).save(inbound));
          }
        }

        const original =
          occurrences.find((ride) => ride.id === originalRideId) ?? occurrences[0];
        return { original, occurrences, series };
      });
    } catch (error) {
      if (this.isSeriesIdempotencyUniqueViolation(error)) {
        const recovered = await this.seriesRepository.findOne({
          where: { publishIdempotencyKey: key },
        });
        if (recovered) {
          return this.existingSeriesResult(recovered, driverId, fingerprint);
        }
      }
      if (this.isCommuteSlotUniqueViolation(error)) {
        const recovered = await this.seriesRepository.findOne({
          where: { publishIdempotencyKey: key },
        });
        if (recovered) {
          return this.existingSeriesResult(recovered, driverId, fingerprint);
        }
        throw new CommuteScheduleConflictError();
      }
      if (this.isSeriesOccurrenceUniqueViolation(error)) {
        throw new ConflictException(
          'A commute occurrence already exists for this series date and direction',
        );
      }
      throw error;
    }
  }

  async findSameDirectionScope(
    manager: EntityManager,
    ride: Ride,
    scope: SeriesScope,
  ): Promise<Ride[]> {
    return this.findSeriesOccurrencesFromDate(manager, ride, scope, true);
  }

  /**
   * THIS_AND_FUTURE cancellation scope: both outbound and return occurrences
   * in the same series whose occurrence_date is on or after the selected date.
   * Matching uses series_id + occurrence_date only (not route labels or times).
   */
  async findSeriesDateScope(
    manager: EntityManager,
    ride: Ride,
    scope: SeriesScope,
  ): Promise<Ride[]> {
    return this.findSeriesOccurrencesFromDate(manager, ride, scope, false);
  }

  private async findSeriesOccurrencesFromDate(
    manager: EntityManager,
    ride: Ride,
    scope: SeriesScope,
    sameDirectionOnly: boolean,
  ): Promise<Ride[]> {
    if (scope !== SeriesScope.THIS_AND_FUTURE || !ride.seriesId) {
      return [ride];
    }

    const occurrenceDate = this.toCivilDate(
      ride.occurrenceDate ?? ride.departureDate,
    );
    const qb = manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .setLock('pessimistic_write')
      .where('ride.series_id = :seriesId', { seriesId: ride.seriesId })
      .andWhere('ride.driver_id = :driverId', { driverId: ride.driverId })
      .andWhere('ride.occurrence_date >= CAST(:occurrenceDate AS date)', {
        occurrenceDate,
      });
    if (sameDirectionOnly) {
      qb.andWhere('ride.direction = :direction', {
        direction: ride.direction ?? RideDirection.OUTBOUND,
      });
    }
    const siblings = await qb
      .orderBy('ride.occurrence_date', 'ASC')
      .addOrderBy('ride.direction', 'ASC')
      .addOrderBy('ride.id', 'ASC')
      .getMany();

    return siblings.length > 0 ? siblings : [ride];
  }

  private assertSeriesRequest(dto: CreateRideDto): void {
    if (!isCommuteSeriesPublish(dto)) {
      throw new BadRequestException('Request is not a commute series publish');
    }
    if (dto.rideType !== RideType.COMMUTE) {
      throw new BadRequestException(
        'Recurring and return ride fields are only supported for COMMUTE rides',
      );
    }
    if (dto.recurring !== true && (dto.excludeWeekdays?.length ?? 0) > 0) {
      throw new BadRequestException(
        'excludeWeekdays is only allowed when recurring is true',
      );
    }
    if (dto.returnEnabled === true) {
      if (!dto.returnDepartureTime?.trim()) {
        throw new BadRequestException(
          'returnDepartureTime is required when returnEnabled is true',
        );
      }
      if (!dto.returnRouteSelectionToken?.trim()) {
        throw new BadRequestException(
          'returnRouteSelectionToken is required when returnEnabled is true',
        );
      }
    } else if (
      dto.returnDepartureTime ||
      dto.returnRouteSelectionToken ||
      dto.returnSource ||
      dto.returnDestination
    ) {
      throw new BadRequestException(
        'Return-specific fields are only allowed when returnEnabled is true',
      );
    }
  }

  private requireIdempotencyKey(
    idempotencyKey: string | null | undefined,
  ): string {
    const key = idempotencyKey?.trim() || '';
    if (!key) {
      throw new BadRequestException(
        'Idempotency-Key header is required when publishing a recurring or return Commute ride',
      );
    }
    if (key.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key must be at most 255 characters',
      );
    }
    return key;
  }

  private resolveReturnRoute(
    dto: CreateRideDto,
    outbound: CommuteRouteSnapshot,
  ): CommuteRouteSnapshot {
    if (dto.returnRouteSelectionToken?.trim() === dto.routeSelectionToken.trim()) {
      throw new BadRequestException(
        'returnRouteSelectionToken must be a separate reverse-route token; the outbound token cannot be reused',
      );
    }

    const returnFields = this.routeSelectionService.resolveSelectedRoute({
      token: dto.returnRouteSelectionToken,
      sourceLatitude: outbound.destinationLatitude,
      sourceLongitude: outbound.destinationLongitude,
      destinationLatitude: outbound.sourceLatitude,
      destinationLongitude: outbound.sourceLongitude,
    });

    if (returnFields.routeSelectionId === outbound.routeSelectionId) {
      throw new BadRequestException(
        'returnRouteSelectionToken must select a reverse driving route, not the outbound route',
      );
    }

    return this.toRouteSnapshot(
      dto.returnSource?.trim() || outbound.destination,
      dto.returnDestination?.trim() || outbound.source,
      returnFields,
    );
  }

  private toRouteSnapshot(
    source: string,
    destination: string,
    fields: SelectedRouteFields,
  ): CommuteRouteSnapshot {
    return {
      source,
      destination,
      ...fields,
    };
  }

  private buildOccurrence(
    manager: EntityManager,
    params: {
      id: string;
      driverId: string;
      dto: CreateRideDto;
      seriesId: string;
      date: string;
      time: string;
      direction: RideDirection;
      route: CommuteRouteSnapshot;
    },
  ): Ride {
    const { route } = params;
    return manager.getRepository(Ride).create({
      id: params.id,
      driverId: params.driverId,
      vehicleId: params.dto.vehicleId,
      rideType: RideType.COMMUTE,
      status: RideStatus.PUBLISHED,
      source: route.source,
      destination: route.destination,
      departureDate: params.date,
      departureTime: params.time,
      totalSeats: params.dto.totalSeats,
      availableSeats: params.dto.totalSeats,
      pricePerSeat: String(params.dto.pricePerSeat),
      maxTwoInBackSeat: params.dto.maxTwoInBackSeat ?? false,
      noSmoking: params.dto.noSmoking ?? false,
      noPets: params.dto.noPets ?? false,
      luggageAllowed: params.dto.luggageAllowed ?? true,
      womenOnly: false,
      notes: params.dto.notes?.trim() ?? null,
      assuredDepositPercentage: null,
      assuredDepositAmount: null,
      driverDepositHoldId: null,
      publishIdempotencyKey: null,
      seriesId: params.seriesId,
      occurrenceDate: params.date,
      direction: params.direction,
      sourceLatitude: route.sourceLatitude,
      sourceLongitude: route.sourceLongitude,
      destinationLatitude: route.destinationLatitude,
      destinationLongitude: route.destinationLongitude,
      routePolyline: route.routePolyline,
      routeLengthMeters: route.routeLengthMeters,
      routeBboxMinLat: route.routeBboxMinLat,
      routeBboxMaxLat: route.routeBboxMaxLat,
      routeBboxMinLng: route.routeBboxMinLng,
      routeBboxMaxLng: route.routeBboxMaxLng,
      routeSelectionId: route.routeSelectionId,
      routeSelectedAt: route.routeSelectedAt,
      routeDurationSeconds: route.routeDurationSeconds,
    });
  }

  private async existingSeriesResult(
    series: RideSeries,
    driverId: string,
    fingerprint: string,
    manager?: EntityManager,
  ): Promise<CommuteSeriesPublishResult> {
    if (series.driverId !== driverId || series.requestFingerprint !== fingerprint) {
      throw new ConflictException(
        'Idempotency key was reused for a different Commute series publish request',
      );
    }
    const rides = manager
      ? manager.getRepository(Ride)
      : this.rideRepository;
    const occurrences = await rides.find({
      where: { seriesId: series.id },
      order: { occurrenceDate: 'ASC', departureTime: 'ASC', id: 'ASC' },
    });
    const original =
      occurrences.find((ride) => ride.id === series.originalRideId) ??
      occurrences.find(
        (ride) =>
          ride.direction === RideDirection.OUTBOUND &&
          this.toCivilDate(ride.occurrenceDate ?? ride.departureDate) ===
            this.toCivilDate(series.publishingDate),
      );
    if (!original) {
      throw new NotFoundException('Original commute series ride not found');
    }
    return { original, occurrences, series };
  }

  /**
   * Application-level slot check (all ride types, non-terminal). The matching
   * DB unique indexes are COMMUTE-only. Regular publish does not take these
   * advisory locks; do not add a cross-type unique index without product sign-off.
   */
  private async assertSlotsAvailable(
    manager: EntityManager,
    driverId: string,
    vehicleId: string,
    slots: Array<{ date: string; time: string }>,
  ): Promise<void> {
    for (const slot of slots) {
      const existing = await manager
        .getRepository(Ride)
        .createQueryBuilder('ride')
        .where('(ride.driver_id = :driverId OR ride.vehicle_id = :vehicleId)', {
          driverId,
          vehicleId,
        })
        .andWhere('ride.departure_date = :date', { date: slot.date })
        .andWhere('ride.departure_time = :time', { time: slot.time })
        .andWhere('ride.status NOT IN (:...terminal)', {
          terminal: [RideStatus.CANCELLED, RideStatus.COMPLETED],
        })
        .getOne();
      if (existing) {
        throw new CommuteScheduleConflictError();
      }
    }
  }

  private normalizeTime(value: string): string {
    const parts = value.split(':');
    if (parts.length === 2) {
      return `${value}:00`;
    }
    return value;
  }

  private toCivilDate(value: string | Date): string {
    return toCivilDateString(value);
  }

  private isUniqueViolation(error: unknown, markers: string[]): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as {
      code?: string;
      constraint?: string;
      detail?: string;
    };
    const code = driverError?.code ?? (error as { code?: string }).code;
    const constraint =
      driverError?.constraint ??
      (error as { constraint?: string }).constraint ??
      '';
    const detail = driverError?.detail ?? '';
    return (
      code === '23505' &&
      markers.some(
        (marker) => constraint.includes(marker) || detail.includes(marker),
      )
    );
  }

  private isSeriesIdempotencyUniqueViolation(error: unknown): boolean {
    return this.isUniqueViolation(error, [
      'UQ_ride_series_publish_idempotency_key',
    ]);
  }

  private isSeriesOccurrenceUniqueViolation(error: unknown): boolean {
    return this.isUniqueViolation(error, [
      'UQ_rides_series_occurrence_direction',
    ]);
  }

  private isCommuteSlotUniqueViolation(error: unknown): boolean {
    return this.isUniqueViolation(error, [
      'UQ_rides_commute_driver_slot',
      'UQ_rides_commute_vehicle_slot',
    ]);
  }
}

export function isPastOccurrence(ride: Ride, now: Date = new Date()): boolean {
  const date = toCivilDateString(ride.departureDate);
  const time =
    ride.departureTime.length >= 8
      ? ride.departureTime.slice(0, 8)
      : ride.departureTime;
  return isAtOrAfterDeparture(now, date, time);
}
