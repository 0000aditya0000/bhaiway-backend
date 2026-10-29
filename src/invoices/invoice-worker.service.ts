import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';

import { AdminAlertService } from '../admin/admin-alert.service';
import { AdminAlertSeverity } from '../admin/entities/admin-alert.entity';
import { SmtpMailService } from '../email/smtp-mail.service';
import { User } from '../users/entities/user.entity';
import { GstInvoiceJob } from './entities/invoice-job.entity';
import { GstInvoice } from './entities/invoice.entity';
import { InvoiceEmailStatus, InvoiceJobStatus } from './enums/invoice.enums';
import { InvoiceConfigService } from './invoice-config.service';
import { buildInvoiceEmailContent } from './invoice-email.templates';
import { invoicePdfFilename } from './invoice-name.util';
import { InvoiceIssuanceService } from './invoice-issuance.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoiceStorageService } from './invoice-storage.service';
import { InvoiceTaxResolutionError } from './invoice-tax.math';
import {
  INVOICE_LIST_PROCESS_LIMIT,
  INVOICE_MAX_EMAIL_ATTEMPTS,
  INVOICE_MAX_JOB_ATTEMPTS,
  INVOICE_RETRY_BASE_MS,
  INVOICE_WORKER_POLL_MS,
} from './invoice.constants';

