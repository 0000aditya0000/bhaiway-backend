import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  CreateInvoiceTaxConfigDto,
  UpdateInvoiceTaxConfigDto,
  UpsertInvoiceIssuerDto,
} from './dto/invoice-admin.dto';
import { GstInvoiceJob } from './entities/invoice-job.entity';
import { GstInvoice } from './entities/invoice.entity';
import { InvoiceEmailStatus } from './enums/invoice.enums';
import { InvoiceConfigService } from './invoice-config.service';
import { InvoiceIssuanceService } from './invoice-issuance.service';
import { InvoiceStorageService } from './invoice-storage.service';
import { InvoiceWorkerService } from './invoice-worker.service';
import { formatPaiseAsRupees } from './invoice-tax.math';

@Injectable()
export class InvoicesService {
  constructor(
    private readonly issuanceService: InvoiceIssuanceService,
    private readonly workerService: InvoiceWorkerService,
    private readonly configService: InvoiceConfigService,
    private readonly storageService: InvoiceStorageService,
    @InjectRepository(GstInvoice)
    private readonly invoiceRepository: Repository<GstInvoice>,
    @InjectRepository(GstInvoiceJob)
    private readonly jobRepository: Repository<GstInvoiceJob>,
  ) {}

  async scheduleForCompletedRide(rideId: string): Promise<void> {
    await this.issuanceService.scheduleForCompletedRide(rideId);
    this.workerService.scheduleProcess();
  }

