import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import {
  AdminAlertCategory,
  AdminAlertSeverity,
} from '../../admin/entities/admin-alert.entity';
import { AdminAlertService } from '../../admin/admin-alert.service';
import { AdminUser } from '../../admin/entities/admin-user.entity';
import { Ride } from '../../rides/entities/ride.entity';
import { RideStatus } from '../../rides/enums/ride.enums';
import { SOS_SERVER_EVENTS } from '../../tracking/tracking.events';
import { TrackingGateway } from '../../tracking/tracking.gateway';
import { TrackingService } from '../../tracking/tracking.service';
import {
  AdminIncidentListQueryDto,
  AdminSosListQueryDto,
  AdminSosNoteDto,
  AdminSosReasonDto,
} from './dto/admin-sos.dto';
import { SafetyIncident } from './entities/safety-incident.entity';
import { SafetyIncidentNote } from './entities/safety-incident-note.entity';
import { SosEvent } from './entities/sos-event.entity';
import { SosNote } from './entities/sos-note.entity';
import { SosParticipant } from './entities/sos-participant.entity';
import { SosTimelineEvent } from './entities/sos-timeline-event.entity';
import { SosTrigger } from './entities/sos-trigger.entity';
import {
  ACTIVE_SOS_STATUSES,
  OPEN_INCIDENT_STATUSES,
  SafetyIncidentSeverity,
  SafetyIncidentStatus,
  SosActorType,
  SosLocationFreshness,
  SosParticipantRole,
  SosStatus,
  SosTimelineEventType,
} from './enums/sos.enums';
import {
  SosInvalidTransitionError,
  SosNotFoundError,
  SosReasonRequiredError,
} from './errors/sos.errors';
import { SosService } from './sos.service';

