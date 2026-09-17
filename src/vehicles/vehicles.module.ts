import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserIdentityVerification } from '../verification/entities/user-identity-verification.entity';
import { VehicleRcVerification } from '../verification/entities/vehicle-rc-verification.entity';
import { VerificationModule } from '../verification/verification.module';
import { Vehicle } from './entities/vehicle.entity';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Vehicle,
      User,
      UserProfile,
      UserIdentityVerification,
      VehicleRcVerification,
    ]),
    AuthModule,
    VerificationModule,
  ],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [TypeOrmModule, VehiclesService],
})
export class VehiclesModule {}
