import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { UserProfile } from '../users/entities/user-profile.entity';
import { CashfreeVehicleRcService } from '../verification/cashfree/cashfree-vehicle-rc.service';
import {
  CashfreeApiError,
  CashfreeRateLimitError,
  VehicleRcInProgressError,
  VehicleRcInvalidError,
} from '../verification/cashfree/cashfree.errors';
import { UserIdentityVerification } from '../verification/entities/user-identity-verification.entity';
import { VehicleRcVerification } from '../verification/entities/vehicle-rc-verification.entity';
import { IdentityVerificationStatus } from '../verification/enums/identity-verification.enums';
import {
  PublicVehicleRcStatus,
  VehicleOwnerMatchStatus,
  VehicleRcVerificationStatus,
} from '../verification/enums/vehicle-rc-verification.enums';
import { VerificationType } from '../verification/enums/verification.enums';
import { VerificationService } from '../verification/verification.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { VehicleRcResponseDto } from './dto/vehicle-rc-response.dto';
import { VerifyVehicleRcDto } from './dto/verify-vehicle-rc.dto';
import { Vehicle } from './entities/vehicle.entity';
import {
  evaluateVehicleRcChecks,
  normalizeRegistrationNumber,
  RC_ERROR_CODES,
  RC_VERIFICATION_IN_FLIGHT_MS,
  toPublicVehicleRcStatus,
  type RcEvaluationResult,
} from './vehicle-rc-matching';

export interface VehicleResponse {
  id: string;
  vehicleType: Vehicle['vehicleType'];
  make: string;
  model: string;
  variant: string | null;
  registrationNumber: string;
  registrationYear: number | null;
  color: string | null;
  seatingCapacity: number;
  isActive: boolean;
  rcVerificationStatus: PublicVehicleRcStatus;
  lastVerifiedAt: string | null;
  insuranceValidUntil: string | null;
}

const MATERIAL_IDENTITY_FIELDS = [
  'vehicleType',
  'make',
  'model',
  'variant',
  'registrationNumber',
  'registrationYear',
] as const;

