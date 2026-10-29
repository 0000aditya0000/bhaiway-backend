import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RideType } from '../rides/enums/ride.enums';
import {
  CreateInvoiceTaxConfigDto,
  UpdateInvoiceTaxConfigDto,
  UpsertInvoiceIssuerDto,
} from './dto/invoice-admin.dto';
import { InvoiceIssuerSettings } from './entities/invoice-issuer-settings.entity';
import { InvoiceTaxConfigAudit } from './entities/invoice-tax-config-audit.entity';
import { InvoiceTaxConfig } from './entities/invoice-tax-config.entity';
import {
  InvoiceTaxConfigStatus,
} from './enums/invoice.enums';
import {
  GSTIN_PATTERN,
  INDIAN_STATE_CODE_PATTERN,
  INVOICE_ELIGIBLE_RIDE_TYPES,
  INVOICE_ISSUER_SETTINGS_ID,
} from './invoice.constants';
import { InvoiceTaxResolutionError } from './invoice-tax.math';

@Injectable()
export class InvoiceConfigService {
  constructor(
    @InjectRepository(InvoiceIssuerSettings)
    private readonly issuerRepository: Repository<InvoiceIssuerSettings>,
    @InjectRepository(InvoiceTaxConfig)
    private readonly taxConfigRepository: Repository<InvoiceTaxConfig>,
    @InjectRepository(InvoiceTaxConfigAudit)
    private readonly taxAuditRepository: Repository<InvoiceTaxConfigAudit>,
  ) {}

  async getIssuer(): Promise<InvoiceIssuerSettings | null> {
    return this.issuerRepository.findOne({
      where: { id: INVOICE_ISSUER_SETTINGS_ID },
    });
  }

  async requireIssuer(): Promise<InvoiceIssuerSettings> {
    const issuer = await this.getIssuer();
    if (!issuer) {
      throw new InvoiceTaxResolutionError(
        'Invoice issuer settings are not configured',
      );
    }
    return issuer;
  }

  async upsertIssuer(
    adminUserId: string,
    dto: UpsertInvoiceIssuerDto,
  ): Promise<InvoiceIssuerSettings> {
    this.assertIssuerDto(dto);
    const existing = await this.getIssuer();
    const row = existing ?? this.issuerRepository.create({
      id: INVOICE_ISSUER_SETTINGS_ID,
    });
    row.legalName = dto.legalName.trim();
    row.gstin = dto.gstin.trim().toUpperCase();
    row.addressLine1 = dto.addressLine1.trim();
    row.addressLine2 = dto.addressLine2?.trim() || null;
    row.city = dto.city.trim();
    row.state = dto.state.trim();
    row.stateCode = dto.stateCode.trim();
    row.pinCode = dto.pinCode.trim();
    row.contactEmail = dto.contactEmail?.trim().toLowerCase() || null;
    row.contactPhone = dto.contactPhone?.trim() || null;
    row.invoicePrefix = dto.invoicePrefix.trim().toUpperCase();
    row.footerNotes = dto.footerNotes?.trim() || null;
    row.updatedByAdminUserId = adminUserId;
    return this.issuerRepository.save(row);
  }

