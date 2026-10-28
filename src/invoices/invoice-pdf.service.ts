import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

import { invoiceRideTypeLabel } from './invoice.constants';
import { GstInvoice } from './entities/invoice.entity';
import { InvoiceGstSplit } from './enums/invoice.enums';
import { formatPaiseAsRupees } from './invoice-tax.math';

@Injectable()
export class InvoicePdfService {
  async render(invoice: GstInvoice, logo: Buffer | null): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: {
        Title: `Tax Invoice ${invoice.invoiceNumber}`,
        Author: invoice.issuerLegalName,
      },
    });

    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    if (logo) {
      try {
        doc.image(logo, 48, 40, { height: 42 });
      } catch {
        // Invalid/corrupt logo: continue without fabricating a replacement.
      }
    }

    doc
      .fontSize(18)
      .fillColor('#111')
      .text('TAX INVOICE', 48, logo ? 90 : 48, { align: 'right' });
    doc.moveDown(logo ? 2.2 : 1.2);

    doc.fontSize(11).fillColor('#111').text(invoice.issuerLegalName);
    doc.fontSize(9).fillColor('#333').text(invoice.issuerAddress);
    doc.text(`GSTIN: ${invoice.issuerGstin}`);
    doc.moveDown(0.8);

    this.kv(doc, 'Invoice number', invoice.invoiceNumber);
    this.kv(doc, 'Invoice date', this.istStamp(invoice.issuedAt));
    this.kv(doc, 'Place of supply', `State code ${invoice.placeOfSupplyStateCode}`);
    this.kv(doc, 'SAC', `${invoice.sacCode} — ${invoice.serviceCategory}`);
    this.kv(doc, 'Currency', invoice.currency);
    doc.moveDown(0.6);

    doc.fontSize(10).fillColor('#111').text('Bill to');
    doc.fontSize(9).fillColor('#333');
    doc.text(invoice.riderName ?? 'Name not available');
    if (invoice.riderPhone) {
      doc.text(`Phone: ${invoice.riderPhone}`);
    }
    if (invoice.riderEmail) {
      doc.text(`Email: ${invoice.riderEmail}`);
    }
    if (invoice.riderBillingStateCode) {
      doc.text(`Billing state code: ${invoice.riderBillingStateCode}`);
    }
    doc.moveDown(0.6);

    doc.fontSize(10).fillColor('#111').text('Ride details');
    doc.fontSize(9).fillColor('#333');
    this.kv(doc, 'Ride ID', invoice.rideId);
    this.kv(doc, 'Booking ID', invoice.bookingId);
    this.kv(doc, 'Ride type', invoiceRideTypeLabel(invoice.rideType));
    this.kv(doc, 'From', invoice.source);
    this.kv(doc, 'To', invoice.destination);
    this.kv(
      doc,
      'Departure',
      invoice.departureAt ? this.istStamp(invoice.departureAt) : 'Not available',
    );
    this.kv(
      doc,
      'Completed',
      invoice.completedAt ? this.istStamp(invoice.completedAt) : 'Not available',
    );
    this.kv(doc, 'Driver', invoice.driverName ?? 'Not available');
    this.kv(
      doc,
      'Vehicle registration',
      invoice.vehicleRegistrationNumber ?? 'Not available',
    );
    doc.moveDown(0.8);

    this.drawTable(doc, invoice);

    doc.moveDown(1);
    doc.fontSize(8).fillColor('#555');
    doc.text(
      'This tax invoice is issued by the BhaiWay registered entity for the eligible completed ride. Tax treatment follows the configuration in force at issue time.',
    );
    if (invoice.gstSplit === InvoiceGstSplit.CGST_SGST) {
      doc.text('GST split: CGST and SGST/UTGST (intra-state supply as configured).');
    } else {
      doc.text('GST split: IGST (inter-state supply as configured).');
    }
    const snapshotNotes = invoice.taxConfigSnapshot?.notes;
    if (typeof snapshotNotes === 'string' && snapshotNotes.trim()) {
      doc.moveDown(0.4);
      doc.text(snapshotNotes.trim());
    }
    const footer = invoice.taxConfigSnapshot?.issuerFooterNotes;
    if (typeof footer === 'string' && footer.trim()) {
      doc.moveDown(0.4);
      doc.text(footer.trim());
    }

    doc.end();
    return done;
  }

  private kv(
    doc: InstanceType<typeof PDFDocument>,
    label: string,
    value: string,
  ): void {
    const y = doc.y;
    doc.fontSize(9).fillColor('#666').text(label, 48, y, { width: 150 });
    doc.fillColor('#111').text(value, 200, y, { width: 350 });
  }

  private drawTable(
    doc: InstanceType<typeof PDFDocument>,
    invoice: GstInvoice,
  ): void {
    const money = (paise: string) =>
      `${invoice.currency} ${formatPaiseAsRupees(BigInt(paise))}`;
    const rows: Array<[string, string]> = [
      ['Ride fare (gross)', money(invoice.grossFarePaise)],
      ['Discount', money(invoice.discountPaise)],
      ['Consideration (net fare)', money(invoice.netFarePaise)],
      [
        `Taxable value (${invoice.pricingMode === 'TAX_INCLUSIVE' ? 'tax-inclusive fare' : 'tax-exclusive fare'})`,
        money(invoice.taxableValuePaise),
      ],
      [`GST rate`, `${(invoice.gstRateBasisPoints / 100).toFixed(2)}%`],
    ];
    if (invoice.gstSplit === InvoiceGstSplit.IGST) {
      rows.push(['IGST', money(invoice.igstPaise)]);
    } else {
      rows.push(['CGST', money(invoice.cgstPaise)]);
      rows.push(['SGST / UTGST', money(invoice.sgstPaise)]);
    }
    rows.push(['Total tax', money(invoice.totalTaxPaise)]);
    rows.push(['Invoice total', money(invoice.invoiceTotalPaise)]);
    rows.push(['Payment status', invoice.paymentStatus]);
    if (invoice.paymentReference) {
      rows.push(['Payment reference', invoice.paymentReference]);
    }

    doc.fontSize(10).fillColor('#111').text('Fare and tax');
    doc.moveDown(0.3);
    for (const [label, value] of rows) {
      const y = doc.y;
      if (y > 740) {
        doc.addPage();
      }
      doc.fontSize(9).fillColor('#333').text(label, 48, doc.y, { width: 300 });
      doc.text(value, 360, y, { width: 180, align: 'right' });
    }
  }

  private istStamp(value: Date): string {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(value);
  }
}
