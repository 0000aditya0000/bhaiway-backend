import { Logger, Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { User } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { NotificationDevice } from './entities/notification-device.entity';
import { NotificationEmailDelivery } from './entities/notification-email-delivery.entity';
import { Notification } from './entities/notification.entity';
import { NotificationEmailService } from './notification-email.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsDispatcher } from './notifications.dispatcher';
import { NotificationsService } from './notifications.service';
import { NOTIFICATION_PROVIDER } from './notifications.types';
import { FirebaseNotificationProvider } from './providers/firebase-notification.provider';
import { MockNotificationProvider } from './providers/mock-notification.provider';

@Module({
  imports: [
    ConfigModule,
    EmailModule,
    // forwardRef: Auth → Referrals → Wallet/Notifications → Auth
    forwardRef(() => AuthModule),
    TypeOrmModule.forFeature([
      Notification,
      NotificationDevice,
      NotificationEmailDelivery,
      UserProfile,
      User,
    ]),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsDispatcher,
    NotificationEmailService,
    FirebaseNotificationProvider,
    MockNotificationProvider,
    {
      provide: NOTIFICATION_PROVIDER,
      inject: [
        ConfigService,
        FirebaseNotificationProvider,
        MockNotificationProvider,
      ],
      useFactory: (
        config: ConfigService,
        firebase: FirebaseNotificationProvider,
        mock: MockNotificationProvider,
      ) => {
        const logger = new Logger('NotificationsModule');
        const requested =
          config.get<string>('NOTIFICATION_PROVIDER')?.trim().toLowerCase() ??
          '';
        const nodeEnv = config.get<string>('NODE_ENV')?.trim() ?? '';
        const forceMock = requested === 'mock' || nodeEnv === 'test';
        const selected = forceMock ? mock : firebase;
        logger.log(
          `[NOTIFICATIONS] provider=${forceMock ? 'mock' : 'firebase'} requested=${requested || '(default)'} nodeEnv=${nodeEnv || '(unset)'}`,
        );
        return selected;
      },
    },
  ],
  exports: [
    NotificationsService,
    NotificationsDispatcher,
    NotificationEmailService,
    MockNotificationProvider,
    NOTIFICATION_PROVIDER,
  ],
})
export class NotificationsModule {}
