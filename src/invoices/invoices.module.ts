import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { Booking } from '../bookings/entities/booking.entity';
import { EmailModule } from '../email/email.module';
import { Ride } from '../rides/entities/ride.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { AdminInvoicesController } from './admin-invoices.controller';
import { InvoiceIssuerSettings } from './entities/invoice-issuer-settings.entity';
import { GstInvoiceJob } from './entities/invoice-job.entity';
import { InvoiceNumberSequence } from './entities/invoice-number-sequence.entity';
import { InvoiceTaxConfigAudit } from './entities/invoice-tax-config-audit.entity';
import { InvoiceTaxConfig } from './entities/invoice-tax-config.entity';
import { GstInvoice } from './entities/invoice.entity';
import { InvoiceConfigService } from './invoice-config.service';
import { InvoiceIssuanceService } from './invoice-issuance.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoiceStorageService } from './invoice-storage.service';
import { InvoiceWorkerService } from './invoice-worker.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GstInvoice,
      GstInvoiceJob,
      InvoiceIssuerSettings,
      InvoiceTaxConfig,
      InvoiceTaxConfigAudit,
      InvoiceNumberSequence,
      Ride,
      Booking,
      User,
      UserProfile,
      Vehicle,
    ]),
    EmailModule,
    forwardRef(() => AuthModule),
    forwardRef(() => AdminModule),
  ],
  controllers: [InvoicesController, AdminInvoicesController],
  providers: [
    InvoiceConfigService,
    InvoiceStorageService,
    InvoicePdfService,
    InvoiceIssuanceService,
    InvoiceWorkerService,
    InvoicesService,
  ],
  exports: [InvoicesService, InvoiceIssuanceService, InvoiceWorkerService],
})
export class InvoicesModule {}
