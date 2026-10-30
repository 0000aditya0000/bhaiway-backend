import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminModule } from '../../admin/admin.module';
import { AdminUser } from '../../admin/entities/admin-user.entity';
import { AdminPermissionGuard } from '../../admin/guards/admin-permission.guard';
import { AuthModule } from '../../auth/auth.module';
import { Booking } from '../../bookings/entities/booking.entity';
import { NotificationsModule } from '../../notifications/notifications.module';
import { Ride } from '../../rides/entities/ride.entity';
import { TrackingModule } from '../../tracking/tracking.module';
import { UserProfile } from '../../users/entities/user-profile.entity';
import { User } from '../../users/entities/user.entity';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { AdminSosController } from './admin-sos.controller';
import { AdminSosService } from './admin-sos.service';
import { SafetyIncidentNote } from './entities/safety-incident-note.entity';
import { SafetyIncident } from './entities/safety-incident.entity';
import { SosEvent } from './entities/sos-event.entity';
import { SosNote } from './entities/sos-note.entity';
import { SosParticipant } from './entities/sos-participant.entity';
import { SosTimelineEvent } from './entities/sos-timeline-event.entity';
import { SosTrigger } from './entities/sos-trigger.entity';
import { SosController } from './sos.controller';
import { SosEventsService } from './sos-events.service';
import { SosService } from './sos.service';

@Module({
  imports: [
    AuthModule,
    AdminModule,
    NotificationsModule,
    TrackingModule,
    TypeOrmModule.forFeature([
      SosEvent,
      SosTrigger,
      SosParticipant,
      SosTimelineEvent,
      SosNote,
      SafetyIncident,
      SafetyIncidentNote,
      Ride,
      Booking,
      User,
      UserProfile,
      Vehicle,
      AdminUser,
    ]),
  ],
  controllers: [SosController, AdminSosController],
  providers: [
    SosService,
    AdminSosService,
    SosEventsService,
    AdminPermissionGuard,
  ],
  exports: [SosService, AdminSosService, SosEventsService, TypeOrmModule],
})
export class SosModule {}
