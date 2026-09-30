import {
  hashAdminPassword,
  verifyAdminPassword,
} from './admin-password.util';
import { AdminAuthService } from './admin-auth.service';
import { UnauthorizedException } from '@nestjs/common';

describe('admin password util', () => {
  it('hashes and verifies a password without storing plaintext', () => {
    const password = 'Welcome@noida2024';
    const hash = hashAdminPassword(password);
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain(password);
    expect(verifyAdminPassword(password, hash)).toBe(true);
    expect(verifyAdminPassword('wrong', hash)).toBe(false);
  });

  it('produces different hashes for the same password (salted)', () => {
    const a = hashAdminPassword('Welcome@noida2024');
    const b = hashAdminPassword('Welcome@noida2024');
    expect(a).not.toBe(b);
  });
});

describe('AdminAuthService.login', () => {
  it('returns a JWT for valid credentials and never echoes the password', async () => {
    const password = 'Welcome@noida2024';
    const adminUserRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'admin-row-1',
        userId: 'user-admin-1',
        username: 'lucifer',
        passwordHash: hashAdminPassword(password),
        permissions: ['ADMIN_DASHBOARD_VIEW'],
        isActive: true,
      }),
    };
    const authService = {
      signAccessToken: jest.fn().mockResolvedValue('jwt-token'),
    };
    const service = new AdminAuthService(
      { get: () => undefined } as any,
      authService as any,
      {} as any,
      adminUserRepository as any,
      {} as any,
    );

    const result = await service.login('lucifer', password);
    expect(result.accessToken).toBe('jwt-token');
    expect(result.admin.username).toBe('lucifer');
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });

  it('rejects invalid credentials', async () => {
    const adminUserRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'admin-row-1',
        userId: 'user-admin-1',
        username: 'lucifer',
        passwordHash: hashAdminPassword('Welcome@noida2024'),
        permissions: ['ADMIN_DASHBOARD_VIEW'],
        isActive: true,
      }),
    };
    const service = new AdminAuthService(
      { get: () => undefined } as any,
      { signAccessToken: jest.fn() } as any,
      {} as any,
      adminUserRepository as any,
      {} as any,
    );

    await expect(service.login('lucifer', 'nope')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
