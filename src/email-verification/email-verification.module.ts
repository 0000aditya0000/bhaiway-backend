import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { User } from '../users/entities/user.entity';
import { EmailVerificationController } from './email-verification.controller';
import { EmailVerificationService } from './email-verification.service';
import { EmailVerificationOtp } from './entities/email-verification-otp.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([EmailVerificationOtp, User]),
    AuthModule,
    EmailModule,
  ],
  controllers: [EmailVerificationController],
  providers: [EmailVerificationService],
  exports: [EmailVerificationService],
})
export class EmailVerificationModule {}
