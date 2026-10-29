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
  hasGst?: boolean;
}): { subject: string; html: string; text: string } {
  const name = input.riderName?.trim() || 'there';
  const rideLabel = invoiceRideTypeLabel(input.rideType);
  const amount = `${input.currency} ${formatPaiseAsRupees(input.invoiceTotalPaise)}`;
  const hasGst = input.hasGst !== false;
  const kind = hasGst ? 'tax invoice' : 'invoice';
  const subject = `Your BhaiWay ${kind} ${input.invoiceNumber}`;
  const text = [
    `Hi ${name},`,
    '',
    `Please find attached your BhaiWay ${kind} ${input.invoiceNumber}.`,
    `Ride: ${rideLabel}`,
    `From: ${input.source}`,
    `To: ${input.destination}`,
    `Invoice total: ${amount}`,
    '',
    'You can also download this invoice from the BhaiWay app.',
    '',
    'BhaiWay',
  ].join('\n');
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f4f7f5;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12221c;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr>
          <td style="background:#0B3D2E;padding:22px 24px;">
            <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:0.4px;">BhaiWay</div>
            <div style="margin-top:4px;font-size:12px;color:#10B981;">${hasGst ? 'GST tax invoice' : 'Ride invoice'}</div>
          </td>
        </tr>
        <tr>
          <td style="height:6px;background:#10B981;font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 12px;font-size:16px;">Hi ${escapeHtml(name)},</p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#5B6E67;">
              Your ${kind} <strong style="color:#0B3D2E;">${escapeHtml(input.invoiceNumber)}</strong> is attached as a PDF.
            </p>
            <table role="presentation" width="100%" style="border-collapse:collapse;background:#f4f7f5;border-radius:12px;">
              <tr><td style="padding:10px 14px;font-size:13px;color:#5B6E67;">Ride</td><td style="padding:10px 14px;font-size:13px;font-weight:600;">${escapeHtml(rideLabel)}</td></tr>
              <tr><td style="padding:10px 14px;font-size:13px;color:#5B6E67;">From</td><td style="padding:10px 14px;font-size:13px;font-weight:600;">${escapeHtml(input.source)}</td></tr>
              <tr><td style="padding:10px 14px;font-size:13px;color:#5B6E67;">To</td><td style="padding:10px 14px;font-size:13px;font-weight:600;">${escapeHtml(input.destination)}</td></tr>
              <tr><td style="padding:10px 14px;font-size:13px;color:#5B6E67;">Invoice total</td><td style="padding:10px 14px;font-size:13px;font-weight:700;color:#0B3D2E;">${escapeHtml(amount)}</td></tr>
            </table>
            <p style="margin:16px 0 0;font-size:13px;color:#5B6E67;">You can also download this invoice from the BhaiWay app.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 24px;background:#072A20;font-size:11px;color:#10B981;">BhaiWay  ·  computer-generated ${kind}</td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
