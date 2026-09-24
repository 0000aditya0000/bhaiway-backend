import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, MoreThan, Repository } from 'typeorm';

import { SmtpMailService } from '../email/smtp-mail.service';
import { User } from '../users/entities/user.entity';
import {
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_MAX_SENDS_PER_HOUR,
  EMAIL_OTP_RESEND_COOLDOWN_MS,
  EMAIL_OTP_SEND_WINDOW_MS,
  EMAIL_OTP_TTL_MS,
} from './email-verification.constants';
import {
  emailOtpHashesMatch,
  generateEmailOtp,
  hashEmailOtp,
  isValidEmailOtpFormat,
  normalizeEmail,
} from './email-otp.util';
import { EmailVerificationOtp } from './entities/email-verification-otp.entity';
import {
  EmailAlreadyVerifiedError,
  EmailMismatchError,
  EmailSendFailedError,
  EmailVerificationAttemptsExceededError,
  EmailVerificationCooldownError,
  EmailVerificationExpiredError,
  EmailVerificationInvalidError,
  EmailVerificationNotFoundError,
  EmailVerificationRateLimitedError,
} from './email-verification.errors';
import {
  buildEmailVerificationHtml,
  buildEmailVerificationText,
  EMAIL_VERIFICATION_SUBJECT,
} from './templates/email-verification.template';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(EmailVerificationOtp)
    private readonly otpRepository: Repository<EmailVerificationOtp>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly smtpMailService: SmtpMailService,
  ) {}

  async sendCode(userId: string, rawEmail: string) {
    const email = normalizeEmail(rawEmail);
    const user = await this.requireUser(userId);
    this.assertEmailBelongsToUser(user, email);

    if (user.emailVerified) {
      throw new EmailAlreadyVerifiedError();
    }

    await this.assertSendLimits(userId, email);

    const otp = generateEmailOtp();
    const now = new Date();
    const record = await this.dataSource.transaction(async (manager) => {
      const otpRepo = manager.getRepository(EmailVerificationOtp);
      await this.invalidateActiveOtps(otpRepo, userId, email, now);

      const created = otpRepo.create({
        userId,
        email,
        otpHash: hashEmailOtp({
          otp,
          userId,
          email,
          pepper: this.getPepper(),
        }),
        expiresAt: new Date(now.getTime() + EMAIL_OTP_TTL_MS),
        attempts: 0,
        maxAttempts: EMAIL_OTP_MAX_ATTEMPTS,
        sentAt: now,
        verifiedAt: null,
        invalidatedAt: null,
      });
      return otpRepo.save(created);
    });

    try {
      await this.smtpMailService.sendEmail({
        to: email,
        subject: EMAIL_VERIFICATION_SUBJECT,
        html: buildEmailVerificationHtml(otp),
        text: buildEmailVerificationText(otp),
      });
    } catch (error) {
      await this.otpRepository.update(
        { id: record.id },
        { invalidatedAt: new Date() },
      );
      this.logger.error(
        `Email verification send failed for user=${userId}: ${(error as Error).message}`,
      );
      throw new EmailSendFailedError();
    }

    this.logger.log(`Email verification code sent for user=${userId}`);
    return {
      success: true,
      message: 'Verification code sent to your email.',
    };
  }

  async verifyCode(userId: string, rawOtp: string) {
    const otp = rawOtp.trim();
    if (!isValidEmailOtpFormat(otp)) {
      throw new EmailVerificationInvalidError();
    }

    const user = await this.requireUser(userId);
    if (!user.email) {
      throw new EmailVerificationNotFoundError();
    }
    if (user.emailVerified) {
      throw new EmailAlreadyVerifiedError();
    }

    const email = normalizeEmail(user.email);

    await this.dataSource.transaction(async (manager) => {
      const otpRepo = manager.getRepository(EmailVerificationOtp);
      const userRepo = manager.getRepository(User);

      const record = await otpRepo.findOne({
        where: {
          userId,
          email,
          verifiedAt: IsNull(),
          invalidatedAt: IsNull(),
        },
        order: { sentAt: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });

      if (!record) {
        throw new EmailVerificationNotFoundError();
      }

      const now = new Date();
      if (record.expiresAt.getTime() <= now.getTime()) {
        record.invalidatedAt = now;
        await otpRepo.save(record);
        throw new EmailVerificationExpiredError();
      }

      if (record.attempts >= record.maxAttempts) {
        throw new EmailVerificationAttemptsExceededError();
      }

      record.attempts += 1;
      const matches = emailOtpHashesMatch(
        record.otpHash,
        otp,
        userId,
        email,
        this.getPepper(),
      );

      if (!matches) {
        await otpRepo.save(record);
        if (record.attempts >= record.maxAttempts) {
          throw new EmailVerificationAttemptsExceededError();
        }
        throw new EmailVerificationInvalidError();
      }

      record.verifiedAt = now;
      record.invalidatedAt = now;
      await otpRepo.save(record);

      const lockedUser = await userRepo.findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedUser) {
        throw new NotFoundException('User not found');
      }
      lockedUser.emailVerified = true;
      lockedUser.email = email;
      await userRepo.save(lockedUser);
    });

    return {
      success: true,
      message: 'Email verified successfully.',
    };
  }

  async getStatus(userId: string) {
    const user = await this.requireUser(userId);
    return {
      email: user.email,
      verified: user.emailVerified,
    };
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private assertEmailBelongsToUser(user: User, email: string): void {
    if (!user.email || user.email !== email) {
      throw new EmailMismatchError();
    }
  }

  private async assertSendLimits(userId: string, email: string): Promise<void> {
    const now = Date.now();
    const latest = await this.otpRepository.findOne({
      where: { userId, email },
      order: { sentAt: 'DESC' },
    });

    if (
      latest &&
      now - latest.sentAt.getTime() < EMAIL_OTP_RESEND_COOLDOWN_MS
    ) {
      throw new EmailVerificationCooldownError();
    }

    const windowStart = new Date(now - EMAIL_OTP_SEND_WINDOW_MS);
    const hourlyCount = await this.otpRepository.count({
      where: {
        userId,
        email,
        sentAt: MoreThan(windowStart),
      },
    });

    if (hourlyCount >= EMAIL_OTP_MAX_SENDS_PER_HOUR) {
      throw new EmailVerificationRateLimitedError();
    }
  }

  private async invalidateActiveOtps(
    otpRepo: Repository<EmailVerificationOtp>,
    userId: string,
    email: string,
    now: Date,
  ): Promise<void> {
    await otpRepo
      .createQueryBuilder()
      .update(EmailVerificationOtp)
      .set({ invalidatedAt: now })
      .where('user_id = :userId', { userId })
      .andWhere('email = :email', { email })
      .andWhere('verified_at IS NULL')
      .andWhere('invalidated_at IS NULL')
      .execute();
  }

  private getPepper(): string {
    return (
      this.configService.get<string>('ENCRYPTION_KEY') ||
      this.configService.get<string>('JWT_ACCESS_SECRET') ||
      ''
    );
  }
}
