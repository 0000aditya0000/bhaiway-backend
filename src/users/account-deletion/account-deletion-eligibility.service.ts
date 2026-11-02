import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Booking } from '../../bookings/entities/booking.entity';
import { BookingStatus } from '../../bookings/enums/booking.enums';
import { NoShowClaim } from '../../no-show/entities/no-show-claim.entity';
import { NoShowClaimStatus } from '../../no-show/enums/no-show.enums';
import { RideSeries } from '../../rides/entities/ride-series.entity';
import { Ride } from '../../rides/entities/ride.entity';
import { RideSeriesStatus, RideStatus } from '../../rides/enums/ride.enums';
import { SafetyIncident } from '../../safety/sos/entities/safety-incident.entity';
import { SosEvent } from '../../safety/sos/entities/sos-event.entity';
import { SosParticipant } from '../../safety/sos/entities/sos-participant.entity';
import {
  ACTIVE_SOS_STATUSES,
  OPEN_INCIDENT_STATUSES,
} from '../../safety/sos/enums/sos.enums';
import { SupportTicket } from '../../support/entities/support-ticket.entity';
import { SupportTicketStatus } from '../../support/enums/support.enums';
import { PaymentOrder } from '../../wallet/entities/payment-order.entity';
import { WalletBalance } from '../../wallet/entities/wallet-balance.entity';
import {
  WalletHold,
  WalletHoldStatus,
} from '../../wallet/entities/wallet-hold.entity';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { Withdrawal } from '../../wallet/entities/withdrawal.entity';
import { PaymentOrderStatus } from '../../wallet/enums/payment-order.enums';
import { WithdrawalStatus } from '../../wallet/enums/withdrawal.enums';

export interface DeletionBlocker {
  type: string;
  count: number;
  description: string;
  details?: Record<string, unknown>;
}

export interface EligibilityResult {
  eligible: boolean;
  blockers: DeletionBlocker[];
}

@Injectable()
export class AccountDeletionEligibilityService {
  private readonly logger = new Logger(AccountDeletionEligibilityService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(RideSeries)
    private readonly rideSeriesRepository: Repository<RideSeries>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(WalletBalance)
    private readonly walletBalanceRepository: Repository<WalletBalance>,
    @InjectRepository(WalletHold)
    private readonly walletHoldRepository: Repository<WalletHold>,
    @InjectRepository(PaymentOrder)
    private readonly paymentOrderRepository: Repository<PaymentOrder>,
    @InjectRepository(Withdrawal)
    private readonly withdrawalRepository: Repository<Withdrawal>,
    @InjectRepository(SosEvent)
    private readonly sosEventRepository: Repository<SosEvent>,
    @InjectRepository(SafetyIncident)
    private readonly safetyIncidentRepository: Repository<SafetyIncident>,
    @InjectRepository(SupportTicket)
    private readonly supportTicketRepository: Repository<SupportTicket>,
    @InjectRepository(NoShowClaim)
    private readonly noShowClaimRepository: Repository<NoShowClaim>,
  ) {}

