import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, MoreThan, Repository } from 'typeorm';

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
import { EmailOtpPurpose } from './enums/email-otp-purpose.enum';
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

export interface SendOtpForPurposeParams {
  userId: string;
  email: string;
  purpose: EmailOtpPurpose;
  subject: string;
  buildHtml: (otp: string) => string;
  buildText: (otp: string) => string;
  /**
   * When true (corporate), cooldown/hourly limits are scoped to userId+purpose
   * so changing the target email cannot bypass abuse controls.
   * When false (personal), limits remain scoped to userId+email+purpose.
   */
  rateLimitByPurposeOnly?: boolean;
  /**
   * When true, invalidate every active OTP for this userId+purpose
   * (any email). Used so only one corporate pending target can race.
   */
  invalidateAllForPurpose?: boolean;
}

export type OtpEvaluationOutcome =
  | 'OK'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'INVALID'
  | 'ATTEMPTS_EXCEEDED';

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

    await this.sendOtpForPurpose({
      userId,
      email,
      purpose: EmailOtpPurpose.EMAIL_VERIFICATION,
      subject: EMAIL_VERIFICATION_SUBJECT,
      buildHtml: buildEmailVerificationHtml,
      buildText: buildEmailVerificationText,
      rateLimitByPurposeOnly: false,
      invalidateAllForPurpose: false,
    });

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

    // Persist attempt/expiry mutations even when verification fails: throw only
    // after the transaction commits.
    const outcome = await this.dataSource.transaction(async (manager) => {
      const otpOutcome = await this.evaluateOtp(manager, {
        userId,
        email,
        otp,
        purpose: EmailOtpPurpose.EMAIL_VERIFICATION,
      });
      if (otpOutcome !== 'OK') {
        return otpOutcome;
      }

      const userRepo = manager.getRepository(User);
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
      return 'OK' as const;
    });

    this.throwForOtpOutcome(outcome);

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

  /**
   * Shared OTP send path used by personal email verification and
   * corporate identity verification. Does not mutate users.email /
   * users.email_verified.
   */
  async sendOtpForPurpose(
    params: SendOtpForPurposeParams,
  ): Promise<{ otpRecordId: string }> {
    const email = normalizeEmail(params.email);
    await this.requireUser(params.userId);

    await this.assertSendLimits(
      params.userId,
      email,
      params.purpose,
      params.rateLimitByPurposeOnly === true,
    );

    const otp = generateEmailOtp();
    const now = new Date();
    const record = await this.dataSource.transaction(async (manager) => {
      const otpRepo = manager.getRepository(EmailVerificationOtp);

      if (params.invalidateAllForPurpose) {
        // Serialize corporate (purpose-wide) OTP creation per user so concurrent
        // sends cannot leave multiple active CORPORATE_IDENTITY OTPs.
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `email-otp:${params.purpose}:${params.userId}`,
        ]);
        await this.invalidateActiveOtpsForPurpose(
          otpRepo,
          params.userId,
          params.purpose,
          now,
        );
      } else {
        await this.invalidateActiveOtps(
          otpRepo,
          params.userId,
          email,
          params.purpose,
          now,
        );
      }

      const created = otpRepo.create({
        userId: params.userId,
        email,
        purpose: params.purpose,
        otpHash: hashEmailOtp({
          otp,
          userId: params.userId,
          email,
          purpose: params.purpose,
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
        subject: params.subject,
        html: params.buildHtml(otp),
        text: params.buildText(otp),
      });
    } catch (error) {
      await this.otpRepository.update(
        { id: record.id },
        { invalidatedAt: new Date() },
      );
      this.logger.error(
        `Email OTP send failed for user=${params.userId} purpose=${params.purpose}: ${(error as Error).message}`,
      );
      throw new EmailSendFailedError();
    }

    this.logger.log(
      `Email OTP sent for user=${params.userId} purpose=${params.purpose}`,
    );
    return { otpRecordId: record.id };
  }

  /**
   * Verifies and consumes an OTP for the given purpose without mutating
   * users.email / users.email_verified. Caller owns business-side updates.
   */
  async verifyOtpForPurpose(params: {
    userId: string;
    email: string;
    otp: string;
    purpose: EmailOtpPurpose;
  }): Promise<void> {
    const otp = params.otp.trim();
    if (!isValidEmailOtpFormat(otp)) {
      throw new EmailVerificationInvalidError();
    }

    const email = normalizeEmail(params.email);
    await this.requireUser(params.userId);

    const outcome = await this.dataSource.transaction(async (manager) =>
      this.evaluateOtp(manager, {
        userId: params.userId,
        email,
        otp,
        purpose: params.purpose,
      }),
    );
    this.throwForOtpOutcome(outcome);
  }

  /**
   * Evaluates an OTP inside an existing transaction. On success the OTP is
   * consumed. On failure, attempt/expiry mutations are written so the outer
   * transaction can commit them; the caller must map the outcome to an error
   * after commit (see CorporateIdentityService.verify).
   */
  async evaluateOtpInTransaction(
    manager: EntityManager,
    params: {
      userId: string;
      email: string;
      otp: string;
      purpose: EmailOtpPurpose;
    },
  ): Promise<OtpEvaluationOutcome> {
    const otp = params.otp.trim();
    if (!isValidEmailOtpFormat(otp)) {
      return 'INVALID';
    }
    const email = normalizeEmail(params.email);
    return this.evaluateOtp(manager, {
      userId: params.userId,
      email,
      otp,
      purpose: params.purpose,
    });
  }

  throwForOtpOutcome(outcome: OtpEvaluationOutcome): void {
    switch (outcome) {
      case 'OK':
        return;
      case 'NOT_FOUND':
        throw new EmailVerificationNotFoundError();
      case 'EXPIRED':
        throw new EmailVerificationExpiredError();
      case 'ATTEMPTS_EXCEEDED':
        throw new EmailVerificationAttemptsExceededError();
      case 'INVALID':
        throw new EmailVerificationInvalidError();
      default:
        throw new EmailVerificationInvalidError();
    }
  }

  private async evaluateOtp(
    manager: EntityManager,
    params: {
      userId: string;
      email: string;
      otp: string;
      purpose: EmailOtpPurpose;
    },
  ): Promise<OtpEvaluationOutcome> {
    const otpRepo = manager.getRepository(EmailVerificationOtp);

    const record = await otpRepo.findOne({
      where: {
        userId: params.userId,
        email: params.email,
        purpose: params.purpose,
        verifiedAt: IsNull(),
        invalidatedAt: IsNull(),
      },
      order: { sentAt: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });

    if (!record) {
      return 'NOT_FOUND';
    }

    const now = new Date();
    if (record.expiresAt.getTime() <= now.getTime()) {
      record.invalidatedAt = now;
      await otpRepo.save(record);
      return 'EXPIRED';
    }

    if (record.attempts >= record.maxAttempts) {
      return 'ATTEMPTS_EXCEEDED';
    }

    record.attempts += 1;
    const matches = emailOtpHashesMatch(
      record.otpHash,
      params.otp,
      params.userId,
      params.email,
      params.purpose,
      this.getPepper(),
    );

    if (!matches) {
      await otpRepo.save(record);
      if (record.attempts >= record.maxAttempts) {
        return 'ATTEMPTS_EXCEEDED';
      }
      return 'INVALID';
    }

    record.verifiedAt = now;
    record.invalidatedAt = now;
    await otpRepo.save(record);
    return 'OK';
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

  private async assertSendLimits(
    userId: string,
    email: string,
    purpose: EmailOtpPurpose,
    rateLimitByPurposeOnly: boolean,
  ): Promise<void> {
    const now = Date.now();
    const latestWhere = rateLimitByPurposeOnly
      ? { userId, purpose }
      : { userId, email, purpose };

    const latest = await this.otpRepository.findOne({
      where: latestWhere,
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
      where: rateLimitByPurposeOnly
        ? {
            userId,
            purpose,
            sentAt: MoreThan(windowStart),
          }
        : {
            userId,
            email,
            purpose,
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
    purpose: EmailOtpPurpose,
    now: Date,
  ): Promise<void> {
    await otpRepo
      .createQueryBuilder()
      .update(EmailVerificationOtp)
      .set({ invalidatedAt: now })
      .where('user_id = :userId', { userId })
      .andWhere('email = :email', { email })
      .andWhere('purpose = :purpose', { purpose })
      .andWhere('verified_at IS NULL')
      .andWhere('invalidated_at IS NULL')
      .execute();
  }

  private async invalidateActiveOtpsForPurpose(
    otpRepo: Repository<EmailVerificationOtp>,
    userId: string,
    purpose: EmailOtpPurpose,
    now: Date,
  ): Promise<void> {
    await otpRepo
      .createQueryBuilder()
      .update(EmailVerificationOtp)
      .set({ invalidatedAt: now })
      .where('user_id = :userId', { userId })
      .andWhere('purpose = :purpose', { purpose })
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
