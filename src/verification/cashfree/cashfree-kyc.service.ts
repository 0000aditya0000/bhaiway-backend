import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';

import { UserProfile } from '../../users/entities/user-profile.entity';
import { User } from '../../users/entities/user.entity';
import { mapVerifiedGenderToEnum } from '../../users/gender-from-verification.mapper';
import { UserVerification } from '../entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../enums/verification.enums';
import {
  IdentityMobileStatus,
  IdentityVerificationStatus,
} from '../enums/identity-verification.enums';
import { CashfreeWebhookEvent } from '../entities/cashfree-webhook-event.entity';
import { UserIdentityVerification } from '../entities/user-identity-verification.entity';
import {
  CashfreeAadhaarDocumentResponse,
  CashfreeDigiLockerService,
  CashfreeGetStatusResponse,
} from './cashfree-digilocker.service';
import {
  CashfreeWebhookSignatureError,
  KycAlreadyVerifiedError,
  KycVerificationNotFoundError,
} from './cashfree.errors';
import {
  CashfreeKycStatusResponseDto,
  CashfreeStartVerificationResponseDto,
} from './dto/cashfree-kyc-response.dto';

const ACTIVE_STATUSES = [
  IdentityVerificationStatus.INITIATED,
  IdentityVerificationStatus.PENDING,
  IdentityVerificationStatus.AUTHENTICATED,
  IdentityVerificationStatus.DOCUMENT_FETCHING,
];

@Injectable()
export class CashfreeKycService {
  private readonly logger = new Logger(CashfreeKycService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly cashfreeService: CashfreeDigiLockerService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
    @InjectRepository(UserVerification)
    private readonly userVerificationRepository: Repository<UserVerification>,
    @InjectRepository(UserIdentityVerification)
    private readonly identityVerificationRepository: Repository<UserIdentityVerification>,
    @InjectRepository(CashfreeWebhookEvent)
    private readonly webhookEventRepository: Repository<CashfreeWebhookEvent>,
  ) {}

  /**
   * Start or reuse DigiLocker verification session.
   * Prevents duplicate active sessions.
   * Rejects already verified users with 409 Conflict.
   */
  async startVerification(
    userId: string,
  ): Promise<CashfreeStartVerificationResponseDto> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // 1. Check if user is already verified
    const isVerified = await this.isUserIdentityVerified(userId);
    if (isVerified) {
      throw new KycAlreadyVerifiedError('User identity is already verified');
    }

    // 2. Check for active non-terminal verification within validity window
    const active = await this.identityVerificationRepository.findOne({
      where: ACTIVE_STATUSES.map((status) => ({
        userId,
        status,
      })),
      order: { createdAt: 'DESC' },
    });

    const now = new Date();
    if (
      active &&
      active.verificationUrl &&
      active.urlExpiresAt &&
      active.urlExpiresAt.getTime() > now.getTime()
    ) {
      return {
        verificationId: active.verificationId,
        referenceId: active.referenceId,
        status: active.status,
        url: active.verificationUrl,
        expiresAt: active.urlExpiresAt.toISOString(),
      };
    }

