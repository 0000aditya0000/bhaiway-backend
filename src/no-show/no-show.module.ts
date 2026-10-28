import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssuredModule } from '../assured/assured.module';
import { AuthModule } from '../auth/auth.module';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingsModule } from '../bookings/bookings.module';
import { ChatModule } from '../chat/chat.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Ride } from '../rides/entities/ride.entity';
import { RegularCancellationModule } from '../rides/regular-cancellation.module';
import { SupportModule } from '../support/support.module';
import { NoShowClaimEffect } from './entities/no-show-claim-effect.entity';
import { NoShowClaim } from './entities/no-show-claim.entity';
import { NoShowClaimsController } from './no-show-claims.controller';
import { NoShowClaimsService } from './no-show-claims.service';
import { NoShowClaimsWorker } from './no-show-claims.worker';

@Module({
  imports: [
    TypeOrmModule.forFeature([NoShowClaim, NoShowClaimEffect, Ride, Booking]),
    AuthModule,
    RegularCancellationModule,
    AssuredModule,
    forwardRef(() => BookingsModule),
    NotificationsModule,
    SupportModule,
    ChatModule,
  ],
  controllers: [NoShowClaimsController],
  providers: [NoShowClaimsService, NoShowClaimsWorker],
  exports: [NoShowClaimsService],
})
export class NoShowModule {}
