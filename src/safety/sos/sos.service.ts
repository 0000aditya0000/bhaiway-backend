import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import {
  AdminAlertCategory,
  AdminAlertSeverity,
} from '../../admin/entities/admin-alert.entity';
import { AdminAlertService } from '../../admin/admin-alert.service';
import { Booking } from '../../bookings/entities/booking.entity';
import { BookingStatus } from '../../bookings/enums/booking.enums';
import { NotificationType } from '../../notifications/enums/notification.enums';
import {
  sosDriverAlertKey,
  sosPassengerAlertKey,
} from '../../notifications/notifications.helpers';
import { NotificationsService } from '../../notifications/notifications.service';
import { Ride } from '../../rides/entities/ride.entity';
import { RideStatus } from '../../rides/enums/ride.enums';
import { TrackingGateway } from '../../tracking/tracking.gateway';
import { TrackingService } from '../../tracking/tracking.service';
import { UserProfile } from '../../users/entities/user-profile.entity';
import { User } from '../../users/entities/user.entity';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { TriggerSosDto, PublishSosLocationDto } from './dto/trigger-sos.dto';
import { SafetyIncident } from './entities/safety-incident.entity';
import { SosEvent } from './entities/sos-event.entity';
import { SosParticipant } from './entities/sos-participant.entity';
import { SosTimelineEvent } from './entities/sos-timeline-event.entity';
import { SosTrigger } from './entities/sos-trigger.entity';
import {
  ACTIVE_SOS_STATUSES,
  SafetyIncidentSeverity,
  SafetyIncidentStatus,
  SafetyIncidentType,
  SosActorType,
  SosCategory,
  SosLocationFreshness,
  SosParticipantRole,
  SosSeverity,
  SosStatus,
  SosTimelineEventType,
} from './enums/sos.enums';
import {
  SosRideNotEligibleError,
  SosRideNotFoundError,
} from './errors/sos.errors';
import { SOS_SERVER_EVENTS } from '../../tracking/tracking.events';
import { SosEventsService } from './sos-events.service';

const SOS_TRIGGER_WINDOW_MS = 2_000;