    // 3. Generate unique verificationId and create session on Cashfree
    const verificationId = `bw_aadhaar_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    const cfSession = await this.cashfreeService.createVerificationUrl({
      verificationId,
    });

    const urlExpiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

    const record = this.identityVerificationRepository.create({
      userId,
      provider: 'CASHFREE',
      verificationType: 'AADHAAR',
      verificationId: cfSession.verificationId,
      referenceId: cfSession.referenceId || null,
      status: IdentityVerificationStatus.PENDING,
      documentType: 'AADHAAR',
      verificationUrl: cfSession.url,
      redirectUrl: cfSession.redirectUrl ?? null,
      urlExpiresAt,
      rawStatus: cfSession.status,
    });

    const saved = await this.identityVerificationRepository.save(record);

    return {
      verificationId: saved.verificationId,
      referenceId: saved.referenceId,
      status: saved.status,
      url: saved.verificationUrl!,
      expiresAt: saved.urlExpiresAt?.toISOString() ?? null,
    };
  }

  /**
   * Return mobile-friendly latest verification status for the authenticated user.
   */
  async getVerificationStatus(
    userId: string,
  ): Promise<CashfreeKycStatusResponseDto> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const latest = await this.identityVerificationRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    if (!latest) {
      // Check if generic UserVerification has IDENTITY verified
      const generic = await this.userVerificationRepository.findOne({
        where: {
          userId,
          verificationType: VerificationType.IDENTITY,
          isCurrent: true,
          status: VerificationStatus.VERIFIED,
        },
      });

      if (generic) {
        const profile = await this.userProfileRepository.findOne({
          where: { userId },
        });
        return {
          status: IdentityMobileStatus.VERIFIED,
          verificationId: generic.documentReference,
          verifiedName: profile?.displayName ?? profile?.firstName ?? null,
          verifiedGender: profile?.gender ?? null,
          verifiedAt: generic.verifiedAt?.toISOString() ?? null,
        };
      }

      return {
        status: IdentityMobileStatus.NOT_VERIFIED,
        verificationId: null,
        verifiedName: null,
        verifiedGender: null,
        verifiedAt: null,
      };
    }

    return this.toMobileStatusDto(latest);
  }

  /**
   * Refresh verification status from Cashfree and finalize document verification if ready.
   */
  async refreshVerification(
    userId: string,
  ): Promise<CashfreeKycStatusResponseDto> {
    const latest = await this.identityVerificationRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    if (!latest) {
      throw new KycVerificationNotFoundError('No verification session found for user');
    }

    // If already verified, return idempotent view
    if (latest.status === IdentityVerificationStatus.VERIFIED) {
      return this.toMobileStatusDto(latest);
    }

    // If already in terminal failed state, return
    if (
      latest.status === IdentityVerificationStatus.FAILED ||
      latest.status === IdentityVerificationStatus.EXPIRED ||
      latest.status === IdentityVerificationStatus.CONSENT_DENIED ||
      latest.status === IdentityVerificationStatus.CONSENT_EXPIRED
    ) {
      return this.toMobileStatusDto(latest);
    }

    // Call Cashfree Get Verification Status
    const cfStatus = await this.cashfreeService.getVerificationStatus({
      referenceId: latest.referenceId,
      verificationId: latest.verificationId,
    });

    const normalizedStatus = cfStatus.status?.toUpperCase();

    if (normalizedStatus === 'AUTHENTICATED') {
      // Retrieve Aadhaar document
      const doc = await this.cashfreeService.getAadhaarDocument({
        referenceId: latest.referenceId,
        verificationId: latest.verificationId,
      });

      const verifiedRecord = await this.completeAadhaarVerification(
        latest.id,
        cfStatus,
        doc,
      );
      return this.toMobileStatusDto(verifiedRecord);
    }

    if (normalizedStatus === 'EXPIRED') {
      latest.status = IdentityVerificationStatus.EXPIRED;
      latest.rawStatus = cfStatus.status;
      await this.identityVerificationRepository.save(latest);
      return this.toMobileStatusDto(latest);
    }

    if (normalizedStatus === 'CONSENT_DENIED') {
      latest.status = IdentityVerificationStatus.CONSENT_DENIED;
      latest.rawStatus = cfStatus.status;
      latest.failureReason = 'User denied DigiLocker consent';
      await this.identityVerificationRepository.save(latest);
      return this.toMobileStatusDto(latest);
    }

    if (normalizedStatus === 'FAILED') {
      latest.status = IdentityVerificationStatus.FAILED;
      latest.rawStatus = cfStatus.status;
      latest.failureReason = 'Verification failed at provider';
      await this.identityVerificationRepository.save(latest);
      return this.toMobileStatusDto(latest);
    }

    // Status remains pending or in progress
    latest.rawStatus = cfStatus.status;
    if (cfStatus.documentConsent !== undefined) {
      latest.documentConsent = cfStatus.documentConsent;
    }
    await this.identityVerificationRepository.save(latest);

    return this.toMobileStatusDto(latest);
  }

  /**
   * Process Cashfree DigiLocker Webhook event.
   * Public route — authenticates HMAC signature and validates replay timestamp.
   */
  async processWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: boolean; status?: string }> {
    const signature =
      this.getHeaderString(headers, 'x-webhook-signature') ||
      this.getHeaderString(headers, 'x-cf-signature') ||
      this.getHeaderString(headers, 'x-cashfree-signature') ||
      this.getHeaderString(headers, 'signature');

    const timestamp =
      this.getHeaderString(headers, 'x-webhook-timestamp') ||
      this.getHeaderString(headers, 'x-cf-timestamp') ||
      this.getHeaderString(headers, 'x-cashfree-timestamp') ||
      this.getHeaderString(headers, 'timestamp');

    // Special Handling: Cashfree Dashboard "Test & Add Webhook" validation probe
    // Cashfree dashboard triggers an unsigned test event (e.g. LOW_BALANCE_ALERT / TEST) to verify endpoint reachability.
    // We strictly acknowledge only this narrow pattern without modifying any state or verification records.
    if (!signature || !timestamp) {
      if (this.isCashfreeTestWebhook(rawBody)) {
        this.logger.log(
          'Cashfree dashboard validation test probe detected (LOW_BALANCE_ALERT / TEST). Acknowledged with HTTP 200.',
        );
        return { received: true, status: 'TEST_WEBHOOK_ACKNOWLEDGED' };
      }

      const headerKeys = Object.keys(headers || {});
      this.logger.warn(
        `Missing Cashfree webhook signature or timestamp headers on production event. Present headers: [${headerKeys.join(', ')}]`,
      );
      throw new CashfreeWebhookSignatureError('Missing webhook signature or timestamp headers');
    }

    // 1. Validate replay window (5 minutes)
    this.cashfreeService.validateWebhookTimestamp(timestamp);

    // 2. Verify HMAC-SHA256 signature
    const isValid = this.cashfreeService.verifyWebhookSignature(
      rawBody,
      signature,
      timestamp,
    );

    if (!isValid) {
      throw new CashfreeWebhookSignatureError();
    }

    // 3. Webhook Deduplication via payloadHash
    const payloadHash = crypto
      .createHash('sha256')
      .update(rawBody)
      .digest('hex');

    const existingEvent = await this.webhookEventRepository.findOne({
      where: { provider: 'CASHFREE', payloadHash },
    });

    if (existingEvent?.processed) {
      return { received: true, status: 'ALREADY_PROCESSED' };
    }

    let parsedPayload: Record<string, any>;
    try {
      parsedPayload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed webhook JSON payload');
    }

    const eventType = String(
      parsedPayload.type ?? parsedPayload.event ?? parsedPayload.event_type ?? '',
    );
    const data = parsedPayload.data ?? parsedPayload;
    const verificationId = data.verification_id ? String(data.verification_id) : null;
    const referenceId = data.reference_id ? String(data.reference_id) : null;

    // Record webhook event in DB
    let webhookEvent = existingEvent;
    if (!webhookEvent) {
      try {
        webhookEvent = await this.webhookEventRepository.save(
          this.webhookEventRepository.create({
            provider: 'CASHFREE',
            eventType: eventType || 'UNKNOWN',
            verificationId,
            referenceId,
            eventTime: timestamp ? new Date(Number(timestamp) || Date.parse(timestamp) || Date.now()) : new Date(),
            payloadHash,
            processed: false,
          }),
        );
      } catch {
        // Recover concurrent insert
        webhookEvent = await this.webhookEventRepository.findOne({
          where: { provider: 'CASHFREE', payloadHash },
        });
      }
    }

    // 4. Handle event types
    try {
      await this.handleWebhookEvent(eventType, verificationId, referenceId, data);

      if (webhookEvent) {
        webhookEvent.processed = true;
        webhookEvent.processedAt = new Date();
        await this.webhookEventRepository.save(webhookEvent);
      }

      return { received: true, status: 'PROCESSED' };
    } catch (error) {
      if (webhookEvent) {
        webhookEvent.failureReason = (error as Error).message;
        await this.webhookEventRepository.save(webhookEvent);
      }
      throw error;
    }
  }

  private async handleWebhookEvent(
    eventType: string,
    verificationId: string | null,
    referenceId: string | null,
    data: Record<string, any>,
  ): Promise<void> {
    const record = await this.findVerificationByIdentifiers(
      verificationId,
      referenceId,
    );

    if (!record) {
      this.logger.warn(
        `Webhook received for unknown verification: verificationId=${verificationId} referenceId=${referenceId}`,
      );
      return;
    }

    switch (eventType) {
      case 'DIGILOCKER_VERIFICATION_SUCCESS': {
        if (record.status === IdentityVerificationStatus.VERIFIED) {
          return;
        }

        // Fetch document from Cashfree
        const doc = await this.cashfreeService.getAadhaarDocument({
          referenceId: record.referenceId,
          verificationId: record.verificationId,
        });

        const statusData: CashfreeGetStatusResponse = {
          status: 'AUTHENTICATED',
          referenceId: record.referenceId ?? undefined,
          verificationId: record.verificationId,
        };

        await this.completeAadhaarVerification(record.id, statusData, doc);
        break;
      }

      case 'DIGILOCKER_VERIFICATION_LINK_EXPIRED': {
        if (record.status !== IdentityVerificationStatus.VERIFIED) {
          record.status = IdentityVerificationStatus.EXPIRED;
          record.failureReason = 'DigiLocker link expired';
          await this.identityVerificationRepository.save(record);
        }
        break;
      }

      case 'DIGILOCKER_VERIFICATION_CONSENT_DENIED': {
        if (record.status !== IdentityVerificationStatus.VERIFIED) {
          record.status = IdentityVerificationStatus.CONSENT_DENIED;
          record.failureReason = 'DigiLocker consent denied by user';
          await this.identityVerificationRepository.save(record);
        }
        break;
      }

      case 'DIGILOCKER_VERIFICATION_CONSENT_EXPIRED': {
        if (record.status !== IdentityVerificationStatus.VERIFIED) {
          record.status = IdentityVerificationStatus.CONSENT_EXPIRED;
          record.failureReason = 'DigiLocker consent expired';
          await this.identityVerificationRepository.save(record);
        }
        break;
      }

      case 'DIGILOCKER_VERIFICATION_FAILURE': {
        if (record.status !== IdentityVerificationStatus.VERIFIED) {
          record.status = IdentityVerificationStatus.FAILED;
          record.failureReason = data.reason ? String(data.reason) : 'DigiLocker verification failed';
          await this.identityVerificationRepository.save(record);
        }
        break;
      }

      default:
        this.logger.log(`Unhandled Cashfree DigiLocker webhook event: ${eventType}`);
    }
  }

  /**
   * Complete Aadhaar verification in a single atomic database transaction with pessimistic locking.
   * Updates:
   * 1. UserIdentityVerification -> VERIFIED
   * 2. UserProfile -> firstName, lastName, displayName, gender
   * 3. UserVerification (IDENTITY) -> VERIFIED
   */
  async completeAadhaarVerification(
    verificationDbId: string,
    statusData: CashfreeGetStatusResponse,
    documentData: CashfreeAadhaarDocumentResponse,
  ): Promise<UserIdentityVerification> {
    return this.dataSource.transaction(async (manager) => {
      const identityRepo = manager.getRepository(UserIdentityVerification);
      const profileRepo = manager.getRepository(UserProfile);
      const genericVerifRepo = manager.getRepository(UserVerification);

      // Pessimistic write lock on the identity verification record
      const record = await identityRepo.findOne({
        where: { id: verificationDbId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!record) {
        throw new NotFoundException('Verification record not found');
      }

      // Idempotency: if already verified, return immediately
      if (record.status === IdentityVerificationStatus.VERIFIED) {
        return record;
      }

      const verifiedName = documentData.name?.trim() ?? null;
      const rawGender = documentData.gender?.trim() ?? null;
      const mappedGender = mapVerifiedGenderToEnum(rawGender);

      // Extract Aadhaar masked and last 4 digits safely
      let maskedAadhaar: string | null = null;
      let aadhaarLast4: string | null = null;
      if (documentData.uid) {
        const digits = documentData.uid.replace(/\D/g, '');
        if (digits.length >= 4) {
          aadhaarLast4 = digits.slice(-4);
          maskedAadhaar = `XXXXXXXX${aadhaarLast4}`;
        }
      }

      const now = new Date();

      // 1. Update UserIdentityVerification
      record.status = IdentityVerificationStatus.VERIFIED;
      record.verifiedName = verifiedName ?? record.verifiedName;
      record.verifiedGender = rawGender ?? record.verifiedGender;
      record.verifiedDob = documentData.dob ?? record.verifiedDob;
      record.maskedAadhaar = maskedAadhaar ?? record.maskedAadhaar;
      record.aadhaarLast4 = aadhaarLast4 ?? record.aadhaarLast4;
      record.verifiedMobile = documentData.mobile ?? record.verifiedMobile;
      record.documentStatus = documentData.status ?? 'VALID';
      record.verifiedAt = now;
      record.failureReason = null;
      record.rawStatus = statusData.status;

      const savedIdentity = await identityRepo.save(record);

      // 2. Update UserProfile (name, gender)
      let profile = await profileRepo.findOne({
        where: { userId: record.userId },
      });

      if (verifiedName) {
        const parts = verifiedName.split(/\s+/);
        const firstName = parts[0];
        const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;

        if (!profile) {
          profile = profileRepo.create({
            userId: record.userId,
            firstName,
            lastName,
            displayName: verifiedName,
            gender: mappedGender,
            dateOfBirth: documentData.dob ?? null,
            profilePhoto: null,
          });
        } else {
          profile.firstName = firstName;
          profile.lastName = lastName;
          profile.displayName = verifiedName;
          if (mappedGender) {
            profile.gender = mappedGender;
          }
        }
      } else if (profile && mappedGender) {
        profile.gender = mappedGender;
      }

      if (profile) {
        await profileRepo.save(profile);
      }

      // 3. Synchronize with generic UserVerification for IDENTITY
      let genericVerif = await genericVerifRepo.findOne({
        where: {
          userId: record.userId,
          verificationType: VerificationType.IDENTITY,
          isCurrent: true,
        },
      });

      if (!genericVerif) {
        genericVerif = genericVerifRepo.create({
          userId: record.userId,
          verificationType: VerificationType.IDENTITY,
          status: VerificationStatus.VERIFIED,
          provider: 'CASHFREE',
          providerReference: record.referenceId,
          documentType: 'AADHAAR',
          documentReference: record.verificationId,
          isCurrent: true,
          submittedAt: record.createdAt,
          verifiedAt: now,
        });
      } else {
        genericVerif.status = VerificationStatus.VERIFIED;
        genericVerif.provider = 'CASHFREE';
        genericVerif.providerReference = record.referenceId;
        genericVerif.verifiedAt = now;
        genericVerif.rejectedAt = null;
        genericVerif.rejectionReason = null;
      }

      await genericVerifRepo.save(genericVerif);

      return savedIdentity;
    });
  }

  private async isUserIdentityVerified(userId: string): Promise<boolean> {
    const verified = await this.identityVerificationRepository.findOne({
      where: {
        userId,
        status: IdentityVerificationStatus.VERIFIED,
      },
    });
    if (verified) return true;

    const generic = await this.userVerificationRepository.findOne({
      where: {
        userId,
        verificationType: VerificationType.IDENTITY,
        isCurrent: true,
        status: VerificationStatus.VERIFIED,
      },
    });
    return Boolean(generic);
  }

  private async findVerificationByIdentifiers(
    verificationId: string | null,
    referenceId: string | null,
  ): Promise<UserIdentityVerification | null> {
    if (verificationId) {
      const byVid = await this.identityVerificationRepository.findOne({
        where: { verificationId },
      });
      if (byVid) return byVid;
    }

    if (referenceId) {
      const byRef = await this.identityVerificationRepository.findOne({
        where: { referenceId },
      });
      if (byRef) return byRef;
    }

    return null;
  }

  private toMobileStatusDto(
    record: UserIdentityVerification,
  ): CashfreeKycStatusResponseDto {
    let mobileStatus: IdentityMobileStatus;

    if (record.status === IdentityVerificationStatus.VERIFIED) {
      mobileStatus = IdentityMobileStatus.VERIFIED;
    } else if (
      record.status === IdentityVerificationStatus.FAILED ||
      record.status === IdentityVerificationStatus.EXPIRED ||
      record.status === IdentityVerificationStatus.CONSENT_DENIED ||
      record.status === IdentityVerificationStatus.CONSENT_EXPIRED
    ) {
      mobileStatus = IdentityMobileStatus.VERIFICATION_FAILED;
    } else if (
      record.status === IdentityVerificationStatus.INITIATED ||
      record.status === IdentityVerificationStatus.PENDING ||
      record.status === IdentityVerificationStatus.AUTHENTICATED ||
      record.status === IdentityVerificationStatus.DOCUMENT_FETCHING
    ) {
      mobileStatus = IdentityMobileStatus.VERIFICATION_IN_PROGRESS;
    } else {
      mobileStatus = IdentityMobileStatus.NOT_VERIFIED;
    }

    return {
      status: mobileStatus,
      verificationId: record.verificationId,
      verifiedName: record.verifiedName,
      verifiedGender: mapVerifiedGenderToEnum(record.verifiedGender),
      verifiedAt: record.verifiedAt?.toISOString() ?? null,
    };
  }

  /**
   * Handle Cashfree DigiLocker browser redirect callback.
   * Public endpoint called when Cashfree redirects the user's browser/webview.
   *
   * Idempotent, safe, never trusts redirect parameters to verify user.
   * Authoritative verification remains webhook + backend status/document API.
   */
  async handleRedirectCallback(
    query: Record<string, string | undefined>,
  ): Promise<{ statusCode: number; html: string }> {
    const verificationId = (
      query.verification_id ||
      query.verificationId
    )?.trim();
    const referenceId = (
      query.reference_id ||
      query.referenceId
    )?.trim();

    this.logger.log(
      `DigiLocker browser redirect callback received. verificationId=${verificationId ?? 'MISSING'} referenceId=${referenceId ?? 'NONE'}`,
    );

    // 1. Missing verification_id -> 400 Bad Request HTML
    if (!verificationId) {
      return {
        statusCode: 400,
        html: this.renderCallbackHtml({
          title: 'Verification Error - BhaiWay',
          heading: 'Invalid Verification Request',
          message: 'Verification identifier is missing. Please return to the BhaiWay app and try again.',
          badgeText: 'Action Required',
          isSuccess: false,
        }),
      };
    }

    // 2. Locate UserIdentityVerification record
    const record = await this.identityVerificationRepository.findOne({
      where: { verificationId },
    });

    if (!record) {
      return {
        statusCode: 404,
        html: this.renderCallbackHtml({
          title: 'Verification Not Found - BhaiWay',
          heading: 'Verification Record Not Found',
          message: 'No matching verification record was found. Please return to the BhaiWay app and initiate verification again.',
          badgeText: 'Not Found',
          isSuccess: false,
        }),
      };
    }

    // 3. Persist reference_id if provided and not yet stored
    if (referenceId && !record.referenceId) {
      record.referenceId = referenceId;
      await this.identityVerificationRepository.save(record);
    }

    // 4. Safe idempotent HTML response (never marks VERIFIED from redirect)
    const isAlreadyVerified =
      record.status === IdentityVerificationStatus.VERIFIED;

    return {
      statusCode: 200,
      html: this.renderCallbackHtml({
        title: 'Aadhaar Verification - BhaiWay',
        heading: 'Aadhaar verification completed.',
        message: 'You can return to the BhaiWay app.',
        subMessage: isAlreadyVerified
          ? 'Your identity has already been successfully verified.'
          : 'Your DigiLocker session has finished and your verification is being processed.',
        badgeText: isAlreadyVerified ? 'Verified' : 'Verification In Progress',
        isSuccess: true,
      }),
    };
  }

  private renderCallbackHtml(options: {
    title: string;
    heading: string;
    message: string;
    subMessage?: string;
    badgeText: string;
    isSuccess: boolean;
  }): string {
    const { title, heading, message, subMessage, badgeText, isSuccess } = options;

    const iconSvg = isSuccess
      ? `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 8.25h.01" />
        </svg>`;

    const iconClass = isSuccess ? 'icon-success' : 'icon-error';
    const badgeClass = isSuccess ? 'badge-success' : 'badge-error';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${this.escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #0b0f19;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      padding: 40px 28px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.5);
    }
    .icon-wrapper {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .icon-success {
      background: rgba(16, 185, 129, 0.15);
      color: #10b981;
    }
    .icon-error {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }
    .icon-wrapper svg {
      width: 38px;
      height: 38px;
    }
    .brand {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #64748b;
      font-weight: 600;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 12px;
      color: #ffffff;
    }
    p.main-msg {
      font-size: 16px;
      font-weight: 500;
      line-height: 1.5;
      color: #e2e8f0;
      margin-bottom: 8px;
    }
    p.sub-msg {
      font-size: 14px;
      line-height: 1.5;
      color: #94a3b8;
      margin-bottom: 24px;
    }
    .badge {
      display: inline-block;
      padding: 6px 16px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 24px;
    }
    .badge-success {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
    }
    .badge-error {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
    }
    .instructions {
      font-size: 13px;
      color: #64748b;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 20px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-wrapper ${iconClass}">
      ${iconSvg}
    </div>
    <div class="brand">BhaiWay Identity</div>
    <h1>${this.escapeHtml(heading)}</h1>
    <p class="main-msg">${this.escapeHtml(message)}</p>
    ${subMessage ? `<p class="sub-msg">${this.escapeHtml(subMessage)}</p>` : ''}
    <div class="badge ${badgeClass}">${this.escapeHtml(badgeText)}</div>
    <div class="instructions">
      You may safely close this window and switch back to the BhaiWay app.
    </div>
  </div>
</body>
</html>`;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private isCashfreeTestWebhook(rawBody: Buffer): boolean {
    if (!rawBody || rawBody.length === 0) {
      return false;
    }

    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') {
        return false;
      }

