import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { Booking } from '../bookings/entities/booking.entity';
import { Ride } from '../rides/entities/ride.entity';
import { redisClientProvider } from './redis/redis.provider';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { REDIS_CLIENT } from './tracking.constants';

/** Global so AppModule + RidesModule share one Redis client instance. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Ride, Booking]), AuthModule],
  controllers: [TrackingController],
  providers: [redisClientProvider, TrackingService],
  exports: [TrackingService, REDIS_CLIENT],
})
export class TrackingModule {}
