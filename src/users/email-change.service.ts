import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import {
  isValidEmailOtpFormat,
  normalizeEmail,
} from '../email-verification/email-otp.util';
import { EmailVerificationOtp } from '../email-verification/entities/email-verification-otp.entity';
import { EmailOtpPurpose } from '../email-verification/enums/email-otp-purpose.enum';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import { EmailVerificationInvalidError } from '../email-verification/email-verification.errors';
import { User } from './entities/user.entity';
import {
  EmailAlreadyRegisteredError,
  EmailSameAsCurrentError,
  NoPendingEmailChangeError,
  PendingEmailMismatchError,
} from './errors/email-change.errors';
import {
  buildEmailChangeVerificationHtml,
  buildEmailChangeVerificationText,
  EMAIL_CHANGE_VERIFICATION_SUBJECT,
} from './templates/email-change-verification.template';

export interface EmailChangeResponse {
  success: boolean;
  message: string;
  user: {
    email: string;
    emailVerified: boolean;
  };
}

@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger(EmailChangeService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(EmailVerificationOtp)
    private readonly otpRepository: Repository<EmailVerificationOtp>,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly dataSource: DataSource,
  ) {}

  async requestEmailChange(
    userId: string,
    rawNewEmail: string,
  ): Promise<{ success: boolean; message: string }> {
    const newEmail = normalizeEmail(rawNewEmail);
    const user = await this.requireUser(userId);

    if (user.email && normalizeEmail(user.email) === newEmail) {
      throw new EmailSameAsCurrentError(
        'New email cannot be the same as your current email.',
      );
    }

    const existingUser = await this.userRepository.findOne({
      where: { email: newEmail },
    });
    if (existingUser && existingUser.id !== userId) {
      throw new EmailAlreadyRegisteredError(
        'This email address is already registered to another account.',
      );
    }

    await this.emailVerificationService.sendOtpForPurpose({
      userId,
      email: newEmail,
      purpose: EmailOtpPurpose.CHANGE_EMAIL,
      subject: EMAIL_CHANGE_VERIFICATION_SUBJECT,
      buildHtml: buildEmailChangeVerificationHtml,
      buildText: buildEmailChangeVerificationText,
      rateLimitByPurposeOnly: true,
      invalidateAllForPurpose: true,
    });

    this.logger.log(`Change email OTP requested for user=${userId}`);

    return {
      success: true,
      message: 'Verification OTP sent to your new email address.',
    };
  }

  async verifyEmailChange(
    userId: string,
    rawNewEmail: string,
    rawOtp: string,
  ): Promise<EmailChangeResponse> {
    const otp = rawOtp.trim();
    if (!isValidEmailOtpFormat(otp)) {
      throw new EmailVerificationInvalidError();
    }

    const newEmail = normalizeEmail(rawNewEmail);
    await this.requireUser(userId);

    const pendingRecord = await this.otpRepository.findOne({
      where: {
        userId,
        purpose: EmailOtpPurpose.CHANGE_EMAIL,
        verifiedAt: IsNull(),
        invalidatedAt: IsNull(),
      },
      order: { sentAt: 'DESC' },
    });

    if (!pendingRecord) {
      throw new NoPendingEmailChangeError(
        'No pending email change request was found.',
      );
    }

    if (pendingRecord.email !== newEmail) {
      throw new PendingEmailMismatchError(
        'The submitted email does not match your pending email change request.',
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const otpOutcome =
        await this.emailVerificationService.evaluateOtpInTransaction(manager, {
          userId,
          email: newEmail,
          otp,
          purpose: EmailOtpPurpose.CHANGE_EMAIL,
        });

      if (otpOutcome !== 'OK') {
        return { kind: 'otp' as const, otpOutcome };
      }

      const userRepo = manager.getRepository(User);
      const lockedUser = await userRepo.findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!lockedUser) {
        throw new NotFoundException('User not found');
      }

      const existingOwner = await userRepo.findOne({
        where: { email: newEmail },
        lock: { mode: 'pessimistic_write' },
      });

      if (existingOwner && existingOwner.id !== userId) {
        throw new EmailAlreadyRegisteredError(
          'This email address is already registered to another account.',
        );
      }

      lockedUser.email = newEmail;
      lockedUser.emailVerified = true;
      const saved = await userRepo.save(lockedUser);

      return { kind: 'success' as const, user: saved };
    });

    if (result.kind !== 'success') {
      this.logger.log(
        `Email change OTP verification failed for user=${userId}`,
      );
      this.emailVerificationService.throwForOtpOutcome(result.otpOutcome);
      throw new Error('unreachable');
    }

    this.logger.log(`Email address updated successfully for user=${userId}`);

    return {
      success: true,
      message: 'Email address updated successfully.',
      user: {
        email: result.user.email!,
        emailVerified: result.user.emailVerified,
      },
    };
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }
}