  async setLogoStorageKey(
    adminUserId: string,
    storageKey: string,
  ): Promise<InvoiceIssuerSettings> {
    const issuer = await this.getIssuer();
    if (!issuer) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVOICE_ISSUER_REQUIRED',
        message: 'Configure the issuing entity before uploading a logo',
      });
    }
    issuer.logoStorageKey = storageKey;
    issuer.updatedByAdminUserId = adminUserId;
    return this.issuerRepository.save(issuer);
  }

  async listTaxConfigs(): Promise<InvoiceTaxConfig[]> {
    return this.taxConfigRepository.find({
      order: { effectiveFrom: 'DESC', createdAt: 'DESC' },
    });
  }

  async createTaxConfig(
    adminUserId: string,
    dto: CreateInvoiceTaxConfigDto,
  ): Promise<InvoiceTaxConfig> {
    const rideTypes = this.normalizeRideTypes(dto.rideTypes);
    const status = dto.status ?? InvoiceTaxConfigStatus.DRAFT;
    const effectiveFrom = new Date(dto.effectiveFrom);
    const effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : null;
    this.assertWindow(effectiveFrom, effectiveTo);
    if (status === InvoiceTaxConfigStatus.ACTIVE) {
      await this.assertNoOverlap(null, rideTypes, effectiveFrom, effectiveTo);
    }

    const saved = await this.taxConfigRepository.save(
      this.taxConfigRepository.create({
        serviceCategory: dto.serviceCategory.trim(),
        rideTypes,
        sacCode: dto.sacCode.trim(),
        gstRateBasisPoints: dto.gstRateBasisPoints,
        pricingMode: dto.pricingMode,
        placeOfSupplyMode: dto.placeOfSupplyMode,
        effectiveFrom,
        effectiveTo,
        status,
        notes: dto.notes?.trim() || null,
        createdByAdminUserId: adminUserId,
        updatedByAdminUserId: adminUserId,
      }),
    );
    await this.writeTaxAudit(saved, adminUserId, 'CREATE');
    return saved;
  }

  async updateTaxConfig(
    adminUserId: string,
    id: string,
    dto: UpdateInvoiceTaxConfigDto,
  ): Promise<InvoiceTaxConfig> {
    const existing = await this.taxConfigRepository.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'INVOICE_TAX_CONFIG_NOT_FOUND',
        message: 'Tax configuration not found',
      });
    }

    if (dto.serviceCategory !== undefined) {
      existing.serviceCategory = dto.serviceCategory.trim();
    }
    if (dto.rideTypes !== undefined) {
      existing.rideTypes = this.normalizeRideTypes(dto.rideTypes);
    }
    if (dto.sacCode !== undefined) {
      existing.sacCode = dto.sacCode.trim();
    }
    if (dto.gstRateBasisPoints !== undefined) {
      existing.gstRateBasisPoints = dto.gstRateBasisPoints;
    }
    if (dto.pricingMode !== undefined) {
      existing.pricingMode = dto.pricingMode;
    }
    if (dto.placeOfSupplyMode !== undefined) {
      existing.placeOfSupplyMode = dto.placeOfSupplyMode;
    }
    if (dto.effectiveFrom !== undefined) {
      existing.effectiveFrom = new Date(dto.effectiveFrom);
    }
    if (dto.effectiveTo !== undefined) {
      existing.effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : null;
    }
    if (dto.status !== undefined) {
      existing.status = dto.status;
    }
    if (dto.notes !== undefined) {
      existing.notes = dto.notes?.trim() || null;
    }
    this.assertWindow(existing.effectiveFrom, existing.effectiveTo);
    if (existing.status === InvoiceTaxConfigStatus.ACTIVE) {
      await this.assertNoOverlap(
        existing.id,
        existing.rideTypes,
        existing.effectiveFrom,
        existing.effectiveTo,
      );
    }
    existing.updatedByAdminUserId = adminUserId;
    const saved = await this.taxConfigRepository.save(existing);
    await this.writeTaxAudit(saved, adminUserId, 'UPDATE');
    return saved;
  }

  async findActiveTaxConfig(
    rideType: RideType,
    at: Date,
  ): Promise<InvoiceTaxConfig | null> {
    const matches = await this.taxConfigRepository
      .createQueryBuilder('config')
      .where('config.status = :status', { status: InvoiceTaxConfigStatus.ACTIVE })
      .andWhere(':rideType = ANY(config.ride_types)', { rideType })
      .andWhere('config.effective_from <= :at', { at })
      .andWhere('(config.effective_to IS NULL OR config.effective_to > :at)', { at })
      .orderBy('config.effective_from', 'DESC')
      .getMany();

    if (matches.length === 0) {
      return null;
    }
    if (matches.length > 1) {
      throw new InvoiceTaxResolutionError(
        `Ambiguous invoice tax configuration for ride type ${rideType}`,
      );
    }
    return matches[0];
  }

  async resolveActiveTaxConfig(
    rideType: RideType,
    at: Date,
  ): Promise<InvoiceTaxConfig> {
    const match = await this.findActiveTaxConfig(rideType, at);
    if (!match) {
      throw new InvoiceTaxResolutionError(
        `No active invoice tax configuration for ride type ${rideType}`,
      );
    }
    return match;
  }

  taxConfigSnapshot(config: InvoiceTaxConfig): Record<string, unknown> {
    return {
      id: config.id,
      serviceCategory: config.serviceCategory,
      rideTypes: config.rideTypes,
      sacCode: config.sacCode,
      gstRateBasisPoints: config.gstRateBasisPoints,
      pricingMode: config.pricingMode,
      placeOfSupplyMode: config.placeOfSupplyMode,
      effectiveFrom: config.effectiveFrom.toISOString(),
      effectiveTo: config.effectiveTo?.toISOString() ?? null,
      status: config.status,
      notes: config.notes,
    };
  }

  private assertIssuerDto(dto: UpsertInvoiceIssuerDto): void {
    const gstin = dto.gstin.trim().toUpperCase();
    const stateCode = dto.stateCode.trim();
    if (!GSTIN_PATTERN.test(gstin)) {
      throw new BadRequestException('Invalid GSTIN');
    }
    if (!INDIAN_STATE_CODE_PATTERN.test(stateCode)) {
      throw new BadRequestException('Invalid issuer state code');
    }
    if (gstin.slice(0, 2) !== stateCode) {
      throw new BadRequestException(
        'GSTIN state code prefix must match issuer stateCode',
      );
    }
  }

  private normalizeRideTypes(rideTypes: RideType[]): RideType[] {
    const unique = [...new Set(rideTypes)];
    for (const rideType of unique) {
      if (!INVOICE_ELIGIBLE_RIDE_TYPES.includes(rideType)) {
        throw new BadRequestException(
          `Ride type ${rideType} is not eligible for rider GST invoices`,
        );
      }
    }
    return unique;
  }

  private assertWindow(from: Date, to: Date | null): void {
    if (Number.isNaN(from.getTime())) {
      throw new BadRequestException('effectiveFrom is invalid');
    }
    if (to && Number.isNaN(to.getTime())) {
      throw new BadRequestException('effectiveTo is invalid');
    }
    if (to && to.getTime() <= from.getTime()) {
      throw new BadRequestException('effectiveTo must be after effectiveFrom');
    }
  }

  private async assertNoOverlap(
    excludeId: string | null,
    rideTypes: RideType[],
    effectiveFrom: Date,
    effectiveTo: Date | null,
  ): Promise<void> {
    const qb = this.taxConfigRepository
      .createQueryBuilder('config')
      .where('config.status = :status', { status: InvoiceTaxConfigStatus.ACTIVE })
      .andWhere('config.ride_types && :rideTypes', { rideTypes })
      .andWhere('config.effective_from < :endAt', {
        endAt: effectiveTo ?? new Date('9999-12-31T23:59:59.000Z'),
      })
      .andWhere('(config.effective_to IS NULL OR config.effective_to > :startAt)', {
        startAt: effectiveFrom,
      });
    if (excludeId) {
      qb.andWhere('config.id <> :excludeId', { excludeId });
    }
    const overlapping = await qb.getCount();
    if (overlapping > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVOICE_TAX_CONFIG_OVERLAP',
        message:
          'Active tax configuration overlaps another active rule for the same ride type',
      });
    }
  }

  private async writeTaxAudit(
    config: InvoiceTaxConfig,
    adminUserId: string,
    action: string,
  ): Promise<void> {
    await this.taxAuditRepository.save(
      this.taxAuditRepository.create({
        taxConfigId: config.id,
        adminUserId,
        action,
        snapshot: this.taxConfigSnapshot(config),
      }),
    );
  }
}
