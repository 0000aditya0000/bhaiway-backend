import { NotificationEmailDeliveryStatus } from './enums/notification-email.enums';
import { NotificationType } from './enums/notification.enums';
import { NotificationEmailService } from './notification-email.service';

describe('NotificationEmailService', () => {
  const notificationId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';

  function makeService(opts: {
    user?: { email: string | null; emailVerified: boolean } | null;
    sendEmail?: jest.Mock;
  }) {
    const sendEmail =
      opts.sendEmail ?? jest.fn().mockResolvedValue(undefined);
    const delivery = {
      id: 'd1',
      notificationId,
      status: NotificationEmailDeliveryStatus.PENDING,
      recipientEmail: null as string | null,
      skipReason: null as string | null,
      attemptCount: 0,
      nextAttemptAt: null as Date | null,
      sentAt: null as Date | null,
      failedAt: null as Date | null,
      failureReason: null as string | null,
    };

    const deliveryRepository = {
      findOne: jest.fn().mockResolvedValue(delivery),
      save: jest.fn(async (row: typeof delivery) => row),
      create: jest.fn((row: unknown) => row),
      find: jest.fn().mockResolvedValue([]),
    };

    const notificationRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: notificationId,
        recipientUserId: userId,
        type: NotificationType.WALLET_CREDITED,
        title: 'Wallet credited',
        body: '₹50 added to your wallet.',
        data: { type: NotificationType.WALLET_CREDITED },
      }),
    };

    const userRepository = {
      findOne: jest.fn().mockResolvedValue(
        opts.user === undefined
          ? { email: 'user@example.com', emailVerified: true }
          : opts.user,
      ),
    };

    const smtp = { sendEmail } as never;

    const service = new NotificationEmailService(
      smtp,
      deliveryRepository as never,
      notificationRepository as never,
      userRepository as never,
    );

    return { service, sendEmail, delivery, deliveryRepository, userRepository };
  }

  it('sends email to verified users', async () => {
    const { service, sendEmail, delivery } = makeService({});
    await service.deliver(notificationId);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Wallet credited',
      }),
    );
    expect(delivery.status).toBe(NotificationEmailDeliveryStatus.SENT);
  });

  it('skips unverified users without sending', async () => {
    const { service, sendEmail, delivery } = makeService({
      user: { email: 'user@example.com', emailVerified: false },
    });
    await service.deliver(notificationId);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(delivery.status).toBe(NotificationEmailDeliveryStatus.SKIPPED);
    expect(delivery.skipReason).toBe('email_unverified');
  });

  it('skips missing email without failing', async () => {
    const { service, sendEmail, delivery } = makeService({
      user: { email: null, emailVerified: false },
    });
    await service.deliver(notificationId);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(delivery.status).toBe(NotificationEmailDeliveryStatus.SKIPPED);
    expect(delivery.skipReason).toBe('email_missing');
  });

  it('keeps delivery row on provider failure and does not throw', async () => {
    const sendEmail = jest
      .fn()
      .mockRejectedValue(new Error('SMTP unavailable'));
    const { service, delivery } = makeService({ sendEmail });
    await service.deliver(notificationId);
    expect(delivery.status).toBe(NotificationEmailDeliveryStatus.PENDING);
    expect(delivery.attemptCount).toBe(1);
    expect(delivery.failureReason).toContain('SMTP unavailable');
    expect(delivery.nextAttemptAt).toBeInstanceOf(Date);
    expect(delivery.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not resend when already SENT', async () => {
    const { service, sendEmail, delivery } = makeService({});
    delivery.status = NotificationEmailDeliveryStatus.SENT;
    await service.deliver(notificationId);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
