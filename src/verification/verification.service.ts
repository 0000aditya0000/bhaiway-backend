import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import { UserProfile } from '../users/entities/user-profile.entity';
import { mapVerifiedGenderToEnum } from '../users/gender-from-verification.mapper';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { SubmitVerificationDto } from './dto/submit-verification.dto';
import { UserVerification } from './entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from './enums/verification.enums';
import { StubVerificationProvider } from './providers/stub-verification.provider';
import {
  VERIFICATION_PROVIDER,
  type VerificationProvider,
  type VerificationProviderSubmitResult,
} from './providers/verification-provider.interface';
import type {
  MyVerificationsResponse,
  RideEligibilityResult,
  TrustedVerificationDecision,
  VerificationStatusView,
} from './verification.types';

const EMPTY_STATUS_VIEW: VerificationStatusView = {
  status: VerificationStatus.PENDING,
  submittedAt: null,
  verifiedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  expiresAt: null,
};

@Injectable()
export class VerificationService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserVerification)
    private readonly verificationRepository: Repository<UserVerification>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
    @Inject(VERIFICATION_PROVIDER)
    private readonly verificationProvider: VerificationProvider,
  ) {}

  async getMyVerifications(userId: string): Promise<MyVerificationsResponse> {
    await this.requireUser(userId);

    if (this.verificationProvider instanceof StubVerificationProvider) {
      const identityVerified = await this.isCurrentlyVerified(
        userId,
        VerificationType.IDENTITY,
      );
      if (identityVerified) {
        const activeVehicle = await this.vehicleRepository.findOne({
          where: { userId, deletedAt: IsNull(), isActive: true },
        });
        await this.bootstrapStubPublisherVerifications(
          userId,
          activeVehicle?.id,
        );
      }
    }

    const current = await this.verificationRepository.find({
      where: { userId, isCurrent: true },
    });

    const byType = new Map(
      current.map((row) => [row.verificationType, row] as const),
    );

    return {
      identity: this.toStatusView(byType.get(VerificationType.IDENTITY)),
      drivingLicense: this.toStatusView(
        byType.get(VerificationType.DRIVING_LICENSE),
      ),
      vehicle: this.toStatusView(byType.get(VerificationType.VEHICLE)),
    };
  }

  async submitIdentityVerification(
    userId: string,
    dto: SubmitVerificationDto,
  ): Promise<VerificationStatusView> {
    const providerResult = await this.verificationProvider.submitIdentity({
      userId,
      verificationType: VerificationType.IDENTITY,
      documentUrl: dto.documentUrl ?? null,
      documentType: dto.documentType ?? null,
      documentReference: dto.documentReference ?? null,
    });

    const view = await this.submitVerification(
      userId,
      VerificationType.IDENTITY,
      dto,
      providerResult,
    );

    if (providerResult.provider === 'stub') {
      await this.bootstrapStubPublisherVerifications(userId);
    }

    return view;
  }

  async submitDrivingLicenseVerification(
    userId: string,
    dto: SubmitVerificationDto,
  ): Promise<VerificationStatusView> {
    const providerResult =
      await this.verificationProvider.submitDrivingLicense({
        userId,
        verificationType: VerificationType.DRIVING_LICENSE,
        documentUrl: dto.documentUrl ?? null,
        documentType: dto.documentType ?? null,
        documentReference: dto.documentReference ?? null,
      });

    return this.submitVerification(
      userId,
      VerificationType.DRIVING_LICENSE,
      dto,
      providerResult,
    );
  }

  async submitVehicleVerification(
    userId: string,
    dto: SubmitVerificationDto,
  ): Promise<VerificationStatusView> {
    const providerResult = await this.verificationProvider.submitVehicle({
      userId,
      verificationType: VerificationType.VEHICLE,
      documentUrl: dto.documentUrl ?? null,
      documentType: dto.documentType ?? null,
      documentReference: dto.documentReference ?? null,
    });

    return this.submitVerification(
      userId,
      VerificationType.VEHICLE,
      dto,
      providerResult,
    );
  }

  /**
   * Publishers require identity, driving license, and vehicle verification.
   * When vehicleId is provided, the selected vehicle must also belong to the
   * user, be active, and not be soft-deleted.
   */
  async canPublishRide(
    userId: string,
    vehicleId?: string,
  ): Promise<RideEligibilityResult> {
    await this.requireUser(userId);

    const required = [
      VerificationType.IDENTITY,
      VerificationType.DRIVING_LICENSE,
      VerificationType.VEHICLE,
    ];

    const missing: VerificationType[] = [];
    for (const type of required) {
      if (!(await this.isCurrentlyVerified(userId, type))) {
        missing.push(type);
      }
    }

    let vehicleEligible: boolean | null = null;
    if (vehicleId !== undefined) {
      const vehicle = await this.vehicleRepository.findOne({
        where: { id: vehicleId, userId, deletedAt: IsNull() },
      });
      vehicleEligible = Boolean(vehicle?.isActive);
    }

    const allowed =
      missing.length === 0 &&
      (vehicleEligible === null || vehicleEligible === true);

    return { allowed, missing, vehicleEligible };
  }

  /**
   * Bookers require identity verification only.
   */
  async canBookRide(userId: string): Promise<RideEligibilityResult> {
    await this.requireUser(userId);

    const missing: VerificationType[] = [];
    if (!(await this.isCurrentlyVerified(userId, VerificationType.IDENTITY))) {
      missing.push(VerificationType.IDENTITY);
    }

    return { allowed: missing.length === 0, missing, vehicleEligible: null };
  }

  /**
   * Invalidates the current verification record so it is no longer treated as
   * valid. Used when material vehicle identity fields change after verification.
   */
  async invalidateCurrentVerification(
    userId: string,
    verificationType: VerificationType,
    reason: string,
  ): Promise<void> {
    const current = await this.verificationRepository.findOne({
      where: { userId, verificationType, isCurrent: true },
    });

    if (!current) {
      return;
    }

    if (
      current.status === VerificationStatus.REJECTED ||
      current.status === VerificationStatus.EXPIRED
    ) {
      return;
    }

    await this.applyTrustedVerificationDecision(current.id, {
      status: VerificationStatus.REJECTED,
      rejectionReason: reason,
    });
  }

  /**
   * Trusted backend/provider/admin path only — never exposed via HTTP.
   * Tests and future webhook handlers use this to advance verification state.
   */
  async applyTrustedVerificationDecision(
    verificationId: string,
    decision: TrustedVerificationDecision,
  ): Promise<VerificationStatusView> {
    const record = await this.verificationRepository.findOne({
      where: { id: verificationId },
    });
    if (!record) {
      throw new NotFoundException('Verification record not found');
    }

    record.status = decision.status;

    if (decision.providerReference !== undefined) {
      record.providerReference = decision.providerReference;
    }

    if (decision.status === VerificationStatus.VERIFIED) {
      record.verifiedAt = new Date();
      record.rejectedAt = null;
      record.rejectionReason = null;
      record.expiresAt = decision.expiresAt ?? null;
    } else if (decision.status === VerificationStatus.REJECTED) {
      record.rejectedAt = new Date();
      record.rejectionReason = decision.rejectionReason ?? null;
      record.verifiedAt = null;
    } else if (decision.status === VerificationStatus.EXPIRED) {
      record.expiresAt = decision.expiresAt ?? new Date();
    } else if (decision.status === VerificationStatus.IN_REVIEW) {
      // keep submitted metadata; no terminal timestamps
    }

    const saved = await this.verificationRepository.save(record);
    return this.toStatusView(saved);
  }

  /**
   * Staging stub only — submits missing publisher prerequisites through the
   * normal verification flow. Real providers are unaffected.
   */
  async bootstrapStubPublisherVerifications(
    userId: string,
    vehicleId?: string,
  ): Promise<void> {
    if (!(this.verificationProvider instanceof StubVerificationProvider)) {
      return;
    }

    if (
      await this.needsStubBootstrap(userId, VerificationType.DRIVING_LICENSE)
    ) {
      await this.submitDrivingLicenseVerification(userId, {
        documentType: 'STUB_DL',
      });
    }

    if (await this.needsStubBootstrap(userId, VerificationType.VEHICLE)) {
      await this.submitVehicleVerification(userId, {
        documentType: 'STUB_RC',
        documentReference: vehicleId,
      });
    }
  }

  /**
   * Staging stub only — links an existing vehicle verification to the user's
   * vehicle without bypassing VerificationService submit rules.
   */
  async associateStubVehicleVerification(
    userId: string,
    vehicleId: string,
  ): Promise<void> {
    if (!(this.verificationProvider instanceof StubVerificationProvider)) {
      return;
    }

    const current = await this.verificationRepository.findOne({
      where: {
        userId,
        verificationType: VerificationType.VEHICLE,
        isCurrent: true,
      },
    });

    if (!current) {
      return;
    }

    if (
      current.status === VerificationStatus.VERIFIED &&
      current.documentReference !== vehicleId
    ) {
      current.documentReference = vehicleId;
      await this.verificationRepository.save(current);
    }
  }

  private async needsStubBootstrap(
    userId: string,
    verificationType: VerificationType,
  ): Promise<boolean> {
    const current = await this.verificationRepository.findOne({
      where: { userId, verificationType, isCurrent: true },
    });
    return !current;
  }

  private async submitVerification(
    userId: string,
    verificationType: VerificationType,
    dto: SubmitVerificationDto,
    providerResult: VerificationProviderSubmitResult,
  ): Promise<VerificationStatusView> {
    await this.requireUser(userId);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(UserVerification);

      const current = await repo.findOne({
        where: { userId, verificationType, isCurrent: true },
      });

      if (current && this.blocksNewSubmission(current)) {
        throw new ConflictException(
          `An active ${verificationType} verification already exists`,
        );
      }

      if (current) {
        current.isCurrent = false;
        await repo.save(current);
      }

      const now = new Date();
      const status = providerResult.status ?? VerificationStatus.PENDING;
      const verified = status === VerificationStatus.VERIFIED;
      const rejected = status === VerificationStatus.REJECTED;

      const created = repo.create({
        userId,
        verificationType,
        status,
        provider: providerResult.provider,
        providerReference: providerResult.providerReference,
        documentUrl: dto.documentUrl ?? null,
        documentType: dto.documentType ?? null,
        documentReference: dto.documentReference ?? null,
        isCurrent: true,
        submittedAt: now,
        verifiedAt: verified ? now : null,
        rejectedAt: rejected ? now : null,
        rejectionReason: null,
        expiresAt: null,
      });

      const saved = await repo.save(created);

      if (verificationType === VerificationType.IDENTITY && verified) {
        await this.applyVerifiedGenderFromProvider(
          manager.getRepository(UserProfile),
          userId,
          providerResult.verifiedGender,
        );
      }

      return this.toStatusView(saved);
    });
  }

  /**
   * Forcefully sets UserProfile.gender from Aadhaar/KYC provider result.
   * Creates a minimal profile shell if none exists yet.
   */
  private async applyVerifiedGenderFromProvider(
    profileRepo: Repository<UserProfile>,
    userId: string,
    rawGender: string | null | undefined,
  ): Promise<void> {
    const gender = mapVerifiedGenderToEnum(
      typeof rawGender === 'string' ? rawGender : rawGender ?? null,
    );
    if (!gender) {
      throw new BadRequestException(
        'Identity verification did not return a mappable verified gender',
      );
    }

    let profile = await profileRepo.findOne({ where: { userId } });
    if (!profile) {
      profile = profileRepo.create({
        userId,
        firstName: 'User',
        lastName: null,
        displayName: null,
        gender,
        dateOfBirth: null,
        profilePhoto: null,
      });
    } else {
      profile.gender = gender;
    }
    await profileRepo.save(profile);
  }

  private blocksNewSubmission(record: UserVerification): boolean {
    if (
      record.status === VerificationStatus.PENDING ||
      record.status === VerificationStatus.IN_REVIEW
    ) {
      return true;
    }

    if (record.status === VerificationStatus.VERIFIED) {
      return !this.isExpired(record);
    }

    return false;
  }

  private async isCurrentlyVerified(
    userId: string,
    verificationType: VerificationType,
  ): Promise<boolean> {
    const current = await this.verificationRepository.findOne({
      where: { userId, verificationType, isCurrent: true },
    });

    if (!current || current.status !== VerificationStatus.VERIFIED) {
      return false;
    }

    return !this.isExpired(current);
  }

  private isExpired(record: UserVerification): boolean {
    if (record.status === VerificationStatus.EXPIRED) {
      return true;
    }
    if (!record.expiresAt) {
      return false;
    }
    return record.expiresAt.getTime() <= Date.now();
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private toStatusView(
    record: UserVerification | undefined | null,
  ): VerificationStatusView {
    if (!record) {
      return { ...EMPTY_STATUS_VIEW };
    }

    const status =
      record.status === VerificationStatus.VERIFIED && this.isExpired(record)
        ? VerificationStatus.EXPIRED
        : record.status;

    return {
      status,
      submittedAt: record.submittedAt?.toISOString() ?? null,
      verifiedAt: record.verifiedAt?.toISOString() ?? null,
      rejectedAt: record.rejectedAt?.toISOString() ?? null,
      rejectionReason: record.rejectionReason,
      expiresAt: record.expiresAt?.toISOString() ?? null,
    };
  }
}
