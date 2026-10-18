import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { Booking } from '../bookings/entities/booking.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Ride } from '../rides/entities/ride.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { AdminSupportController } from './admin-support.controller';
import { SupportTicketAttachment } from './entities/support-ticket-attachment.entity';
import { SupportTicketComment } from './entities/support-ticket-comment.entity';
import { SupportTicketStatusHistory } from './entities/support-ticket-status-history.entity';
import { SupportTicket } from './entities/support-ticket.entity';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SupportTicket,
      SupportTicketComment,
      SupportTicketAttachment,
      SupportTicketStatusHistory,
      Ride,
      Booking,
      WalletTransaction,
      UserProfile,
    ]),
    forwardRef(() => AuthModule),
    forwardRef(() => AdminModule),
    NotificationsModule,
  ],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
