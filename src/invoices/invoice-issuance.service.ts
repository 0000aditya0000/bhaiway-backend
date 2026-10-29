import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus } from '../rides/enums/ride.enums';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { GstInvoiceJob } from './entities/invoice-job.entity';
import { GstInvoice } from './entities/invoice.entity';
import {
  InvoiceEmailStatus,
  InvoiceJobStatus,
  InvoicePaymentStatus,
  InvoicePlaceOfSupplyMode,
  InvoiceTaxPricingMode,
} from './enums/invoice.enums';
import { InvoiceConfigService } from './invoice-config.service';
import {
  INVOICE_CURRENCY,
  INVOICE_ELIGIBLE_RIDE_TYPES,
  INVOICE_FALLBACK_SAC,
  INVOICE_FALLBACK_SERVICE_CATEGORY,
  INVOICE_FALLBACK_TAX_NOTES,
  INVOICE_NUMBER_PAD,
  INVOICE_RIDER_ENSURE_LIMIT,
  INVOICE_UNCONFIGURED_TAX_CONFIG_ID,
  isEligibleInvoiceRideType,
} from './invoice.constants';
import {
  formatIssuerAddress,
  formatPersonName,
  rideDepartureAt,
} from './invoice-name.util';
import {
  calculateInvoiceTax,
  indianFinancialYearLabel,
  InvoiceTaxResolutionError,
  rupeesToPaise,
  untaxedInvoiceResult,
} from './invoice-tax.math';

@Injectable()
export class InvoiceIssuanceService {
  private readonly logger = new Logger(InvoiceIssuanceService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly invoiceConfigService: InvoiceConfigService,
    @InjectRepository(GstInvoice)
    private readonly invoiceRepository: Repository<GstInvoice>,
    @InjectRepository(GstInvoiceJob)
    private readonly jobRepository: Repository<GstInvoiceJob>,
  ) {}

  async scheduleForCompletedRide(rideId: string): Promise<void> {
    const ride = await this.dataSource.getRepository(Ride).findOne({
      where: { id: rideId },
    });
    if (!ride || ride.status !== RideStatus.COMPLETED) {
      return;
    }
    if (!isEligibleInvoiceRideType(ride.rideType)) {
      return;
    }

    const bookings = await this.dataSource.getRepository(Booking).find({
      where: { rideId, status: BookingStatus.COMPLETED },
    });

    for (const booking of bookings) {
      await this.enqueueJob(ride.id, booking.id);
    }
  }

  /**
   * Enqueue missing invoice jobs for this rider's completed eligible bookings.
   * Used when the app polls GET /invoices so a completed Regular/Commute trip
   * can finish issuance without waiting for the 15s worker poll.
   */
  async ensureJobsForRider(
    riderUserId: string,
    filters?: { rideId?: string; bookingId?: string },
  ): Promise<string[]> {
    const qb = this.dataSource
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .innerJoin(Ride, 'ride', 'ride.id = booking.ride_id')
      .where('booking.passenger_id = :riderUserId', { riderUserId })
      .andWhere('booking.status = :bookingStatus', {
        bookingStatus: BookingStatus.COMPLETED,
      })
      .andWhere('ride.status = :rideStatus', {
        rideStatus: RideStatus.COMPLETED,
      })
      .andWhere('ride.ride_type IN (:...rideTypes)', {
        rideTypes: [...INVOICE_ELIGIBLE_RIDE_TYPES],
      })
      .orderBy('booking.updated_at', 'DESC')
      .addOrderBy('booking.id', 'DESC')
      .take(INVOICE_RIDER_ENSURE_LIMIT);

    if (filters?.rideId) {
      qb.andWhere('booking.ride_id = :rideId', { rideId: filters.rideId });
    }
    if (filters?.bookingId) {
      qb.andWhere('booking.id = :bookingId', { bookingId: filters.bookingId });
    }

    const bookings = await qb.getMany();
    const bookingIds: string[] = [];
    for (const booking of bookings) {
      bookingIds.push(booking.id);
      await this.enqueueJob(booking.rideId, booking.id);
    }
    return bookingIds;
  }

