export const CORPORATE_IDENTITY_VERIFICATION_SUBJECT =
  'Verify your BhaiWay corporate identity';

export function buildCorporateIdentityVerificationHtml(otp: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BhaiWay corporate identity verification</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;padding:32px;text-align:left;">
            <tr>
              <td>
                <h1 style="margin:0 0 16px;font-size:22px;color:#111827;">Verify your corporate identity</h1>
                <p style="margin:0 0 16px;font-size:16px;line-height:24px;">Hello,</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:24px;">Use this code to verify ownership of your official company email for BhaiWay corporate identity:</p>
                <p style="margin:0 0 24px;font-size:32px;letter-spacing:6px;font-weight:700;color:#111827;">${otp}</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:24px;">This code will expire in 10 minutes.</p>
                <p style="margin:0 0 24px;font-size:16px;line-height:24px;">If you did not request this verification, you can safely ignore this email.</p>
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

export function buildCorporateIdentityVerificationText(otp: string): string {
  return [
    'Hello,',
    '',
    'Use this code to verify ownership of your official company email for BhaiWay corporate identity:',
    '',
    otp,
    '',
    'This code will expire in 10 minutes.',
    '',
    'If you did not request this verification, you can safely ignore this email.',
    '',
    'Regards,',
    'BhaiWay Team',
  ].join('\n');
}
