export const EMAIL_CHANGE_VERIFICATION_SUBJECT =
  'Verify your new BhaiWay email address';

export function buildEmailChangeVerificationHtml(otp: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BhaiWay email change verification</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;text-align:left;">
            <tr>
              <td>
                <h1 style="margin:0 0 16px;font-size:22px;color:#111827;">Verify your new email address</h1>
                <p style="margin:0 0 16px;font-size:16px;line-height:24px;">Hello,</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:24px;">You requested to change your BhaiWay account email address. Your verification code is:</p>
                <p style="margin:0 0 24px;font-size:32px;letter-spacing:6px;font-weight:700;color:#111827;">${otp}</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:24px;">This code will expire in 10 minutes.</p>
                <p style="margin:0 0 24px;font-size:16px;line-height:24px;">If you did not request this email change, please ignore this email or contact support immediately.</p>
                <p style="margin:0;font-size:16px;line-height:24px;">Regards,<br />BhaiWay Team</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildEmailChangeVerificationText(otp: string): string {
  return [
    'Hello,',
    '',
    'You requested to change your BhaiWay account email address. Your verification code is:',
    '',
    otp,
    '',
    'This code will expire in 10 minutes.',
    '',
    'If you did not request this email change, please ignore this email or contact support immediately.',
    '',
    'Regards,',
    'BhaiWay Team',
  ].join('\n');
}
