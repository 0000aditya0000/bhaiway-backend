import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Ride } from './entities/ride.entity';
import { RegularRideCancellationService } from './regular-ride-cancellation.service';

@Module({
  imports: [TypeOrmModule.forFeature([Ride, Booking])],
  providers: [RegularRideCancellationService],
  exports: [RegularRideCancellationService],
})
export class RegularCancellationModule {}
