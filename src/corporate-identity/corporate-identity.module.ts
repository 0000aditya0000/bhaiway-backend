import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { User } from '../users/entities/user.entity';
import { CorporateIdentityController } from './corporate-identity.controller';
import { CorporateIdentityService } from './corporate-identity.service';
import { CorporateIdentityVerification } from './entities/corporate-identity-verification.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CorporateIdentityVerification, User]),
    AuthModule,
    EmailVerificationModule,
  ],
  controllers: [CorporateIdentityController],
  providers: [CorporateIdentityService],
  exports: [CorporateIdentityService],
})
export class CorporateIdentityModule {}
