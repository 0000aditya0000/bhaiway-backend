import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/enums/notification.enums';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletNotFoundError } from '../wallet/errors/wallet.errors';
import { WalletService } from '../wallet/wallet.service';
import {
  ReferralPageDto,
  ReferralSummaryDto,
} from './dto/referral-response.dto';
import { Referral } from './entities/referral.entity';
import {
  REFERRAL_REFERENCE_TYPE,
  REFERRAL_REWARD_COINS,
  ReferralStatus,
  referralNotifyReferredKey,
  referralNotifyReferrerKey,
  referralRewardReferredIdempotencyKey,
  referralRewardReferrerIdempotencyKey,
} from './enums/referral.enums';
import {
  ReferralAlreadyExistsError,
  ReferralCodeGenerationError,
  ReferralCodeInvalidError,
  SelfReferralNotAllowedError,
} from './errors/referral.errors';
import {
  generateReferralCode,
  normalizeReferralCode,
} from './referral-code.util';

const CODE_ALLOCATION_ATTEMPTS = 12;

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
    private readonly notificationsService: NotificationsService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly profileRepository: Repository<UserProfile>,
    @InjectRepository(Referral)
    private readonly referralRepository: Repository<Referral>,
  ) {}

  /**
   * Allocates a unique referral code for a new user (caller owns the TX).
   */
  async allocateUniqueReferralCode(manager: EntityManager): Promise<string> {
    const userRepo = manager.getRepository(User);
    for (let attempt = 0; attempt < CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
      const code = generateReferralCode();
      const existing = await userRepo.findOne({
        where: { referralCode: code },
      });
      if (!existing) {
        return code;
      }
    }
    throw new ReferralCodeGenerationError();
  }

  /**
   * Ensures the user has a referral code (lazy backfill for pre-migration users).
   */
  async ensureUserReferralCode(userId: string): Promise<string> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new WalletNotFoundError();
    }
    if (user.referralCode) {
      return user.referralCode;
    }

    return this.dataSource.transaction(async (manager) => {
      const locked = await manager
        .getRepository(User)
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :userId', { userId })
        .getOne();
      if (!locked) {
        throw new WalletNotFoundError();
      }
      if (locked.referralCode) {
        return locked.referralCode;
      }
      for (let attempt = 0; attempt < CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
        const code = generateReferralCode();
        try {
          locked.referralCode = code;
          await manager.getRepository(User).save(locked);
          return code;
        } catch {
          // unique collision — retry
        }
      }
      throw new ReferralCodeGenerationError();
    });
  }

  /**
   * Resolves a referral code for a NEW user registration.
   * Throws REFERRAL_CODE_INVALID if the code is non-empty but unknown.
   */
  async resolveReferrerInTransaction(
    manager: EntityManager,
    rawCode: string | null | undefined,
  ): Promise<User | null> {
    const code = normalizeReferralCode(rawCode);
    if (!code) {
      return null;
    }

    const referrer = await manager.getRepository(User).findOne({
      where: { referralCode: code },
    });
    if (!referrer) {
      throw new ReferralCodeInvalidError();
    }
    return referrer;
  }

  /**
   * Creates the referral row and credits both wallets inside an existing TX
   * (must run after the referred user + wallet exist).
   */
  async applyReferralRewardsInTransaction(
    manager: EntityManager,
    params: {
      referrer: User;
      referredUserId: string;
      referralCode: string;
    },
  ): Promise<Referral> {
    if (params.referrer.id === params.referredUserId) {
      throw new SelfReferralNotAllowedError();
    }

    const referralRepo = manager.getRepository(Referral);
    const existing = await referralRepo.findOne({
      where: { referredUserId: params.referredUserId },
    });
    if (existing) {
      throw new ReferralAlreadyExistsError();
    }

    const referredWallet = await manager.getRepository(Wallet).findOne({
      where: { userId: params.referredUserId },
    });
    const referrerWallet = await manager.getRepository(Wallet).findOne({
      where: { userId: params.referrer.id },
    });
    if (!referredWallet || !referrerWallet) {
      throw new WalletNotFoundError();
    }

    const now = new Date();
    const referral = referralRepo.create({
      referrerUserId: params.referrer.id,
      referredUserId: params.referredUserId,
      referralCode: params.referralCode,
      status: ReferralStatus.REWARDED,
      rewardCoins: REFERRAL_REWARD_COINS.toString(),
      rewardedAt: now,
    });
    const saved = await referralRepo.save(referral);

    await this.walletService.creditPointsInTransaction(manager, {
      walletId: referredWallet.id,
      userId: params.referredUserId,
      amount: REFERRAL_REWARD_COINS,
      sourceType: WalletPointSource.PROMOTIONAL,
      referenceType: REFERRAL_REFERENCE_TYPE,
      referenceId: saved.id,
      idempotencyKey: referralRewardReferredIdempotencyKey(saved.id),
      suppressWalletCreditNotification: true,
    });

    await this.walletService.creditPointsInTransaction(manager, {
      walletId: referrerWallet.id,
      userId: params.referrer.id,
      amount: REFERRAL_REWARD_COINS,
      sourceType: WalletPointSource.PROMOTIONAL,
      referenceType: REFERRAL_REFERENCE_TYPE,
      referenceId: saved.id,
      idempotencyKey: referralRewardReferrerIdempotencyKey(saved.id),
      suppressWalletCreditNotification: true,
    });

    await this.notificationsService.safeEnqueueInTransaction(manager, {
      recipientUserId: params.referrer.id,
      type: NotificationType.REFERRAL_REWARD_REFERRER,
      title: 'Referral Reward',
      body: 'Your friend joined BhaiWay! 50 Coins have been added to your wallet. 🎉',
      data: {
        type: NotificationType.REFERRAL_REWARD_REFERRER,
        referralId: saved.id,
        amount: REFERRAL_REWARD_COINS.toString(),
      },
      idempotencyKey: referralNotifyReferrerKey(saved.id),
    });

    await this.notificationsService.safeEnqueueInTransaction(manager, {
      recipientUserId: params.referredUserId,
      type: NotificationType.REFERRAL_REWARD_REFERRED,
      title: 'Referral Reward',
      body: 'Welcome to BhaiWay! 50 Coins have been added to your wallet through your referral. 🎉',
      data: {
        type: NotificationType.REFERRAL_REWARD_REFERRED,
        referralId: saved.id,
        amount: REFERRAL_REWARD_COINS.toString(),
      },
      idempotencyKey: referralNotifyReferredKey(saved.id),
    });

    this.logger.log(
      `Referral rewarded referrer=${params.referrer.id} referred=${params.referredUserId} referral=${saved.id}`,
    );

    return saved;
  }

  async getSummary(userId: string): Promise<ReferralSummaryDto> {
    const referralCode = await this.ensureUserReferralCode(userId);
    const raw = await this.referralRepository
      .createQueryBuilder('r')
      .select('COUNT(*)', 'cnt')
      .addSelect('COALESCE(SUM(r.reward_coins), 0)', 'coins')
      .where('r.referrer_user_id = :userId', { userId })
      .andWhere('r.status = :status', { status: ReferralStatus.REWARDED })
      .getRawOne<{ cnt: string; coins: string }>();

    return {
      referralCode,
      totalReferrals: Number(raw?.cnt ?? 0),
      totalCoinsEarned: String(raw?.coins ?? '0'),
    };
  }

  async listForReferrer(
    userId: string,
    pageRaw?: number,
    limitRaw?: number,
  ): Promise<ReferralPageDto> {
    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(50, Math.max(1, Number(limitRaw) || 20));
    const skip = (page - 1) * limit;

    const [rows, total] = await this.referralRepository.findAndCount({
      where: { referrerUserId: userId },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    const referredIds = rows.map((r) => r.referredUserId);
    const profiles =
      referredIds.length === 0
        ? []
        : await this.profileRepository
            .createQueryBuilder('p')
            .where('p.user_id IN (:...ids)', { ids: referredIds })
            .getMany();
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

    return {
      items: rows.map((row) => {
        const profile = profileByUser.get(row.referredUserId);
        const name =
          profile?.displayName ||
          [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') ||
          null;
        return {
          id: row.id,
          referredUser: {
            id: row.referredUserId,
            name: name || null,
            profilePhoto: profile?.profilePhoto ?? null,
          },
          rewardCoins: row.rewardCoins,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          rewardedAt: row.rewardedAt ? row.rewardedAt.toISOString() : null,
        };
      }),
      page,
      limit,
      total,
    };
  }
}
