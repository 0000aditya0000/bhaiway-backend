import { RideType } from '../rides/enums/ride.enums';
import { GstInvoice } from './entities/invoice.entity';
import {
  InvoiceEmailStatus,
  InvoiceGstSplit,
  InvoicePaymentStatus,
  InvoicePlaceOfSupplyMode,
  InvoiceTaxPricingMode,
} from './enums/invoice.enums';
import { InvoicePdfService } from './invoice-pdf.service';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function sampleInvoice(): GstInvoice {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    invoiceNumber: 'BW/2026-27/000001',
    rideId: '22222222-2222-4222-8222-222222222222',
    bookingId: '33333333-3333-4333-8333-333333333333',
    riderUserId: '44444444-4444-4444-8444-444444444444',
    rideType: RideType.REGULAR,
    riderName: 'Test Rider',
    riderEmail: 'rider@example.com',
    riderPhone: '+919999999999',
    riderBillingStateCode: null,
    driverName: 'Test Driver',
    vehicleRegistrationNumber: 'MH12AB1234',
    source: 'Pune',
    destination: 'Mumbai',
    departureAt: new Date('2026-05-01T03:30:00.000Z'),
    completedAt: new Date('2026-05-01T10:00:00.000Z'),
    issuedAt: new Date('2026-05-01T10:05:00.000Z'),
    grossFarePaise: '100000',
    discountPaise: '0',
    netFarePaise: '100000',
    taxableValuePaise: '100000',
    gstRateBasisPoints: 1800,
    cgstPaise: '9000',
    sgstPaise: '9000',
    igstPaise: '0',
    totalTaxPaise: '18000',
    invoiceTotalPaise: '118000',
    pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
    gstSplit: InvoiceGstSplit.CGST_SGST,
    paymentStatus: InvoicePaymentStatus.PAID,
    paymentReference: 'pay_ref',
    issuerLegalName: 'Example Mobility Private Limited',
    issuerGstin: '27AABCU9603R1ZM',
    issuerAddress: 'Line 1\nPune, Maharashtra 27\nPIN 411001',
    issuerState: 'Maharashtra',
    issuerStateCode: '27',
    sacCode: '996411',
    serviceCategory: 'Passenger transportation',
    placeOfSupplyMode: InvoicePlaceOfSupplyMode.ISSUER_STATE,
    placeOfSupplyStateCode: '27',
    taxConfigId: '55555555-5555-4555-8555-555555555555',
    taxConfigSnapshot: { notes: 'Configured test snapshot' },
    currency: 'INR',
    pdfStorageKey: null,
    pdfSha256: null,
    emailStatus: InvoiceEmailStatus.PENDING,
    emailAttemptCount: 0,
    emailLastAttemptAt: null,
    emailLastError: null,
    emailSentAt: null,
    emailNextAttemptAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as GstInvoice;
}

describe('InvoicePdfService', () => {
  it('renders a TAX INVOICE PDF with logo bytes', async () => {
    const service = new InvoicePdfService();
    const pdf = await service.render(sampleInvoice(), PNG_1X1);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