@Injectable()
export class InvoiceWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoiceWorkerService.name);
  private readonly inFlightEmails = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly issuanceService: InvoiceIssuanceService,
    private readonly pdfService: InvoicePdfService,
    private readonly storageService: InvoiceStorageService,
    private readonly configService: InvoiceConfigService,
    private readonly smtpMailService: SmtpMailService,
    private readonly adminAlertService: AdminAlertService,
    @InjectRepository(GstInvoiceJob)
    private readonly jobRepository: Repository<GstInvoiceJob>,
    @InjectRepository(GstInvoice)
    private readonly invoiceRepository: Repository<GstInvoice>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  onModuleInit(): void {
    if ((process.env.NODE_ENV ?? '').trim() === 'test') {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.processDue().catch((error) => {
        this.logger.warn(
          `Invoice worker poll failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, INVOICE_WORKER_POLL_MS);
    this.pollTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  scheduleProcess(): void {
    setImmediate(() => {
      void this.processDue();
    });
  }

  async processJobsForBookings(bookingIds: string[]): Promise<void> {
    if (bookingIds.length === 0) {
      return;
    }
    const jobs = await this.jobRepository.find({
      where: {
        bookingId: In(bookingIds),
        status: In([
          InvoiceJobStatus.PENDING,
          InvoiceJobStatus.PROCESSING,
          InvoiceJobStatus.FAILED,
        ]),
      },
      order: { createdAt: 'ASC' },
      take: INVOICE_LIST_PROCESS_LIMIT,
    });
    for (const job of jobs) {
      await this.processJob(job.id);
    }

    const pendingMail = await this.invoiceRepository.find({
      where: {
        bookingId: In(bookingIds),
        emailStatus: In([InvoiceEmailStatus.PENDING, InvoiceEmailStatus.FAILED]),
      },
      order: { createdAt: 'ASC' },
      take: INVOICE_LIST_PROCESS_LIMIT,
    });
    for (const invoice of pendingMail) {
      await this.deliverEmail(invoice.id);
    }
  }

  async processDue(limit = 20): Promise<void> {
    const now = new Date();
    const jobs = await this.jobRepository.find({
      where: [
        {
          status: InvoiceJobStatus.PENDING,
          nextAttemptAt: IsNull(),
        },
        {
          status: InvoiceJobStatus.PENDING,
          nextAttemptAt: LessThanOrEqual(now),
        },
        {
          status: InvoiceJobStatus.PROCESSING,
          nextAttemptAt: LessThanOrEqual(now),
        },
        {
          status: InvoiceJobStatus.FAILED,
          nextAttemptAt: LessThanOrEqual(now),
        },
      ],
      take: limit,
      order: { createdAt: 'ASC' },
    });
    for (const job of jobs) {
      await this.processJob(job.id);
    }

    const emailNow = new Date();
    const invoices = await this.invoiceRepository.find({
      where: [
        {
          emailStatus: InvoiceEmailStatus.PENDING,
          emailNextAttemptAt: IsNull(),
        },
        {
          emailStatus: InvoiceEmailStatus.PENDING,
          emailNextAttemptAt: LessThanOrEqual(emailNow),
        },
        {
          emailStatus: InvoiceEmailStatus.FAILED,
          emailNextAttemptAt: LessThanOrEqual(emailNow),
        },
      ],
      take: limit,
      order: { createdAt: 'ASC' },
    });
    for (const invoice of invoices) {
      await this.deliverEmail(invoice.id);
    }
  }

  async processJob(jobId: string): Promise<void> {
    try {
      const job = await this.jobRepository.findOne({ where: { id: jobId } });
      if (!job) {
        return;
      }
      if (
        job.status === InvoiceJobStatus.ISSUED ||
        job.status === InvoiceJobStatus.SKIPPED
      ) {
        return;
      }
      if (
        job.status === InvoiceJobStatus.FAILED &&
        job.attemptCount >= INVOICE_MAX_JOB_ATTEMPTS
      ) {
        return;
      }
      if (
        job.attemptCount > 0 &&
        job.nextAttemptAt &&
        job.nextAttemptAt.getTime() > Date.now()
      ) {
        return;
      }

      job.status = InvoiceJobStatus.PROCESSING;
      job.attemptCount += 1;
      try {
        await this.jobRepository.save(job);
      } catch (error) {
        if (this.isForeignKeyViolation(error)) {
          return;
        }
        throw error;
      }

      try {
        const invoice = await this.issuanceService.issueForJob(job);
        await this.ensurePdf(invoice);
        job.invoiceId = invoice.id;
        job.status = InvoiceJobStatus.ISSUED;
        job.lastError = null;
        job.nextAttemptAt = null;
        await this.jobRepository.save(job);
        this.scheduleEmail(invoice.id);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message.slice(0, 500) : String(error);
        const terminal = job.attemptCount >= INVOICE_MAX_JOB_ATTEMPTS;
        job.status = terminal ? InvoiceJobStatus.FAILED : InvoiceJobStatus.PENDING;
        job.lastError = reason;
        job.nextAttemptAt = new Date(
          Date.now() + INVOICE_RETRY_BASE_MS * 2 ** Math.min(job.attemptCount, 4),
        );
        try {
          await this.jobRepository.save(job);
        } catch (persistError) {
          if (!this.isForeignKeyViolation(persistError)) {
            throw persistError;
          }
          return;
        }
        this.logger.warn(
          `Invoice job failed job=${job.id} booking=${job.bookingId} attempt=${job.attemptCount}: ${reason}`,
        );
        try {
          await this.adminAlertService.reportIncident({
            incidentKey: `invoice-job:${job.bookingId}`,
            category: 'INVOICE',
            severity: AdminAlertSeverity.WARNING,
            title: 'GST invoice generation failed',
            message: `Retryable invoice generation failed for booking ${job.bookingId}`,
            source: 'InvoiceWorkerService',
            metadata: {
              bookingId: job.bookingId,
              rideId: job.rideId,
              attemptCount: job.attemptCount,
            },
          });
        } catch (alertError) {
          this.logger.warn(
            `Invoice alert persist failed booking=${job.bookingId}: ${
              alertError instanceof Error ? alertError.message : String(alertError)
            }`,
          );
        }
      }
    } catch (error) {
      if (this.isForeignKeyViolation(error)) {
        return;
      }
      throw error;
    }
  }

  async ensurePdf(invoice: GstInvoice): Promise<GstInvoice> {
    if (invoice.pdfStorageKey && invoice.pdfSha256) {
      const exists = await this.storageService.pdfExists(invoice.pdfStorageKey);
      if (exists) {
        return invoice;
      }
    }

    const issuer = await this.configService.getIssuer();
    const logo = await this.storageService.readOptionalFile(
      issuer?.logoStorageKey ?? null,
    );
    const pdf = await this.pdfService.render(invoice, logo);
    const stored = await this.storageService.savePdf(invoice.id, pdf);
    invoice.pdfStorageKey = stored.storageKey;
    invoice.pdfSha256 = stored.sha256;
    return this.invoiceRepository.save(invoice);
  }

  scheduleEmail(invoiceId: string): void {
    setImmediate(() => {
      void this.deliverEmail(invoiceId);
    });
  }

  async retryEmail(invoiceId: string): Promise<GstInvoice> {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
    });
    if (!invoice) {
      throw new InvoiceTaxResolutionError('Invoice not found');
    }
    if (invoice.emailStatus === InvoiceEmailStatus.SENT) {
      return invoice;
    }
    invoice.emailStatus = InvoiceEmailStatus.PENDING;
    invoice.emailNextAttemptAt = null;
    await this.invoiceRepository.save(invoice);
    this.inFlightEmails.delete(invoiceId);
    await this.deliverEmail(invoice.id);
    const reloaded = await this.invoiceRepository.findOneByOrFail({
      id: invoice.id,
    });
    return reloaded;
  }

  async deliverEmail(invoiceId: string): Promise<void> {
    if (this.inFlightEmails.has(invoiceId)) {
      return;
    }
    this.inFlightEmails.add(invoiceId);
    try {
      let invoice = await this.invoiceRepository.findOne({
        where: { id: invoiceId },
      });
      if (!invoice) {
        return;
      }
      if (
        invoice.emailStatus === InvoiceEmailStatus.SENT ||
        invoice.emailStatus === InvoiceEmailStatus.SKIPPED
      ) {
        return;
      }
      if (
        invoice.emailStatus === InvoiceEmailStatus.FAILED &&
        invoice.emailAttemptCount >= INVOICE_MAX_EMAIL_ATTEMPTS
      ) {
        return;
      }
      if (
        invoice.emailAttemptCount > 0 &&
        invoice.emailNextAttemptAt &&
        invoice.emailNextAttemptAt.getTime() > Date.now()
      ) {
        return;
      }

      invoice = await this.ensurePdf(invoice);

      const user = await this.userRepository.findOne({
        where: { id: invoice.riderUserId },
      });
      const email = user?.email?.trim().toLowerCase() ?? '';
      if (!email || !user?.emailVerified) {
        invoice.emailStatus = InvoiceEmailStatus.SKIPPED;
        invoice.emailLastError = !email ? 'email_missing' : 'email_unverified';
        invoice.emailNextAttemptAt = null;
        await this.invoiceRepository.save(invoice);
        return;
      }

      if (!invoice.pdfStorageKey) {
        throw new Error('Invoice PDF is not available');
      }
      const pdf = await this.storageService.readPdf(invoice.pdfStorageKey);
      const content = buildInvoiceEmailContent({
        invoiceNumber: invoice.invoiceNumber,
        riderName: invoice.riderName,
        rideType: invoice.rideType,
        source: invoice.source,
        destination: invoice.destination,
        invoiceTotalPaise: BigInt(invoice.invoiceTotalPaise),
        currency: invoice.currency,
      });

      invoice.emailAttemptCount += 1;
      invoice.emailLastAttemptAt = new Date();
      try {
        await this.smtpMailService.sendEmail({
          to: email,
          subject: content.subject,
          html: content.html,
          text: content.text,
          attachments: [
            {
              filename: this.pdfFilename(invoice.invoiceNumber),
              content: pdf,
              contentType: 'application/pdf',
            },
          ],
        });
        invoice.emailStatus = InvoiceEmailStatus.SENT;
        invoice.emailSentAt = new Date();
        invoice.emailLastError = null;
        invoice.emailNextAttemptAt = null;
        await this.invoiceRepository.save(invoice);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message.slice(0, 500) : String(error);
        const terminal = invoice.emailAttemptCount >= INVOICE_MAX_EMAIL_ATTEMPTS;
        invoice.emailStatus = terminal
          ? InvoiceEmailStatus.FAILED
          : InvoiceEmailStatus.PENDING;
        invoice.emailLastError = reason;
        invoice.emailNextAttemptAt = new Date(
          Date.now() +
            INVOICE_RETRY_BASE_MS * 2 ** Math.min(invoice.emailAttemptCount, 4),
        );
        await this.invoiceRepository.save(invoice);
        this.logger.warn(
          `Invoice email failed invoice=${invoice.id} attempt=${invoice.emailAttemptCount}: ${reason}`,
        );
      }
    } catch (error) {
      if (this.isForeignKeyViolation(error)) {
        return;
      }
      throw error;
    } finally {
      this.inFlightEmails.delete(invoiceId);
    }
  }

  pdfFilename(invoiceNumber: string): string {
    return invoicePdfFilename(invoiceNumber);
  }

  private isForeignKeyViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23503'
    );
  }
}
