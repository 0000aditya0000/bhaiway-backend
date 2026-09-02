import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Ride } from '../rides/entities/ride.entity';
import { RideType } from '../rides/enums/ride.enums';
import { WalletTransactionQueryDto } from './dto/wallet-transaction-query.dto';
import {
  WalletTransactionItemDto,
  WalletTransactionPageDto,
} from './dto/wallet-transaction-response.dto';
import { WalletTransaction } from './entities/wallet-transaction.entity';
import { Wallet } from './entities/wallet.entity';
import { WalletNotFoundError } from './errors/wallet.errors';
import { pointsToCoins } from './wallet-coins.mapper';
import { getWalletTransactionDisplay } from './wallet-transaction-display.mapper';
import { resolveRideContextForTransactions } from './wallet-transaction-ride-context';

@Injectable()
export class WalletHistoryService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(WalletTransaction)
    private readonly walletTransactionRepository: Repository<WalletTransaction>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
  ) {}

  async findTransactionsForUser(
    userId: string,
    query: WalletTransactionQueryDto,
  ): Promise<WalletTransactionPageDto> {
    const wallet = await this.walletRepository.findOne({
      where: { userId },
    });
    if (!wallet) {
      throw new WalletNotFoundError();
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.walletTransactionRepository
      .createQueryBuilder('tx')
      .where('tx.wallet_id = :walletId', { walletId: wallet.id })
      .orderBy('tx.created_at', 'DESC')
      .addOrderBy('tx.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.transactionType !== undefined) {
      qb.andWhere('tx.transaction_type = :transactionType', {
        transactionType: query.transactionType,
      });
    }

    if (query.from !== undefined) {
      qb.andWhere('tx.created_at >= :from', {
        from: `${query.from}T00:00:00.000Z`,
      });
    }

    if (query.to !== undefined) {
      qb.andWhere('tx.created_at <= :to', {
        to: `${query.to}T23:59:59.999Z`,
      });
    }

    const [transactions, total] = await qb.getManyAndCount();
    const rideContext = await resolveRideContextForTransactions(
      transactions,
      this.bookingRepository,
      this.rideRepository,
    );

    return {
      items: transactions.map((tx) => this.toItem(tx, rideContext)),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  private toItem(
    tx: WalletTransaction,
    rideContext: Map<string, { rideId: string; rideType: RideType }>,
  ): WalletTransactionItemDto {
    const ride = rideContext.get(tx.id);
    const display = getWalletTransactionDisplay(tx, ride?.rideType);
    return {
      transactionId: tx.id,
      transactionType: tx.transactionType,
      direction: tx.direction,
      amount: pointsToCoins(tx.amount),
      balanceBefore: pointsToCoins(tx.balanceBefore),
      balanceAfter: pointsToCoins(tx.balanceAfter),
      pointSource: tx.pointSource,
      status: tx.status,
      displayTitle: display.displayTitle,
      displayCategory: display.displayCategory,
      referenceType: tx.referenceType,
      referenceId: tx.referenceId,
      ...(ride ? { rideId: ride.rideId, rideType: ride.rideType } : {}),
      createdAt: tx.createdAt.toISOString(),
    };
  }
}