      // 1. Cashfree LOW_BALANCE_ALERT (default test event used by Cashfree dashboard for Secure ID / Payouts)
      const event = String(parsed.event || parsed.event_type || parsed.type || '').toUpperCase();
      if (event === 'LOW_BALANCE_ALERT') {
        return true;
      }

      // 2. Explicit test events
      if (
        event === 'TEST' ||
        event === 'TEST_WEBHOOK' ||
        event === 'TEST_NOTIFICATION' ||
        event.startsWith('TEST_') ||
        event.endsWith('_TEST')
      ) {
        return true;
      }

      // 3. Nested data test flag or event (e.g. { data: { test: true } } or { data: { type: 'TEST' } })
      if (parsed.data && typeof parsed.data === 'object') {
        const subEvent = String(parsed.data.type || parsed.data.event || '').toUpperCase();
        if (subEvent.includes('TEST') || parsed.data.test === true) {
          return true;
        }
      }

      // 4. AlertTime + currentBalance test payload signature pattern
      if (parsed.alertTime && parsed.currentBalance !== undefined) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private getHeaderString(
    headers: Record<string, string | string[] | undefined>,
    key: string,
  ): string | undefined {
    const val = headers[key] ?? headers[key.toLowerCase()];
    if (Array.isArray(val)) {
      return val[0]?.trim();
    }
    return val?.trim();
  }
}