  private async enqueueJob(rideId: string, bookingId: string): Promise<void> {
    try {
      await this.jobRepository.save(
        this.jobRepository.create({
          id: randomUUID(),
          rideId,
          bookingId,
          status: InvoiceJobStatus.PENDING,
          attemptCount: 0,
          nextAttemptAt: null,
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        this.logger.warn(
          `Invoice job enqueue failed booking=${bookingId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async issueForJob(job: GstInvoiceJob): Promise<GstInvoice> {
    const existing = await this.invoiceRepository.findOne({
      where: { bookingId: job.bookingId },
    });
    if (existing) {
      return existing;
    }

    return this.dataSource.transaction(async (manager) => {
      const raced = await manager.getRepository(GstInvoice).findOne({
        where: { bookingId: job.bookingId },
      });
      if (raced) {
        return raced;
      }

      const ride = await manager.getRepository(Ride).findOne({
        where: { id: job.rideId },
      });
      const booking = await manager.getRepository(Booking).findOne({
        where: { id: job.bookingId },
      });
      if (!ride || !booking) {
        throw new InvoiceTaxResolutionError('Ride or booking missing for invoice job');
      }
      if (ride.status !== RideStatus.COMPLETED) {
        throw new InvoiceTaxResolutionError('Ride is not completed');
      }
      if (booking.status !== BookingStatus.COMPLETED) {
        throw new InvoiceTaxResolutionError('Booking is not completed');
      }
      if (!isEligibleInvoiceRideType(ride.rideType)) {
        throw new InvoiceTaxResolutionError(
          `Ride type ${ride.rideType} is not eligible for rider invoices`,
        );
      }

      const issuer = await this.invoiceConfigService.requireIssuer();
      const issuedAt = new Date();
      const taxConfig = await this.invoiceConfigService.findActiveTaxConfig(
        ride.rideType,
        issuedAt,
      );

      const rider = await manager.getRepository(User).findOne({
        where: { id: booking.passengerId },
      });
      const riderProfile = await manager.getRepository(UserProfile).findOne({
        where: { userId: booking.passengerId },
      });
      const driverProfile = await manager.getRepository(UserProfile).findOne({
        where: { userId: ride.driverId },
      });
      const vehicle = await manager.getRepository(Vehicle).findOne({
        where: { id: ride.vehicleId },
      });

      const netFareRupees = BigInt(booking.totalAmount);
      const discountRupees = BigInt(booking.couponDiscountAmount ?? '0');
      const grossFareRupees = netFareRupees + discountRupees;
      const tax = taxConfig
        ? calculateInvoiceTax({
            netFareRupees,
            grossFareRupees,
            discountRupees,
            gstRateBasisPoints: taxConfig.gstRateBasisPoints,
            pricingMode: taxConfig.pricingMode,
            placeOfSupplyMode: taxConfig.placeOfSupplyMode,
            issuerStateCode: issuer.stateCode,
            recipientStateCode: null,
          })
        : untaxedInvoiceResult({
            netFareRupees,
            issuerStateCode: issuer.stateCode,
          });
      const taxSnapshot = taxConfig
        ? {
            ...this.invoiceConfigService.taxConfigSnapshot(taxConfig),
            issuerFooterNotes: issuer.footerNotes,
          }
        : {
            id: INVOICE_UNCONFIGURED_TAX_CONFIG_ID,
            fallback: true,
            reason: 'NO_ACTIVE_TAX_CONFIG',
            gstRateBasisPoints: 0,
            pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
            placeOfSupplyMode: InvoicePlaceOfSupplyMode.ISSUER_STATE,
            sacCode: INVOICE_FALLBACK_SAC,
            serviceCategory: INVOICE_FALLBACK_SERVICE_CATEGORY,
            notes: INVOICE_FALLBACK_TAX_NOTES,
            issuerFooterNotes: issuer.footerNotes,
          };

      const invoiceNumber = await this.nextInvoiceNumber(
        manager,
        issuer.invoicePrefix,
        issuedAt,
      );

      const invoice = manager.getRepository(GstInvoice).create({
        invoiceNumber,
        rideId: ride.id,
        bookingId: booking.id,
        riderUserId: booking.passengerId,
        rideType: ride.rideType,
        riderName: formatPersonName(riderProfile),
        riderEmail: rider?.email?.trim().toLowerCase() || null,
        riderPhone: rider?.phone ?? null,
        riderBillingStateCode: null,
        driverName: formatPersonName(driverProfile),
        vehicleRegistrationNumber: vehicle?.registrationNumber ?? null,
        source: ride.source,
        destination: ride.destination,
        departureAt: rideDepartureAt(ride),
        completedAt: ride.completedAt,
        issuedAt,
        grossFarePaise: rupeesToPaise(grossFareRupees).toString(),
        discountPaise: rupeesToPaise(discountRupees).toString(),
        netFarePaise: rupeesToPaise(netFareRupees).toString(),
        taxableValuePaise: tax.taxableValuePaise.toString(),
        gstRateBasisPoints: tax.gstRateBasisPoints,
        cgstPaise: tax.cgstPaise.toString(),
        sgstPaise: tax.sgstPaise.toString(),
        igstPaise: tax.igstPaise.toString(),
        totalTaxPaise: tax.totalTaxPaise.toString(),
        invoiceTotalPaise: tax.invoiceTotalPaise.toString(),
        pricingMode: tax.pricingMode,
        gstSplit: tax.split,
        paymentStatus: this.mapPaymentStatus(booking.paymentStatus),
        paymentReference:
          booking.fareWalletTransactionId ??
          booking.walletTransactionId ??
          booking.idempotencyKey,
        issuerLegalName: issuer.legalName,
        issuerGstin: issuer.gstin,
        issuerAddress: formatIssuerAddress(issuer),
        issuerState: issuer.state,
        issuerStateCode: issuer.stateCode,
        sacCode: taxConfig?.sacCode ?? INVOICE_FALLBACK_SAC,
        serviceCategory:
          taxConfig?.serviceCategory ?? INVOICE_FALLBACK_SERVICE_CATEGORY,
        placeOfSupplyMode:
          taxConfig?.placeOfSupplyMode ?? InvoicePlaceOfSupplyMode.ISSUER_STATE,
        placeOfSupplyStateCode: tax.placeOfSupplyStateCode,
        taxConfigId: taxConfig?.id ?? INVOICE_UNCONFIGURED_TAX_CONFIG_ID,
        taxConfigSnapshot: taxSnapshot,
        currency: INVOICE_CURRENCY,
        emailStatus: InvoiceEmailStatus.PENDING,
        emailAttemptCount: 0,
        emailNextAttemptAt: null,
      });

      try {
        return await manager.getRepository(GstInvoice).save(invoice);
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          const created = await manager.getRepository(GstInvoice).findOne({
            where: { bookingId: booking.id },
          });
          if (created) {
            return created;
          }
        }
        throw error;
      }
    });
  }

  async nextInvoiceNumber(
    manager: EntityManager,
    prefix: string,
    issuedAt: Date,
  ): Promise<string> {
    const financialYear = indianFinancialYearLabel(issuedAt);
    await manager.query(
      `
      INSERT INTO invoice_number_sequences (series_prefix, financial_year, last_value)
      VALUES ($1, $2, 0)
      ON CONFLICT (series_prefix, financial_year) DO NOTHING
      `,
      [prefix, financialYear],
    );
    const locked: Array<{ last_value: string | number }> = await manager.query(
      `
      SELECT last_value
      FROM invoice_number_sequences
      WHERE series_prefix = $1 AND financial_year = $2
      FOR UPDATE
      `,
      [prefix, financialYear],
    );
    const current = Number(locked?.[0]?.last_value);
    if (!Number.isInteger(current) || current < 0) {
      throw new InvoiceTaxResolutionError('Failed to allocate invoice number');
    }
    const lastValue = current + 1;
    await manager.query(
      `
      UPDATE invoice_number_sequences
      SET last_value = $3, updated_at = NOW()
      WHERE series_prefix = $1 AND financial_year = $2
      `,
      [prefix, financialYear, lastValue],
    );
    return `${prefix}/${financialYear}/${String(lastValue).padStart(INVOICE_NUMBER_PAD, '0')}`;
  }

  private mapPaymentStatus(status: BookingPaymentStatus): InvoicePaymentStatus {
    if (status === BookingPaymentStatus.PAID) {
      return InvoicePaymentStatus.PAID;
    }
    if (status === BookingPaymentStatus.REFUNDED) {
      return InvoicePaymentStatus.REFUNDED;
    }
    return InvoicePaymentStatus.UNPAID;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }
}
