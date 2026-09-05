import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { UserVerification } from './entities/user-verification.entity';
import { StubVerificationProvider } from './providers/stub-verification.provider';
import { VERIFICATION_PROVIDER } from './providers/verification-provider.interface';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserProfile, UserVerification, Vehicle]),
    AuthModule,
  ],
  controllers: [VerificationController],
  providers: [
    VerificationService,
    StubVerificationProvider,
    {
      provide: VERIFICATION_PROVIDER,
      useExisting: StubVerificationProvider,
    },
  ],
  exports: [TypeOrmModule, VerificationService],
})
export class VerificationModule {}
