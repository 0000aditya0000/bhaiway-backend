import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { normalizeEmail } from '../email-verification/email-otp.util';
import { EmailOtpPurpose } from '../email-verification/enums/email-otp-purpose.enum';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import { User } from '../users/entities/user.entity';
import { CorporateEmailDomainPolicy } from './corporate-email-domain.policy';
import { CorporateEmailNotAllowedError } from './corporate-identity.errors';
import { CorporateIdentityVerification } from './entities/corporate-identity-verification.entity';
import { CorporateIdentityStatus } from './enums/corporate-identity-status.enum';
import {
  buildCorporateIdentityVerificationHtml,
  buildCorporateIdentityVerificationText,
  CORPORATE_IDENTITY_VERIFICATION_SUBJECT,
} from './templates/corporate-identity-verification.template';

export interface CorporateIdentityStatusView {
  status: CorporateIdentityStatus;
  email: string | null;
  verifiedAt: string | null;
}

@Injectable()
export class CorporateIdentityService {
  private readonly logger = new Logger(CorporateIdentityService.name);
  private readonly domainPolicy = new CorporateEmailDomainPolicy();

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(CorporateIdentityVerification)
    private readonly corporateRepository: Repository<CorporateIdentityVerification>,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly dataSource: DataSource,
  ) {}

  async send(userId: string, rawEmail: string): Promise<CorporateIdentityStatusView & { message?: string }> {
    await this.requireUser(userId);
    const email = normalizeEmail(rawEmail);
    this.assertCorporateEmailAllowed(email);

    const existing = await this.getOrCreateRecord(userId);

    if (
      existing.status === CorporateIdentityStatus.VERIFIED &&
      existing.corporateEmail === email &&
      !existing.pendingCorporateEmail
    ) {
      this.logger.log(
        `Corporate identity already verified for user=${userId}`,
      );
      return this.toVerifiedView(existing);
    }

    await this.emailVerificationService.sendOtpForPurpose({
      userId,
      email,
      purpose: EmailOtpPurpose.CORPORATE_IDENTITY,
      subject: CORPORATE_IDENTITY_VERIFICATION_SUBJECT,
      buildHtml: buildCorporateIdentityVerificationHtml,
      buildText: buildCorporateIdentityVerificationText,
      rateLimitByPurposeOnly: true,
      invalidateAllForPurpose: true,
    });

    existing.pendingCorporateEmail = email;
    // Keep verified corporateEmail/verifiedAt while a change is pending.
    // Workflow status becomes OTP_PENDING so clients know an OTP is out.
    if (existing.status !== CorporateIdentityStatus.VERIFIED) {
      existing.status = CorporateIdentityStatus.OTP_PENDING;
      existing.corporateEmail = null;
      existing.verifiedAt = null;
    } else {
      existing.status = CorporateIdentityStatus.OTP_PENDING;
    }
    await this.corporateRepository.save(existing);

    this.logger.log(`Corporate identity OTP requested for user=${userId}`);

    return {
      status: CorporateIdentityStatus.OTP_PENDING,
      email,
      verifiedAt: null,
      message: 'Corporate identity verification code sent.',
    };
  }

  async verify(
    userId: string,
    rawEmail: string,
    rawOtp: string,
  ): Promise<CorporateIdentityStatusView> {
    await this.requireUser(userId);
    const email = normalizeEmail(rawEmail);
    this.assertCorporateEmailAllowed(email);

    const result = await this.dataSource.transaction(async (manager) => {
      const otpOutcome =
        await this.emailVerificationService.evaluateOtpInTransaction(manager, {
          userId,
          email,
          otp: rawOtp,
          purpose: EmailOtpPurpose.CORPORATE_IDENTITY,
        });

      if (otpOutcome !== 'OK') {
        return { kind: 'otp' as const, otpOutcome };
      }

      const repo = manager.getRepository(CorporateIdentityVerification);
      let record = await repo.findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!record) {
        record = repo.create({
          userId,
          corporateEmail: null,
          pendingCorporateEmail: null,
          status: CorporateIdentityStatus.NOT_VERIFIED,
          verifiedAt: null,
        });
      }

      const now = new Date();
      record.corporateEmail = email;
      record.pendingCorporateEmail = null;
      record.status = CorporateIdentityStatus.VERIFIED;
      record.verifiedAt = now;
      await repo.save(record);
      return { kind: 'verified' as const, verifiedAt: now };
    });

    if (result.kind !== 'verified') {
      this.logger.log(
        `Corporate identity verification failed for user=${userId}`,
      );
      this.emailVerificationService.throwForOtpOutcome(result.otpOutcome);
      // throwForOtpOutcome always throws; keep TypeScript control-flow happy.
      throw new Error('unreachable');
    }

    this.logger.log(
      `Corporate identity verification succeeded for user=${userId}`,
    );

    return {
      status: CorporateIdentityStatus.VERIFIED,
      email,
      verifiedAt: result.verifiedAt.toISOString(),
    };
  }

  async getStatus(userId: string): Promise<CorporateIdentityStatusView> {
    await this.requireUser(userId);
    const record = await this.corporateRepository.findOne({
      where: { userId },
    });

    if (!record) {
      return {
        status: CorporateIdentityStatus.NOT_VERIFIED,
        email: null,
        verifiedAt: null,
      };
    }

    if (record.pendingCorporateEmail) {
      return {
        status: CorporateIdentityStatus.OTP_PENDING,
        email: record.pendingCorporateEmail,
        verifiedAt: null,
      };
    }

    if (
      record.status === CorporateIdentityStatus.VERIFIED &&
      record.corporateEmail
    ) {
      return this.toVerifiedView(record);
    }

    return {
      status: CorporateIdentityStatus.NOT_VERIFIED,
      email: null,
      verifiedAt: null,
    };
  }

  /**
   * Authoritative verified corporate email for business rules.
   * Remains the previous email while a change OTP is pending.
   */
  async getVerifiedCorporateEmail(userId: string): Promise<string | null> {
    const record = await this.corporateRepository.findOne({
      where: { userId },
    });
    if (!record?.corporateEmail) {
      return null;
    }
    // During change: status may be OTP_PENDING but corporateEmail still holds A.
    return record.corporateEmail;
  }

  private assertCorporateEmailAllowed(email: string): void {
    if (!this.domainPolicy.isAllowedCorporateEmail(email)) {
      throw new CorporateEmailNotAllowedError();
    }
  }

  private async getOrCreateRecord(
    userId: string,
  ): Promise<CorporateIdentityVerification> {
    const existing = await this.corporateRepository.findOne({
      where: { userId },
    });
    if (existing) {
      return existing;
    }

    try {
      const created = this.corporateRepository.create({
        userId,
        corporateEmail: null,
        pendingCorporateEmail: null,
        status: CorporateIdentityStatus.NOT_VERIFIED,
        verifiedAt: null,
      });
      return await this.corporateRepository.save(created);
    } catch {
      const raced = await this.corporateRepository.findOne({
        where: { userId },
      });
      if (raced) {
        return raced;
      }
      throw new NotFoundException('Corporate identity record not found');
    }
  }

  private toVerifiedView(
    record: CorporateIdentityVerification,
  ): CorporateIdentityStatusView {
    return {
      status: CorporateIdentityStatus.VERIFIED,
      email: record.corporateEmail,
      verifiedAt: record.verifiedAt
        ? record.verifiedAt.toISOString()
        : null,
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
