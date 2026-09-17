import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { UserProfile } from '../users/entities/user-profile.entity';
import { CashfreeVehicleRcService } from '../verification/cashfree/cashfree-vehicle-rc.service';
import {
  VehicleRcForbiddenError,
  VehicleRcInvalidError,
} from '../verification/cashfree/cashfree.errors';
import { UserIdentityVerification } from '../verification/entities/user-identity-verification.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VehicleRcVerification } from '../verification/entities/vehicle-rc-verification.entity';
import { IdentityVerificationStatus } from '../verification/enums/identity-verification.enums';
import {
  VehicleOwnerMatchStatus,
  VehicleRcVerificationStatus,
} from '../verification/enums/vehicle-rc-verification.enums';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
import { VerificationService } from '../verification/verification.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { VehicleRcResponseDto } from './dto/vehicle-rc-response.dto';
import { VerifyVehicleRcDto } from './dto/verify-vehicle-rc.dto';
import { Vehicle } from './entities/vehicle.entity';

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

  async create(userId: string, dto: CreateVehicleDto): Promise<VehicleResponse> {
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
      await this.verificationService.associateStubVehicleVerification(
        userId,
        saved.id,
      );
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
    return vehicles.map((vehicle) => this.toResponse(vehicle));
  }

  async findOne(userId: string, vehicleId: string): Promise<VehicleResponse> {
    const vehicle = await this.requireOwnedVehicle(userId, vehicleId);
    return this.toResponse(vehicle);
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

      return this.toResponse(saved);
    } catch (error) {
      this.rethrowDuplicateRegistration(error);
      throw error;
    }
  }

  async remove(userId: string, vehicleId: string): Promise<VehicleResponse> {
    const vehicle = await this.requireOwnedVehicle(userId, vehicleId);
    vehicle.isActive = false;
    await this.vehicleRepository.save(vehicle);
    await this.vehicleRepository.softDelete({ id: vehicle.id });
    return this.toResponse(vehicle);
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
      return this.toResponse(saved);
    });
  }

  normalizeRegistrationNumber(value: string): string {
    return value.trim().toUpperCase().replace(/\s+/g, '');
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

  private toResponse(vehicle: Vehicle): VehicleResponse {
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
    };
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
    // 1. Authorization: check vehicle exists and is owned by userId
    const vehicle = await this.vehicleRepository.findOne({
      where: { id: vehicleId, deletedAt: IsNull() },
    });
    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }
    if (vehicle.userId !== userId) {
      throw new VehicleRcForbiddenError(
        'You do not have permission to verify this vehicle',
      );
    }

    // 2. Determine and normalize registration number
    const targetReg = dto?.vehicleNumber || vehicle.registrationNumber;
    const normRequested = this.normalizeRegistrationNumber(targetReg);
    if (!normRequested || normRequested.length < 4) {
      throw new BadRequestException('A valid vehicle registration number is required');
    }

    // 3. Idempotency check:
    // If the vehicle is already verified with status VALID for this exact registration number,
    // return the existing verification result without calling Cashfree again.
    const existingValid = await this.vehicleRcRepository.findOne({
      where: {
        vehicleId,
        requestedVehicleNumber: normRequested,
        status: VehicleRcVerificationStatus.VALID,
      },
      order: { createdAt: 'DESC' },
    });

    if (existingValid) {
      return {
        success: true,
        verification: {
          vehicleId,
          status: 'VERIFIED',
          vehicleNumber:
            existingValid.verifiedVehicleNumber ||
            existingValid.requestedVehicleNumber,
          verifiedAt: (
            existingValid.verifiedAt ?? existingValid.createdAt
          ).toISOString(),
          verificationId: existingValid.verificationId,
          ownerMatchStatus: existingValid.ownerMatchStatus,
        },
      };
    }

    // 4. Generate unique server-side verification ID (<= 50 chars)
    const verificationId = this.generateRcVerificationId(vehicleId);

    // 5. Call Cashfree Vehicle RC API
    let cfResponse;
    try {
      cfResponse = await this.cashfreeVehicleRcService.verifyVehicleRc({
        verificationId,
        vehicleNumber: normRequested,
      });
    } catch (error) {
      // Audit log failed attempt in vehicle_rc_verifications
      try {
        const failureRecord = this.vehicleRcRepository.create({
          vehicleId,
          userId,
          provider: 'CASHFREE',
          verificationId,
          requestedVehicleNumber: normRequested,
          status: VehicleRcVerificationStatus.FAILED,
          failureCode:
            error instanceof HttpException
              ? (error.getResponse() as any)?.code || error.name
              : 'UPSTREAM_ERROR',
          failureReason: (error as Error).message,
        });
        await this.vehicleRcRepository.save(failureRecord);
      } catch {
        // preserve primary error
      }
      throw error;
    }

    // 6. Check registration number match
    const returnedRaw = cfResponse.regNo || cfResponse.vehicleNumber || '';
    const normReturned = returnedRaw
      ? this.normalizeRegistrationNumber(returnedRaw)
      : '';
    const regMatches = !normReturned || normReturned === normRequested;

    // 7. Check owner information (without modifying UserProfile)
    const ownerMatchStatus = await this.evaluateOwnerMatch(
      userId,
      cfResponse.owner,
    );

    // 8. Determine final verification status
    const isSuccessful = cfResponse.status === 'VALID' && regMatches;

    if (!isSuccessful) {
      const failureCode = !regMatches
        ? 'VEHICLE_NUMBER_MISMATCH'
        : cfResponse.failureCode || 'VEHICLE_RC_INVALID';
      const failureReason = !regMatches
        ? `Returned registration number (${normReturned}) does not match requested (${normRequested})`
        : cfResponse.failureReason || 'Vehicle RC verification failed';

      const invalidRecord = this.vehicleRcRepository.create({
        vehicleId,
        userId,
        provider: 'CASHFREE',
        verificationId,
        referenceId: cfResponse.referenceId ?? null,
        requestedVehicleNumber: normRequested,
        verifiedVehicleNumber: normReturned || null,
        status: VehicleRcVerificationStatus.INVALID,
        rcStatus: cfResponse.rcStatus ?? null,
        failureCode,
        failureReason,
        ownerMatchStatus: VehicleOwnerMatchStatus.NOT_CHECKED,
        rawResponse: cfResponse.sanitizedRawResponse ?? null,
      });
      await this.vehicleRcRepository.save(invalidRecord);

      throw new VehicleRcInvalidError(failureReason, failureCode, {
        verificationId,
        vehicleNumber: normRequested,
        failureCode,
        failureReason,
      });
    }

    // 9. Save VALID verification and update vehicle & user_verification within transaction
    return this.dataSource.transaction(async (manager) => {
      const rcRepo = manager.getRepository(VehicleRcVerification);
      const vehRepo = manager.getRepository(Vehicle);
      const userVerifRepo = manager.getRepository(UserVerification);

      const verifiedAt = new Date();
      const validRecord = rcRepo.create({
        vehicleId,
        userId,
        provider: 'CASHFREE',
        verificationId,
        referenceId: cfResponse.referenceId ?? null,
        requestedVehicleNumber: normRequested,
        verifiedVehicleNumber: normReturned || normRequested,
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
        rawResponse: cfResponse.sanitizedRawResponse ?? null,
        verifiedAt,
      });
      const savedRecord = await rcRepo.save(validRecord);

      vehicle.documentType = 'RC';
      vehicle.documentReference = verificationId;
      await vehRepo.save(vehicle);

      let currentVerif = await userVerifRepo.findOne({
        where: {
          userId,
          verificationType: VerificationType.VEHICLE,
          isCurrent: true,
        },
      });
      if (!currentVerif) {
        currentVerif = userVerifRepo.create({
          userId,
          verificationType: VerificationType.VEHICLE,
          status: VerificationStatus.VERIFIED,
          provider: 'CASHFREE',
          providerReference: verificationId,
          documentType: 'RC',
          documentReference: vehicleId,
          isCurrent: true,
          submittedAt: verifiedAt,
          verifiedAt,
        });
      } else {
        currentVerif.status = VerificationStatus.VERIFIED;
        currentVerif.provider = 'CASHFREE';
        currentVerif.providerReference = verificationId;
        currentVerif.documentType = 'RC';
        currentVerif.documentReference = vehicleId;
        currentVerif.verifiedAt = verifiedAt;
        currentVerif.rejectedAt = null;
        currentVerif.rejectionReason = null;
      }
      await userVerifRepo.save(currentVerif);

      return {
        success: true,
        verification: {
          vehicleId,
          status: 'VERIFIED',
          vehicleNumber:
            savedRecord.verifiedVehicleNumber ||
            savedRecord.requestedVehicleNumber,
          verifiedAt: verifiedAt.toISOString(),
          verificationId: savedRecord.verificationId,
          ownerMatchStatus: savedRecord.ownerMatchStatus,
        },
      };
    });
  }

  generateRcVerificationId(vehicleId: string): string {
    const cleanId = vehicleId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    const timeBase = Date.now().toString(36);
    const randPart = randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
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

    const normRcOwner = rcOwner.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    const normUser = userName.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();

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
