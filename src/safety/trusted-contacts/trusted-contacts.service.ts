import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import { CreateTrustedContactDto } from './dto/create-trusted-contact.dto';
import {
  TrustedContactPageDto,
  TrustedContactResponseDto,
} from './dto/trusted-contact-response.dto';
import { UpdateTrustedContactDto } from './dto/update-trusted-contact.dto';
import { TrustedContact } from './entities/trusted-contact.entity';
import {
  DuplicateTrustedContactError,
  InvalidTrustedContactNameError,
  InvalidTrustedContactPhoneError,
  TrustedContactLimitReachedError,
  TrustedContactNotFoundError,
} from './errors/trusted-contact.errors';
import { DEFAULT_MAX_TRUSTED_CONTACTS } from './trusted-contact.constants';
import { normalizeTrustedContactPhone } from './trusted-contact-phone.util';

@Injectable()
export class TrustedContactsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @InjectRepository(TrustedContact)
    private readonly contactRepository: Repository<TrustedContact>,
  ) {}

  private maxContacts(): number {
    const raw = this.configService.get<string>('MAX_TRUSTED_CONTACTS');
    const parsed = raw != null ? Number(raw) : DEFAULT_MAX_TRUSTED_CONTACTS;
    if (!Number.isFinite(parsed) || parsed < 1) {
      return DEFAULT_MAX_TRUSTED_CONTACTS;
    }
    return Math.floor(parsed);
  }

  private toResponse(row: TrustedContact): TrustedContactResponseDto {
    return {
      id: row.id,
      name: row.name,
      phoneNumber: row.phoneNumber,
      relationship: row.relationship,
      photoUrl: row.photoUrl,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private requireNormalizedPhone(raw: string): string {
    const normalized = normalizeTrustedContactPhone(raw);
    if (!normalized) {
      throw new InvalidTrustedContactPhoneError();
    }
    return normalized;
  }

  private requireName(name: string): string {
    const trimmed = name?.trim() ?? '';
    if (trimmed.length < 2 || trimmed.length > 100) {
      throw new InvalidTrustedContactNameError();
    }
    return trimmed;
  }

  async create(
    userId: string,
    dto: CreateTrustedContactDto,
  ): Promise<TrustedContactResponseDto> {
    const name = this.requireName(dto.name);
    const phoneNumber = this.requireNormalizedPhone(dto.phoneNumber);
    const photoUrl =
      dto.photoUrl === undefined
        ? null
        : dto.photoUrl === null
          ? null
          : dto.photoUrl.trim() || null;

    try {
      const saved = await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(TrustedContact);

        // Lock existing active rows for this user so concurrent creates cannot
        // bypass the max-contact limit.
        await repo
          .createQueryBuilder('c')
          .setLock('pessimistic_write')
          .where('c.user_id = :userId', { userId })
          .andWhere('c.deleted_at IS NULL')
          .getMany();

        const count = await repo.count({ where: { userId } });
        const max = this.maxContacts();
        if (count >= max) {
          throw new TrustedContactLimitReachedError(max);
        }

        const duplicate = await repo.findOne({
          where: { userId, phoneNumber },
        });
        if (duplicate) {
          throw new DuplicateTrustedContactError();
        }

        const entity = repo.create({
          userId,
          name,
          phoneNumber,
          relationship: dto.relationship,
          photoUrl,
        });
        return repo.save(entity);
      });

      return this.toResponse(saved);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new DuplicateTrustedContactError();
      }
      throw error;
    }
  }

  async list(
    userId: string,
    pageRaw?: number,
    limitRaw?: number,
  ): Promise<TrustedContactPageDto> {
    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(50, Math.max(1, Number(limitRaw) || 20));
    const skip = (page - 1) * limit;

    const [rows, total] = await this.contactRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip,
      take: limit,
    });

    return {
      items: rows.map((row) => this.toResponse(row)),
      page,
      limit,
      total,
    };
  }

  async getById(
    userId: string,
    contactId: string,
  ): Promise<TrustedContactResponseDto> {
    const row = await this.requireOwned(userId, contactId);
    return this.toResponse(row);
  }

  async update(
    userId: string,
    contactId: string,
    dto: UpdateTrustedContactDto,
  ): Promise<TrustedContactResponseDto> {
    const row = await this.requireOwned(userId, contactId);

    if (dto.name !== undefined) {
      row.name = this.requireName(dto.name);
    }
    if (dto.phoneNumber !== undefined) {
      row.phoneNumber = this.requireNormalizedPhone(dto.phoneNumber);
    }
    if (dto.relationship !== undefined) {
      row.relationship = dto.relationship;
    }
    if (dto.photoUrl !== undefined) {
      row.photoUrl =
        dto.photoUrl === null ? null : dto.photoUrl.trim() || null;
    }

    try {
      const saved = await this.contactRepository.save(row);
      return this.toResponse(saved);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new DuplicateTrustedContactError();
      }
      throw error;
    }
  }

  async remove(userId: string, contactId: string): Promise<void> {
    const row = await this.requireOwned(userId, contactId);
    await this.contactRepository.softRemove(row);
  }

  private async requireOwned(
    userId: string,
    contactId: string,
  ): Promise<TrustedContact> {
    const row = await this.contactRepository.findOne({
      where: { id: contactId, userId },
    });
    if (!row) {
      // Same response whether missing or owned by someone else (privacy).
      throw new TrustedContactNotFoundError();
    }
    return row;
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driver = (
      error as QueryFailedError & {
        driverError?: { code?: string };
        code?: string;
      }
    ).driverError;
    const code = driver?.code ?? (error as { code?: string }).code;
    return code === '23505';
  }
}