@Injectable()
export class VehiclesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(VehicleRcVerification)
    private readonly vehicleRcRepository: Repository<VehicleRcVerification>,
    @InjectRepository(UserIdentityVerification)
    private readonly userIdentityRepository: Repository<UserIdentityVerification>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
    private readonly verificationService: VerificationService,
    private readonly cashfreeVehicleRcService: CashfreeVehicleRcService,
  ) {}

  async create(
    userId: string,
    dto: CreateVehicleDto,
  ): Promise<VehicleResponse> {
    const registrationNumber = this.normalizeRegistrationNumber(
      dto.registrationNumber,
    );

    const existingActiveCount = await this.vehicleRepository.count({
      where: { userId, deletedAt: IsNull() },
    });

    try {
      const vehicle = this.vehicleRepository.create({
        userId,
        vehicleType: dto.vehicleType,
        make: dto.make.trim(),
        model: dto.model.trim(),
        variant: dto.variant?.trim() ?? null,
        registrationNumber,
        registrationYear: dto.registrationYear ?? null,
        color: dto.color?.trim() ?? null,
        seatingCapacity: dto.seatingCapacity,
        documentUrl: dto.documentUrl ?? null,
        documentType: dto.documentType ?? null,
        documentReference: dto.documentReference ?? null,
        isActive: existingActiveCount === 0,
      });

      const saved = await this.vehicleRepository.save(vehicle);
      return this.toResponse(saved);
    } catch (error) {
      this.rethrowDuplicateRegistration(error);
      throw error;
    }
  }

  async findAll(userId: string): Promise<VehicleResponse[]> {
    const vehicles = await this.vehicleRepository.find({
      where: { userId, deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    const latestByVehicle = await this.loadLatestRcByVehicleIds(
      vehicles.map((vehicle) => vehicle.id),
    );
    return vehicles.map((vehicle) =>
      this.toResponse(vehicle, latestByVehicle.get(vehicle.id)),
    );
  }

  async findOne(userId: string, vehicleId: string): Promise<VehicleResponse> {
    const vehicle = await this.requireOwnedVehicle(userId, vehicleId);
    const latest = await this.findLatestRc(vehicle.id);
    return this.toResponse(vehicle, latest);
  }

  async update(
    userId: string,
    vehicleId: string,
    dto: UpdateVehicleDto,
  ): Promise<VehicleResponse> {
    const vehicle = await this.requireOwnedVehicle(userId, vehicleId);

    const nextRegistration =
      dto.registrationNumber !== undefined
        ? this.normalizeRegistrationNumber(dto.registrationNumber)
        : vehicle.registrationNumber;

    const materialChanged = this.hasMaterialIdentityChange(vehicle, {
      ...dto,
      registrationNumber: nextRegistration,
    });

    if (dto.vehicleType !== undefined) {
      vehicle.vehicleType = dto.vehicleType;
    }
    if (dto.make !== undefined) {
      vehicle.make = dto.make.trim();
    }
    if (dto.model !== undefined) {
      vehicle.model = dto.model.trim();
    }
    if (dto.variant !== undefined) {
      vehicle.variant = dto.variant?.trim() ?? null;
    }
    if (dto.registrationNumber !== undefined) {
      vehicle.registrationNumber = nextRegistration;
    }
    if (dto.registrationYear !== undefined) {
      vehicle.registrationYear = dto.registrationYear;
    }
    if (dto.color !== undefined) {
      vehicle.color = dto.color?.trim() ?? null;
    }
    if (dto.seatingCapacity !== undefined) {
      vehicle.seatingCapacity = dto.seatingCapacity;
    }
    if (dto.documentUrl !== undefined) {
      vehicle.documentUrl = dto.documentUrl;
    }
    if (dto.documentType !== undefined) {
      vehicle.documentType = dto.documentType;
    }
    if (dto.documentReference !== undefined) {
      vehicle.documentReference = dto.documentReference;
    }

    try {
      const saved = await this.vehicleRepository.save(vehicle);

      if (materialChanged) {
        await this.verificationService.invalidateCurrentVerification(
          userId,
          VerificationType.VEHICLE,
          'Vehicle identity fields changed; resubmission required',
        );
      }

      const latest = await this.findLatestRc(saved.id);
      return this.toResponse(saved, latest);
    } catch (error) {
      this.rethrowDuplicateRegistration(error);
      throw error;
    }
  }

  async remove(userId: string, vehicleId: string): Promise<VehicleResponse> {
    const vehicle = await this.requireOwnedVehicle(userId, vehicleId);
    const latest = await this.findLatestRc(vehicle.id);
    vehicle.isActive = false;
    await this.vehicleRepository.save(vehicle);
    await this.vehicleRepository.softDelete({ id: vehicle.id });
    return this.toResponse(vehicle, latest);
  }

  async setActiveVehicle(
    userId: string,
    vehicleId: string,
  ): Promise<VehicleResponse> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Vehicle);

      const vehicle = await repo.findOne({
        where: { id: vehicleId, userId, deletedAt: IsNull() },
      });
      if (!vehicle) {
        throw new NotFoundException('Vehicle not found');
      }

      await repo.update(
        { userId, deletedAt: IsNull(), isActive: true },
        { isActive: false },
      );

      vehicle.isActive = true;
      const saved = await repo.save(vehicle);
      const latest = await manager
        .getRepository(VehicleRcVerification)
        .findOne({
          where: { vehicleId: saved.id },
          order: { createdAt: 'DESC' },
        });
      return this.toResponse(saved, latest);
    });
  }

  normalizeRegistrationNumber(value: string): string {
    return normalizeRegistrationNumber(value);
  }

  private async requireOwnedVehicle(
    userId: string,
    vehicleId: string,
  ): Promise<Vehicle> {
    const vehicle = await this.vehicleRepository.findOne({
      where: { id: vehicleId, userId, deletedAt: IsNull() },
    });
    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }
    return vehicle;
  }

  private hasMaterialIdentityChange(
    vehicle: Vehicle,
    dto: UpdateVehicleDto & { registrationNumber?: string },
  ): boolean {
    for (const field of MATERIAL_IDENTITY_FIELDS) {
      if (dto[field] === undefined) {
        continue;
      }
      const nextValue =
        field === 'make' || field === 'model' || field === 'variant'
          ? typeof dto[field] === 'string'
            ? dto[field].trim()
            : dto[field]
          : dto[field];
      if (nextValue !== vehicle[field]) {
        return true;
      }
    }
    return false;
  }

  private toResponse(
    vehicle: Vehicle,
    rc?: VehicleRcVerification | null,
  ): VehicleResponse {
    return {
      id: vehicle.id,
      vehicleType: vehicle.vehicleType,
      make: vehicle.make,
      model: vehicle.model,
      variant: vehicle.variant,
      registrationNumber: vehicle.registrationNumber,
      registrationYear: vehicle.registrationYear,
      color: vehicle.color,
      seatingCapacity: vehicle.seatingCapacity,
      isActive: vehicle.isActive,
      rcVerificationStatus: toPublicVehicleRcStatus(rc?.status),
      lastVerifiedAt: this.toLastVerifiedAt(rc),
      insuranceValidUntil: rc?.insuranceValidUntil ?? null,
    };
  }

  private toLastVerifiedAt(rc?: VehicleRcVerification | null): string | null {
    if (!rc) {
      return null;
    }
    if (rc.status === VehicleRcVerificationStatus.PENDING) {
      return null;
    }
    return (rc.verifiedAt ?? rc.createdAt).toISOString();
  }

  private async findLatestRc(
    vehicleId: string,
  ): Promise<VehicleRcVerification | null> {
    return this.vehicleRcRepository.findOne({
      where: { vehicleId },
      order: { createdAt: 'DESC' },
    });
  }

  private async loadLatestRcByVehicleIds(
    vehicleIds: string[],
  ): Promise<Map<string, VehicleRcVerification>> {
    const latest = new Map<string, VehicleRcVerification>();
    if (vehicleIds.length === 0) {
      return latest;
    }

    const records = await this.vehicleRcRepository.find({
      where: { vehicleId: In(vehicleIds) },
      order: { createdAt: 'DESC' },
    });
    for (const record of records) {
      if (!latest.has(record.vehicleId)) {
        latest.set(record.vehicleId, record);
      }
    }
    return latest;
  }

  private rethrowDuplicateRegistration(error: unknown): void {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    ) {
      throw new ConflictException(
        'A vehicle with this registration number already exists',
      );
    }
  }

  async verifyRc(
    userId: string,
    vehicleId: string,
    dto?: VerifyVehicleRcDto,
  ): Promise<VehicleRcResponseDto> {
    const attempt = await this.beginVerificationAttempt(userId, vehicleId, dto);

    if (attempt.existingValid) {
      return this.toVerifyResponse(
        attempt.vehicle,
        attempt.existingValid,
        null,
        true,
      );
    }

    const pending = attempt.pending;
    const vehicle = attempt.vehicle;
    const normRequested = vehicle.registrationNumber;
    const verificationId = pending.verificationId;

    let cfResponse;
    try {
      cfResponse = await this.cashfreeVehicleRcService.verifyVehicleRc({
        verificationId,
        vehicleNumber: normRequested,
      });
    } catch (error) {
      await this.markAttemptFailed(pending.id, vehicle.id, error);
      throw error;
    }

    const evaluation = evaluateVehicleRcChecks(vehicle, cfResponse);
    const ownerMatchStatus = await this.evaluateOwnerMatch(
      userId,
      cfResponse.owner,
    );

    if (!evaluation.passed) {
      await this.persistCompletedAttempt({
        attemptId: pending.id,
        vehicleId: vehicle.id,
        cfResponse,
        evaluation,
        ownerMatchStatus,
      });

      throw new VehicleRcInvalidError(
        evaluation.primaryMessage,
        evaluation.primaryCode,
        {
          vehicleId: vehicle.id,
          verificationStatus: evaluation.verificationStatus,
          checks: evaluation.checks,
          errors: evaluation.errors,
          verificationId,
          vehicleNumber: normRequested,
          failureCode: evaluation.primaryCode,
          failureReason: evaluation.primaryMessage,
        },
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const rcRepo = manager.getRepository(VehicleRcVerification);
      const vehRepo = manager.getRepository(Vehicle);
      const verifiedAt = new Date();
      const returnedRaw = cfResponse.regNo || cfResponse.vehicleNumber || '';
      const normReturned = returnedRaw
        ? this.normalizeRegistrationNumber(returnedRaw)
        : normRequested;

      await rcRepo.update(
        { id: pending.id, vehicleId: vehicle.id },
        {
          referenceId: cfResponse.referenceId ?? null,
          verifiedVehicleNumber: normReturned,
          status: VehicleRcVerificationStatus.VALID,
          rcStatus: cfResponse.rcStatus ?? null,
          ownerName: cfResponse.owner ?? null,
          ownerCount: cfResponse.ownerCount ?? null,
          vehicleClass: cfResponse.class ?? null,
          manufacturerName: cfResponse.vehicleManufacturerName ?? null,
          model: cfResponse.model ?? null,
          vehicleColor: cfResponse.vehicleColor ?? null,
          fuelType: cfResponse.type ?? null,
          bodyType: cfResponse.bodyType ?? null,
          vehicleCategory: cfResponse.vehicleCategory ?? null,
          chassis: cfResponse.chassis ?? null,
          engine: cfResponse.engine ?? null,
          registrationDate: cfResponse.regDate ?? null,
          manufacturingMonthYear:
            cfResponse.vehicleManufacturingMonthYear ?? null,
          rcExpiryDate: cfResponse.rcExpiryDate ?? null,
          insuranceCompany: cfResponse.vehicleInsuranceCompanyName ?? null,
          insuranceValidUntil: cfResponse.vehicleInsuranceUpto ?? null,
          financer: cfResponse.rcFinancer ?? null,
          isCommercial: cfResponse.isCommercial ?? null,
          seatCapacity: cfResponse.seatCapacity ?? null,
          puccNumber: cfResponse.puccNumber ?? null,
          puccValidUntil: cfResponse.puccUpto ?? null,
          blacklistStatus: cfResponse.blacklistStatus ?? null,
          ownerMatchStatus,
          failureCode: null,
          failureReason: null,
          rawResponse: cfResponse.sanitizedRawResponse ?? null,
          verifiedAt,
        },
      );

      vehicle.documentType = 'RC';
      vehicle.documentReference = verificationId;
      await vehRepo.save(vehicle);

      const savedRecord = await rcRepo.findOneByOrFail({ id: pending.id });
      return this.toVerifyResponse(vehicle, savedRecord, evaluation, true);
    });
  }

  private async beginVerificationAttempt(
    userId: string,
    vehicleId: string,
    dto?: VerifyVehicleRcDto,
  ): Promise<{
    vehicle: Vehicle;
    existingValid: VehicleRcVerification | null;
    pending: VehicleRcVerification;
  }> {
    return this.dataSource.transaction(async (manager) => {
      const vehRepo = manager.getRepository(Vehicle);
      const rcRepo = manager.getRepository(VehicleRcVerification);

      const vehicle = await vehRepo
        .createQueryBuilder('v')
        .setLock('pessimistic_write')
        .where('v.id = :id', { id: vehicleId })
        .andWhere('v.user_id = :userId', { userId })
        .andWhere('v.deleted_at IS NULL')
        .getOne();

      if (!vehicle) {
        throw new NotFoundException('Vehicle not found');
      }

      if (dto?.vehicleNumber) {
        const fromDto = this.normalizeRegistrationNumber(dto.vehicleNumber);
        if (fromDto !== vehicle.registrationNumber) {
          throw new BadRequestException(
            'vehicleNumber must match the saved registration number',
          );
        }
      }

      const recentPending = await rcRepo.findOne({
        where: {
          vehicleId: vehicle.id,
          status: VehicleRcVerificationStatus.PENDING,
        },
        order: { createdAt: 'DESC' },
      });
      if (
        recentPending &&
        Date.now() - recentPending.createdAt.getTime() <
          RC_VERIFICATION_IN_FLIGHT_MS
      ) {
        throw new VehicleRcInProgressError();
      }

      const existingValid = await rcRepo.findOne({
        where: {
          vehicleId: vehicle.id,
          requestedVehicleNumber: vehicle.registrationNumber,
          status: VehicleRcVerificationStatus.VALID,
        },
        order: { createdAt: 'DESC' },
      });
      if (existingValid) {
        return {
          vehicle,
          existingValid,
          pending: existingValid,
        };
      }

      const pending = rcRepo.create({
        vehicleId: vehicle.id,
        userId,
        provider: 'CASHFREE',
        verificationId: this.generateRcVerificationId(vehicle.id),
        requestedVehicleNumber: vehicle.registrationNumber,
        status: VehicleRcVerificationStatus.PENDING,
        ownerMatchStatus: VehicleOwnerMatchStatus.NOT_CHECKED,
      });
      const savedPending = await rcRepo.save(pending);
      return {
        vehicle,
        existingValid: null,
        pending: savedPending,
      };
    });
  }

  private async persistCompletedAttempt(params: {
    attemptId: string;
    vehicleId: string;
    cfResponse: Awaited<
      ReturnType<CashfreeVehicleRcService['verifyVehicleRc']>
    >;
    evaluation: RcEvaluationResult;
    ownerMatchStatus: VehicleOwnerMatchStatus;
  }): Promise<void> {
    const returnedRaw =
      params.cfResponse.regNo || params.cfResponse.vehicleNumber || '';
    const normReturned = returnedRaw
      ? this.normalizeRegistrationNumber(returnedRaw)
      : null;

    await this.vehicleRcRepository.update(
      { id: params.attemptId, vehicleId: params.vehicleId },
      {
        referenceId: params.cfResponse.referenceId ?? null,
        verifiedVehicleNumber: normReturned,
        status: params.evaluation.persistenceStatus,
        rcStatus: params.cfResponse.rcStatus ?? null,
        ownerName: params.cfResponse.owner ?? null,
        ownerCount: params.cfResponse.ownerCount ?? null,
        vehicleClass: params.cfResponse.class ?? null,
        manufacturerName: params.cfResponse.vehicleManufacturerName ?? null,
        model: params.cfResponse.model ?? null,
        vehicleColor: params.cfResponse.vehicleColor ?? null,
        fuelType: params.cfResponse.type ?? null,
        bodyType: params.cfResponse.bodyType ?? null,
        vehicleCategory: params.cfResponse.vehicleCategory ?? null,
        chassis: params.cfResponse.chassis ?? null,
        engine: params.cfResponse.engine ?? null,
        registrationDate: params.cfResponse.regDate ?? null,
        manufacturingMonthYear:
          params.cfResponse.vehicleManufacturingMonthYear ?? null,
        rcExpiryDate: params.cfResponse.rcExpiryDate ?? null,
        insuranceCompany: params.cfResponse.vehicleInsuranceCompanyName ?? null,
        insuranceValidUntil: params.cfResponse.vehicleInsuranceUpto ?? null,
        financer: params.cfResponse.rcFinancer ?? null,
        isCommercial: params.cfResponse.isCommercial ?? null,
        seatCapacity: params.cfResponse.seatCapacity ?? null,
        puccNumber: params.cfResponse.puccNumber ?? null,
        puccValidUntil: params.cfResponse.puccUpto ?? null,
        blacklistStatus: params.cfResponse.blacklistStatus ?? null,
        ownerMatchStatus: params.ownerMatchStatus,
        failureCode: params.evaluation.primaryCode,
        failureReason: params.evaluation.primaryMessage,
        rawResponse: params.cfResponse.sanitizedRawResponse ?? null,
      },
    );
  }

  private async markAttemptFailed(
    attemptId: string,
    vehicleId: string,
    error: unknown,
  ): Promise<void> {
    const providerUnavailable =
      error instanceof CashfreeApiError ||
      error instanceof CashfreeRateLimitError;
    const failureCode = providerUnavailable
      ? RC_ERROR_CODES.RC_PROVIDER_UNAVAILABLE
      : this.extractErrorCode(error);

    try {
      await this.vehicleRcRepository.update(
        { id: attemptId, vehicleId },
        {
          status: VehicleRcVerificationStatus.FAILED,
          failureCode,
          failureReason:
            error instanceof Error
              ? error.message
              : 'RC verification provider error',
        },
      );
    } catch {
      // Preserve the original provider error.
    }
  }

  private extractErrorCode(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (
        typeof response === 'object' &&
        response !== null &&
        'code' in response &&
        typeof (response as { code?: unknown }).code === 'string'
      ) {
        return (response as { code: string }).code;
      }
      return error.name;
    }
    return 'UPSTREAM_ERROR';
  }

  private toVerifyResponse(
    vehicle: Vehicle,
    record: VehicleRcVerification,
    evaluation: RcEvaluationResult | null,
    success: boolean,
  ): VehicleRcResponseDto {
    const emptyCheck = {
      status: 'NOT_AVAILABLE' as const,
      userValue: null,
      rcValue: null,
    };
    const checks = evaluation?.checks ?? {
      registrationNumber: {
        status: 'MATCHED' as const,
        userValue: vehicle.registrationNumber,
        rcValue: record.verifiedVehicleNumber,
      },
      vehicleName: emptyCheck,
      make: emptyCheck,
      model: emptyCheck,
      colour: emptyCheck,
      vehicleType: emptyCheck,
      insurance: emptyCheck,
      vehicleStatus: emptyCheck,
    };

    return {
      success,
      vehicleId: vehicle.id,
      verificationStatus: success ? 'VERIFIED' : 'FAILED',
      checks,
      errors: evaluation?.errors ?? [],
      verification: {
        vehicleId: vehicle.id,
        status: success ? 'VERIFIED' : 'FAILED',
        vehicleNumber:
          record.verifiedVehicleNumber || record.requestedVehicleNumber,
        verifiedAt: (record.verifiedAt ?? record.createdAt).toISOString(),
        verificationId: record.verificationId,
        ownerMatchStatus: record.ownerMatchStatus,
      },
    };
  }

  generateRcVerificationId(vehicleId: string): string {
    const cleanId = vehicleId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    const timeBase = Date.now().toString(36);
    const randPart = randomUUID()
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8);
    const id = `rc_${cleanId}_${timeBase}_${randPart}`;
    return id.slice(0, 50);
  }

  private async evaluateOwnerMatch(
    userId: string,
    rcOwner?: string | null,
  ): Promise<VehicleOwnerMatchStatus> {
    if (!rcOwner || !rcOwner.trim()) {
      return VehicleOwnerMatchStatus.NOT_CHECKED;
    }

    const identityVerif = await this.userIdentityRepository.findOne({
      where: { userId, status: IdentityVerificationStatus.VERIFIED },
      order: { createdAt: 'DESC' },
    });

    let userName = identityVerif?.verifiedName?.trim();

    if (!userName) {
      const profile = await this.userProfileRepository.findOne({
        where: { userId },
      });
      if (profile) {
        userName =
          [profile.firstName, profile.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() || profile.displayName?.trim();
      }
    }

    if (!userName) {
      return VehicleOwnerMatchStatus.NOT_CHECKED;
    }

    const normRcOwner = rcOwner
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .trim();
    const normUser = userName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .trim();

    if (normRcOwner === normUser) {
      return VehicleOwnerMatchStatus.MATCHED;
    }

    const userWords = normUser.split(/\s+/).filter((w) => w.length > 2);
    const ownerWords = normRcOwner.split(/\s+/).filter((w) => w.length > 2);

    const hasCommonWord = userWords.some((w) => ownerWords.includes(w));
    return hasCommonWord
      ? VehicleOwnerMatchStatus.MATCHED
      : VehicleOwnerMatchStatus.NOT_MATCHED;
  }
}
