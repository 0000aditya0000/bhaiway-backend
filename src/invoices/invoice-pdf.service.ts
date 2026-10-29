import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

import {
  invoiceHasGstBreakdown,
  invoiceRideTypeLabel,
} from './invoice.constants';
import { GstInvoice } from './entities/invoice.entity';
import { InvoiceGstSplit, InvoiceTaxPricingMode } from './enums/invoice.enums';
import { formatPaiseAsRupees } from './invoice-tax.math';

/** BhaiWay palette from product emails: forest header, emerald accent, light page. */
const BRAND = {
  forest: '#0B3D2E',
  forestDeep: '#072A20',
  accent: '#10B981',
  page: '#F6F7F9',
  ink: '#1A1A1A',
  muted: '#5C6B66',
  white: '#FFFFFF',
  rowAlt: '#F0F2F4',
} as const;

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 36;
const CONTENT = PAGE.width - MARGIN * 2;

type PdfDoc = InstanceType<typeof PDFDocument>;

@Injectable()
export class InvoicePdfService {
  async render(invoice: GstInvoice, logo: Buffer | null): Promise<Buffer> {
    const hasGst = invoiceHasGstBreakdown(invoice);
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: {
        Title: `${hasGst ? 'Tax Invoice' : 'Invoice'} ${invoice.invoiceNumber}`,
        Author: invoice.issuerLegalName,
        Creator: 'BhaiWay',
      },
    });

    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.paintPage(doc);
    this.drawHeader(doc, logo, hasGst);
    this.drawIssuerAndMeta(doc, invoice, hasGst);
    this.drawPartiesAndRide(doc, invoice);
    this.drawFareTable(doc, invoice, hasGst);
    this.drawNotes(doc, invoice, hasGst);
    this.drawFooter(doc, invoice, hasGst);

    doc.end();
    return done;
  }

  private drawHeader(doc: PdfDoc, logo: Buffer | null, hasGst: boolean): void {
    doc.save();
    doc.rect(0, 0, PAGE.width, 118).fill(BRAND.forest);
    doc.rect(0, 118, PAGE.width, 6).fill(BRAND.accent);
    doc.restore();

    const logoBox = { x: MARGIN, y: 28, w: 72, h: 62 };
    doc.save();
    doc
      .roundedRect(logoBox.x, logoBox.y, logoBox.w, logoBox.h, 10)
      .fill(BRAND.white);
    doc.restore();

    let logoDrawn = false;
    if (logo) {
      try {
        doc.image(logo, logoBox.x + 8, logoBox.y + 8, {
          fit: [logoBox.w - 16, logoBox.h - 16],
          align: 'center',
          valign: 'center',
        });
        logoDrawn = true;
      } catch {
        logoDrawn = false;
      }
    }
    if (!logoDrawn) {
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(BRAND.forest)
        .text('BW', logoBox.x, logoBox.y + 24, {
          width: logoBox.w,
          align: 'center',
        });
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(22)
      .fillColor(BRAND.white)
      .text('BhaiWay', logoBox.x + logoBox.w + 16, 36, { lineBreak: false });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(BRAND.accent)
      .text(hasGst ? 'GST tax invoice' : 'Ride invoice', logoBox.x + logoBox.w + 16, 64);

    doc
      .roundedRect(PAGE.width - MARGIN - 126, 40, 126, 28, 8)
      .fill(BRAND.accent);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(BRAND.forestDeep)
      .text(hasGst ? 'TAX INVOICE' : 'INVOICE', PAGE.width - MARGIN - 126, 48, {
        width: 126,
        align: 'center',
      });

    doc.y = 140;
  }

  private drawIssuerAndMeta(
    doc: PdfDoc,
    invoice: GstInvoice,
    hasGst: boolean,
  ): void {
    const left = MARGIN;
    const gap = 16;
    const col = (CONTENT - gap) / 2;
    const top = doc.y;

    this.card(doc, left, top, col, 118, BRAND.white);
    this.card(doc, left + col + gap, top, col, 118, BRAND.white);

    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text('ISSUED BY', left + 14, top + 12);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(BRAND.ink)
      .text(invoice.issuerLegalName, left + 14, top + 28, { width: col - 28 });
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(BRAND.muted)
      .text(invoice.issuerAddress, left + 14, top + 46, {
        width: col - 28,
        height: 46,
        ellipsis: true,
      });
    if (hasGst) {
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(BRAND.forest)
        .text(`GSTIN  ${invoice.issuerGstin}`, left + 14, top + 98);
    }

    const metaX = left + col + gap + 14;
    this.metaRow(doc, metaX, top + 14, 'Invoice number', invoice.invoiceNumber, col - 28);
    this.metaRow(
      doc,
      metaX,
      top + 38,
      'Invoice date',
      this.istStamp(invoice.issuedAt),
      col - 28,
    );
    if (hasGst) {
      this.metaRow(
        doc,
        metaX,
        top + 62,
        'Place of supply',
        `State code ${invoice.placeOfSupplyStateCode}`,
        col - 28,
      );
      this.metaRow(
        doc,
        metaX,
        top + 86,
        'SAC',
        `${invoice.sacCode} · ${invoice.serviceCategory}`,
        col - 28,
      );
    }

    doc.y = top + 134;
  }

  private drawPartiesAndRide(doc: PdfDoc, invoice: GstInvoice): void {
    const left = MARGIN;
    const gap = 16;
    const col = (CONTENT - gap) / 2;
    const top = doc.y;
    const height = 132;

    this.card(doc, left, top, col, height, BRAND.white);
    this.card(doc, left + col + gap, top, col, height, BRAND.white);

    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text('BILL TO', left + 14, top + 12);
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(BRAND.ink)
      .text(invoice.riderName ?? 'Name not available', left + 14, top + 28, {
        width: col - 28,
      });
    const riderLines = [
      invoice.riderPhone ? `Phone  ${invoice.riderPhone}` : null,
      invoice.riderEmail ? `Email  ${invoice.riderEmail}` : null,
      invoice.riderBillingStateCode
        ? `Billing state  ${invoice.riderBillingStateCode}`
        : null,
    ].filter((line): line is string => Boolean(line));
    doc.font('Helvetica').fontSize(8.5).fillColor(BRAND.muted);
    for (const [index, line] of riderLines.entries()) {
      doc.text(line, left + 14, top + 50 + index * 14, { width: col - 28 });
    }

    const rideX = left + col + gap + 14;
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text('RIDE', rideX, top + 12);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(BRAND.forest)
      .text(invoiceRideTypeLabel(invoice.rideType), rideX, top + 28, {
        width: col - 28,
      });

    doc.save();
    doc.circle(rideX + 5, top + 56, 4).fill(BRAND.accent);
    doc
      .moveTo(rideX + 5, top + 60)
      .lineTo(rideX + 5, top + 78)
      .lineWidth(1.5)
      .strokeColor(BRAND.accent)
      .stroke();
    doc.circle(rideX + 5, top + 82, 4).fill(BRAND.forest);
    doc.restore();

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(BRAND.ink)
      .text(invoice.source, rideX + 16, top + 48, { width: col - 44 });
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(BRAND.ink)
      .text(invoice.destination, rideX + 16, top + 74, { width: col - 44 });

    const rideMeta = [
      `Driver  ${invoice.driverName ?? 'Not available'}`,
      `Vehicle  ${invoice.vehicleRegistrationNumber ?? 'Not available'}`,
      `Completed  ${invoice.completedAt ? this.istStamp(invoice.completedAt) : 'Not available'}`,
    ];
    doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.muted);
    doc.text(rideMeta.join('   ·   '), rideX, top + 104, { width: col - 28 });

    doc.y = top + height + 16;
  }

  private drawFareTable(
    doc: PdfDoc,
    invoice: GstInvoice,
    hasGst: boolean,
  ): void {
    const money = (paise: string) =>
      `${invoice.currency} ${formatPaiseAsRupees(BigInt(paise))}`;
    const hasDiscount = BigInt(invoice.discountPaise) !== 0n;
    const rows: Array<{ label: string; value: string; emphasize?: boolean }> = [];
    if (hasGst) {
      rows.push({ label: 'Ride fare (gross)', value: money(invoice.grossFarePaise) });
      rows.push({ label: 'Discount', value: money(invoice.discountPaise) });
      rows.push({
        label: 'Consideration (net fare)',
        value: money(invoice.netFarePaise),
      });
      rows.push({
        label: `Taxable value (${invoice.pricingMode === InvoiceTaxPricingMode.TAX_INCLUSIVE ? 'tax-inclusive' : 'tax-exclusive'})`,
        value: money(invoice.taxableValuePaise),
      });
      rows.push({
        label: 'GST rate',
        value: `${(invoice.gstRateBasisPoints / 100).toFixed(2)}%`,
      });
      if (invoice.gstSplit === InvoiceGstSplit.IGST) {
        rows.push({ label: 'IGST', value: money(invoice.igstPaise) });
      } else {
        rows.push({ label: 'CGST', value: money(invoice.cgstPaise) });
        rows.push({ label: 'SGST / UTGST', value: money(invoice.sgstPaise) });
      }
      rows.push({ label: 'Total tax', value: money(invoice.totalTaxPaise) });
      rows.push({
        label: 'Invoice total',
        value: money(invoice.invoiceTotalPaise),
        emphasize: true,
      });
    } else {
      if (hasDiscount) {
        rows.push({ label: 'Ride fare', value: money(invoice.grossFarePaise) });
        rows.push({ label: 'Discount', value: money(invoice.discountPaise) });
        rows.push({ label: 'Net fare', value: money(invoice.netFarePaise) });
      } else {
        rows.push({ label: 'Ride fare', value: money(invoice.netFarePaise) });
      }
      rows.push({
        label: 'Total',
        value: money(invoice.invoiceTotalPaise),
        emphasize: true,
      });
    }
    rows.push({ label: 'Payment status', value: invoice.paymentStatus });
    if (invoice.paymentReference) {
      rows.push({ label: 'Payment reference', value: invoice.paymentReference });
    }

    const x = MARGIN;
    const headerH = 28;
    const rowH = 22;
    const emphasizeH = rowH + 4;
    let y = doc.y;
    const bodyH = rows.reduce(
      (sum, row) => sum + (row.emphasize ? emphasizeH : rowH),
      0,
    );

    if (y + headerH + bodyH > PAGE.height - 70) {
      doc.addPage();
      this.paintPage(doc);
      y = MARGIN;
    }

    doc.save();
    doc.roundedRect(x, y, CONTENT, headerH + bodyH, 10).clip();
    doc.rect(x, y, CONTENT, headerH).fill(BRAND.forest);
    let bandY = y + headerH;
    for (const [index, row] of rows.entries()) {
      if (row.emphasize) {
        doc.rect(x, bandY, CONTENT, emphasizeH).fill(BRAND.forest);
        doc.rect(x, bandY, 6, emphasizeH).fill(BRAND.accent);
        bandY += emphasizeH;
        continue;
      }
      doc
        .rect(x, bandY, CONTENT, rowH)
        .fill(index % 2 === 0 ? BRAND.rowAlt : BRAND.white);
      bandY += rowH;
    }
    doc.restore();

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(BRAND.white)
      .text(hasGst ? 'FARE AND TAX' : 'FARE', x + 14, y + 9, {
        width: 240,
        lineBreak: false,
      });
    doc.text('AMOUNT', x + CONTENT - 160, y + 9, {
      width: 146,
      align: 'right',
      lineBreak: false,
    });

    let textY = y + headerH;
    for (const row of rows) {
      if (row.emphasize) {
        doc
          .font('Helvetica-Bold')
          .fontSize(11)
          .fillColor(BRAND.white)
          .text(row.label, x + 14, textY + 7, { width: 280, lineBreak: false });
        doc.fillColor(BRAND.accent).text(row.value, x + CONTENT - 180, textY + 7, {
          width: 166,
          align: 'right',
          lineBreak: false,
        });
        textY += emphasizeH;
        continue;
      }
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(BRAND.ink)
        .text(row.label, x + 14, textY + 6, { width: 300, lineBreak: false });
      doc.text(row.value, x + CONTENT - 180, textY + 6, {
        width: 166,
        align: 'right',
        lineBreak: false,
      });
      textY += rowH;
    }

    doc.y = textY + 16;
  }

  private drawNotes(
    doc: PdfDoc,
    invoice: GstInvoice,
    hasGst: boolean,
  ): void {
    const summary = hasGst
      ? [
          'Issued by the BhaiWay registered entity for this completed ride. Tax treatment follows the configuration in force at issue time.',
          invoice.gstSplit === InvoiceGstSplit.IGST
            ? 'GST split: IGST (inter-state supply as configured).'
            : 'GST split: CGST and SGST/UTGST (intra-state supply as configured).',
        ].join(' ')
      : 'Issued by the BhaiWay registered entity for this completed ride. Amount equals the ride fare.';
    const extras = [
      hasGst && typeof invoice.taxConfigSnapshot?.notes === 'string'
        ? invoice.taxConfigSnapshot.notes.trim()
        : '',
      typeof invoice.taxConfigSnapshot?.issuerFooterNotes === 'string'
        ? invoice.taxConfigSnapshot.issuerFooterNotes.trim()
        : '',
    ].filter(Boolean);

    if (doc.y > PAGE.height - 120) {
      doc.addPage();
      this.paintPage(doc);
    }

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(summary, MARGIN, doc.y, { width: CONTENT });
    if (extras.length > 0) {
      doc.moveDown(0.4);
      doc.text(extras.join('\n'), MARGIN, doc.y, { width: CONTENT });
    }
  }

  private drawFooter(
    doc: PdfDoc,
    invoice: GstInvoice,
    hasGst: boolean,
  ): void {
    const y = PAGE.height - 46;
    doc.save();
    doc.rect(0, y, PAGE.width, 46).fill(BRAND.forestDeep);
    doc.rect(0, y, PAGE.width, 3).fill(BRAND.accent);
    doc.restore();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(BRAND.white)
      .text(
        hasGst
          ? `BhaiWay  ·  ${invoice.issuerLegalName}  ·  GSTIN ${invoice.issuerGstin}`
          : `BhaiWay  ·  ${invoice.issuerLegalName}`,
        MARGIN,
        y + 12,
        { width: CONTENT, align: 'center', lineBreak: false },
      );
    doc
      .fontSize(7)
      .fillColor(BRAND.accent)
      .text(
        hasGst
          ? 'This is a computer-generated tax invoice and does not require a signature.'
          : 'This is a computer-generated invoice and does not require a signature.',
        MARGIN,
        y + 26,
        { width: CONTENT, align: 'center', lineBreak: false },
      );
  }

  private paintPage(doc: PdfDoc): void {
    doc.save();
    doc.rect(0, 0, PAGE.width, PAGE.height).fill(BRAND.page);
    doc.restore();
  }

  private card(
    doc: PdfDoc,
    x: number,
    y: number,
    w: number,
    h: number,
    fill: string = BRAND.white,
  ): void {
    doc.save();
    doc.roundedRect(x, y, w, h, 10).fill(fill);
    doc.restore();
  }

  private metaRow(
    doc: PdfDoc,
    x: number,
    y: number,
    label: string,
    value: string,
    width: number,
  ): void {
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(BRAND.muted)
      .text(label.toUpperCase(), x, y, { width });
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(BRAND.ink)
      .text(value, x, y + 11, { width });
  }

  private istStamp(value: Date): string {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(value);
  }
}
