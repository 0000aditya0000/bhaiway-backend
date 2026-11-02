import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminModule } from '../../admin/admin.module';
import { AdminUser } from '../../admin/entities/admin-user.entity';
import { AdminPermissionGuard } from '../../admin/guards/admin-permission.guard';
import { AdminAccountDeletionController } from '../../admin/admin-account-deletion.controller';
import { Booking } from '../../bookings/entities/booking.entity';
import { NoShowClaimEffect } from '../../no-show/entities/no-show-claim-effect.entity';
import { NoShowClaim } from '../../no-show/entities/no-show-claim.entity';
import { NotificationDevice } from '../../notifications/entities/notification-device.entity';
import { NotificationsModule } from '../../notifications/notifications.module';
import { RideSeries } from '../../rides/entities/ride-series.entity';
import { Ride } from '../../rides/entities/ride.entity';
import { SafetyIncidentNote } from '../../safety/sos/entities/safety-incident-note.entity';
import { SafetyIncident } from '../../safety/sos/entities/safety-incident.entity';
import { SosEvent } from '../../safety/sos/entities/sos-event.entity';
import { SosNote } from '../../safety/sos/entities/sos-note.entity';
import { SosParticipant } from '../../safety/sos/entities/sos-participant.entity';
import { SosTimelineEvent } from '../../safety/sos/entities/sos-timeline-event.entity';
import { SosTrigger } from '../../safety/sos/entities/sos-trigger.entity';
import { TrustedContact } from '../../safety/trusted-contacts/entities/trusted-contact.entity';
import { SupportTicketAttachment } from '../../support/entities/support-ticket-attachment.entity';
import { SupportTicketComment } from '../../support/entities/support-ticket-comment.entity';
import { SupportTicketStatusHistory } from '../../support/entities/support-ticket-status-history.entity';
import { SupportTicket } from '../../support/entities/support-ticket.entity';
import { UserProfile } from '../entities/user-profile.entity';
import { User } from '../entities/user.entity';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { PaymentOrder } from '../../wallet/entities/payment-order.entity';
import { WalletBalance } from '../../wallet/entities/wallet-balance.entity';
import { WalletHoldAllocation } from '../../wallet/entities/wallet-hold-allocation.entity';
import { WalletHold } from '../../wallet/entities/wallet-hold.entity';
import { WalletPointLot } from '../../wallet/entities/wallet-point-lot.entity';
import { WalletTransaction } from '../../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { Withdrawal } from '../../wallet/entities/withdrawal.entity';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionEligibilityService } from './account-deletion-eligibility.service';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionAuditLog } from './entities/account-deletion-audit-log.entity';
import { AccountDeletionRequest } from './entities/account-deletion-request.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AccountDeletionRequest,
      AccountDeletionAuditLog,
      User,
      UserProfile,
      Ride,
      RideSeries,
      Booking,
      Vehicle,
      Wallet,
      WalletBalance,
      WalletHold,
      WalletHoldAllocation,
      WalletPointLot,
      WalletTransaction,
      PaymentOrder,
      Withdrawal,
      SosEvent,
      SosTrigger,
      SosParticipant,
      SosTimelineEvent,
      SosNote,
      SafetyIncident,
      SafetyIncidentNote,
      SupportTicket,
      SupportTicketComment,
      SupportTicketAttachment,
      SupportTicketStatusHistory,
      NoShowClaim,
      NoShowClaimEffect,
      NotificationDevice,
      TrustedContact,
      AdminUser,
    ]),
    AdminModule,
    NotificationsModule,
  ],
  controllers: [AccountDeletionController, AdminAccountDeletionController],
  providers: [
    AccountDeletionEligibilityService,
    AccountDeletionService,
    AdminPermissionGuard,
  ],
  exports: [
    AccountDeletionEligibilityService,
    AccountDeletionService,
    TypeOrmModule,
  ],
})
export class AccountDeletionModule {}
