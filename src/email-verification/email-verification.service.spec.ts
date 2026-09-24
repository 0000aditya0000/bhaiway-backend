import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';

import { SmtpMailService } from '../email/smtp-mail.service';
import { User } from '../users/entities/user.entity';
import * as otpUtil from './email-otp.util';
import { EmailVerificationService } from './email-verification.service';
import { EmailVerificationOtp } from './entities/email-verification-otp.entity';

describe('EmailVerificationService transactions', () => {
  it('rolls back user verification when a later write fails', async () => {
    const user: User = {
      id: 'user-1',
      email: 'user@example.com',
      emailVerified: false,
    } as User;

    const otpSave = jest.fn();
    const userSave = jest.fn().mockRejectedValue(new Error('db write failed'));
    const otpRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'otp-1',
        userId: 'user-1',
        email: 'user@example.com',
        otpHash: 'v1$salt$hash',
        expiresAt: new Date(Date.now() + 60_000),
        attempts: 0,
        maxAttempts: 5,
        verifiedAt: null,
        invalidatedAt: null,
      }),
      save: otpSave,
    };
    const userRepo = {
      findOne: jest.fn().mockResolvedValue(user),
      save: userSave,
    };

    const dataSource = {
      transaction: async (cb: (manager: unknown) => Promise<unknown>) =>
        cb({
          getRepository: (entity: unknown) =>
            entity === User ? userRepo : otpRepo,
        }),
    } as unknown as DataSource;

    const service = new EmailVerificationService(
      {
        findOne: jest.fn().mockResolvedValue(user),
      } as unknown as Repository<User>,
      {} as Repository<EmailVerificationOtp>,
      dataSource,
      { get: () => 'pepper' } as unknown as ConfigService,
      { sendEmail: jest.fn() } as unknown as SmtpMailService,
    );

    jest.spyOn(otpUtil, 'emailOtpHashesMatch').mockReturnValue(true);

    await expect(service.verifyCode('user-1', '4827')).rejects.toThrow(
      'db write failed',
    );
    expect(userSave).toHaveBeenCalled();
    expect(otpSave).toHaveBeenCalled();
  });
});
