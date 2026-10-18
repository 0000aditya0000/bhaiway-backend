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

  const subject = notification.title.slice(0, 200);
  const summary = notification.body.slice(0, 500);
  const ticketLine = ticketRef ? `\nTicket reference: ${ticketRef}` : '';

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
            ${
              ticketRef
                ? `<p style="margin:0 0 16px;font-size:14px;color:#555;">Ticket reference: <strong>${escapeHtml(ticketRef)}</strong></p>`
                : ''
            }
            <p style="margin:0;font-size:13px;color:#666;">Open the BhaiWay app for full details and next steps.</p>
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
