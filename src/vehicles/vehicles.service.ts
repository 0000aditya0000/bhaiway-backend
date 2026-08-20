import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import { VerificationService } from '../verification/verification.service';
import { VerificationType } from '../verification/enums/verification.enums';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
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
    private readonly verificationService: VerificationService,
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
}
