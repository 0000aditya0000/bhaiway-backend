import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  AdminActivityEvent,
} from './entities/admin-activity-event.entity';
import {
  AdminAlert,
  AdminAlertCategory,
  AdminAlertSeverity,
  AdminAlertStatus,
} from './entities/admin-alert.entity';

export interface ReportAdminIncidentInput {
  incidentKey: string;
  category: AdminAlertCategory | string;
  severity: AdminAlertSeverity;
  title: string;
  message: string;
  source: string;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class AdminAlertService {
  private readonly logger = new Logger(AdminAlertService.name);

  constructor(
    @InjectRepository(AdminAlert)
    private readonly alertRepository: Repository<AdminAlert>,
    @InjectRepository(AdminActivityEvent)
    private readonly activityRepository: Repository<AdminActivityEvent>,
  ) {}

  /**
   * Opens or refreshes a deduplicated incident. Does not create duplicates
   * while an OPEN/ACKNOWLEDGED alert with the same incidentKey exists.
   */
  async reportIncident(input: ReportAdminIncidentInput): Promise<AdminAlert> {
    const existing = await this.alertRepository.findOne({
      where: {
        incidentKey: input.incidentKey,
        status: In([AdminAlertStatus.OPEN, AdminAlertStatus.ACKNOWLEDGED]),
      },
    });

    if (existing) {
      existing.message = input.message;
      existing.severity = input.severity;
      existing.metadata = input.metadata ?? existing.metadata;
      return this.alertRepository.save(existing);
    }

    const alert = this.alertRepository.create({
      incidentKey: input.incidentKey,
      category: input.category,
      severity: input.severity,
      status: AdminAlertStatus.OPEN,
      title: input.title,
      message: input.message,
      source: input.source,
      metadata: input.metadata ?? null,
    });
    const saved = await this.alertRepository.save(alert);

    await this.recordActivity({
      eventType: 'ALERT_OPENED',
      category: input.category,
      severity: input.severity,
      title: input.title,
      description: input.message,
      metadata: {
        alertId: saved.id,
        incidentKey: input.incidentKey,
      },
    });

    this.logger.warn(
      `Admin alert opened category=${input.category} incident=${input.incidentKey}`,
    );
    return saved;
  }

  async resolveIncident(
    incidentKey: string,
    resolvedByUserId?: string | null,
    recoveryTitle?: string,
  ): Promise<AdminAlert | null> {
    const existing = await this.alertRepository.findOne({
      where: {
        incidentKey,
        status: In([AdminAlertStatus.OPEN, AdminAlertStatus.ACKNOWLEDGED]),
      },
    });
    if (!existing) {
      return null;
    }

    const now = new Date();
    existing.status = AdminAlertStatus.RESOLVED;
    existing.resolvedAt = now;
    existing.resolvedByUserId = resolvedByUserId ?? null;
    const saved = await this.alertRepository.save(existing);

    await this.recordActivity({
      eventType: 'ALERT_RESOLVED',
      category: existing.category,
      severity: AdminAlertSeverity.INFO,
      title: recoveryTitle ?? `${existing.title} recovered`,
      description: `Incident ${incidentKey} resolved`,
      metadata: {
        alertId: saved.id,
        incidentKey,
      },
    });

    return saved;
  }

  async recordActivity(input: {
    eventType: string;
    category: AdminAlertCategory | string;
    severity: AdminAlertSeverity;
    title: string;
    description: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<AdminActivityEvent> {
    const event = this.activityRepository.create({
      eventType: input.eventType,
      category: input.category,
      severity: input.severity,
      title: input.title,
      description: input.description,
      metadata: input.metadata ?? null,
    });
    return this.activityRepository.save(event);
  }

  async getAttentionSummary(limit = 10): Promise<{
    critical: number;
    warning: number;
    total: number;
    alerts: AdminAlert[];
  }> {
    const openStatuses = [AdminAlertStatus.OPEN, AdminAlertStatus.ACKNOWLEDGED];

    const [critical, warning, info, alerts] = await Promise.all([
      this.alertRepository.count({
        where: {
          status: In(openStatuses),
          severity: AdminAlertSeverity.CRITICAL,
        },
      }),
      this.alertRepository.count({
        where: {
          status: In(openStatuses),
          severity: AdminAlertSeverity.WARNING,
        },
      }),
      this.alertRepository.count({
        where: {
          status: In(openStatuses),
          severity: AdminAlertSeverity.INFO,
        },
      }),
      this.alertRepository.find({
        where: { status: In(openStatuses) },
        order: { createdAt: 'DESC' },
        take: limit,
      }),
    ]);

    return {
      critical,
      warning,
      total: critical + warning + info,
      alerts,
    };
  }

  async getRecentActivity(params: {
    limit: number;
    cursor?: string | null;
  }): Promise<{
    items: AdminActivityEvent[];
    nextCursor: string | null;
  }> {
    const take = Math.min(Math.max(params.limit, 1), 50);
    const qb = this.activityRepository
      .createQueryBuilder('event')
      .orderBy('event.created_at', 'DESC')
      .addOrderBy('event.id', 'DESC')
      .take(take + 1);

    if (params.cursor) {
      const cursorDate = new Date(params.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        qb.andWhere('event.created_at < :cursor', { cursor: cursorDate });
      }
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore
      ? items[items.length - 1].createdAt.toISOString()
      : null;

    return { items, nextCursor };
  }
}
