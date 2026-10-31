import { Notification } from './entities/notification.entity';

export function buildNotificationEmailContent(notification: Notification): {
  subject: string;
  html: string;
  text: string;
} {
  const ticketRef =
    typeof notification.data?.ticketReference === 'string'
      ? notification.data.ticketReference
      : null;
  const source =
    typeof notification.data?.source === 'string' ? notification.data.source : null;
  const destination =
    typeof notification.data?.destination === 'string'
      ? notification.data.destination
      : null;
  const departureDate =
    typeof notification.data?.departureDate === 'string'
      ? notification.data.departureDate
      : null;
  const departureTime =
    typeof notification.data?.departureTime === 'string'
      ? notification.data.departureTime
      : null;
  const cancelledBy =
    typeof notification.data?.cancelledBy === 'string'
      ? notification.data.cancelledBy
      : null;
  const cancellationReason =
    typeof notification.data?.cancellationReason === 'string'
      ? notification.data.cancellationReason
      : null;
  const rideId =
    typeof notification.data?.rideId === 'string' ? notification.data.rideId : null;
  const bookingId =
    typeof notification.data?.bookingId === 'string'
      ? notification.data.bookingId
      : null;

  const subject = notification.title.slice(0, 200);
  const summary = notification.body.slice(0, 500);
  const route =
    source && destination ? `${source} → ${destination}` : source || destination;
  const when = [departureDate, departureTime].filter(Boolean).join(' at ');
  const extraLines = [
    route ? `Route: ${route}` : null,
    when ? `Departure: ${when}` : null,
    cancelledBy ? `Cancelled by: ${cancelledBy}` : null,
    cancellationReason ? `Reason: ${cancellationReason}` : null,
    rideId ? `Ride ID: ${rideId}` : null,
    bookingId ? `Booking ID: ${bookingId}` : null,
    ticketRef ? `Ticket reference: ${ticketRef}` : null,
  ].filter((line): line is string => line != null);
  const ticketLine = extraLines.length > 0 ? `\n${extraLines.join('\n')}` : '';

  const text = [
    'BhaiWay',
    '',
    notification.title,
    '',
    summary,
    ticketLine.trim(),
    '',
    'Open the BhaiWay app for full details.',
    '',
    '— BhaiWay Support',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr>
          <td style="background:#0b3d2e;padding:20px 24px;">
            <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">BhaiWay</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;">${escapeHtml(notification.title)}</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#333;">${escapeHtml(summary)}</p>
            ${extraLines
              .map(
                (line) =>
                  `<p style="margin:0 0 8px;font-size:14px;color:#555;">${escapeHtml(line)}</p>`,
              )
              .join('')}
            <p style="margin:${extraLines.length > 0 ? '8px' : '0'} 0 0;font-size:13px;color:#666;">Open the BhaiWay app for full details and next steps.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#f0f2f4;font-size:12px;color:#777;">
            You received this email because you have a verified email on your BhaiWay account.
          </td>
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