@Injectable()
export class SosService {
  private readonly logger = new Logger(SosService.name);
  private readonly lastTriggerMs = new Map<string, number>();

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SosEvent)
    private readonly sosRepository: Repository<SosEvent>,
    @InjectRepository(SosTrigger)
    private readonly triggerRepository: Repository<SosTrigger>,
    @InjectRepository(SosParticipant)
    private readonly participantRepository: Repository<SosParticipant>,
    @InjectRepository(SafetyIncident)
    private readonly incidentRepository: Repository<SafetyIncident>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    private readonly trackingService: TrackingService,
    private readonly trackingGateway: TrackingGateway,
    private readonly notificationsService: NotificationsService,
    private readonly sosEvents: SosEventsService,
    private readonly adminAlertService: AdminAlertService,
  ) {}

  async trigger(
    userId: string,
    rideId: string,
    dto: TriggerSosDto,
  ): Promise<Record<string, unknown>> {
    const throttleKey = `${userId}:${rideId}`;
    const last = this.lastTriggerMs.get(throttleKey);
    if (
      last &&
      Date.now() - last < SOS_TRIGGER_WINDOW_MS &&
      !dto.idempotencyKey
    ) {
      const existing = await this.findActiveForRide(rideId);
      if (existing) {
        return this.toUserResponse(existing, { attached: true });
      }
    }

    let result: {
      sos: SosEvent;
      created: boolean;
      additional: boolean;
      trigger: SosTrigger;
    };
    try {
      result = await this.dataSource.transaction(async (manager) => {
        const ride = await manager
          .getRepository(Ride)
          .createQueryBuilder('ride')
          .setLock('pessimistic_write')
          .where('ride.id = :rideId', { rideId })
          .getOne();
        if (!ride) {
          throw new SosRideNotFoundError();
        }

        const participant = await this.resolveParticipant(
          manager,
          ride,
          userId,
        );
        if (!participant) {
          throw new SosRideNotFoundError();
        }
        if (ride.status !== RideStatus.IN_PROGRESS) {
          throw new SosRideNotEligibleError();
        }

        if (dto.idempotencyKey) {
          const replay = await manager.getRepository(SosTrigger).findOne({
            where: { idempotencyKey: dto.idempotencyKey },
          });
          if (replay) {
            const sos = await manager.getRepository(SosEvent).findOneByOrFail({
              id: replay.sosId,
            });
            return { sos, created: false, additional: false, trigger: replay };
          }
        }

        const active = await manager.getRepository(SosEvent).findOne({
          where: { rideId: ride.id, status: In(ACTIVE_SOS_STATUSES) },
        });

        const location = this.normalizeLocation(dto);

        if (active) {
          const prior = await manager.getRepository(SosTrigger).findOne({
            where: { sosId: active.id, userId },
            order: { triggeredAt: 'DESC' },
          });
          if (prior && !dto.idempotencyKey) {
            return {
              sos: active,
              created: false,
              additional: false,
              trigger: prior,
            };
          }

          const trigger = manager.getRepository(SosTrigger).create({
            sosId: active.id,
            userId,
            role: participant.role,
            isOriginal: false,
            triggeredAt: new Date(),
            triggerSource: 'APP',
            idempotencyKey: dto.idempotencyKey ?? null,
            latitude: location?.latitude ?? null,
            longitude: location?.longitude ?? null,
            accuracy: location?.accuracy ?? null,
          });
          const savedTrigger = await manager
            .getRepository(SosTrigger)
            .save(trigger);
          await this.appendTimeline(manager, {
            sosId: active.id,
            eventType: SosTimelineEventType.ADDITIONAL_TRIGGER,
            actorType: SosActorType.USER,
            actorId: userId,
            description:
              'Additional SOS trigger attached to the active emergency',
            metadata: { triggerId: savedTrigger.id, role: participant.role },
          });
          return {
            sos: active,
            created: false,
            additional: true,
            trigger: savedTrigger,
          };
        }

        const now = new Date();
        const sos = manager.getRepository(SosEvent).create({
          rideId: ride.id,
          originalTriggerUserId: userId,
          category: dto.category ?? SosCategory.EMERGENCY,
          severity: SosSeverity.CRITICAL,
          status: SosStatus.TRIGGERED,
          rideType: ride.rideType,
          triggeredAt: now,
          triggerLatitude: location?.latitude ?? null,
          triggerLongitude: location?.longitude ?? null,
          triggerAccuracy: location?.accuracy ?? null,
          triggerLocationAt: location ? now : null,
        });
        const savedSos = await manager.getRepository(SosEvent).save(sos);

        const originalTrigger = manager.getRepository(SosTrigger).create({
          sosId: savedSos.id,
          userId,
          role: participant.role,
          isOriginal: true,
          triggeredAt: now,
          triggerSource: 'APP',
          idempotencyKey: dto.idempotencyKey ?? null,
          latitude: location?.latitude ?? null,
          longitude: location?.longitude ?? null,
          accuracy: location?.accuracy ?? null,
        });
        const savedTrigger = await manager
          .getRepository(SosTrigger)
          .save(originalTrigger);

        await this.snapshotParticipants(manager, savedSos, ride);
        const incident = manager.getRepository(SafetyIncident).create({
          sosId: savedSos.id,
          rideId: ride.id,
          type: SafetyIncidentType.SOS,
          status: SafetyIncidentStatus.OPEN,
          severity: SafetyIncidentSeverity.CRITICAL,
          title: 'SOS emergency',
          summary: 'Ride SOS triggered',
        });
        await manager.getRepository(SafetyIncident).save(incident);

        await this.appendTimeline(manager, {
          sosId: savedSos.id,
          eventType: SosTimelineEventType.TRIGGERED,
          actorType: SosActorType.USER,
          actorId: userId,
          description: 'SOS triggered',
          metadata: { role: participant.role, category: savedSos.category },
        });

        const snapshot = await manager.getRepository(SosParticipant).find({
          where: { sosId: savedSos.id },
        });
        await this.enqueueInitialAlerts(manager, savedSos, snapshot, userId);

        return {
          sos: savedSos,
          created: true,
          additional: false,
          trigger: savedTrigger,
        };
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
      if (dto.idempotencyKey) {
        const replay = await this.triggerRepository.findOne({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (replay) {
          const sos = await this.sosRepository.findOneByOrFail({
            id: replay.sosId,
          });
          result = {
            sos,
            created: false,
            additional: false,
            trigger: replay,
          };
        } else {
          result = await this.attachAfterRace(userId, rideId, dto);
        }
      } else {
        result = await this.attachAfterRace(userId, rideId, dto);
      }
    }

    this.lastTriggerMs.set(throttleKey, Date.now());

    if (result.created) {
      this.dispatchCreated(result.sos);
    } else if (result.additional) {
      this.dispatchAdditional(result.sos, result.trigger, userId);
    }

    return this.toUserResponse(result.sos, {
      created: result.created,
      attached: result.additional || !result.created,
    });
  }

  async publishLocation(
    userId: string,
    rideId: string,
    dto: PublishSosLocationDto,
  ): Promise<Record<string, unknown>> {
    const sos = await this.requireActiveParticipantSos(userId, rideId);
    const stored = await this.trackingService.setParticipantLocation(
      rideId,
      userId,
      dto,
    );
    this.trackingGateway.emitToAdminSafety(SOS_SERVER_EVENTS.LOCATION_UPDATED, {
      sosId: sos.id,
      rideId,
      userId,
    });
    return {
      sosId: sos.id,
      rideId,
      userId,
      latitude: stored.latitude,
      longitude: stored.longitude,
      timestamp: stored.timestamp,
      accuracy: stored.accuracy ?? null,
      freshness: this.trackingService.classifyLocationFreshness(
        stored.updatedAt,
      ),
    };
  }

  async getActiveForParticipant(
    userId: string,
    rideId: string,
  ): Promise<Record<string, unknown>> {
    const sos = await this.requireActiveParticipantSos(userId, rideId);
    return this.toUserResponse(sos, { attached: false });
  }

  async findActiveForRide(rideId: string): Promise<SosEvent | null> {
    return this.sosRepository.findOne({
      where: { rideId, status: In(ACTIVE_SOS_STATUSES) },
    });
  }

  private async attachAfterRace(
    userId: string,
    rideId: string,
    dto: TriggerSosDto,
  ): Promise<{
    sos: SosEvent;
    created: boolean;
    additional: boolean;
    trigger: SosTrigger;
  }> {
    return this.dataSource.transaction(async (manager) => {
      const sos = await manager.getRepository(SosEvent).findOne({
        where: { rideId, status: In(ACTIVE_SOS_STATUSES) },
      });
      if (!sos) {
        throw new SosRideNotEligibleError();
      }
      const existingTrigger = await manager.getRepository(SosTrigger).findOne({
        where: { sosId: sos.id, userId },
      });
      if (existingTrigger) {
        return {
          sos,
          created: false,
          additional: false,
          trigger: existingTrigger,
        };
      }
      const ride = await manager
        .getRepository(Ride)
        .findOneByOrFail({ id: rideId });
      const participant = await this.resolveParticipant(manager, ride, userId);
      const location = this.normalizeLocation(dto);
      const trigger = await manager.getRepository(SosTrigger).save(
        manager.getRepository(SosTrigger).create({
          sosId: sos.id,
          userId,
          role: participant?.role ?? SosParticipantRole.PASSENGER,
          isOriginal: false,
          triggeredAt: new Date(),
          triggerSource: 'APP',
          idempotencyKey: dto.idempotencyKey ?? null,
          latitude: location?.latitude ?? null,
          longitude: location?.longitude ?? null,
          accuracy: location?.accuracy ?? null,
        }),
      );
      await this.appendTimeline(manager, {
        sosId: sos.id,
        eventType: SosTimelineEventType.ADDITIONAL_TRIGGER,
        actorType: SosActorType.USER,
        actorId: userId,
        description: 'Additional SOS trigger attached after concurrent create',
        metadata: { triggerId: trigger.id },
      });
      return { sos, created: false, additional: true, trigger };
    });
  }

  async getLocationsForAdmin(
    sosId: string,
  ): Promise<Record<string, unknown>[]> {
    const sos = await this.sosRepository.findOneBy({ id: sosId });
    if (!sos) {
      return [];
    }
    const participants = await this.participantRepository.find({
      where: { sosId: sos.id },
    });
    const results: Record<string, unknown>[] = [];
    for (const participant of participants) {
      let snapshot =
        participant.role === SosParticipantRole.DRIVER
          ? await this.trackingService.getDriverLocationSnapshot(sos.rideId)
          : await this.trackingService.getParticipantLocation(
              sos.rideId,
              participant.userId,
            );
      if (
        !snapshot &&
        participant.userId === sos.originalTriggerUserId &&
        sos.triggerLatitude != null &&
        sos.triggerLongitude != null
      ) {
        snapshot = {
          latitude: sos.triggerLatitude,
          longitude: sos.triggerLongitude,
          timestamp: (sos.triggerLocationAt ?? sos.triggeredAt).toISOString(),
          updatedAt: (sos.triggerLocationAt ?? sos.triggeredAt).toISOString(),
          accuracy: sos.triggerAccuracy ?? undefined,
        };
      }
      const freshness = snapshot
        ? this.trackingService.classifyLocationFreshness(snapshot.updatedAt)
        : SosLocationFreshness.MISSING;
      results.push({
        userId: participant.userId,
        role: participant.role,
        latitude:
          freshness === SosLocationFreshness.MISSING
            ? null
            : (snapshot?.latitude ?? null),
        longitude:
          freshness === SosLocationFreshness.MISSING
            ? null
            : (snapshot?.longitude ?? null),
        timestamp:
          freshness === SosLocationFreshness.MISSING
            ? null
            : (snapshot?.timestamp ?? null),
        accuracy: snapshot?.accuracy ?? null,
        freshness,
      });
    }
    return results;
  }

  private async requireActiveParticipantSos(
    userId: string,
    rideId: string,
  ): Promise<SosEvent> {
    const ride = await this.rideRepository.findOneBy({ id: rideId });
    if (!ride) {
      throw new SosRideNotFoundError();
    }
    const participant = await this.resolveParticipant(
      this.dataSource.manager,
      ride,
      userId,
    );
    if (!participant) {
      throw new SosRideNotFoundError();
    }
    const sos = await this.findActiveForRide(rideId);
    if (!sos) {
      throw new SosRideNotFoundError();
    }
    return sos;
  }

  private async resolveParticipant(
    manager: EntityManager,
    ride: Ride,
    userId: string,
  ): Promise<{ role: SosParticipantRole; booking?: Booking } | null> {
    if (ride.driverId === userId) {
      return { role: SosParticipantRole.DRIVER };
    }
    const booking = await manager.getRepository(Booking).findOne({
      where: {
        rideId: ride.id,
        passengerId: userId,
        status: BookingStatus.CONFIRMED,
      },
    });
    if (!booking) {
      return null;
    }
    return { role: SosParticipantRole.PASSENGER, booking };
  }

  private async snapshotParticipants(
    manager: EntityManager,
    sos: SosEvent,
    ride: Ride,
  ): Promise<void> {
    const [driver, driverProfile, vehicle, bookings] = await Promise.all([
      manager.getRepository(User).findOneBy({ id: ride.driverId }),
      manager.getRepository(UserProfile).findOne({
        where: { userId: ride.driverId },
      }),
      manager.getRepository(Vehicle).findOneBy({ id: ride.vehicleId }),
      manager.getRepository(Booking).find({
        where: { rideId: ride.id, status: BookingStatus.CONFIRMED },
      }),
    ]);

    const driverRow = manager.getRepository(SosParticipant).create({
      sosId: sos.id,
      userId: ride.driverId,
      role: SosParticipantRole.DRIVER,
      displayName: this.displayName(driverProfile),
      phone: driver?.phone ?? null,
      profilePhoto: driverProfile?.profilePhoto ?? null,
      vehicleId: vehicle?.id ?? ride.vehicleId,
      vehicleMake: vehicle?.make ?? null,
      vehicleModel: vehicle?.model ?? null,
      vehicleRegistrationNumber: vehicle?.registrationNumber ?? null,
      vehicleColor: vehicle?.color ?? null,
      metadata: {
        source: ride.source,
        destination: ride.destination,
      },
    });
    await manager.getRepository(SosParticipant).save(driverRow);

    for (const booking of bookings) {
      const [user, profile] = await Promise.all([
        manager.getRepository(User).findOneBy({ id: booking.passengerId }),
        manager.getRepository(UserProfile).findOne({
          where: { userId: booking.passengerId },
        }),
      ]);
      const row = manager.getRepository(SosParticipant).create({
        sosId: sos.id,
        userId: booking.passengerId,
        role: SosParticipantRole.PASSENGER,
        displayName: this.displayName(profile),
        phone: user?.phone ?? null,
        profilePhoto: profile?.profilePhoto ?? null,
        bookingId: booking.id,
        bookingStatus: booking.status,
        pickupStatus: booking.pickupStatus,
        metadata: {
          seats: booking.seats,
        },
      });
      await manager.getRepository(SosParticipant).save(row);
    }
  }

  private async enqueueInitialAlerts(
    manager: EntityManager,
    sos: SosEvent,
    participants: SosParticipant[],
    triggerUserId: string,
  ): Promise<void> {
    const trigger = participants.find((p) => p.userId === triggerUserId);
    const triggerName = trigger?.displayName || 'A passenger';
    const driver = participants.find(
      (p) => p.role === SosParticipantRole.DRIVER,
    );

    if (driver && driver.userId !== triggerUserId) {
      await this.notificationsService.safeEnqueueInTransaction(manager, {
        recipientUserId: driver.userId,
        type: NotificationType.SOS_DRIVER_ALERT,
        title: 'SOS triggered',
        body: 'SOS TRIGGERED FOR YOUR RIDE',
        data: {
          type: NotificationType.SOS_DRIVER_ALERT,
          sosId: sos.id,
          rideId: sos.rideId,
        },
        idempotencyKey: sosDriverAlertKey(sos.id),
      });
    }

    for (const participant of participants) {
      if (
        participant.role !== SosParticipantRole.PASSENGER ||
        participant.userId === triggerUserId
      ) {
        continue;
      }
      await this.notificationsService.safeEnqueueInTransaction(manager, {
        recipientUserId: participant.userId,
        type: NotificationType.SOS_PASSENGER_ALERT,
        title: 'SOS alert',
        body: 'A passenger has triggered an SOS in your current ride. Please stay alert and follow safety instructions.',
        data: {
          type: NotificationType.SOS_PASSENGER_ALERT,
          sosId: sos.id,
          rideId: sos.rideId,
        },
        idempotencyKey: sosPassengerAlertKey(sos.id, participant.userId),
      });
    }

    void triggerName;
  }

  private dispatchCreated(sos: SosEvent): void {
    try {
      this.sosEvents.emitCreated({
        sosId: sos.id,
        rideId: sos.rideId,
        originalTriggerUserId: sos.originalTriggerUserId,
        triggeredAt: sos.triggeredAt.toISOString(),
      });
      void this.adminAlertService.reportIncident({
        incidentKey: `sos:${sos.id}`,
        category: AdminAlertCategory.SOS,
        severity: AdminAlertSeverity.CRITICAL,
        title: 'SOS triggered',
        message: `Active SOS on ride ${sos.rideId}`,
        source: 'sos',
        metadata: { sosId: sos.id, rideId: sos.rideId },
      });
      void this.participantRepository
        .find({ where: { sosId: sos.id } })
        .then((participants) => {
          const trigger = participants.find(
            (p) => p.userId === sos.originalTriggerUserId,
          );
          const driver = participants.find(
            (p) => p.role === SosParticipantRole.DRIVER,
          );
          const payload = {
            sosId: sos.id,
            rideId: sos.rideId,
            category: sos.category,
            triggeredAt: sos.triggeredAt.toISOString(),
            triggeringPassengerName: trigger?.displayName ?? null,
            alertType: 'SOS',
          };
          if (driver && driver.userId !== sos.originalTriggerUserId) {
            this.trackingGateway.emitSosDriverAlert(driver.userId, payload);
          }
          for (const participant of participants) {
            if (
              participant.role === SosParticipantRole.PASSENGER &&
              participant.userId !== sos.originalTriggerUserId
            ) {
              this.trackingGateway.emitSosPassengerAlert(participant.userId, {
                sosId: sos.id,
                rideId: sos.rideId,
                message:
                  'A passenger has triggered an SOS in your current ride. Please stay alert and follow safety instructions.',
              });
            }
          }
          this.trackingGateway.emitToAdminSafety(SOS_SERVER_EVENTS.TRIGGERED, {
            sosId: sos.id,
            rideId: sos.rideId,
            status: sos.status,
          });
          this.trackingGateway.emitToAdminSafety(
            SOS_SERVER_EVENTS.INCIDENT_CREATED,
            { sosId: sos.id, rideId: sos.rideId },
          );
        })
        .catch((error) => {
          this.logger.warn(
            `SOS dispatch failed sos=${sos.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    } catch (error) {
      this.logger.warn(
        `SOS post-commit dispatch failed sos=${sos.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private dispatchAdditional(
    sos: SosEvent,
    trigger: SosTrigger,
    userId: string,
  ): void {
    try {
      this.sosEvents.emitAdditionalTrigger({
        sosId: sos.id,
        rideId: sos.rideId,
        originalTriggerUserId: sos.originalTriggerUserId,
        triggeredAt: sos.triggeredAt.toISOString(),
        userId,
      });
      this.trackingGateway.emitToAdminSafety(
        SOS_SERVER_EVENTS.ADDITIONAL_TRIGGER,
        {
          sosId: sos.id,
          rideId: sos.rideId,
          userId,
        },
      );
      void this.adminAlertService.reportIncident({
        incidentKey: `sos:${sos.id}`,
        category: AdminAlertCategory.SOS,
        severity: AdminAlertSeverity.CRITICAL,
        title: 'Additional SOS trigger',
        message: `Another participant triggered SOS on ride ${sos.rideId}`,
        source: 'sos',
        metadata: { sosId: sos.id, rideId: sos.rideId, userId },
      });
    } catch (error) {
      this.logger.warn(
        `Additional SOS dispatch failed sos=${sos.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async appendTimeline(
    manager: EntityManager,
    input: {
      sosId: string;
      eventType: SosTimelineEventType;
      actorType: SosActorType;
      actorId: string | null;
      description: string;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<SosTimelineEvent> {
    const row = manager.getRepository(SosTimelineEvent).create({
      sosId: input.sosId,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId,
      description: input.description,
      metadata: input.metadata ?? null,
    });
    return manager.getRepository(SosTimelineEvent).save(row);
  }

  private normalizeLocation(dto: TriggerSosDto): {
    latitude: number;
    longitude: number;
    accuracy?: number;
  } | null {
    if (dto.latitude == null || dto.longitude == null) {
      return null;
    }
    return {
      latitude: dto.latitude,
      longitude: dto.longitude,
      accuracy: dto.accuracy,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const record = error as {
      code?: string;
      driverError?: { code?: string };
      message?: string;
    };
    if (record.code === '23505' || record.driverError?.code === '23505') {
      return true;
    }
    return /duplicate key|UQ_sos_events_one_active_per_ride|UQ_sos_triggers_idempotency/i.test(
      record.message ?? '',
    );
  }

  private displayName(profile: UserProfile | null): string | null {
    if (!profile) {
      return null;
    }
    const combined = [profile.firstName, profile.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    return profile.displayName?.trim() || combined || null;
  }

  private async toUserResponse(
    sos: SosEvent,
    flags: { created?: boolean; attached?: boolean },
  ): Promise<Record<string, unknown>> {
    const incident = await this.incidentRepository.findOne({
      where: { sosId: sos.id },
    });
    return {
      sosId: sos.id,
      rideId: sos.rideId,
      status: sos.status,
      severity: sos.severity,
      category: sos.category,
      originalTriggerUserId: sos.originalTriggerUserId,
      triggeredAt: sos.triggeredAt.toISOString(),
      incidentId: incident?.id ?? null,
      created: Boolean(flags.created),
      attachedToExisting: Boolean(flags.attached) && !flags.created,
    };
  }
}
