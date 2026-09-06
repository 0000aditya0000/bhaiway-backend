import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { NotificationDevice } from './entities/notification-device.entity';
import { Notification } from './entities/notification.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsDispatcher } from './notifications.dispatcher';
import { NotificationsService } from './notifications.service';
import { NOTIFICATION_PROVIDER } from './notifications.types';
import { FirebaseNotificationProvider } from './providers/firebase-notification.provider';
import { MockNotificationProvider } from './providers/mock-notification.provider';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    TypeOrmModule.forFeature([Notification, NotificationDevice, UserProfile]),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsDispatcher,
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
        const forceMock =
          config.get<string>('NOTIFICATION_PROVIDER') === 'mock' ||
          config.get<string>('NODE_ENV') === 'test';
        return forceMock ? mock : firebase;
      },
    },
  ],
  exports: [
    NotificationsService,
    NotificationsDispatcher,
    MockNotificationProvider,
    NOTIFICATION_PROVIDER,
  ],
})
export class NotificationsModule {}
