import { ConfigService } from '@nestjs/config';

const sendMail = jest.fn().mockResolvedValue({ messageId: 'msg-1' });
const verify = jest.fn().mockResolvedValue(true);

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: jest.fn(() => ({ sendMail, verify })),
  },
}));

import { SmtpMailService } from './smtp-mail.service';

describe('SmtpMailService', () => {
  const smtpPassword = 'smtp-super-secret-password';

  function makeService() {
    const config = {
      get: (key: string) => {
        const env: Record<string, string> = {
          SMTP_HOST: 'mail.kodenzolabs.in',
          SMTP_PORT: '465',
          SMTP_SECURE: 'true',
          SMTP_USER: 'alerts@kodenzolabs.in',
          SMTP_PASSWORD: smtpPassword,
          SMTP_FROM_EMAIL: 'alerts@kodenzolabs.in',
          SMTP_FROM_NAME: 'BhaiWay',
        };
        return env[key];
      },
    } as unknown as ConfigService;
    return new SmtpMailService(config);
  }

  beforeEach(() => {
    sendMail.mockClear();
    verify.mockClear();
  });

  it('sends from BhaiWay <alerts@kodenzolabs.in> and never logs the password', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const service = makeService();
    await service.sendEmail({
      to: 'user@example.com',
      subject: 'Verify your BhaiWay email address',
      html: '<p>4827</p>',
      text: '4827',
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'BhaiWay <alerts@kodenzolabs.in>',
        to: 'user@example.com',
        subject: 'Verify your BhaiWay email address',
      }),
    );

    const logs = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    expect(logs).not.toContain(smtpPassword);

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
