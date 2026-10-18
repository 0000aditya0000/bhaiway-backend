import { SupportTicketAttachment } from './entities/support-ticket-attachment.entity';
import { SupportTicketComment } from './entities/support-ticket-comment.entity';
import { SupportTicketStatusHistory } from './entities/support-ticket-status-history.entity';
import { SupportTicket } from './entities/support-ticket.entity';
import {
  SupportTicketCategory,
  SupportTicketStatus,
} from './enums/support.enums';
import {
  SupportAttachmentLimitError,
  SupportInvalidCategoryError,
  SupportRideRequiredError,
  SupportStatusTransitionError,
} from './errors/support.errors';
import { SupportService } from './support.service';

describe('SupportService (unit)', () => {
  function buildService(opts?: {
    lockedTicket?: Partial<SupportTicket> | null;
  }) {
    const savedTickets: Array<Record<string, unknown>> = [];

    const ticketRepo = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        if (opts?.lockedTicket && where.id) {
          return Promise.resolve(opts.lockedTicket);
        }
        if (where.id) {
          const created = savedTickets.find((t) => t.id === where.id);
          if (!created) return Promise.resolve(null);
          return Promise.resolve({
            ...created,
            createdAt: new Date(),
            updatedAt: new Date(),
            resolvedAt: null,
            relatedWalletTransactionId: null,
          });
        }
        return Promise.resolve(null);
      }),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) => {
        savedTickets.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const historyRepo = {
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
      find: jest.fn().mockResolvedValue([]),
    };
    const attachmentRepo = {
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
      find: jest.fn().mockResolvedValue([]),
    };
    const commentRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };

    const repoByEntity = new Map<unknown, unknown>([
      [SupportTicket, ticketRepo],
      [SupportTicketStatusHistory, historyRepo],
      [SupportTicketAttachment, attachmentRepo],
      [SupportTicketComment, commentRepo],
    ]);

    const dataSource = {
      transaction: jest.fn(async (fn: (m: unknown) => Promise<unknown>) =>
        fn({
          getRepository: (entity: unknown) => repoByEntity.get(entity),
        }),
      ),
    };

    const notificationsService = {
      safeEnqueueInTransaction: jest.fn().mockResolvedValue(undefined),
    };
    const adminAlertService = {
      recordActivity: jest.fn().mockResolvedValue(undefined),
    };

    const service = new SupportService(
      dataSource as never,
      notificationsService as never,
      adminAlertService as never,
      ticketRepo as never,
      commentRepo as never,
      attachmentRepo as never,
      historyRepo as never,
      {
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
      } as never,
      { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
    );

    return {
      service,
      notificationsService,
      savedTickets,
      ticketRepo,
      dataSource,
    };
  }

  it('rejects invalid category/subcategory combinations', async () => {
    const { service } = buildService();
    await expect(
      service.createTicket('user-1', {
        category: SupportTicketCategory.BOOKINGS_AND_RIDES,
        subcategory: 'WALLET_ISSUE',
        description: 'bad combo',
      }),
    ).rejects.toBeInstanceOf(SupportInvalidCategoryError);
  });

  it('requires relatedRideId for BOOKINGS_AND_RIDES', async () => {
    const { service } = buildService();
    await expect(
      service.createTicket('user-1', {
        category: SupportTicketCategory.BOOKINGS_AND_RIDES,
        subcategory: 'DRIVER_BEHAVIOUR',
        description: 'Driver was rude',
      }),
    ).rejects.toBeInstanceOf(SupportRideRequiredError);
  });

  it('rejects more than three attachments', async () => {
    const { service } = buildService();
    await expect(
      service.createTicket('user-1', {
        category: SupportTicketCategory.OTHERS,
        subcategory: 'OTHER',
        description: 'Help',
        attachmentUrls: [
          'https://cdn.example.com/1.jpg',
          'https://cdn.example.com/2.jpg',
          'https://cdn.example.com/3.jpg',
          'https://cdn.example.com/4.jpg',
        ],
      }),
    ).rejects.toBeInstanceOf(SupportAttachmentLimitError);
  });

  it('creates OTHERS ticket with CREATED status and enqueues notification', async () => {
    const { service, notificationsService, savedTickets } = buildService();
    const detail = await service.createTicket('user-1', {
      category: SupportTicketCategory.OTHERS,
      subcategory: 'APP_ISSUE',
      description: 'App crashes on open',
      attachmentUrls: ['https://cdn.example.com/shot.png'],
    });

    expect(savedTickets[0]?.status).toBe(SupportTicketStatus.CREATED);
    expect(detail.status).toBe(SupportTicketStatus.CREATED);
    expect(detail.category).toBe(SupportTicketCategory.OTHERS);
    expect(detail.reference).toMatch(/^SUP-/);
    expect(notificationsService.safeEnqueueInTransaction).toHaveBeenCalled();
  });

  it('rejects reopening a RESOLVED ticket', async () => {
    const lockedTicket = {
      id: 't1',
      reference: 'SUP-ABC',
      userId: 'u1',
      status: SupportTicketStatus.RESOLVED,
      assigneeAdminUserId: null,
      resolvedAt: new Date(),
    };
    const { service, ticketRepo } = buildService({ lockedTicket });
    ticketRepo.findOne.mockResolvedValue({
      ...lockedTicket,
      category: SupportTicketCategory.OTHERS,
      subcategory: 'OTHER',
      subject: 'x',
      description: 'y',
      relatedRideId: null,
      relatedBookingId: null,
      relatedWalletTransactionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.updateStatus('admin-1', 't1', {
        status: SupportTicketStatus.IN_PROGRESS,
      }),
    ).rejects.toBeInstanceOf(SupportStatusTransitionError);
  });
});