  async listForRider(userId: string, page = 1, limit = 20) {
    const take = Math.min(Math.max(limit, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;
    const [items, total] = await this.invoiceRepository.findAndCount({
      where: { riderUserId: userId },
      order: { issuedAt: 'DESC' },
      skip,
      take,
    });
    return {
      items: items.map((row) => this.toRiderDto(row)),
      page: Math.max(page, 1),
      limit: take,
      total,
    };
  }

  async getForRider(userId: string, invoiceId: string) {
    const invoice = await this.requireOwnedInvoice(userId, invoiceId);
    return this.toRiderDto(invoice, true);
  }

  async downloadPdfForRider(userId: string, invoiceId: string) {
    const invoice = await this.requireOwnedInvoice(userId, invoiceId);
    return this.readPdf(invoice);
  }

  async getAdminConfig() {
    const [issuer, taxConfigs] = await Promise.all([
      this.configService.getIssuer(),
      this.configService.listTaxConfigs(),
    ]);
    return {
      issuer: issuer
        ? {
            legalName: issuer.legalName,
            gstin: issuer.gstin,
            addressLine1: issuer.addressLine1,
            addressLine2: issuer.addressLine2,
            city: issuer.city,
            state: issuer.state,
            stateCode: issuer.stateCode,
            pinCode: issuer.pinCode,
            contactEmail: issuer.contactEmail,
            contactPhone: issuer.contactPhone,
            invoicePrefix: issuer.invoicePrefix,
            hasLogo: Boolean(issuer.logoStorageKey),
            footerNotes: issuer.footerNotes,
            updatedAt: issuer.updatedAt,
          }
        : null,
      taxConfigs,
    };
  }

  upsertIssuer(adminUserId: string, dto: UpsertInvoiceIssuerDto) {
    return this.configService.upsertIssuer(adminUserId, dto);
  }

  createTaxConfig(adminUserId: string, dto: CreateInvoiceTaxConfigDto) {
    return this.configService.createTaxConfig(adminUserId, dto);
  }

  updateTaxConfig(
    adminUserId: string,
    id: string,
    dto: UpdateInvoiceTaxConfigDto,
  ) {
    return this.configService.updateTaxConfig(adminUserId, id, dto);
  }

  async uploadLogo(
    adminUserId: string,
    file: { buffer: Buffer; mimetype: string } | undefined,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Logo file is required');
    }
    let storageKey: string;
    try {
      storageKey = await this.storageService.saveLogo(
        file.buffer,
        file.mimetype,
      );
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      const message =
        error instanceof Error ? error.message : 'Logo upload failed';
      if (
        message.includes('must be') ||
        message.includes('PNG') ||
        message.includes('1 MB')
      ) {
        throw new BadRequestException(message);
      }
      throw error;
    }
    const issuer = await this.configService.setLogoStorageKey(
      adminUserId,
      storageKey,
    );
    return { hasLogo: Boolean(issuer.logoStorageKey) };
  }

  async listAdmin(params: {
    page?: number;
    limit?: number;
    emailStatus?: InvoiceEmailStatus;
    invoiceNumber?: string;
  }) {
    const take = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const page = Math.max(params.page ?? 1, 1);
    const qb = this.invoiceRepository
      .createQueryBuilder('invoice')
      .orderBy('invoice.issued_at', 'DESC')
      .skip((page - 1) * take)
      .take(take);
    if (params.emailStatus) {
      qb.andWhere('invoice.email_status = :emailStatus', {
        emailStatus: params.emailStatus,
      });
    }
    if (params.invoiceNumber?.trim()) {
      qb.andWhere('invoice.invoice_number ILIKE :number', {
        number: `%${params.invoiceNumber.trim()}%`,
      });
    }
    const [items, total] = await qb.getManyAndCount();
    const jobs =
      items.length === 0
        ? []
        : await this.jobRepository.find({
            where: items.map((item) => ({ invoiceId: item.id })),
          });
    const jobByInvoice = new Map(
      jobs.filter((job) => job.invoiceId).map((job) => [job.invoiceId!, job]),
    );
    return {
      items: items.map((row) =>
        this.toAdminDto(row, jobByInvoice.get(row.id) ?? null),
      ),
      page,
      limit: take,
      total,
    };
  }

  async getAdmin(invoiceId: string) {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
    });
    if (!invoice) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found',
      });
    }
    const job = await this.jobRepository.findOne({
      where: { invoiceId: invoice.id },
    });
    return this.toAdminDto(invoice, job);
  }

  async retryEmail(invoiceId: string) {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
    });
    if (!invoice) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found',
      });
    }
    const updated = await this.workerService.retryEmail(invoice.id);
    const job = await this.jobRepository.findOne({
      where: { invoiceId: updated.id },
    });
    return this.toAdminDto(updated, job);
  }

  async downloadPdfAdmin(invoiceId: string) {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
    });
    if (!invoice) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found',
      });
    }
    return this.readPdf(invoice);
  }

  private async requireOwnedInvoice(userId: string, invoiceId: string) {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId, riderUserId: userId },
    });
    if (!invoice) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found',
      });
    }
    return invoice;
  }

  private async readPdf(invoice: GstInvoice) {
    const withPdf = await this.workerService.ensurePdf(invoice);
    if (!withPdf.pdfStorageKey) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'INVOICE_PDF_NOT_READY',
        message: 'Invoice PDF is not available yet',
      });
    }
    const buffer = await this.storageService.readPdf(withPdf.pdfStorageKey);
    return {
      buffer,
      filename: this.workerService.pdfFilename(withPdf.invoiceNumber),
    };
  }

  private toRiderDto(invoice: GstInvoice, detailed = false) {
    const base = {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      rideId: invoice.rideId,
      bookingId: invoice.bookingId,
      rideType: invoice.rideType,
      source: invoice.source,
      destination: invoice.destination,
      issuedAt: invoice.issuedAt,
      invoiceTotal: formatPaiseAsRupees(BigInt(invoice.invoiceTotalPaise)),
      currency: invoice.currency,
      paymentStatus: invoice.paymentStatus,
      emailStatus: invoice.emailStatus,
      pdfAvailable: Boolean(invoice.pdfStorageKey),
    };
    if (!detailed) {
      return base;
    }
    return {
      ...base,
      riderName: invoice.riderName,
      driverName: invoice.driverName,
      vehicleRegistrationNumber: invoice.vehicleRegistrationNumber,
      departureAt: invoice.departureAt,
      completedAt: invoice.completedAt,
      taxableValue: formatPaiseAsRupees(BigInt(invoice.taxableValuePaise)),
      gstRateBasisPoints: invoice.gstRateBasisPoints,
      cgst: formatPaiseAsRupees(BigInt(invoice.cgstPaise)),
      sgst: formatPaiseAsRupees(BigInt(invoice.sgstPaise)),
      igst: formatPaiseAsRupees(BigInt(invoice.igstPaise)),
      issuerLegalName: invoice.issuerLegalName,
      issuerGstin: invoice.issuerGstin,
      sacCode: invoice.sacCode,
      placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
    };
  }

  private toAdminDto(invoice: GstInvoice, job: GstInvoiceJob | null) {
    return {
      ...this.toRiderDto(invoice, true),
      emailAttemptCount: invoice.emailAttemptCount,
      emailLastAttemptAt: invoice.emailLastAttemptAt,
      emailLastError: invoice.emailLastError,
      emailSentAt: invoice.emailSentAt,
      jobStatus: job?.status ?? null,
      jobAttemptCount: job?.attemptCount ?? null,
      jobLastError: job?.lastError ?? null,
      taxConfigSnapshot: invoice.taxConfigSnapshot,
    };
  }
}
