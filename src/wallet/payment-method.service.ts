import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import {
  CreatePaymentMethodDto,
  DeletePaymentMethodResponseDto,
  PaymentMethodResponseDto,
  UpdatePaymentMethodDto,
} from './dto/payment-method.dto';
import { UserPaymentMethod } from './entities/user-payment-method.entity';
import type { WithdrawalPaymentMethodSnapshot } from './entities/withdrawal.entity';
import { Withdrawal } from './entities/withdrawal.entity';
import { PaymentMethodType } from './enums/withdrawal.enums';
import {
  InvalidPaymentMethodError,
  PaymentMethodNotFoundError,
} from './errors/withdrawal.errors';
import {
  decryptAccountNumber,
  encryptAccountNumber,
  maskAccountNumber,
} from './payment-method-crypto.util';

const UPI_PATTERN = /^[\w.-]{2,}@[\w.-]{2,}$/i;
const ACCOUNT_NUMBER_PATTERN = /^\d{9,18}$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export interface CreatePaymentMethodResult {
  method: PaymentMethodResponseDto;
  /** false when an identical active method already existed. */
  created: boolean;
}

@Injectable()
export class PaymentMethodService {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(UserPaymentMethod)
    private readonly paymentMethodRepository: Repository<UserPaymentMethod>,
    @InjectRepository(Withdrawal)
    private readonly withdrawalRepository: Repository<Withdrawal>,
  ) {}

  async create(
    userId: string,
    dto: CreatePaymentMethodDto,
  ): Promise<CreatePaymentMethodResult> {
    if (dto.type === PaymentMethodType.UPI) {
      const upiId = this.normalizeUpi(dto.upiId);
      const existing = await this.paymentMethodRepository
        .createQueryBuilder('pm')
        .where('pm.user_id = :userId', { userId })
        .andWhere('pm.type = :type', { type: PaymentMethodType.UPI })
        .andWhere('pm.is_active = true')
        .andWhere('LOWER(pm.upi_id) = :upiId', { upiId })
        .getOne();
      if (existing) {
        return { method: this.toResponse(existing), created: false };
      }

      const saved = await this.paymentMethodRepository.save(
        this.paymentMethodRepository.create({
          userId,
          type: PaymentMethodType.UPI,
          upiId,
          accountHolderName: null,
          accountNumberEncrypted: null,
          accountNumberLast4: null,
          ifscCode: null,
          bankName: null,
          isActive: true,
        }),
      );
      return { method: this.toResponse(saved), created: true };
    }

    const bank = this.normalizeBank(dto);
    const last4 = bank.accountNumber.slice(-4);
    const candidates = await this.paymentMethodRepository
      .createQueryBuilder('pm')
      .where('pm.user_id = :userId', { userId })
      .andWhere('pm.type = :type', { type: PaymentMethodType.BANK_ACCOUNT })
      .andWhere('pm.is_active = true')
      .andWhere('pm.account_number_last4 = :last4', { last4 })
      .andWhere('pm.ifsc_code = :ifsc', { ifsc: bank.ifscCode })
      .andWhere('LOWER(pm.account_holder_name) = :holder', {
        holder: bank.accountHolderName.toLowerCase(),
      })
      .getMany();
    const duplicate = candidates.find((candidate) => {
      if (!candidate.accountNumberEncrypted) {
        return true;
      }
      const plain = decryptAccountNumber(
        candidate.accountNumberEncrypted,
        this.getSecret(),
      );
      return plain === null || plain === bank.accountNumber;
    });
    if (duplicate) {
      return { method: this.toResponse(duplicate), created: false };
    }

    const saved = await this.paymentMethodRepository.save(
      this.paymentMethodRepository.create({
        userId,
        type: PaymentMethodType.BANK_ACCOUNT,
        upiId: null,
        accountHolderName: bank.accountHolderName,
        accountNumberEncrypted: encryptAccountNumber(
          bank.accountNumber,
          this.getSecret(),
        ),
        accountNumberLast4: last4,
        ifscCode: bank.ifscCode,
        bankName: bank.bankName,
        isActive: true,
      }),
    );
    return { method: this.toResponse(saved), created: true };
  }

  async list(userId: string): Promise<PaymentMethodResponseDto[]> {
    const rows = await this.paymentMethodRepository.find({
      where: { userId, isActive: true },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return rows.map((row) => this.toResponse(row));
  }

  async get(userId: string, id: string): Promise<PaymentMethodResponseDto> {
    return this.toResponse(await this.findActiveOwned(userId, id));
  }

  async update(
    userId: string,
    id: string,
    dto: UpdatePaymentMethodDto,
  ): Promise<PaymentMethodResponseDto> {
    const method = await this.findActiveOwned(userId, id);

    if (method.type === PaymentMethodType.UPI) {
      if (dto.upiId !== undefined) {
        method.upiId = this.normalizeUpi(dto.upiId);
      }
    } else {
      const holder =
        dto.accountHolderName !== undefined
          ? this.normalizeHolder(dto.accountHolderName)
          : method.accountHolderName;
      const ifsc =
        dto.ifscCode !== undefined
          ? this.normalizeIfsc(dto.ifscCode)
          : method.ifscCode;
      const bankName =
        dto.bankName !== undefined
          ? this.normalizeBankName(dto.bankName)
          : method.bankName;

      method.accountHolderName = holder;
      method.ifscCode = ifsc;
      method.bankName = bankName;

      if (dto.accountNumber !== undefined) {
        const accountNumber = this.normalizeAccountNumber(dto.accountNumber);
        method.accountNumberEncrypted = encryptAccountNumber(
          accountNumber,
          this.getSecret(),
        );
        method.accountNumberLast4 = accountNumber.slice(-4);
      }
    }

    if (dto.isActive !== undefined) {
      method.isActive = dto.isActive;
    }

    const saved = await this.paymentMethodRepository.save(method);
    return this.toResponse(saved);
  }

  /**
   * Hard delete when the method was never used by a withdrawal;
   * otherwise soft delete (isActive=false) so history stays intact.
   */
  async remove(
    userId: string,
    id: string,
  ): Promise<DeletePaymentMethodResponseDto> {
    const method = await this.findActiveOwned(userId, id);

    const referenced = await this.withdrawalRepository.count({
      where: { paymentMethodId: method.id },
    });

    if (referenced > 0) {
      method.isActive = false;
      await this.paymentMethodRepository.save(method);
      return { id: method.id, deleted: false, deactivated: true };
    }

    await this.paymentMethodRepository.delete({ id: method.id, userId });
    return { id: method.id, deleted: true, deactivated: false };
  }

  /** Loads a method owned by the user (any active state). Used by withdrawals. */
  async findOwned(
    userId: string,
    id: string,
    manager?: EntityManager,
  ): Promise<UserPaymentMethod> {
    const repo = manager
      ? manager.getRepository(UserPaymentMethod)
      : this.paymentMethodRepository;
    const method = await repo.findOne({ where: { id, userId } });
    if (!method) {
      throw new PaymentMethodNotFoundError();
    }
    return method;
  }

  /** Immutable copy persisted on the withdrawal row. */
  buildSnapshot(method: UserPaymentMethod): WithdrawalPaymentMethodSnapshot {
    return {
      type: method.type,
      upiId: method.upiId,
      accountHolderName: method.accountHolderName,
      accountNumberEncrypted: method.accountNumberEncrypted,
      accountNumberLast4: method.accountNumberLast4,
      ifscCode: method.ifscCode,
      bankName: method.bankName,
    };
  }

  /** Admin-only: decrypts the full account number from a snapshot. */
  decryptSnapshotAccountNumber(
    snapshot: WithdrawalPaymentMethodSnapshot,
  ): string | null {
    if (!snapshot.accountNumberEncrypted) {
      return null;
    }
    return decryptAccountNumber(
      snapshot.accountNumberEncrypted,
      this.getSecret(),
    );
  }

  toResponse(method: UserPaymentMethod): PaymentMethodResponseDto {
    return {
      id: method.id,
      type: method.type,
      upiId: method.upiId,
      accountHolderName: method.accountHolderName,
      accountNumberMasked:
        method.type === PaymentMethodType.BANK_ACCOUNT
          ? maskAccountNumber(method.accountNumberLast4)
          : null,
      accountNumberLast4: method.accountNumberLast4,
      ifscCode: method.ifscCode,
      bankName: method.bankName,
      isActive: method.isActive,
      createdAt: method.createdAt.toISOString(),
      updatedAt: method.updatedAt.toISOString(),
    };
  }

  private async findActiveOwned(
    userId: string,
    id: string,
  ): Promise<UserPaymentMethod> {
    const method = await this.paymentMethodRepository.findOne({
      where: { id, userId, isActive: true },
    });
    if (!method) {
      throw new PaymentMethodNotFoundError();
    }
    return method;
  }

  private getSecret(): string {
    const secret =
      this.configService.get<string>('ENCRYPTION_KEY') ||
      this.configService.get<string>('JWT_ACCESS_SECRET') ||
      '';
    if (!secret) {
      throw new Error('ENCRYPTION_KEY or JWT_ACCESS_SECRET must be configured');
    }
    return secret;
  }

  private normalizeUpi(raw: string | undefined): string {
    const upiId = (raw ?? '').trim().toLowerCase();
    if (!upiId || upiId.length > 100 || !UPI_PATTERN.test(upiId)) {
      throw new InvalidPaymentMethodError('A valid UPI ID is required');
    }
    return upiId;
  }

  private normalizeHolder(raw: string | undefined): string {
    const holder = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (holder.length < 2 || holder.length > 100) {
      throw new InvalidPaymentMethodError(
        'Account holder name must be 2-100 characters',
      );
    }
    return holder;
  }

  private normalizeAccountNumber(raw: string | undefined): string {
    const accountNumber = (raw ?? '').replace(/\s+/g, '');
    if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
      throw new InvalidPaymentMethodError(
        'Account number must be 9-18 digits',
      );
    }
    return accountNumber;
  }

  private normalizeIfsc(raw: string | undefined): string {
    const ifsc = (raw ?? '').trim().toUpperCase();
    if (!IFSC_PATTERN.test(ifsc)) {
      throw new InvalidPaymentMethodError('A valid IFSC code is required');
    }
    return ifsc;
  }

  private normalizeBankName(raw: string | undefined): string {
    const bankName = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (bankName.length < 2 || bankName.length > 100) {
      throw new InvalidPaymentMethodError('Bank name is required');
    }
    return bankName;
  }

  private normalizeBank(dto: CreatePaymentMethodDto): {
    accountHolderName: string;
    accountNumber: string;
    ifscCode: string;
    bankName: string;
  } {
    return {
      accountHolderName: this.normalizeHolder(dto.accountHolderName),
      accountNumber: this.normalizeAccountNumber(dto.accountNumber),
      ifscCode: this.normalizeIfsc(dto.ifscCode),
      bankName: this.normalizeBankName(dto.bankName),
    };
  }
}