@Injectable()
export class AdminSosService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SosEvent)
    private readonly sosRepository: Repository<SosEvent>,
    @InjectRepository(SosTrigger)
    private readonly triggerRepository: Repository<SosTrigger>,
    @InjectRepository(SosParticipant)
    private readonly participantRepository: Repository<SosParticipant>,
    @InjectRepository(SosTimelineEvent)
    private readonly timelineRepository: Repository<SosTimelineEvent>,
    @InjectRepository(SosNote)
    private readonly noteRepository: Repository<SosNote>,
    @InjectRepository(SafetyIncident)
    private readonly incidentRepository: Repository<SafetyIncident>,
    @InjectRepository(SafetyIncidentNote)
    private readonly incidentNoteRepository: Repository<SafetyIncidentNote>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(AdminUser)
    private readonly adminUserRepository: Repository<AdminUser>,
    private readonly sosService: SosService,
    private readonly trackingService: TrackingService,
    private readonly trackingGateway: TrackingGateway,
    private readonly adminAlertService: AdminAlertService,
  ) {}

  async list(query: AdminSosListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const qb = this.sosRepository
      .createQueryBuilder('sos')
      .orderBy('sos.triggeredAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.status) {
      qb.andWhere('sos.status = :status', { status: query.status });
    }
    if (query.severity) {
      qb.andWhere('sos.severity = :severity', { severity: query.severity });
    }
    if (query.rideType) {
      qb.andWhere('sos.rideType = :rideType', { rideType: query.rideType });
    }
    if (query.rideId) {
      qb.andWhere('sos.rideId = :rideId', { rideId: query.rideId });
    }
    if (query.triggerUserId) {
      qb.andWhere('sos.originalTriggerUserId = :triggerUserId', {
        triggerUserId: query.triggerUserId,
      });
    }
    if (query.from) {
      qb.andWhere('sos.triggeredAt >= :from', { from: new Date(query.from) });
    }
    if (query.to) {
      qb.andWhere('sos.triggeredAt <= :to', { to: new Date(query.to) });
    }
    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      qb.andWhere(
        '(CAST(sos.id AS text) ILIKE :term OR CAST(sos.rideId AS text) ILIKE :term)',
        { term },
      );
    }

    const [items, total] = await qb.getManyAndCount();
    const participants = items.length
      ? await this.participantRepository.find({
          where: { sosId: In(items.map((item) => item.id)) },
        })
      : [];
    const bySos = new Map<string, SosParticipant[]>();
    for (const participant of participants) {
      const list = bySos.get(participant.sosId) ?? [];
      list.push(participant);
      bySos.set(participant.sosId, list);
    }

    return {
      page,
      limit,
      total,
      items: items.map((sos) => {
        const people = bySos.get(sos.id) ?? [];
        const trigger = people.find(
          (p) => p.userId === sos.originalTriggerUserId,
        );
        const driver = people.find((p) => p.role === SosParticipantRole.DRIVER);
        return {
          sosId: sos.id,
          rideId: sos.rideId,
          rideType: sos.rideType,
          status: sos.status,
          severity: sos.severity,
          category: sos.category,
          triggeredAt: sos.triggeredAt.toISOString(),
          lastUpdatedAt: sos.updatedAt.toISOString(),
          originalTriggerer: trigger
            ? {
                userId: trigger.userId,
                name: trigger.displayName,
                role: trigger.role,
              }
            : { userId: sos.originalTriggerUserId, name: null, role: null },
          driver: driver
            ? {
                userId: driver.userId,
                name: driver.displayName,
                vehicleRegistrationNumber: driver.vehicleRegistrationNumber,
              }
            : null,
          locationSummary: {
            latitude: sos.triggerLatitude,
            longitude: sos.triggerLongitude,
            timestamp: sos.triggerLocationAt?.toISOString() ?? null,
          },
        };
      }),
    };
  }

  async getDetail(sosId: string, adminUserId: string) {
    const sos = await this.requireSos(sosId);
    const [ride, triggers, participants, timeline, notes, incident] =
      await Promise.all([
        this.rideRepository.findOneBy({ id: sos.rideId }),
        this.triggerRepository.find({
          where: { sosId: sos.id },
          order: { triggeredAt: 'ASC' },
        }),
        this.participantRepository.find({ where: { sosId: sos.id } }),
        this.timelineRepository.find({
          where: { sosId: sos.id },
          order: { createdAt: 'ASC' },
        }),
        this.noteRepository.find({
          where: { sosId: sos.id },
          order: { createdAt: 'ASC' },
        }),
        this.incidentRepository.findOne({ where: { sosId: sos.id } }),
      ]);

    await this.adminAlertService.recordActivity({
      eventType: 'SOS_DETAIL_ACCESSED',
      category: AdminAlertCategory.SOS,
      severity: AdminAlertSeverity.INFO,
      title: 'SOS detail accessed',
      description: `Admin viewed SOS ${sos.id}`,
      metadata: { sosId: sos.id, adminUserId },
    });

    const locations = await this.sosService.getLocationsForAdmin(sos.id);
    const original = participants.find(
      (p) => p.userId === sos.originalTriggerUserId,
    );
    const driver = participants.find(
      (p) => p.role === SosParticipantRole.DRIVER,
    );
    const incidentNotes = incident
      ? await this.incidentNoteRepository.find({
          where: { incidentId: incident.id },
          order: { createdAt: 'ASC' },
        })
      : [];

    return {
      sos: {
        id: sos.id,
        status: sos.status,
        category: sos.category,
        severity: sos.severity,
        triggeredAt: sos.triggeredAt.toISOString(),
        acknowledgedAt: sos.acknowledgedAt?.toISOString() ?? null,
        responseStartedAt: sos.responseStartedAt?.toISOString() ?? null,
        resolvedAt: sos.resolvedAt?.toISOString() ?? null,
        falseAlarmAt: sos.falseAlarmAt?.toISOString() ?? null,
        resolutionReason: sos.resolutionReason,
      },
      ride: ride
        ? {
            rideId: ride.id,
            rideType: ride.rideType,
            source: ride.source,
            destination: ride.destination,
            departureDate: ride.departureDate,
            departureTime: ride.departureTime,
            rideStatus: ride.status,
          }
        : null,
      originalTriggerer: original
        ? this.toParticipantDto(original)
        : { userId: sos.originalTriggerUserId },
      additionalTriggerers: triggers
        .filter((t) => !t.isOriginal)
        .map((t) => ({
          userId: t.userId,
          role: t.role,
          triggeredAt: t.triggeredAt.toISOString(),
          triggerId: t.id,
        })),
      driver: driver ? this.toParticipantDto(driver) : null,
      passengers: participants
        .filter((p) => p.role === SosParticipantRole.PASSENGER)
        .map((p) => this.toParticipantDto(p)),
      location: {
        trigger: {
          latitude: sos.triggerLatitude,
          longitude: sos.triggerLongitude,
          timestamp: sos.triggerLocationAt?.toISOString() ?? null,
          accuracy: sos.triggerAccuracy,
          freshness:
            sos.triggerLatitude == null
              ? SosLocationFreshness.MISSING
              : this.trackingService.classifyLocationFreshness(
                  (sos.triggerLocationAt ?? sos.triggeredAt).toISOString(),
                ),
        },
        participants: locations,
      },
      timeline: timeline.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        actorType: event.actorType,
        actorId: event.actorId,
        description: event.description,
        metadata: event.metadata,
        createdAt: event.createdAt.toISOString(),
      })),
      notes: notes.map((note) => ({
        id: note.id,
        body: note.body,
        authorUserId: note.authorUserId,
        createdAt: note.createdAt.toISOString(),
      })),
      incident: incident
        ? {
            id: incident.id,
            status: incident.status,
            type: incident.type,
            severity: incident.severity,
            assignedAdminUserId: incident.assignedAdminUserId,
            escalatedAt: incident.escalatedAt?.toISOString() ?? null,
            notes: incidentNotes.map((note) => ({
              id: note.id,
              body: note.body,
              authorUserId: note.authorUserId,
              createdAt: note.createdAt.toISOString(),
            })),
          }
        : null,
    };
  }

  async acknowledge(adminUserId: string, sosId: string) {
    return this.transition(adminUserId, sosId, SosStatus.ACKNOWLEDGED);
  }

  async startResponse(adminUserId: string, sosId: string) {
    return this.transition(adminUserId, sosId, SosStatus.RESPONDING);
  }

  async resolve(adminUserId: string, sosId: string, dto: AdminSosReasonDto) {
    if (!dto.reason?.trim()) {
      throw new SosReasonRequiredError();
    }
    return this.transition(adminUserId, sosId, SosStatus.RESOLVED, dto.reason);
  }

  async falseAlarm(adminUserId: string, sosId: string, dto: AdminSosReasonDto) {
    if (!dto.reason?.trim()) {
      throw new SosReasonRequiredError();
    }
    return this.transition(
      adminUserId,
      sosId,
      SosStatus.FALSE_ALARM,
      dto.reason,
    );
  }

  async addNote(adminUserId: string, sosId: string, dto: AdminSosNoteDto) {
    const admin = await this.requireAdmin(adminUserId);
    const sos = await this.requireSos(sosId);
    const note = await this.noteRepository.save(
      this.noteRepository.create({
        sosId: sos.id,
        authorAdminUserId: admin.id,
        authorUserId: adminUserId,
        body: dto.body.trim(),
      }),
    );
    await this.sosService.appendTimeline(this.dataSource.manager, {
      sosId: sos.id,
      eventType: SosTimelineEventType.NOTE_ADDED,
      actorType: SosActorType.ADMIN,
      actorId: adminUserId,
      description: 'Admin note added',
      metadata: { noteId: note.id },
    });
    this.trackingGateway.emitToAdminSafety(
      SOS_SERVER_EVENTS.INCIDENT_NOTE_ADDED,
      {
        sosId: sos.id,
        noteId: note.id,
      },
    );
    return {
      id: note.id,
      sosId: sos.id,
      body: note.body,
      createdAt: note.createdAt.toISOString(),
    };
  }

  async getLocations(adminUserId: string, sosId: string) {
    const sos = await this.requireSos(sosId);
    await this.adminAlertService.recordActivity({
      eventType: 'SOS_LOCATIONS_ACCESSED',
      category: AdminAlertCategory.SOS,
      severity: AdminAlertSeverity.INFO,
      title: 'SOS locations accessed',
      description: `Admin viewed SOS locations ${sos.id}`,
      metadata: { sosId: sos.id, adminUserId },
    });
    return {
      sosId: sos.id,
      rideId: sos.rideId,
      participants: await this.sosService.getLocationsForAdmin(sos.id),
    };
  }

  async listIncidents(query: AdminIncidentListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const qb = this.incidentRepository
      .createQueryBuilder('incident')
      .orderBy('incident.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.status) {
      qb.andWhere('incident.status = :status', { status: query.status });
    }
    if (query.severity) {
      qb.andWhere('incident.severity = :severity', {
        severity: query.severity,
      });
    }
    if (query.type) {
      qb.andWhere('incident.type = :type', { type: query.type });
    }
    if (query.search?.trim()) {
      qb.andWhere(
        '(CAST(incident.id AS text) ILIKE :term OR CAST(incident.sosId AS text) ILIKE :term OR incident.title ILIKE :term)',
        { term: `%${query.search.trim()}%` },
      );
    }
    const [items, total] = await qb.getManyAndCount();
    return {
      page,
      limit,
      total,
      items: items.map((incident) => ({
        id: incident.id,
        sosId: incident.sosId,
        rideId: incident.rideId,
        type: incident.type,
        status: incident.status,
        severity: incident.severity,
        title: incident.title,
        assignedAdminUserId: incident.assignedAdminUserId,
        createdAt: incident.createdAt.toISOString(),
        updatedAt: incident.updatedAt.toISOString(),
      })),
    };
  }

  async getIncident(incidentId: string) {
    const incident = await this.incidentRepository.findOneBy({
      id: incidentId,
    });
    if (!incident) {
      throw new SosNotFoundError('Incident not found');
    }
    const notes = await this.incidentNoteRepository.find({
      where: { incidentId: incident.id },
      order: { createdAt: 'ASC' },
    });
    const timeline = incident.sosId
      ? await this.timelineRepository.find({
          where: { sosId: incident.sosId },
          order: { createdAt: 'ASC' },
        })
      : [];
    return {
      ...incident,
      createdAt: incident.createdAt.toISOString(),
      updatedAt: incident.updatedAt.toISOString(),
      notes: notes.map((note) => ({
        id: note.id,
        body: note.body,
        authorUserId: note.authorUserId,
        createdAt: note.createdAt.toISOString(),
      })),
      timeline: timeline.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        description: event.description,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  async acknowledgeIncident(adminUserId: string, incidentId: string) {
    const admin = await this.requireAdmin(adminUserId);
    const incident = await this.incidentRepository.findOneBy({
      id: incidentId,
    });
    if (!incident) {
      throw new SosNotFoundError('Incident not found');
    }
    if (
      incident.status === SafetyIncidentStatus.ACKNOWLEDGED ||
      incident.status === SafetyIncidentStatus.ASSIGNED ||
      incident.status === SafetyIncidentStatus.ESCALATED ||
      incident.status === SafetyIncidentStatus.RESOLVED ||
      incident.status === SafetyIncidentStatus.CLOSED
    ) {
      return this.getIncident(incident.id);
    }
    incident.status = SafetyIncidentStatus.ACKNOWLEDGED;
    await this.incidentRepository.save(incident);
    if (incident.sosId) {
      await this.sosService.appendTimeline(this.dataSource.manager, {
        sosId: incident.sosId,
        eventType: SosTimelineEventType.ACKNOWLEDGED,
        actorType: SosActorType.ADMIN,
        actorId: adminUserId,
        description: 'Incident acknowledged',
        metadata: { incidentId: incident.id, adminId: admin.id },
      });
    }
    this.trackingGateway.emitToAdminSafety(SOS_SERVER_EVENTS.INCIDENT_UPDATED, {
      incidentId: incident.id,
      status: incident.status,
    });
    return this.getIncident(incident.id);
  }

  async assignIncidentToMe(adminUserId: string, incidentId: string) {
    const admin = await this.requireAdmin(adminUserId);
    const incident = await this.incidentRepository.findOneBy({
      id: incidentId,
    });
    if (!incident) {
      throw new SosNotFoundError('Incident not found');
    }
    if (incident.assignedAdminUserId === admin.id) {
      return this.getIncident(incident.id);
    }
    incident.assignedAdminUserId = admin.id;
    incident.assignedAt = new Date();
    if (
      incident.status === SafetyIncidentStatus.OPEN ||
      incident.status === SafetyIncidentStatus.ACKNOWLEDGED
    ) {
      incident.status = SafetyIncidentStatus.ASSIGNED;
    }
    await this.incidentRepository.save(incident);
    if (incident.sosId) {
      await this.sosService.appendTimeline(this.dataSource.manager, {
        sosId: incident.sosId,
        eventType: SosTimelineEventType.ASSIGNED,
        actorType: SosActorType.ADMIN,
        actorId: adminUserId,
        description: 'Incident assigned',
        metadata: { incidentId: incident.id },
      });
    }
    this.trackingGateway.emitToAdminSafety(SOS_SERVER_EVENTS.INCIDENT_UPDATED, {
      incidentId: incident.id,
      status: incident.status,
    });
    return this.getIncident(incident.id);
  }

  async escalateIncident(adminUserId: string, incidentId: string) {
    const admin = await this.requireAdmin(adminUserId);
    const incident = await this.incidentRepository.findOneBy({
      id: incidentId,
    });
    if (!incident) {
      throw new SosNotFoundError('Incident not found');
    }
    if (incident.status === SafetyIncidentStatus.ESCALATED) {
      return this.getIncident(incident.id);
    }
    incident.status = SafetyIncidentStatus.ESCALATED;
    incident.escalatedAt = new Date();
    incident.escalatedByAdminUserId = admin.id;
    await this.incidentRepository.save(incident);
    if (incident.sosId) {
      await this.sosService.appendTimeline(this.dataSource.manager, {
        sosId: incident.sosId,
        eventType: SosTimelineEventType.ESCALATED,
        actorType: SosActorType.ADMIN,
        actorId: adminUserId,
        description: 'Incident escalated',
        metadata: { incidentId: incident.id },
      });
    }
    this.trackingGateway.emitToAdminSafety(SOS_SERVER_EVENTS.INCIDENT_UPDATED, {
      incidentId: incident.id,
      status: incident.status,
    });
    return this.getIncident(incident.id);
  }

  async resolveIncident(
    adminUserId: string,
    incidentId: string,
    dto: AdminSosReasonDto,
  ) {
    if (!dto.reason?.trim()) {
      throw new SosReasonRequiredError();
    }
    const admin = await this.requireAdmin(adminUserId);
    const incident = await this.incidentRepository.findOneBy({
      id: incidentId,
    });
    if (!incident) {
      throw new SosNotFoundError('Incident not found');
    }
    if (incident.status === SafetyIncidentStatus.RESOLVED) {
      return this.getIncident(incident.id);
    }
    incident.status = SafetyIncidentStatus.RESOLVED;
    incident.resolvedAt = new Date();
    incident.resolvedByAdminUserId = admin.id;
    incident.resolutionNote = dto.reason.trim();
    await this.incidentRepository.save(incident);
    this.trackingGateway.emitToAdminSafety(SOS_SERVER_EVENTS.INCIDENT_UPDATED, {
      incidentId: incident.id,
      status: incident.status,
    });
    return this.getIncident(incident.id);
  }

  async addIncidentNote(
    adminUserId: string,
    incidentId: string,
    dto: AdminSosNoteDto,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const incident = await this.incidentRepository.findOneBy({
      id: incidentId,
    });
    if (!incident) {
      throw new SosNotFoundError('Incident not found');
    }
    const note = await this.incidentNoteRepository.save(
      this.incidentNoteRepository.create({
        incidentId: incident.id,
        authorAdminUserId: admin.id,
        authorUserId: adminUserId,
        body: dto.body.trim(),
      }),
    );
    this.trackingGateway.emitToAdminSafety(
      SOS_SERVER_EVENTS.INCIDENT_NOTE_ADDED,
      {
        incidentId: incident.id,
        noteId: note.id,
      },
    );
    return {
      id: note.id,
      incidentId: incident.id,
      body: note.body,
      createdAt: note.createdAt.toISOString(),
    };
  }

  async liveMonitoringSummary() {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [
      activeRideCount,
      activeSosCount,
      criticalIncidentCount,
      openIncidentCount,
    ] = await Promise.all([
      this.rideRepository.count({ where: { status: RideStatus.IN_PROGRESS } }),
      this.sosRepository.count({ where: { status: In(ACTIVE_SOS_STATUSES) } }),
      this.incidentRepository.count({
        where: {
          status: In(OPEN_INCIDENT_STATUSES),
          severity: SafetyIncidentSeverity.CRITICAL,
        },
      }),
      this.incidentRepository.count({
        where: { status: In(OPEN_INCIDENT_STATUSES) },
      }),
    ]);
    const eventsTodayCount = await this.timelineRepository
      .createQueryBuilder('event')
      .where('event.createdAt >= :start', { start: startOfDay })
      .getCount();

    return {
      activeRideCount,
      activeSosCount,
      criticalIncidentCount,
      openIncidentCount,
      routeDeviationCount: 0,
      routeDeviationDetectionEnabled: false,
      eventsToday: eventsTodayCount,
    };
  }

  async liveMonitoringMap() {
    const rides = await this.rideRepository.find({
      where: { status: RideStatus.IN_PROGRESS },
      select: { id: true, status: true, rideType: true, driverId: true },
    });
    const { locations } = await this.trackingService.getStoredLocationsForRides(
      rides.map((ride) => ride.id),
    );
    const activeSos = await this.sosRepository.find({
      where: { status: In(ACTIVE_SOS_STATUSES) },
    });
    const markers: Record<string, unknown>[] = [];
    for (const ride of rides) {
      const loc = locations.get(ride.id);
      if (!loc) {
        continue;
      }
      markers.push({
        id: ride.id,
        entityType: 'ACTIVE_RIDE',
        rideId: ride.id,
        latitude: loc.latitude,
        longitude: loc.longitude,
        timestamp: loc.updatedAt,
        status: ride.status,
        freshness: this.trackingService.classifyLocationFreshness(
          loc.updatedAt,
        ),
      });
    }
    for (const sos of activeSos) {
      const loc = locations.get(sos.rideId);
      const lat = loc?.latitude ?? sos.triggerLatitude;
      const lng = loc?.longitude ?? sos.triggerLongitude;
      if (lat == null || lng == null) {
        continue;
      }
      markers.push({
        id: sos.id,
        entityType: 'ACTIVE_SOS',
        rideId: sos.rideId,
        latitude: lat,
        longitude: lng,
        timestamp:
          loc?.updatedAt ??
          sos.triggerLocationAt?.toISOString() ??
          sos.triggeredAt.toISOString(),
        status: sos.status,
        severity: sos.severity,
        freshness: this.trackingService.classifyLocationFreshness(
          loc?.updatedAt ?? sos.triggerLocationAt?.toISOString() ?? null,
        ),
      });
    }
    return { markers };
  }

  async liveMonitoringActiveSos() {
    const listed = await this.list({
      status: SosStatus.TRIGGERED,
      page: 1,
      limit: 50,
    });
    const responding = await this.list({
      status: SosStatus.ACKNOWLEDGED,
      page: 1,
      limit: 50,
    });
    const inResponse = await this.list({
      status: SosStatus.RESPONDING,
      page: 1,
      limit: 50,
    });
    return {
      items: [...listed.items, ...responding.items, ...inResponse.items],
    };
  }

  private async transition(
    adminUserId: string,
    sosId: string,
    next: SosStatus,
    reason?: string,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const saved = await this.dataSource.transaction(async (manager) => {
      const sos = await manager
        .getRepository(SosEvent)
        .createQueryBuilder('sos')
        .setLock('pessimistic_write')
        .where('sos.id = :sosId', { sosId })
        .getOne();
      if (!sos) {
        throw new SosNotFoundError();
      }
      if (sos.status === next) {
        return { sos, skipped: true as const };
      }
      this.assertTransition(sos.status, next);
      const now = new Date();
      if (next === SosStatus.ACKNOWLEDGED) {
        sos.status = next;
        sos.acknowledgedAt = now;
        sos.acknowledgedByAdminId = admin.id;
      } else if (next === SosStatus.RESPONDING) {
        sos.status = next;
        sos.responseStartedAt = now;
        sos.responseStartedByAdminId = admin.id;
      } else if (next === SosStatus.RESOLVED) {
        sos.status = next;
        sos.resolvedAt = now;
        sos.resolvedByAdminId = admin.id;
        sos.resolutionReason = reason ?? null;
      } else if (next === SosStatus.FALSE_ALARM) {
        sos.status = next;
        sos.falseAlarmAt = now;
        sos.falseAlarmByAdminId = admin.id;
        sos.resolutionReason = reason ?? null;
      }
      const saved = await manager.getRepository(SosEvent).save(sos);
      const eventType =
        next === SosStatus.ACKNOWLEDGED
          ? SosTimelineEventType.ACKNOWLEDGED
          : next === SosStatus.RESPONDING
            ? SosTimelineEventType.RESPONSE_STARTED
            : next === SosStatus.FALSE_ALARM
              ? SosTimelineEventType.FALSE_ALARM
              : SosTimelineEventType.RESOLVED;
      await this.sosService.appendTimeline(manager, {
        sosId: saved.id,
        eventType,
        actorType: SosActorType.ADMIN,
        actorId: adminUserId,
        description: `SOS ${next.toLowerCase()}`,
        metadata: reason ? { reason } : null,
      });

      const incident = await manager.getRepository(SafetyIncident).findOne({
        where: { sosId: saved.id },
      });
      if (incident) {
        if (
          next === SosStatus.ACKNOWLEDGED &&
          incident.status === SafetyIncidentStatus.OPEN
        ) {
          incident.status = SafetyIncidentStatus.ACKNOWLEDGED;
          await manager.getRepository(SafetyIncident).save(incident);
        }
        if (next === SosStatus.FALSE_ALARM) {
          incident.status = SafetyIncidentStatus.RESOLVED;
          incident.resolvedAt = now;
          incident.resolvedByAdminUserId = admin.id;
          incident.resolutionNote = reason ?? 'False alarm';
          await manager.getRepository(SafetyIncident).save(incident);
        }
      }

      return { sos: saved, skipped: false as const };
    });
    if (!saved.skipped) {
      const socketEvent =
        next === SosStatus.ACKNOWLEDGED
          ? SOS_SERVER_EVENTS.ACKNOWLEDGED
          : next === SosStatus.RESPONDING
            ? SOS_SERVER_EVENTS.RESPONDING
            : next === SosStatus.FALSE_ALARM
              ? SOS_SERVER_EVENTS.FALSE_ALARM
              : SOS_SERVER_EVENTS.RESOLVED;
      this.trackingGateway.emitToAdminSafety(socketEvent, {
        sosId: saved.sos.id,
        rideId: saved.sos.rideId,
        status: saved.sos.status,
      });
    }
    return this.toLifecycleResponse(saved.sos);
  }

  private assertTransition(current: SosStatus, next: SosStatus): void {
    const allowed: Record<SosStatus, SosStatus[]> = {
      [SosStatus.TRIGGERED]: [
        SosStatus.ACKNOWLEDGED,
        SosStatus.RESOLVED,
        SosStatus.FALSE_ALARM,
      ],
      [SosStatus.ACKNOWLEDGED]: [
        SosStatus.RESPONDING,
        SosStatus.RESOLVED,
        SosStatus.FALSE_ALARM,
      ],
      [SosStatus.RESPONDING]: [SosStatus.RESOLVED, SosStatus.FALSE_ALARM],
      [SosStatus.RESOLVED]: [],
      [SosStatus.FALSE_ALARM]: [],
    };
    if (!allowed[current].includes(next)) {
      throw new SosInvalidTransitionError(
        `Cannot transition SOS from ${current} to ${next}`,
      );
    }
  }

  private toLifecycleResponse(sos: SosEvent) {
    return {
      sosId: sos.id,
      rideId: sos.rideId,
      status: sos.status,
      acknowledgedAt: sos.acknowledgedAt?.toISOString() ?? null,
      responseStartedAt: sos.responseStartedAt?.toISOString() ?? null,
      resolvedAt: sos.resolvedAt?.toISOString() ?? null,
      falseAlarmAt: sos.falseAlarmAt?.toISOString() ?? null,
      resolutionReason: sos.resolutionReason,
    };
  }

  private toParticipantDto(participant: SosParticipant) {
    return {
      userId: participant.userId,
      role: participant.role,
      name: participant.displayName,
      phone: participant.phone,
      profilePhoto: participant.profilePhoto,
      bookingId: participant.bookingId,
      bookingStatus: participant.bookingStatus,
      pickupStatus: participant.pickupStatus,
      vehicleId: participant.vehicleId,
      vehicleMake: participant.vehicleMake,
      vehicleModel: participant.vehicleModel,
      vehicleRegistrationNumber: participant.vehicleRegistrationNumber,
      vehicleColor: participant.vehicleColor,
    };
  }

  private async requireSos(sosId: string): Promise<SosEvent> {
    const sos = await this.sosRepository.findOneBy({ id: sosId });
    if (!sos) {
      throw new SosNotFoundError();
    }
    return sos;
  }

  private async requireAdmin(adminUserId: string): Promise<AdminUser> {
    const admin = await this.adminUserRepository.findOne({
      where: { userId: adminUserId, isActive: true },
    });
    if (!admin) {
      throw new SosNotFoundError('Admin not found');
    }
    return admin;
  }
}