  /**
   * Evaluates all outstanding obligations across BhaiWay subsystems.
   * If an EntityManager is supplied, queries run inside that transaction context.
   */
  async checkEligibility(
    userId: string,
    manager?: EntityManager,
  ): Promise<EligibilityResult> {
    const blockers: DeletionBlocker[] = [];

    // 1. Active driver rides
    const rideRepo = manager
      ? manager.getRepository(Ride)
      : this.rideRepository;

    const activeRideStatuses = [
      RideStatus.DRAFT,
      RideStatus.PUBLISHED,
      RideStatus.ASSURANCE_PENDING,
      RideStatus.ASSURANCE_ACTIVE,
      RideStatus.IN_PROGRESS,
    ];

    const activeDriverRides = await rideRepo
      .createQueryBuilder('r')
      .where('r.driverId = :userId', { userId })
      .andWhere('r.status IN (:...statuses)', { statuses: activeRideStatuses })
      .getMany();

    if (activeDriverRides.length > 0) {
      const inProgressRides = activeDriverRides.filter(
        (r) => r.status === RideStatus.IN_PROGRESS,
      );
      if (inProgressRides.length > 0) {
        blockers.push({
          type: 'RIDE_IN_PROGRESS',
          count: inProgressRides.length,
          description:
            'You are currently operating a ride in progress. Complete the trip before proceeding.',
          details: { rideIds: inProgressRides.map((r) => r.id) },
        });
      }

      const scheduledRides = activeDriverRides.filter(
        (r) => r.status !== RideStatus.IN_PROGRESS,
      );
      if (scheduledRides.length > 0) {
        blockers.push({
          type: 'ACTIVE_DRIVER_RIDE',
          count: scheduledRides.length,
          description:
            'You have active, scheduled or pending rides as a driver. Cancel or complete them before closing your account.',
          details: { rideIds: scheduledRides.map((r) => r.id) },
        });
      }
    }

    // 2. Active recurring commute series
    const seriesRepo = manager
      ? manager.getRepository(RideSeries)
      : this.rideSeriesRepository;

    const activeSeriesCount = await seriesRepo.count({
      where: {
        driverId: userId,
        status: RideSeriesStatus.ACTIVE,
      },
    });

    if (activeSeriesCount > 0) {
      blockers.push({
        type: 'ACTIVE_COMMUTE_SERIES',
        count: activeSeriesCount,
        description:
          'You have an active recurring Office Commute series. You must cancel the series before deleting your account.',
      });
    }

    // 3. Active passenger bookings
    const bookingRepo = manager
      ? manager.getRepository(Booking)
      : this.bookingRepository;

    const activeBookingStatuses = [
      BookingStatus.PENDING,
      BookingStatus.CONFIRMED,
    ];

    const activeBookings = await bookingRepo
      .createQueryBuilder('b')
      .innerJoinAndSelect('b.ride', 'r')
      .where('b.passengerId = :userId', { userId })
      .andWhere('b.status IN (:...statuses)', {
        statuses: activeBookingStatuses,
      })
      .getMany();

    if (activeBookings.length > 0) {
      const inProgressBookings = activeBookings.filter(
        (b) => b.ride && b.ride.status === RideStatus.IN_PROGRESS,
      );
      if (inProgressBookings.length > 0) {
        blockers.push({
          type: 'RIDE_IN_PROGRESS',
          count: inProgressBookings.length,
          description:
            'You have an active booking on a trip currently in progress.',
          details: { bookingIds: inProgressBookings.map((b) => b.id) },
        });
      }

      const otherBookings = activeBookings.filter(
        (b) => !b.ride || b.ride.status !== RideStatus.IN_PROGRESS,
      );
      if (otherBookings.length > 0) {
        blockers.push({
          type: 'ACTIVE_BOOKING',
          count: otherBookings.length,
          description:
            'You have pending or confirmed passenger bookings. Cancel or complete them before deletion.',
          details: { bookingIds: otherBookings.map((b) => b.id) },
        });
      }
    }

    // 4. Wallet balances and active holds
    const walletRepo = manager
      ? manager.getRepository(Wallet)
      : this.walletRepository;
    const balanceRepo = manager
      ? manager.getRepository(WalletBalance)
      : this.walletBalanceRepository;
    const holdRepo = manager
      ? manager.getRepository(WalletHold)
      : this.walletHoldRepository;

    const wallet = await walletRepo.findOne({ where: { userId } });
    if (wallet) {
      const balance = await balanceRepo.findOne({
        where: { walletId: wallet.id },
      });

      if (balance) {
        const purchased = BigInt(balance.purchasedAvailable || '0');
        const driverEarned = BigInt(balance.driverEarnedAvailable || '0');
        const totalWithdrawable = purchased + driverEarned;

        if (totalWithdrawable > 0n) {
          blockers.push({
            type: 'OUTSTANDING_WALLET_BALANCE',
            count: 1,
            description: `You have an outstanding withdrawable wallet balance of ${totalWithdrawable.toString()} points/coins. Please withdraw or settle your balance.`,
            details: {
              purchasedAvailable: balance.purchasedAvailable,
              driverEarnedAvailable: balance.driverEarnedAvailable,
            },
          });
        }

        const purchasedHeld = BigInt(balance.purchasedHeld || '0');
        const promoHeld = BigInt(balance.promotionalHeld || '0');
        const driverHeld = BigInt(balance.driverEarnedHeld || '0');
        const totalHeld = purchasedHeld + promoHeld + driverHeld;

        if (totalHeld > 0n) {
          blockers.push({
            type: 'ACTIVE_WALLET_HOLD',
            count: 1,
            description:
              'You have funds held in your wallet for pending security deposits or in-flight payments.',
            details: { totalHeld: totalHeld.toString() },
          });
        }
      }

      // Check active wallet holds explicitly
      const activeHoldCount = await holdRepo.count({
        where: {
          walletId: wallet.id,
          status: WalletHoldStatus.ACTIVE,
        },
      });

      if (
        activeHoldCount > 0 &&
        !blockers.some((b) => b.type === 'ACTIVE_WALLET_HOLD')
      ) {
        blockers.push({
          type: 'ACTIVE_WALLET_HOLD',
          count: activeHoldCount,
          description:
            'You have active security deposit or ride payment holds that must be settled.',
        });
      }
    }

    // 5. Pending payment orders
    const paymentOrderRepo = manager
      ? manager.getRepository(PaymentOrder)
      : this.paymentOrderRepository;

    const pendingPaymentOrders = await paymentOrderRepo.count({
      where: {
        userId,
        status: PaymentOrderStatus.PENDING,
      },
    });

    if (pendingPaymentOrders > 0) {
      blockers.push({
        type: 'PENDING_PAYMENT_ORDER',
        count: pendingPaymentOrders,
        description:
          'You have pending payment transactions awaiting confirmation from the payment gateway.',
      });
    }

    // 6. Pending withdrawals
    const withdrawalRepo = manager
      ? manager.getRepository(Withdrawal)
      : this.withdrawalRepository;

    const pendingWithdrawalStatuses = [
      WithdrawalStatus.INITIATED,
      WithdrawalStatus.PROCESSING,
    ];

    const pendingWithdrawals = await withdrawalRepo
      .createQueryBuilder('w')
      .where('w.userId = :userId', { userId })
      .andWhere('w.status IN (:...statuses)', {
        statuses: pendingWithdrawalStatuses,
      })
      .getCount();

    if (pendingWithdrawals > 0) {
      blockers.push({
        type: 'PENDING_WITHDRAWAL',
        count: pendingWithdrawals,
        description:
          'You have a withdrawal request currently being processed. It must complete before account closure.',
      });
    }

    // 7. Active SOS & Safety Incidents
    const sosRepo = manager
      ? manager.getRepository(SosEvent)
      : this.sosEventRepository;

    const activeSosCount = await sosRepo
      .createQueryBuilder('sos')
      .innerJoin(Ride, 'r', 'r.id = sos.rideId')
      .leftJoin(SosParticipant, 'p', 'p.sosId = sos.id')
      .where('sos.status IN (:...statuses)', { statuses: ACTIVE_SOS_STATUSES })
      .andWhere(
        '(sos.originalTriggerUserId = :userId OR r.driverId = :userId OR p.userId = :userId)',
        { userId },
      )
      .getCount();

    if (activeSosCount > 0) {
      blockers.push({
        type: 'ACTIVE_SAFETY_INCIDENT',
        count: activeSosCount,
        description:
          'Your account is associated with an active emergency SOS event currently being addressed.',
      });
    }

    const incidentRepo = manager
      ? manager.getRepository(SafetyIncident)
      : this.safetyIncidentRepository;

    const openIncidentCount = await incidentRepo
      .createQueryBuilder('inc')
      .innerJoin(Ride, 'r', 'r.id = inc.rideId')
      .leftJoin(Booking, 'b', 'b.rideId = inc.rideId')
      .where('inc.status IN (:...statuses)', {
        statuses: OPEN_INCIDENT_STATUSES,
      })
      .andWhere('(r.driverId = :userId OR b.passengerId = :userId)', { userId })
      .getCount();

    if (
      openIncidentCount > 0 &&
      !blockers.some((b) => b.type === 'ACTIVE_SAFETY_INCIDENT')
    ) {
      blockers.push({
        type: 'ACTIVE_SAFETY_INCIDENT',
        count: openIncidentCount,
        description:
          'Your account is associated with an open safety incident under investigation.',
      });
    }

    // 8. Open Support Tickets & Disputes
    const ticketRepo = manager
      ? manager.getRepository(SupportTicket)
      : this.supportTicketRepository;

    const openTicketStatuses = [
      SupportTicketStatus.CREATED,
      SupportTicketStatus.IN_PROGRESS,
    ];

    const openTicketCount = await ticketRepo
      .createQueryBuilder('t')
      .where('t.userId = :userId', { userId })
      .andWhere('t.status IN (:...statuses)', { statuses: openTicketStatuses })
      .getCount();

    if (openTicketCount > 0) {
      blockers.push({
        type: 'UNRESOLVED_SUPPORT_TICKET',
        count: openTicketCount,
        description:
          'You have open support tickets or active dispute inquiries awaiting resolution.',
      });
    }

    // 9. Pending No-Show Claims
    const noShowRepo = manager
      ? manager.getRepository(NoShowClaim)
      : this.noShowClaimRepository;

    const pendingNoShowCount = await noShowRepo
      .createQueryBuilder('ns')
      .where('ns.status = :status', { status: NoShowClaimStatus.PENDING })
      .andWhere(
        '(ns.claimantUserId = :userId OR ns.respondentUserId = :userId)',
        {
          userId,
        },
      )
      .getCount();

    if (pendingNoShowCount > 0) {
      blockers.push({
        type: 'PENDING_NO_SHOW_CLAIM',
        count: pendingNoShowCount,
        description:
          'You have pending ride no-show claims awaiting review or counter-response.',
      });
    }

    return {
      eligible: blockers.length === 0,
      blockers,
    };
  }
}
