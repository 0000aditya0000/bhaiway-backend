import { invoiceRideTypeLabel } from './invoice.constants';
import { RideType } from '../rides/enums/ride.enums';
import { formatPaiseAsRupees } from './invoice-tax.math';

export function buildInvoiceEmailContent(input: {
  invoiceNumber: string;
  riderName: string | null;
  rideType: RideType;
  source: string;
  destination: string;
  invoiceTotalPaise: bigint;
  currency: string;
}): { subject: string; html: string; text: string } {
  const name = input.riderName?.trim() || 'there';
  const rideLabel = invoiceRideTypeLabel(input.rideType);
  const amount = `${input.currency} ${formatPaiseAsRupees(input.invoiceTotalPaise)}`;
  const subject = `Your BhaiWay tax invoice ${input.invoiceNumber}`;
  const text = [
    `Hi ${name},`,
    '',
    `Please find attached your BhaiWay tax invoice ${input.invoiceNumber}.`,
    `Ride: ${rideLabel}`,
    `From: ${input.source}`,
    `To: ${input.destination}`,
    `Invoice total: ${amount}`,
    '',
    'You can also download this invoice from the BhaiWay app.',
    '',
    'BhaiWay',
  ].join('\n');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5">
      <p>Hi ${escapeHtml(name)},</p>
      <p>Please find attached your BhaiWay tax invoice <strong>${escapeHtml(input.invoiceNumber)}</strong>.</p>
      <table style="border-collapse:collapse">
        <tr><td style="padding:2px 12px 2px 0">Ride</td><td>${escapeHtml(rideLabel)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0">From</td><td>${escapeHtml(input.source)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0">To</td><td>${escapeHtml(input.destination)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0">Invoice total</td><td>${escapeHtml(amount)}</td></tr>
      </table>
      <p>You can also download this invoice from the BhaiWay app.</p>
      <p>BhaiWay</p>
    </div>
  `.trim();
  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
